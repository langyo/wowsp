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
import gc
import hashlib
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
    p.add_argument(
        "--data",
        nargs="+",
        action="append",
        default=[],
        help="torpedo JSONL file(s); accepts several paths per flag and/or repeated flags",
    )
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
    p.add_argument(
        "--eval-batch-size",
        type=int,
        default=0,
        help="validation forward batch (0 = max(batch-size, 8192); full-corpus folds do not fit whole)",
    )
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--label-smoothing", type=float, default=0.05)
    p.add_argument("--folds", type=int, default=5, help="target GroupKFold folds (degraded when fewer replays)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    p.add_argument(
        "--feature-dtype",
        default="float16",
        choices=["float16", "float32"],
        help="entity/mask storage dtype in RAM (default float16 for the full corpus; cast to float32 per training batch)",
    )
    p.add_argument(
        "--feature-set",
        default="core",
        choices=["core", "torp2"],
        help="core = E26c features exactly (global 27); torp2 = +11 derived torpedo-geometry/class dims (global 38)",
    )
    p.add_argument(
        "--pos-weight",
        type=float,
        default=0.0,
        help="secondary ablation only: BCE pos_weight on head B (0 = off, bit-identical to E26c)",
    )
    p.add_argument(
        "--focal-gamma",
        type=float,
        default=0.0,
        help="secondary ablation only: focal-BCE gamma on head B (>0 replaces plain BCE; 0 = off)",
    )
    p.add_argument(
        "--final-fit",
        action="store_true",
        help="T2 delivery mode: train ONE model on ALL rows (no CV) and export ONNX (fp32+int8) + parity vectors",
    )
    p.add_argument(
        "--export-dir",
        default="",
        help="final-fit output dir (default: <repo>/scripts/experiments/out/torpedo_model/final)",
    )
    p.add_argument("--parity-rows", type=int, default=1000, help="final-fit: torch-vs-ORT fp32 parity rows")
    p.add_argument("--parity-vector-rows", type=int, default=200, help="final-fit: rows stored in parity_vectors.json")
    p.add_argument("--int8-eval-rows", type=int, default=100000, help="final-fit: rows for the int8-vs-fp32 metric sample")
    p.add_argument(
        "--save-oof",
        default="",
        help="E26e: save per-row OOF predictions + metadata to this .npz (float32 probs; training unchanged)",
    )
    p.add_argument(
        "--calibrate",
        nargs="?",
        const="",
        default=None,
        metavar="NPZ",
        help="E26e: temperature-calibrate an OOF npz (bare flag uses --save-oof; or pass the npz path)",
    )
    p.add_argument(
        "--calibrate-out",
        default="",
        help="E26e: calibration_metrics.json path (default: next to the OOF npz)",
    )
    p.add_argument(
        "--outcome",
        nargs="+",
        default=[],
        help="E26e-c: 4 outcome sidecar JSONL in --data order (torpFiredFish/torpHits/torpHpLostNearby/torpTerminalNear)",
    )
    p.add_argument(
        "--head-c",
        action="store_true",
        help="E26e-c: add a third head (P(torpHits>0 | launched)) trained ONLY on labelB==1 rows; requires --outcome",
    )
    p.add_argument(
        "--head-c-only",
        action="store_true",
        help="E26e-d: standalone single-head model trained ONLY on launched rows (no shared trunk with headA/B)",
    )
    p.add_argument(
        "--combine-oof",
        action="store_true",
        help="E26e-d: merge a base OOF npz (E26e-a probB) with a standalone headC npz into one combined npz",
    )
    p.add_argument("--combine-base", default="", help="combine-oof: base npz (must carry probB/labelB/rowIndex)")
    p.add_argument("--combine-headc", default="", help="combine-oof: standalone headC npz (--head-c-only --save-oof)")
    p.add_argument("--combine-out", default="", help="combine-oof: output combined npz path")
    p.add_argument("--metrics-out", default=None, help="write the full metrics JSON here")
    p.add_argument("--selftest", action="store_true", help="torch-free unit test of loader/labels/split/metrics")
    return p.parse_args(argv)


def resolve_data_paths(args: argparse.Namespace) -> list[Path]:
    paths: list[Path] = [Path(p) for group in args.data for p in group]
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



def count_corpus_rows(paths: list[Path]) -> tuple[int, list[dict], float]:
    """Pass 1 of the full-corpus loader: count NON-EMPTY lines per file WITHOUT
    JSON parsing, so pass 2 can preallocate exactly (no list/append growth).
    Returns (total non-empty lines, per-file records, seconds)."""
    t0 = time.time()
    total = 0
    files: list[dict] = []
    for path in paths:
        n = 0
        with path.open("rb") as f:
            for line in f:
                if line.strip():
                    n += 1
        total += n
        files.append({"path": str(path), "bytes": path.stat().st_size, "lines": n, "rows_used": 0})
    return total, files, time.time() - t0


def region_of(path: Path) -> str:
    """Dataset region tag from the export file name (dataset_kots_apac_2s -> apac)."""
    for token in path.stem.split("_"):
        if token in ("own", "apac", "eu", "na"):
            return token
    return "unknown"


def array_bytes(*arrs) -> int:
    return int(sum(a.nbytes for a in arrs if a is not None))

# torp2 derived feature block (E26d): geometry + class, computed FROM THE ROW
# alone (no re-export). Order is part of the model input contract.
TORP2_NAMES = [
    "cls_dd",
    "cls_ca",
    "cls_bb",
    "cls_ss",
    "cls_unknown",
    "obs_enemies_frac",
    "in_range_enemies_frac",
    "closest_in_range_frac",
    "in_range_within_45deg_frac",
    "in_range_within_20deg_frac",
    "reload_ready",
]
TORP2_DIM = len(TORP2_NAMES)
# Class one-hot order: DD, (CL+CA), BB, SS, unknown. CV rows never reach the
# loader (the exporter drops them; the loader skips defensively).
CLASS_ONEHOT = {"Destroyer": 0, "Cruiser": 1, "Battleship": 2, "Submarine": 3}


def derive_torp2_extras(row: dict, cls: str) -> list[float]:
    """11 derived dims from the raw row (E26d torp2 feature set).

    Geometry is taken from the SAME exported enemy slots the model sees; only
    observed-now enemies count (stale intel is not a launchable target).
    """
    oh = [0.0, 0.0, 0.0, 0.0, 0.0]
    oh[CLASS_ONEHOT.get(cls, 4)] = 1.0
    own_range = row.get("ownRangeM")
    try:
        own_range = float(own_range) if own_range is not None else 0.0
    except (TypeError, ValueError):
        own_range = 0.0
    enemies = row.get("enemies") or []
    observed = []
    for e in enemies:
        if not e.get("observedNow"):
            continue
        observed.append(e)
    in_range = []
    if own_range > 0.0:
        for e in observed:
            d = e.get("distM")
            if d is not None and float(d) <= own_range:
                in_range.append(e)
    n_obs = min(len(observed), 12)
    n_in = min(len(in_range), 8)
    closest = 0.0
    if in_range and own_range > 0.0:
        dmin = min(float(e["distM"]) for e in in_range)
        closest = min(max(1.0 - dmin / own_range, 0.0), 1.0)
    frac45 = frac20 = 0.0
    if in_range:
        absb = [abs(float(e["bearingRelRad"])) for e in in_range]
        frac45 = sum(1 for b in absb if b <= math.pi / 4.0) / len(absb)
        frac20 = sum(1 for b in absb if b <= math.pi / 9.0) / len(absb)
    reload = row.get("ownReloadFrac")
    ready = 1.0 if (reload is not None and float(reload) >= 0.999) else 0.0
    return oh + [n_obs / 12.0, n_in / 8.0, closest, frac45, frac20, ready]

