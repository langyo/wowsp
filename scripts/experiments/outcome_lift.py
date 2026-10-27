#!/usr/bin/env python3
"""Post-hoc OUTCOME lift evaluation (E13, research note B's strongest offline
evidence).

The E9/E12 metrics answer "does the model agree with the expert" (AUPRC,
decile lift over labelB). This script answers the next question up: **do the
moments the model rates highly actually land hits and remove enemy HP
afterwards?** It consumes the E13 outcome fields the Rust exporter now stamps
on every decision row (`ownerShotsHit` / `ownerShotsFired` /
`enemyHpLostNearby` over the window `(t + labelWindow, t + 45 s]`, plus
`gameMode`), and produces:

  1. EXPERT BASELINE (no model needed): experts firing at a decision moment
     vs holding — window hit rate and enemy-HP-loss totals for the two
     groups. Answers "do good players pick better fire moments at all?"
  2. MODEL DECILE CURVES (needs --model, an ONNX from train_fire_model.py):
     rank can-fire rows by the model's head-B probability, split into ten
     deciles, and report three curves per decile with their Spearman rho
     against the decile's mean predicted probability:
       (a) expert actual fire rate  — the old decile lift (agreement);
       (b) window hit rate          — sum(hit)/sum(fired) per decile;
       (c) mean enemyHpLostNearby   — normalised by the overall mean.
     If (b)/(c) are also monotone, the model learned DECISION QUALITY, not
     fire-frequency imitation — the direct answer to the generalisation
     worry of research note B.

Dataset compatibility: rows WITHOUT outcome fields (pre-E13 exports) are
detected and reported; per-row fields fall back to 0/absent, and the script
refuses to compute outcome curves when no row carries them.

Usage:
    python scripts/experiments/outcome_lift.py --selftest
    python scripts/experiments/outcome_lift.py \
        --data-dir scripts/experiments/out/fire_model/out_datasets/ \
        --model scripts/experiments/out/fire_model/fp32.onnx \
        --exclude-mode pve --exclude-mode event \
        --out scripts/experiments/out/fire_model/outcome_lift.json

Dependencies: numpy always; onnxruntime only with --model (imported lazily).
Featurization is imported from train_fire_model.py so the scoring input can
never drift from the training featurizer.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

import train_fire_model as base

# ── outcome fields from the raw exported rows ────────────────────────────────


def outcome_arrays(rows: list[dict]) -> dict:
    """Pull the E13 outcome fields off raw JSON rows (missing -> 0 / None)."""
    n = len(rows)
    hits = np.zeros(n, dtype=np.float64)
    fired = np.zeros(n, dtype=np.float64)
    hp_lost = np.zeros(n, dtype=np.float64)
    modes = np.empty(n, dtype=object)
    versions = np.empty(n, dtype=object)
    any_outcome = 0
    for i, r in enumerate(rows):
        h = r.get("ownerShotsHit")
        f = r.get("ownerShotsFired")
        d = r.get("enemyHpLostNearby")
        if h is None and f is None and d is None:
            modes[i] = r.get("gameMode")
            versions[i] = r.get("replayVersion")
            continue
        any_outcome += 1
        hits[i] = float(h or 0.0)
        fired[i] = float(f or 0.0)
        hp_lost[i] = float(d or 0.0)
        modes[i] = r.get("gameMode")
        versions[i] = r.get("replayVersion")
    return {
        "hits": hits,
        "fired": fired,
        "hp_lost": hp_lost,
        "mode": modes,
        "version": versions,
        "rows_with_outcome_fields": any_outcome,
    }


# ── 1. expert baseline: fired vs held decision moments ──────────────────────


def expert_baseline(
    label_b: np.ndarray, hits: np.ndarray, fired: np.ndarray, hp_lost: np.ndarray
) -> dict:
    """Outcome comparison of expert-FIRED vs expert-HELD decision moments
    (label-B defined rows only — a hold during reload is physics, censored).

    Hit rate is reported two ways: the pooled rate (sum hits / sum fired —
    every shell counts) and the row-median rate among rows that actually put
    main-battery shells into their window (per-moment accuracy). HP loss is
    the per-row mean/median of the window total."""
    defined = np.isfinite(label_b)
    fired_mask = defined & (label_b == 1)
    held_mask = defined & (label_b == 0)

    def group(m: np.ndarray) -> dict:
        n = int(m.sum())
        h, f, d = hits[m], fired[m], hp_lost[m]
        with_shells = f > 0
        row_rates = h[with_shells] / f[with_shells]
        return {
            "rows": n,
            "pooled_hit_rate": float(h.sum() / f.sum()) if f.sum() > 0 else None,
            "rows_with_window_shells": int(with_shells.sum()),
            "row_hit_rate_median": float(np.median(row_rates)) if len(row_rates) else None,
            "row_hit_rate_mean": float(row_rates.mean()) if len(row_rates) else None,
            "hp_lost_mean": float(d.mean()) if n else None,
            "hp_lost_median": float(np.median(d)) if n else None,
            "hp_lost_p90": float(np.percentile(d, 90)) if n else None,
        }

    g_fired = group(fired_mask)
    g_held = group(held_mask)
    # Effect summary: hit-rate delta (pooled + row-median) and HP-loss ratio.
    pooled_delta = None
    if g_fired["pooled_hit_rate"] is not None and g_held["pooled_hit_rate"] is not None:
        pooled_delta = g_fired["pooled_hit_rate"] - g_held["pooled_hit_rate"]
    median_delta = None
    if g_fired["row_hit_rate_median"] is not None and g_held["row_hit_rate_median"] is not None:
        median_delta = g_fired["row_hit_rate_median"] - g_held["row_hit_rate_median"]
    hp_ratio = None
    if g_held["hp_lost_mean"] not in (None, 0.0) and g_fired["hp_lost_mean"] is not None:
        hp_ratio = g_fired["hp_lost_mean"] / g_held["hp_lost_mean"]
    return {
        "fired": g_fired,
        "held": g_held,
        "pooled_hit_rate_delta": pooled_delta,
        "row_hit_rate_median_delta": median_delta,
        "fired_vs_held_hp_lost_ratio": hp_ratio,
    }


# ── 2. model decile curves ──────────────────────────────────────────────────


def outcome_deciles(
    p: np.ndarray,
    label_b: np.ndarray,
    hits: np.ndarray,
    fired: np.ndarray,
    hp_lost: np.ndarray,
    n_deciles: int = 10,
) -> dict:
    """Rank rows by predicted fire probability (decile 1 = highest), report
    per decile: mean predicted P, expert actual fire rate, pooled window hit
    rate (sum hits / sum fired), mean enemyHpLostNearby (+ normalised by the
    overall mean), plus Spearman rho of meanP vs each curve.

    Rows: label-B DEFINED rows (can-fire) — the head-B domain, matching
    train_fire_model's decile lift; hit-rate deciles keep every row but the
    rate pools numerator/denominator inside the decile, so rows with no
    window shells simply contribute nothing to either side."""
    order = np.argsort(-p, kind="stable")
    parts = np.array_split(order, n_deciles)
    defined = np.isfinite(label_b)
    base_rate = float(label_b[defined].mean()) if defined.any() else float("nan")
    overall_hp = float(hp_lost.mean()) if len(hp_lost) else float("nan")
    deciles = []
    for di, idx in enumerate(parts):
        if len(idx) == 0:
            deciles.append(
                {"decile": di + 1, "n": 0, "meanP": None, "expertFireRate": None,
                 "hitRate": None, "hpLostMean": None, "hpLostNormalized": None}
            )
            continue
        f_sum = float(fired[idx].sum())
        dm = defined[idx]
        fire_rate = float(label_b[idx][dm].mean()) if dm.any() else None
        deciles.append(
            {
                "decile": di + 1,
                "n": int(len(idx)),
                "meanP": float(p[idx].mean()),
                "expertFireRate": fire_rate,
                "hitRate": float(hits[idx].sum() / f_sum) if f_sum > 0 else None,
                "hpLostMean": float(hp_lost[idx].mean()),
                "hpLostNormalized": (
                    float(hp_lost[idx].mean() / overall_hp)
                    if overall_hp and math.isfinite(overall_hp) and overall_hp > 0
                    else None
                ),
            }
        )

    def curve(key: str) -> dict:
        pairs = [
            (d["meanP"], d[key])
            for d in deciles
            if d["n"] > 0 and d["meanP"] is not None and d[key] is not None
        ]
        rho = (
            base.spearman_rho(np.array([a for a, _ in pairs]), np.array([b for _, b in pairs]))
            if len(pairs) >= 3
            else None
        )
        return {"deciles": [d[key] for d in deciles], "spearmanRhoMeanPvsMetric": rho}

    return {
        "rows": int(len(p)),
        "baseFireRate": base_rate,
        "overallHpLostMean": overall_hp,
        "deciles": deciles,
        "expert_fire_rate": curve("expertFireRate"),
        "window_hit_rate": curve("hitRate"),
        "hp_lost_mean": curve("hpLostMean"),
    }


# ── model scoring (onnxruntime, lazy import) ────────────────────────────────


def score_with_onnx(model_path: Path, data: dict, idx: np.ndarray) -> np.ndarray:
    """Head-B probabilities for rows `idx` via a train_fire_model ONNX export
    (static batch 1 — loop per row). Returns sigmoid(logitB)."""
    try:
        import onnxruntime as ort
    except ImportError:
        raise SystemExit(
            "[e13] onnxruntime is missing — install it (pip install onnxruntime) "
            "or rerun without --model for the expert baseline only"
        ) from None
    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    n = len(idx)
    p = np.zeros(n, dtype=np.float64)
    for j, i in enumerate(idx):
        (lb,) = sess.run(
            None,
            {
                "entity": data["entity"][i : i + 1].astype(np.float32),
                "global_feat": data["global"][i : i + 1].astype(np.float32),
                "mask": data["mask"][i : i + 1].astype(np.float32),
            },
        )[1:]
        p[j] = 1.0 / (1.0 + math.exp(-float(np.asarray(lb).reshape(-1)[0])))
    return p


# ── selftest (torch/onnx-free) ───────────────────────────────────────────────


def run_selftest() -> int:
    # outcome_arrays: present / absent fields.
    rows = [
        {"ownerShotsHit": 2, "ownerShotsFired": 4, "enemyHpLostNearby": 1200.0,
         "gameMode": "pvp", "replayVersion": "15.8.0"},
        {"gameMode": "pvp"},  # pre-E13 row: everything defaults
        {"ownerShotsHit": 0, "ownerShotsFired": 6, "enemyHpLostNearby": 0.0},
    ]
    oa = outcome_arrays(rows)
    assert oa["rows_with_outcome_fields"] == 2
    assert oa["hits"].tolist() == [2.0, 0.0, 0.0]
    assert oa["fired"].tolist() == [4.0, 0.0, 6.0]
    assert oa["hp_lost"].tolist() == [1200.0, 0.0, 0.0]
    assert oa["mode"][0] == "pvp" and oa["mode"][2] is None

    # Expert baseline: fired rows get systematically better windows.
    y = np.array([1] * 50 + [0] * 50, dtype=np.float64)
    hits = np.concatenate([np.full(50, 3.0), np.full(50, 1.0)])
    fired = np.concatenate([np.full(50, 6.0), np.full(50, 6.0)])
    hp = np.concatenate([np.full(50, 3000.0), np.full(50, 1000.0)])
    eb = expert_baseline(y, hits, fired, hp)
    assert eb["fired"]["rows"] == 50 and eb["held"]["rows"] == 50
    assert abs(eb["fired"]["pooled_hit_rate"] - 0.5) < 1e-9
    assert abs(eb["held"]["pooled_hit_rate"] - (1 / 6)) < 1e-9
    assert eb["pooled_hit_rate_delta"] > 0.3
    assert abs(eb["fired_vs_held_hp_lost_ratio"] - 3.0) < 1e-9
    # Censored rows (NaN labelB) join neither group.
    y2 = y.copy()
    y2[:10] = np.nan
    eb2 = expert_baseline(y2, hits, fired, hp)
    assert eb2["fired"]["rows"] == 40 and eb2["held"]["rows"] == 50

    # Decile curves: block d (0..9) gets fire rate (9-d)/10, hit rate
    # (9-d)/10 and hp (9-d)*100 — all strictly monotone with a descending
    # meanP -> rho +1 for every curve; constant metric -> rho None;
    # ANTI-monotone metric -> rho -1.
    n = 1000
    p = np.concatenate([np.full(100, 0.95 - 0.09 * d) for d in range(10)])
    lab = np.concatenate(
        [np.array([1.0] * (10 * (9 - d)) + [0.0] * (10 * (d + 1))) for d in range(10)]
    )
    hi = np.concatenate([np.full(100, 9.0 - d) for d in range(10)])  # hits/10 shells
    fi = np.full(n, 10.0)
    hp2 = np.concatenate([np.full(100, 100.0 * (9 - d)) for d in range(10)])
    dec = outcome_deciles(p, lab, hi, fi, hp2)
    assert dec["deciles"][0]["n"] == 100 and dec["deciles"][9]["n"] == 100
    assert dec["expert_fire_rate"]["spearmanRhoMeanPvsMetric"] > 0.99
    assert dec["window_hit_rate"]["spearmanRhoMeanPvsMetric"] > 0.99
    assert dec["hp_lost_mean"]["spearmanRhoMeanPvsMetric"] > 0.99
    assert dec["deciles"][0]["hitRate"] == 0.9 and dec["deciles"][9]["hitRate"] == 0.0
    # overall hp mean = 450; top decile 900 -> normalized 2.0 exactly.
    assert abs(dec["deciles"][0]["hpLostNormalized"] - 2.0) < 1e-9
    anti = outcome_deciles(p, lab, hi[::-1].copy(), fi, hp2)
    assert anti["window_hit_rate"]["spearmanRhoMeanPvsMetric"] < -0.99
    flat = outcome_deciles(p, lab, np.full(n, 5.0), fi, hp2)
    assert flat["window_hit_rate"]["spearmanRhoMeanPvsMetric"] is None
    # Empty-input degeneracy: no crash, empty deciles.
    empty = outcome_deciles(np.zeros(0), np.zeros(0), np.zeros(0), np.zeros(0), np.zeros(0))
    assert empty["rows"] == 0 and empty["deciles"][0]["n"] == 0
    print("[selftest] E13 outcome-lift logic OK (arrays/baseline/deciles/rhos)")
    return 0


# ── main ─────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(
        description=(
            "E13: post-hoc OUTCOME lift — expert fired-vs-held baseline plus "
            "model-decile curves over hit rate / enemy HP lost (research "
            "note B's strongest offline evidence)."
        )
    )
    p.add_argument("--data", action="append", default=None,
                   help="JSONL dataset from the E13 Rust export (repeatable)")
    p.add_argument("--data-dir", default=None,
                   help="additionally load every *.jsonl under this directory (recursive)")
    p.add_argument("--model", type=Path, default=None,
                   help="train_fire_model ONNX export (fp32/int8) for the decile curves; "
                        "omit for the expert baseline only")
    p.add_argument("--out", type=Path, default=None,
                   help="output JSON (default <data-dir>/outcome_lift.json or ./outcome_lift.json)")
    p.add_argument("--exclude-mode", action="append", default=None,
                   metavar="MODE",
                   help="drop rows whose gameMode matches (repeatable, e.g. "
                        "--exclude-mode pve --exclude-mode event for ops/bot modes)")
    p.add_argument("--min-version", default=None,
                   help="keep only rows whose replayVersion starts with this prefix "
                        "(e.g. 15.8) — analyse one distribution slice")
    p.add_argument("--selftest", action="store_true",
                   help="torch/onnx-free synthetic self-test of the analysis logic")
    a = p.parse_args(argv)
    if a.out is None:
        base_dir = Path(a.data_dir) if a.data_dir else (
            Path(a.data[-1]).parent if a.data else Path(".")
        )
        a.out = base_dir / "outcome_lift.json"
    return a


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.selftest:
        return run_selftest()

    paths = [Path(d) for d in (args.data or [])]
    if args.data_dir:
        paths.extend(sorted(Path(args.data_dir).rglob("*.jsonl")))
    if not paths:
        raise SystemExit("[e13] no dataset files (check --data / --data-dir)")
    for q in paths:
        if not q.is_file():
            raise SystemExit(f"[e13] dataset not found: {q}")

    data = base.load_datasets(paths)
    rows: list[dict] = data["rows_meta"]
    oa = outcome_arrays(rows)
    if oa["rows_with_outcome_fields"] == 0:
        raise SystemExit(
            "[e13] no row carries outcome fields — re-export the dataset with the "
            "post-#1418 fire_dataset.rs (E13) batch exporter first"
        )

    # Mode / version filters (ops and other non-randoms modes pollute the
    # decision distribution — Halloween ops in particular).
    keep = np.ones(len(rows), dtype=bool)
    mode_hist: dict[str | None, int] = {}
    for i, m in enumerate(oa["mode"]):
        mode_hist[m] = mode_hist.get(m, 0) + 1
    dropped_mode = 0
    if args.exclude_mode:
        ex = set(args.exclude_mode)
        keep &= np.array([m not in ex for m in oa["mode"]])
        dropped_mode = int((~keep).sum())
    version_hist: dict[str | None, int] = {}
    for v in oa["version"]:
        version_hist[v] = version_hist.get(v, 0) + 1
    if args.min_version:
        pref = base.normalize_version_prefix(args.min_version)
        keep &= np.array(
            [
                v is not None and str(base.row_version_prefix(str(v)) or "").startswith(pref)
                for v in oa["version"]
            ]
        )

    idx = np.flatnonzero(keep)
    if len(idx) == 0:
        raise SystemExit("[e13] every row filtered away (check --exclude-mode / --min-version)")
    print(
        f"[e13] {len(rows)} rows ({oa['rows_with_outcome_fields']} with outcome fields) "
        f"over {len(set(data['group']))} replays; kept {len(idx)}"
        + (f" (dropped {dropped_mode} by --exclude-mode)" if args.exclude_mode else "")
    )
    print(f"[e13] gameMode histogram: {mode_hist}")
    print(f"[e13] replayVersion histogram: {version_hist}")

    label_b = data["label_b"][idx]
    hits, fired, hp_lost = oa["hits"][idx], oa["fired"][idx], oa["hp_lost"][idx]

    report: dict = {
        "dataset": [str(q) for q in paths],
        "rows_total": int(len(rows)),
        "rows_analyzed": int(len(idx)),
        "rows_with_outcome_fields": int(oa["rows_with_outcome_fields"]),
        "game_mode_histogram": {str(k): v for k, v in mode_hist.items()},
        "replay_version_histogram": {str(k): v for k, v in version_hist.items()},
        "excluded_modes": args.exclude_mode or [],
        "min_version": args.min_version,
    }

    # 1. Expert baseline over label-B defined rows.
    defined = np.isfinite(label_b)
    eb = expert_baseline(label_b, hits, fired, hp_lost)
    report["expert_baseline"] = eb
    print(
        f"[e13] expert baseline over {int(defined.sum())} can-fire rows: "
        f"fired(n={eb['fired']['rows']}) pooled hit-rate "
        f"{eb['fired']['pooled_hit_rate'] if eb['fired']['pooled_hit_rate'] is None else round(eb['fired']['pooled_hit_rate'], 4)} "
        f"vs held(n={eb['held']['rows']}) "
        f"{eb['held']['pooled_hit_rate'] if eb['held']['pooled_hit_rate'] is None else round(eb['held']['pooled_hit_rate'], 4)} "
        f"(delta {eb['pooled_hit_rate_delta'] if eb['pooled_hit_rate_delta'] is None else round(eb['pooled_hit_rate_delta'], 4)}); "
        f"HP-loss ratio fired/held "
        f"{eb['fired_vs_held_hp_lost_ratio'] if eb['fired_vs_held_hp_lost_ratio'] is None else round(eb['fired_vs_held_hp_lost_ratio'], 3)}"
    )

    # 2. Model decile curves (can-fire rows only, where head B is defined —
    # the same domain as train_fire_model's decile lift).
    if args.model is not None:
        if not args.model.is_file():
            raise SystemExit(f"[e13] model not found: {args.model}")
        p = score_with_onnx(args.model, data, idx)
        dec_mask = np.isfinite(label_b)
        dec = outcome_deciles(
            p[dec_mask], label_b[dec_mask], hits[dec_mask], fired[dec_mask], hp_lost[dec_mask]
        )
        report["model_deciles"] = {
            "model": str(args.model),
            **dec,
        }
        r_fire = dec["expert_fire_rate"]["spearmanRhoMeanPvsMetric"]
        r_hit = dec["window_hit_rate"]["spearmanRhoMeanPvsMetric"]
        r_hp = dec["hp_lost_mean"]["spearmanRhoMeanPvsMetric"]
        fmt = lambda r: "None" if r is None else f"{r:+.3f}"  # noqa: E731
        print(
            f"[e13] model decile curves (n={dec['rows']}): rho fire-rate {fmt(r_fire)}, "
            f"window hit-rate {fmt(r_hit)}, hp-lost {fmt(r_hp)}"
        )
        for d in dec["deciles"]:
            hr = d["hitRate"] if d["hitRate"] is None else round(d["hitRate"], 4)
            hpn = d["hpLostNormalized"] if d["hpLostNormalized"] is None else round(d["hpLostNormalized"], 3)
            print(
                f"[e13]   decile {d['decile']:2d}: meanP {d['meanP']:.4f} "
                f"fireRate {d['expertFireRate']:.4f} hitRate {hr} hpNorm {hpn} (n={d['n']})"
            )
    else:
        report["model_deciles"] = {"status": "skipped — no --model given"}

    def jsonable(o):
        if isinstance(o, dict):
            return {str(k): jsonable(v) for k, v in o.items()}
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

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(jsonable(report), indent=2), encoding="utf-8")
    print(f"[e13] wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
