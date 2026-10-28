#!/usr/bin/env python3
"""Train the 17-class movement-decision DeepSets model (E16, G6 step 1).

The movement twin of train_fire_model.py — "given this tick and this intel,
where does each ship actually go":

    Rust movement export (fire_dataset.rs `export_move_dataset_dir`, driven
    by the e16_move_batch test with WOWSP_MOVE_DATASET_OUT)
      -> THIS SCRIPT: featurize on the SAME fire-v2 pipeline (slot/global
         featurizers imported from train_fire_model) -> split BY REPLAY
         (leave-largest-replay-out) or BY VERSION (the E13/E14 OOD stress
         test) -> train the fire DeepSets backbone with a 17-class softmax
         head instead of the two binary heads
      -> static-shape ONNX fp32 + int8 dynamic quantization.

LABEL (E16): realised displacement over [t+4, t+16] s, classified into 16
bearing sectors of 22.5 deg measured RELATIVE to the decider's heading at t
(WoWS rudder semantics; the serve side recovers the absolute bearing from
the live yaw) + 1 "no obvious movement" class (< 100 m over the window —
100 m / 12 s = 16.2 kt, so a straight-cruising slow ship legitimately lands
there; the corpus histogram reports how big that class is).

THE EVALUATION IS THE EXPERIMENT: movement is dominated by inertia — ships
mostly keep their heading — so the model is reported AGAINST strict
baselines, not just absolute numbers:
  * inertia           — predict sector 0 (current heading) for every row;
                        top-3 = {0, 1, 15} (ahead +- 22.5 deg);
  * speed-gated inertia — predict 16 (no move) when the own trailing speed
                        cannot cover 100 m in 12 s (< 16.2 kt), else 0;
                        top-3 = [primary, the other of {0,16}, 1]. This is
                        the honest "physics floor": a ship below threshold
                        moving straight is class 16 BY CONSTRUCTION;
  * majority class    — the TRAIN split's most frequent sector(s).
If the model fails to beat them that IS the E16 scientific result and must
be reported as such (see README E16).

E14 lesson applied: cross-version training defaults are the caller's choice
via --ablate e11 (the version-gated feature families are OOD poison); the
export always writes the full v2 schema and this script zeroes the family
at train time exactly like train_fire_model.

Usage:
    # 1. export the movement dataset (Rust side, see fire_dataset.rs E16):
    WOWSP_TEST_REPLAY_DIR=<replay folder> \
    WOWSP_MOVE_DATASET_OUT=scripts/experiments/out/move_model/dataset.jsonl \
        cargo test -p wowsp_tauri e16_move_batch -- --nocapture
    # 2. train + evaluate + export (same-distribution, ablated):
    python scripts/experiments/train_move_model.py \
        --data scripts/experiments/out/move_model/dataset.jsonl --ablate e11
    # version stress test:
    python scripts/experiments/train_move_model.py --data ... \
        --ablate e11 --holdout-version 15,8 --train-version 14,5 \
        --out-dir scripts/experiments/out/move_model/ho158

Outputs (under --out-dir, default scripts/experiments/out/move_model/):
    fp32.onnx / int8.onnx   17-class logits, static batch 1
    sample_input.json       one featurized row for the Rust-side ort test
    metrics.json            split, baseline comparison, calibration, parity

Dependencies (experiment-only, same as train_fire_model): torch, onnx,
onnxruntime, numpy. --selftest runs torch-free.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

import train_fire_model as tfm

# ── E16 label constants (must stay in sync with fire_dataset.rs) ─────────────

MOVE_SECTORS = 17
MOVE_SECTOR_NONE = 16
MOVE_SECTOR_RAD = math.pi / 8.0  # 22.5 deg
MOVE_LABEL_START_S = 4.0
MOVE_LABEL_END_S = 16.0
MOVE_WINDOW_S = MOVE_LABEL_END_S - MOVE_LABEL_START_S  # 12 s
MOVE_NONE_THRESHOLD_M = 100.0
KT_MS = 0.514444  # knots -> m/s (decision_tick's constant)
# Own speed below which 12 s of straight-line sailing cannot cover the
# no-move threshold: 100 m / 12 s = 8.33 m/s = 16.2 kt.
SPEED_GATED_INERTIA_KT = MOVE_NONE_THRESHOLD_M / MOVE_WINDOW_S / KT_MS


def move_sector_from_row(row: dict) -> int:
    """Recompute the sector label from the row's raw label fields — the
    loader's consistency check that the Rust export and this script agree
    on the 17-class grammar."""
    dist = float(row["movedDistM"])
    if dist < MOVE_NONE_THRESHOLD_M:
        return MOVE_SECTOR_NONE
    rel = float(row["moveBearingRad"]) - float(row["ownYawRad"])
    rel = (rel + math.pi) % (2.0 * math.pi) - math.pi  # wrap to [-pi, pi)
    k = int(round(rel / MOVE_SECTOR_RAD))
    return k % (MOVE_SECTORS - 1)


def load_move_datasets(paths: list[Path]) -> dict:
    """Merge movement JSONL datasets: the fire-v2 featurization arrays plus
    the E16 label/metadata columns. Mirror's tfm.load_datasets's file
    handling (featureVersion consistency per file and across files)."""
    seen: set[Path] = set()
    unique: list[Path] = []
    for p in paths:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            unique.append(p)
    rows: list[dict] = []
    file_versions: list[int] = []
    for path in unique:
        with open(path, encoding="utf-8") as f:
            file_rows = 0
            ver: int | None = None
            for n, line in enumerate(f, 1):
                line = line.strip()
                if line:
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError as e:
                        raise SystemExit(
                            f"[e16] malformed JSONL at {path}:{n}: {e}"
                        ) from e
                    if "moveSector" not in row:
                        raise SystemExit(
                            f"[e16] {path}:{n} is not a movement-dataset row "
                            "(no moveSector key) — rerun the E16 Rust export"
                        )
                    row_ver = int(row.get("featureVersion", 1) or 1)
                    if ver is None:
                        ver = row_ver
                    elif row_ver != ver:
                        raise SystemExit(
                            f"[e16] {path} mixes featureVersions {ver} and {row_ver}"
                        )
                    rows.append(row)
                    file_rows += 1
            file_versions.append(ver or 1)
            print(f"[e16] loaded {file_rows:7d} rows (featureVersion {ver or 1}) from {path}")
    if not rows:
        raise SystemExit(
            "[e16] no movement rows found — rerun the Rust export "
            "(e16_move_batch with WOWSP_MOVE_DATASET_OUT)"
        )
    if len(set(file_versions)) != 1:
        raise SystemExit(
            f"[e16] mixed featureVersions across files ({file_versions}) — "
            "v1 and v2 datasets cannot train together"
        )
    version = file_versions[0]
    entity_dim = tfm.ENTITY_DIM_V1 if version == 1 else tfm.ENTITY_DIM_V2
    global_dim = tfm.GLOBAL_DIM_V1 if version == 1 else tfm.GLOBAL_DIM_V2
    n = len(rows)
    data = {
        "feature_version": version,
        "entity_dim": entity_dim,
        "global_dim": global_dim,
        "entity": np.zeros((n, tfm.SLOTS, entity_dim), dtype=np.float32),
        "global": np.zeros((n, global_dim), dtype=np.float32),
        "mask": np.zeros((n, tfm.SLOTS), dtype=np.float32),
        "move_sector": np.zeros((n,), dtype=np.int64),
        "moved_dist_m": np.zeros((n,), dtype=np.float32),
        "own_yaw_rad": np.zeros((n,), dtype=np.float32),
        "own_speed_kt": np.full((n,), np.nan, dtype=np.float32),
        "group": np.empty((n,), dtype=object),
        "version": np.empty((n,), dtype=object),
        "game_mode": np.empty((n,), dtype=object),
    }
    for i, row in enumerate(rows):
        e, m = tfm.entity_matrix_and_mask(row, version)
        g = tfm.global_vector(row, version)
        data["entity"][i], data["global"][i], data["mask"][i] = e, g, m
        sector = int(row["moveSector"])
        recomputed = move_sector_from_row(row)
        if sector != recomputed:
            raise SystemExit(
                f"[e16] row {i}: moveSector {sector} disagrees with the "
                f"recomputed label {recomputed} (dist {row['movedDistM']:.1f} m) — "
                "exporter/label grammar drift"
            )
        data["move_sector"][i] = sector
        data["moved_dist_m"][i] = row["movedDistM"]
        data["own_yaw_rad"][i] = row["ownYawRad"]
        spd = row.get("ownSpeedKt")
        if spd is not None:
            data["own_speed_kt"][i] = spd
        data["group"][i] = row.get("replayId") or "unknown"
        data["version"][i] = tfm.row_version_prefix(row.get("replayVersion"))
        data["game_mode"][i] = row.get("gameMode") or "unknown"
    data["rows_meta"] = rows
    return data


# ── baselines (the bar the model must clear) ─────────────────────────────────


def inertia_preds(y: np.ndarray) -> dict:
    """Keep-heading baseline: sector 0 for every row (the relative-frame
    restatement of 'predict the current heading'). Top-3 = {0, 1, 15} —
    ahead and the two adjacent sectors."""
    top1 = np.zeros_like(y)
    return {"name": "inertia (sector 0)", "top1": top1, "top3": [0, 1, 15]}


def speed_gated_inertia_preds(y: np.ndarray, speed_kt: np.ndarray) -> dict:
    """Physics floor: a decider whose own trailing speed cannot cover the
    no-move threshold in 12 s (< 16.2 kt) is class 16 BY CONSTRUCTION when
    it sails straight; above it, inertia (sector 0). Missing speed falls
    back to plain inertia. Top-3 = [primary, the other of {0,16}, 1]."""
    slow = np.isfinite(speed_kt) & (speed_kt < SPEED_GATED_INERTIA_KT)
    top1 = np.where(slow, MOVE_SECTOR_NONE, 0).astype(y.dtype)
    # Deterministic top-3 per row: primary, the other of {0,16}, then 1.
    top3 = np.stack(
        [
            top1,
            np.where(slow, 0, MOVE_SECTOR_NONE).astype(y.dtype),
            np.full_like(y, 1),
        ],
        axis=1,
    )
    return {"name": f"speed-gated inertia (<{SPEED_GATED_INERTIA_KT:.1f} kt -> 16)", "top1": top1, "top3": top3}


def majority_preds(train_y: np.ndarray) -> tuple[dict, dict]:
    """Majority-class baseline FIT ON THE TRAIN SPLIT (like a real model):
    top-1 = the most frequent sector, top-3 = the three most frequent
    (ties by lowest sector id — deterministic)."""
    hist = np.bincount(train_y, minlength=MOVE_SECTORS)
    order = sorted(range(MOVE_SECTORS), key=lambda k: (-hist[k], k))
    return (
        {"name": f"majority class (sector {order[0]})", "top1_sector": order[0], "top3": order[:3]},
        hist,
    )


def topk_accuracy(y_true: np.ndarray, topk_idx: np.ndarray, k: int) -> float:
    """Top-k accuracy from an `[N, k]` array of predicted class ids (each
    row already ordered by rank) or an `[N]` top-1 array."""
    topk_idx = np.atleast_2d(topk_idx.T).T if topk_idx.ndim == 2 else topk_idx[:, None]
    kk = topk_idx[:, :k]
    return float((kk == y_true[:, None]).any(axis=1).mean())


def topk_from_probs(probs: np.ndarray, k: int) -> np.ndarray:
    """`[N, k]` class-id array of the k highest-probability classes."""
    return np.argsort(-probs, kind="stable")[:, :k]


# ── multiclass metrics ───────────────────────────────────────────────────────


def softmax(x: np.ndarray) -> np.ndarray:
    x = x - x.max(axis=-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=-1, keepdims=True)


def multiclass_nll(y_true: np.ndarray, probs: np.ndarray) -> float:
    p = np.clip(probs[np.arange(len(y_true)), y_true], 1e-7, 1.0)
    return float(-np.log(p).mean())


def multiclass_ece(y_true: np.ndarray, probs: np.ndarray, n_bins: int = 15) -> float:
    """Confidence-based ECE: bins the MAX predicted probability against the
    top-1 correctness indicator (the standard multiclass calibration error)."""
    conf = probs.max(axis=1)
    correct = (probs.argmax(axis=1) == y_true).astype(np.float64)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    n = len(y_true)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf >= lo) & (conf < hi if hi < 1.0 else conf <= hi)
        if m.any():
            ece += m.sum() / n * abs(conf[m].mean() - correct[m].mean())
    return float(ece)


def mean_entropy_nats(probs: np.ndarray) -> float:
    p = np.clip(probs, 1e-12, 1.0)
    return float(-(p * np.log(p)).sum(axis=1).mean())


def label_entropy_nats(y: np.ndarray) -> float:
    hist = np.bincount(y, minlength=MOVE_SECTORS).astype(np.float64)
    p = hist / hist.sum()
    p = p[p > 0]
    return float(-(p * np.log(p)).sum())


def per_sector_recall(y_true: np.ndarray, y_pred: np.ndarray) -> list[dict]:
    out = []
    for k in range(MOVE_SECTORS):
        m = y_true == k
        out.append(
            {
                "sector": k,
                "n": int(m.sum()),
                "recall": float((y_pred[m] == k).mean()) if m.any() else None,
            }
        )
    return out


def eval_battery(
    name: str,
    y_true: np.ndarray,
    probs: np.ndarray | None,
    top1: np.ndarray,
    top3: np.ndarray,
) -> dict:
    """The comparison-table row: top-1 / top-3 / directional-rows top-1
    (rows whose truth is a bearing sector, not the no-move class), plus
    probabilistic metrics when the predictor emits probabilities."""
    directional = y_true != MOVE_SECTOR_NONE
    out = {
        "name": name,
        "rows": int(len(y_true)),
        "top1": topk_accuracy(y_true, top1, 1),
        "top3": topk_accuracy(y_true, top3, 3),
        "top1_directional_rows": (
            float((top1[directional] == y_true[directional]).mean())
            if directional.any()
            else None
        ),
        "no_move_rate": float((~directional).mean()),
    }
    if probs is not None:
        out["nll"] = multiclass_nll(y_true, probs)
        out["ece_15bin"] = multiclass_ece(y_true, probs)
        out["mean_entropy_nats"] = mean_entropy_nats(probs)
    return out


# ── model (fire backbone, 17-class head) ─────────────────────────────────────


def build_move_model(hidden: int, entity_dim: int, global_dim: int) -> "torch.nn.Module":
    import torch
    import torch.nn as nn

    class MoveDeepSets(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.phi = nn.Sequential(  # per-entity shared encoder
                nn.Linear(entity_dim, hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden),
                nn.ReLU(),
            )
            self.ctx1 = nn.Linear(hidden + global_dim, hidden)  # broadcast-concat
            self.ctx2 = nn.Linear(hidden, hidden)
            self.head = nn.Linear(hidden, MOVE_SECTORS)  # 17-class softmax head

        def forward(self, entity, global_feat, mask):
            h = self.phi(entity)
            g = global_feat.unsqueeze(1).expand(-1, h.size(1), -1)
            h = torch.relu(self.ctx1(torch.cat([h, g], dim=-1)))
            h = torch.relu(self.ctx2(h))
            m = mask.unsqueeze(-1)
            agg = (h * m).sum(dim=1) / mask.sum(dim=1, keepdim=True).clamp(min=1.0)
            return self.head(agg)  # [B, 17] logits

    return MoveDeepSets()


# ── main ─────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(
        description=(
            "E16: train the 17-class movement-decision DeepSets on the Rust "
            "movement export, evaluate against the inertia/majority baselines, "
            "export ONNX fp32 + int8."
        )
    )
    p.add_argument("--data", action="append", default=None, help="movement JSONL (repeatable)")
    p.add_argument(
        "--data-dir",
        default=None,
        help="additionally load every *.jsonl under this directory (recursive)",
    )
    p.add_argument("--out-dir", default=str(here / "out/move_model"), help="output directory")
    p.add_argument("--epochs", type=int, default=40, help="training epochs (default 40)")
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--hidden", type=int, default=320)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="cpu", help="cpu or cuda")
    p.add_argument(
        "--label-smoothing",
        type=float,
        default=0.05,
        help="CE label smoothing (spec: 0.05)",
    )
    p.add_argument(
        "--cv-folds",
        type=int,
        default=0,
        help="GroupKFold folds over replayId (0 disables; node3 is an 8-core slice)",
    )
    p.add_argument("--parity-samples", type=int, default=1000)
    p.add_argument(
        "--holdout-version",
        default=None,
        metavar="VER",
        help="E13-style version stress test ('15,8' holds out every 15.8.x row)",
    )
    p.add_argument(
        "--train-version",
        default=None,
        metavar="VER",
        help="with --holdout-version: train only on this version prefix (e.g. '14,5')",
    )
    p.add_argument(
        "--ablate",
        default="none",
        choices=["none", "e11", "smoke", "weather", "builds"],
        help=(
            "E14 feature-group ablation (train-time zeroing; cross-version "
            "runs default to e11 in the experiment configs — the version-"
            "gated families are OOD poison)"
        ),
    )
    p.add_argument(
        "--exclude-modes",
        default="pve,event",
        help=(
            "comma-separated gameMode tags dropped before training (ops/bot "
            "movement is scripted; '' keeps everything)"
        ),
    )
    p.add_argument(
        "--selftest",
        action="store_true",
        help="torch-free synthetic validation of loader/baselines/metrics",
    )
    return p.parse_args(argv)


def resolve_data_paths(args: argparse.Namespace, here: Path) -> list[Path]:
    paths = [Path(d) for d in (args.data or [])]
    if args.data_dir:
        dd = Path(args.data_dir)
        paths.extend(sorted(dd.rglob("*.jsonl")))
    if not paths:
        paths = [here / "out/move_model/dataset.jsonl"]
    for p in paths:
        if not p.is_file():
            print(
                f"[e16] dataset not found: {p}\n"
                "      produce it with:\n"
                "      WOWSP_TEST_REPLAY_DIR=<folder> WOWSP_MOVE_DATASET_OUT=<path> "
                "cargo test -p wowsp_tauri e16_move_batch -- --nocapture",
                file=sys.stderr,
            )
            raise SystemExit(2)
    return paths


def run_selftest() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        # Two synthetic movement files: replayA's decider sails dead ahead
        # (yaw 0, displacement bearing 0 -> sector 0 dominant), replayB's
        # turns to a relative -90 deg (yaw pi/2, bearing 0 -> sector 12);
        # every 5th row is a no-move row (40 m < 100 m). The loader's
        # recompute check validates the label grammar on every row.
        paths = []
        for fi, (stem, dom, yaw) in enumerate(
            [("replayA", 0, 0.0), ("replayB", 12, 1.5707964)]
        ):
            p = tdp / f"{stem}.jsonl"
            with open(p, "w", encoding="utf-8") as f:
                for i in range(50):
                    sector = dom if i % 5 else MOVE_SECTOR_NONE
                    row = {
                        "replayId": stem,
                        "replayVersion": "15,8,0,0" if fi == 0 else "14,5,0,0",
                        "featureVersion": 2,
                        "ownerEntityId": 9,
                        "teamId": fi,
                        "t": float(5 + 4 * i),
                        "ownSpeedKt": 25.0 if i % 2 else 5.0,
                        "ownHpFrac": 0.9,
                        "ownReloadFrac": 1.0,
                        "ownRangeM": 15000.0,
                        "zonesOwned0": 1,
                        "zonesOwned1": 0,
                        "zonesOwned2": 0,
                        "zonesOwnedOther": 0,
                        "zonesActiveProgress": 0,
                        "eventsShells30s": 5,
                        "eventsTorps30s": 0,
                        "eventsExplosions30s": 2,
                        "eventsExplosionsNear30s": 1,
                        "enemies": [
                            {
                                "entityId": 100,
                                "entityType": 2,
                                "shipId": None,
                                "distM": 4000.0,
                                "bearingRelRad": 0.0,
                                "speedKt": 20.0,
                                "hpFrac": 0.8,
                                "obsAgeS": 1.0,
                                "observedNow": True,
                                "terrainBlocked": False,
                                "isEnemy": True,
                            }
                        ],
                        "friends": [],
                        "gameMode": "pvp",
                        "ownDamconFrac": -1.0,
                        "ownRepairFrac": -1.0,
                        "ownOtherConsumableFrac": -1.0,
                        "ownEnginePower": -1.0,
                        "ownEngineDir": 0.0,
                        "ownInSmoke": False,
                        "activeSmokeCountFrac": 0.0,
                        "activeSmokeAreaFeat": 0.0,
                        "visionCapFrac": 1.0,
                        "weatherIncomingFrac": 0.0,
                        "allyRadarCountFrac": -1.0,
                        "allyHydroCountFrac": -1.0,
                        "e11EventsKnown": fi == 0,
                        "ownYawRad": yaw,
                        "movedDistM": 150.0,
                        "moveBearingRad": 0.0,
                        "moveSector": sector,
                    }
                    if sector == MOVE_SECTOR_NONE:
                        row["movedDistM"] = 40.0
                    f.write(json.dumps(row) + "\n")
            paths.append(p)
        data = load_move_datasets(paths)
        assert len(data["move_sector"]) == 100
        assert data["entity"].shape == (100, tfm.SLOTS, tfm.ENTITY_DIM_V2)
        assert data["global"].shape == (100, tfm.GLOBAL_DIM_V2)
        # The recompute check inside the loader already validates the pinned
        # row (yaw pi/2, bearing 0 -> rel -pi/2 -> sector 12); make the
        # grammar explicit here too.
        assert move_sector_from_row(
            {"movedDistM": 150.0, "moveBearingRad": 0.0, "ownYawRad": 1.5707964}
        ) == 12
        assert move_sector_from_row(
            {"movedDistM": 99.999, "moveBearingRad": 2.0, "ownYawRad": 0.0}
        ) == MOVE_SECTOR_NONE
        # Boundary: exactly +22.5 deg rel -> sector 1 (round half away from
        # zero, matching the Rust f32::round).
        assert (
            move_sector_from_row(
                {"movedDistM": 150.0, "moveBearingRad": math.pi / 8, "ownYawRad": 0.0}
            )
            == 1
        )
        # Grouping + version metadata ride along.
        assert set(data["group"]) == {"replayA", "replayB"}
        assert set(data["version"]) == {"15.8.0", "14.5.0"}

        # ── baselines on a constructed inertial world ──
        y = np.concatenate([np.zeros(60, dtype=np.int64), np.full(20, MOVE_SECTOR_NONE), np.full(20, 12)])
        inert = inertia_preds(y)
        assert abs(topk_accuracy(y, inert["top1"], 1) - 0.6) < 1e-12
        inert_top3 = np.tile(np.array(inert["top3"]), (len(y), 1))
        assert abs(topk_accuracy(y, inert_top3, 3) - 0.6) < 1e-12  # {0,1,15} misses 16 and 12
        # Speed-gated: 25 kt rows are "fast" (sector 0), 5 kt rows slow (16).
        speed = np.array([25.0] * 60 + [5.0] * 40)
        sg = speed_gated_inertia_preds(y, speed)
        expected = np.zeros(100, dtype=np.int64)
        expected[60:] = MOVE_SECTOR_NONE
        assert (sg["top1"] == expected).all()
        assert abs(topk_accuracy(y, sg["top1"], 1) - 0.8) < 1e-12
        assert abs(topk_accuracy(y, sg["top3"], 3) - 0.8) < 1e-12
        # (the 12-rows are wrong under both baselines — that is the point)

        # ── metrics ──
        yy = np.array([0, 0, 1, 2])
        # perfect confident predictions
        pr = np.eye(3)[[0, 0, 1, 2]]
        assert multiclass_ece(yy, pr) < 1e-9
        assert multiclass_nll(yy, pr) < 1e-6
        # overconfident wrong predictions on half the rows -> ECE > 0
        pr_bad = np.eye(3)[[0, 0, 1, 0]]
        assert multiclass_ece(yy, pr_bad) > 0.1
        assert multiclass_nll(yy, pr_bad) > 1.0
        assert mean_entropy_nats(pr) < 1e-6
        assert abs(mean_entropy_nats(np.full((4, 3), 1 / 3)) - math.log(3)) < 1e-9
        assert abs(label_entropy_nats(np.array([0, 0, 1])) - label_entropy_nats(np.array([1, 1, 0]))) < 1e-12
        # top-k from probs: ties broken deterministically (stable argsort).
        pr_tie = np.full((2, MOVE_SECTORS), 1.0 / MOVE_SECTORS)
        tk = topk_from_probs(pr_tie, 3)
        assert (tk == np.tile(np.arange(3), (2, 1))).all()
        # per-sector recall
        rec = per_sector_recall(np.array([0, 0, 1]), np.array([0, 1, 1]))
        assert rec[0]["recall"] == 0.5 and rec[1]["recall"] == 1.0 and rec[2]["n"] == 0

        # ── majority baseline fit ──
        maj, hist = majority_preds(y)
        # counts 0:60, 16:20, 12:20 — the 20/20 tie orders by lowest id.
        assert maj["top1_sector"] == 0 and maj["top3"] == [0, 12, MOVE_SECTOR_NONE]
        assert hist[0] == 60 and hist.sum() == 100

        # ── eval battery shape ──
        uniform = np.full((100, MOVE_SECTORS), 1.0 / MOVE_SECTORS)
        bat = eval_battery("t", y, uniform, inert["top1"], inert_top3)
        assert bat["rows"] == 100 and 0 <= bat["top1"] <= 1 and "nll" in bat

    print("[selftest] E16 loader/baselines/metrics OK")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    here = Path(__file__).resolve().parent
    if args.selftest:
        return run_selftest()

    try:
        import torch  # noqa: F401
    except ImportError:
        print(
            "[e16] torch is missing — install the CPU wheel (see train_fire_model docstring)",
            file=sys.stderr,
        )
        return 2

    import torch
    import torch.nn as nn
    import onnx
    import onnxruntime as ort

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        print("[e16] --device cuda but CUDA unavailable — falling back to cpu", file=sys.stderr)
        device = torch.device("cpu")
    print(f"[e16] device: {device}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    data_paths = resolve_data_paths(args, here)
    data = load_move_datasets(data_paths)
    data = tfm.apply_ablation(data, args.ablate)

    # Mode exclusion (ops/bot movement is scripted label noise).
    exclude = {m.strip() for m in args.exclude_modes.split(",") if m.strip()}
    keep = np.array([m not in exclude for m in data["game_mode"]], dtype=bool)
    dropped_modes = int((~keep).sum())
    if dropped_modes:
        print(f"[e16] dropped {dropped_modes} rows of excluded game modes {sorted(exclude)}")
        for k in ("entity", "global", "mask"):
            data[k] = data[k][keep]
        for k in (
            "move_sector",
            "moved_dist_m",
            "own_yaw_rad",
            "own_speed_kt",
            "group",
            "version",
        ):
            data[k] = data[k][keep]
        data["rows_meta"] = [r for r, kp in zip(data["rows_meta"], keep) if kp]

    y = data["move_sector"]
    n = len(y)
    hist = np.bincount(y, minlength=MOVE_SECTORS)
    groups, group_counts = np.unique(data["group"], return_counts=True)
    print(
        f"[e16] {n} rows over {len(groups)} replay group(s); "
        f"no-move share {hist[MOVE_SECTOR_NONE] / n:.3f}; "
        f"sector-0 share {hist[0] / n:.3f}; label entropy {label_entropy_nats(y):.3f} nats; "
        f"movedDist p50 {np.median(data['moved_dist_m']):.0f} m"
    )
    print(f"[e16] sector histogram: {hist.tolist()}")

    # ── split (E13 semantics, movement rows) ─────────────────────────────
    if args.holdout_version is not None:
        ho_ver = tfm.normalize_version_prefix(args.holdout_version)
        tr_ver = tfm.normalize_version_prefix(args.train_version) if args.train_version else None
        is_ho = np.array([tfm.version_matches(v, ho_ver) for v in data["version"]])
        is_tr = np.array(
            [
                v is not None
                and not tfm.version_matches(v, ho_ver)
                and (tr_ver is None or tfm.version_matches(v, tr_ver))
                for v in data["version"]
            ]
        )
        n_dropped = int((~(is_ho | is_tr)).sum())
        if is_ho.sum() == 0 or is_tr.sum() == 0:
            vh: dict = {}
            for v in data["version"]:
                vh[v] = vh.get(v, 0) + 1
            raise SystemExit(
                f"[e16] --holdout-version {ho_ver}: held-out {int(is_ho.sum())}, "
                f"train {int(is_tr.sum())} — version histogram {vh}"
            )
        val_idx = np.flatnonzero(is_ho)
        train_idx = np.flatnonzero(is_tr)
        split_mode = (
            f"version-holdout (train = {tr_ver if tr_ver else 'non-holdout'}, "
            f"held-out = {ho_ver})"
        )
        print(
            f"[e16] version split: held-out v{ho_ver} {len(val_idx)} rows "
            f"({len(set(data['group'][val_idx]))} replays) vs train "
            f"{'v' + tr_ver if tr_ver else 'rest'} {len(train_idx)} rows; "
            f"{n_dropped} rows of other versions dropped"
        )
    elif len(groups) >= 2:
        train_idx, val_idx = tfm.leave_one_replay_out(data["group"])
        split_mode = "leave-one-replay-out (held-out = largest replay group)"
        print(
            f"[e16] same-distribution split: held-out "
            f"{data['group'][val_idx][0]} {len(val_idx)} rows, train {len(train_idx)} rows"
        )
    else:
        rng = np.random.default_rng(args.seed)
        perm = rng.permutation(n)
        n_val = max(1, int(n * 0.2))
        val_idx, train_idx = perm[:n_val], perm[n_val:]
        split_mode = "random-20pct-of-single-replay (NOT a generalisation estimate)"
        print(f"[e16] WARNING: single replay — {split_mode}")

    # ── baselines (fit on the train split where fitted at all) ───────────
    inert = inertia_preds(y)
    sg = speed_gated_inertia_preds(y, data["own_speed_kt"])
    maj, _ = majority_preds(y[train_idx])
    inert_top3 = np.tile(np.array(inert["top3"]), (n, 1))
    maj_top3 = np.tile(np.array(maj["top3"]), (n, 1))
    maj_top1 = np.full(n, maj["top1_sector"], dtype=np.int64)

    # ── model ────────────────────────────────────────────────────────────
    model = build_move_model(args.hidden, data["entity_dim"], data["global_dim"]).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[e16] model: DeepSets 17-class head, {n_params:,} params")

    def batch(idx: np.ndarray) -> dict:
        return {
            "entity": torch.from_numpy(data["entity"][idx]).to(device),
            "global": torch.from_numpy(data["global"][idx]).to(device),
            "mask": torch.from_numpy(data["mask"][idx]).to(device),
        }

    y_t = torch.from_numpy(y).to(device)
    ce = nn.CrossEntropyLoss(label_smoothing=args.label_smoothing)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    losses: list[float] = []
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        order = train_idx[np.random.permutation(len(train_idx))]
        tot, cnt = 0.0, 0
        for s in range(0, len(order), args.batch_size):
            idx = order[s : s + args.batch_size]
            b = batch(idx)
            logits = model(b["entity"], b["global"], b["mask"])
            loss = ce(logits, y_t[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item() * len(idx)
            cnt += len(idx)
        losses.append(tot / cnt)
    model.eval()
    print(
        f"[e16] trained {args.epochs} epochs in {time.time() - t0:.1f}s: "
        f"loss {losses[0]:.4f} -> {losses[-1]:.4f}"
    )

    def predict_all(m, idx: np.ndarray) -> np.ndarray:
        outs = []
        with torch.no_grad():
            for s in range(0, len(idx), 16384):
                b = batch(idx[s : s + 16384])
                outs.append(m(b["entity"], b["global"], b["mask"]))
        return torch.cat(outs).cpu().numpy()

    logits_all = predict_all(model, np.arange(n))
    probs_all = softmax(logits_all)
    top1_all = probs_all.argmax(axis=1).astype(np.int64)
    top3_all = topk_from_probs(probs_all, 3)

    # ── held-out comparison table ────────────────────────────────────────
    va = val_idx
    model_row = eval_battery(
        "model (17-class DeepSets)",
        y[va],
        probs_all[va],
        top1_all[va],
        top3_all[va],
    )
    baselines = [
        eval_battery(inert["name"], y[va], None, inert["top1"][va], inert_top3[va]),
        eval_battery(sg["name"], y[va], None, sg["top1"][va], sg["top3"][va]),
        eval_battery(maj["name"], y[va], None, maj_top1[va], maj_top3[va]),
    ]
    table = baselines + [model_row]
    print(
        f"[e16] held-out [{split_mode.split(' (')[0]}] over {len(va)} rows "
        f"(no-move share {model_row['no_move_rate']:.3f}):"
    )
    hdr = f"{'predictor':44s} top1    top3    top1@dir"
    print(hdr)
    for row in table:
        dir_acc = row["top1_directional_rows"]
        print(
            f"{row['name']:44s} {row['top1']:.4f}  {row['top3']:.4f}  "
            f"{'  n/a' if dir_acc is None else f'{dir_acc:.4f}'}"
        )
    best_baseline = max(
        (b["top1"] for b in baselines),
    )
    verdict = (
        "MODEL BEATS every baseline on top-1"
        if model_row["top1"] > best_baseline
        else (
            "MODEL FAILS TO BEAT the best baseline top-1 — the E16 honest "
            "result (movement is harder to learn than firing; quantify per "
            "sector below)"
        )
    )
    print(f"[e16] {verdict}")

    model_rec = per_sector_recall(y[va], top1_all[va])
    inert_rec = per_sector_recall(y[va], inert["top1"][va])
    for mr, ir in zip(model_rec, inert_rec):
        if mr["n"]:
            delta = (mr["recall"] or 0.0) - (ir["recall"] or 0.0)
            print(
                f"[e16]   sector {mr['sector']:2d} (n={mr['n']:5d}): model recall "
                f"{mr['recall']:.3f} vs inertia {ir['recall']:.3f} ({delta:+.3f})"
            )

    # ── CV (optional; node3 is an 8-core slice — default off) ───────────
    cv_report: dict = {"mode": "skipped (default; enable with --cv-folds)"}
    cv_groups = data["group"][train_idx] if args.holdout_version is not None else data["group"]
    if args.cv_folds >= 2 and len(set(cv_groups)) >= 2:
        k = min(args.cv_folds, len(set(cv_groups)))
        folds = tfm.group_kfold_assign(cv_groups, k)
        cv_base = train_idx if args.holdout_version is not None else np.arange(n)
        fold_acc: list[float] = []
        for f in range(k):
            te = cv_base[np.flatnonzero(folds == f)]
            tr = cv_base[np.flatnonzero(folds != f)]
            fm = build_move_model(args.hidden, data["entity_dim"], data["global_dim"]).to(device)
            fo = torch.optim.AdamW(fm.parameters(), lr=args.lr)
            for epoch in range(args.epochs):
                fm.train()
                order = tr[np.random.permutation(len(tr))]
                for s in range(0, len(order), args.batch_size):
                    idx = order[s : s + args.batch_size]
                    b = batch(idx)
                    loss = ce(fm(b["entity"], b["global"], b["mask"]), y_t[idx])
                    fo.zero_grad()
                    loss.backward()
                    fo.step()
            fm.eval()
            fl = predict_all(fm, te)
            acc = float((fl.argmax(axis=1) == y[te]).mean())
            fold_acc.append(acc)
            print(f"[e16] fold {f + 1}/{k}: top1 {acc:.4f} ({len(te)} rows)")
        cv_report = {
            "mode": f"GroupKFold k={k} grouped by replayId",
            "fold_top1": fold_acc,
            "top1_mean": float(np.mean(fold_acc)),
            "top1_std": float(np.std(fold_acc)),
        }

    metrics: dict = {
        "dataset": [str(p) for p in data_paths],
        "rows": int(n),
        "replay_groups": int(len(groups)),
        "rows_dropped_excluded_modes": dropped_modes,
        "sector_histogram": hist.tolist(),
        "no_move_share": float(hist[MOVE_SECTOR_NONE] / n),
        "sector0_share": float(hist[0] / n),
        "label_entropy_nats": label_entropy_nats(y),
        "moved_dist_p50_m": float(np.median(data["moved_dist_m"])),
        "moved_dist_p90_m": float(np.percentile(data["moved_dist_m"], 90)),
        "params": int(n_params),
        "device": str(device),
        "hidden": args.hidden,
        "epochs": args.epochs,
        "label_smoothing": args.label_smoothing,
        "ablate": args.ablate,
        "feature_version": int(data["feature_version"]),
        "entity_dim": int(data["entity_dim"]),
        "global_dim": int(data["global_dim"]),
        "loss_first": losses[0],
        "loss_last": losses[-1],
        "loss_curve_every10": losses[9::10],
        "split": {
            "mode": split_mode,
            "rows_heldout": int(len(val_idx)),
            "rows_train": int(len(train_idx)),
            "heldout_groups": sorted(set(data["group"][val_idx].tolist())),
        },
        "heldout_table": table,
        "heldout_sector_recall_model": model_rec,
        "heldout_sector_recall_inertia": inert_rec,
        "heldout_label_histogram": np.bincount(y[va], minlength=MOVE_SECTORS).tolist(),
        "train_label_histogram": np.bincount(y[train_idx], minlength=MOVE_SECTORS).tolist(),
        "speed_gated_inertia_threshold_kt": SPEED_GATED_INERTIA_KT,
        "cv": cv_report,
        "verdict": verdict,
    }

    # ── ONNX export (static shapes, batch 1) ─────────────────────────────
    model = model.cpu()
    fp32_path = out_dir / "fp32.onnx"
    ex = torch.from_numpy(data["entity"][:1])
    gx = torch.from_numpy(data["global"][:1])
    mx = torch.from_numpy(data["mask"][:1])
    try:
        torch.onnx.export(
            model,
            (ex, gx, mx),
            str(fp32_path),
            input_names=["entity", "global_feat", "mask"],
            output_names=["logits"],
            opset_version=17,
            dynamo=False,
        )
    except TypeError:
        torch.onnx.export(
            model,
            (ex, gx, mx),
            str(fp32_path),
            input_names=["entity", "global_feat", "mask"],
            output_names=["logits"],
            opset_version=17,
        )
    onnx.checker.check_model(onnx.load(str(fp32_path)))
    print(f"[e16] exported + checked {fp32_path} ({fp32_path.stat().st_size:,} bytes)")

    from onnxruntime.quantization import QuantType, quantize_dynamic
    import shutil
    import tempfile

    int8_path = out_dir / "int8.onnx"
    with tempfile.TemporaryDirectory() as td:
        tmp_in = Path(td) / "fp32.onnx"
        shutil.copyfile(fp32_path, tmp_in)
        tmp_out = Path(td) / "int8.onnx"
        try:
            quantize_dynamic(str(tmp_in), str(tmp_out), weight_type=QuantType.QInt8)
        except TypeError:
            quantize_dynamic(str(tmp_in), str(tmp_out))
        shutil.copyfile(tmp_out, int8_path)
    onnx.checker.check_model(onnx.load(str(int8_path)))
    print(f"[e16] quantized -> {int8_path} ({int8_path.stat().st_size:,} bytes)")

    so = ort.SessionOptions()
    sess_fp32 = ort.InferenceSession(str(fp32_path), so, providers=["CPUExecutionProvider"])
    sess_int8 = ort.InferenceSession(str(int8_path), so, providers=["CPUExecutionProvider"])

    def run_ort(sess, e, g, m, limit=None):
        """Batch-1 ORT forwards (static batch 1): [N, 17] logits."""
        out = []
        nn = len(g) if limit is None else min(limit, len(g))
        for i in range(nn):
            (lo,) = sess.run(
                None,
                {
                    "entity": e[i : i + 1].astype(np.float32),
                    "global_feat": g[i : i + 1].astype(np.float32),
                    "mask": m[i : i + 1].astype(np.float32),
                },
            )
            out.append(np.asarray(lo).reshape(-1))
        return np.stack(out)

    # Parity / quantization / permutation / mask-boundary battery (note C),
    # bounded row counts — the batch-1 ORT loop is O(rows).
    check = np.arange(min(args.parity_samples, n))
    _dev = device
    device = torch.device("cpu")
    pt_check = predict_all(model, check)
    device = _dev
    ort_check = run_ort(sess_fp32, data["entity"], data["global"], data["mask"], limit=len(check))
    parity = float(np.max(np.abs(softmax(pt_check) - softmax(ort_check))))
    q_check = run_ort(sess_int8, data["entity"], data["global"], data["mask"], limit=len(check))
    quant_dp = float(np.max(np.abs(softmax(q_check) - softmax(ort_check))))
    acc_fp32 = float((ort_check.argmax(axis=1) == y[check]).mean())
    acc_int8 = float((q_check.argmax(axis=1) == y[check]).mean())
    print(
        f"[e16] parity fp32 PyTorch vs ORT over {len(check)} rows: max|dp| {parity:.2e}; "
        f"int8 max|dp| {quant_dp:.2e}; top1 fp32 {acc_fp32:.4f} vs int8 {acc_int8:.4f}"
    )
    perm_max = 0.0
    for i in range(200):
        pidx = np.random.permutation(tfm.SLOTS)
        e = data["entity"][i][pidx][None]
        m = data["mask"][i][pidx][None]
        g = data["global"][i][None]
        plo = run_ort(sess_fp32, e, g, m)
        perm_max = max(perm_max, float(np.max(np.abs(plo[0] - ort_check[i]))))
    print(f"[e16] permutation (200 rows): fp32 max|dlogit| {perm_max:.2e}")
    worst_nan = False
    for i in range(50):
        e = data["entity"][i].copy()
        m = data["mask"][i].copy()
        e[: tfm.ENEMY_SLOTS] = 0.0
        m[: tfm.ENEMY_SLOTS] = 0.0
        lo = run_ort(sess_fp32, e[None], data["global"][i][None], m[None])
        worst_nan = worst_nan or not np.isfinite(lo).all()
    e0 = np.zeros((1, tfm.SLOTS, data["entity_dim"]), dtype=np.float32)
    m0 = np.zeros((1, tfm.SLOTS), dtype=np.float32)
    g0 = np.zeros((1, data["global_dim"]), dtype=np.float32)
    lo0 = run_ort(sess_fp32, e0, g0, m0)
    empty_finite = bool(np.isfinite(lo0).all())
    print(
        f"[e16] mask boundary: enemy-masked finite={not worst_nan}, "
        f"all-masked finite={empty_finite}"
    )

    sample = {
        "_lineage": "featurized movement dataset row 0 (train_move_model.py, fire-v2 featurizers)",
        "entity": data["entity"][0].tolist(),
        "global": data["global"][0].tolist(),
        "mask": data["mask"][0].tolist(),
        "slots": tfm.SLOTS,
        "entityDim": int(data["entity_dim"]),
        "globalDim": int(data["global_dim"]),
        "moveSectors": MOVE_SECTORS,
    }
    (out_dir / "sample_input.json").write_text(json.dumps(sample), encoding="utf-8")

    metrics.update(
        {
            "parity_fp32_max_dp": parity,
            "int8_max_dp": quant_dp,
            "top1_fp32_ort_checkrows": acc_fp32,
            "top1_int8_ort_checkrows": acc_int8,
            "permutation_fp32_max_dlogit": perm_max,
            "mask_boundary_finite": bool(not worst_nan and empty_finite),
            "torch_version": torch.__version__,
            "onnx_version": onnx.__version__,
            "onnxruntime_version": ort.__version__,
        }
    )

    def jsonable(o):
        if isinstance(o, dict):
            return {k: jsonable(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [jsonable(v) for v in o]
        if isinstance(o, (np.floating, float)):
            f = float(o)
            return None if math.isnan(f) or math.isinf(f) else f
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.ndarray):
            return jsonable(o.tolist())
        return o

    (out_dir / "metrics.json").write_text(json.dumps(jsonable(metrics), indent=2), encoding="utf-8")
    print(f"[e16] wrote {out_dir / 'metrics.json'} and sample_input.json")

    assert parity < 1e-4, "fp32 parity failed"
    assert not worst_nan and empty_finite, "NaN at mask boundary"
    assert perm_max < 1e-4, "permutation invariance failed"
    assert losses[-1] < 0.95 * losses[0], "train loss did not decrease enough"
    print("[e16] ALL pipeline checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
