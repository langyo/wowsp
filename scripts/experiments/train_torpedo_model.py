#!/usr/bin/env python3
"""E26: torpedo-decision two-head model (train + out-of-fold evaluation).

The torpedo twin of the fire model: "given this tick and this intel, can this
ship launch torpedoes right now, and does the expert actually launch?"

Pipeline (the Rust half is E26's `TorpedoDatasetRow` family in
`fire_dataset.rs`, env-gated batch export `e26_torpedo_export_on_real_replays`):

    Torpedo JSONL (DecisionRowCore v2 schema + torpedo labels)
      -> THIS SCRIPT: reuse train_fire_model's featurizers/metrics verbatim
         -> train the two-head DeepSets (head A "can launch", head B "launched")
            on a GroupKFold-by-replay split
      -> pooled out-of-fold metrics + per-class breakdown + baselines
      -> metrics JSON (--metrics-out) + human-readable stdout tables.

Row contract (fixed by the Rust export; both labels live on the same row):
  labelACanLaunch: bool      — reload ready AND an observed enemy in torp range
  labelBLaunched: bool|null  — a torpedo CLICK by the decider in (t, t+window];
                               null exactly when labelA is false (censored)
  ownReloadFrac / ownRangeM  — in THIS family they carry the TORPEDO reload /
                               range (the Rust exporter writes them), so the
                               generic v2 featurizers are correct unchanged.
  featureVersion: 2 (entity 15-wide, global 27-wide — same as fire/move v2).

Deciders exclude carriers: a CV "torpedo launch" is a squadron air-drop whose
owner is the carrier hull, not a ship torpedo decision. The exporter drops
them; this loader also skips any AirCarrier row (belt and braces) and reports
the count.

SCOPE: this validates learnability on a CPU pilot, not deployment quality —
the pilot uses the first --max-rows rows by file order, a single own-shard
slice, and no GPU. Pre-registration:
scripts/experiments/out/torpedo_model/e26-preregistration.md.

Dependencies: numpy (always), torch (training; NOT needed for --selftest).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:  # allow `import train_fire_model` from any cwd
    sys.path.insert(0, str(HERE))

import train_fire_model as tfm  # noqa: E402  (numpy-only at import time)

REPO_ROOT = HERE.parents[1]  # scripts/experiments -> repo root
DEFAULT_SHIP_CLASSES = REPO_ROOT / "packages/webui/src/res/data/ships_basics.json"

# Row family constants (must stay in sync with fire_dataset.rs E26 export).
FEATURE_VERSION = 2
CLASS_ORDER = ["Destroyer", "Cruiser", "Battleship", "Submarine", "unknown"]
CLASS_LABEL = {
    "Destroyer": "DD",
    "Cruiser": "CL/CA",
    "Battleship": "BB",
    "Submarine": "SS",
    "unknown": "unknown",
}
# Pre-registered pilot acceptance (see e26-preregistration.md).
ACCEPT_AUPRC_MULTIPLE = 2.0  # head-B OOF AUPRC >= 2x its base rate
ACCEPT_TOPDECILE_LIFT = 1.5  # top-decile launch rate >= 1.5x base rate
MIN_CLASS_N = 30  # below this a class is described, never judged


# ── CLI ─────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--data", action="append", default=[], help="torpedo JSONL file(s); repeatable")
    p.add_argument("--data-dir", action="append", default=[], help="directory of *.jsonl (sorted)")
    p.add_argument(
        "--max-rows",
        type=int,
        default=250000,
        help="pilot budget: keep the FIRST N rows in file order (0 = all rows)",
    )
    p.add_argument("--ship-classes", default=str(DEFAULT_SHIP_CLASSES), help="ships_basics.json for shipId->type")
    p.add_argument("--epochs", type=int, default=12)
    p.add_argument("--hidden", type=int, default=192)
    p.add_argument("--batch-size", type=int, default=4096)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--label-smoothing", type=float, default=0.05)
    p.add_argument("--folds", type=int, default=5, help="target GroupKFold folds (degraded when fewer replays)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    p.add_argument("--metrics-out", default=None, help="write the full metrics JSON here")
    p.add_argument("--selftest", action="store_true", help="torch-free unit test of loader/labels/split/metrics")
    return p.parse_args(argv)


def resolve_data_paths(args: argparse.Namespace) -> list[Path]:
    paths: list[Path] = [Path(p) for p in args.data]
    for d in args.data_dir:
        paths.extend(sorted(Path(d).glob("*.jsonl")))
    seen: set[Path] = set()
    unique: list[Path] = []
    for p in paths:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            unique.append(p)
    if not unique:
        raise SystemExit("[e26] no data: pass --data <jsonl> and/or --data-dir <dir>")
    return unique


# ── ship class table ────────────────────────────────────────────────────────


def load_ship_classes(path: Path) -> tuple[dict[int, str], str | None]:
    """shipId -> class string out of the webui ships_basics pack."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    ships = raw.get("ships") or {}
    out: dict[int, str] = {}
    for sid, entry in ships.items():
        try:
            out[int(sid)] = str(entry.get("type") or "unknown")
        except (TypeError, ValueError):
            continue
    return out, raw.get("gameVersion")


