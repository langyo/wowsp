#!/usr/bin/env python3
"""E26e-i: fuse two headC OOF npz files (E26e-g any-target + E26e-h fish-rate).

Pre-registered primary score: **mean calibrated probability** on launched rows.
  p_cal = sigmoid(logit(clip(p, 1e-6, 1-1e-6)) / T)
  probC_ens = (p_any_cal + p_rate_cal) / 2      (launched rows only; NaN elsewhere)

Temperatures come from each model's own OOF global fit:
  any-target headC (E26e-g) T = 1.0723, fish-rate headC (E26e-h) T = 1.3873.
The npz written here keeps -data/row metadata of the first input and only replaces
probC with the ensemble, so the existing torpedo_outcome_lift.py --prob-key C can
evaluate it directly.

Secondary (--rank-average): a second npz whose probC is the mean of the two models'
within-launched percentile ranks (0..1) — reported only, never used for the verdict.

Inputs must be the same corpus/split: rowIndex / labelB / labelC / fold / groupCode /
shipId / t are validated; any mismatch aborts.

Usage:
  python scripts/experiments/torpedo_headc_ensemble.py \
    --oof-a scripts/experiments/out/torpedo_model/e26e-g/e26e_g_oof.npz \
    --oof-b scripts/experiments/out/torpedo_model/e26e-h/e26e_h_fish_rate_oof.npz \
    --out scripts/experiments/out/torpedo_model/e26e-i/e26e_i_ensemble_oof.npz \
    --rank-out scripts/experiments/out/torpedo_model/e26e-i/e26e_i_rank_oof.npz \
    --metrics-out scripts/experiments/out/torpedo_model/e26e-i/e26e_i_ensemble_metrics.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

PROB_CLIP = 1e-6
DEFAULT_TEMP_A = 1.0723  # E26e-g any-target headC OOF global temperature
DEFAULT_TEMP_B = 1.3873  # E26e-h fish-rate headC OOF global temperature
ALIGN_KEYS_EXACT = ("rowIndex", "fold", "groupCode", "shipId")
ALIGN_KEYS_FLOAT = ("labelB", "labelC", "t")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sigmoid(z):
    z = np.asarray(z, dtype=np.float64)
    out = np.empty_like(z)
    pos = z >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-z[pos]))
    ez = np.exp(z[~pos])
    out[~pos] = ez / (1.0 + ez)
    return out


def logit(p) -> np.ndarray:
    """logit with the pre-registered 1e-6 clip (p may be 0/1 at the tails)."""
    p = np.clip(np.asarray(p, dtype=np.float64), PROB_CLIP, 1.0 - PROB_CLIP)
    return np.log(p) - np.log1p(-p)


def calibrate(p, temperature: float) -> np.ndarray:
    if not float(temperature) > 0.0:
        raise SystemExit("[ens] temperature must be positive, got " + str(temperature))
    return sigmoid(logit(p) / float(temperature))


def average_rank_pct(x, mask) -> np.ndarray:
    """Mean-1-based rank percentile in [0, 1] over mask (ties get average rank)."""
    idx = np.flatnonzero(mask)
    n = len(idx)
    out = np.full(len(x), np.nan, dtype=np.float64)
    if n == 0:
        return out
    vals = np.asarray(x, dtype=np.float64)[idx]
    order = np.argsort(vals, kind="mergesort")
    ranks = np.empty(n, dtype=np.float64)
    i = 0
    while i < n:
        j = i + 1
        while j < n and vals[order[j]] == vals[order[i]]:
            j += 1
        avg = (i + 1 + j) / 2.0
        ranks[order[i:j]] = avg
        i = j
    pct = (ranks - 1.0) / (n - 1.0) if n > 1 else np.full(n, 0.5)
    out[idx] = pct
    return out


def load_oof(path: Path) -> dict:
    path = Path(path)
    if not path.is_file():
        raise SystemExit("[ens] OOF npz not found: " + str(path))
    z = np.load(path, allow_pickle=False)
    required = ("probC", "labelB", "labelC", "rowIndex", "fold", "groupCode")
    for key in required:
        if key not in z.files:
            raise SystemExit("[ens] " + str(path) + " missing key: " + key)
    out = {key: z[key] for key in z.files}
    out["_path"] = str(path)
    out["_sha256"] = sha256_file(path)
    out["_meta"] = json.loads(str(z["meta"].tolist())) if "meta" in z.files else {}
    return out


def validate_pair(a: dict, b: dict) -> None:
    if len(a["probC"]) != len(b["probC"]):
        raise SystemExit("[ens] row count mismatch: " + str(len(a["probC"])) + " vs " + str(len(b["probC"])))
    for key in ALIGN_KEYS_EXACT:
        if key not in a or key not in b:
            raise SystemExit("[ens] cannot validate alignment: missing key " + key)
        if not np.array_equal(np.asarray(a[key]), np.asarray(b[key])):
            raise SystemExit("[ens] " + key + " mismatch between the two OOF npz files (not the same corpus/split)")
    for key in ALIGN_KEYS_FLOAT:
        if key not in a or key not in b:
            raise SystemExit("[ens] cannot validate alignment: missing key " + key)
        va = np.asarray(a[key], dtype=np.float64)
        vb = np.asarray(b[key], dtype=np.float64)
        if not np.allclose(va, vb, rtol=0.0, atol=1e-9, equal_nan=True):
            raise SystemExit("[ens] " + key + " mismatch between the two OOF npz files (not the same corpus/split)")
    for key in ("groupNames", "classNames", "regionNames"):
        if key in a and key in b and list(a[key].tolist()) != list(b[key].tolist()):
            raise SystemExit("[ens] " + key + " mismatch between the two OOF npz files")


def launched_mask(label_b) -> np.ndarray:
    lb = np.asarray(label_b, dtype=np.float64)
    return np.isfinite(lb) & (lb == 1.0)


def build_payload(a: dict, prob_c, extra_meta: dict) -> dict:
    payload = {key: a[key] for key in a if not key.startswith("_") and key != "meta"}
    payload["probC"] = np.asarray(prob_c, dtype=np.float32)
    meta = dict(a.get("_meta") or {})
    meta.update(extra_meta)
    payload["meta"] = np.array(json.dumps(meta, ensure_ascii=False)[:200000], dtype="U200000")
    return payload


def build_ensemble(a: dict, b: dict, temp_a: float, temp_b: float):
    laid = launched_mask(a["labelB"])
    p_a = calibrate(a["probC"], temp_a)
    p_b = calibrate(b["probC"], temp_b)
    ens = np.where(laid, (p_a + p_b) / 2.0, np.nan)
    rank = np.full(len(laid), np.nan, dtype=np.float64)
    if int(laid.sum()) > 0:
        ra = average_rank_pct(p_a, laid)
        rb = average_rank_pct(p_b, laid)
        rank[laid] = (ra[laid] + rb[laid]) / 2.0
    return p_a, p_b, ens, rank, laid


def _spearman(x, y) -> float:
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    ok = np.isfinite(x) & np.isfinite(y)
    if int(ok.sum()) < 2:
        return float("nan")
    rx = average_rank_pct(x, ok)
    ry = average_rank_pct(y, ok)
    rx = rx[ok]
    ry = ry[ok]
    rx = rx - rx.mean()
    ry = ry - ry.mean()
    denom = float(np.sqrt((rx * rx).sum() * (ry * ry).sum()))
    return float((rx * ry).sum() / denom) if denom > 0.0 else float("nan")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="E26e-i headC two-model OOF ensemble")
    ap.add_argument("--oof-a", required=False, help="any-target headC OOF npz (E26e-g)")
    ap.add_argument("--oof-b", required=False, help="fish-rate headC OOF npz (E26e-h)")
    ap.add_argument("--out", default="", help="ensemble OOF npz path (probC = mean calibrated probability)")
    ap.add_argument("--rank-out", default="", help="optional secondary npz (probC = mean rank percentile)")
    ap.add_argument("--metrics-out", default="", help="metrics JSON path")
    ap.add_argument("--temp-a", type=float, default=DEFAULT_TEMP_A)
    ap.add_argument("--temp-b", type=float, default=DEFAULT_TEMP_B)
    ap.add_argument("--rank-average", action="store_true", help="also write the rank-average secondary npz")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    if not args.oof_a or not args.oof_b:
        raise SystemExit("[ens] --oof-a and --oof-b are required")

    a = load_oof(Path(args.oof_a))
    b = load_oof(Path(args.oof_b))
    validate_pair(a, b)
    p_a, p_b, ens, rank, laid = build_ensemble(a, b, args.temp_a, args.temp_b)
    n_launched = int(laid.sum())
    if n_launched == 0:
        raise SystemExit("[ens] no launched rows (labelB==1) in the OOF files")
    if not np.all(np.isfinite(ens[laid])) or float(np.nanmin(ens[laid])) < 0.0 or float(np.nanmax(ens[laid])) > 1.0:
        raise SystemExit("[ens] ensemble probabilities out of [0,1]")
    print(
        f"[ens] rows {len(laid):,} launched {n_launched:,} | "
        f"source A {Path(args.oof_a).name} (T={args.temp_a}) mean p_cal {float(p_a[laid].mean()):.6f} | "
        f"source B {Path(args.oof_b).name} (T={args.temp_b}) mean p_cal {float(p_b[laid].mean()):.6f} | "
        f"ensemble mean {float(ens[laid].mean()):.6f}",
        flush=True,
    )
    spearman_ab = _spearman(p_a[laid], p_b[laid])
    print(f"[ens] spearman(calibrated A, calibrated B) = {spearman_ab:.6f}", flush=True)

    out = Path(args.out) if args.out else Path("out/torpedo_model/e26e-i/e26e_i_ensemble_oof.npz")
    out.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "method": "mean calibrated probability",
        "prob_clip": PROB_CLIP,
        "temp_a": float(args.temp_a),
        "temp_b": float(args.temp_b),
        "source_a": {"path": a["_path"], "sha256": a["_sha256"], "role": "any-target headC OOF (E26e-g)"},
        "source_b": {"path": b["_path"], "sha256": b["_sha256"], "role": "fish-rate headC OOF (E26e-h)"},
        "launchedRows": n_launched,
        "ensemble": "probC = (sigmoid(logit(probC_a)/T_a) + sigmoid(logit(probC_b)/T_b)) / 2 on launched rows",
        "spearmanCalibratedAB": spearman_ab,
        "headB_unchanged": True,
    }
    np.savez_compressed(out, **build_payload(a, ens, meta))
    print(f"[ens] ensemble npz -> {out} ({out.stat().st_size:,} bytes)", flush=True)

    rank_path = None
    if args.rank_average or args.rank_out:
        rank_path = Path(args.rank_out) if args.rank_out else out.with_name(out.stem.replace("ensemble", "rank") + ".npz")
        rank_path.parent.mkdir(parents=True, exist_ok=True)
        rank_meta = dict(meta)
        rank_meta["method"] = "rank-average (mean within-launched percentile rank, secondary only)"
        np.savez_compressed(rank_path, **build_payload(a, rank, rank_meta))
        print(f"[ens] rank-average npz -> {rank_path} ({rank_path.stat().st_size:,} bytes)", flush=True)

    metrics = {
        "method": "E26e-i headC two-model OOF ensemble (mean calibrated probability, primary)",
        "prob_clip": PROB_CLIP,
        "temps": {"any_target_E26e_g": float(args.temp_a), "fish_rate_E26e_h": float(args.temp_b)},
        "sources": [meta["source_a"], meta["source_b"]],
        "rows": int(len(laid)),
        "launchedRows": n_launched,
        "spearmanCalibratedAB": spearman_ab,
        "stats": {
            "meanCalibratedA": float(p_a[laid].mean()),
            "meanCalibratedB": float(p_b[laid].mean()),
            "meanEnsemble": float(ens[laid].mean()),
            "minEnsemble": float(ens[laid].min()),
            "maxEnsemble": float(ens[laid].max()),
        },
        "outputs": {"ensemble": str(out), "ensemble_sha256": sha256_file(out)},
        "rank_average": ({"path": str(rank_path), "sha256": sha256_file(rank_path)} if rank_path else None),
        "notes": [
            "primary score = mean calibrated probability; only launched rows are scored",
            "rank-average is secondary and never used for the verdict",
            "headB untouched (no retraining); temperatures are the source models' OOF fits",
            "evaluation is external: torpedo_outcome_lift.py --prob-key C --min-lift 2.3",
        ],
    }
    if args.metrics_out:
        mp = Path(args.metrics_out)
        mp.parent.mkdir(parents=True, exist_ok=True)
        mp.write_text(json.dumps(metrics, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"[ens] metrics -> {mp}", flush=True)
    return 0


def run_selftest() -> int:
    import tempfile

    root = Path(tempfile.mkdtemp(prefix="e26i-selftest-"))

    def make(n=20, seed=0):
        rng = np.random.default_rng(seed)
        prob = rng.uniform(0.0, 1.0, n)
        prob[0] = 0.0
        prob[1] = 1.0
        label_b = np.full(n, np.nan, dtype=np.float64)
        label_b[: n // 2] = 1.0
        label_b[n // 2 : n // 2 + 3] = 0.0
        label_c = np.zeros(n, dtype=np.float64)
        label_c[: n // 3] = 1.0
        return {
            "probC": prob.astype(np.float32),
            "labelB": label_b.astype(np.float32),
            "labelC": label_c.astype(np.float32),
            "rowIndex": np.arange(n, dtype=np.int32),
            "fold": (np.arange(n) % 5).astype(np.int8),
            "groupCode": (np.arange(n) % 3).astype(np.int32),
            "shipId": np.arange(100, 100 + n, dtype=np.int64),
            "t": np.arange(n, dtype=np.float32) * 2.0,
            "groupNames": np.array(["g0", "g1", "g2"], dtype="U8"),
            "classCode": (np.arange(n) % 2).astype(np.int8),
            "classNames": np.array(["Destroyer", "Cruiser"], dtype="U16"),
            "regionCode": (np.arange(n) % 2).astype(np.int8),
            "regionNames": np.array(["apac", "own"], dtype="U16"),
            "labelA": np.ones(n, dtype=np.float32),
            "probA": np.zeros(n, dtype=np.float32),
            "probB": np.zeros(n, dtype=np.float32),
        }

    def as_loaded(payload, tag):
        return {**payload, "_path": "synthetic_" + tag, "_sha256": "0" * 64, "_meta": {"synthetic": True}}

    a = as_loaded(make(20, 0), "a")
    b = as_loaded(make(20, 1), "b")
    validate_pair(a, b)  # label-independent alignment keys match by construction

    # probability clip + calibration determinism / monotonicity
    z = logit(np.array([0.0, 1.0, -5.0, 5.0]))
    assert np.all(np.isfinite(z)), z
    cal = calibrate(np.array([0.0, 1.0, 0.5]), 2.0)
    assert np.all((cal >= 0.0) & (cal <= 1.0))
    cal2 = calibrate(np.array([0.0, 1.0, 0.5]), 2.0)
    assert np.array_equal(cal, cal2), "calibration must be deterministic"
    assert float(cal[2]) == 0.5, "p=0.5 stays 0.5 under temperature"
    cal_hi = calibrate(np.array([0.9]), 10.0)
    cal_lo = calibrate(np.array([0.9]), 0.5)
    assert float(cal_hi[0]) < float(cal_lo[0]), "larger T must shrink logits"

    # ensemble: launched rows only, NaN elsewhere, in [0,1]
    p_a, p_b, ens, rank, laid = build_ensemble(a, b, 1.0723, 1.3873)
    assert np.array_equal(np.isfinite(ens), laid), "ensemble must be finite exactly on launched rows"
    assert np.all((ens[laid] >= 0.0) & (ens[laid] <= 1.0))
    assert np.allclose(ens[laid], (p_a[laid] + p_b[laid]) / 2.0)
    e2 = build_ensemble(a, b, 1.0723, 1.3873)[2]
    assert np.allclose(ens[laid], e2[laid]), "ensemble must be deterministic"
    assert np.all((rank[laid] >= 0.0) & (rank[laid] <= 1.0))

    # rank percentile toy contract: monotone, ties averaged, ends at 0/1
    pct = average_rank_pct(np.array([10.0, 20.0, 20.0, 30.0, -1.0]), np.array([True, True, True, True, False]))
    assert abs(pct[0] - 0.0) < 1e-12 and abs(pct[3] - 1.0) < 1e-12, pct
    assert abs(pct[1] - 0.5) < 1e-12 and abs(pct[2] - 0.5) < 1e-12, pct
    assert np.isnan(pct[4])

    # misalignment must abort loudly
    bad = as_loaded(make(20, 1), "bad")
    bad["rowIndex"] = bad["rowIndex"].copy()
    bad["rowIndex"][3] = 999
    failed = False
    try:
        validate_pair(a, bad)
    except SystemExit:
        failed = True
    assert failed is True, "rowIndex mismatch must abort"
    bad2 = as_loaded(make(20, 1), "bad2")
    bad2["labelB"] = bad2["labelB"].copy()
    bad2["labelB"][0] = 0.0  # A has 1.0 there
    failed = False
    try:
        validate_pair(a, bad2)
    except SystemExit:
        failed = True
    assert failed is True, "labelB mismatch must abort"
    bad3 = as_loaded(make(20, 1), "bad3")
    bad3["fold"] = bad3["fold"].copy()
    bad3["fold"][0] = (int(bad3["fold"][0]) + 1) % 5
    failed = False
    try:
        validate_pair(a, bad3)
    except SystemExit:
        failed = True
    assert failed is True, "fold mismatch must abort"

    # end-to-end npz round-trip: write ensemble npz, reload, probC matches
    out = root / "ens.npz"
    np.savez_compressed(out, **build_payload(a, ens, {"method": "selftest"}))
    back = np.load(out, allow_pickle=False)
    assert "probC" in back.files and "meta" in back.files
    assert np.allclose(back["probC"][np.isfinite(back["probC"])], ens[laid], equal_nan=True)
    assert np.array_equal(back["rowIndex"], a["rowIndex"])
    assert "torp2Extras" not in back.files

    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
