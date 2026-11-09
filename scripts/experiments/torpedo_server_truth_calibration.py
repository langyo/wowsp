#!/usr/bin/env python3
"""E26e-n: absolute-probability calibration of headC against server damageStat truth.

E26e-m showed the proxy hit label undercounts the absolute hit rate (24.37% vs
the server 40.14% on recorder rows). This script asks whether headC's raw
probability can be recalibrated to the server truth **without retraining**, using
only a replay-held-out calibration map:

  * primary: Platt scaling -- logistic regression on logit(p)  (numpy IRLS)
  * secondary: isotonic regression -- PAVA over p               (numpy)

Truth rows are rebuilt from the E26e-m rows/damage sidecars with the audit
helpers (torpedo_server_truth_audit.load_damage/server_delta): recorder row
(ownerEntityId == recorderEntityId), launched (labelB=true & fired>0), server
delta in (t, t+2+120] clamped to fired > 0 => truth label.

5-fold GroupKFold by replayId (deterministic greedy size-balanced assignment);
calibrators are fit on train folds and scored out-of-fold on the test fold. The
model itself is untouched; ranking is invariant under the monotone maps, so the
fish-level top-decile outcome lift is reported for raw/Platt/isotonic.

Outputs: out/torpedo_model/e26e-n/calibration_metrics.json and
         out/torpedo_model/e26e-n/server_truth_calibrated.npz (diagnostic).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

PROB_EPS = 1e-7
LOGIT_CLIP = 1e-6
ECE_BINS = 15
N_FOLDS = 5
SEED = 0
MIN_ROWS = 200


def sigmoid(z):
    z = np.asarray(z, dtype=np.float64)
    out = np.empty_like(z)
    pos = z >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-z[pos]))
    ez = np.exp(z[~pos])
    out[~pos] = ez / (1.0 + ez)
    return out


def logit(p):
    p = np.clip(np.asarray(p, dtype=np.float64), LOGIT_CLIP, 1.0 - LOGIT_CLIP)
    return np.log(p) - np.log1p(-p)


def brier_score(y, p) -> float:
    return float(np.mean((np.asarray(p, dtype=np.float64) - np.asarray(y, dtype=np.float64)) ** 2))


def log_loss(y, p) -> float:
    y = np.asarray(y, dtype=np.float64)
    p = np.clip(np.asarray(p, dtype=np.float64), PROB_EPS, 1.0 - PROB_EPS)
    return float(-np.mean(y * np.log(p) + (1.0 - y) * np.log1p(-p)))


def ece_score(y, p, bins: int = ECE_BINS):
    y = np.asarray(y, dtype=np.float64)
    p = np.clip(np.asarray(p, dtype=np.float64), 0.0, 1.0)
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = 0.0
    table = []
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        m = (p >= lo) & ((p < hi) if i < bins - 1 else (p <= hi))
        n = int(m.sum())
        if n == 0:
            table.append({"bin": i + 1, "n": 0, "meanProb": None, "hitRate": None})
            continue
        mp = float(p[m].mean())
        hr = float(y[m].mean())
        total += n * abs(hr - mp)
        table.append({"bin": i + 1, "n": n, "meanProb": mp, "hitRate": hr})
    return (float(total / len(y)) if len(y) else None), table


def roc_auc(y, p):
    y = np.asarray(y, dtype=np.float64)
    p = np.asarray(p, dtype=np.float64)
    pos = int(y.sum())
    neg = len(y) - pos
    if pos == 0 or neg == 0:
        return None
    ranks = np.empty(len(p), dtype=np.float64)
    order = np.argsort(p, kind="mergesort")
    ranks[order] = np.arange(1, len(p) + 1, dtype=np.float64)
    ux, inv = np.unique(p, return_inverse=True)
    for g in np.unique(inv):
        m = inv == g
        ranks[m] = ranks[m].mean()
    rank_sum = ranks[y == 1.0].sum()
    return float((rank_sum - pos * (pos + 1) / 2.0) / (pos * neg))


def top_decile_lift(prob, fired, hits, k: int = 10):
    """Fish-level top-decile hit-rate lift (same contract as torpedo_outcome_lift)."""
    prob = np.asarray(prob, dtype=np.float64)
    fired = np.asarray(fired, dtype=np.float64)
    hits = np.asarray(hits, dtype=np.float64)
    base_f = float(fired.sum())
    base_h = float(hits.sum())
    if base_f <= 0:
        return None, None
    base = base_h / base_f
    order = np.argsort(-prob, kind="mergesort")
    n = len(prob)
    dec = np.empty(n, dtype=np.int32)
    for i, idx in enumerate(order):
        dec[idx] = min(int(i * k / max(n, 1)), k - 1) + 1
    top = dec == 1
    top_f = float(fired[top].sum())
    if top_f <= 0:
        return None, base
    return (float(hits[top].sum()) / top_f) / base, base


def group_folds(groups, n_folds: int, seed: int) -> np.ndarray:
    """Deterministic size-balanced GroupKFold assignment (groups = replay ids)."""
    uniq = sorted({str(g) for g in groups})
    sizes = {g: 0 for g in uniq}
    for g in groups:
        sizes[str(g)] += 1
    rng = np.random.default_rng(seed)
    # longest-processing-time greedy on sizes (deterministic), then random fold labels
    order = sorted(uniq, key=lambda g: (-sizes[g], g))
    totals = np.zeros(n_folds, dtype=np.int64)
    fold_of = {}
    for g in order:
        k = int(np.argmin(totals))
        fold_of[g] = k
        totals[k] += sizes[g]
    labels = rng.permutation(n_folds)
    return np.array([int(labels[fold_of[str(g)]]) for g in groups], dtype=np.int64)


def fit_platt(z, y, iters: int = 100, ridge: float = 1e-9):
    """Logistic regression y ~ sigmoid(a*z+b) via IRLS; returns (a, b)."""
    z = np.asarray(z, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if y.sum() in (0.0, float(len(y))):
        return 1.0, 0.0
    def loglik(a_, b_):
        mu_ = np.clip(sigmoid(a_ * z + b_), 1e-12, 1.0 - 1e-12)
        return float((y * np.log(mu_) + (1.0 - y) * np.log1p(-mu_)).sum())

    a, b = 1.0, 0.0
    ll = loglik(a, b)
    for _ in range(iters):
        mu = sigmoid(a * z + b)
        w = np.maximum(mu * (1.0 - mu), 1e-9)
        # design order is [slope, intercept] so the Newton step is (da, db)
        r = np.array([(y * z).sum() - (mu * z).sum(), y.sum() - mu.sum()], dtype=np.float64)
        H = np.array([[(w * z * z).sum(), (w * z).sum()], [(w * z).sum(), w.sum()]], dtype=np.float64)
        H[0, 0] += ridge
        H[1, 1] += ridge
        try:
            delta = np.linalg.solve(H, r)
        except np.linalg.LinAlgError:
            break
        # backtracking line search: Newton can overshoot far from the optimum
        alpha = 1.0
        accepted = False
        for _ls in range(40):
            a_new = a + alpha * float(delta[0])
            b_new = b + alpha * float(delta[1])
            ll_new = loglik(a_new, b_new)
            if np.isfinite(ll_new) and ll_new > ll + 1e-12:
                a, b, ll = a_new, b_new, ll_new
                accepted = True
                break
            alpha *= 0.5
        if not accepted:
            break
        if alpha * float(np.max(np.abs(delta))) < 1e-10:
            break
    if not np.isfinite(a) or not np.isfinite(b):
        return 1.0, 0.0
    return float(a), float(b)


def fit_isotonic_pava(p, y):
    """PAVA isotonic regression; returns (knots_x, knots_y) piecewise-constant map."""
    p = np.asarray(p, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    order = np.argsort(p, kind="mergesort")
    xs = p[order]
    ys = y[order]
    ux, start = np.unique(xs, return_index=True)
    counts = np.diff(np.append(start, len(xs)))
    vals = np.array([ys[start[i]:start[i] + counts[i]].sum() / counts[i] for i in range(len(ux))], dtype=np.float64)
    w = counts.astype(np.float64)
    vals_list = list(vals)
    w_list = list(w)
    i = 0
    while i < len(vals_list) - 1:
        if vals_list[i] > vals_list[i + 1]:
            total = w_list[i] + w_list[i + 1]
            v = (vals_list[i] * w_list[i] + vals_list[i + 1] * w_list[i + 1]) / total
            vals_list[i:i + 2] = [v]
            w_list[i:i + 2] = [total]
            if i > 0:
                i -= 1
        else:
            i += 1
    out_vals = []
    for v, wi in zip(vals_list, w_list):
        out_vals.extend([v] * int(round(wi)))
    out_vals = np.array(out_vals, dtype=np.float64)
    if len(out_vals) != len(ux):
        if len(out_vals) < len(ux):
            out_vals = np.concatenate([out_vals, np.full(len(ux) - len(out_vals), out_vals[-1])])
        else:
            out_vals = out_vals[: len(ux)]
    return ux, out_vals


def predict_isotonic(knots_x, knots_y, p):
    p = np.asarray(p, dtype=np.float64)
    idx = np.searchsorted(knots_x, p, side="right") - 1
    idx = np.clip(idx, 0, len(knots_y) - 1)
    return np.clip(knots_y[idx], 0.0, 1.0)


def build_truth_rows(rows_paths, damage_paths, oof_path, log=print):
    import torpedo_server_truth_audit as audit

    z = np.load(oof_path, allow_pickle=False)
    need = ("probC", "labelB", "groupCode", "groupNames", "t", "shipId", "rowIndex")
    for key in need:
        if key not in z.files:
            raise SystemExit("[e26n] OOF missing key: " + key)
    probC = z["probC"].astype(np.float64)
    group_names = [str(x) for x in z["groupNames"].tolist()]
    group_code = z["groupCode"]
    t_oof = z["t"].astype(np.float64)
    ship_oof = z["shipId"].astype(np.int64)
    n = len(probC)
    rows = []
    mismatch = 0
    scanned = 0
    gidx = 0
    for rows_path, damage_path in zip(rows_paths, damage_paths):
        dmg = audit.load_damage(damage_path)
        timelines = dmg["timelines"]
        with Path(rows_path).open("r", encoding="utf-8") as f:
            for line in f:
                st = line.strip()
                if not st:
                    continue
                row = json.loads(st)
                scanned += 1
                rid = str(audit.pick(row, "replayId"))
                t = float(audit.pick(row, "t"))
                ship = int(audit.pick(row, "shipId"))
                label_b = audit.pick(row, "labelB")
                fired = int(audit.pick(row, "fired") or 0)
                proxy_hits = int(audit.pick(row, "hits") or 0)
                owner = audit.pick(row, "owner")
                launched = bool(label_b) and fired > 0
                tl = timelines.get(rid)
                recorder = tl.get("recorder") if tl is not None else None
                recorder_row = False
                try:
                    recorder_row = recorder is not None and owner is not None and int(owner) == int(recorder)
                except (TypeError, ValueError):
                    recorder_row = False
                if launched and recorder_row and tl is not None:
                    delta = audit.server_delta(tl, t, fired)
                    if delta is not None:
                        expect_replay = group_names[int(group_code[gidx])]
                        if (rid != expect_replay or abs(t - float(t_oof[gidx])) > 1e-3
                                or ship != int(ship_oof[gidx])):
                            mismatch += 1
                        rows.append({
                            "index": gidx,
                            "replay": rid,
                            "prob": float(probC[gidx]),
                            "fired": fired,
                            "proxyHits": proxy_hits,
                            "serverDelta": float(delta),
                            "y": 1.0 if delta > 0.0 else 0.0,
                        })
                gidx += 1
    if scanned != n or gidx != n:
        raise SystemExit("[e26n] sidecar rows " + str(scanned) + " != OOF rows " + str(n))
    if mismatch:
        raise SystemExit("[e26n] truth rows misaligned with OOF (replay/t/ship): " + str(mismatch))
    if not rows:
        raise SystemExit("[e26n] no truth rows")
    return {
        "rows": rows,
        "oofRows": n,
        "scanned": scanned,
        "replays": int(len({r["replay"] for r in rows})),
        "positives": int(sum(r["y"] for r in rows)),
        "firedFish": int(sum(r["fired"] for r in rows)),
        "serverHits": int(sum(r["serverDelta"] for r in rows)),
    }


def evaluate_map(y, prob, fired, hits):
    """y = row-level server truth (delta>0); hits = fish-level server delta (E26e-m lift口径)."""
    ece, rel = ece_score(y, prob)
    lift, base = top_decile_lift(prob, fired, np.asarray(hits, dtype=np.float64))
    return {
        "brier": brier_score(y, prob),
        "logloss": log_loss(y, prob),
        "ece": ece,
        "auc": roc_auc(y, prob),
        "lift": lift,
        "baseRate": base,
        "meanProb": float(np.mean(prob)),
        "hitRate": float(np.mean(y)),
        "reliability": rel,
    }


def bootstrap_paired(y, p_raw, p_platt, fired, hits, groups, reps, seed):
    uniq = sorted({str(g) for g in groups})
    idx_by_group = {g: np.flatnonzero(np.array([str(x) == g for x in groups])) for g in uniq}
    rng = np.random.default_rng(seed)
    out = {"brierDiff": [], "loglossDiff": [], "liftDiff": []}
    for _ in range(int(reps)):
        pick = rng.integers(0, len(uniq), size=len(uniq))
        idx = np.concatenate([idx_by_group[uniq[i]] for i in pick]) if len(uniq) else np.array([], dtype=np.int64)
        if not len(idx):
            continue
        out["brierDiff"].append(brier_score(y[idx], p_raw[idx]) - brier_score(y[idx], p_platt[idx]))
        out["loglossDiff"].append(log_loss(y[idx], p_raw[idx]) - log_loss(y[idx], p_platt[idx]))
        lr, _ = top_decile_lift(p_raw[idx], fired[idx], hits[idx])
        lp, _ = top_decile_lift(p_platt[idx], fired[idx], hits[idx])
        if lr is not None and lp is not None:
            out["liftDiff"].append(lr - lp)

    def ci(vals):
        if not vals:
            return None
        a = np.asarray(vals, dtype=np.float64)
        return [float(np.quantile(a, 0.025)), float(np.quantile(a, 0.975))]

    return {k: {"mean": float(np.mean(v)) if v else None, "ci95": ci(v)} for k, v in out.items()}


def run(args) -> int:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    data = build_truth_rows([Path(p) for p in args.rows], [Path(p) for p in args.damage], Path(args.oof))
    rows = data["rows"]
    y = np.array([r["y"] for r in rows], dtype=np.float64)
    p = np.array([r["prob"] for r in rows], dtype=np.float64)
    fired = np.array([r["fired"] for r in rows], dtype=np.int64)
    delta = np.array([r["serverDelta"] for r in rows], dtype=np.float64)
    groups = [r["replay"] for r in rows]
    n = len(rows)
    print("[e26n] truth rows " + format(n, ",") + " (positives " + format(int(y.sum()), ",") + ", replays "
          + format(data["replays"], ",") + ", fired " + format(data["firedFish"], ",") + ")", flush=True)
    folds = group_folds(groups, args.folds, args.seed)
    p_platt = np.full(n, np.nan, dtype=np.float64)
    p_iso = np.full(n, np.nan, dtype=np.float64)
    fold_params = []
    per_fold = []
    for k in range(args.folds):
        train = folds != k
        test = folds == k
        if int(train.sum()) == 0 or int(test.sum()) == 0:
            continue
        a, b = fit_platt(logit(p[train]), y[train])
        zx, zy = fit_isotonic_pava(p[train], y[train])
        p_platt[test] = sigmoid(a * logit(p[test]) + b)
        p_iso[test] = predict_isotonic(zx, zy, p[test])
        fold_params.append({"fold": k, "train": int(train.sum()), "test": int(test.sum()),
                            "testPositives": int(y[test].sum()), "plattA": a, "plattB": b, "isoKnots": int(len(zx))})
        raw_f = evaluate_map(y[test], p[test], fired[test], delta[test])
        platt_f = evaluate_map(y[test], p_platt[test], fired[test], delta[test])
        iso_f = evaluate_map(y[test], p_iso[test], fired[test], delta[test])
        per_fold.append({
            "fold": k, "train": int(train.sum()), "test": int(test.sum()), "testPositives": int(y[test].sum()),
            "raw": {m: raw_f[m] for m in ("brier", "logloss", "ece", "auc", "lift")},
            "platt": {m: platt_f[m] for m in ("brier", "logloss", "ece", "auc", "lift")},
            "isotonic": {m: iso_f[m] for m in ("brier", "logloss", "ece", "auc", "lift")},
        })
    ok = np.isfinite(p_platt) & np.isfinite(p_iso)
    raw = evaluate_map(y, p, fired, delta)
    raw_ok = evaluate_map(y[ok], p[ok], fired[ok], delta[ok])
    platt = evaluate_map(y[ok], p_platt[ok], fired[ok], delta[ok])
    iso = evaluate_map(y[ok], p_iso[ok], fired[ok], delta[ok])
    brier_rel = (raw_ok["brier"] - platt["brier"]) / raw_ok["brier"]
    ll_drop = raw_ok["logloss"] - platt["logloss"]
    boot = bootstrap_paired(y, p, p_platt, fired, delta, groups, args.bootstrap, args.seed)
    # held-out lift invariance: monotone Platt is rank-identical inside each test fold.
    # Pooled lift mixes fold-specific maps (not comparable), so it is reported only.
    lift_deltas = [abs((f["platt"]["lift"] if f["platt"]["lift"] is not None else 0.0)
                       - (f["raw"]["lift"] if f["raw"]["lift"] is not None else 0.0)) for f in per_fold]
    max_fold_lift_delta = max(lift_deltas) if lift_deltas else None
    lift_ok = max_fold_lift_delta is not None and max_fold_lift_delta <= 0.02
    verdict = bool(n >= MIN_ROWS and brier_rel >= 0.05 and ll_drop > 0.0 and lift_ok)
    result = {
        "lineage": "E26e-n headC server-truth absolute probability calibration (no retraining)",
        "protocol": {
            "folds": int(args.folds), "seed": int(args.seed), "bootstrap": int(args.bootstrap),
            "primary": "Platt (logistic on logit(p))", "secondary": "isotonic (PAVA)",
            "foldRule": "GroupKFold by replayId (deterministic greedy size-balanced)",
            "probClip": LOGIT_CLIP, "minRows": MIN_ROWS,
        },
        "data": {
            "rows": data["oofRows"], "truthRows": n, "positives": int(y.sum()), "replays": data["replays"],
            "firedFish": data["firedFish"], "serverHits": data["serverHits"], "serverHitRate": float(y.mean()),
        },
        "raw": raw,
        "platt": platt,
        "isotonic": iso,
        "deltas": {
            "brierRelImprovement": float(brier_rel),
            "loglossDrop": float(ll_drop),
            "brierDelta": float(raw_ok["brier"] - platt["brier"]),
            "loglossDelta": float(raw_ok["logloss"] - platt["logloss"]),
            "eceRaw": raw["ece"], "ecePlatt": platt["ece"], "eceIso": iso["ece"],
            "liftRaw": raw["lift"], "liftPlatt": platt["lift"], "liftIso": iso["lift"],
            "maxFoldLiftDelta": max_fold_lift_delta,
            "pooledLiftDelta": ((raw["lift"] or 0.0) - (platt["lift"] or 0.0)),
            "bootstrap": boot,
        },
        "perFold": per_fold,
        "foldParams": fold_params,
        "verdict": "PASS" if verdict else "MIXED",
        "verdictRule": "truth rows >= 200 and Platt held-out Brier relative improvement >= 5% and logloss drops and held-out lift preserved (max per-fold |dLift| <= 0.02; pooled lift reported only)",
        "notes": [
            "calibrators are fit out-of-fold by replayId; the headC model itself is untouched",
            "lift preservation is checked per held-out fold (raw vs Platt are rank-identical there); the pooled lift mixes fold-specific maps and is not a valid invariance check",
            "monotone maps preserve ranking; lift differences come only from finite deciles / isotonic ties",
            "server truth is recorder-only (ownerEntityId == recorderEntityId); rows/damage sidecars are E26e-m",
            "raw probabilities are the E26e-g OOF probC (sigmoid of model logits, no temperature applied)",
            "the E26e-m audit found the proxy label undercounts absolute hit rate; calibration fixes probability semantics only",
        ],
    }
    np.savez_compressed(
        out_dir / "server_truth_calibrated.npz",
        rowIndex=np.array([r["index"] for r in rows], dtype=np.int64),
        probC_raw=p.astype(np.float32),
        probC_platt=p_platt.astype(np.float32),
        probC_isotonic=p_iso.astype(np.float32),
        y=y.astype(np.float32),
        fired=fired.astype(np.int32),
        serverDelta=np.array([r["serverDelta"] for r in rows], dtype=np.float32),
        fold=folds.astype(np.int8),
    )
    metrics_path = out_dir / "calibration_metrics.json"
    metrics_path.write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    print("[e26n] raw   brier {:.6f} logloss {:.6f} ece {:.6f} lift {}".format(raw_ok["brier"], raw_ok["logloss"], raw_ok["ece"], raw["lift"]), flush=True)
    print("[e26n] platt brier {:.6f} logloss {:.6f} ece {:.6f} lift {}".format(platt["brier"], platt["logloss"], platt["ece"], platt["lift"]), flush=True)
    print("[e26n] iso   brier {:.6f} logloss {:.6f} ece {:.6f} lift {}".format(iso["brier"], iso["logloss"], iso["ece"], iso["lift"]), flush=True)
    print("[e26n] verdict {} (brier rel improvement {:.2f}%, logloss drop {:.6f})".format(result["verdict"], brier_rel * 100.0, ll_drop), flush=True)
    print("[e26n] metrics -> " + str(metrics_path), flush=True)
    return 0


def run_selftest() -> int:
    # basic probability helpers
    assert abs(float(sigmoid(np.array([0.0]))[0]) - 0.5) < 1e-12
    z = np.array([-2.0, -0.5, 0.5, 2.0])
    assert np.allclose(logit(sigmoid(z)), z)
    assert abs(brier_score(np.array([1.0, 0.0]), np.array([0.8, 0.2])) - ((0.04 + 0.04) / 2.0)) < 1e-12
    ll = log_loss(np.array([1.0, 0.0]), np.array([0.8, 0.2]))
    assert abs(ll - (-np.log(0.8))) < 1e-12, ll
    # perfectly calibrated ECE
    y = np.array([0.0] * 50 + [1.0] * 50)
    p = np.array([0.0] * 50 + [1.0] * 50)
    ece, _ = ece_score(y, p)
    assert abs(ece) < 1e-12
    # top-decile lift: top decile all hits -> lift = 1/base
    prob = np.linspace(0.0, 1.0, 100)
    fired = np.ones(100)
    hits = (prob >= 0.9).astype(float)
    lift, base = top_decile_lift(prob, fired, hits)
    assert base == 0.1 and abs(lift - 10.0) < 1e-9, (lift, base)
    # grouped folds: every replay in exactly one fold, all folds non-empty, balanced-ish
    groups = ["a"] * 30 + ["b"] * 25 + ["c"] * 20 + ["d"] * 15 + ["e"] * 10
    folds = group_folds(groups, 5, 0)
    assert len(folds) == len(groups)
    for g in set(groups):
        assert len(set(folds[np.array([x == g for x in groups])])) == 1
    assert set(folds.tolist()) == {0, 1, 2, 3, 4}
    counts = sorted(int((folds == k).sum()) for k in range(5))
    assert counts == sorted([sizes for sizes in (30, 25, 20, 15, 10)]) or max(counts) - min(counts) <= 20, counts
    many = ["g%d" % (i % 50) for i in range(500)]
    folds_m = group_folds(many, 5, 0)
    counts_m = [int((folds_m == k).sum()) for k in range(5)]
    assert max(counts_m) - min(counts_m) <= 60, counts_m
    # determinism
    assert np.array_equal(folds, group_folds(groups, 5, 0))
    # Platt recovers a synthetic logistic slope/intercept
    rng = np.random.default_rng(7)
    zz = rng.normal(0.0, 1.5, size=4000)
    yy = rng.binomial(1, sigmoid(-1.0 * zz + 0.4), size=4000).astype(float)
    a, b = fit_platt(zz, yy)
    assert abs(a - (-1.0)) < 0.15 and abs(b - 0.4) < 0.12, (a, b)
    # PAVA is monotone and matches a known pooling
    px = np.array([0.1, 0.2, 0.3, 0.4])
    py = np.array([0.0, 1.0, 0.0, 1.0])
    kx, ky = fit_isotonic_pava(px, py)
    assert np.all(np.diff(ky) >= -1e-12), ky
    assert len(kx) == len(ky)
    pred = predict_isotonic(kx, ky, np.array([0.15, 0.35]))
    assert np.all((pred >= 0.0) & (pred <= 1.0))
    # isotonic with monotone labels is identity-ish
    kx2, ky2 = fit_isotonic_pava(np.array([0.1, 0.2, 0.3]), np.array([0.1, 0.2, 0.3]))
    assert np.allclose(predict_isotonic(kx2, ky2, np.array([0.1, 0.2, 0.3])), [0.1, 0.2, 0.3])
    # no positive / no negative guard
    assert fit_platt(np.array([0.1, 0.2]), np.array([0.0, 0.0])) == (1.0, 0.0)
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-n headC server-truth probability calibration")
    ap.add_argument("--rows", nargs="+", default=[])
    ap.add_argument("--damage", nargs="+", default=[])
    ap.add_argument("--oof", default="")
    ap.add_argument("--out-dir", default="out/torpedo_model/e26e-n")
    ap.add_argument("--folds", type=int, default=N_FOLDS)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--bootstrap", type=int, default=1000)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    if not args.rows or not args.damage or not args.oof:
        raise SystemExit("[e26n] --rows, --damage and --oof are required")
    if len(args.rows) != len(args.damage):
        raise SystemExit("[e26n] --rows and --damage must pair up shard by shard")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