def load_torpedo_rows(
    paths: list[Path],
    max_rows: int,
    classes: dict[int, str],
    feature_dtype: str = "float16",
    feature_set: str = "core",
) -> dict:
    """Stream the JSONL corpus into featurized arrays.

    Two loader modes:
      * --max-rows > 0 (pilot): single pass preallocated to the budget — the
        historical E26 behaviour (first N rows in file order; later files are
        skipped and reported).
      * --max-rows 0 (full corpus): TWO passes — pass 1 counts non-empty lines
        per file without JSON parsing, pass 2 preallocates EXACTLY and fills.
        There is no list / np.append growth path: the old full-corpus fallback
        was quadratic and unusable at multi-million rows.

    Entity and mask blocks use --feature-dtype (default float16: ~2x smaller, cast
    back to float32 per training batch); the global block stays float32.
    --feature-set torp2 appends TORP2_DIM derived dims to the global block, in place
    (global width becomes 27 + 11 = 38, one preallocated array — no concat copy).
    """
    dtypes = {"float16": np.float16, "float32": np.float32}
    if feature_dtype not in dtypes:
        raise SystemExit(f"[e26] unknown --feature-dtype {feature_dtype!r}")
    if feature_set not in ("core", "torp2"):
        raise SystemExit(f"[e26] unknown --feature-set {feature_set!r}")
    extra_dim = TORP2_DIM if feature_set == "torp2" else 0
    feature_names = [f"global_{i}" for i in range(tfm.GLOBAL_DIM_V2)] + (
        list(TORP2_NAMES) if extra_dim else []
    )
    edt = dtypes[feature_dtype]
    mdt = np.float16 if feature_dtype == "float16" else np.float32
    budget = max_rows if max_rows and max_rows > 0 else None
    two_pass = budget is None
    t0 = time.time()
    count_s = 0.0
    files_skipped: list[str] = []
    if two_pass:
        n_pre, files, count_s = count_corpus_rows(paths)
        print(f"[e26] pass-1: {n_pre:,} non-empty rows across {len(files)} file(s) in {count_s:.1f}s", flush=True)
    else:
        n_pre = int(budget)
        files = [{"path": str(p), "bytes": p.stat().st_size, "lines": None, "rows_used": 0} for p in paths]
    if n_pre <= 0:
        raise SystemExit("[e26] no rows to load")

    # Preallocate exactly (the float16 entity block dominates memory: N*24*15*2 B).
    esize = np.dtype(edt).itemsize
    msize = np.dtype(mdt).itemsize
    Xe = np.zeros((n_pre, tfm.SLOTS, tfm.ENTITY_DIM_V2), dtype=edt)
    Xg = np.zeros((n_pre, tfm.GLOBAL_DIM_V2 + extra_dim), dtype=np.float32)
    Xm = np.zeros((n_pre, tfm.SLOTS), dtype=mdt)
    ya = np.zeros(n_pre, dtype=np.float32)
    yb = np.full(n_pre, np.nan, dtype=np.float32)
    ship_ids = np.full(n_pre, -1, dtype=np.int64)
    gid = np.zeros(n_pre, dtype=np.int32)
    times = np.zeros(n_pre, dtype=np.float32)
    gid_map: dict[str, int] = {}
    regions: list[str] = []
    cls_arr: list[str] = []
    cls_counts: dict[str, int] = {k: 0 for k in CLASS_ORDER}
    file_index = {f["path"]: f for f in files}
    rows = 0
    skipped_cv = 0
    inconsistent = 0
    bad_json = 0
    for path in paths:
        if budget is not None and rows >= budget:
            files_skipped.append(str(path))
            continue
        entry = file_index[str(path)]
        region = region_of(path)
        lines_total = 0
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                lines_total += 1
                if budget is not None and rows >= budget:
                    continue  # keep counting lines for an honest sampling note
                st = line.strip()
                if not st:
                    continue
                try:
                    row = json.loads(st)
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
                if rows >= n_pre:
                    raise SystemExit(f"[e26] {path}: more usable rows than pass-1 counted ({n_pre:,}) — corpus changed mid-run?")
                e, m = tfm.entity_matrix_and_mask(row, FEATURE_VERSION)
                g = tfm.global_vector(row, FEATURE_VERSION)
                Xe[rows] = e
                Xg[rows, : tfm.GLOBAL_DIM_V2] = g
                if extra_dim:
                    Xg[rows, tfm.GLOBAL_DIM_V2 :] = derive_torp2_extras(row, cls)
                Xm[rows] = m
                ya[rows] = a
                yb[rows] = b
                ship_ids[rows] = -1 if ship_id is None else ship_id
                tv = row.get("t")
                times[rows] = float(tv) if tv is not None else -1.0
                gname = str(row.get("replayId") or path.stem)
                gi = gid_map.get(gname)
                if gi is None:
                    gi = len(gid_map)
                    gid_map[gname] = gi
                gid[rows] = gi
                regions.append(region)
                cls_arr.append(cls)
                cls_counts[cls] = cls_counts.get(cls, 0) + 1
                rows += 1
                entry["rows_used"] += 1
        entry["lines"] = lines_total
        entry["region"] = region
    if rows == 0:
        raise SystemExit("[e26] no usable rows loaded")

    def trim(a):
        return a[:rows]

    Xe, Xg, Xm = trim(Xe), trim(Xg), trim(Xm)
    ya, yb, ship_ids, gid, times = trim(ya), trim(yb), trim(ship_ids), trim(gid), trim(times)
    region_arr = np.array(regions, dtype=object)
    region_counts: dict[str, int] = {}
    for reg in regions:
        region_counts[reg] = region_counts.get(reg, 0) + 1
    array_b = array_bytes(Xe, Xg, Xm, ya, yb, ship_ids, gid)
    theoretical = rows * (tfm.SLOTS * tfm.ENTITY_DIM_V2 * esize + tfm.GLOBAL_DIM_V2 * 4 + tfm.SLOTS * msize + 12)
    load_s = time.time() - t0
    return {
        "entity": Xe,
        "global": Xg,
        "mask": Xm,
        "label_a": ya,
        "label_b": yb,
        "ship_id": ship_ids,
        "t": times,
        "group": gid,
        "group_names": list(gid_map.keys()),
        "region": region_arr,
        "region_counts": region_counts,
        "class": np.array(cls_arr, dtype=object),
        "rows": rows,
        "files": files,
        "files_skipped": files_skipped,
        "skipped_aircarrier": skipped_cv,
        "inconsistent_labelb": inconsistent,
        "bad_json_rows": bad_json,
        "class_counts": cls_counts,
        "max_rows": budget,
        "feature_set": feature_set,
        "extra_dim": extra_dim,
        "feature_names": feature_names,
        "loader_mode": "two-pass-full" if two_pass else "single-pass-budget",
        "feature_dtype": feature_dtype,
        "pass1_seconds": round(count_s, 1),
        "load_seconds": round(load_s, 1),
        "array_bytes": array_b,
        "theoretical_bytes": int(theoretical),
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
    device,
    y_c=None,
    c_mask_all=None,
    use_head_c: bool = False,
):
    """Train one fold, return (p_a_val, p_b_val, p_c_val, epoch_losses, seconds).

    E26e-c: with use_head_c the local three-head model additionally trains head C
    (P(torpHits>0 | launched)) on labelB==1 rows only; head A/B losses unchanged.

    Inputs may live in float16 (E26c full-corpus mode) and/or on the GPU;
    each batch is cast to float32 on the model device. Validation runs in
    fixed-size batches because a whole fold's activation tensors do not fit
    on a 15 GB node at multi-million-row scale."""
    nn = torch.nn
    torch.manual_seed(args.seed + fold)
    np.random.seed(args.seed + fold)
    if use_head_c:
        model = build_three_head_model(torch, hidden=args.hidden, entity_dim=entity_dim, global_dim=global_dim)
    else:
        model = tfm.build_model(hidden=args.hidden, entity_dim=entity_dim, global_dim=global_dim)
    model.to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    bce_a = nn.BCEWithLogitsLoss(reduction="none")
    bce_c = nn.BCEWithLogitsLoss(reduction="none")
    pos_weight = getattr(args, "pos_weight", 0.0) or 0.0
    focal_gamma = getattr(args, "focal_gamma", 0.0) or 0.0
    bce_b = nn.BCEWithLogitsLoss(
        reduction="none",
        pos_weight=None if pos_weight <= 0.0 else torch.tensor([pos_weight], device=device),
    )
    eps = args.label_smoothing

    def head_b_loss(logits, target):
        """Head-B elementwise loss: BCE (+ optional pos_weight) with optional
        focal modulation. The reweighting knobs are SECONDARY ablations only;
        both default off, which is bit-identical to E26c."""
        el = bce_smoothed_loss(bce_b, logits, target, eps)
        if focal_gamma > 0.0:
            p = torch.sigmoid(logits)
            pt = torch.where(target > 0.5, p, 1.0 - p)
            el = el * (1.0 - pt).clamp(min=0.0) ** focal_gamma
        return el

    idx_t = torch.from_numpy(train_idx).to(device)
    losses: list[float] = []
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        perm = idx_t[torch.randperm(len(idx_t), device=device)]
        tot, cnt = 0.0, 0
        for st in range(0, len(perm), args.batch_size):
            idx = perm[st : st + args.batch_size]
            xb = entity[idx].to(device, non_blocking=True).float()
            gb = glob[idx].to(device, non_blocking=True).float()
            mb = mask[idx].to(device, non_blocking=True).float()
            if use_head_c:
                la, lb, lc = model(xb, gb, mb)
            else:
                la, lb = model(xb, gb, mb)
            ya_b = y_a[idx].to(device)
            yb_b = y_b[idx].to(device)
            bm = b_mask_all[idx].to(device)
            loss_a = bce_smoothed_loss(bce_a, la, ya_b, eps).mean()
            loss_b = (head_b_loss(lb, yb_b) * bm).sum() / bm.sum().clamp(min=1.0)
            loss = loss_a + loss_b
            if use_head_c:
                yc_b = y_c[idx].to(device)
                cm = c_mask_all[idx].to(device)
                loss_c = (bce_c(lc, yc_b) * cm).sum() / cm.sum().clamp(min=1.0)
                loss = loss + loss_c
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += float(loss.item()) * len(idx)
            cnt += len(idx)
        losses.append(tot / max(cnt, 1))
        log_fn(f"  fold {fold} epoch {epoch + 1}/{args.epochs} loss {losses[-1]:.4f} ({time.time() - t0:.1f}s)")

    model.eval()
    eval_batch = getattr(args, "eval_batch_size", 0) or max(args.batch_size, 8192)
    p_a = np.empty(len(val_idx), dtype=np.float32)
    p_b = np.empty(len(val_idx), dtype=np.float32)
    p_c = np.empty(len(val_idx), dtype=np.float32) if use_head_c else None
    with torch.no_grad():
        for st in range(0, len(val_idx), eval_batch):
            vidx_np = val_idx[st : st + eval_batch]
            vidx = torch.from_numpy(vidx_np).to(device)
            xb = entity[vidx].to(device, non_blocking=True).float()
            gb = glob[vidx].to(device, non_blocking=True).float()
            mb = mask[vidx].to(device, non_blocking=True).float()
            if use_head_c:
                la, lb, lc = model(xb, gb, mb)
            else:
                la, lb = model(xb, gb, mb)
            p_a[st : st + len(vidx_np)] = torch.sigmoid(la).float().cpu().numpy()
            p_b[st : st + len(vidx_np)] = torch.sigmoid(lb).float().cpu().numpy()
            if use_head_c:
                p_c[st : st + len(vidx_np)] = torch.sigmoid(lc).float().cpu().numpy()
    return p_a, p_b, p_c, losses, time.time() - t0


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

def per_region_metrics(data: dict, p_a: np.ndarray, p_b: np.ndarray, b_mask: np.ndarray) -> dict:
    """Descriptive per-region slice (own / apac / eu / na), same shape as per_class."""
    out: dict[str, dict] = {}
    for reg in sorted(set(data["region"].tolist())):
        m = data["region"] == reg
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
        }
        if n >= MIN_CLASS_N:
            entry["auprc_headA"] = _num(tfm.average_precision(data["label_a"][m], p_a[m]))
            mb = m & b_mask
            if int(mb.sum()) >= MIN_CLASS_N and int(np.nansum(data["label_b"][mb])) > 0:
                entry["auprc_headB"] = _num(tfm.average_precision(data["label_b"][mb], p_b[mb]))
        out[reg] = entry
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
    data = load_torpedo_rows(paths, args.max_rows, classes, args.feature_dtype, args.feature_set)
    load_s = time.time() - t0
    log(
        f"[e26] loaded {data['rows']:,} rows from {len(data['files'])} file(s) "
        f"(feature set {data['feature_set']} (+{data['extra_dim']} derived dims), loader {data['loader_mode']}, "
        f"feature dtype {data['feature_dtype']}, pass-1 "
        f"{data['pass1_seconds']:.1f}s; skipped files {len(data['files_skipped'])}, AirCarrier rows "
        f"skipped {data['skipped_aircarrier']}, inconsistent labelB {data['inconsistent_labelb']}, "
        f"bad json {data['bad_json_rows']}) in {load_s:.1f}s"
    )
    log(
        f"[e26] arrays {data['array_bytes'] / 1e9:.2f} GB allocated (theoretical "
        f"{data['theoretical_bytes'] / 1e9:.2f} GB, entity {data['entity'].dtype}, mask "
        f"{data['mask'].dtype}, global {data['global'].dtype})"
    )
    log(f"[e26] class counts: {json.dumps(data['class_counts'], ensure_ascii=False)}")
    log(f"[e26] region counts: {json.dumps(data['region_counts'], ensure_ascii=False)}")

    outcome = None
    if args.outcome:
        outcome = load_outcome_sidecars(paths, [Path(p) for p in args.outcome], data, log)
    if args.head_c and outcome is None:
        raise SystemExit("[e26] --head-c requires --outcome (4 sidecar JSONL in --data order)")
    label_c_np = None
    c_mask_np = None
    if args.head_c:
        label_c_np = (outcome["hits"] > 0).astype(np.float32)
        c_mask_np = (data["label_b"] == 1.0) & (outcome["fired"] >= 1)
        log("[e26] headC: launched rows " + format(int(c_mask_np.sum()), ",") +
            " / positives " + format(int(label_c_np[c_mask_np].sum()), ",") +
            " (hit rate " + format(float(label_c_np[c_mask_np].mean()), ".4f") + ")" +
            "; labelB==1 but fired==0: " + str(outcome["quality"]["launchedWithZeroFiredFish"]))

    entity = torch.from_numpy(data["entity"])
    glob = torch.from_numpy(data["global"])
    mask = torch.from_numpy(data["mask"])
    y_a = torch.from_numpy(data["label_a"])
    y_b = torch.from_numpy(np.nan_to_num(data["label_b"], nan=0.0))
    b_mask_np = (data["label_a"] == 1.0) & np.isfinite(data["label_b"])
    b_mask = torch.from_numpy(b_mask_np.astype(np.float32))
    # headC tensors only exist on the --head-c path; train_fold receives None
    # otherwise (the no-flag path must stay bit-compatible with E26e-a).
    y_c = None
    c_mask = None
    if args.head_c:
        y_c = torch.from_numpy(label_c_np)
        c_mask = torch.from_numpy(c_mask_np.astype(np.float32))
    if device.type == "cuda":
        # Move the whole corpus once (float16 entity keeps this ~2 GB) and free the
        # host copies; batches are cast to float32 on the GPU per step.
        entity = entity.to(device)
        glob = glob.to(device)
        mask = mask.to(device)
        y_a = y_a.to(device)
        y_b = y_b.to(device)
        b_mask = b_mask.to(device)
        if args.head_c:
            y_c = y_c.to(device)
            c_mask = c_mask.to(device)
        # Free the host copies of the big arrays only — labels/classes/regions stay
        # on the host because the OOF metrics and per-class slices read them.
        data["entity"] = None
        data["global"] = None
        data["mask"] = None
        gc.collect()
    log(
        f"[e26] tensors on {device}: entity {entity.numel() * entity.element_size() / 1e9:.2f} GB "
        f"{entity.dtype}, global {glob.numel() * glob.element_size() / 1e9:.2f} GB, "
        f"mask {mask.numel() * mask.element_size() / 1e9:.2f} GB"
    )
    if device.type == "cuda":
        free_b, total_b = torch.cuda.mem_get_info()
        log(f"[e26] cuda mem after load: free {free_b / 1e9:.1f} GB / total {total_b / 1e9:.1f} GB")
    entity_dim = tfm.ENTITY_DIM_V2
    global_dim = int(glob.shape[1])
    log(f"[e26] feature names ({global_dim}): {', '.join(data['feature_names'])}")

    split = make_split(data["group"], args.folds, args.seed)
    fold = split["fold"]
    log(f"[e26] split: {split['mode']} ({split['n_groups']} replays)")

    n = data["rows"]
    p_a = np.full(n, np.nan, dtype=np.float64)
    p_b = np.full(n, np.nan, dtype=np.float64)
    p_c = np.full(n, np.nan, dtype=np.float64) if args.head_c else None
    fold_reports: list[dict] = []
    epoch_losses_all: list[list[float]] = []
    for f in range(split["folds"]):
        val_idx = np.flatnonzero(fold == f)
        train_idx = np.flatnonzero(fold != f)
        if len(val_idx) == 0 or len(train_idx) == 0:
            continue  # fold 1 of the single-replay path with tiny data
        log(f"[e26] fold {f}: train {len(train_idx):,} / val {len(val_idx):,}")
        fa, fb, fc, losses, secs = train_fold(
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
            device=args._device_torch,
            y_c=y_c,
            c_mask_all=c_mask,
            use_head_c=args.head_c,
        )
        p_a[val_idx] = fa
        p_b[val_idx] = fb
        if args.head_c:
            p_c[val_idx] = fc
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
                **(
                    {"headC": head_b_metrics(label_c_np[va][c_mask_np[va]], p_c[va][c_mask_np[va]])}
                    if args.head_c
                    else {}
                ),
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
    if args.head_c:
        oof["headC"] = head_b_metrics(
            label_c_np[scored][c_mask_np[scored]], p_c[scored][c_mask_np[scored]]
        )
    baselines = no_skill_baselines(data["label_b"][b_mask_np])
    per_class = per_class_metrics(data, p_a, p_b, b_mask_np)
    per_region = per_region_metrics(data, p_a, p_b, b_mask_np)
    per_class_c: dict = {}
    per_region_c: dict = {}
    if args.head_c:
        for cls in sorted(set(data["class"][c_mask_np].tolist())):
            m = c_mask_np & (data["class"] == cls)
            per_class_c[cls] = (
                head_b_metrics(label_c_np[m], p_c[m])
                if int(m.sum()) >= MIN_CLASS_N
                else {"rows": int(m.sum()), "insufficient": True}
            )
        for reg in sorted(set(data["region"][c_mask_np].tolist())):
            m = c_mask_np & (data["region"] == reg)
            per_region_c[reg] = (
                head_b_metrics(label_c_np[m], p_c[m])
                if int(m.sum()) >= MIN_CLASS_N
                else {"rows": int(m.sum()), "insufficient": True}
            )

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
            "loader_mode": data["loader_mode"],
            "feature_dtype": data["feature_dtype"],
            "feature_set": data["feature_set"],
            "extra_dim": data["extra_dim"],
            "feature_names": data["feature_names"],
            "reweight_head": "B",
            "pos_weight": args.pos_weight,
            "focal_gamma": args.focal_gamma,
            "head_c": bool(args.head_c),
            "outcome_sidecars": [str(p) for p in args.outcome],
            "loss_weights": {"A": 1.0, "B": 1.0, "C": 1.0 if args.head_c else 0.0},
            "pass1_seconds": data["pass1_seconds"],
            "array_bytes": data["array_bytes"],
            "theoretical_bytes": data["theoretical_bytes"],
            "sampling": "first N rows in file order (pilot budget); files after the budget are skipped"
            if data["max_rows"]
            else "FULL corpus: two-pass exact preallocation (no sampling)",
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
            "region_counts": data["region_counts"],
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
        "outcome": outcome["quality"] if outcome is not None else None,
        "split": {
            "mode": split["mode"],
            "folds": split["folds"],
            "replays": split["n_groups"],
            "fold_sizes": [int((fold == f).sum()) for f in range(split["folds"])],
        },
        "metrics_oof_pooled": oof,
        "baselines_headB": baselines,
        "per_class": per_class,
        "per_region": per_region,
        "per_class_headC": per_class_c,
        "per_region_headC": per_region_c,
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
    if args.head_c:
        metrics["calibration_class"] = {
            "note": "E26e-c secondary: global + per-class temperature scaling (descriptive)",
            "e26e_a_headB_global_T_reference": 0.7586,
            "headB": class_temperature_report(
                p_b[b_mask_np], data["label_b"][b_mask_np], data["class"][b_mask_np]
            ),
            "headC": class_temperature_report(
                p_c[c_mask_np], label_c_np[c_mask_np], data["class"][c_mask_np]
            ),
        }
    if args.save_oof:
        metrics["protocol"]["save_oof"] = str(args.save_oof)
        metrics["protocol"]["save_oof_summary"] = save_oof_npz(
            Path(args.save_oof), data, p_a, p_b, fold, split, args,
            p_c=p_c if args.head_c else None,
            label_c=label_c_np if args.head_c else None,
        )
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
    if "headC" in oof:
        c = oof["headC"]
        print(f"headC OOF (launched rows): AUPRC {c['auprc']} AUC {c['roc_auc']} logloss {c['logloss']} "
              f"ECE {c['ece_15bin']} (base {c['baseRate']}, top-decile lift {c['topDecile']['lift']})")
        cc = metrics.get("calibration_class", {}).get("headC", {}).get("global")
        if cc:
            print(f"headC class-global T {cc['temperature']}: logloss "
                  f"{cc['before']['logloss']} -> {cc['after']['logloss']}, ECE "
                  f"{cc['before']['ece_15bin']} -> {cc['after']['ece_15bin']}")
    bl = metrics["baselines_headB"]
    if bl:
        print(f"baseline no-skill AUPRC {bl['noSkill']['auprc']} logloss {bl['noSkill']['logloss']}; "
              f"labelA-rule AUPRC {bl['labelARule']['auprc']} logloss {bl['labelARule']['logloss']}")
    print("\nper class:")
    for cls, e in metrics["per_class"].items():
        print(f"  {CLASS_LABEL.get(cls, cls):7s} rows {e['rows']:7,} canLaunch {e['canLaunch']:7,} "
              f"launched {e['launched']:6,} posRate {e['positiveRate']} "
              f"AUPRC-A {e['auprc_headA']} AUPRC-B {e['auprc_headB']}")
    print("\nper region:")
    for reg, e in metrics.get("per_region", {}).items():
        print(f"  {reg:7s} rows {e['rows']:8,} canLaunch {e['canLaunch']:8,} "
              f"launched {e['launched']:6,} posRate {e['positiveRate']} "
              f"AUPRC-A {e['auprc_headA']} AUPRC-B {e['auprc_headB']}")
    acc = metrics["acceptance"]
    print(f"\nacceptance: {acc['rule']}")
    print(f"  AUPRC {acc['headB_auprc']} = {acc['headB_auprc_multiple']}x base -> {acc['pass_auprc']}; "
          f"top-decile lift {acc['topDecileLift']} -> {acc['pass_lift']}; VERDICT {acc['verdict'].upper()}")
    print(f"total train seconds {metrics['training']['total_seconds']}")


