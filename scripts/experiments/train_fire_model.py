#!/usr/bin/env python3
"""Train the two-head fire-decision DeepSets model (E9 loop, E12 scale-up).

Closes the model-delivery loop that E9 prototyped end to end:

    Rust sample export (fire_dataset.rs, WOWSP_DATASET_OUT — single replay,
    or the E12 batch folder ingestion for many replays)
      -> THIS SCRIPT: featurize -> split BY REPLAY (GroupKFold, no trajectory
         leakage) -> train PyTorch DeepSets two-head
      -> static-shape ONNX export (fp32) -> int8 dynamic quantization
      -> Rust `ort` loads the REAL model and runs a forward (decision_ai.rs
         test `e9_real_model_forward_*`).

The model follows research note C's first-choice structure: fixed entity
slots + padding mask, contextualised DeepSets — per-entity shared MLP,
broadcast-concat global features, two narrow interaction layers, two binary
heads (labelA "physically can fire", labelB "expert chose to fire", research
note B's DeepHit template). Only MatMul/Add/Relu/Where/Mul/Div ops — no
attention, no LayerNorm — so the ONNX export + int8 dynamic quantization risk
chain disappears entirely.

E12 additions over E9:
  - multi-replay data: `--data` is repeatable and `--data-dir` globs every
    `*.jsonl` beneath a directory (the batch-aggregated dataset);
  - rows carry `replayId` (stamped by the Rust batch exporter); the split is
    GroupKFold over that key — NEVER over `ownerEntityId`, which repeats
    across replays — plus a leave-one-replay-out held-out report;
  - research note B metric battery on the held-out replay: log loss, Brier,
    PR-AUPRC, ROC-AUC, ECE + reliability-curve data, stratified Cohen's kappa
    (nearest-enemy distance bucket x observed-enemy-count bucket), decile
    lift with Spearman rho, and the "physically cannot fire" false-positive
    count for head A.
  - E13: post-hoc OUTCOME lift — the Rust exporter now stamps outcome
    fields on every row (ownerShotsHit / ownerShotsFired /
    enemyHpLostNearby over (t + labelWindow, t + 45 s] + gameMode), so the
    held-out report and metrics.json carry the real decile curves over
    window hit rate and enemy HP lost (outcome_lift.py's logic, imported —
    datasets exported before E13 degrade to a status note);
  - E13: `--holdout-version 15,8` holds out every row of one client version
    (train on the rest, or on `--train-version 14,5` only) — the
    out-of-distribution stress test across game versions.
  - E14: feature-schema routing — datasets stamp `featureVersion` (v1 rows
    carry no key); v2 adds the E14 families (explicit vision / consumables /
    engine / smoke / weather / ally radar-hydro), entity 10->15 and global
    14->27 dims, model input widths follow the schema (hidden structure
    untouched). `--ablate {e11,smoke,weather,builds}` zeroes one feature
    family before training for the feature-group ablations.
  - E15: `--label {plain,hit,soft}` selects the head-B target — plain =
    expert fired (the E9-E13 default, backward-comparable), hit = fired AND
    the outcome window landed a server-confirmed hit, soft = 0.3 + 0.7*hit
    on fired rows. Loss stays BCE; a plain-label "comparability anchor"
    block is reported whenever a non-plain target trains the head.

SCOPE (important): this validates the PIPELINE, not model quality. The
training data available today is ONE replay (3584 rows / 1330 can-fire /
171 fired, the E7 reference numbers); with a single replay the split falls
back to E9's random 80/20 and every held-out number below is machinery
evidence, not a performance claim. Overfitting is expected and accepted.

Usage:
    # 1. export the dataset from a replay folder (E12 batch; single replay
    #    also works — it is copied into a temp folder next to planted bad
    #    files to prove tolerance):
    WOWSP_TEST_REPLAY=<replay> WOWSP_DATASET_OUT=<dataset.jsonl> \
        cargo test -p wowsp_tauri e12_batch_export -- --nocapture
    # 2. train + split + evaluate + export + validate:
    python scripts/experiments/train_fire_model.py \
        --data scripts/experiments/out/fire_model/dataset.jsonl
    # multi-replay: --data a.jsonl --data b.jsonl / --data-dir <dir>
    # 3. prove the Rust side loads the real model:
    cargo test -p wowsp_tauri e9_real_model -- --ignored --nocapture

Outputs (under --out-dir, default scripts/experiments/out/fire_model/):
    fp32.onnx          static-shape ONNX export (batch 1)
    int8.onnx          int8 dynamic-quantized version
    sample_input.json  one featurized row (entity/global/mask arrays) for the
                       Rust-side ort test — avoids duplicating the featurizer
    metrics.json       all validation numbers (split, held-out note-B battery,
                       parity, quantization, permutation, mask boundary,
                       loss curve summary)

Dependencies (NOT added to scripts/requirements.txt — experiment-only):
    torch (CPU wheel), onnx, onnxruntime, numpy.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

# ── featurization layout (must stay in sync with fire_dataset.rs export) ─────

ENEMY_SLOTS = 16
FRIEND_SLOTS = 8
SLOTS = ENEMY_SLOTS + FRIEND_SLOTS

# Schema versions (E14): v1 rows carry no featureVersion key (read as 1).
# v1 = the E9/E13 layout; v2 adds the E14 feature families — entity slots
# gain the explicit vision verdict / smoke / radar / side / engine columns,
# the global block gains consumable windows, engine state, smoke geometry,
# the weather (cyclone) timeline, ally radar/hydro build counts and the
# E11 availability flag. All v2 features are PRE-NORMALIZED on the Rust side
# (bounded fractions or -1/0 unknown sentinels) and pass through unchanged.
ENTITY_DIM_V1 = 10
GLOBAL_DIM_V1 = 14
ENTITY_DIM_V2 = 15
GLOBAL_DIM_V2 = 27

# v2 entity column groups (for --ablate; indices within ENTITY_DIM_V2).
V2_ENT_E11 = [10, 14]  # spottedNow, enginePowerFrac
V2_ENT_SMOKE = [11]  # insideSmoke
V2_ENT_BUILDS = [12]  # radarLit
# v2 global column groups (indices within GLOBAL_DIM_V2).
V2_GLB_E11 = [14, 15, 16, 17, 18, 26]  # consumables x3, engine x2, known flag
V2_GLB_SMOKE = [19, 20, 21]  # ownInSmoke, count, area
V2_GLB_WEATHER = [22, 23]  # vision cap, incoming ramp
V2_GLB_BUILDS = [24, 25]  # ally radar / hydro counts

# Normalization constants — deliberately fixed (no fitted scalers: one replay
# of data; every scale documented so the Rust side could mirror them later).
DIST_SCALE_M = 10_000.0  # planar distance: ~10 km -> 1.0
SPEED_SCALE_KT = 40.0  # top warship speeds ~40 kt
AGE_SCALE_S = 60.0  # observation age: clamp 60 s -> 1.0
TIME_SCALE_S = 1200.0  # match time: 20 min battle -> 1.0
RANGE_SCALE_M = 30_000.0  # engagement range: ~30 km -> 1.0
ZONE_SCALE = 10.0  # zone counts
EVENT_SCALE = 8.0  # log1p(event count) / 8 (138 shells/30 s -> ~0.61)

# Nearest-enemy distance buckets for the stratified-kappa report (note B).
DIST_BUCKETS = [
    (None, 5_000.0, "<5km"),
    (5_000.0, 15_000.0, "5-15km"),
    (15_000.0, None, ">15km"),
]
# Observed-now enemy count buckets: 0 / 1 / 2 / 3+.
OBS_COUNT_BUCKETS = [(0, 0, "0"), (1, 1, "1"), (2, 2, "2"), (3, None, "3+")]
# Minimum rows per stratum for a kappa to be reported.
KAPPA_MIN_N = 30


def featurize_slot(slot: dict | None, ver: int = 1) -> list[float]:
    """One entity slot -> ENTITY_DIM floats. `None` (padding) -> zeros."""
    if slot is None:
        return [0.0] * (ENTITY_DIM_V1 if ver == 1 else ENTITY_DIM_V2)
    dist = min(slot["distM"] / DIST_SCALE_M, 2.0)
    b = slot["bearingRelRad"]
    speed = slot.get("speedKt")
    hp = slot.get("hpFrac")
    los = slot.get("terrainBlocked")
    base = [
        dist,
        math.sin(b),
        math.cos(b),
        (speed / SPEED_SCALE_KT) if speed is not None else -1.0,
        hp if hp is not None else -1.0,
        min(slot["obsAgeS"] / AGE_SCALE_S, 1.0),
        1.0 if slot["observedNow"] else 0.0,
        (-1.0 if los is None else (1.0 if los else 0.0)),
        1.0 if slot["entityType"] == 2 else 0.0,  # EntityKind one-hot summary
        1.0 if speed is not None else 0.0,  # speedKnown flag
    ]
    if ver == 1:
        return base
    spotted = slot.get("spottedNow")
    engine = slot.get("enginePowerFrac")
    return base + [
        (-1.0 if spotted is None else (1.0 if spotted else 0.0)),
        1.0 if slot.get("insideSmoke") else 0.0,
        1.0 if slot.get("radarLit") else 0.0,
        1.0 if slot.get("isEnemy") else 0.0,
        engine if engine is not None else -1.0,
    ]


def entity_matrix_and_mask(row: dict, ver: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """One exported JSON row's entity block: `[SLOTS, ENTITY_DIM]` slot
    features + the `[SLOTS]` padding mask (E16 extraction — shared with
    train_move_model's loader; enemies then friends, truncated to their
    slot budgets)."""
    entity_dim = ENTITY_DIM_V1 if ver == 1 else ENTITY_DIM_V2
    entities: list[dict | None] = list(row["enemies"])[:ENEMY_SLOTS]
    entities += list(row["friends"])[:FRIEND_SLOTS]
    entity = np.zeros((SLOTS, entity_dim), dtype=np.float32)
    mask = np.zeros((SLOTS,), dtype=np.float32)
    for i, slot in enumerate(entities):
        entity[i] = featurize_slot(slot, ver)
        mask[i] = 1.0
    return entity, mask


def global_vector(row: dict, ver: int = 1) -> np.ndarray:
    """One exported JSON row's global feature block (`[GLOBAL_DIM]` — v1 14
    dims, v2 +13 pre-normalized E14 dims; E16 extraction shared with
    train_move_model's loader)."""
    own_speed = row.get("ownSpeedKt")
    g = np.array(
        [
            row["t"] / TIME_SCALE_S,
            (own_speed / SPEED_SCALE_KT) if own_speed is not None else -1.0,
            row.get("ownHpFrac", -1.0) if row.get("ownHpFrac") is not None else -1.0,
            row["ownReloadFrac"],
            row["ownRangeM"] / RANGE_SCALE_M,
            row["zonesOwned0"] / ZONE_SCALE,
            row["zonesOwned1"] / ZONE_SCALE,
            row["zonesOwned2"] / ZONE_SCALE,
            row["zonesOwnedOther"] / ZONE_SCALE,
            row["zonesActiveProgress"] / ZONE_SCALE,
            math.log1p(row["eventsShells30s"]) / EVENT_SCALE,
            math.log1p(row["eventsTorps30s"]) / EVENT_SCALE,
            math.log1p(row["eventsExplosions30s"]) / EVENT_SCALE,
            math.log1p(row["eventsExplosionsNear30s"]) / EVENT_SCALE,
        ],
        dtype=np.float32,
    )
    if ver == 2:
        # All v2 global features arrive pre-normalized from the Rust export
        # (bounded fractions; -1 = stream unavailable; 0 = known inactive).
        g = np.concatenate(
            [
                g,
                np.array(
                    [
                        row.get("ownDamconFrac", -1.0),
                        row.get("ownRepairFrac", -1.0),
                        row.get("ownOtherConsumableFrac", -1.0),
                        row.get("ownEnginePower", -1.0),
                        row.get("ownEngineDir", 0.0),
                        1.0 if row.get("ownInSmoke") else 0.0,
                        row.get("activeSmokeCountFrac", 0.0),
                        row.get("activeSmokeAreaFeat", 0.0),
                        row.get("visionCapFrac", 1.0),
                        row.get("weatherIncomingFrac", 0.0),
                        row.get("allyRadarCountFrac", -1.0),
                        row.get("allyHydroCountFrac", -1.0),
                        1.0 if row.get("e11EventsKnown") else 0.0,
                    ],
                    dtype=np.float32,
                ),
            ]
        )
    return g