def class_of(ship_id: int | None, classes: dict[int, str]) -> str:
    if ship_id is None:
        return "unknown"
    return classes.get(int(ship_id), "unknown")


# ── loader ──────────────────────────────────────────────────────────────────


def row_labels(row: dict) -> tuple[float, float, bool]:
    """(label_a, label_b, consistent) — label_b NaN when censored.

    Contract: labelB is defined EXACTLY on can-launch rows (null elsewhere).
    A row violating either direction is a malformed export: counted and
    dropped, never silently trained on."""
    a = bool(row.get("labelACanLaunch"))
    b = row.get("labelBLaunched")
    if a:
        if b is None:
            return 1.0, float("nan"), False
        return 1.0, (1.0 if bool(b) else 0.0), True
    return 0.0, float("nan"), b is None


def load_torpedo_rows(
    paths: list[Path],
    max_rows: int,
    classes: dict[int, str],
) -> dict:
    """Stream the JSONL corpus into featurized front-loaded arrays (pilot
    budget = first --max-rows rows in file order)."""
    budget = max_rows if max_rows and max_rows > 0 else None
    n_max = budget if budget is not None else 0

    # Preallocate when a budget exists (entity block dominates: N*24*15 floats).
    if n_max:
        Xe = np.zeros((n_max, tfm.SLOTS, tfm.ENTITY_DIM_V2), dtype=np.float32)
        Xg = np.zeros((n_max, tfm.GLOBAL_DIM_V2), dtype=np.float32)
        Xm = np.zeros((n_max, tfm.SLOTS), dtype=np.float32)
    else:
        ents: list[np.ndarray] = []
        globs: list[np.ndarray] = []
        masks: list[np.ndarray] = []
    ya = np.zeros(n_max or 0, dtype=np.float32)
    yb = np.full(n_max or 0, np.nan, dtype=np.float32)
    ship_ids: list[int | None] = []
    groups: list[str] = []
    cls_counts: dict[str, int] = {k: 0 for k in CLASS_ORDER}

    rows = 0
    skipped_cv = 0
    inconsistent = 0
    bad_json = 0
    files: list[dict] = []
    files_skipped: list[str] = []
    for path in paths:
        if budget is not None and rows >= budget:
            files_skipped.append(str(path))
            continue
        used = 0
        lines_total = 0
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                lines_total += 1
                if budget is not None and rows >= budget:
                    continue  # keep counting lines for an honest sampling note
                s = line.strip()
                if not s:
                    continue
                try:
                    row = json.loads(s)
                except json.JSONDecodeError:
                    bad_json += 1
                    continue
                ver = int(row.get("featureVersion", FEATURE_VERSION))
                if ver != FEATURE_VERSION:
                    raise SystemExit(
                        f"[e26] {path}: featureVersion {ver} != {FEATURE_VERSION} — this family "
                        "carries the fire/move v2 schema (entity 15 / global 27)"
                    )
                ship_id = row.get("shipId")
                ship_id = int(ship_id) if ship_id is not None else None
                cls = class_of(ship_id, classes)
                if cls == "AirCarrier":
                    skipped_cv += 1
                    continue
                a, b, ok = row_labels(row)
                if not ok:
                    inconsistent += 1
                    continue
                e, m = tfm.entity_matrix_and_mask(row, FEATURE_VERSION)
                g = tfm.global_vector(row, FEATURE_VERSION)
                if n_max:
                    Xe[rows] = e
                    Xg[rows] = g
                    Xm[rows] = m
                else:
                    ents.append(e)
                    globs.append(g)
                    masks.append(m)
                if n_max:
                    ya[rows] = a
                    yb[rows] = b
                else:
                    ya = np.append(ya, a)
                    yb = np.append(yb, b)
                ship_ids.append(ship_id)
                groups.append(str(row.get("replayId") or path.stem))
                cls_counts[cls] = cls_counts.get(cls, 0) + 1
                rows += 1
                used += 1
        files.append(
            {
                "path": str(path),
                "bytes": path.stat().st_size,
                "lines": lines_total,
                "rows_used": used,
            }
        )
    if rows == 0:
        raise SystemExit("[e26] no usable rows loaded")

    if n_max:
        Xe, Xg, Xm = Xe[:rows], Xg[:rows], Xm[:rows]
        ya, yb = ya[:rows], yb[:rows]
    else:
        Xe = np.stack(ents)
        Xg = np.stack(globs)
        Xm = np.stack(masks)
    return {
        "entity": Xe,
        "global": Xg,
        "mask": Xm,
        "label_a": ya,
        "label_b": yb,
        "ship_id": np.array([-1 if s is None else s for s in ship_ids], dtype=np.int64),
        "group": np.array(groups, dtype=object),
        "class": np.array([class_of(s, classes) for s in ship_ids], dtype=object),
        "rows": rows,
        "files": files,
        "files_skipped": files_skipped,
        "skipped_aircarrier": skipped_cv,
        "inconsistent_labelb": inconsistent,
        "bad_json_rows": bad_json,
        "class_counts": cls_counts,
        "max_rows": budget,
    }