# ── E26e-a: OOF dump + temperature calibration ──────────────────────────────

OOF_NPZ_VERSION = 1


def oof_arrays(data: dict, p_a: np.ndarray, p_b: np.ndarray, fold: np.ndarray,
               p_c: np.ndarray = None, label_c: np.ndarray = None) -> dict:
    """Compact per-row OOF payload (E26e). Probabilities stay float32; class and
    region are int8 codes with the name tables alongside, so one npz carries
    everything the calibration pass needs (no retraining, no row parsing)."""
    class_names = sorted(set(data["class"].tolist()))
    class_code = {name: i for i, name in enumerate(class_names)}
    region_names = sorted(set(data["region"].tolist()))
    region_code = {name: i for i, name in enumerate(region_names)}
    payload = {
        "probA": np.asarray(p_a, dtype=np.float32),
        "probB": np.asarray(p_b, dtype=np.float32),
        "labelA": np.asarray(data["label_a"], dtype=np.float32),
        "labelB": np.asarray(data["label_b"], dtype=np.float32),
        "fold": np.asarray(fold, dtype=np.int8),
        "rowIndex": np.arange(data["rows"], dtype=np.int32),
        "shipId": np.asarray(data["ship_id"], dtype=np.int64),
        "t": np.asarray(data["t"], dtype=np.float32),
        "classCode": np.array([class_code[str(c)] for c in data["class"]], dtype=np.int8),
        "classNames": np.array(class_names, dtype="U16"),
        "regionCode": np.array([region_code[str(r)] for r in data["region"]], dtype=np.int8),
        "regionNames": np.array(region_names, dtype="U16"),
        "groupCode": np.asarray(data["group"], dtype=np.int32),
        "groupNames": np.array(data["group_names"], dtype="U128"),
    }
    if p_c is not None:
        payload["probC"] = np.asarray(p_c, dtype=np.float32)
    if label_c is not None:
        payload["labelC"] = np.asarray(label_c, dtype=np.float32)
    return payload


def save_oof_npz(path: Path, data: dict, p_a: np.ndarray, p_b: np.ndarray, fold: np.ndarray, split: dict, args,
                 p_c: np.ndarray = None, label_c: np.ndarray = None) -> dict:
    """Write the OOF payload (compressed). Returns a small summary dict."""
    payload = oof_arrays(data, p_a, p_b, fold, p_c=p_c, label_c=label_c)
    payload["meta"] = np.array(json.dumps({
        "version": OOF_NPZ_VERSION,
        "rows": data["rows"],
        "scored": int(np.isfinite(p_a).sum()),
        "feature_version": FEATURE_VERSION,
        "feature_set": data["feature_set"],
        "extra_dim": data["extra_dim"],
        "folds": split["folds"],
        "split_mode": split["mode"],
        "seed": args.seed,
        "hidden": args.hidden,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "label_smoothing": args.label_smoothing,
        "replays": split["n_groups"],
        "class_counts": data["class_counts"],
        "region_counts": data["region_counts"],
        "head_c": bool(p_c is not None),
    }), dtype="U2048")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **payload)
    summary = {"path": str(path), "bytes": path.stat().st_size, "rows": data["rows"], "arrays": sorted(payload)}
    print(f"[e26] OOF npz -> {path} ({path.stat().st_size:,} bytes, {data['rows']:,} rows)", flush=True)
    return summary


CALIB_EPS = 1e-7


def _probs_to_logits(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=np.float64), CALIB_EPS, 1.0 - CALIB_EPS)
    return np.log(p) - np.log1p(-p)


def temperature_nll(z: np.ndarray, y: np.ndarray, T: float) -> float:
    """Mean BCE of sigmoid(z / T) against y (stable form)."""
    zz = z / T
    return float(np.mean(np.logaddexp(0.0, zz) - y * zz))


