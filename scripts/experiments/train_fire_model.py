#!/usr/bin/env python3
"""Train the two-head fire-decision DeepSets model (feasibility experiment E9).

Closes the model-delivery loop that E9 prototypes end to end:

    Rust sample export (fire_dataset.rs, WOWSP_DATASET_OUT)
      -> THIS SCRIPT: featurize -> train PyTorch DeepSets two-head
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

SCOPE (important): this validates the PIPELINE, not model quality. The
training data is ONE replay (3584 rows / 1330 can-fire / 171 fired, the E7
reference numbers); overfitting is expected and accepted. Metrics below are
machinery checks (loss decreases, heads separate, parity holds), not
performance claims.

Usage:
    # 1. export the dataset from a replay (Rust side):
    WOWSP_TEST_REPLAY=<replay> WOWSP_DATASET_OUT=<dataset.jsonl> \
        cargo test -p wowsp_tauri e9_dataset_export -- --nocapture
    # 2. train + export + validate:
    python scripts/experiments/train_fire_model.py \
        --data scripts/experiments/out/fire_model/dataset.jsonl
    # 3. prove the Rust side loads the real model:
    cargo test -p wowsp_tauri e9_real_model -- --ignored --nocapture

Outputs (under --out-dir, default scripts/experiments/out/fire_model/):
    fp32.onnx          static-shape ONNX export (batch 1)
    int8.onnx          int8 dynamic-quantized version
    sample_input.json  one featurized row (entity/global/mask arrays) for the
                       Rust-side ort test — avoids duplicating the featurizer
    metrics.json       all validation numbers (parity, quantization,
                       permutation, mask boundary, loss curve summary)

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

ENTITY_DIM = 10
GLOBAL_DIM = 14

# Normalization constants — deliberately fixed (no fitted scalers: one replay
# of data; every scale documented so the Rust side could mirror them later).
DIST_SCALE_M = 10_000.0  # planar distance: ~10 km -> 1.0
SPEED_SCALE_KT = 40.0  # top warship speeds ~40 kt
AGE_SCALE_S = 60.0  # observation age: clamp 60 s -> 1.0
TIME_SCALE_S = 1200.0  # match time: 20 min battle -> 1.0
RANGE_SCALE_M = 30_000.0  # engagement range: ~30 km -> 1.0
ZONE_SCALE = 10.0  # zone counts
EVENT_SCALE = 8.0  # log1p(event count) / 8 (138 shells/30 s -> ~0.61)


def featurize_slot(slot: dict | None) -> list[float]:
    """One entity slot -> ENTITY_DIM floats. `None` (padding) -> zeros."""
    if slot is None:
        return [0.0] * ENTITY_DIM
    dist = min(slot["distM"] / DIST_SCALE_M, 2.0)
    b = slot["bearingRelRad"]
    speed = slot.get("speedKt")
    hp = slot.get("hpFrac")
    los = slot.get("terrainBlocked")
    return [
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


def featurize_row(row: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, int | None]:
    """One exported JSON row -> (entity[SLOTS, ENTITY_DIM], global[GLOBAL_DIM],
    mask[SLOTS], labelA, labelB)."""
    entities: list[dict | None] = list(row["enemies"])[:ENEMY_SLOTS]
    entities += list(row["friends"])[:FRIEND_SLOTS]
    entity = np.zeros((SLOTS, ENTITY_DIM), dtype=np.float32)
    mask = np.zeros((SLOTS,), dtype=np.float32)
    for i, slot in enumerate(entities):
        entity[i] = featurize_slot(slot)
        mask[i] = 1.0
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
    label_a = int(row["labelACanFire"])
    label_b = None if row.get("labelBFired") is None else int(row["labelBFired"])
    return entity, g, mask, label_a, label_b


def load_dataset(path: Path) -> dict:
    rows = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as e:  # pragma: no cover
                    raise SystemExit(f"[e9] malformed JSONL at {path}:{n}: {e}") from e
    if not rows:
        raise SystemExit(f"[e9] {path} contains no rows — rerun the Rust export first")
    n = len(rows)
    data = {
        "entity": np.zeros((n, SLOTS, ENTITY_DIM), dtype=np.float32),
        "global": np.zeros((n, GLOBAL_DIM), dtype=np.float32),
        "mask": np.zeros((n, SLOTS), dtype=np.float32),
        "label_a": np.zeros((n,), dtype=np.float32),
        # labelB ground truth where defined; head-B loss is masked to
        # labelA==1 rows (a hold during reload is physics, not a decision).
        "label_b": np.full((n,), np.nan, dtype=np.float32),
    }
    for i, row in enumerate(rows):
        e, g, m, la, lb = featurize_row(row)
        data["entity"][i], data["global"][i], data["mask"][i] = e, g, m
        data["label_a"][i] = la
        if lb is not None:
            data["label_b"][i] = lb
    data["rows_meta"] = rows
    return data


# ── model (research note C first choice) ─────────────────────────────────────


def build_model() -> "torch.nn.Module":
    import torch
    import torch.nn as nn

    hidden = 320  # -> ~0.32 M params, inside the 0.3–1 M budget of note C

    class TwoHeadDeepSets(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.phi = nn.Sequential(  # per-entity shared encoder
                nn.Linear(ENTITY_DIM, hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden),
                nn.ReLU(),
            )
            self.ctx1 = nn.Linear(hidden + GLOBAL_DIM, hidden)  # broadcast-concat
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


# ── main ─────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(
        description=(
            "E9: train the two-head fire-decision DeepSets on a Rust-exported "
            "JSONL dataset, export ONNX fp32 + int8, and run the note-C "
            "validation battery (parity / quantization / permutation / mask)."
        )
    )
    p.add_argument(
        "--data",
        default=str(here / "out/fire_model/dataset.jsonl"),
        help="JSONL dataset from the Rust export (WOWSP_DATASET_OUT)",
    )
    p.add_argument(
        "--out-dir",
        default=str(here / "out/fire_model"),
        help="output directory for fp32.onnx / int8.onnx / metrics.json",
    )
    p.add_argument("--epochs", type=int, default=60, help="training epochs (default 60)")
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--lr", type=float, default=1e-3, help="AdamW learning rate")
    p.add_argument("--hidden", type=int, default=320, help="hidden width (default 320 -> ~0.32M params)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument(
        "--label-smoothing",
        type=float,
        default=0.05,
        help="BCE label smoothing (research note B: light eps 0.05-0.1)",
    )
    p.add_argument(
        "--parity-samples",
        type=int,
        default=1000,
        help="min samples for the PyTorch-vs-ORT parity check (note C: >=1000)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    data_path = Path(args.data)
    if not data_path.is_file():
        print(
            f"[e9] dataset not found: {data_path}\n"
            "      produce it with:\n"
            "      WOWSP_TEST_REPLAY=<replay> WOWSP_DATASET_OUT=<path> "
            "cargo test -p wowsp_tauri e9_dataset_export -- --nocapture",
            file=sys.stderr,
        )
        return 2

    try:
        import torch  # noqa: F401
    except ImportError:
        print(
            "[e9] torch is missing — install the CPU wheel:\n"
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

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[e9] loading {data_path}")
    data = load_dataset(data_path)
    n = len(data["label_a"])
    can = data["label_a"] == 1
    fired = data["label_b"] == 1
    print(
        f"[e9] {n} rows: labelA+ {int(can.sum())} ({can.mean():.3f}), "
        f"labelB+ {int(fired.sum())} (rate among A+ {fired.sum() / max(can.sum(), 1):.3f})"
    )

    # 80/20 random split (single replay — leakage is accepted; the goal is a
    # pipeline check, and both train and val metrics are reported).
    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(n)
    n_val = max(1, int(n * 0.2))
    val_idx, train_idx = perm[:n_val], perm[n_val:]

    def batch(idx: np.ndarray) -> dict:
        return {
            "entity": torch.from_numpy(data["entity"][idx]),
            "global": torch.from_numpy(data["global"][idx]),
            "mask": torch.from_numpy(data["mask"][idx]),
        }

    y_a = torch.from_numpy(data["label_a"])
    y_b = torch.from_numpy(np.nan_to_num(data["label_b"], nan=0.0))
    b_mask = torch.from_numpy(np.isfinite(data["label_b"]).astype(np.float32))

    model = build_model()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[e9] model: contextualised DeepSets two-head, {n_params:,} params")

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    # BCEWithLogitsLoss has no label_smoothing kwarg (only CrossEntropyLoss
    # does) — smooth the targets by hand: y' = y(1-eps) + eps/2 (note B: eps 0.05).
    eps = args.label_smoothing
    smooth = lambda t: t * (1.0 - eps) + 0.5 * eps  # noqa: E731
    bce = nn.BCEWithLogitsLoss(reduction="none")
    losses: list[float] = []
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        order = train_idx[np.random.permutation(len(train_idx))]
        tot, cnt = 0.0, 0
        for s in range(0, len(order), args.batch_size):
            idx = order[s : s + args.batch_size]
            b = batch(idx)
            la, lb = model(b["entity"], b["global"], b["mask"])
            loss_a = bce(la, smooth(y_a[idx])).mean()
            m = b_mask[idx]
            loss_b = (bce(lb, smooth(y_b[idx])) * m).sum() / m.sum().clamp(min=1.0)
            loss = loss_a + loss_b
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item() * len(idx)
            cnt += len(idx)
        losses.append(tot / cnt)
        if epoch == 0 or (epoch + 1) % 10 == 0:
            print(f"[e9] epoch {epoch + 1:3d}/{args.epochs} train loss {losses[-1]:.4f}")
    print(
        f"[e9] trained {args.epochs} epochs in {time.time() - t0:.1f}s: "
        f"loss {losses[0]:.4f} -> {losses[-1]:.4f}"
    )

    model.eval()
    with torch.no_grad():
        full = batch(np.arange(n))
        pt_la, pt_lb = model(full["entity"], full["global"], full["mask"])
    pt_pa, pt_pb = sigmoid(pt_la.numpy()), sigmoid(pt_lb.numpy())

    # Single-replay overfit is expected and accepted (pipeline check, not
    # a performance claim) — val numbers are reported for the machinery.
    finite_b = np.isfinite(data["label_b"])
    tr_a, va_a = train_idx, val_idx
    tr_b = train_idx[finite_b[train_idx]]
    va_b = val_idx[finite_b[val_idx]]
    metrics: dict = {
        "dataset": str(data_path),
        "rows": int(n),
        "rows_can_fire": int(can.sum()),
        "rows_fired": int(fired.sum()),
        "positive_rate_among_can_fire": float(fired.sum() / max(can.sum(), 1)),
        "params": int(n_params),
        "hidden": args.hidden,
        "epochs": args.epochs,
        "loss_first": losses[0],
        "loss_last": losses[-1],
        "loss_curve_every10": losses[9::10],
        # Single-replay overfit is expected and accepted (pipeline check, not
        # a performance claim) — val numbers are reported for the machinery.
        "auprc_a_train": average_precision(data["label_a"][tr_a], pt_pa[tr_a]),
        "auprc_a_val": average_precision(data["label_a"][va_a], pt_pa[va_a]),
        "auprc_b_train": average_precision(data["label_b"][tr_b], pt_pb[tr_b]),
        "auprc_b_val": average_precision(data["label_b"][va_b], pt_pb[va_b]),
    }

    # ── ONNX export (static shapes, batch 1) ─────────────────────────────
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
            output_names=["logitA", "logitB"],
            opset_version=17,
            dynamo=False,
        )
    except TypeError:
        # older/newer torch without the dynamo kwarg
        torch.onnx.export(
            model,
            (ex, gx, mx),
            str(fp32_path),
            input_names=["entity", "global_feat", "mask"],
            output_names=["logitA", "logitB"],
            opset_version=17,
        )
    onnx.checker.check_model(onnx.load(str(fp32_path)))
    print(f"[e9] exported + checked {fp32_path} ({fp32_path.stat().st_size:,} bytes)")

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
    print(f"[e9] quantized -> {int8_path} ({int8_path.stat().st_size:,} bytes)")

    so = ort.SessionOptions()
    sess_fp32 = ort.InferenceSession(str(fp32_path), so, providers=["CPUExecutionProvider"])
    sess_int8 = ort.InferenceSession(str(int8_path), so, providers=["CPUExecutionProvider"])

    def run_ort(sess, e, g, m):
        """Batch-1 ORT forward (the export is static batch 1): accepts
        [N, ...] arrays, loops rows, returns ([N], [N]) logits."""
        las, lbs = [], []
        for i in range(len(g)):
            la, lb = sess.run(
                None,
                {
                    "entity": e[i : i + 1].astype(np.float32),
                    "global_feat": g[i : i + 1].astype(np.float32),
                    "mask": m[i : i + 1].astype(np.float32),
                },
            )
            las.append(np.asarray(la).reshape(-1)[0])
            lbs.append(np.asarray(lb).reshape(-1)[0])
        return np.array(las), np.array(lbs)

    # ── validation battery (research note C checklist) ───────────────────
    # 1. PyTorch vs ORT fp32 parity over >= parity_samples samples.
    check = np.arange(min(n, max(args.parity_samples, n)))  # all rows (single replay)
    ort_la, ort_lb = run_ort(sess_fp32, data["entity"][check], data["global"][check], data["mask"][check])
    parity_a = float(np.max(np.abs(sigmoid(ort_la) - pt_pa[check])))
    parity_b = float(np.max(np.abs(sigmoid(ort_lb) - pt_pb[check])))
    print(f"[e9] parity fp32 PyTorch vs ORT over {len(check)} rows: max|dp| A {parity_a:.2e}, B {parity_b:.2e}")

    # 2. int8 vs fp32 (probabilities + PR-AUPRC / log loss on head B among A+).
    q_la, q_lb = run_ort(sess_int8, data["entity"][check], data["global"][check], data["mask"][check])
    quant_dp_a = float(np.max(np.abs(sigmoid(q_la) - sigmoid(ort_la))))
    quant_dp_b = float(np.max(np.abs(sigmoid(q_lb) - sigmoid(ort_lb))))
    auprc_fp32 = average_precision(data["label_b"][can], sigmoid(ort_lb)[can])
    auprc_int8 = average_precision(data["label_b"][can], sigmoid(q_lb)[can])
    auprc_a_fp32 = average_precision(data["label_a"], sigmoid(ort_la))
    auprc_a_int8 = average_precision(data["label_a"], sigmoid(q_la))
    ll_fp32 = log_loss(data["label_b"][can], sigmoid(ort_lb)[can])
    ll_int8 = log_loss(data["label_b"][can], sigmoid(q_lb)[can])
    print(
        f"[e9] int8 vs fp32: max|dp| A {quant_dp_a:.2e} B {quant_dp_b:.2e}; "
        f"AUPRC-B fp32 {auprc_fp32:.4f} int8 {auprc_int8:.4f}; "
        f"AUPRC-A fp32 {auprc_a_fp32:.4f} int8 {auprc_a_int8:.4f}; "
        f"logloss-B fp32 {ll_fp32:.4f} int8 {ll_int8:.4f}"
    )

    # 3. Permutation invariance: the shared per-entity MLP + masked-mean
    # aggregation carry NO positional information, so permuting slots (with
    # their mask entries) must not change the output — the DeepSets property,
    # verifiable even though the SLOTS themselves are deterministically
    # ordered (order only decides truncation, which this does not touch).
    perm_max_a = perm_max_b = 0.0
    qperm_max_a = qperm_max_b = 0.0
    for i in range(200):
        pidx = np.random.permutation(SLOTS)
        e = data["entity"][i][pidx][None]
        m = data["mask"][i][pidx][None]
        g = data["global"][i][None]
        pla, plb = run_ort(sess_fp32, e, g, m)
        perm_max_a = max(perm_max_a, abs(pla[0] - ort_la[i]))
        perm_max_b = max(perm_max_b, abs(plb[0] - ort_lb[i]))
        qla, qlb = run_ort(sess_int8, e, g, m)
        qperm_max_a = max(qperm_max_a, abs(qla[0] - q_la[i]))
        qperm_max_b = max(qperm_max_b, abs(qlb[0] - q_lb[i]))
    print(
        f"[e9] permutation (200 rows): fp32 max|dlogit| A {perm_max_a:.2e} B {perm_max_b:.2e}; "
        f"int8 A {qperm_max_a:.2e} B {qperm_max_b:.2e}"
    )

    # 4. Mask boundary: all enemy slots masked + zeroed on real rows, and a
    # fully-masked synthetic row — no NaN/inf anywhere.
    worst_nan = False
    for i in range(50):
        e = data["entity"][i].copy()
        m = data["mask"][i].copy()
        e[:ENEMY_SLOTS] = 0.0
        m[:ENEMY_SLOTS] = 0.0
        la, lb = run_ort(sess_fp32, e[None], data["global"][i][None], m[None])
        worst_nan = worst_nan or not (np.isfinite(la).all() and np.isfinite(lb).all())
    e0 = np.zeros((1, SLOTS, ENTITY_DIM), dtype=np.float32)
    m0 = np.zeros((1, SLOTS), dtype=np.float32)
    g0 = np.zeros((1, GLOBAL_DIM), dtype=np.float32)
    la0, lb0 = run_ort(sess_fp32, e0, g0, m0)
    empty_finite = bool(np.isfinite(la0).all() and np.isfinite(lb0).all())
    la0i, lb0i = run_ort(sess_int8, e0, g0, m0)
    empty_finite_int8 = bool(np.isfinite(la0i).all() and np.isfinite(lb0i).all())
    print(
        f"[e9] mask boundary: enemy-masked rows finite={not worst_nan}, "
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
        "entityDim": ENTITY_DIM,
        "globalDim": GLOBAL_DIM,
    }
    (out_dir / "sample_input.json").write_text(json.dumps(sample), encoding="utf-8")

    metrics.update(
        {
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
        if isinstance(o, (np.floating, np.integer)):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
        return o

    (out_dir / "metrics.json").write_text(json.dumps(jsonable(metrics), indent=2), encoding="utf-8")
    print(f"[e9] wrote {out_dir / 'metrics.json'} and sample_input.json")

    # Pipeline gate: everything the delivery loop promised must hold.
    assert parity_a < 1e-5 and parity_b < 1e-5, "fp32 parity failed"
    assert not worst_nan and empty_finite and empty_finite_int8, "NaN at mask boundary"
    assert perm_max_a < 1e-6 and perm_max_b < 1e-6, "permutation invariance failed"
    assert losses[-1] < 0.5 * losses[0], "train loss did not decrease enough"
    print("[e9] ALL pipeline checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