# ── split ───────────────────────────────────────────────────────────────────


def make_split(groups: np.ndarray, target_folds: int, seed: int) -> dict:
    """GroupKFold by replay. Degrades honestly when replays are scarce:
    >= target folds -> target-fold GroupKFold; 2..target-1 replays -> LOO
    (one fold per replay); 1 replay -> random 20% holdout (pipeline evidence
    only, NOT a generalisation estimate)."""
    n_groups = len(set(groups.tolist()))
    if n_groups >= max(2, target_folds):
        k = max(2, target_folds)
        fold = tfm.group_kfold_assign(groups, k)
        return {"mode": f"{k}-fold GroupKFold by replayId", "folds": k, "fold": fold, "n_groups": n_groups}
    if n_groups >= 2:
        fold = tfm.group_kfold_assign(groups, n_groups)
        return {
            "mode": f"leave-one-replay-out ({n_groups} replays; GroupKFold degraded from {target_folds})",
            "folds": n_groups,
            "fold": fold,
            "n_groups": n_groups,
        }
    rng = np.random.default_rng(seed)
    n = len(groups)
    fold = np.zeros(n, dtype=np.int64)
    n_val = max(1, int(round(n * 0.2)))
    fold[rng.permutation(n)[:n_val]] = 1
    return {
        "mode": "single-replay random-20pct holdout (PIPELINE evidence only, not a generalisation estimate)",
        "folds": 2,
        "fold": fold,
        "n_groups": 1,
    }


# ── training ────────────────────────────────────────────────────────────────


def bce_smoothed_loss(bce, logits, target, smooth_eps: float):
    return bce(logits, target * (1.0 - smooth_eps) + 0.5 * smooth_eps)


def train_fold(
    *,
    torch,
    entity,
    glob,
    mask,
    y_a,
    y_b,
    train_idx: np.ndarray,
    val_idx: np.ndarray,
    args: argparse.Namespace,
    fold: int,
    entity_dim: int,
    global_dim: int,
    b_mask_all,
    log_fn,
):
    """Train one fold, return (p_a_val, p_b_val, epoch_losses, seconds)."""
    nn = torch.nn
    torch.manual_seed(args.seed + fold)
    np.random.seed(args.seed + fold)
    model = tfm.build_model(hidden=args.hidden, entity_dim=entity_dim, global_dim=global_dim)
    model.to(args._device_torch)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    bce = nn.BCEWithLogitsLoss(reduction="none")
    eps = args.label_smoothing

    idx_t = torch.from_numpy(train_idx)
    y_a_t = y_a
    y_b_t = y_b
    bmask_t = b_mask_all
    losses: list[float] = []
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        perm = idx_t[torch.randperm(len(idx_t))]
        tot, cnt = 0.0, 0
        for s in range(0, len(perm), args.batch_size):
            idx = perm[s : s + args.batch_size]
            la, lb = model(entity[idx], glob[idx], mask[idx])
            loss_a = bce_smoothed_loss(bce, la, y_a_t[idx], eps).mean()
            m = bmask_t[idx]
            loss_b = (bce_smoothed_loss(bce, lb, y_b_t[idx], eps) * m).sum() / m.sum().clamp(min=1.0)
            loss = loss_a + loss_b
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += float(loss.item()) * len(idx)
            cnt += len(idx)
        losses.append(tot / max(cnt, 1))
        log_fn(f"  fold {fold} epoch {epoch + 1}/{args.epochs} loss {losses[-1]:.4f} ({time.time() - t0:.1f}s)")

    model.eval()
    with torch.no_grad():
        v_idx = torch.from_numpy(val_idx)
        la, lb = model(entity[v_idx], glob[v_idx], mask[v_idx])
        p_a = torch.sigmoid(la).cpu().numpy()
        p_b = torch.sigmoid(lb).cpu().numpy()
    return p_a, p_b, losses, time.time() - t0


# ── metrics ─────────────────────────────────────────────────────────────────