def fit_temperature(p: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    """Fit a single temperature T minimizing BCE on probs p (monotone).
    Grid over log T then ternary refinement (no scipy dependency).
    Returns (T, nll_before, nll_after)."""
    z = _probs_to_logits(p)
    y = np.asarray(y, dtype=np.float64)
    best_T, best = 1.0, temperature_nll(z, y, 1.0)
    grid = np.exp(np.linspace(np.log(0.02), np.log(50.0), 481))
    losses = np.array([temperature_nll(z, y, t) for t in grid])
    i = int(np.argmin(losses))
    if losses[i] < best:
        best_T, best = float(grid[i]), float(losses[i])
    lo = float(grid[max(i - 1, 0)])
    hi = float(grid[min(i + 1, len(grid) - 1)])
    for _ in range(80):
        m1 = lo + (hi - lo) / 3.0
        m2 = hi - (hi - lo) / 3.0
        if temperature_nll(z, y, m1) < temperature_nll(z, y, m2):
            hi = m2
        else:
            lo = m1
    T = 0.5 * (lo + hi)
    if temperature_nll(z, y, T) < best:
        best_T, best = float(T), float(temperature_nll(z, y, T))
    return best_T, temperature_nll(z, y, 1.0), best


def apply_temperature(p: np.ndarray, T: float) -> np.ndarray:
    z = _probs_to_logits(p)
    return 1.0 / (1.0 + np.exp(-z / T))


def class_temperature_report(p: np.ndarray, y: np.ndarray, classes: np.ndarray,
                             min_n: int = 30) -> dict:
    """E26e-c secondary: fit one global T and one T per ship class (DD/CL/CA/BB/SS)
    on the given rows; report logloss/Brier/ECE before/after. Descriptive only."""
    p = np.asarray(p, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    out = {"rows": int(len(y)), "positives": int(y.sum())}
    if len(y) >= min_n:
        T, nll0, nll1 = fit_temperature(p, y)
        p_cal = apply_temperature(p, T)
        out["global"] = {
            "temperature": _num(T),
            "before": _calibration_metrics(y, p),
            "after": _calibration_metrics(y, p_cal),
        }
    else:
        out["global"] = None
    per_class = {}
    for cls in sorted(set(np.asarray(classes, dtype=object).tolist())):
        m = np.asarray([c == cls for c in classes], dtype=bool)
        n = int(m.sum())
        if n < min_n:
            per_class[str(cls)] = {"rows": n, "insufficient": True}
            continue
        T, nll0, nll1 = fit_temperature(p[m], y[m])
        p_cal = apply_temperature(p[m], T)
        per_class[str(cls)] = {
            "rows": n,
            "positives": int(y[m].sum()),
            "temperature": _num(T),
            "before": _calibration_metrics(y[m], p[m]),
            "after": _calibration_metrics(y[m], p_cal),
        }
    out["per_class"] = per_class
    return out


def _calibration_metrics(y: np.ndarray, p: np.ndarray) -> dict:
    return {
        "rows": int(len(y)),
        "positives": int(np.sum(y)),
        "positiveRate": _num(float(np.mean(y))) if len(y) else None,
        "auprc": _num(tfm.average_precision(y, p)) if len(y) else None,
        "roc_auc": _num(tfm.roc_auc(y, p)),
        "logloss": _num(tfm.log_loss(y, p)),
        "brier": _num(tfm.brier_score(y, p)),
        "ece_15bin": _num(tfm.ece_and_reliability(y, p)[0]),
    }


def _calibration_slice(y: np.ndarray, p: np.ndarray, mask: np.ndarray) -> dict:
    if int(mask.sum()) == 0:
        return None
    return _calibration_metrics(y[mask], p[mask])


def run_calibration(args: argparse.Namespace) -> int:
    """Load an OOF npz, fit temperature scaling (head B on canLaunch rows; head A
    on all rows as reference), and write before/after calibration metrics."""
    npz_arg = args.calibrate if isinstance(args.calibrate, str) and args.calibrate else args.save_oof
    if not npz_arg:
        raise SystemExit("[e26] --calibrate needs an npz: pass the path or --save-oof")
    npz_path = Path(npz_arg)
    if not npz_path.exists():
        raise SystemExit(f"[e26] OOF npz not found: {npz_path}")
    log = lambda s: print(s, flush=True)  # noqa: E731
    log(f"[e26] calibration input: {npz_path}")
    z = np.load(npz_path, allow_pickle=False)
    probA = z["probA"].astype(np.float64)
    probB = z["probB"].astype(np.float64)
    labelA = z["labelA"].astype(np.float64)
    labelB = z["labelB"].astype(np.float64)
    fold = z["fold"]
    classCode = z["classCode"]
    classNames = [str(x) for x in z["classNames"].tolist()]
    regionCode = z["regionCode"]
    regionNames = [str(x) for x in z["regionNames"].tolist()]
    meta = json.loads(str(z["meta"].tolist()))
    scored = np.isfinite(probA)
    can = scored & (labelA == 1.0) & np.isfinite(labelB)
    log(f"[e26] OOF rows {len(probA):,} scored {int(scored.sum()):,} can {int(can.sum()):,} "
        f"launched {int(np.nansum(labelB[can])):,}")

    # ── head B: canLaunch rows only (the hypothesis under test) ─────────────
    yb = labelB[can]
    pb = probB[can]
    T_b, nll_before, nll_after = fit_temperature(pb, yb)
    pb_cal = apply_temperature(pb, T_b)
    b_before = _calibration_metrics(yb, pb)
    b_after = _calibration_metrics(yb, pb_cal)
    base_rate = float(np.mean(yb))
    const_p = np.full(len(yb), base_rate)
    constant = {
        "positiveRate": _num(base_rate),
        "logloss": _num(tfm.log_loss(yb, const_p)),
        "brier": _num(tfm.brier_score(yb, const_p)),
    }
    prereg = {"logloss": 0.08289, "brier": 0.01594}  # E26e-a pre-registration (E26c/E26d OOF constants)
    log(f"[e26] headB temperature T = {T_b:.4f} (BCE {nll_before:.6f} -> {nll_after:.6f})")
    log(f"[e26] headB logloss {b_before['logloss']} -> {b_after['logloss']}; "
        f"brier {b_before['brier']} -> {b_after['brier']}; "
        f"ECE {b_before['ece_15bin']} -> {b_after['ece_15bin']}; "
        f"AUPRC {b_before['auprc']} -> {b_after['auprc']} (must be equal)")

    # ── head A reference temperature (all rows) ─────────────────────────────
    ya = labelA[scored]
    pa = probA[scored]
    T_a, nll_a_before, nll_a_after = fit_temperature(pa, ya)
    pa_cal = apply_temperature(pa, T_a)
    a_before = _calibration_metrics(ya, pa)
    a_after = _calibration_metrics(ya, pa_cal)
    log(f"[e26] headA reference T = {T_a:.4f} (BCE {nll_a_before:.6f} -> {nll_a_after:.6f})")

    # ── per-class / per-region (head B on can rows) ─────────────────────────
    per_class = {}
    for code, name in enumerate(classNames):
        m = can & (classCode == code)
        row = {
            "rows": int(m.sum()),
            "canLaunch": int((m & (labelA == 1.0)).sum()),
            "launched": int(np.nansum(labelB[m])),
            "before": _calibration_slice(yb, pb, m[can]),
            "after": _calibration_slice(yb, pb_cal, m[can]),
        }
        per_class[name] = row
    per_region = {}
    for code, name in enumerate(regionNames):
        m = can & (regionCode == code)
        per_region[name] = {
            "rows": int(m.sum()),
            "launched": int(np.nansum(labelB[m])),
            "before": _calibration_slice(yb, pb, m[can]),
            "after": _calibration_slice(yb, pb_cal, m[can]),
        }

    rank_ok = {
        "auprc_delta": _num(abs(b_before["auprc"] - b_after["auprc"])),
        "auc_delta": _num(abs(b_before["roc_auc"] - b_after["roc_auc"])),
        "monotone_by_construction": True,
    }
    pass_logloss = bool(b_after["logloss"] is not None and b_after["logloss"] < prereg["logloss"])
    pass_brier = bool(b_after["brier"] is not None and b_after["brier"] < prereg["brier"])
    metrics = {
        "_lineage": "E26e-a torpedo OOF temperature calibration (no retraining)",
        "protocol": {
            "oof_npz": str(npz_path),
            "rows": int(len(probA)),
            "scored": int(scored.sum()),
            "canLaunch": int(can.sum()),
            "launched": int(np.nansum(labelB[can])),
            "temperature_fit": "single T per head, grid (log T in [0.02, 50]) + ternary refinement, minimizing BCE",
            "eps": CALIB_EPS,
            "meta": meta,
        },
        "temperature": {"headB": _num(T_b), "headA_reference": _num(T_a)},
        "headB": {
            "before": b_before,
            "after": b_after,
            "delta": {
                "logloss": _num(b_after["logloss"] - b_before["logloss"]),
                "brier": _num(b_after["brier"] - b_before["brier"]),
                "ece_15bin": _num(b_after["ece_15bin"] - b_before["ece_15bin"]),
                "auprc": _num(b_after["auprc"] - b_before["auprc"]),
                "roc_auc": _num(b_after["roc_auc"] - b_before["roc_auc"]),
            },
        },
        "baselines_headB": {
            "constant_rate": constant,
            "pre_registered": prereg,
        },
        "acceptance": {
            "rule": "headB calibrated OOF logloss < 0.08289 AND Brier < 0.01594 (E26e-a pre-registration)",
            "logloss_below": pass_logloss,
            "brier_below": pass_brier,
            "verdict": "pass" if (pass_logloss and pass_brier) else "fail",
        },
        "rank_invariance": rank_ok,
        "per_class": per_class,
        "per_region": per_region,
        "headA_reference": {"before": a_before, "after": a_after, "temperature": _num(T_a)},
    }
    out = Path(args.calibrate_out) if args.calibrate_out else npz_path.parent / "calibration_metrics.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(metrics, indent=1, ensure_ascii=False), encoding="utf-8")
    log(f"[e26] calibration metrics -> {out}")
    log(f"[e26] verdict: {metrics['acceptance']['verdict'].upper()} "
        f"(logloss {metrics['headB']['after']['logloss']} vs prereg {prereg['logloss']}; "
        f"brier {metrics['headB']['after']['brier']} vs prereg {prereg['brier']})")
    return 0



# ── E26e-c: outcome sidecar loading (row-aligned) ───────────────────────────

OUTCOME_FIELD_ALIASES = {
    "replayId": ("replayId", "replay_id"),
    "t": ("t", "time"),
    "shipId": ("shipId", "ship_id"),
    "fired": ("torpFiredFish", "torp_fired_fish", "firedFish"),
    "hits": ("torpHits", "torp_hits", "hits"),
    "hp": ("torpHpLostNearby", "torp_hp_lost_nearby", "hpLostNearby"),
    "terminalNear": ("torpTerminalNear", "torp_terminal_near", "terminalNear"),
}


def _pick_outcome_field(row: dict, key: str):
    for name in OUTCOME_FIELD_ALIASES[key]:
        if name in row:
            return row[name]
    return None


def load_outcome_sidecars(paths: list, sidecar_paths: list, data: dict, log_fn) -> dict:
    """Stream 4 outcome sidecars in --data order and validate row alignment.

    Row i of the concatenated sidecars must match data row i by
    replayId/t(+/-1e-3)/shipId; counts must be equal. Returns per-row outcome
    arrays + quality counters. Without --outcome the training path is untouched."""
    if not sidecar_paths:
        raise SystemExit("[e26] --outcome needs at least one sidecar (4 for the full corpus, in --data order)")
    if len(sidecar_paths) > 1 and len(sidecar_paths) != 4:
        raise SystemExit("[e26] --outcome accepts 1 (single-shard/P0) or 4 (apac,eu,na,own in --data order) sidecars")
    n = data["rows"]
    fired = np.zeros(n, dtype=np.int32)
    hits = np.zeros(n, dtype=np.int32)
    hp = np.zeros(n, dtype=np.float32)
    terminal = np.zeros(n, dtype=np.int32)
    bad_replay = bad_t = bad_ship = missing = 0
    pos = 0
    per_shard = []
    for path in sidecar_paths:
        rows_here = 0
        with Path(path).open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if pos >= n:
                    raise SystemExit("[e26] outcome sidecar has more rows than the dataset (" + str(n) + "); check --outcome order")
                row = json.loads(line)
                rows_here += 1
                rid = _pick_outcome_field(row, "replayId")
                tv = _pick_outcome_field(row, "t")
                sid = _pick_outcome_field(row, "shipId")
                expect_replay = data["group_names"][int(data["group"][pos])]
                ok = True
                if rid is None or str(rid) != expect_replay:
                    bad_replay += 1
                    ok = False
                if tv is None or not np.isfinite(float(tv)) or abs(float(tv) - float(data["t"][pos])) > 1e-3:
                    bad_t += 1
                    ok = False
                if sid is None or int(sid) != int(data["ship_id"][pos]):
                    bad_ship += 1
                    ok = False
                fv = _pick_outcome_field(row, "fired")
                hv = _pick_outcome_field(row, "hits")
                if fv is None or hv is None:
                    missing += 1
                    ok = False
                if ok:
                    fired[pos] = int(fv)
                    hits[pos] = int(hv)
                    pv = _pick_outcome_field(row, "hp")
                    hp[pos] = float(pv) if pv is not None else 0.0
                    tn = _pick_outcome_field(row, "terminalNear")
                    terminal[pos] = int(tn) if tn is not None else 0
                pos += 1
        per_shard.append({"path": str(path), "rows": rows_here})
    if pos != n:
        raise SystemExit("[e26] outcome sidecar rows " + str(pos) + " != dataset rows " + str(n) + "; check --outcome order")
    launched = data["label_b"] == 1.0
    quality = {
        "rows": int(n),
        "launchedRows": int(launched.sum()),
        "launchedWithZeroFiredFish": int(np.sum(launched & (fired == 0))),
        "hitsAmongLaunched": int(np.sum(hits[launched])),
        "firedFishAmongLaunched": int(np.sum(fired[launched])),
        "terminalNearPositiveRows": int(np.sum(terminal > 0)),
        "mismatchReplay": int(bad_replay),
        "mismatchT": int(bad_t),
        "mismatchShip": int(bad_ship),
        "missingOutcomeFields": int(missing),
        "perShard": per_shard,
    }
    log_fn("[e26] outcome sidecars joined: " + json.dumps(quality, ensure_ascii=False))
    if bad_replay or bad_t or bad_ship or missing:
        log_fn("[e26] WARNING: outcome misalignment counters non-zero — inspect before trusting headC")
    return {"fired": fired, "hits": hits, "hp": hp, "terminalNear": terminal, "quality": quality}


def build_three_head_model(torch, hidden: int, entity_dim: int, global_dim: int):
    """E26e-c three-head variant of the E26 TwoHeadDeepSets (copied locally so
    train_fire_model.py stays untouched). Only head C output is new."""
    import torch.nn as nn

    class ThreeHeadDeepSets(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.phi = nn.Sequential(
                nn.Linear(entity_dim, hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden),
                nn.ReLU(),
            )
            self.ctx1 = nn.Linear(hidden + global_dim, hidden)
            self.ctx2 = nn.Linear(hidden, hidden)
            self.head_a = nn.Linear(hidden, 1)
            self.head_b = nn.Linear(hidden, 1)
            self.head_c = nn.Linear(hidden, 1)  # E26e-c: P(hit | launched)

        def forward(self, entity, global_feat, mask):
            h = self.phi(entity)
            g = global_feat.unsqueeze(1).expand(-1, h.size(1), -1)
            h = torch.relu(self.ctx1(torch.cat([h, g], dim=-1)))
            h = torch.relu(self.ctx2(h))
            m = mask.unsqueeze(-1)
            agg = (h * m).sum(dim=1) / mask.sum(dim=1, keepdim=True).clamp(min=1.0)
            return (
                self.head_a(agg).squeeze(-1),
                self.head_b(agg).squeeze(-1),
                self.head_c(agg).squeeze(-1),
            )

    return ThreeHeadDeepSets()




# ── E26e-d: standalone outcome head (no shared trunk) + OOF merge ───────────


def build_headc_only_model(torch, hidden: int, entity_dim: int, global_dim: int):
    """Standalone DeepSets + single head C (same trunk shape as E26 TwoHead,
    but no headA/headB and no shared training signal)."""
    import torch.nn as nn

    class HeadCDeepSets(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.phi = nn.Sequential(
                nn.Linear(entity_dim, hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden),
                nn.ReLU(),
            )
            self.ctx1 = nn.Linear(hidden + global_dim, hidden)
            self.ctx2 = nn.Linear(hidden, hidden)
            self.head_c = nn.Linear(hidden, 1)

        def forward(self, entity, global_feat, mask):
            h = self.phi(entity)
            g = global_feat.unsqueeze(1).expand(-1, h.size(1), -1)
            h = torch.relu(self.ctx1(torch.cat([h, g], dim=-1)))
            h = torch.relu(self.ctx2(h))
            m = mask.unsqueeze(-1)
            agg = (h * m).sum(dim=1) / mask.sum(dim=1, keepdim=True).clamp(min=1.0)
            return self.head_c(agg).squeeze(-1)

    return HeadCDeepSets()


def _standalone_oof_npz(path: Path, data: dict, p_c: np.ndarray, label_c: np.ndarray,
                        fold: np.ndarray, split: dict, args, metrics: dict) -> dict:
    """Write the standalone headC OOF npz (probC valid on launched rows only)."""
    class_names = sorted(set(data["class"].tolist()))
    class_code = {name: i for i, name in enumerate(class_names)}
    region_names = sorted(set(data["region"].tolist()))
    region_code = {name: i for i, name in enumerate(region_names)}
    payload = {
        "probC": np.asarray(p_c, dtype=np.float32),
        "labelC": np.asarray(label_c, dtype=np.float32),
        "labelA": np.asarray(data["label_a"], dtype=np.float32),
        "labelB": np.asarray(data["label_b"], dtype=np.float32),
        "fold": np.asarray(fold, dtype=np.int8),
        "rowIndex": np.arange(data["rows"], dtype=np.int32),
        "shipId": np.asarray(data["ship_id"], dtype=np.int64),
        "t": np.asarray(data["t"], dtype=np.float32),
        "classCode": np.array([class_code[str(c)] for c in data["class"]], dtype=np.int8),
        "classNames": np.array(class_names, dtype="U16"),
        "regionCode": np.array([region_code[str(r)] for r in data["region"]], dtype=np.int8),
        "regionNames": np.array(region_names, dtype="U16"),
        "groupCode": np.asarray(data["group"], dtype=np.int32),
        "groupNames": np.array(data["group_names"], dtype="U128"),
    }
    payload["meta"] = np.array(json.dumps({
        "version": OOF_NPZ_VERSION,
        "model": "headc-standalone",
        "rows": data["rows"],
        "launchedRows": int(np.sum(np.isfinite(p_c))),
        "feature_version": FEATURE_VERSION,
        "feature_set": data["feature_set"],
        "extra_dim": data["extra_dim"],
        "folds": split["folds"],
        "split_mode": split["mode"],
        "seed": args.seed,
        "hidden": args.hidden,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "label_smoothing": args.label_smoothing,
        "replays": split["n_groups"],
        "class_counts": data["class_counts"],
        "region_counts": data["region_counts"],
        "oof": metrics,
    }), dtype="U8192")
    np.savez_compressed(path, **payload)
    return {"path": str(path), "bytes": path.stat().st_size, "rows": data["rows"],
            "launchedRows": int(np.sum(np.isfinite(p_c)))}


def run_headc_only(args: argparse.Namespace) -> dict:
    """E26e-d: train a standalone headC on launched rows only (no headA/B), 5-fold
    OOF, then save probC + metadata for joint evaluation with E26e-a probB."""
    import torch

    if args.device == "cuda":
        if not torch.cuda.is_available():
            raise SystemExit("[e26] --device cuda requested but torch reports no CUDA")
        device = torch.device("cuda")
    elif args.device == "cpu" or not torch.cuda.is_available():
        device = torch.device("cpu")
    else:
        device = torch.device("cuda")
    torch.set_num_threads(max(1, torch.get_num_threads()))
    log = lambda s: print(s, flush=True)  # noqa: E731
    log(f"[e26] HEAD-C ONLY on {device} (torch {torch.__version__})")
    if not args.outcome:
        raise SystemExit("[e26] --head-c-only requires --outcome (4 sidecar JSONL in --data order)")
    classes, class_pack_version = load_ship_classes(Path(args.ship_classes))
    paths = resolve_data_paths(args)
    t0 = time.time()
    data = load_torpedo_rows(paths, args.max_rows, classes, args.feature_dtype, args.feature_set)
    log(f"[e26] loaded {data['rows']:,} rows in {time.time() - t0:.1f}s (arrays {data['array_bytes'] / 1e9:.2f} GB)")
    outcome = load_outcome_sidecars(paths, [Path(p) for p in args.outcome], data, log)
    label_c_np = (outcome["hits"] > 0).astype(np.float32)
    c_mask_np = (data["label_b"] == 1.0) & (outcome["fired"] >= 1)
    n_launched = int(c_mask_np.sum())
    n_pos = int(label_c_np[c_mask_np].sum())
    log(f"[e26] launched rows {n_launched:,} / positives {n_pos:,} "
        f"(row hit rate {float(label_c_np[c_mask_np].mean()):.4f}); "
        f"labelB=1 but fired=0: {outcome['quality']['launchedWithZeroFiredFish']}")
    if n_launched == 0:
        raise SystemExit("[e26] no launched rows for --head-c-only")

    entity = torch.from_numpy(data["entity"])
    glob = torch.from_numpy(data["global"])
    mask = torch.from_numpy(data["mask"])
    y_c = torch.from_numpy(label_c_np)
    c_mask_t = torch.from_numpy(c_mask_np.astype(np.float32))
    entity_dim = tfm.ENTITY_DIM_V2
    global_dim = int(glob.shape[1])
    if device.type == "cuda":
        entity = entity.to(device)
        glob = glob.to(device)
        mask = mask.to(device)
        y_c = y_c.to(device)
        c_mask_t = c_mask_t.to(device)
        data["entity"] = None
        data["global"] = None
        data["mask"] = None
        gc.collect()
    log(f"[e26] tensors: entity {entity.numel() * entity.element_size() / 1e9:.2f} GB {entity.dtype}")

    split = make_split(data["group"], args.folds, args.seed)
    fold = split["fold"]
    log(f"[e26] split: {split['mode']} ({split['n_groups']} replays)")
    nn = torch.nn
    bce_none = nn.BCEWithLogitsLoss(reduction="none")
    eps = args.label_smoothing
    eval_batch = getattr(args, "eval_batch_size", 0) or max(args.batch_size, 8192)
    p_c = np.full(data["rows"], np.nan, dtype=np.float64)
    fold_reports = []
    losses_all = []
    for f in range(split["folds"]):
        val_mask = c_mask_np & (fold == f)
        train_mask = c_mask_np & (fold != f)
        if int(val_mask.sum()) == 0 or int(train_mask.sum()) == 0:
            continue
        torch.manual_seed(args.seed + f)
        np.random.seed(args.seed + f)
        model = build_headc_only_model(torch, hidden=args.hidden, entity_dim=entity_dim, global_dim=global_dim)
        model.to(device)
        opt = torch.optim.Adam(model.parameters(), lr=args.lr)
        train_idx = torch.from_numpy(np.flatnonzero(train_mask)).to(device)
        losses = []
        t_fold = time.time()
        for epoch in range(args.epochs):
            model.train()
            perm = train_idx[torch.randperm(len(train_idx), device=device)]
            tot, cnt = 0.0, 0
            for st in range(0, len(perm), args.batch_size):
                idx = perm[st : st + args.batch_size]
                lc = model(entity[idx].float(), glob[idx].float(), mask[idx].float())
                yc_b = y_c[idx].to(device)
                loss = bce_smoothed_loss(bce_none, lc, yc_b, eps).mean()
                opt.zero_grad()
                loss.backward()
                opt.step()
                tot += float(loss.item()) * len(idx)
                cnt += len(idx)
            losses.append(tot / max(cnt, 1))
            log(f"  fold {f} epoch {epoch + 1}/{args.epochs} loss {losses[-1]:.4f} ({time.time() - t_fold:.1f}s)")
        losses_all.append(losses)
        model.eval()
        val_idx = np.flatnonzero(val_mask)
        preds = np.empty(len(val_idx), dtype=np.float32)
        with torch.no_grad():
            for st in range(0, len(val_idx), eval_batch):
                chunk = val_idx[st : st + eval_batch]
                idx = torch.from_numpy(chunk).to(device)
                lc = model(entity[idx].float(), glob[idx].float(), mask[idx].float())
                preds[st : st + len(chunk)] = torch.sigmoid(lc).float().cpu().numpy()
        p_c[val_idx] = preds
        fold_reports.append({
            "fold": f, "train_rows": int(train_mask.sum()), "val_rows": int(val_mask.sum()),
            "seconds": round(time.time() - t_fold, 1),
            "loss_first": round(losses[0], 4), "loss_last": round(losses[-1], 4),
            "headC": head_b_metrics(label_c_np[val_mask], preds),
        })
        fr = fold_reports[-1]["headC"]
        log(f"[e26] fold {f} val headC: AUPRC {fr['auprc']} AUC {fr['roc_auc']} "
            f"logloss {fr['logloss']} base {fr['baseRate']} topLift {fr['topDecile']['lift']}")

    scored = np.isfinite(p_c)
    oof_c = head_b_metrics(label_c_np[scored], p_c[scored])
    log(f"[e26] OOF headC: rows {int(scored.sum()):,} AUPRC {oof_c['auprc']} AUC {oof_c['roc_auc']} "
        f"logloss {oof_c['logloss']} Brier {oof_c['brier']} ECE {oof_c['ece_15bin']} "
        f"base {oof_c['baseRate']} topLift {oof_c['topDecile']['lift']}")
    per_class = {}
    for cls in sorted(set(data["class"][scored].tolist())):
        m = scored & (data["class"] == cls)
        per_class[cls] = (head_b_metrics(label_c_np[m], p_c[m])
                          if int(m.sum()) >= MIN_CLASS_N else {"rows": int(m.sum()), "insufficient": True})
    per_region = {}
    for reg in sorted(set(data["region"][scored].tolist())):
        m = scored & (data["region"] == reg)
        per_region[reg] = (head_b_metrics(label_c_np[m], p_c[m])
                           if int(m.sum()) >= MIN_CLASS_N else {"rows": int(m.sum()), "insufficient": True})
    calib = class_temperature_report(p_c[scored], label_c_np[scored], data["class"][scored])
    metrics = {
        "_lineage": "E26e-d standalone outcome headC (launched rows only, no shared trunk)",
        "protocol": {
            "model": "headc-standalone", "feature_version": FEATURE_VERSION,
            "entity_dim": entity_dim, "global_dim": global_dim,
            "feature_set": data["feature_set"], "feature_dtype": data["feature_dtype"],
            "data_paths": [str(p) for p in paths],
            "outcome_sidecars": [str(p) for p in args.outcome],
            "epochs": args.epochs, "hidden": args.hidden, "batch_size": args.batch_size,
            "lr": args.lr, "label_smoothing": args.label_smoothing, "seed": args.seed,
            "device": str(device), "torch": torch.__version__,
            "ship_classes": str(args.ship_classes), "ship_class_pack": class_pack_version,
            "trained_on": "labelB==1 & torpFiredFish>=1 rows only",
        },
        "data": {
            "rows": data["rows"], "launchedRows": n_launched,
            "positives": n_pos, "rowHitRate": _num(label_c_np[c_mask_np].mean()),
            "class_counts": data["class_counts"], "region_counts": data["region_counts"],
            "outcome": outcome["quality"],
        },
        "split": {"mode": split["mode"], "folds": split["folds"], "replays": split["n_groups"],
                  "fold_sizes": [int((fold == f).sum()) for f in range(split["folds"])]},
        "metrics_oof_pooled": {"headC": oof_c},
        "per_class": per_class,
        "per_region": per_region,
        "per_fold": {"folds": fold_reports, "summary_mean_std": summarize_per_fold(fold_reports)},
        "calibration_class": calib,
        "training": {"fold_seconds": [r["seconds"] for r in fold_reports],
                     "total_seconds": round(sum(r["seconds"] for r in fold_reports), 1),
                     "epoch_loss_first": [_num(l[0]) for l in losses_all],
                     "epoch_loss_last": [_num(l[-1]) for l in losses_all]},
        "acceptance": {
            "rule": "E26e-d secondary only: standalone headC outcome-lift is descriptive; joint acceptance uses probB*probC",
            "note": "see e26e-d-preregistration.md",
        },
    }
    if args.save_oof:
        metrics["save_oof"] = _standalone_oof_npz(Path(args.save_oof), data, p_c, label_c_np, fold, split, args, oof_c)
    return metrics


def run_combine_oof(args: argparse.Namespace) -> int:
    """E26e-d: merge E26e-a base npz (probA/probB) with the standalone headC npz."""
    if not args.combine_base or not args.combine_headc or not args.combine_out:
        raise SystemExit("[e26] --combine-oof needs --combine-base, --combine-headc and --combine-out")
    out_path = Path(args.combine_out).resolve()
    if out_path == Path(args.combine_base).resolve() or out_path == Path(args.combine_headc).resolve():
        raise SystemExit("[e26] --combine-out must not overwrite --combine-base/--combine-headc")
    base = np.load(args.combine_base, allow_pickle=False)
    hc = np.load(args.combine_headc, allow_pickle=False)
    for key in ("probB", "labelB", "rowIndex", "shipId", "t", "groupCode"):
        if key not in base.files:
            raise SystemExit("[e26] base npz missing key: " + key)
    for key in ("probC", "labelC", "rowIndex"):
        if key not in hc.files:
            raise SystemExit("[e26] headC npz missing key: " + key)
    if len(base["probB"]) != len(hc["probC"]):
        raise SystemExit("[e26] row count mismatch base " + str(len(base["probB"])) + " vs headC " + str(len(hc["probC"])))
    if not np.array_equal(base["rowIndex"], hc["rowIndex"]):
        raise SystemExit("[e26] rowIndex mismatch between base and headC npz")
    for key in ("shipId", "t", "groupCode"):
        if key in hc.files and not np.array_equal(base[key], hc[key]):
            raise SystemExit("[e26] " + key + " mismatch between base and headC npz")
    payload = {}
    for key in base.files:
        payload[key] = base[key]
    payload["probC"] = hc["probC"]
    payload["labelC"] = hc["labelC"]
    meta = json.loads(str(base["meta"].tolist())) if "meta" in base.files else {}
    meta["combined"] = "E26e-a probB + E26e-d standalone probC (same rowIndex)"
    payload["meta"] = np.array(json.dumps(meta), dtype="U8192")
    out = Path(args.combine_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, **payload)
    launched = np.isfinite(hc["probC"]) & np.isfinite(base["labelB"])
    print(f"[e26] combined npz -> {out} ({out.stat().st_size:,} bytes; "
          f"scored probC rows {int(np.isfinite(hc['probC']).sum()):,}; launched {int(launched.sum()):,})", flush=True)
    return 0


# ── T2 delivery: final fit (all rows) + ONNX export ─────────────────────────


def final_export_dir(args: argparse.Namespace) -> Path:
    if args.export_dir:
        return Path(args.export_dir)
    return HERE / "out" / "torpedo_model" / "final"


def select_eval_subset(data: dict, n_eval: int, seed: int) -> dict:
    """Deterministic (seeded permutation) row subset kept on the HOST for the
    ONNX parity/int8 checks and the parity vectors — selected BEFORE the full
    corpus is moved to the device so the host arrays can be freed afterwards."""
    n = data["rows"]
    rng = np.random.default_rng(seed)
    take = min(n_eval, n)
    idx = np.sort(rng.permutation(n)[:take]).astype(np.int64)
    return {
        "idx": idx,
        "rows": int(take),
        "entity": data["entity"][idx].astype(np.float32),  # float16 storage -> fp32
        "global": data["global"][idx].astype(np.float32),
        "mask": data["mask"][idx].astype(np.float32),
        "label_a": data["label_a"][idx].astype(np.float32),
        "label_b": data["label_b"][idx].astype(np.float32),
        "class": data["class"][idx],
        "region": data["region"][idx],
        "ship_id": data["ship_id"][idx],
        "group": data["group"][idx],
        "t": data["t"][idx],
        "group_names": data["group_names"],
    }


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def train_final_model(
    *,
    torch,
    args: argparse.Namespace,
    entity,
    glob,
    mask,
    y_a,
    y_b,
    b_mask,
    entity_dim: int,
    global_dim: int,
    device,
    log_fn,
):
    """Train ONE model on ALL rows (no CV) with the E26c/E26d hyperparameters."""
    nn = torch.nn
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    model = tfm.build_model(hidden=args.hidden, entity_dim=entity_dim, global_dim=global_dim)
    model.to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    bce = nn.BCEWithLogitsLoss(reduction="none")
    eps = args.label_smoothing
    n = int(entity.shape[0])
    losses: list[float] = []
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(n, device=device)
        tot, cnt = 0.0, 0
        for st in range(0, n, args.batch_size):
            idx = perm[st : st + args.batch_size]
            la, lb = model(entity[idx].float(), glob[idx].float(), mask[idx].float())
            loss_a = bce_smoothed_loss(bce, la, y_a[idx], eps).mean()
            m = b_mask[idx]
            loss_b = (bce_smoothed_loss(bce, lb, y_b[idx], eps) * m).sum() / m.sum().clamp(min=1.0)
            loss = loss_a + loss_b
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += float(loss.item()) * len(idx)
            cnt += len(idx)
        losses.append(tot / max(cnt, 1))
        log_fn(f"[e26] final-fit epoch {epoch + 1}/{args.epochs} loss {losses[-1]:.4f} ({time.time() - t0:.1f}s)")
    log_fn(f"[e26] final-fit done: {args.epochs} epochs on {n:,} rows in {time.time() - t0:.1f}s")
    return model, losses


def _ort_forward_rows(sess, entity, glob, mask) -> tuple[np.ndarray, np.ndarray]:
    """Batch-1 ORT forward loop (the export is static batch 1)."""
    la = np.empty(len(glob), dtype=np.float32)
    lb = np.empty(len(glob), dtype=np.float32)
    for i in range(len(glob)):
        out = sess.run(
            None,
            {
                "entity": entity[i : i + 1].astype(np.float32),
                "global_feat": glob[i : i + 1].astype(np.float32),
                "mask": mask[i : i + 1].astype(np.float32),
            },
        )
        la[i] = np.asarray(out[0]).reshape(-1)[0]
        lb[i] = np.asarray(out[1]).reshape(-1)[0]
    return la, lb


def export_final_model(
    *,
    torch,
    model,
    data: dict,
    subset: dict,
    args: argparse.Namespace,
    out_dir: Path,
    train_losses: list[float],
    device_str: str,
    log_fn,
    entity_dim: int,
    global_dim: int,
):
    """Export fp32 + int8 ONNX with the app Fire24-compatible contract, then
    validate torch-vs-ORT parity and int8 degradation. Returns the metrics dict."""
    import tempfile
    import shutil

    import numpy as _np
    import onnx
    import onnxruntime as ort
    from onnxruntime.quantization import QuantType, quantize_dynamic

    out_dir.mkdir(parents=True, exist_ok=True)
    nn = torch.nn
    model = model.cpu().eval()

    # Checkpoint BEFORE export (E24 lesson: never lose a 1-epoch-scale fit...
    # and here the deliverable is the checkpoint itself).
    ckpt_path = out_dir / "checkpoint.pt"
    torch.save(
        {
            "model": model.state_dict(),
            "hidden": args.hidden,
            "feature_version": FEATURE_VERSION,
            "feature_set": data["feature_set"],
            "extra_dim": data["extra_dim"],
            "entity_dim": entity_dim,
            "global_dim": global_dim,
            "feature_names": data["feature_names"],
            "epochs": args.epochs,
            "loss_last": float(train_losses[-1]),
            "torch": torch.__version__,
        },
        ckpt_path,
    )
    log_fn(f"[e26] checkpoint -> {ckpt_path} ({ckpt_path.stat().st_size:,} bytes)")

    class ExportWrapper(nn.Module):
        def __init__(self, inner) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, entity, global_feat, mask):
            la, lb = self.inner(entity, global_feat, mask)
            return la.unsqueeze(-1), lb.unsqueeze(-1)  # [B, 1] app contract

    wrapper = ExportWrapper(model).eval()
    ex = torch.from_numpy(subset["entity"][:1]).float()
    gx = torch.from_numpy(subset["global"][:1]).float()
    mx = torch.from_numpy(subset["mask"][:1]).float()
    fp32_path = out_dir / "fp32.onnx"
    in_names = ["entity", "global_feat", "mask"]
    out_names = ["logitA", "logitB"]
    try:
        torch.onnx.export(
            wrapper,
            (ex, gx, mx),
            str(fp32_path),
            input_names=in_names,
            output_names=out_names,
            opset_version=17,
            dynamo=False,
        )
    except TypeError:
        torch.onnx.export(
            wrapper,
            (ex, gx, mx),
            str(fp32_path),
            input_names=in_names,
            output_names=out_names,
            opset_version=17,
        )
    onnx.checker.check_model(onnx.load(str(fp32_path)))
    log_fn(f"[e26] fp32 ONNX -> {fp32_path} ({fp32_path.stat().st_size:,} bytes)")

    # int8 dynamic quantization in an ASCII-safe temp dir (E19 pitfall).
    int8_path = out_dir / "int8.onnx"
    with tempfile.TemporaryDirectory() as td:
        tmp_in = Path(td) / "fp32.onnx"
        tmp_out = Path(td) / "int8.onnx"
        shutil.copyfile(fp32_path, tmp_in)
        try:
            quantize_dynamic(str(tmp_in), str(tmp_out), weight_type=QuantType.QInt8)
        except TypeError:
            quantize_dynamic(str(tmp_in), str(tmp_out))
        shutil.copyfile(tmp_out, int8_path)
    onnx.checker.check_model(onnx.load(str(int8_path)))
    log_fn(f"[e26] int8 ONNX -> {int8_path} ({int8_path.stat().st_size:,} bytes)")

    # Contract printout (names + declared shapes).
    m32 = onnx.load(str(fp32_path))
    def _shapes(gm):
        return [
            (i.name, [d.dim_value if d.HasField("dim_value") else d.dim_param for d in i.type.tensor_type.shape.dim])
            for i in gm.graph.input
        ], [
            (o.name, [d.dim_value if d.HasField("dim_value") else d.dim_param for d in o.type.tensor_type.shape.dim])
            for o in gm.graph.output
        ]
    in_shapes, out_shapes = _shapes(m32)
    log_fn(f"[e26] ONNX inputs: {in_shapes}")
    log_fn(f"[e26] ONNX outputs: {out_shapes}")
    assert [n for n, _ in in_shapes] == in_names
    assert [n for n, _ in out_shapes] == out_names

    so = ort.SessionOptions()
    sess_fp32 = ort.InferenceSession(str(fp32_path), so, providers=["CPUExecutionProvider"])
    sess_int8 = ort.InferenceSession(str(int8_path), so, providers=["CPUExecutionProvider"])

    # 1) torch (CPU) vs ORT fp32 on --parity-rows deterministic rows: logits.
    npair = min(args.parity_rows, subset["rows"])
    e_p = torch.from_numpy(subset["entity"][:npair])
    g_p = torch.from_numpy(subset["global"][:npair])
    m_p = torch.from_numpy(subset["mask"][:npair])
    with torch.no_grad():
        t_la, t_lb = model(e_p, g_p, m_p)
    t_la = t_la.numpy().reshape(-1)
    t_lb = t_lb.numpy().reshape(-1)
    o_la, o_lb = _ort_forward_rows(sess_fp32, subset["entity"], subset["global"], subset["mask"])
    par_a = float(np.max(np.abs(o_la[:npair] - t_la)))
    par_b = float(np.max(np.abs(o_lb[:npair] - t_lb)))
    tolerance = 1e-4
    parity_ok = bool(par_a < tolerance and par_b < tolerance)
    log_fn("[e26] parity fp32 torch-vs-ORT over "
           f"{npair} rows: max|dlogit| A {par_a:.2e} B {par_b:.2e} (< {tolerance:.0e}) -> {parity_ok}")
    assert parity_ok, "fp32 torch-vs-ORT parity failed"

    # 2) int8 vs fp32 metrics on the deterministic eval subset (in-sample
    # reference: the final fit uses every row, so this is NOT held-out).
    i8_la, i8_lb = _ort_forward_rows(sess_int8, subset["entity"], subset["global"], subset["mask"])
    p32_a = tfm.sigmoid(o_la)
    p32_b = tfm.sigmoid(o_lb)
    p8_a = tfm.sigmoid(i8_la)
    p8_b = tfm.sigmoid(i8_lb)
    dpa = float(np.max(np.abs(p8_a - p32_a)))
    dpb = float(np.max(np.abs(p8_b - p32_b)))
    can = subset["label_a"] == 1.0
    y_b_can = subset["label_b"][can]
    ref = {
        "rows": subset["rows"],
        "in_sample": True,
        "headA_auprc_fp32": _num(tfm.average_precision(subset["label_a"], p32_a)),
        "headA_auprc_int8": _num(tfm.average_precision(subset["label_a"], p8_a)),
        "headA_logloss_fp32": _num(tfm.log_loss(subset["label_a"], p32_a)),
        "headA_logloss_int8": _num(tfm.log_loss(subset["label_a"], p8_a)),
        "headB_auprc_fp32": _num(tfm.average_precision(y_b_can, p32_b[can])),
        "headB_auprc_int8": _num(tfm.average_precision(y_b_can, p8_b[can])),
        "headB_logloss_fp32": _num(tfm.log_loss(y_b_can, p32_b[can])),
        "headB_logloss_int8": _num(tfm.log_loss(y_b_can, p8_b[can])),
        "maxAbsProbDiffA": dpa,
        "maxAbsProbDiffB": dpb,
    }
    log_fn(
        f"[e26] int8 vs fp32 on {subset['rows']:,} rows: max|dp| A {dpa:.2e} B {dpb:.2e}; "
        f"AUPRC-B fp32 {ref['headB_auprc_fp32']} int8 {ref['headB_auprc_int8']}; "
        f"logloss-B fp32 {ref['headB_logloss_fp32']} int8 {ref['headB_logloss_int8']}"
    )

    # 3) parity vectors (>= --parity-vector-rows): tensors + fp32/int8 logits +
    # row metadata + the 11 torp2 derived dims (part of the 38-wide global).
    nvec = min(args.parity_vector_rows, subset["rows"])
    extra_dim = int(data["extra_dim"])
    vectors = []
    for i in range(nvec):
        vectors.append(
            {
                "entity": subset["entity"][i].reshape(-1).tolist(),
                "global": subset["global"][i].tolist(),
                "mask": subset["mask"][i].tolist(),
                "torp2Extras": subset["global"][i, 27:27 + extra_dim].tolist() if extra_dim else [],
                "logitA_fp32": float(o_la[i]),
                "logitB_fp32": float(o_lb[i]),
                "logitA_int8": float(i8_la[i]),
                "logitB_int8": float(i8_lb[i]),
                "shipId": int(subset["ship_id"][i]),
                "replayId": subset["group_names"][int(subset["group"][i])],
                "t": float(subset["t"][i]),
                "region": str(subset["region"][i]),
                "class": str(subset["class"][i]),
                "labelACanLaunch": bool(subset["label_a"][i] == 1.0),
                "labelBLaunched": None if np.isnan(subset["label_b"][i]) else bool(subset["label_b"][i] == 1.0),
            }
        )
    vectors_path = out_dir / "parity_vectors.json"
    vectors_path.write_text(json.dumps({"rows": vectors}, indent=1), encoding="utf-8")
    log_fn(f"[e26] parity vectors -> {vectors_path} ({nvec} rows)")

    def _fentry(p: Path) -> dict:
        return {"path": str(p), "bytes": p.stat().st_size, "sha256": sha256_file(p)}

    metrics = {
        "_lineage": "E26d torp2 final-fit ONNX delivery candidate (T2 model)",
        "mode": "final-fit (ALL rows, no CV; the E26d OOF numbers remain the honest estimate)",
        "data": {
            "rows": data["rows"],
            "replays": len(data["group_names"]),
            "feature_set": data["feature_set"],
            "extra_dim": data["extra_dim"],
            "feature_version": FEATURE_VERSION,
            "class_counts": data["class_counts"],
            "region_counts": data["region_counts"],
            "labels": {
                "canLaunch": int(data["label_a"].sum()),
                "launched_true": int(np.nansum(data["label_b"])),
                "labelB_null": int(np.isnan(data["label_b"]).sum()),
            },
        },
        "training": {
            "epochs": args.epochs,
            "hidden": args.hidden,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "label_smoothing": args.label_smoothing,
            "device": device_str,
            "loss_first": _num(train_losses[0]),
            "loss_last": _num(train_losses[-1]),
            "loss_curve": [_num(x) for x in train_losses],
        },
        "reference_oof": {
            "source": "E26d torp2 5-fold OOF (scripts/experiments/out/torpedo_model/e26d_torp2_metrics.json)",
            "headB_auprc": 0.03705068555520497,
            "headB_auprc_multiple_of_base": 2.286065230588968,
            "headB_topDecileLift": 2.661953046068418,
            "headA_auprc": 0.9998866615209074,
        },
        "export": {
            "contract": {"inputs": {n: s for n, s in in_shapes}, "outputs": {n: s for n, s in out_shapes}},
            "fp32": _fentry(fp32_path),
            "int8": _fentry(int8_path),
            "checkpoint": _fentry(ckpt_path),
            "opset": 17,
            "torch": torch.__version__,
            "onnx": onnx.__version__,
            "onnxruntime": ort.__version__,
        },
        "parity_fp32": {
            "rows": int(npair),
            "maxAbsLogitDiffA": par_a,
            "maxAbsLogitDiffB": par_b,
            "tolerance": tolerance,
            "passed": parity_ok,
        },
        "int8_vs_fp32": ref,
        "parity_vectors": {"path": str(vectors_path), "rows": nvec},
    }
    metrics_path = out_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=1, ensure_ascii=False), encoding="utf-8")
    log_fn(f"[e26] metrics -> {metrics_path}")
    return metrics


def run_final_fit(args: argparse.Namespace) -> int:
    """T2 delivery pipeline: load the full corpus, train ONE model on all rows,
    export fp32+int8 ONNX, validate torch-vs-ORT parity, write parity vectors."""
    import torch

    log = lambda s: print(s, flush=True)  # noqa: E731
    if args.feature_set != "torp2":
        raise SystemExit("[e26] --final-fit requires --feature-set torp2 (the E26d delivery feature set)")
    device = torch.device("cuda" if (args.device in ("auto", "cuda") and torch.cuda.is_available()) else "cpu")
    torch.set_num_threads(max(1, torch.get_num_threads()))
    log(f"[e26] FINAL FIT on {device} (torch {torch.__version__})")

    classes, class_pack_version = load_ship_classes(Path(args.ship_classes))
    paths = resolve_data_paths(args)
    t0 = time.time()
    data = load_torpedo_rows(paths, args.max_rows, classes, args.feature_dtype, args.feature_set)
    log(f"[e26] loaded {data['rows']:,} rows / {len(data['group_names'])} replays in {time.time() - t0:.1f}s "
        f"(arrays {data['array_bytes'] / 1e9:.2f} GB)")
    log(f"[e26] class counts: {json.dumps(data['class_counts'], ensure_ascii=False)}")

    subset = select_eval_subset(data, args.int8_eval_rows, args.seed)
    log(f"[e26] host eval subset: {subset['rows']:,} rows (int8 metrics + parity vectors)")

    entity = torch.from_numpy(data["entity"])
    glob = torch.from_numpy(data["global"])
    mask = torch.from_numpy(data["mask"])
    y_a = torch.from_numpy(data["label_a"])
    y_b = torch.from_numpy(np.nan_to_num(data["label_b"], nan=0.0))
    b_mask_np = (data["label_a"] == 1.0) & np.isfinite(data["label_b"])
    b_mask = torch.from_numpy(b_mask_np.astype(np.float32))
    entity_dim = int(entity.shape[2])
    global_dim = int(glob.shape[1])
    if device.type == "cuda":
        entity = entity.to(device)
        glob = glob.to(device)
        mask = mask.to(device)
        y_a = y_a.to(device)
        y_b = y_b.to(device)
        b_mask = b_mask.to(device)
        # host copies no longer needed (the eval subset above is a compact copy)
        data["entity"] = None
        data["global"] = None
        data["mask"] = None
        gc.collect()
    log(f"[e26] tensors: entity {entity.numel() * entity.element_size() / 1e9:.2f} GB {entity.dtype} on {entity.device}")

    model, losses = train_final_model(
        torch=torch,
        args=args,
        entity=entity,
        glob=glob,
        mask=mask,
        y_a=y_a,
        y_b=y_b,
        b_mask=b_mask,
        entity_dim=entity_dim,
        global_dim=global_dim,
        device=device,
        log_fn=log,
    )

    out_dir = final_export_dir(args)
    metrics = export_final_model(
        torch=torch,
        model=model,
        data=data,
        subset=subset,
        args=args,
        out_dir=out_dir,
        train_losses=losses,
        device_str=str(device),
        log_fn=log,
        entity_dim=entity_dim,
        global_dim=global_dim,
    )
    log(f"[e26] DELIVERY CANDIDATE ready under {out_dir}")
    log(f"[e26] fp32 {metrics['export']['fp32']['bytes']:,} bytes sha256={metrics['export']['fp32']['sha256']}")
    log(f"[e26] int8 {metrics['export']['int8']['bytes']:,} bytes sha256={metrics['export']['int8']['sha256']}")
    log(f"[e26] parity {metrics['parity_fp32']}")
    log(f"[e26] int8_vs_fp32 {metrics['int8_vs_fp32']}")
    return 0

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

    # 6. E26c full-corpus loader: two-pass mode, float16 storage, exact count.
    assert data["loader_mode"] == "single-pass-budget", data["loader_mode"]
    assert data2["loader_mode"] == "two-pass-full", data2["loader_mode"]
    assert data2["feature_dtype"] == "float16", data2["feature_dtype"]
    assert data2["entity"].dtype == np.float16, data2["entity"].dtype
    assert data2["mask"].dtype == np.float16, data2["mask"].dtype
    assert data2["global"].dtype == np.float32, data2["global"].dtype
    assert data2["rows"] == data2["entity"].shape[0] == data2["group"].shape[0]
    assert data2["array_bytes"] > 0 and data2["theoretical_bytes"] > 0
    assert data2["pass1_seconds"] >= 0.0
    # float16 values still carry the featurizer sentinels/one-hots (§2 shape test
    # above asserts the float32 path; the loader stores the same values narrowed).
    assert float(data2["entity"][0, 0, 8]) == 1.0  # entityType==2 one-hot survives narrowing
    # --feature-dtype float32 keeps the historical storage for pilot reproduction.
    data_f32 = load_torpedo_rows([tmp], max_rows=0, classes=classes, feature_dtype="float32")
    assert data_f32["entity"].dtype == np.float32 and data_f32["mask"].dtype == np.float32
    assert data_f32["rows"] == data2["rows"]
    # Group ids are interned integers (per-replay groups feed GroupKFold unchanged).
    assert data2["group"].dtype == np.int32 and len(data2["group_names"]) >= 1
    assert make_split(data2["group"], 5, seed=0)["n_groups"] == len(data2["group_names"])

    # 7. Region tagging from the export file name + per-region aggregation.
    apac = root / "dataset_kots_apac_2s.jsonl"
    apac.write_text(tmp.read_text(encoding="utf-8"), encoding="utf-8")
    data_apac = load_torpedo_rows([apac], max_rows=0, classes=classes)
    assert data_apac["region_counts"] == {"apac": 5}, data_apac["region_counts"]
    pr = per_region_metrics(
        {
            "region": np.array(["apac"] * 40, dtype=object),
            "label_a": np.array([1.0] * 40),
            "label_b": np.array([1.0] * 10 + [0.0] * 30),
        },
        np.linspace(0.9, 0.1, 40),
        np.linspace(0.9, 0.1, 40),
        np.array([True] * 40),
    )
    assert pr["apac"]["rows"] == 40 and pr["apac"]["launched"] == 10 and pr["apac"]["auprc_headB"] is not None

    # 8. E26d torp2 derived features: geometry/class dims + core bit-compatibility.
    assert TORP2_DIM == 11 and len(TORP2_NAMES) == 11
    base = synth()
    ex = derive_torp2_extras(base, "Destroyer")
    assert ex[0] == 1.0 and ex[1:5] == [0.0, 0.0, 0.0, 0.0], ex
    assert abs(ex[5] - 1.0 / 12.0) < 1e-9, ex  # one observed enemy
    assert abs(ex[6] - 1.0 / 8.0) < 1e-9, ex  # 5 km <= 10 km range
    assert abs(ex[7] - 0.5) < 1e-9, ex        # 1 - 5000/10000
    assert abs(ex[8] - 1.0) < 1e-9, ex        # 0.5 rad = 28.6 deg <= 45
    assert abs(ex[9] - 0.0) < 1e-9, ex        # 28.6 deg > 20
    assert ex[10] == 0.0, ex                  # reload 0.5 -> not ready
    empty = synth()
    empty["enemies"] = []
    ex_empty = derive_torp2_extras(empty, "unknown")
    assert ex_empty == [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], ex_empty
    boundary = synth()
    boundary["enemies"] = [
        {"distM": 20000.0, "bearingRelRad": 0.0, "observedNow": True},          # observed, out of range
        {"distM": 9000.0, "bearingRelRad": math.pi / 9.0, "observedNow": True},  # exactly 20 deg
        {"distM": 8000.0, "bearingRelRad": math.pi / 4.0, "observedNow": True},  # exactly 45 deg
        {"distM": 5000.0, "bearingRelRad": 2.0, "observedNow": False},           # stale -> ignored
    ]
    ex_b = derive_torp2_extras(boundary, "Battleship")
    assert ex_b[2] == 1.0, ex_b
    assert abs(ex_b[5] - 3.0 / 12.0) < 1e-9, ex_b   # 3 observed
    assert abs(ex_b[6] - 2.0 / 8.0) < 1e-9, ex_b    # 2 in range
    assert abs(ex_b[7] - 0.2) < 1e-9, ex_b          # closest 8 km -> 0.2
    assert abs(ex_b[8] - 1.0) < 1e-9, ex_b          # 20 and 45 deg both <= 45
    assert abs(ex_b[9] - 0.5) < 1e-9, ex_b          # only 20 deg <= 20
    ready = synth()
    ready["ownReloadFrac"] = 0.999
    assert derive_torp2_extras(ready, "Destroyer")[10] == 1.0
    ready["ownReloadFrac"] = 0.9989
    assert derive_torp2_extras(ready, "Destroyer")[10] == 0.0
    assert derive_torp2_extras(synth(), "Cruiser")[1] == 1.0
    assert derive_torp2_extras(synth(), "Submarine")[3] == 1.0
    # core stays 27-wide; torp2 appends exactly 11 dims and keeps the first 27
    # columns byte-identical (E26c compatibility).
    d_core = load_torpedo_rows([tmp], max_rows=0, classes=classes)
    d_torp2 = load_torpedo_rows([tmp], max_rows=0, classes=classes, feature_set="torp2")
    assert d_core["global"].shape[1] == tfm.GLOBAL_DIM_V2 == 27, d_core["global"].shape
    assert d_torp2["global"].shape[1] == 38 and d_torp2["extra_dim"] == 11
    assert len(d_torp2["feature_names"]) == 38 and d_torp2["feature_names"][27] == "cls_dd"
    assert np.array_equal(d_core["global"], d_torp2["global"][:, :27]), "core columns drifted"
    assert d_torp2["global"][0, 27] == 1.0, "row 0 is a Destroyer -> cls_dd"
    assert d_core["feature_set"] == "core" and d_torp2["feature_set"] == "torp2"

    # 9. T2 delivery mode: CLI flags + eval-subset selector + default export dir.
    fa = parse_args(["--final-fit", "--export-dir", str(root / "final")])
    assert fa.final_fit is True and str(fa.export_dir).endswith("final")
    assert fa.parity_rows >= 1000 and fa.parity_vector_rows >= 200
    assert parse_args([]).final_fit is False
    assert final_export_dir(parse_args([])).as_posix().endswith("out/torpedo_model/final")
    fake = {
        "rows": 10,
        "entity": np.zeros((10, tfm.SLOTS, tfm.ENTITY_DIM_V2), dtype=np.float16),
        "global": np.zeros((10, 38), dtype=np.float32),
        "mask": np.zeros((10, tfm.SLOTS), dtype=np.float16),
        "label_a": np.zeros(10, dtype=np.float32),
        "label_b": np.full(10, np.nan, dtype=np.float32),
        "class": np.array(["Destroyer"] * 10, dtype=object),
        "region": np.array(["own"] * 10, dtype=object),
        "ship_id": np.arange(10, dtype=np.int64),
        "group": np.arange(10, dtype=np.int32),
        "t": np.arange(10, dtype=np.float32),
        "group_names": [f"r{i}" for i in range(10)],
    }
    sub1 = select_eval_subset(fake, 100000, seed=0)
    sub2 = select_eval_subset(fake, 100000, seed=0)
    assert sub1["rows"] == 10 and np.array_equal(sub1["idx"], sub2["idx"])
    assert sub1["entity"].dtype == np.float32 and sub1["entity"].shape == (10, 24, 15)
    assert sub1["global"].shape == (10, 38) and sub1["t"].shape == (10,)
    assert sub1["group_names"][int(sub1["group"][0])] == "r0"
    sub3 = select_eval_subset(fake, 4, seed=7)
    assert sub3["rows"] == 4 and len(set(sub3["idx"].tolist())) == 4

    # 10. E26e-a: OOF npz roundtrip + temperature fit (numpy only, torch-free).
    oa = parse_args(["--save-oof", str(root / "oof.npz")])
    assert oa.save_oof.endswith("oof.npz")
    assert parse_args(["--calibrate", str(root / "oof.npz")]).calibrate.endswith("oof.npz")
    assert parse_args(["--calibrate"]).calibrate == ""
    assert parse_args([]).calibrate is None
    fake["rows"] = 10
    fake["entity"] = np.zeros((10, tfm.SLOTS, tfm.ENTITY_DIM_V2), dtype=np.float16)
    fake["global"] = np.zeros((10, 38), dtype=np.float32)
    fake["mask"] = np.zeros((10, tfm.SLOTS), dtype=np.float16)
    fake["label_a"] = np.array([1, 1, 1, 1, 1, 0, 0, 0, 0, 0], dtype=np.float32)
    fake["label_b"] = np.array([1, 0, np.nan, 1, 0, np.nan, np.nan, np.nan, np.nan, np.nan], dtype=np.float32)
    fake["class"] = np.array(["Destroyer"] * 6 + ["Cruiser"] * 4, dtype=object)
    fake["region"] = np.array(["own"] * 5 + ["apac"] * 5, dtype=object)
    fake["ship_id"] = np.arange(10, dtype=np.int64)
    fake["group"] = np.arange(10, dtype=np.int32)
    fake["t"] = np.arange(10, dtype=np.float32)
    fake["group_names"] = [f"r{i}" for i in range(10)]
    p_a = np.array([0.9, 0.8, 0.7, 0.6, 0.4, 0.3, 0.2, 0.1, 0.05, 0.01])
    p_b = np.array([0.8, 0.2, np.nan, 0.9, 0.1, np.nan, np.nan, np.nan, np.nan, np.nan])
    fold = np.array([0, 0, 0, 0, 0, 1, 1, 1, 1, 1], dtype=np.int8)
    arr = oof_arrays(fake, p_a, p_b, fold)
    assert arr["probB"].dtype == np.float32 and np.isnan(arr["probB"][2])
    assert arr["classNames"].tolist() == ["Cruiser", "Destroyer"]
    assert arr["classCode"].tolist()[0] == 1 and arr["classCode"].tolist()[6] == 0
    assert arr["regionNames"].tolist() == ["apac", "own"]
    tmpnpz = root / "oof_roundtrip.npz"
    np.savez_compressed(tmpnpz, **arr)
    back = np.load(tmpnpz, allow_pickle=False)
    for key in ("probA", "probB", "labelA", "labelB", "fold", "rowIndex", "shipId", "t",
                "classCode", "classNames", "regionCode", "regionNames", "groupCode", "groupNames"):
        assert key in back, key
    assert back["probA"].shape == (10,) and "torp2Extras" not in back.files
    # synthetic: labels drawn from sigmoid(z/2), model probs sigmoid(z) => true T=2
    rng = np.random.default_rng(7)
    z_true = rng.normal(0.0, 1.5, 4000)
    p_true = 1.0 / (1.0 + np.exp(-z_true / 2.0))
    yb = (rng.random(4000) < p_true).astype(np.float64)
    pb_syn = 1.0 / (1.0 + np.exp(-z_true))
    T, nll0, nll1 = fit_temperature(pb_syn, yb)
    assert 1.5 < T < 2.8, T
    assert nll1 < nll0, (nll0, nll1)
    pcal = apply_temperature(pb_syn, T)
    assert max(pcal) <= 1.0 and min(pcal) >= 0.0
    assert abs(tfm.average_precision(yb, pb_syn) - tfm.average_precision(yb, pcal)) < 1e-12
    assert abs(tfm.roc_auc(yb, pb_syn) - tfm.roc_auc(yb, pcal)) < 1e-12
    assert tfm.log_loss(yb, pcal) < tfm.log_loss(yb, pb_syn)
    c = _calibration_metrics(yb, pcal)
    assert c["rows"] == 4000 and c["logloss"] is not None

    # 11. E26e-c: outcome sidecar loader / headC contract.
    ca = parse_args(["--head-c", "--outcome", "a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"])
    assert ca.head_c is True and len(ca.outcome) == 4
    assert parse_args([]).head_c is False
    odata = {
        "rows": 4,
        "group": np.arange(4, dtype=np.int32),
        "group_names": ["r0", "r1", "r2", "r3"],
        "t": np.array([0.0, 1.0, 2.0, 3.0], dtype=np.float32),
        "ship_id": np.array([100, 101, 102, 103], dtype=np.int64),
        "label_b": np.array([1.0, 0.0, 1.0, 0.0], dtype=np.float32),
        "class": np.array(["Destroyer", "Destroyer", "Cruiser", "Cruiser"], dtype=object),
        "region": np.array(["own", "own", "apac", "apac"], dtype=object),
        "label_a": np.array([1.0, 1.0, 1.0, 0.0], dtype=np.float32),
    }
    ocases = [
        {"replayId": "r0", "t": 0.0, "shipId": 100, "torpFiredFish": 3, "torpHits": 2, "torpHpLostNearby": 500.0, "torpTerminalNear": 2},
        {"replayId": "r1", "t": 1.0, "shipId": 101, "torpFiredFish": 0, "torpHits": 0, "torpHpLostNearby": 0.0, "torpTerminalNear": 0},
        {"replayId": "r2", "t": 2.0, "shipId": 102, "torpFiredFish": 1, "torpHits": 1, "torpHpLostNearby": 120.0, "torpTerminalNear": 1},
        {"replayId": "r3", "t": 3.0, "shipId": 103, "torpFiredFish": 2, "torpHits": 0, "torpHpLostNearby": 0.0, "torpTerminalNear": 1},
    ]
    side_paths = []
    for f, case in zip(("a", "b", "c", "d"), ocases):
        sp = root / ("outcome_" + f + ".jsonl")
        sp.write_text(json.dumps(case) + "\n", encoding="utf-8")
        side_paths.append(sp)
    joined = load_outcome_sidecars([], side_paths, odata, lambda s: None)
    q = joined["quality"]
    assert q["launchedRows"] == 2 and q["launchedWithZeroFiredFish"] == 0
    assert q["hitsAmongLaunched"] == 3 and q["firedFishAmongLaunched"] == 4
    assert q["terminalNearPositiveRows"] == 3
    assert q["mismatchReplay"] == 0 and q["mismatchT"] == 0 and q["mismatchShip"] == 0
    label_c = (joined["hits"] > 0).astype(np.float32)
    c_mask = (odata["label_b"] == 1.0) & (joined["fired"] >= 1)
    assert c_mask.tolist() == [True, False, True, False]
    assert label_c[c_mask].tolist() == [1.0, 1.0]
    # a mismatch is counted but rows still join on matching keys
    bad = dict(ocases[0]); bad["replayId"] = "WRONG"
    sp = root / "outcome_bad.jsonl"
    sp.write_text(json.dumps(bad) + "\n", encoding="utf-8")
    bad_join = load_outcome_sidecars([], [sp] + side_paths[1:], odata, lambda s: None)
    assert bad_join["quality"]["mismatchReplay"] == 1
    # wrong row count must be loud
    try:
        load_outcome_sidecars([], [side_paths[0]], odata, lambda s: None)
        raise AssertionError("expected SystemExit on sidecar count mismatch")
    except SystemExit:
        pass
    # headC model has three heads (torch-gated: --selftest stays torch-free when
    # torch is absent, e.g. in CI's python-only job)
    try:
        import torch as _torch
    except ImportError:
        _torch = None
    if _torch is not None:
        m3 = build_three_head_model(_torch, hidden=16, entity_dim=15, global_dim=38)
        names = [n for n, _ in m3.named_parameters()]
        assert any(n.startswith("head_a") for n in names)
        assert any(n.startswith("head_b") for n in names)
        assert any(n.startswith("head_c") for n in names)
        out = m3(
            _torch.zeros(2, 24, 15), _torch.zeros(2, 38), _torch.ones(2, 24)
        )
        assert len(out) == 3 and out[0].shape == (2,) and out[2].shape == (2,)

    # 12. E26e-d: standalone headC CLI / model / OOF combine (numpy-only; torch gated).
    do = parse_args(["--head-c-only", "--outcome", "a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"])
    assert do.head_c_only is True and len(do.outcome) == 4
    co = parse_args(["--combine-oof", "--combine-base", "b.npz", "--combine-headc", "c.npz", "--combine-out", "o.npz"])
    assert co.combine_oof is True and co.combine_out == "o.npz"
    assert parse_args([]).head_c_only is False and parse_args([]).combine_oof is False
    if _torch is not None:
        m1 = build_headc_only_model(_torch, hidden=16, entity_dim=15, global_dim=38)
        names1 = [n for n, _ in m1.named_parameters()]
        assert any(n.startswith("head_c") for n in names1)
        assert not any(n.startswith("head_a") or n.startswith("head_b") for n in names1)
        o1 = m1(_torch.zeros(2, 24, 15), _torch.zeros(2, 38), _torch.ones(2, 24))
        assert o1.shape == (2,)
    nrow = 5
    bnpz = root / "base_oof.npz"
    cnpz = root / "headc_oof.npz"
    np.savez_compressed(
        bnpz,
        probA=np.full(nrow, 0.5, np.float32),
        probB=np.array([0.1, 0.2, 0.3, 0.4, 0.5], np.float32),
        labelA=np.array([1, 1, 1, 1, 0], np.float32),
        labelB=np.array([1, 1, 1, 0, np.nan], np.float32),
        fold=np.zeros(nrow, np.int8),
        rowIndex=np.arange(nrow, dtype=np.int32),
        shipId=np.arange(100, 100 + nrow, dtype=np.int64),
        t=np.arange(nrow, dtype=np.float32),
        groupCode=np.arange(nrow, dtype=np.int32),
        meta=np.array("{}", dtype="U32"),
    )
    np.savez_compressed(
        cnpz,
        probC=np.array([0.9, 0.8, np.nan, np.nan, np.nan], np.float32),
        labelC=np.array([1, 1, 0, 0, 0], np.float32),
        rowIndex=np.arange(nrow, dtype=np.int32),
        shipId=np.arange(100, 100 + nrow, dtype=np.int64),
        t=np.arange(nrow, dtype=np.float32),
        groupCode=np.arange(nrow, dtype=np.int32),
    )
    comb = root / "combined_oof.npz"
    cargs = parse_args(["--combine-oof", "--combine-base", str(bnpz), "--combine-headc", str(cnpz), "--combine-out", str(comb)])
    assert run_combine_oof(cargs) == 0
    backc = np.load(comb, allow_pickle=False)
    for key in ("probA", "probB", "probC", "labelA", "labelB", "labelC", "rowIndex", "groupCode", "meta"):
        assert key in backc.files, key
    assert np.array_equal(backc["probC"], np.array([0.9, 0.8, np.nan, np.nan, np.nan], np.float32), equal_nan=True)
    assert np.array_equal(backc["probB"], np.array([0.1, 0.2, 0.3, 0.4, 0.5], np.float32))
    # rowIndex mismatch must be loud
    bad = root / "headc_bad.npz"
    np.savez_compressed(bad, probC=np.zeros(nrow, np.float32), labelC=np.zeros(nrow, np.float32),
                        rowIndex=np.arange(1, nrow + 1, dtype=np.int32), shipId=np.arange(100, 100 + nrow, dtype=np.int64),
                        t=np.arange(nrow, dtype=np.float32), groupCode=np.arange(nrow, dtype=np.int32))
    bargs = parse_args(["--combine-oof", "--combine-base", str(bnpz), "--combine-headc", str(bad), "--combine-out", str(root / "x.npz")])
    failed = False
    try:
        run_combine_oof(bargs)
    except SystemExit:
        failed = True
    assert failed is True

    print("PASS")
    return 0


# ── entry point ─────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.selftest:
        return run_selftest()
    if args.calibrate is not None:
        return run_calibration(args)
    if args.combine_oof:
        return run_combine_oof(args)
    if args.head_c_only:
        metrics = run_headc_only(args)
        if args.metrics_out:
            out = Path(args.metrics_out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"[e26] metrics -> {out}")
        return 0
    if args.final_fit:
        return run_final_fit(args)
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