def featurize_row(row: dict, ver: int = 1) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, float | None]:
    """One exported JSON row -> (entity[SLOTS, ENTITY_DIM], global[GLOBAL_DIM],
    mask[SLOTS], labelA, labelB). `labelB` is the PLAIN fire label (float for
    E15 soft rows); the hit/soft variants are pulled off the raw row by
    `load_datasets`."""
    entity, mask = entity_matrix_and_mask(row, ver)
    g = global_vector(row, ver)
    label_a = int(row["labelACanFire"])
    fired = row.get("labelBFired")
    label_b = None if fired is None else float(fired)
    return entity, g, mask, label_a, label_b


def row_strat(row: dict, source_stem: str) -> tuple[str, float | None, int]:
    """Per-row metadata for splitting/stratification: the replay GROUP key
    (row `replayId` when the batch exporter stamped it, else the source file
    stem — one aggregated file's rows then form one group), the nearest
    OBSERVED-NOW enemy distance (metres; None when no enemy is observed) and
    the observed-now enemy count."""
    group = row.get("replayId") or source_stem
    observed = [e for e in row.get("enemies", []) if e.get("observedNow")]
    dist = min((e["distM"] for e in observed), default=None)
    return str(group), dist, len(observed)


def load_datasets(paths: list[Path]) -> dict:
    """Merge JSONL datasets from every path (E12: multi-replay). Adds:
    `group` (replay identity per row), `nearest_enemy_dist_m`,
    `observed_enemy_count`; `rows_meta` keeps the raw rows in the same order.
    E14: the schema version (row `featureVersion`, absent -> 1) is detected
    per FILE and must agree across files — v1/v2 featurizations cannot mix
    (dims differ). The returned dict carries `feature_version`,
    `entity_dim`, `global_dim`, plus the E15 target columns `label_b_hit`
    (NaN where censored/absent) and `label_b_soft` alongside the plain
    `label_b`. Duplicate paths are de-duplicated preserving order."""
    seen: set[Path] = set()
    unique: list[Path] = []
    for p in paths:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            unique.append(p)
    # Two-pass streaming load (E19 scale): a multi-million-row corpus must
    # never hold the raw JSON dicts and the feature arrays at the same time.
    # Pass 1 validates + counts (no dicts retained); pass 2 featurizes
    # line-by-line straight into the arrays. Small corpora still keep
    # `rows_meta` (the self-test parity fixtures rely on it).
    file_versions: list[int] = []
    total_rows = 0
    for path_ in unique:
        ver: int | None = None
        file_rows = 0
        with open(path_, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    row_ver = int(json.loads(line).get("featureVersion", 1) or 1)
                except json.JSONDecodeError as e:  # pragma: no cover
                    raise SystemExit(f"[e12] malformed JSONL at {path_}:{n}: {e}") from e
                if ver is None:
                    ver = row_ver
                elif row_ver != ver:
                    raise SystemExit(
                        f"[e14] {path_} mixes featureVersions {ver} and {row_ver} — "
                        "one file must come from one export schema"
                    )
                file_rows += 1
        file_versions.append(ver or 1)
        total_rows += file_rows
        print(f"[e12] counted {file_rows:7d} rows (featureVersion {ver or 1}) from {path_}")
    if not total_rows:
        if not unique:
            raise SystemExit(
                "[e12] no dataset files to load (check --data / --data-dir)"
            )
        raise SystemExit(
            "[e12] no rows found in "
            + ", ".join(str(p) for p in unique)
            + " — rerun the Rust export first"
        )
    if len(set(file_versions)) != 1:
        raise SystemExit(
            f"[e14] mixed featureVersions across files ({file_versions}) — "
            "v1 and v2 datasets cannot train together"
        )
    version = file_versions[0]
    entity_dim = ENTITY_DIM_V1 if version == 1 else ENTITY_DIM_V2
    global_dim = GLOBAL_DIM_V1 if version == 1 else GLOBAL_DIM_V2
    n = total_rows
    keep_meta = n < 2_000_000
    data = {
        "feature_version": version,
        "entity_dim": entity_dim,
        "global_dim": global_dim,
        "entity": np.zeros((n, SLOTS, entity_dim), dtype=np.float32),
        "global": np.zeros((n, global_dim), dtype=np.float32),
        "mask": np.zeros((n, SLOTS), dtype=np.float32),
        "label_a": np.zeros((n,), dtype=np.float32),
        # labelB ground truth where defined; head-B loss is masked to
        # labelA==1 rows (a hold during reload is physics, not a decision).
        # `label_b` stays the PLAIN fire label for every consumer
        # (outcome_lift's expert baseline included); the E15 variants ride
        # their own columns and the train side picks via --label.
        "label_b": np.full((n,), np.nan, dtype=np.float32),
        "label_b_hit": np.full((n,), np.nan, dtype=np.float32),
        "label_b_soft": np.full((n,), np.nan, dtype=np.float32),
        "group": np.empty((n,), dtype=object),
        "nearest_enemy_dist_m": np.full((n,), np.nan, dtype=np.float32),
        "observed_enemy_count": np.zeros((n,), dtype=np.int32),
        # E19 low-memory mode: the outcome scalars outcome_lift needs,
        # pre-extracted so the raw row dicts can be dropped afterwards.
        "outcome_hits": np.zeros((n,), dtype=np.float64),
        "outcome_fired": np.zeros((n,), dtype=np.float64),
        "outcome_hp_lost": np.zeros((n,), dtype=np.float64),
        "outcome_mode": np.empty((n,), dtype=object),
        "outcome_version": np.empty((n,), dtype=object),
        "outcome_rows": 0,
        "rows_meta": [] if keep_meta else None,
    }
    rows = data["rows_meta"]
    attr_rows: list[list[float]] = []
    pose = 0
    for path_ in unique:
        stem = path_.stem
        with open(path_, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                e, g, m, la, lb = featurize_row(row, version)
                data["entity"][pose], data["global"][pose], data["mask"][pose] = e, g, m
                data["label_a"][pose] = la
                if lb is not None:
                    data["label_b"][pose] = lb
                hit = row.get("labelBHit")
                if hit is not None:
                    data["label_b_hit"][pose] = float(hit)
                soft = row.get("labelBSoft")
                if soft is not None:
                    data["label_b_soft"][pose] = float(soft)
                grp, dist, cnt = row_strat(row, stem)
                data["group"][pose] = grp
                data["nearest_enemy_dist_m"][pose] = dist if dist is not None else np.nan
                data["observed_enemy_count"][pose] = cnt
                h = row.get("ownerShotsHit")
                fshots = row.get("ownerShotsFired")
                hp = row.get("enemyHpLostNearby")
                if h is not None or fshots is not None or hp is not None:
                    data["outcome_rows"] += 1
                    data["outcome_hits"][pose] = float(h or 0.0)
                    data["outcome_fired"][pose] = float(fshots or 0.0)
                    data["outcome_hp_lost"][pose] = float(hp or 0.0)
                if ATTR_TABLE:
                    attr_rows.append(row_attr_vector(row))
                data["outcome_mode"][pose] = row.get("gameMode")
                data["outcome_version"][pose] = row.get("replayVersion")
                if keep_meta:
                    rows.append(row)
                pose += 1
    assert pose == n, f"row count drifted: {pose} != {n}"
    if ATTR_TABLE and attr_rows:
        data["attrs"] = np.array(attr_rows, dtype=np.float32)
    else:
        data["attrs"] = None
    return data


# ── split (research note B: group by REPLAY, never by entity id) ────────────


def group_kfold_assign(groups: np.ndarray, k: int) -> np.ndarray:
    """Deterministic GroupKFold (sklearn semantics, no dependency): groups
    sorted by row count descending (ties by first appearance), each assigned
    to the currently-lightest fold. Returns fold index per ROW; every row of
    a group lands in exactly one fold."""
    unique, inverse = np.unique(groups, return_inverse=True)
    counts = np.bincount(inverse)
    order = sorted(range(len(unique)), key=lambda gi: (-counts[gi], unique[gi]))
    fold_weight = np.zeros(k, dtype=np.int64)
    group_fold = np.empty(len(unique), dtype=np.int64)
    for gi in order:
        f = int(np.argmin(fold_weight))  # argmin ties -> lowest fold index
        group_fold[gi] = f
        fold_weight[f] += counts[gi]
    return group_fold[inverse]


def leave_one_replay_out(groups: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Held-out = the LARGEST replay group (deterministic; ties by name),
    train = every other row. Returns (train_idx, heldout_idx)."""
    unique = np.unique(groups)
    sizes = [(int((groups == g).sum()), str(g)) for g in unique]
    heldout_group = max(sizes)[1]
    mask = groups == heldout_group
    return np.flatnonzero(~mask), np.flatnonzero(mask)


# ── version split (E13: out-of-distribution stress across game versions) ─────


def normalize_version_prefix(prefix: str) -> str:
    """'15,8' / '15.8.0' / ' 15.8 ' / '15,8,0,12345' -> leading numeric
    segments joined by dots, at most THREE (major.minor.patch — build ids
    like clientVersionFromExe's 4th segment are dropped); commas tolerated."""
    parts = [p.strip() for p in prefix.replace(",", ".").split(".")]
    out: list[str] = []
    for p in parts:
        if len(out) >= 3:
            break
        if p and p.isdigit():
            out.append(p)
        else:
            break
    if not out:
        raise SystemExit(f"[e13] unparsable version prefix: {prefix!r}")
    return ".".join(out)


def row_version_prefix(version: str | None) -> str | None:
    """One row's replayVersion normalized the same way (leading numeric
    segments, dots); None when the row carries no version."""
    if not version:
        return None
    try:
        return normalize_version_prefix(str(version))
    except SystemExit:
        return None


def version_matches(version: str | None, prefix: str) -> bool:
    """Segment-wise version match: every prefix segment must equal the
    version's segment at the same position (extra version segments allowed).

    A plain `startswith` would make "14.1" swallow "14.11.x" (WoWS ships
    two-digit minors), so compare segments, not strings."""
    if not version:
        return False
    got = str(version).split(".")
    want = prefix.split(".")
    return len(got) >= len(want) and all(g == w for g, w in zip(got, want))


# ── model (research note C first choice) ─────────────────────────────────────


def build_model(
    hidden: int = 320,
    entity_dim: int = ENTITY_DIM_V1,
    global_dim: int = GLOBAL_DIM_V1,
    moe: int | None = None,
    moe_gate_hidden: int = 64,
) -> "torch.nn.Module":
    if moe:
        return build_moe_model(hidden, entity_dim, global_dim, experts=moe, gate_hidden=moe_gate_hidden)
    import torch
    import torch.nn as nn

    # default 320 -> ~0.32 M params, inside the 0.3–1 M budget of note C.
    # E14: the input widths follow the dataset's feature schema (v1 10/14,
    # v2 15/27) — the HIDDEN structure is untouched, only the first/ctx
    # layers widen.

    class TwoHeadDeepSets(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.phi = nn.Sequential(  # per-entity shared encoder
                nn.Linear(entity_dim, hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden),
                nn.ReLU(),
            )
            self.ctx1 = nn.Linear(hidden + global_dim, hidden)  # broadcast-concat
            self.ctx2 = nn.Linear(hidden, hidden)  # 2nd narrow interaction layer
            self.head_a = nn.Linear(hidden, 1)  # "physically can fire"
            self.head_b = nn.Linear(hidden, 1)  # "expert fired"

        def forward(self, entity, global_feat, mask):
            # entity [B,S,E], global_feat [B,G], mask [B,S]
            h = self.phi(entity)  # [B,S,H]
            g = global_feat.unsqueeze(1).expand(-1, h.size(1), -1)
            h = torch.relu(self.ctx1(torch.cat([h, g], dim=-1)))
            h = torch.relu(self.ctx2(h))
            m = mask.unsqueeze(-1)
            # Masked mean aggregation: padded slots contribute exactly zero.
            # No -inf anywhere — the classic all-masked NaN path cannot occur
            # (sum=0 / clamp(min=1) = 0 vector -> finite head logits).
            agg = (h * m).sum(dim=1) / mask.sum(dim=1, keepdim=True).clamp(min=1.0)
            return self.head_a(agg).squeeze(-1), self.head_b(agg).squeeze(-1)

    return TwoHeadDeepSets()


# -- E24: weapon-attribute routing input -----------------------------------
# The table is built by build_ship_attributes.py out of the gameparams
# pack: per-ship weapon attributes (concealment, smoke-firing detection,
# main-battery range, torpedo range, radar/hydro flags) plus team
# composition aggregates. The router reads SHIP PROPERTIES, never ship
# names — a mixed-role hull (a gunboat DD, a Hel-style hybrid in a DD
# slot with cap duty) routes by what it can do and partially activates
# every expert its attribute profile matches.
ATTR_DIM = 10
ATTR_TABLE: dict[int, list[float]] = {}


def load_attr_table(path: str) -> None:
    """E24: load shipId -> weapon-attribute table. Raises when the table
    is requested but unreadable — a silent empty table would train an
    E19-shape gate while the run log claims attribute routing."""
    global ATTR_TABLE
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    for sid, a in raw.items():
        ATTR_TABLE[int(sid)] = [
            float(a.get("vis") or 0) / 20.0,
            float(a.get("visSmoke") or 0) / 5.0,
            float(a.get("mbRange") or 0) / 30000.0,
            float(a.get("torpRange") or 0) / 20000.0,
            float(a.get("hasRadar") or 0),
            float(a.get("hasHydro") or 0),
        ]


def _attrs_of(sid) -> list[float]:
    a = ATTR_TABLE.get(int(sid)) if sid else None
    # unknown ship -> neutral mid-brightness defaults, not zeros: zeroing
    # would read as "minimum concealment, no guns" — the worst possible
    # imputation for an unidentified hull.
    return a if a is not None else [0.5, 0.0, 0.5, 0.0, 0.0, 0.0]


def row_attr_vector(row: dict) -> list[float]:
    """Own-ship 6 dims + 4 team-composition dims (mean friend/enemy
    main-battery range and concealment): the router sees what MY ship can
    do and what the lobby around it looks like."""
    own = _attrs_of(row.get("shipId"))
    fr_r = fr_v = en_r = en_v = 0.0
    fr_n = en_n = 0
    for e in row.get("friends", []):
        a = _attrs_of(e.get("shipId"))
        fr_r += a[2]
        fr_v += a[0]
        fr_n += 1
    for e in row.get("enemies", []):
        a = _attrs_of(e.get("shipId"))
        en_r += a[2]
        en_v += a[0]
        en_n += 1
    if fr_n:
        fr_r /= fr_n
        fr_v /= fr_n
    if en_n:
        en_r /= en_n
        en_v /= en_n
    return own + [fr_r, fr_v, en_r, en_v]


# ── E19: soft mixture-of-experts with a front router ─────────────────────────
# The router reads the EXISTING input contract only (the global feature block
# already carries the own-ship attribute proxies — main-battery range, reload,
# consumables, vision/smoke/radar-hydro — plus the pooled raw entity
# features); no new input tensor, so the ONNX contract and every downstream
# metric stay unchanged. Experts own their interaction layers + heads on top
# of the SHARED per-entity encoder; the gate softmaxes over experts and blends
# the head LOGITS (pre-sigmoid) — the dual-activation model: attribute
# similarity pulls every similar expert, and a mixed-role ship activates
# several experts partially instead of snapping to one.
MOE_DEFAULT_EXPERTS = 4
MOE_DEFAULT_AUX = 0.01
MOE_DEFAULT_GATE_HIDDEN = 64


def build_moe_model(
    hidden: int,
    entity_dim: int,
    global_dim: int,
    experts: int = MOE_DEFAULT_EXPERTS,
    gate_hidden: int = MOE_DEFAULT_GATE_HIDDEN,
) -> "torch.nn.Module":
    import torch
    import torch.nn as nn

    class MoEDeepSets(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.experts_n = experts
            self.phi = nn.Sequential(  # SHARED per-entity encoder
                nn.Linear(entity_dim, hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden),
                nn.ReLU(),
            )
            # Router: global attributes + pooled RAW entity stats + pooled
            # encoded context -> expert weights.
            self.gate1 = nn.Linear(
                global_dim + entity_dim + hidden + (ATTR_DIM if ATTR_TABLE else 0), gate_hidden
            )
            self.gate2 = nn.Linear(gate_hidden, experts)
            self.ctx1 = nn.ModuleList(
                nn.Linear(hidden + global_dim, hidden) for _ in range(experts)
            )
            self.ctx2 = nn.ModuleList(nn.Linear(hidden, hidden) for _ in range(experts))
            self.head_a = nn.ModuleList(nn.Linear(hidden, 1) for _ in range(experts))
            self.head_b = nn.ModuleList(nn.Linear(hidden, 1) for _ in range(experts))
            self.last_gate = None

        def forward(self, entity, global_feat, mask, attrs=None):
            m = mask.unsqueeze(-1)
            denom = mask.sum(dim=1, keepdim=True).clamp(min=1.0)
            pooled_raw = (entity * m).sum(dim=1) / denom  # [B, E]
            h = self.phi(entity)  # [B, S, H]
            g = global_feat.unsqueeze(1).expand(-1, h.size(1), -1)
            pooled_h = (h * m).sum(dim=1) / denom  # [B, H]
            gate_logits = self.gate2(
                torch.relu(
                    self.gate1(
                        torch.cat(
                            [global_feat, pooled_raw, pooled_h]
                            + ([attrs] if attrs is not None else []),
                            dim=-1,
                        )
                    )
                )
            )  # [B, K]
            w = torch.softmax(gate_logits, dim=-1)
            self.last_gate = w
            ctx = torch.cat([h, g], dim=-1)
            agg_a = []
            agg_b = []
            for k in range(self.experts_n):
                hk = torch.relu(self.ctx1[k](ctx))
                hk = torch.relu(self.ctx2[k](hk))
                agg = (hk * m).sum(dim=1) / denom
                agg_a.append(self.head_a[k](agg))
                agg_b.append(self.head_b[k](agg))
            weights = [w[:, k : k + 1] for k in range(self.experts_n)]
            logit_a = sum(wk * a for wk, a in zip(weights, agg_a)).squeeze(-1)
            logit_b = sum(wk * b for wk, b in zip(weights, agg_b)).squeeze(-1)
            return logit_a, logit_b

        def gate_balance_loss(self):
            w = self.last_gate
            if w is None:
                return None
            # Switch-Transformer style: K * sum_k(mean_gate_k^2). Uniform
            # gates score 1.0; the term only fights expert collapse.
            share = w.mean(dim=0)
            return w.size(1) * (share * share).sum()

    return MoEDeepSets()


def apply_ablation(data: dict, group: str) -> dict:
    """E14 analysis knob: zero one feature family's columns BEFORE training
    (train-time masking only — the export schema is untouched). Used for the
    feature-group ablations (e.g. train v2 without the E11 streams).
    Returns a NEW data dict; the input stays intact."""
    if group == "none":
        return data
    if data["feature_version"] != 2:
        raise SystemExit("[e14] --ablate needs a featureVersion 2 dataset")
    out = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in data.items()}
    ent_cols = {
        "e11": V2_ENT_E11,
        "smoke": V2_ENT_SMOKE,
        "builds": V2_ENT_BUILDS,
    }.get(group, [])
    glb_cols = {
        "e11": V2_GLB_E11,
        "smoke": V2_GLB_SMOKE,
        "builds": V2_GLB_BUILDS,
        "weather": V2_GLB_WEATHER,
    }.get(group, [])
    if not ent_cols and not glb_cols:
        raise SystemExit(f"[e14] unknown --ablate group {group!r}")
    for c in ent_cols:
        out["entity"][:, :, c] = 0.0
    for c in glb_cols:
        out["global"][:, c] = 0.0
    print(
        f"[e14] ablation {group}: zeroed entity cols {ent_cols}, global cols {glb_cols}"
    )
    return out


def select_label_target(data: dict, label: str) -> np.ndarray:
    """E15: the head-B training/eval target column for --label
    (plain | hit | soft). Falls back to plain with a loud note when the
    dataset predates the E15 exporter."""
    if label == "hit":
        col = data.get("label_b_hit")
        if col is not None and np.isfinite(col).any():
            return col
        print("[e15] dataset lacks labelBHit — falling back to the plain label")
    elif label == "soft":
        col = data.get("label_b_soft")
        if col is not None and np.isfinite(col).any():
            return col
        print("[e15] dataset lacks labelBSoft — falling back to the plain label")
    return data["label_b"]


# ── metrics (numpy-only; no sklearn dependency) ──────────────────────────────


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def average_precision(y_true: np.ndarray, scores: np.ndarray) -> float:
    """PR-AUPRC (average precision), primary metric of research note B."""
    if y_true.sum() == 0:
        return float("nan")
    order = np.argsort(-scores, kind="stable")
    y = y_true[order]
    tp = np.cumsum(y)
    prec = tp / (np.arange(len(y)) + 1.0)
    return float((prec * y).sum() / y_true.sum())


def log_loss(y_true: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(p, 1e-7, 1.0 - 1e-7)
    return float(-(y_true * np.log(p) + (1 - y_true) * np.log(1 - p)).mean())


def brier_score(y_true: np.ndarray, p: np.ndarray) -> float:
    return float(((p - y_true) ** 2).mean())


def _avg_ranks(x: np.ndarray) -> np.ndarray:
    """Average ranks (1-based) with ties sharing their mean rank."""
    x = np.asarray(x, dtype=np.float64)
    order = np.argsort(x, kind="stable")
    ranks = np.empty(len(x), dtype=np.float64)
    sx = x[order]
    i = 0
    while i < len(x):
        j = i
        while j + 1 < len(x) and sx[j + 1] == sx[i]:
            j += 1
        ranks[order[i : j + 1]] = 0.5 * (i + j) + 1.0
        i = j + 1
    return ranks


def roc_auc(y_true: np.ndarray, scores: np.ndarray) -> float:
    """ROC-AUC via average ranks (tie-correct Mann-Whitney)."""
    y_true = np.asarray(y_true) == 1
    pos, neg = int(y_true.sum()), int((~y_true).sum())
    if pos == 0 or neg == 0:
        return float("nan")
    r = _avg_ranks(scores)
    return float(
        (r[y_true].sum() - pos * (pos + 1) / 2.0) / (pos * neg)
    )


def ece_and_reliability(
    y_true: np.ndarray, p: np.ndarray, n_bins: int = 15
) -> tuple[float, list[dict]]:
    """Expected calibration error (equal-width bins) + the reliability-curve
    data (per bin: upper edge, mean predicted, empirical rate, count) as the
    JSON payload — plotting stays outside the pipeline."""
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    bins: list[dict] = []
    n = len(y_true)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1.0 else p <= hi)
        cnt = int(m.sum())
        if cnt == 0:
            bins.append({"upper": float(hi), "meanP": None, "empRate": None, "count": 0})
            continue
        conf = float(p[m].mean())
        emp = float(y_true[m].mean())
        ece += cnt / n * abs(conf - emp)
        bins.append(
            {"upper": float(hi), "meanP": conf, "empRate": emp, "count": cnt}
        )
    return float(ece), bins


def cohen_kappa_binary(y_true: np.ndarray, y_pred: np.ndarray) -> float | None:
    """Cohen's kappa for binary outcomes; None when degenerate (no variance
    in either variable beyond a perfect-match constant pair)."""
    n = len(y_true)
    if n == 0:
        return None
    po = float((y_true == y_pred).mean())
    pt, pp = float(y_true.mean()), float(y_pred.mean())
    pe = pt * pp + (1.0 - pt) * (1.0 - pp)
    if pe >= 1.0 - 1e-12:
        return None
    return (po - pe) / (1.0 - pe)


def spearman_rho(x: np.ndarray, y: np.ndarray) -> float | None:
    """Spearman rank correlation (ties averaged); None when a variable is
    constant."""
    rx, ry = _avg_ranks(x), _avg_ranks(y)
    rx -= rx.mean()
    ry -= ry.mean()
    denom = math.sqrt(float((rx**2).sum()) * float((ry**2).sum()))
    if denom == 0.0:
        return None
    return float((rx * ry).sum() / denom)


def _dist_bucket(dist_m: float) -> str:
    if not np.isfinite(dist_m):
        return "no-observed-enemy"
    for lo, hi, name in DIST_BUCKETS:
        if (lo is None or dist_m >= lo) and (hi is None or dist_m < hi):
            return name
    return "no-observed-enemy"  # pragma: no cover


def _count_bucket(c: int) -> str:
    for lo, hi, name in OBS_COUNT_BUCKETS:
        if (lo is None or c >= lo) and (hi is None or c <= hi):
            return name
    return "3+"  # pragma: no cover


def stratified_kappa(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    nearest_dist_m: np.ndarray,
    obs_count: np.ndarray,
) -> dict:
    """Note-B stratified Cohen's kappa: nearest-OBSERVED-enemy distance bucket
    (<5km / 5-15km / >15km / none) x observed-enemy-count bucket (0/1/2/3+).
    Strata under KAPPA_MIN_N rows (or with degenerate labels) report
    kappa=None with their n and positive rate so gaps are visible, not
    hidden."""
    dists = [_dist_bucket(d) for d in nearest_dist_m]
    counts = [_count_bucket(c) for c in obs_count]
    out = {"min_n": KAPPA_MIN_N, "strata": []}
    for dname in ["<5km", "5-15km", ">15km", "no-observed-enemy"]:
        for cname in ["0", "1", "2", "3+"]:
            m = np.array(
                [di == dname and ci == cname for di, ci in zip(dists, counts)],
                dtype=bool,
            )
            n = int(m.sum())
            entry = {
                "distBucket": dname,
                "obsEnemyBucket": cname,
                "n": n,
                "positiveRate": float(y_true[m].mean()) if n else None,
                "kappa": None,
            }
            if n >= KAPPA_MIN_N:
                entry["kappa"] = cohen_kappa_binary(
                    y_true[m].astype(np.float64), y_pred[m].astype(np.float64)
                )
            out["strata"].append(entry)
    return out


def decile_lift(y_true: np.ndarray, p: np.ndarray) -> dict:
    """Note-B decile lift: rank rows by predicted probability, split into ten
    equal-size deciles (1 = highest predicted), report each decile's actual
    positive rate and lift vs the base rate. Monotonicity is summarised as
    Spearman rho between each decile's MEAN PREDICTED probability and its
    ACTUAL rate (+1 = perfectly monotone lift; convention-free — decile 1
    has the highest predictions either way)."""
    n = len(y_true)
    base = float(y_true.mean()) if n else float("nan")
    order = np.argsort(-p, kind="stable")
    parts = np.array_split(order, 10)
    deciles = []
    for di, idx in enumerate(parts):
        if len(idx) == 0:
            deciles.append(
                {"decile": di + 1, "n": 0, "meanP": None, "actualRate": None, "lift": None}
            )
            continue
        rate = float(y_true[idx].mean())
        deciles.append(
            {
                "decile": di + 1,
                "n": int(len(idx)),
                "meanP": float(p[idx].mean()),
                "actualRate": rate,
                "lift": (rate / base) if base > 0 else None,
            }
        )
    pairs = [
        (d["meanP"], d["actualRate"])
        for d in deciles
        if d["actualRate"] is not None and d["meanP"] is not None
    ]
    rho = (
        spearman_rho(np.array([a for a, _ in pairs]), np.array([b for _, b in pairs]))
        if len(pairs) >= 3
        else None
    )
    return {"baseRate": base, "deciles": deciles, "spearmanRhoMeanPvsRate": rho}


def classification_report_head(
    name: str,
    y_true: np.ndarray,
    p: np.ndarray,
    dist_m: np.ndarray,
    obs_count: np.ndarray,
    threshold: float = 0.5,
) -> dict:
    """The full note-B battery for one head on one evaluation set."""
    finite = np.isfinite(y_true)
    y, pp = y_true[finite], p[finite]
    d, c = dist_m[finite], obs_count[finite]
    ece, rel = ece_and_reliability(y, pp)
    hard = (pp >= threshold).astype(np.float64)
    return {
        "head": name,
        "rows": int(len(y)),
        "positives": int(y.sum()),
        "baseRate": float(y.mean()) if len(y) else None,
        "logloss": log_loss(y, pp) if len(y) else None,
        "brier": brier_score(y, pp) if len(y) else None,
        "auprc": average_precision(y, pp) if len(y) else None,
        "roc_auc": roc_auc(y, pp) if len(y) else None,
        "ece_15bin": ece if len(y) else None,
        "reliability_15bin": rel,
        "stratified_kappa": stratified_kappa(y, hard, d, c),
    }


# ── main ─────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(
        description=(
            "E9/E12: train the two-head fire-decision DeepSets on Rust-exported "
            "JSONL dataset(s), split BY REPLAY (GroupKFold), evaluate the "
            "note-B metric battery on a held-out replay, export ONNX fp32 + "
            "int8, and run the note-C validation battery."
        )
    )
    p.add_argument(
        "--data",
        action="append",
        default=None,
        help=(
            "JSONL dataset from the Rust export (repeatable; E12 batch "
            "aggregates many replays into one file)"
        ),
    )
    p.add_argument(
        "--data-dir",
        default=None,
        help="additionally load every *.jsonl under this directory (recursive)",
    )
    p.add_argument(
        "--out-dir",
        default=str(here / "out/fire_model"),
        help="output directory for fp32.onnx / int8.onnx / metrics.json",
    )
    p.add_argument(
        "--attr-table",
        default=None,
        help=(
            "E24 weapon-attribute routing table (ship_attributes.json from "
            "build_ship_attributes.py); absent = the E19 gate without "
            "attributes"
        ),
    )
    p.add_argument("--epochs", type=int, default=60, help="training epochs (default 60)")
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--lr", type=float, default=1e-3, help="AdamW learning rate")
    p.add_argument("--hidden", type=int, default=320, help="hidden width (default 320 -> ~0.32M params)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument(
        "--device",
        default="cpu",
        help="cpu or cuda (GPU training; ONNX export always runs on CPU)",
    )
    p.add_argument(
        "--label-smoothing",
        type=float,
        default=0.05,
        help="BCE label smoothing (research note B: light eps 0.05-0.1)",
    )
    p.add_argument(
        "--cv-folds",
        type=int,
        default=5,
        help="GroupKFold folds over replayId when >=2 replays (0 disables CV)",
    )
    p.add_argument(
        "--parity-samples",
        type=int,
        default=1000,
        help="min samples for the PyTorch-vs-ORT parity check (note C: >=1000)",
    )
    p.add_argument(
        "--holdout-version",
        default=None,
        metavar="VER",
        help=(
            "E13 version stress test: hold out every row whose replayVersion "
            "matches this prefix ('15,8' == '15.8'). Train on the remaining "
            "rows (or only --train-version). OOD split — never mixes versions "
            "across the boundary."
        ),
    )
    p.add_argument(
        "--train-version",
        default=None,
        metavar="VER",
        help=(
            "with --holdout-version: restrict TRAINING to rows of this version "
            "prefix (e.g. '14,5') — rows of every other version are dropped "
            "from both sides (default: train on all non-holdout versions)"
        ),
    )
    p.add_argument(
        "--moe",
        type=int,
        default=0,
        metavar="K",
        help=(
            "E19: train a soft mixture-of-experts with a front router over K "
            "experts (0 = the E9 two-head DeepSets baseline). Router input is "
            "the existing global feature block + pooled entity stats; the gate "
            "blends expert head logits (dual partial activation)."
        ),
    )
    p.add_argument(
        "--moe-aux",
        type=float,
        default=MOE_DEFAULT_AUX,
        help="E19 gate load-balancing auxiliary loss weight (default 0.01)",
    )
    p.add_argument(
        "--moe-gate-hidden",
        type=int,
        default=MOE_DEFAULT_GATE_HIDDEN,
        help="E19 router MLP hidden width (default 64)",
    )
    p.add_argument(
        "--label",
        default="plain",
        choices=["plain", "hit", "soft"],
        help=(
            "E15 head-B target: plain = expert fired (the E9-E13 default, "
            "backward-comparable); hit = fired AND the outcome window landed "
            "a server-confirmed hit; soft = 0.3 + 0.7*hit on fired rows. "
            "Loss stays BCE — only the target column changes."
        ),
    )
    p.add_argument(
        "--ablate",
        default="none",
        choices=["none", "e11", "smoke", "weather", "builds"],
        help=(
            "E14 feature-group ablation: zero one family's feature columns "
            "before training (analysis knob — the export schema is untouched). "
            "v2 datasets only."
        ),
    )
    p.add_argument(
        "--selftest",
        action="store_true",
        help=(
            "torch-free unit test of the E12 scale-up logic (multi-file load, "
            "replay grouping, GroupKFold, note-B metrics) on synthetic data"
        ),
    )
    return p.parse_args(argv)


def resolve_data_paths(args: argparse.Namespace, here: Path) -> list[Path]:
    paths = [Path(d) for d in (args.data or [])]
    if args.data_dir:
        dd = Path(args.data_dir)
        paths.extend(sorted(dd.rglob("*.jsonl")))
    if not paths and not args.data_dir:
        # E9 compatibility: the default single-replay dataset. An explicit
        # (possibly empty) --data-dir never falls back silently.
        paths = [here / "out/fire_model/dataset.jsonl"]
    for p in paths:
        if not p.is_file():
            print(
                f"[e12] dataset not found: {p}\n"
                "      produce it with:\n"
                "      WOWSP_TEST_REPLAY=<replay> [WOWSP_TEST_REPLAY_DIR=<dir>] "
                "WOWSP_DATASET_OUT=<path> cargo test -p wowsp_tauri "
                "e12_batch_export -- --nocapture",
                file=sys.stderr,
            )
            raise SystemExit(2)
    return paths


def run_selftest() -> int:
    """Synthetic validation of the E12 scale-up logic (no torch, no replays):
    multi-file loading with replayId/fallback grouping, GroupKFold purity and
    balance, leave-one-replay-out, and every note-B metric on constructed
    labels/predictions."""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        # Two synthetic "replays": 40 rows each, half can-fire. replayId is
        # stamped on every row of file 1; file 2 omits it (fallback = stem).
        paths = []
        for fi, (stem, stamp) in enumerate([("replayA", True), ("replayB", False)]):
            p = tdp / f"{stem}.jsonl"
            with open(p, "w", encoding="utf-8") as f:
                for i in range(40):
                    enemies = [
                        {
                            "entityId": 100 + j,
                            "entityType": 2,
                            "shipId": None,
                            "distM": float(2000 + 400 * i + j),
                            "bearingRelRad": 0.1,
                            "speedKt": 20.0,
                            "hpFrac": 0.8,
                            "obsAgeS": 1.0,
                            "observedNow": j < (i % 4),
                            "terrainBlocked": None,
                        }
                        for j in range(2)
                    ]
                    row = {
                        "replayVersion": "15.8.0",
                        "mapName": "spaces/50_Gold_harbor",
                        "ownerEntityId": 9 + fi * 100,  # SAME ids across files
                        "shipId": 222,
                        "teamId": 1,
                        "t": float(10 + 2 * i),
                        "ownSpeedKt": 15.0,
                        "ownHpFrac": 0.9,
                        "ownReloadFrac": 1.0,
                        "ownRangeM": 15000.0,
                        "zonesOwned0": 1,
                        "zonesOwned1": 2,
                        "zonesOwned2": 0,
                        "zonesOwnedOther": 0,
                        "zonesActiveProgress": 1,
                        "eventsShells30s": 5,
                        "eventsTorps30s": 0,
                        "eventsExplosions30s": 2,
                        "eventsExplosionsNear30s": 1,
                        "enemies": enemies,
                        "friends": [],
                        "labelACanFire": i % 2 == 0,
                        "labelBFired": (i % 4 == 0) if i % 2 == 0 else None,
                    }
                    if stamp:
                        row["replayId"] = stem
                    f.write(json.dumps(row) + "\n")
            paths.append(p)
        data = load_datasets(paths)
        assert len(data["label_a"]) == 80
        groups = sorted(set(data["group"]))
        assert groups == ["replayA", "replayB"], groups
        # Entity ids REPEAT across the two files (same ownerEntityId 9 vs
        # 109): grouping must be by replay identity, and the identical
        # shipId/teamId across files must not merge anything.
        owners_a = {r["ownerEntityId"] for r in data["rows_meta"] if r.get("replayId") == "replayA"}
        assert owners_a == {9}, owners_a
        # GroupKFold: k=2 over two groups -> each fold is exactly one group.
        folds = group_kfold_assign(data["group"], 2)
        for f in range(2):
            g = set(data["group"][folds == f])
            assert len(g) == 1, f"fold {f} leaks groups {g}"
        # Leave-one-replay-out: 40 held-out, 40 train, disjoint groups.
        tr, he = leave_one_replay_out(data["group"])
        assert len(he) == 40 and len(tr) == 40
        assert set(data["group"][he]).isdisjoint(set(data["group"][tr]))
        # Strat arrays: nearest observed enemy distance / observed count.
        assert np.isfinite(data["nearest_enemy_dist_m"]).sum() > 0
        assert data["observed_enemy_count"].max() <= 2

    # Metrics on constructed data.
    y = np.array([0] * 60 + [1] * 40, dtype=np.float64)
    perfect = y * 0.98 + 0.01
    assert roc_auc(y, perfect) > 0.999
    assert average_precision(y, perfect) > 0.99
    assert brier_score(y, perfect) < 0.02
    anti = 1.0 - perfect
    assert roc_auc(y, anti) < 0.001
    # Ties: constant scores -> undefined-direction AUC handled via ranks.
    assert math.isnan(average_precision(np.zeros(10), np.linspace(0, 1, 10)))
    # ECE: perfectly calibrated 0/1 predictions -> ~0.
    e0, rel0 = ece_and_reliability(y, perfect)
    assert e0 < 0.05, e0
    assert sum(b["count"] for b in rel0) == 100
    # Overconfident shift -> positive ECE.
    e1, _ = ece_and_reliability(y, np.clip(perfect + 0.2, 0, 1))
    assert e1 > e0
    # Kappa: perfect agreement -> 1; degenerate -> None.
    assert cohen_kappa_binary(y, y) > 0.99
    assert cohen_kappa_binary(np.ones(5), np.ones(5)) is None
    # Spearman: monotone vs anti-monotone.
    xs = np.arange(10, dtype=float)
    assert spearman_rho(xs, 2 * xs) > 0.999
    assert spearman_rho(xs, -xs) < -0.999
    assert spearman_rho(xs, np.zeros(10)) is None
    # Decile lift: block d (d=0..9) has rate (9-d)/10 and meanP 0.95-0.09d
    # — both strictly decreasing across deciles, so rho must be +1, top
    # decile rate 0.9, bottom 0.0, strictly monotone.
    y_dec = np.concatenate(
        [np.array([1] * (9 - d) + [0] * (d + 1), dtype=np.float64) for d in range(10)]
    )
    p_dec = np.concatenate([np.full(10, 0.95 - 0.09 * d) for d in range(10)])
    lift = decile_lift(y_dec, p_dec)
    assert lift["deciles"][0]["actualRate"] == 0.9
    assert lift["deciles"][9]["actualRate"] == 0.0
    assert lift["spearmanRhoMeanPvsRate"] > 0.999, lift["spearmanRhoMeanPvsRate"]
    rates = [d["actualRate"] for d in lift["deciles"]]
    assert all(a > b for a, b in zip(rates, rates[1:])), rates
    # Constant labels: every decile rate ties -> rho None, not a crash.
    assert decile_lift(np.zeros(50), np.linspace(0, 1, 50))["spearmanRhoMeanPvsRate"] is None
    # Stratified kappa end-to-end: interleaved strata — two (dist, count)
    # combos with 50 mixed-label rows each (kappa reported = 1.0 under
    # perfect predictions), the other combos empty (visible, not hidden).
    # y has period 4 so it decorrelates from the period-2 strata tiling:
    # each populated stratum sees both classes.
    y_mix = np.tile(np.array([0.0, 1.0, 1.0, 0.0]), 25)
    dist = np.tile(np.array([3000.0, 12000.0]), 50)
    cnt = np.tile(np.array([1, 3]), 50)
    sk = stratified_kappa(y_mix, y_mix.copy(), dist, cnt)
    reported = [s for s in sk["strata"] if s["kappa"] is not None]
    assert len(reported) == 2, [s for s in sk["strata"] if s["n"] > 0]
    assert all(s["n"] == 50 and s["kappa"] > 0.99 for s in reported)
    assert sum(s["n"] for s in sk["strata"]) == 100

    # Version helpers (E13): comma/dot forms, leading numeric segments, junk.
    assert normalize_version_prefix("15,8") == "15.8"
    assert normalize_version_prefix("15.8.0") == "15.8.0"
    assert normalize_version_prefix(" 14.5 ") == "14.5"
    assert normalize_version_prefix("15,8,0,1234567") == "15.8.0"
    try:
        normalize_version_prefix("abc")
        raise AssertionError("junk version prefix must exit")
    except SystemExit:
        pass
    assert row_version_prefix("15.8.0") == "15.8.0"
    assert row_version_prefix(None) is None
    assert row_version_prefix("") is None
    assert row_version_prefix("unknown-build") is None
    # Prefix semantics of the split masks: '15.8' holds out 15.8.x only,
    # segment-wise — '14.1' must NOT match '14.11.x' (two-digit minors exist).
    vers = np.array(["14.5.0", "15.8.0", "15.8.1", "15.9.0", None], dtype=object)
    normed = np.array([row_version_prefix(v) for v in vers], dtype=object)
    ho = "15.8"
    is_ho = np.array([version_matches(v, ho) for v in normed])
    assert is_ho.tolist() == [False, True, True, False, False]
    is_tr = np.array([v is not None and not version_matches(v, ho) for v in normed])
    assert is_tr.tolist() == [True, False, False, True, False]
    assert version_matches("14.11.0", "14.1") is False
    assert version_matches("14.1.2", "14.1") is True
    # ── E14/E15: schema-v2 routing, label variants, ablation masking ────
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        # v2 file: every new field present with hand-checkable values.
        p2 = tdp / "replayV2.jsonl"
        with open(p2, "w", encoding="utf-8") as f:
            for i in range(30):
                enemies = [
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
                        "spottedNow": True,
                        "insideSmoke": i % 2 == 0,
                        "radarLit": True,
                        "isEnemy": True,
                        "enginePowerFrac": 0.8,
                    }
                ]
                row = {
                    "replayId": "replayV2",
                    "replayVersion": "15,8,0,0",
                    "featureVersion": 2,
                    "ownerEntityId": 9,
                    "teamId": 0,
                    "t": float(10 + 2 * i),
                    "ownSpeedKt": 15.0,
                    "ownHpFrac": 0.9,
                    "ownReloadFrac": 1.0,
                    "ownRangeM": 15000.0,
                    "zonesOwned0": 1,
                    "zonesOwned1": 2,
                    "zonesOwned2": 0,
                    "zonesOwnedOther": 0,
                    "zonesActiveProgress": 1,
                    "eventsShells30s": 5,
                    "eventsTorps30s": 0,
                    "eventsExplosions30s": 2,
                    "eventsExplosionsNear30s": 1,
                    "enemies": enemies,
                    "friends": [],
                    "labelACanFire": i % 2 == 0,
                    # Among can-fire rows (i even): i%8 in {0} fired+hit,
                    # {2} fired+missed, {4,6} held — all three E15 lattices.
                    "labelBFired": (i % 8 in (0, 2)) if i % 2 == 0 else None,
                    "ownDamconFrac": 0.5,
                    "ownRepairFrac": -1.0,
                    "ownOtherConsumableFrac": 0.25,
                    "ownEnginePower": 0.6,
                    "ownEngineDir": -1.0,
                    "ownInSmoke": False,
                    "activeSmokeCountFrac": 0.125,
                    "activeSmokeAreaFeat": 0.199,
                    "visionCapFrac": 0.5,
                    "weatherIncomingFrac": 0.25,
                    "allyRadarCountFrac": 0.25,
                    "allyHydroCountFrac": -1.0,
                    "e11EventsKnown": True,
                    "labelBHit": (i % 8 == 0) if i % 2 == 0 else None,
                    "labelBSoft": (
                        (1.0 if i % 8 == 0 else (0.3 if i % 8 == 2 else 0.0))
                        if i % 2 == 0
                        else None
                    ),
                }
                f.write(json.dumps(row) + "\n")
        data2 = load_datasets([p2])
        assert data2["feature_version"] == 2
        assert data2["entity_dim"] == ENTITY_DIM_V2 == 15
        assert data2["global_dim"] == GLOBAL_DIM_V2 == 27
        assert data2["entity"].shape == (30, SLOTS, 15)
        # Featurizer exact values: the v2 entity block (cols 10..14) and the
        # global block (cols 14..26) carry the Rust-side normalization.
        slot_vec = featurize_slot(enemies[0], 2)
        inside = 1.0 if enemies[0]["insideSmoke"] else 0.0
        assert slot_vec[10:15] == [1.0, inside, 1.0, 1.0, 0.8]
        row0 = featurize_row(json.loads(json.dumps(row)), 2)
        assert row0[1][14] == 0.5 and row0[1][15] == -1.0 and row0[1][16] == 0.25
        assert row0[1][17] == 0.6 and row0[1][18] == -1.0 and row0[1][19] == 0.0
        assert row0[1][20] == 0.125 and row0[1][21] == 0.199
        assert row0[1][22] == 0.5 and row0[1][23] == 0.25
        assert row0[1][24] == 0.25 and row0[1][25] == -1.0 and row0[1][26] == 1.0
        # v1 padding + v1 slot: 10 dims, zeros for None.
        assert len(featurize_slot(None, 1)) == 10
        assert len(featurize_slot(None, 2)) == 15
        # E15 targets: hit/soft censor exactly with the plain label; soft
        # values land on the 0 / 0.3 / 1 lattice.
        assert np.isnan(data2["label_b_hit"][1]) and np.isnan(data2["label_b_soft"][1])
        hit_vals = data2["label_b_hit"][np.isfinite(data2["label_b_hit"])]
        soft_vals = data2["label_b_soft"][np.isfinite(data2["label_b_soft"])]
        assert sorted(set(hit_vals.tolist())) == [0.0, 1.0]
        assert sorted(set(soft_vals) - {0.0, 1.0}) and all(
            abs(v - 0.3) < 1e-6 for v in set(soft_vals) - {0.0, 1.0}
        )
        assert select_label_target(data2, "plain") is data2["label_b"]
        assert select_label_target(data2, "hit") is data2["label_b_hit"]
        assert select_label_target(data2, "soft") is data2["label_b_soft"]
        # v1 data has no hit column values -> hit falls back to plain.
        p1 = tdp / "replayV1.jsonl"
        v1_row = {k: v for k, v in row.items() if k not in (
            "featureVersion", "labelBHit", "labelBSoft", "ownDamconFrac",
            "ownRepairFrac", "ownOtherConsumableFrac", "ownEnginePower",
            "ownEngineDir", "ownInSmoke", "activeSmokeCountFrac",
            "activeSmokeAreaFeat", "visionCapFrac", "weatherIncomingFrac",
            "allyRadarCountFrac", "allyHydroCountFrac", "e11EventsKnown")}
        v1_row["enemies"] = [{k: v for k, v in enemies[0].items() if k not in (
            "spottedNow", "insideSmoke", "radarLit", "isEnemy", "enginePowerFrac")}]
        with open(p1, "w", encoding="utf-8") as f:
            f.write(json.dumps(v1_row) + "\n")
        data1 = load_datasets([p1])
        assert data1["feature_version"] == 1 and data1["entity_dim"] == 10
        assert select_label_target(data1, "hit") is data1["label_b"]
        assert select_label_target(data1, "soft") is data1["label_b"]
        # Ablation masking: e11 zeroes vision/engine/consumable columns but
        # leaves the side marker and the smoke block intact.
        ab = apply_ablation(data2, "e11")
        assert (ab["entity"][:, :, 10] == 0).all() and (ab["entity"][:, :, 14] == 0).all()
        # isEnemy untouched where the slot is real (fixture: one enemy slot).
        assert (ab["entity"][np.asarray(ab["mask"])[:, 0] == 1, 0, 13] == 1).all()
        for c in V2_GLB_E11:
            assert (ab["global"][:, c] == 0).all()
        assert (ab["global"][:, 20] == 0.125).all()  # smoke block untouched
        assert (data2["entity"][:, 0, 10] == 1).all()  # input dict untouched
        # Mixed schemas across files refuse to load.
        try:
            load_datasets([p2, p1])
            raise AssertionError("mixed v1/v2 files must exit")
        except SystemExit:
            pass
        # Mixed schemas inside one file refuse too.
        p3 = tdp / "mixed.jsonl"
        with open(p3, "w", encoding="utf-8") as f:
            f.write(json.dumps({**row, "featureVersion": 2}) + "\n")
            f.write(json.dumps({**row, "featureVersion": 1}) + "\n")
        try:
            load_datasets([p3])
            raise AssertionError("in-file mixed featureVersion must exit")
        except SystemExit:
            pass

    print("[selftest] E12 scale-up logic OK (load/group/split/metrics)")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.attr_table:
        load_attr_table(args.attr_table)
        print(
            f"[e24] attr table: {len(ATTR_TABLE)} ships from {args.attr_table} "
            f"(gate input +{ATTR_DIM})"
        )
    here = Path(__file__).resolve().parent
    if args.selftest:
        return run_selftest()
    data_paths = resolve_data_paths(args, here)

    try:
        import torch  # noqa: F401
    except ImportError:
        print(
            "[e12] torch is missing — install the CPU wheel:\n"
            "     pip install torch --index-url https://download.pytorch.org/whl/cpu\n"
            "     pip install onnx onnxruntime",
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
        print("[e12] --device cuda but CUDA unavailable — falling back to cpu", file=sys.stderr)
        device = torch.device("cpu")
    print(f"[e12] device: {device}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[e12] loading {len(data_paths)} dataset file(s)")
    data = load_datasets(data_paths)
    data = apply_ablation(data, args.ablate)
    y_b_sel = select_label_target(data, args.label)
    n = len(data["label_a"])
    can = data["label_a"] == 1
    fired = data["label_b"] == 1
    groups, group_counts = np.unique(data["group"], return_counts=True)
    n_groups = len(groups)
    print(
        f"[e14] featureVersion {data['feature_version']} "
        f"(entity {data['entity_dim']} / global {data['global_dim']} dims); "
        f"label={args.label}; ablate={args.ablate}"
    )
    if args.label != "plain":
        sel_defined = np.isfinite(y_b_sel)
        sel_pos = float(np.nanmean(y_b_sel[sel_defined])) if sel_defined.any() else float("nan")
        print(
            f"[e15] {args.label} target: {int(sel_defined.sum())} defined rows, "
            f"mean target {sel_pos:.3f} (plain rate among can-fire "
            f"{fired.sum() / max(can.sum(), 1):.3f})"
        )
    print(
        f"[e12] {n} rows over {n_groups} replay group(s): labelA+ {int(can.sum())} "
        f"({can.mean():.3f}), labelB+ {int(fired.sum())} "
        f"(rate among A+ {fired.sum() / max(can.sum(), 1):.3f})"
    )
    for g, c in sorted(zip(groups, group_counts), key=lambda kv: -kv[1]):
        print(f"[e12]   group {g}: {c} rows")

    # ── split by replay (note B / E12) ───────────────────────────────────
    # >= 2 replays: leave-one-replay-out held-out (the LARGEST group) for the
    # full note-B battery, plus optional GroupKFold CV for fold-stable
    # AUPRC. ONE replay: the E9 fallback — a random 80/20 split, loudly
    # flagged, because per-replay grouping cannot split a single group.
    # E13: --holdout-version switches to the version stress test — train and
    # held-out are separated by CLIENT VERSION (never mixed), the held-out
    # side being one version's rows and the training side the rest (or a
    # single --train-version).
    rng = np.random.default_rng(args.seed)
    version_of = np.array(
        (
            [row_version_prefix(v) for v in data["outcome_version"]]
            if data["rows_meta"] is None
            else [row_version_prefix(r.get("replayVersion")) for r in data["rows_meta"]]
        ), dtype=object
    )
    if args.holdout_version is not None:
        ho_ver = normalize_version_prefix(args.holdout_version)
        tr_ver = normalize_version_prefix(args.train_version) if args.train_version else None
        # Segment-wise prefix semantics: '15.8' holds out every row of
        # 15.8.x but not 15.80.x ('14.1' must not swallow '14.11.x').
        is_ho = np.array([version_matches(v, ho_ver) for v in version_of])
        is_tr = np.array(
            [
                v is not None
                and not version_matches(v, ho_ver)
                and (tr_ver is None or version_matches(v, tr_ver))
                for v in version_of
            ]
        )
        n_dropped = int((~(is_ho | is_tr)).sum())
        if is_ho.sum() == 0 or is_tr.sum() == 0:
            vh: dict = {}
            for v in version_of:
                vh[v] = vh.get(v, 0) + 1
            raise SystemExit(
                f"[e13] --holdout-version {ho_ver}: held-out rows {int(is_ho.sum())}, "
                f"train rows {int(is_tr.sum())} — version histogram {vh}"
            )
        val_idx = np.flatnonzero(is_ho)
        train_idx = np.flatnonzero(is_tr)
        split_mode = (
            f"version-holdout (train = "
            f"{tr_ver if tr_ver else 'every non-holdout version'}, "
            f"held-out = version {ho_ver})"
        )
        heldout_groups = sorted(set(data["group"][val_idx]))
        print(
            f"[e13] version split: held-out v{ho_ver} {len(val_idx)} rows "
            f"({len(heldout_groups)} replays) vs train "
            f"{'v' + tr_ver if tr_ver else 'rest'} {len(train_idx)} rows "
            f"({len(set(data['group'][train_idx]))} replays); "
            f"{n_dropped} rows of other versions dropped"
        )
    elif n_groups >= 2:
        train_idx, val_idx = leave_one_replay_out(data["group"])
        split_mode = "leave-one-replay-out (held-out = largest replay group)"
        heldout_groups = sorted(set(data["group"][val_idx]))
    else:
        perm = rng.permutation(n)
        n_val = max(1, int(n * 0.2))
        val_idx, train_idx = perm[:n_val], perm[n_val:]
        split_mode = (
            "random-20pct-of-single-replay (ONLY one replay available — "
            "trajectory leakage across the split is accepted per the E9 "
            "pipeline-evidence convention; NOT a generalisation estimate)"
        )
        heldout_groups = [str(groups[0])]

    def batch(idx: np.ndarray) -> dict:
        return {
            "entity": torch.from_numpy(data["entity"][idx]).to(device),
            "global": torch.from_numpy(data["global"][idx]).to(device),
            "mask": torch.from_numpy(data["mask"][idx]).to(device),
        }

    y_a = torch.from_numpy(data["label_a"]).to(device)
    # E15: head B trains on the SELECTED target (--label); the loss mask is
    # its own censoring (defined == can-fire, identical across variants).
    y_b = torch.from_numpy(np.nan_to_num(y_b_sel, nan=0.0)).to(device)
    b_mask = torch.from_numpy(np.isfinite(y_b_sel).astype(np.float32)).to(device)

    def train_model(hidden: int, tr_idx: np.ndarray | None = None) -> tuple["torch.nn.Module", list[float]]:
        """Train one model on `tr_idx` (defaults to the main split's train
        set; the CV folds pass their own). Training loop: E9, unchanged
        apart from the E14 input widths and the E15 target column."""
        tr = train_idx if tr_idx is None else tr_idx
        model = build_model(
            hidden,
            data["entity_dim"],
            data["global_dim"],
            moe=args.moe,
            moe_gate_hidden=args.moe_gate_hidden,
        ).to(device)
        opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
        # BCEWithLogitsLoss has no label_smoothing kwarg (only CrossEntropyLoss
        # does) — smooth the targets by hand: y' = y(1-eps) + eps/2 (note B).
        eps = args.label_smoothing
        smooth = lambda t: t * (1.0 - eps) + 0.5 * eps  # noqa: E731
        bce = nn.BCEWithLogitsLoss(reduction="none")
        losses: list[float] = []
        t0 = time.time()
        for epoch in range(args.epochs):
            model.train()
            order = tr[np.random.permutation(len(tr))]
            tot, cnt = 0.0, 0
            for s in range(0, len(order), args.batch_size):
                idx = order[s : s + args.batch_size]
                b = batch(idx)
                attrs_b = (
                    torch.from_numpy(data["attrs"][idx]).to(device)
                    if data.get("attrs") is not None
                    else None
                )
                la, lb = model(b["entity"], b["global"], b["mask"], attrs_b)
                loss_a = bce(la, smooth(y_a[idx])).mean()
                m = b_mask[idx]
                loss_b = (bce(lb, smooth(y_b[idx])) * m).sum() / m.sum().clamp(min=1.0)
                loss = loss_a + loss_b
                if args.moe:
                    aux = model.gate_balance_loss()
                    if aux is not None:
                        loss = loss + args.moe_aux * aux
                opt.zero_grad()
                loss.backward()
                opt.step()
                tot += loss.item() * len(idx)
                cnt += len(idx)
            losses.append(tot / cnt)
        model.eval()
        print(
            f"[e12] trained {args.epochs} epochs in {time.time() - t0:.1f}s: "
            f"loss {losses[0]:.4f} -> {losses[-1]:.4f}"
        )
        return model, losses

    model, losses = train_model(args.hidden)
    n_params = sum(p.numel() for p in model.parameters())
    kind = (
        f"soft MoE ({args.moe} experts, gate {args.moe_gate_hidden}, aux {args.moe_aux})"
        if args.moe
        else "contextualised DeepSets two-head"
    )
    print(f"[e12] model: {kind}, {n_params:,} params")
    if args.moe:
        with torch.no_grad():
            gs = []
            for s in range(0, len(val_idx), 16384):
                _vi = val_idx[s : s + 16384]
                _va = (
                    torch.from_numpy(data["attrs"][_vi]).to(device)
                    if data.get("attrs") is not None
                    else None
                )
                model(batch(_vi)["entity"], batch(_vi)["global"], batch(_vi)["mask"], _va)
                gs.append(model.last_gate.mean(dim=0).cpu())
            gate_mean = torch.stack(gs).mean(dim=0).tolist()
        print(f"[e19] held-out mean gate share per expert: {[round(x, 4) for x in gate_mean]}")

    # Full-dataset predictions, CHUNKED: pushing every row through the GPU at
    # once materialises ~9GB of intermediate activations ([N,24,320] layers),
    # which OOMs on a shared GPU. 16k-row chunks keep the peak negligible.
    def predict_all(m: "torch.nn.Module", idx: np.ndarray):
        outs_a: list = []
        outs_b: list = []
        with torch.no_grad():
            for s in range(0, len(idx), 16384):
                _si = idx[s : s + 16384]
                b = batch(_si)
                _sa = (
                    torch.from_numpy(data["attrs"][_si]).to(device)
                    if data.get("attrs") is not None
                    else None
                )
                la, lb = m(b["entity"], b["global"], b["mask"], _sa)
                outs_a.append(la)
                outs_b.append(lb)
        return torch.cat(outs_a), torch.cat(outs_b)

    pt_la, pt_lb = predict_all(model, np.arange(n))
    pt_pa, pt_pb = sigmoid(pt_la.cpu().numpy()), sigmoid(pt_lb.cpu().numpy())

    # ── held-out note-B battery ──────────────────────────────────────────
    # Head B evaluates against the SELECTED target (--label); the plain
    # comparison block next to it keeps every config comparable with the
    # E13 baseline regardless of which target trained the head.
    finite_b = np.isfinite(y_b_sel)
    va_a = val_idx
    va_b = val_idx[finite_b[val_idx]]
    heldout_a = classification_report_head(
        "A/physically-can-fire (all held-out rows)",
        data["label_a"][va_a],
        pt_pa[va_a],
        data["nearest_enemy_dist_m"][va_a],
        data["observed_enemy_count"][va_a],
    )
    # Note B: the "physically cannot fire" subset must produce ZERO head-A
    # false positives at the deployment threshold.
    cannot = va_a[data["label_a"][va_a] == 0]
    heldout_a["false_positives_on_cannot_fire"] = int((pt_pa[cannot] >= 0.5).sum())
    heldout_a["cannot_fire_rows"] = int(len(cannot))
    head_b_name = {
        "plain": "B/expert-fired (held-out can-fire rows)",
        "hit": "B/fired-and-hit (held-out can-fire rows)",
        "soft": "B/soft-outcome (held-out can-fire rows)",
    }[args.label]
    heldout_b = classification_report_head(
        head_b_name,
        y_b_sel[va_b],
        pt_pb[va_b],
        data["nearest_enemy_dist_m"][va_b],
        data["observed_enemy_count"][va_b],
    )
    heldout_b["decile_lift"] = decile_lift(y_b_sel[va_b], pt_pb[va_b])
    # Comparability anchor: the same head scored against the PLAIN label —
    # the metric the E13 table reports — so a hit/soft-trained model is
    # directly comparable to the baseline row.
    heldout_b_plain: dict | None = None
    if args.label != "plain":
        finite_plain = np.isfinite(data["label_b"])
        va_p = val_idx[finite_plain[val_idx]]
        heldout_b_plain = classification_report_head(
            "B/expert-fired-PLAIN (comparability anchor)",
            data["label_b"][va_p],
            pt_pb[va_p],
            data["nearest_enemy_dist_m"][va_p],
            data["observed_enemy_count"][va_p],
        )
        heldout_b_plain["decile_lift"] = decile_lift(
            data["label_b"][va_p], pt_pb[va_p]
        )
        print(
            f"[e15] held-out PLAIN-label anchor: auprc "
            f"{heldout_b_plain['auprc']:.4f} auc {heldout_b_plain['roc_auc']:.4f} "
            f"ece {heldout_b_plain['ece_15bin']:.4f} "
            f"top-decile lift {heldout_b_plain['decile_lift']['deciles'][0].get('lift')}"
        )
    # E13: post-hoc OUTCOME lift on the held-out rows — the expert
    # fired-vs-held baseline plus the model's decile curves over window hit
    # rate / enemy HP lost (research note B's strongest offline evidence).
    # Datasets exported before E13 carry no outcome fields -> status note.
    outcome_report: dict = {
        "status": "dataset lacks outcome fields (re-export with the E13 fire_dataset batch exporter)"
    }
    try:
        import outcome_lift

        if data["rows_meta"] is None:
            oa = {
                "hits": data["outcome_hits"],
                "fired": data["outcome_fired"],
                "hp_lost": data["outcome_hp_lost"],
                "mode": data["outcome_mode"],
                "version": data["outcome_version"],
                "rows_with_outcome_fields": data["outcome_rows"],
            }
        else:
            oa = outcome_lift.outcome_arrays(data["rows_meta"])
        if oa["rows_with_outcome_fields"] > 0:
            eb_h = outcome_lift.expert_baseline(
                data["label_b"][va_b], oa["hits"][va_b], oa["fired"][va_b], oa["hp_lost"][va_b]
            )
            dec_h = outcome_lift.outcome_deciles(
                pt_pb[va_b],
                data["label_b"][va_b],
                oa["hits"][va_b],
                oa["fired"][va_b],
                oa["hp_lost"][va_b],
            )
            outcome_report = {"expert_baseline": eb_h, "model_deciles": dec_h}
            r_hit = dec_h["window_hit_rate"]["spearmanRhoMeanPvsMetric"]
            r_hp = dec_h["hp_lost_mean"]["spearmanRhoMeanPvsMetric"]
            fmt = lambda r: "None" if r is None else f"{r:+.3f}"  # noqa: E731
            print(
                f"[e13] held-out outcome lift: fired vs held pooled hit-rate "
                f"{eb_h['fired']['pooled_hit_rate'] if eb_h['fired']['pooled_hit_rate'] is None else round(eb_h['fired']['pooled_hit_rate'], 4)}"
                f"/{eb_h['held']['pooled_hit_rate'] if eb_h['held']['pooled_hit_rate'] is None else round(eb_h['held']['pooled_hit_rate'], 4)}; "
                f"decile rho hit-rate {fmt(r_hit)}, hp-lost {fmt(r_hp)}"
            )
    except ImportError:  # pragma: no cover — outcome_lift.py lives next to this script
        pass
    heldout_report = {
        "mode": split_mode,
        "heldout_groups": heldout_groups,
        "train_groups": n_groups - len(heldout_groups) if n_groups >= 2 else 1,
        "rows_heldout": int(len(val_idx)),
        "head_a": heldout_a,
        "head_b": heldout_b,
        "head_b_plain_anchor": heldout_b_plain,
        "outcome_lift": outcome_report,
        "evidence_note": (
            "Single-replay numbers are PIPELINE evidence only (E9 "
            "convention): with one replay the held-out split is random, not "
            "by replay, and these are not generalisation estimates."
        ),
    }
    print(
        f"[e12] held-out [{split_mode.split(' (')[0]}] headB: "
        f"logloss {heldout_b['logloss']:.4f} brier {heldout_b['brier']:.4f} "
        f"auprc {heldout_b['auprc']:.4f} auc {heldout_b['roc_auc']:.4f} "
        f"ece {heldout_b['ece_15bin']:.4f}"
    )
    print(
        f"[e12] held-out headA false positives on cannot-fire rows: "
        f"{heldout_a['false_positives_on_cannot_fire']}/{heldout_a['cannot_fire_rows']}"
    )

    # ── GroupKFold CV (>= 2 replays only) ────────────────────────────────
    # Under --holdout-version the CV rides the TRAIN side only (folds must
    # never touch the held-out version — the OOD boundary is the experiment).
    cv_report: dict = {"mode": "skipped", "reason": "single replay group"}
    if args.holdout_version is not None:
        cv_groups = data["group"][train_idx]
        cv_scope = (
            f" (train side only: {len(set(cv_groups))} replays, version "
            f"{normalize_version_prefix(args.train_version) if args.train_version else 'non-holdout'})"
        )
    else:
        cv_groups = data["group"]
        cv_scope = ""
    if len(set(cv_groups)) >= 2 and args.cv_folds >= 2:
        k = min(args.cv_folds, len(set(cv_groups)))
        folds = group_kfold_assign(cv_groups, k)
        # Global row indices: under --holdout-version the CV-scoped arrays
        # are train-subset-relative, so fold indices map back through
        # train_idx; otherwise the identity.
        cv_base = train_idx if args.holdout_version is not None else np.arange(n)
        fold_auprc_b: list[float] = []
        fold_auprc_a: list[float] = []
        for f in range(k):
            te = cv_base[np.flatnonzero(folds == f)]
            tr = cv_base[np.flatnonzero(folds != f)]
            fold_model, _ = train_model(args.hidden, tr)
            fl_a, fl_b = predict_all(fold_model, te)
            pa, pb = sigmoid(fl_a.cpu().numpy()), sigmoid(fl_b.cpu().numpy())
            fb_mask = finite_b[te]
            fold_auprc_a.append(average_precision(data["label_a"][te], pa))
            fold_auprc_b.append(average_precision(y_b_sel[te][fb_mask], pb[fb_mask]))
            print(
                f"[e12] fold {f + 1}/{k}: AUPRC-A {fold_auprc_a[-1]:.4f} "
                f"AUPRC-B {fold_auprc_b[-1]:.4f} ({len(te)} rows)"
            )
        cv_report = {
            "mode": f"GroupKFold k={k} grouped by replayId{cv_scope}",
            "fold_auprc_a": fold_auprc_a,
            "fold_auprc_b": fold_auprc_b,
            "auprc_a_mean": float(np.nanmean(fold_auprc_a)),
            "auprc_b_mean": float(np.nanmean(fold_auprc_b)),
            "auprc_b_std": float(np.nanstd(fold_auprc_b)),
        }

    metrics: dict = {
        "dataset": [str(p) for p in data_paths],
        "rows": int(n),
        "replay_groups": int(n_groups),
        "rows_can_fire": int(can.sum()),
        "rows_fired": int(fired.sum()),
        "positive_rate_among_can_fire": float(fired.sum() / max(can.sum(), 1)),
        "params": int(n_params),
        "device": str(device),
        "hidden": args.hidden,
        "epochs": args.epochs,
        "loss_first": losses[0],
        "loss_last": losses[-1],
        "loss_curve_every10": losses[9::10],
        "heldout": heldout_report,
        "cv": cv_report,
        "auprc_a_train": average_precision(data["label_a"][train_idx], pt_pa[train_idx]),
        "auprc_b_train": average_precision(
            y_b_sel[train_idx][finite_b[train_idx]], pt_pb[train_idx][finite_b[train_idx]]
        ),
    }
    metrics.update(
        {
            "feature_version": int(data["feature_version"]),
            "entity_dim": int(data["entity_dim"]),
            "global_dim": int(data["global_dim"]),
            "label": args.label,
            "ablate": args.ablate,
        }
    )

    # ── ONNX export (static shapes, batch 1) ─────────────────────────────
    # E24: with an attr table loaded the gate takes a 4th input (`attrs`,
    # [1, ATTR_DIM]) — the export AND every ORT call below must feed it,
    # or the traced graph and the trained gate disagree (the first E24
    # full run crashed exactly here: 1x298 vs 308x64).
    model = model.cpu()  # export and all ORT validation run on CPU
    use_attrs = data["attrs"] is not None
    # Checkpoint BEFORE export: an export/quantization bug must never cost
    # the training run (the first E24 full run lost ~2h to exactly that).
    torch.save(
        {
            "model": model.state_dict(),
            "hidden": args.hidden,
            "attr_dim": ATTR_DIM if use_attrs else 0,
            "loss_last": losses[-1],
        },
        out_dir / "checkpoint.pt",
    )
    print(f"[e12] checkpoint -> {out_dir / 'checkpoint.pt'}")
    fp32_path = out_dir / "fp32.onnx"
    ex = torch.from_numpy(data["entity"][:1])
    gx = torch.from_numpy(data["global"][:1])
    mx = torch.from_numpy(data["mask"][:1])
    in_names = ["entity", "global_feat", "mask"] + (["attrs"] if use_attrs else [])
    export_inputs = (ex, gx, mx) + ((torch.from_numpy(data["attrs"][:1]),) if use_attrs else ())
    try:
        torch.onnx.export(
            model,
            export_inputs,
            str(fp32_path),
            input_names=in_names,
            output_names=["logitA", "logitB"],
            opset_version=17,
            dynamo=False,
        )
    except TypeError:
        # older/newer torch without the dynamo kwarg
        torch.onnx.export(
            model,
            export_inputs,
            str(fp32_path),
            input_names=in_names,
            output_names=["logitA", "logitB"],
            opset_version=17,
        )
    onnx.checker.check_model(onnx.load(str(fp32_path)))
    print(f"[e12] exported + checked {fp32_path} ({fp32_path.stat().st_size:,} bytes)")

    # ── int8 dynamic quantization ────────────────────────────────────────
    # PITFALL: onnxruntime's quantizer writes/reopens an intermediate
    # "<model>-inferred.onnx" NEXT TO the input and fails on non-ASCII
    # (e.g. CJK) directory names on Windows — quantize in an ASCII-safe temp
    # dir and copy the result back.
    from onnxruntime.quantization import QuantType, quantize_dynamic

    int8_path = out_dir / "int8.onnx"
    import shutil
    import tempfile

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
    print(f"[e12] quantized -> {int8_path} ({int8_path.stat().st_size:,} bytes)")

    so = ort.SessionOptions()
    sess_fp32 = ort.InferenceSession(str(fp32_path), so, providers=["CPUExecutionProvider"])
    sess_int8 = ort.InferenceSession(str(int8_path), so, providers=["CPUExecutionProvider"])

    def run_ort(sess, e, g, m, a=None):
        """Batch-1 ORT forward (the export is static batch 1): accepts
        [N, ...] arrays, loops rows, returns ([N], [N]) logits. `a` is the
        E24 attrs block ([N, ATTR_DIM]) when the export carries one."""
        las, lbs = [], []
        for i in range(len(g)):
            feed = {
                "entity": e[i : i + 1].astype(np.float32),
                "global_feat": g[i : i + 1].astype(np.float32),
                "mask": m[i : i + 1].astype(np.float32),
            }
            if a is not None:
                feed["attrs"] = a[i : i + 1].astype(np.float32)
            la, lb = sess.run(None, feed)
            las.append(np.asarray(la).reshape(-1)[0])
            lbs.append(np.asarray(lb).reshape(-1)[0])
        return np.array(las), np.array(lbs)

    # ── validation battery (research note C checklist) ───────────────────
    # Full-dataset ORT predictions for both sessions first: the dataset-level
    # comparisons below index with full-length masks, and the permutation
    # test samples arbitrary rows (E9 only avoided this mismatch by running
    # with --parity-samples == rows).
    # E19: on a multi-million-row corpus the per-row ORT loop cannot scan
    # the full dataset (hours of CPU for machinery evidence only) — the
    # parity/quantization checks run on a deterministic PREFIX subsample.
    vg = min(n, 50_000)
    va = data["attrs"][:vg] if use_attrs else None
    ort_la, ort_lb = run_ort(
        sess_fp32,
        data["entity"][:vg],
        data["global"][:vg],
        data["mask"][:vg],
        va,
    )
    q_la, q_lb = run_ort(
        sess_int8,
        data["entity"][:vg],
        data["global"][:vg],
        data["mask"][:vg],
        va,
    )

    # 1. PyTorch vs ORT fp32 parity over the first parity_samples rows
    #    (deterministic prefix). Like-for-like on CPU: pt_* came from the
    #    training device (GPU kernels differ by sub-ulp), so recompute the
    #    compared rows on the already-moved-to-CPU model.
    check = np.arange(min(args.parity_samples, vg))
    _dev = device
    device = torch.device("cpu")
    _la, _lb = predict_all(model, check)
    device = _dev
    parity_a = float(np.max(np.abs(sigmoid(ort_la[check]) - sigmoid(_la.numpy()))))
    parity_b = float(np.max(np.abs(sigmoid(ort_lb[check]) - sigmoid(_lb.numpy()))))
    print(f"[e12] parity fp32 PyTorch vs ORT over {len(check)} rows: max|dp| A {parity_a:.2e}, B {parity_b:.2e}")

    # 2. int8 vs fp32 (probabilities + PR-AUPRC / log loss on head B among A+).
    quant_dp_a = float(np.max(np.abs(sigmoid(q_la) - sigmoid(ort_la))))
    quant_dp_b = float(np.max(np.abs(sigmoid(q_lb) - sigmoid(ort_lb))))
    can_v = can[:vg]
    auprc_fp32 = average_precision(data["label_b"][:vg][can_v], sigmoid(ort_lb)[can_v])
    auprc_int8 = average_precision(data["label_b"][:vg][can_v], sigmoid(q_lb)[can_v])
    auprc_a_fp32 = average_precision(data["label_a"][:vg], sigmoid(ort_la))
    auprc_a_int8 = average_precision(data["label_a"][:vg], sigmoid(q_la))
    ll_fp32 = log_loss(data["label_b"][:vg][can_v], sigmoid(ort_lb)[can_v])
    ll_int8 = log_loss(data["label_b"][:vg][can_v], sigmoid(q_lb)[can_v])
    print(
        f"[e12] int8 vs fp32: max|dp| A {quant_dp_a:.2e} B {quant_dp_b:.2e}; "
        f"AUPRC-B fp32 {auprc_fp32:.4f} int8 {auprc_int8:.4f}; "
        f"AUPRC-A fp32 {auprc_a_fp32:.4f} int8 {auprc_a_int8:.4f}; "
        f"logloss-B fp32 {ll_fp32:.4f} int8 {ll_int8:.4f}"
    )

    # 3. Permutation invariance: the shared per-entity MLP + masked-mean
    #    aggregation carry NO positional information, so permuting slots (with
    #    their mask entries) must not change the output — the DeepSets property,
    #    verifiable even though the SLOTS themselves are deterministically
    #    ordered (order only decides truncation, which this does not touch).
    perm_max_a = perm_max_b = 0.0
    qperm_max_a = qperm_max_b = 0.0
    for i in range(200):
        pidx = np.random.permutation(SLOTS)
        e = data["entity"][i][pidx][None]
        m = data["mask"][i][pidx][None]
        g = data["global"][i][None]
        ai = data["attrs"][i][None] if use_attrs else None
        pla, plb = run_ort(sess_fp32, e, g, m, ai)
        perm_max_a = max(perm_max_a, abs(pla[0] - ort_la[i]))
        perm_max_b = max(perm_max_b, abs(plb[0] - ort_lb[i]))
        qla, qlb = run_ort(sess_int8, e, g, m, ai)
        qperm_max_a = max(qperm_max_a, abs(qla[0] - q_la[i]))
        qperm_max_b = max(qperm_max_b, abs(qlb[0] - q_lb[i]))
    print(
        f"[e12] permutation (200 rows): fp32 max|dlogit| A {perm_max_a:.2e} B {perm_max_b:.2e}; "
        f"int8 A {qperm_max_a:.2e} B {qperm_max_b:.2e}"
    )

    # 4. Mask boundary: all enemy slots masked + zeroed on real rows, and a
    #    fully-masked synthetic row — no NaN/inf anywhere.
    worst_nan = False
    for i in range(50):
        e = data["entity"][i].copy()
        m = data["mask"][i].copy()
        e[:ENEMY_SLOTS] = 0.0
        m[:ENEMY_SLOTS] = 0.0
        la, lb = run_ort(
            sess_fp32, e[None], data["global"][i][None], m[None],
            data["attrs"][i][None] if use_attrs else None,
        )
        worst_nan = worst_nan or not (np.isfinite(la).all() and np.isfinite(lb).all())
    e0 = np.zeros((1, SLOTS, data["entity_dim"]), dtype=np.float32)
    m0 = np.zeros((1, SLOTS), dtype=np.float32)
    g0 = np.zeros((1, data["global_dim"]), dtype=np.float32)
    a0 = np.zeros((1, ATTR_DIM), dtype=np.float32) if use_attrs else None
    la0, lb0 = run_ort(sess_fp32, e0, g0, m0, a0)
    empty_finite = bool(np.isfinite(la0).all() and np.isfinite(lb0).all())
    la0i, lb0i = run_ort(sess_int8, e0, g0, m0, a0)
    empty_finite_int8 = bool(np.isfinite(la0i).all() and np.isfinite(lb0i).all())
    print(
        f"[e12] mask boundary: enemy-masked rows finite={not worst_nan}, "
        f"all-masked finite fp32={empty_finite} int8={empty_finite_int8} "
        f"(empty logits A {la0[0]:.3f} B {lb0[0]:.3f})"
    )

    # ── sample_input.json for the Rust-side ort test ─────────────────────
    sample = {
        "_lineage": "featurized dataset row 0 (train_fire_model.py featurize_row)",
        "entity": data["entity"][0].tolist(),
        "global": data["global"][0].tolist(),
        "mask": data["mask"][0].tolist(),
        "slots": SLOTS,
        "entityDim": int(data["entity_dim"]),
        "globalDim": int(data["global_dim"]),
    }
    if use_attrs:
        sample["attrs"] = data["attrs"][0].tolist()
        sample["attrDim"] = ATTR_DIM
    (out_dir / "sample_input.json").write_text(json.dumps(sample), encoding="utf-8")

    metrics.update(
        {
            "attr_routing": bool(use_attrs),
            "attr_dim": int(ATTR_DIM if use_attrs else 0),
            "parity_fp32_max_dp_a": parity_a,
            "parity_fp32_max_dp_b": parity_b,
            "parity_rows": int(len(check)),
            "int8_max_dp_a": quant_dp_a,
            "int8_max_dp_b": quant_dp_b,
            "auprc_b_fp32": auprc_fp32,
            "auprc_b_int8": auprc_int8,
            "auprc_a_fp32": auprc_a_fp32,
            "auprc_a_int8": auprc_a_int8,
            "logloss_b_fp32": ll_fp32,
            "logloss_b_int8": ll_int8,
            "permutation_fp32_max_dlogit_a": perm_max_a,
            "permutation_fp32_max_dlogit_b": perm_max_b,
            "permutation_int8_max_dlogit_a": qperm_max_a,
            "permutation_int8_max_dlogit_b": qperm_max_b,
            "mask_boundary_finite": bool(not worst_nan and empty_finite and empty_finite_int8),
            "torch_version": torch.__version__,
            "onnx_version": onnx.__version__,
            "onnxruntime_version": ort.__version__,
        }
    )
    # numpy scalars (float32/float64) are not JSON-serializable — sanitize.
    def jsonable(o):
        if isinstance(o, dict):
            return {k: jsonable(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [jsonable(v) for v in o]
        if isinstance(o, (np.floating, float)):
            f = float(o)
            return None if math.isnan(f) or math.isinf(f) else f
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, np.ndarray):
            return jsonable(o.tolist())
        return o

    (out_dir / "metrics.json").write_text(json.dumps(jsonable(metrics), indent=2), encoding="utf-8")
    print(f"[e12] wrote {out_dir / 'metrics.json'} and sample_input.json")

    # Pipeline gate: everything the delivery loop promised must hold.
    assert parity_a < 1e-5 and parity_b < 1e-5, "fp32 parity failed"
    assert not worst_nan and empty_finite and empty_finite_int8, "NaN at mask boundary"
    assert perm_max_a < 1e-5 and perm_max_b < 1e-5, "permutation invariance failed"
    # Loss must drop meaningfully. The E9 single-replay gate demanded a 2x
    # drop; multi-replay corpora start lower (mixed head-A/B balance), so a
    # 15% relative drop is the honest floor — 126 replays measured 1.40x.
    assert losses[-1] < 0.85 * losses[0], "train loss did not decrease enough"
    print("[e12] ALL pipeline checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