def _num(v):
    """JSON-safe float (NaN/inf -> None)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(f) or math.isinf(f)) else f


def head_a_metrics(y: np.ndarray, p: np.ndarray) -> dict:
    ece, rel = tfm.ece_and_reliability(y, p)
    return {
        "rows": int(len(y)),
        "positives": int(y.sum()),
        "baseRate": _num(y.mean()) if len(y) else None,
        "auprc": _num(tfm.average_precision(y, p)) if len(y) else None,
        "roc_auc": _num(tfm.roc_auc(y, p)) if len(y) else None,
        "logloss": _num(tfm.log_loss(y, p)) if len(y) else None,
        "brier": _num(tfm.brier_score(y, p)) if len(y) else None,
        "ece_15bin": _num(ece) if len(y) else None,
        "reliability_15bin": rel if len(y) else [],
    }


def head_b_metrics(y: np.ndarray, p: np.ndarray) -> dict:
    """Head B over the can-launch subset (y is finite there by construction)."""
    dec = tfm.decile_lift(y, p) if len(y) else {"baseRate": None, "deciles": [], "spearmanRhoMeanPvsRate": None}
    top = dec["deciles"][0] if dec["deciles"] else {"n": 0, "actualRate": None, "lift": None}
    ece, rel = tfm.ece_and_reliability(y, p) if len(y) else (float("nan"), [])
    return {
        "rows": int(len(y)),
        "positives": int(y.sum()),
        "baseRate": _num(dec["baseRate"]),
        "auprc": _num(tfm.average_precision(y, p)) if len(y) else None,
        "roc_auc": _num(tfm.roc_auc(y, p)) if len(y) else None,
        "logloss": _num(tfm.log_loss(y, p)) if len(y) else None,
        "brier": _num(tfm.brier_score(y, p)) if len(y) else None,
        "ece_15bin": _num(ece) if len(y) else None,
        "topDecile": {"n": int(top["n"]), "actualRate": _num(top["actualRate"]), "lift": _num(top["lift"])},
        "decileLift": dec,
        "reliability_15bin": rel,
    }


def no_skill_baselines(y_b_subset: np.ndarray) -> dict:
    """Constant-prediction baselines for head B (no-skill + labelA rule).

    On the labelA subset the 'rule' baseline predicts 1 for every row (the
    rule says these rows are physically launchable), so both baselines carry
    the base rate as AUPRC; the log loss shows why a calibrated head matters.
    """
    if len(y_b_subset) == 0:
        return {}
    base = float(y_b_subset.mean())
    p_const = np.clip(base, 1e-7, 1 - 1e-7)
    p_one = np.full(len(y_b_subset), 1.0 - 1e-7)
    return {
        "baseRate": _num(base),
        "noSkill": {
            "predict": "constant base rate",
            "auprc": _num(tfm.average_precision(y_b_subset, np.full(len(y_b_subset), p_const))),
            "logloss": _num(tfm.log_loss(y_b_subset, np.full(len(y_b_subset), p_const))),
            "brier": _num(tfm.brier_score(y_b_subset, np.full(len(y_b_subset), p_const))),
            "roc_auc": 0.5,
        },
        "labelARule": {
            "predict": "always 1 on labelA rows",
            "auprc": _num(tfm.average_precision(y_b_subset, p_one)),
            "logloss": _num(tfm.log_loss(y_b_subset, p_one)),
            "brier": _num(tfm.brier_score(y_b_subset, p_one)),
            "roc_auc": 0.5,
        },
    }


def per_class_metrics(data: dict, p_a: np.ndarray, p_b: np.ndarray, b_mask: np.ndarray) -> dict:
    out: dict[str, dict] = {}
    for cls in CLASS_ORDER:
        m = data["class"] == cls
        n = int(m.sum())
        if n == 0:
            continue
        can = int(data["label_a"][m].sum())
        launched = int(np.nansum(data["label_b"][m]))
        entry = {
            "rows": n,
            "canLaunch": can,
            "launched": launched,
            "positiveRate": _num(launched / can) if can else None,
            "auprc_headA": None,
            "auprc_headB": None,
            "note": None,
        }
        if n >= MIN_CLASS_N:
            entry["auprc_headA"] = _num(tfm.average_precision(data["label_a"][m], p_a[m]))
            mb = m & b_mask
            if int(mb.sum()) >= MIN_CLASS_N and int(np.nansum(data["label_b"][mb])) > 0:
                entry["auprc_headB"] = _num(
                    tfm.average_precision(data["label_b"][mb], p_b[mb])
                )
        else:
            entry["note"] = f"n<{MIN_CLASS_N}: descriptive only (pre-registered)"
        out[cls] = entry
    return out


def summarize_per_fold(fold_reports: list[dict]) -> dict:
    keys = [
        ("headA", "auprc"),
        ("headA", "roc_auc"),
        ("headA", "ece_15bin"),
        ("headB", "auprc"),
        ("headB", "roc_auc"),
        ("headB", "logloss"),
        ("headB", "ece_15bin"),
    ]
    out: dict[str, dict] = {}
    for head, key in keys:
        vals = [
            r[head][key]
            for r in fold_reports
            if r.get(head, {}).get(key) is not None and math.isfinite(r[head][key])
        ]
        name = f"{head}.{key}"
        if vals:
            out[name] = {
                "n_folds": len(vals),
                "mean": _num(np.mean(vals)),
                "std": _num(np.std(vals)),
            }
    lifts = [
        r["headB"]["topDecile"]["lift"]
        for r in fold_reports
        if r.get("headB", {}).get("topDecile", {}).get("lift") is not None
    ]
    if lifts:
        out["headB.topDecileLift"] = {"n_folds": len(lifts), "mean": _num(np.mean(lifts)), "std": _num(np.std(lifts))}
    return out


# ── main training run ───────────────────────────────────────────────────────


def run_training(args: argparse.Namespace) -> dict:
    import torch  # training-only dependency (--selftest must not need it)

    if args.device == "cuda":
        if not torch.cuda.is_available():
            raise SystemExit("[e26] --device cuda requested but torch reports no CUDA")
        device = torch.device("cuda")
    elif args.device == "cpu" or not torch.cuda.is_available():
        device = torch.device("cpu")
    else:
        device = torch.device("cuda")
    torch.set_num_threads(max(1, torch.get_num_threads()))
    args._device_torch = device
    log = lambda s: print(s, flush=True)  # noqa: E731
    log(f"[e26] device {device} (torch {torch.__version__}, threads {torch.get_num_threads()})")

    classes, class_pack_version = load_ship_classes(Path(args.ship_classes))
    paths = resolve_data_paths(args)
    t0 = time.time()
    data = load_torpedo_rows(paths, args.max_rows, classes)
    load_s = time.time() - t0
    log(
        f"[e26] loaded {data['rows']:,} rows from {len(data['files'])} file(s) "
        f"(skipped files {len(data['files_skipped'])}, AirCarrier rows skipped {data['skipped_aircarrier']}, "
        f"inconsistent labelB {data['inconsistent_labelb']}, bad json {data['bad_json_rows']}) "
        f"in {load_s:.1f}s"
    )
    log(f"[e26] class counts: {json.dumps(data['class_counts'], ensure_ascii=False)}")

    entity = torch.from_numpy(data["entity"])
    glob = torch.from_numpy(data["global"])
    mask = torch.from_numpy(data["mask"])
    y_a = torch.from_numpy(data["label_a"])
    y_b = torch.from_numpy(np.nan_to_num(data["label_b"], nan=0.0))
    b_mask_np = (data["label_a"] == 1.0) & np.isfinite(data["label_b"])
    b_mask = torch.from_numpy(b_mask_np.astype(np.float32))
    entity_dim = tfm.ENTITY_DIM_V2
    global_dim = tfm.GLOBAL_DIM_V2

    split = make_split(data["group"], args.folds, args.seed)
    fold = split["fold"]
    log(f"[e26] split: {split['mode']} ({split['n_groups']} replays)")

    n = data["rows"]
    p_a = np.full(n, np.nan, dtype=np.float64)
    p_b = np.full(n, np.nan, dtype=np.float64)
    fold_reports: list[dict] = []
    epoch_losses_all: list[list[float]] = []
    for f in range(split["folds"]):
        val_idx = np.flatnonzero(fold == f)
        train_idx = np.flatnonzero(fold != f)
        if len(val_idx) == 0 or len(train_idx) == 0:
            continue  # fold 1 of the single-replay path with tiny data
        log(f"[e26] fold {f}: train {len(train_idx):,} / val {len(val_idx):,}")
        fa, fb, losses, secs = train_fold(
            torch=torch,
            entity=entity,
            glob=glob,
            mask=mask,
            y_a=y_a,
            y_b=y_b,
            train_idx=train_idx,
            val_idx=val_idx,
            args=args,
            fold=f,
            entity_dim=entity_dim,
            global_dim=global_dim,
            b_mask_all=b_mask,
            log_fn=log,
        )
        p_a[val_idx] = fa
        p_b[val_idx] = fb
        epoch_losses_all.append(losses)
        va = val_idx
        mb = b_mask_np[va]
        fold_reports.append(
            {
                "fold": f,
                "train_rows": int(len(train_idx)),
                "val_rows": int(len(va)),
                "seconds": round(secs, 1),
                "loss_first": round(losses[0], 4),
                "loss_last": round(losses[-1], 4),
                "headA": head_a_metrics(data["label_a"][va], p_a[va]),
                "headB": head_b_metrics(data["label_b"][va][mb], p_b[va][mb]),
            }
        )
        log(
            f"[e26] fold {f} val headB: AUPRC {fold_reports[-1]['headB']['auprc']} "
            f"AUC {fold_reports[-1]['headB']['roc_auc']} "
            f"base {fold_reports[-1]['headB']['baseRate']} topLift {fold_reports[-1]['headB']['topDecile']['lift']}"
        )

    scored = np.isfinite(p_a)
    log(f"[e26] out-of-fold predictions for {int(scored.sum()):,}/{n:,} rows")

    # Pooled OOF metrics are the PRE-REGISTERED primary analysis.
    oof = {
        "headA": head_a_metrics(data["label_a"][scored], p_a[scored]),
        "headB": head_b_metrics(data["label_b"][scored][b_mask_np[scored]], p_b[scored][b_mask_np[scored]]),
    }
    baselines = no_skill_baselines(data["label_b"][b_mask_np])
    per_class = per_class_metrics(data, p_a, p_b, b_mask_np)

    hb = oof["headB"]
    base = hb.get("baseRate") or 0.0
    auprc = hb.get("auprc")
    top_lift = hb.get("topDecile", {}).get("lift")
    passed_auprc = bool(auprc is not None and base > 0 and auprc >= ACCEPT_AUPRC_MULTIPLE * base)
    passed_lift = bool(top_lift is not None and top_lift >= ACCEPT_TOPDECILE_LIFT)
    acceptance = {
        "rule": f"headB OOF AUPRC >= {ACCEPT_AUPRC_MULTIPLE}x base rate AND top-decile launch-rate lift >= {ACCEPT_TOPDECILE_LIFT}x",
        "headB_auprc": _num(auprc),
        "headB_baseRate": _num(base),
        "headB_auprc_multiple": _num((auprc / base) if (auprc is not None and base) else None),
        "topDecileLift": _num(top_lift),
        "pass_auprc": passed_auprc,
        "pass_lift": passed_lift,
        "verdict": "pass" if (passed_auprc and passed_lift) else ("mixed" if (passed_auprc or passed_lift) else "fail"),
        "note": "per-class acceptance is descriptive only: DD/CL/SS are reported with n/positives, never judged when n<30",
    }

    metrics = {
        "_lineage": "E26 torpedo-decision pilot (train_torpedo_model.py)",
        "protocol": {
            "pipeline": "Rust TorpedoDatasetRow JSONL (DecisionRowCore v2 + torpedo labels) -> this script",
            "feature_version": FEATURE_VERSION,
            "entity_dim": entity_dim,
            "global_dim": global_dim,
            "data_paths": [str(p) for p in paths],
            "max_rows": args.max_rows,
            "sampling": "first N rows in file order (pilot budget); files after the budget are skipped",
            "epochs": args.epochs,
            "hidden": args.hidden,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "label_smoothing": args.label_smoothing,
            "seed": args.seed,
            "device": str(device),
            "torch": torch.__version__,
            "numpy": np.__version__,
            "ship_classes": str(args.ship_classes),
            "ship_class_pack": class_pack_version,
            "acceptance": {
                "auprc_multiple": ACCEPT_AUPRC_MULTIPLE,
                "topdecile_lift": ACCEPT_TOPDECILE_LIFT,
                "min_class_n": MIN_CLASS_N,
            },
        },
        "data": {
            "rows": data["rows"],
            "replays": split["n_groups"],
            "files": data["files"],
            "files_skipped_after_budget": data["files_skipped"],
            "skipped_aircarrier": data["skipped_aircarrier"],
            "inconsistent_labelb": data["inconsistent_labelb"],
            "bad_json_rows": data["bad_json_rows"],
            "class_counts": data["class_counts"],
            "labels": {
                "rows": int(n),
                "canLaunch": int(data["label_a"].sum()),
                "canLaunchRate": _num(data["label_a"].mean()),
                "launched_true": int(np.nansum(data["label_b"])),
                "labelB_null": int(np.isnan(data["label_b"]).sum()),
                "positiveRate_among_can": _num(np.nansum(data["label_b"]) / max(int(data["label_a"].sum()), 1)),
            },
            "load_seconds": round(load_s, 1),
        },
        "split": {
            "mode": split["mode"],
            "folds": split["folds"],
            "replays": split["n_groups"],
            "fold_sizes": [int((fold == f).sum()) for f in range(split["folds"])],
        },
        "metrics_oof_pooled": oof,
        "baselines_headB": baselines,
        "per_class": per_class,
        "per_fold": {
            "folds": fold_reports,
            "summary_mean_std": summarize_per_fold(fold_reports),
        },
        "training": {
            "fold_seconds": [r["seconds"] for r in fold_reports],
            "total_seconds": round(sum(r["seconds"] for r in fold_reports), 1),
            "epoch_loss_first": [_num(l[0]) for l in epoch_losses_all],
            "epoch_loss_last": [_num(l[-1]) for l in epoch_losses_all],
        },
        "acceptance": acceptance,
    }
    return metrics


def print_report(metrics: dict) -> None:
    d = metrics["data"]
    lab = d["labels"]
    print("\n=== E26 torpedo pilot ===")
    print(f"rows {d['rows']:,} | replays {d['replays']} | canLaunch {lab['canLaunch']:,} "
          f"({(lab['canLaunchRate'] or 0) * 100:.2f}%) | launched {lab['launched_true']:,} "
          f"(pos rate among can {(lab['positiveRate_among_can'] or 0) * 100:.2f}%)")
    print(f"split: {metrics['split']['mode']}")
    oof = metrics["metrics_oof_pooled"]
    a, b = oof["headA"], oof["headB"]
    print(f"headA OOF: AUPRC {a['auprc']} AUC {a['roc_auc']} ECE {a['ece_15bin']} (base {a['baseRate']})")
    print(f"headB OOF: AUPRC {b['auprc']} AUC {b['roc_auc']} logloss {b['logloss']} ECE {b['ece_15bin']} "
          f"(base {b['baseRate']}, top-decile lift {b['topDecile']['lift']})")
    bl = metrics["baselines_headB"]
    if bl:
        print(f"baseline no-skill AUPRC {bl['noSkill']['auprc']} logloss {bl['noSkill']['logloss']}; "
              f"labelA-rule AUPRC {bl['labelARule']['auprc']} logloss {bl['labelARule']['logloss']}")
    print("\nper class:")
    for cls, e in metrics["per_class"].items():
        print(f"  {CLASS_LABEL.get(cls, cls):7s} rows {e['rows']:7,} canLaunch {e['canLaunch']:7,} "
              f"launched {e['launched']:6,} posRate {e['positiveRate']} "
              f"AUPRC-A {e['auprc_headA']} AUPRC-B {e['auprc_headB']}")
    acc = metrics["acceptance"]
    print(f"\nacceptance: {acc['rule']}")
    print(f"  AUPRC {acc['headB_auprc']} = {acc['headB_auprc_multiple']}x base -> {acc['pass_auprc']}; "
          f"top-decile lift {acc['topDecileLift']} -> {acc['pass_lift']}; VERDICT {acc['verdict'].upper()}")
    print(f"total train seconds {metrics['training']['total_seconds']}")


# ── self-test (torch-free) ──────────────────────────────────────────────────


def run_selftest() -> int:
    import tempfile

    root = Path(tempfile.mkdtemp(prefix="e26-selftest-"))

    def synth(ship_id=1, a=True, b=True, replay="r1") -> dict:
        row = {
            "replayId": replay,
            "shipId": ship_id,
            "t": 5.0,
            "ownSpeedKt": 20.0,
            "ownHpFrac": 1.0,
            "ownReloadFrac": 0.5,
            "ownRangeM": 10000.0,
            "zonesOwned0": 1,
            "zonesOwned1": 0,
            "zonesOwned2": 0,
            "zonesOwnedOther": 2,
            "zonesActiveProgress": 1,
            "eventsShells30s": 3,
            "eventsTorps30s": 1,
            "eventsExplosions30s": 0,
            "eventsExplosionsNear30s": 0,
            "enemies": [
                {
                    "entityId": 9,
                    "entityType": 2,
                    "shipId": 2,
                    "distM": 5000.0,
                    "bearingRelRad": 0.5,
                    "speedKt": 15.0,
                    "hpFrac": 0.8,
                    "obsAgeS": 0.2,
                    "observedNow": True,
                    "terrainBlocked": None,
                    "spotting": None,
                    "insideSmoke": False,
                    "radarLit": False,
                    "isEnemy": True,
                    "enginePowerFrac": 0.5,
                }
            ],
            "friends": [],
            "featureVersion": 2,
            "ownDamconFrac": 1.0,
            "ownRepairFrac": 1.0,
            "ownOtherConsumableFrac": -1.0,
            "ownEnginePower": 0.5,
            "ownEngineDir": 1.0,
            "ownInSmoke": False,
            "activeSmokeCountFrac": 0.0,
            "activeSmokeAreaFeat": 0.0,
            "visionCapFrac": 1.0,
            "weatherIncomingFrac": 0.0,
            "allyRadarCountFrac": -1.0,
            "allyHydroCountFrac": -1.0,
            "e11EventsKnown": True,
            "labelACanLaunch": a,
            "labelBLaunched": b,
            "ownTorpReloadFrac": 0.5,
            "ownTorpRangeM": 10000.0,
        }
        return row

    # 1. featurizers produce the v2 shapes and the labels censor correctly.
    row = synth(a=True, b=True)
    e, m = tfm.entity_matrix_and_mask(row, FEATURE_VERSION)
    g = tfm.global_vector(row, FEATURE_VERSION)
    assert e.shape == (tfm.SLOTS, tfm.ENTITY_DIM_V2) == (24, 15), e.shape
    assert m.shape == (tfm.SLOTS,)
    assert g.shape == (tfm.GLOBAL_DIM_V2,) == (27,), g.shape
    assert m[0] == 1.0 and m[1] == 0.0, "one enemy slot, no friends -> first slot filled"
    assert e[0, 8] == 1.0, "slot entityType==2 one-hot (still dead-but-present column)"
    a, b, ok = row_labels(synth(a=False, b=None))
    assert (a, math.isnan(b), ok) == (0.0, True, True)
    a, b, ok = row_labels(synth(a=False, b=False))
    assert ok is False, "labelB on a cannot-launch row is inconsistent (censored semantics)"
    a, b, ok = row_labels(synth(a=True, b=None))
    assert (a, math.isnan(b), ok) == (1.0, True, False), "can-launch rows must be labelled"

    # 2. GroupKFold determinism + degradation policy.
    groups = np.array(["a"] * 10 + ["b"] * 5 + ["c"] * 3, dtype=object)
    f1 = tfm.group_kfold_assign(groups, 3)
    f2 = tfm.group_kfold_assign(groups, 3)
    assert np.array_equal(f1, f2)
    assert sorted(set(f1.tolist())) == [0, 1, 2]
    for gname in ("a", "b", "c"):
        assert len(set(f1[groups == gname].tolist())) == 1, "group leaked across folds"
    split = make_split(groups, 5, seed=0)
    assert split["folds"] == 3 and "leave-one-replay-out" in split["mode"], split["mode"]
    split3 = make_split(groups, 3, seed=0)
    assert split3["mode"].startswith("3-fold")
    split1 = make_split(np.array(["only"] * 30, dtype=object), 5, seed=0)
    assert split1["folds"] == 2 and "PIPELINE" in split1["mode"]

    # 3. Metric sanity (perfect ranking -> AUPRC 1; calibrated -> ECE 0).
    y = np.array([1.0, 1.0, 0.0, 0.0])
    p_perfect = np.array([0.9, 0.8, 0.2, 0.1])
    assert tfm.average_precision(y, p_perfect) == 1.0
    assert tfm.roc_auc(y, p_perfect) == 1.0
    ece, _ = tfm.ece_and_reliability(np.array([0.0, 0.0, 1.0, 1.0]), np.array([0.0, 0.0, 1.0, 1.0]))
    assert ece < 1e-9, ece
    dec = tfm.decile_lift(np.array([1.0] * 10 + [0.0] * 90), np.array([0.9] * 10 + [0.1] * 90))
    assert dec["deciles"][0]["lift"] == 10.0, dec["deciles"][0]

    # 4. Loader: file-order budget, CV skip, class mapping, group fallback.
    tmp = root / "rows.jsonl"
    lines = []
    for i in range(6):
        ship = 4183799504 if i == 3 else 1  # CV row -> skipped
        lines.append(json.dumps(synth(ship_id=ship, a=i % 2 == 0, b=None if i % 2 else True, replay=f"r{i % 2}")))
    lines.append("{not json}")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    classes = {1: "Destroyer", 4183799504: "AirCarrier"}
    data = load_torpedo_rows([tmp], max_rows=4, classes=classes)
    assert data["rows"] == 4, data["rows"]
    assert data["skipped_aircarrier"] == 1, data["skipped_aircarrier"]
    assert data["bad_json_rows"] == 0, "bad json row lies beyond the budget"
    assert list(data["class"]).count("AirCarrier") == 0
    assert data["files"][0]["lines"] == 7
    data2 = load_torpedo_rows([tmp], max_rows=0, classes=classes)
    assert data2["rows"] == 5 and data2["bad_json_rows"] == 1, (data2["rows"], data2["bad_json_rows"])
    assert list(data2["class"]).count("AirCarrier") == 0

    # 5. Class + metrics aggregation shapes used by the report.
    pc = per_class_metrics(
        {
            "class": np.array(["Destroyer"] * 40, dtype=object),
            "label_a": np.array([1.0] * 40),
            "label_b": np.array([1.0] * 10 + [0.0] * 30),
        },
        np.linspace(0.9, 0.1, 40),
        np.linspace(0.9, 0.1, 40),
        np.array([True] * 40),
    )
    assert pc["Destroyer"]["rows"] == 40 and pc["Destroyer"]["launched"] == 10
    assert pc["Destroyer"]["auprc_headB"] is not None

    print("PASS")
    return 0


# ── entry point ─────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.selftest:
        return run_selftest()
    metrics = run_training(args)
    if args.metrics_out:
        out = Path(args.metrics_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"[e26] metrics -> {out}")
    print_report(metrics)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
