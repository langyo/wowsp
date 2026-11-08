#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E26e-b: torpedo outcome-lift evaluation (numpy-only; no torch).

Question: does the E26d/E26e-a head-B OOF probability rank EXPERT torpedo
launches by ACTUAL outcome (torpedo hits), not merely by agreement with the
expert click label?

Inputs
  --oof      E26e-a OOF npz (probB/labelB/labelA/class/region/replay/t/shipId,
             rowIndex = global row number in the training --data order).
  --outcome  Rust outcome sidecar JSONL files, in the SAME order as the
             training --data (apac, eu, na, own). Each line is one dataset row
             plus torp_fired_fish / torp_hits / torp_hp_lost_nearby (+ optional
             torp_terminal_near); row i corresponds to the i-th OOF row in that
             order. Rows are joined by replayId/t/shipId for validation.

Primary analysis (pre-registered, see out/torpedo_model/e26e-b-preregistration.md)
  launched rows only (labelB == 1): fish-level hit rate
  sum(torp_hits)/sum(torp_fired_fish), deciles of probB (1 = highest),
  top-decile lift vs base >= 1.25x AND decile Spearman(meanP, hitRate) >= +0.30
  with a replay-cluster bootstrap 95% CI excluding 0.

Agreement (probB vs labelB) is reported separately and deliberately does NOT
count as outcome evidence: ranking expert clicks is not the same as ranking
good outcomes (E13/E17/E20/E21 precedents).
"""

import argparse
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

MIN_STRATUM_ROWS = 30         # per-class / per-region descriptive floor
DECILES = 10
JOIN_T_TOL = 1e-3             # float32 t rounding between OOF npz and sidecar
PREREG_TOPDECILE_LIFT = 1.25
PREREG_SPEARMAN = 0.30
PREREG_JOIN_COVERAGE = 0.95


# ── small standalone metrics (numpy only) ────────────────────────────────────


def _avg_rank(a: np.ndarray) -> np.ndarray:
    """1-based average ranks (ties share the mean rank)."""
    a = np.asarray(a, dtype=np.float64)
    order = np.argsort(a, kind="mergesort")
    vals = a[order]
    ranks = np.empty(len(a), dtype=np.float64)
    ranks[order] = np.arange(1, len(a) + 1, dtype=np.float64)
    i = 0
    while i < len(vals):
        j = i + 1
        while j < len(vals) and vals[j] == vals[i]:
            j += 1
        if j - i > 1:
            ranks[order[i:j]] = 1.0 + (i + j - 1) / 2.0
        i = j
    return ranks


def spearman(x: np.ndarray, y: np.ndarray):
    """Spearman rho (average ranks); None when undefined."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if len(x) < 3 or len(y) < 3:
        return None
    rx = _avg_rank(x)
    ry = _avg_rank(y)
    rx = rx - rx.mean()
    ry = ry - ry.mean()
    denom = float(np.sqrt((rx * rx).sum() * (ry * ry).sum()))
    if denom <= 0.0:
        return None
    return float((rx * ry).sum() / denom)


def average_precision(y: np.ndarray, score: np.ndarray) -> float:
    y = np.asarray(y, dtype=np.float64)
    score = np.asarray(score, dtype=np.float64)
    order = np.argsort(-score, kind="mergesort")
    y = y[order]
    pos = float(y.sum())
    if pos <= 0.0:
        return float("nan")
    hits = 0
    ap = 0.0
    for i, v in enumerate(y, start=1):
        if v > 0.5:
            hits += 1
            ap += hits / i
    return ap / pos


def roc_auc(y: np.ndarray, score: np.ndarray) -> float:
    y = np.asarray(y, dtype=np.float64)
    score = np.asarray(score, dtype=np.float64)
    ranks = _avg_rank(score)
    pos = y > 0.5
    n_pos = int(pos.sum())
    n_neg = len(y) - n_pos
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    return float((ranks[pos].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def log_loss(y: np.ndarray, p: np.ndarray) -> float:
    y = np.asarray(y, dtype=np.float64)
    p = np.clip(np.asarray(p, dtype=np.float64), 1e-12, 1.0 - 1e-12)
    return float(-np.mean(y * np.log(p) + (1.0 - y) * np.log(1.0 - p)))


def decile_ids(p: np.ndarray, k: int = DECILES) -> np.ndarray:
    """Rank-based deciles: 1 = highest probability ... k = lowest."""
    p = np.asarray(p, dtype=np.float64)
    n = len(p)
    if n == 0:
        return np.zeros(0, dtype=np.int8)
    order = np.argsort(-p, kind="mergesort")
    ranks = np.empty(n, dtype=np.int64)
    ranks[order] = np.arange(n, dtype=np.int64)
    return (ranks * k // n + 1).clip(1, k).astype(np.int8)


def decile_table(prob: np.ndarray, fish: np.ndarray, hits: np.ndarray, k: int = DECILES) -> list:
    """Fish-level hit rate per probability decile (1 = highest)."""
    dec = decile_ids(prob, k)
    out = []
    for d in range(1, k + 1):
        m = dec == d
        n = int(m.sum())
        fired = int(fish[m].sum())
        h = int(hits[m].sum())
        out.append({
            "decile": d,
            "rows": n,
            "firedFish": fired,
            "hits": h,
            "hitRate": (h / fired) if fired > 0 else None,
            "rowAnyHitRate": float(np.mean(hits[m] > 0)) if n else None,
            "meanProb": float(np.mean(prob[m])) if n else None,
            "hpLostPerFish": None,
        })
    return out


def top_decile_lift(table: list, base_rate) -> float:
    if not table or base_rate is None or base_rate <= 0.0:
        return None
    r1 = table[0].get("hitRate")
    if r1 is None:
        return None
    return float(r1 / base_rate)


# ── OOF / sidecar loading ────────────────────────────────────────────────────


def load_oof(path: Path) -> dict:
    z = np.load(path, allow_pickle=False)
    need = ["probB", "labelB", "labelA", "classCode", "classNames", "regionCode",
            "regionNames", "groupCode", "groupNames", "t", "shipId", "rowIndex"]
    missing = [k for k in need if k not in z.files]
    if missing:
        raise SystemExit("[e26b] OOF npz missing keys: " + repr(missing))
    return {
        "probB": z["probB"].astype(np.float64),
        "probC": z["probC"].astype(np.float64) if "probC" in z.files else None,
        "labelB": z["labelB"].astype(np.float64),
        "labelA": z["labelA"].astype(np.float64),
        "classCode": z["classCode"],
        "classNames": [str(x) for x in z["classNames"].tolist()],
        "regionCode": z["regionCode"],
        "regionNames": [str(x) for x in z["regionNames"].tolist()],
        "groupCode": z["groupCode"],
        "groupNames": [str(x) for x in z["groupNames"].tolist()],
        "t": z["t"].astype(np.float64),
        "shipId": z["shipId"].astype(np.int64),
        "rowIndex": z["rowIndex"].astype(np.int64),
        "meta": json.loads(str(z["meta"].tolist())) if "meta" in z.files else {},
    }


FIELD_ALIASES = {
    "replayId": ("replayId", "replay_id"),
    "t": ("t", "time"),
    "shipId": ("shipId", "ship_id"),
    "labelA": ("labelACanLaunch", "label_a_can_launch", "labelA"),
    "labelB": ("labelBLaunched", "label_b_launched", "labelB"),
    "fired": ("torp_fired_fish", "torpFiredFish", "firedFish", "fired_fish"),
    "hits": ("torp_hits", "torpHits", "hits"),
    "hp": ("torp_hp_lost_nearby", "torpHpLostNearby", "hpLostNearby"),
    "terminalNear": ("torp_terminal_near", "torpTerminalNear", "terminalNear"),
    "rowIndex": ("rowIndex", "row_index"),
}


def pick_field(row: dict, key: str):
    for name in FIELD_ALIASES[key]:
        if name in row:
            return row[name]
    return None


# ── row selection / join ────────────────────────────────────────────────────


def select_target_rows(oof: dict, regions, max_replays) -> tuple:
    """Rows the sidecar files are expected to cover, in original row order."""
    mask = np.ones(len(oof["probB"]), dtype=bool)
    if regions:
        keep = {r.lower() for r in regions}
        codes = [i for i, name in enumerate(oof["regionNames"]) if name.lower() in keep]
        if not codes:
            raise SystemExit("[e26b] no region codes match " + repr(sorted(keep)) +
                             " (have " + repr(oof["regionNames"]) + ")")
        mask &= np.isin(oof["regionCode"], np.array(codes, dtype=np.int8))
    info = {"regions": regions or "all", "max_replays": max_replays}
    idx = np.flatnonzero(mask)
    if max_replays is not None and max_replays > 0:
        seen = set()
        keep_rows = []
        for i in idx:
            g = int(oof["groupCode"][i])
            if g not in seen:
                if len(seen) >= max_replays:
                    continue
                seen.add(g)
            keep_rows.append(i)
        idx = np.array(keep_rows, dtype=np.int64)
        info["selected_replays"] = len(seen)
    return idx, info


def join_sidecars(oof: dict, sidecar_paths: list, target_idx: np.ndarray, lenient: bool = False) -> dict:
    """Stream sidecars in order and validate replayId/t/shipId against the
    selected OOF rows. Returns per-row outcome arrays aligned to target_idx."""
    n = len(target_idx)
    pos_by_row = {int(oof["rowIndex"][i]): p for p, i in enumerate(target_idx)}
    join_key_missing = 0
    row_index_mode = False
    fired = np.zeros(n, dtype=np.int32)
    hits = np.zeros(n, dtype=np.int32)
    hp = np.full(n, np.nan, dtype=np.float64)
    terminal_near = np.full(n, -1, dtype=np.int32)
    label_a_s = np.full(n, np.nan, dtype=np.float64)
    label_b_s = np.full(n, np.nan, dtype=np.float64)
    joined = np.zeros(n, dtype=bool)
    mismatch_replay = 0
    mismatch_t = 0
    mismatch_ship = 0
    missing_field = 0
    pos = 0
    per_shard = []
    for path in sidecar_paths:
        rows_here = 0
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if pos >= n:
                    raise SystemExit("[e26b] sidecar " + str(path) +
                                     " has more rows than the selected OOF set (" + str(n) +
                                     "); check --outcome order/selection (apac,eu,na,own)")
                row = json.loads(line)
                # explicit rowIndex wins (shard order may differ); else positional
                ri = pick_field(row, "rowIndex")
                if ri is not None:
                    row_index_mode = True
                    got = pos_by_row.get(int(ri))
                    if got is None:
                        mismatch_replay += 1
                        ok = False
                        pos_here = pos
                    else:
                        pos_here = got
                else:
                    pos_here = pos
                i = int(target_idx[pos_here])
                rows_here += 1
                rid = pick_field(row, "replayId")
                tv = pick_field(row, "t")
                sid = pick_field(row, "shipId")
                ok = True
                expect_replay = oof["groupNames"][int(oof["groupCode"][i])]
                if rid is None or tv is None or sid is None:
                    join_key_missing += 1
                    if not lenient:
                        ok = False
                else:
                    if str(rid) != expect_replay:
                        mismatch_replay += 1
                        ok = False
                    if not np.isfinite(float(tv)) or abs(float(tv) - oof["t"][i]) > JOIN_T_TOL:
                        mismatch_t += 1
                        ok = False
                    if int(sid) != int(oof["shipId"][i]):
                        mismatch_ship += 1
                        ok = False
                fv = pick_field(row, "fired")
                hv = pick_field(row, "hits")
                pv = pick_field(row, "hp")
                if fv is None or hv is None:
                    missing_field += 1
                    ok = False
                if ok:
                    fired[pos_here] = int(fv)
                    hits[pos_here] = int(hv)
                    hp[pos_here] = float(pv) if pv is not None else float("nan")
                    tn = pick_field(row, "terminalNear")
                    if tn is not None:
                        terminal_near[pos_here] = int(tn)
                    la = pick_field(row, "labelA")
                    lb = pick_field(row, "labelB")
                    if la is not None:
                        label_a_s[pos_here] = float(bool(la))
                    if lb is not None:
                        label_b_s[pos_here] = float(bool(lb))
                    joined[pos_here] = True
                pos += 1
        per_shard.append({"path": str(path), "rows": rows_here})
    if pos != n:
        raise SystemExit("[e26b] sidecar rows " + str(pos) + " != selected OOF rows " + str(n) +
                         "; check --outcome order")
    return {
        "fired": fired, "hits": hits, "hp": hp, "terminalNear": terminal_near,
        "labelA_sidecar": label_a_s, "labelB_sidecar": label_b_s, "joined": joined,
        "mismatch_replay": mismatch_replay, "mismatch_t": mismatch_t,
        "mismatch_ship": mismatch_ship, "missing_field": missing_field,
        "joinKeyMissing": join_key_missing, "rowIndexMode": row_index_mode,
        "per_shard": per_shard,
    }


# ── analysis ────────────────────────────────────────────────────────────────


def analyze_launched(prob: np.ndarray, fired: np.ndarray, hits: np.ndarray, hp: np.ndarray,
                     k: int = DECILES, terminal_near=None) -> dict:
    """Launched (labelB==1) outcome analysis on fish-level hit rate."""
    base_fired = int(fired.sum())
    base_hits = int(hits.sum())
    base_rate = (base_hits / base_fired) if base_fired > 0 else None
    table = decile_table(prob, fired, hits, k)
    dec = decile_ids(prob, k)
    for d in range(1, k + 1):
        m = dec == d
        f = int(fired[m].sum())
        hpm = hp[m]
        valid = np.isfinite(hpm)
        table[d - 1]["hpLostPerFish"] = (
            float(np.nansum(hpm[valid]) / f) if f > 0 and valid.any() else None
        )
    lift = top_decile_lift(table, base_rate)
    geom_base = None
    geom_lift = None
    if terminal_near is not None and len(terminal_near) == len(prob):
        tn = np.asarray(terminal_near, dtype=np.float64)
        for d in range(1, k + 1):
            m = dec == d
            f = int(fired[m].sum())
            table[d - 1]["geomNearRate"] = (float(tn[m].sum()) / f) if f > 0 else None
        if base_fired > 0:
            geom_base = float(tn.sum()) / base_fired
            r1g = table[0].get("geomNearRate")
            geom_lift = (r1g / geom_base) if (r1g is not None and geom_base > 0) else None
    mean_p = np.array([r["meanProb"] for r in table if r["meanProb"] is not None], dtype=np.float64)
    rates = np.array([r["hitRate"] for r in table if r["hitRate"] is not None], dtype=np.float64)
    rho_dec = spearman(mean_p, rates) if len(rates) >= 3 else None
    row_any = (hits > 0).astype(np.float64)
    rho_row = spearman(prob, row_any)
    r1 = table[0]["hitRate"]
    r10 = table[-1]["hitRate"]
    return {
        "rows": int(len(prob)),
        "firedFish": base_fired,
        "hits": base_hits,
        "baseHitRate": base_rate,
        "rowAnyHitRate": float(np.mean(hits > 0)) if len(hits) else None,
        "hpLostPerFish": float(np.nansum(hp[np.isfinite(hp)]) / base_fired) if base_fired else None,
        "topDecileLift": lift,
        "topBottomGap": (r1 - r10) if (r1 is not None and r10 is not None) else None,
        "spearmanDecile": rho_dec,
        "spearmanRow": rho_row,
        "geomNearBaseRate": geom_base,
        "geomNearTopDecileLift": geom_lift,
        "deciles": table,
    }


def bootstrap_cluster(prob: np.ndarray, fired: np.ndarray, hits: np.ndarray, hp: np.ndarray,
                      group_ids: np.ndarray, reps: int, seed: int, k: int = DECILES,
                      alpha: float = 0.05) -> dict:
    """Replay-cluster bootstrap for top-decile lift and decile Spearman."""
    rng = np.random.default_rng(seed)
    uniq, inv = np.unique(group_ids, return_inverse=True)
    rows_by_group = [np.flatnonzero(inv == g) for g in range(len(uniq))]
    lifts = []
    rhos = []
    for _ in range(int(reps)):
        pick = rng.integers(0, len(uniq), size=len(uniq))
        idx = np.concatenate([rows_by_group[g] for g in pick]) if len(uniq) else np.array([], dtype=np.int64)
        p = prob[idx]
        f = fired[idx]
        h = hits[idx]
        base = (h.sum() / f.sum()) if f.sum() > 0 else None
        tab = decile_table(p, f, h, k)
        lib = top_decile_lift(tab, base)
        mp = np.array([r["meanProb"] for r in tab if r["meanProb"] is not None], dtype=np.float64)
        rt = np.array([r["hitRate"] for r in tab if r["hitRate"] is not None], dtype=np.float64)
        if lib is not None:
            lifts.append(lib)
        if len(rt) >= 3:
            r = spearman(mp, rt)
            if r is not None:
                rhos.append(r)
    def ci(vals):
        if not vals:
            return None
        a = np.asarray(vals, dtype=np.float64)
        return [float(np.quantile(a, alpha / 2.0)), float(np.quantile(a, 1.0 - alpha / 2.0))]
    lift_ci = ci(lifts)
    rho_ci = ci(rhos)
    return {
        "reps": int(reps), "seed": int(seed), "clusters": int(len(uniq)),
        "lift95": lift_ci, "spearman95": rho_ci,
        "spearmanExcludesZero": bool(rho_ci is not None and (rho_ci[0] > 0.0 or rho_ci[1] < 0.0)),
    }


def stratum_report(mask: np.ndarray, prob: np.ndarray, fired: np.ndarray, hits: np.ndarray,
                   hp: np.ndarray, k: int = DECILES, terminal_near=None):
    n = int(mask.sum())
    if n < MIN_STRATUM_ROWS:
        return None
    a = analyze_launched(prob[mask], fired[mask], hits[mask], hp[mask], k,
                         None if terminal_near is None else terminal_near[mask])
    return {
        "rows": a["rows"], "firedFish": a["firedFish"], "hits": a["hits"],
        "baseHitRate": a["baseHitRate"], "rowAnyHitRate": a["rowAnyHitRate"],
        "topDecileLift": a["topDecileLift"], "spearmanDecile": a["spearmanDecile"],
        "geomNearTopDecileLift": a["geomNearTopDecileLift"],
    }

# ── main analysis ───────────────────────────────────────────────────────────


def run(args) -> int:
    oof_path = Path(args.oof)
    oof = load_oof(oof_path)
    rows = len(oof["probB"])
    print("[e26b] OOF " + str(oof_path) + " rows " + format(rows, ",") +
          " replays " + str(len(oof["groupNames"])), flush=True)
    sidecars = [Path(p) for p in args.outcome]
    if not sidecars:
        raise SystemExit("[e26b] --outcome needs at least one sidecar file")
    if len(sidecars) != 4 and not args.regions:
        raise SystemExit("[e26b] full-corpus run expects 4 sidecars in apac,eu,na,own order; " +
                         "for a P0 subset pass --regions and the matching sidecar(s)")
    regions = [r for r in (args.regions or "").split(",") if r.strip()] or None
    target_idx, sel_info = select_target_rows(oof, regions, args.max_replays)
    print("[e26b] selected OOF rows " + format(len(target_idx), ",") +
          " " + json.dumps(sel_info, ensure_ascii=False), flush=True)
    j = join_sidecars(oof, sidecars, target_idx, lenient=bool(args.lenient_join))
    joined = j["joined"]
    coverage = float(joined.mean()) if len(joined) else 0.0
    join_info = {
        "selectedRows": int(len(target_idx)),
        "joinedRows": int(joined.sum()),
        "coverage": coverage,
        "mismatchReplay": j["mismatch_replay"],
        "mismatchT": j["mismatch_t"],
        "mismatchShip": j["mismatch_ship"],
        "missingOutcomeFields": j["missing_field"],
        "joinKeyMissing": j.get("joinKeyMissing", 0),
        "perShard": j["per_shard"],
        "gate": PREREG_JOIN_COVERAGE,
        "passed": bool(coverage >= PREREG_JOIN_COVERAGE),
    }
    print("[e26b] join coverage " + format(coverage, ".3%") + " (gate " +
          format(PREREG_JOIN_COVERAGE, ".0%") + "); mismatches replay/t/ship = " +
          str(j["mismatch_replay"]) + "/" + str(j["mismatch_t"]) + "/" + str(j["mismatch_ship"]),
          flush=True)
    labelA = oof["labelA"][target_idx]
    labelB = oof["labelB"][target_idx]
    probB = oof["probB"][target_idx]
    probC = oof.get("probC")
    probC = probC[target_idx] if probC is not None else None
    prob_key = getattr(args, "prob_key", "B")
    if prob_key == "B":
        score = probB
        score_def = "probB (headB launch probability)"
    elif prob_key == "C":
        if probC is None:
            raise SystemExit("[e26b] --prob-key C needs probC in the OOF npz (E26e-c --head-c run)")
        score = probC
        score_def = "probC (headC P(torpHits>0 | launched))"
    else:
        if probC is None:
            raise SystemExit("[e26b] --prob-key combined needs probB+probC in the OOF npz")
        score = np.sqrt(probB * probC)
        score_def = "combined = sqrt(probB * probC)"
    class_code = oof["classCode"][target_idx]
    region_code = oof["regionCode"][target_idx]
    group_code = oof["groupCode"][target_idx]
    agreeA = int(np.sum(np.isfinite(j["labelA_sidecar"]) &
                        (np.nan_to_num(j["labelA_sidecar"]) == labelA)))
    validBs = np.isfinite(j["labelB_sidecar"])
    agreeB = int(np.sum(validBs & (np.nan_to_num(j["labelB_sidecar"]) == np.nan_to_num(labelB))))
    launched = joined & (labelB == 1.0)
    fired_launched = j["fired"][launched]
    fired0 = int(np.sum(launched & (j["fired"] == 0)))
    quality = {
        "launchedRows": int(launched.sum()),
        "launchedWithZeroFiredFish": fired0,
        "labelB_sidecar_agree": agreeB,
        "labelB_sidecar_compared": int(validBs.sum()),
        "labelA_sidecar_agree": agreeA,
        "unjoinedRows": int((~joined).sum()),
        "terminalNearPositiveLaunched": int(np.sum(j["terminalNear"][launched] > 0)),
        "terminalNearMax": int(j["terminalNear"].max()) if len(j["terminalNear"]) else 0,
    }
    print("[e26b] launched rows (labelB=1): " + format(int(launched.sum()), ",") +
          "; firedFish sum " + format(int(fired_launched.sum()), ","), flush=True)
    if launched.sum() == 0:
        raise SystemExit("[e26b] no joined launched rows — check sidecar/order")
    prob = score[launched]
    fired = j["fired"][launched]
    hits = j["hits"][launched]
    hp = j["hp"][launched]
    groups = group_code[launched]
    terminal_launched = j["terminalNear"][launched]
    analysis = analyze_launched(prob, fired, hits, hp, terminal_near=terminal_launched)
    boot = bootstrap_cluster(prob, fired, hits, hp, groups, args.bootstrap, args.seed)
    min_lift = float(getattr(args, "min_lift", PREREG_TOPDECILE_LIFT))
    min_spearman = float(getattr(args, "min_spearman", PREREG_SPEARMAN))
    pass_lift = bool(analysis["topDecileLift"] is not None and analysis["topDecileLift"] >= min_lift)
    pass_rho = bool(analysis["spearmanDecile"] is not None and analysis["spearmanDecile"] >= min_spearman)
    pass_ci = bool(boot["spearmanExcludesZero"])
    if not join_info["passed"]:
        verdict = "fail"
    elif pass_lift and pass_rho and pass_ci:
        verdict = "pass"
    elif pass_lift or pass_rho:
        verdict = "mixed"
    else:
        verdict = "fail"
    per_class = {}
    for code, name in enumerate(oof["classNames"]):
        m = launched & (class_code == code)
        rep = stratum_report(m, score, j["fired"], j["hits"], j["hp"], terminal_near=j["terminalNear"])
        per_class[name] = rep if rep is not None else {"rows": int(m.sum()), "insufficient": True}
    per_region = {}
    for code, name in enumerate(oof["regionNames"]):
        m = launched & (region_code == code)
        rep = stratum_report(m, score, j["fired"], j["hits"], j["hp"], terminal_near=j["terminalNear"])
        per_region[name] = rep if rep is not None else {"rows": int(m.sum()), "insufficient": True}
    can = joined & (labelA == 1.0) & np.isfinite(labelB)
    agreement = {
        "rows": int(can.sum()),
        "note_key": "always headB (probB) vs labelB, independent of --prob-key",
        "auprc": float(average_precision(labelB[can], probB[can])) if can.sum() else None,
        "roc_auc": float(roc_auc(labelB[can], probB[can])) if can.sum() else None,
        "logloss": float(log_loss(labelB[can], probB[can])) if can.sum() else None,
        "note": "agreement only — ranking expert clicks is NOT outcome evidence",
    }
    metrics = {
        "_lineage": "E26e-b torpedo outcome-lift evaluation (E26e-a OOF + Rust outcome sidecar)",
        "inputs": {
            "oof": str(oof_path),
            "prob_key": prob_key,
            "score_definition": score_def,
            "min_lift": float(getattr(args, "min_lift", PREREG_TOPDECILE_LIFT)),
            "min_spearman": float(getattr(args, "min_spearman", PREREG_SPEARMAN)),
            "sidecars": [str(p) for p in sidecars],
            "selection": sel_info,
            "bootstrap": int(args.bootstrap),
            "seed": int(args.seed),
            "pre_registration": {
                "topDecileLift": PREREG_TOPDECILE_LIFT,
                "spearmanDecile": PREREG_SPEARMAN,
                "joinCoverage": PREREG_JOIN_COVERAGE,
            },
        },
        "join": join_info,
        "quality": quality,
        "base": {
            "rows": analysis["rows"],
            "firedFish": analysis["firedFish"],
            "hits": analysis["hits"],
            "hitRate": analysis["baseHitRate"],
            "rowAnyHitRate": analysis["rowAnyHitRate"],
            "hpLostPerFish": analysis["hpLostPerFish"],
            "geomNearBaseRate": analysis["geomNearBaseRate"],
        },
        "deciles": analysis["deciles"],
        "primary": {
            "topDecileLift": analysis["topDecileLift"],
            "topBottomGap": analysis["topBottomGap"],
            "spearmanDecile": analysis["spearmanDecile"],
            "spearmanRow": analysis["spearmanRow"],
            "geomNearTopDecileLift": analysis["geomNearTopDecileLift"],
            "bootstrap": boot,
            "pass_lift": pass_lift,
            "pass_spearman": pass_rho,
            "pass_ci_excludes_zero": pass_ci,
            "verdict": verdict,
        },
        "per_class": per_class,
        "per_region": per_region,
        "agreement": agreement,
        "notes": [
            "outcome is evaluation-only; must not be wired into training labels (E15 precedent)",
            "fish-level hit rate = sum(torp_hits)/sum(torp_fired_fish) on labelB=1 rows",
            "hit = terminal within TORP_HIT_RADIUS_UNITS of an enemy hull AND covering an enemy HP drop",
            "hp_lost is an ordinal proxy (E13 full-credit crossfire), not a damage ledger",
        ],
    }
    out = Path(args.metrics_out) if args.metrics_out else Path("outcome_lift_metrics.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(metrics, indent=1, ensure_ascii=False), encoding="utf-8")
    print("[e26b] outcome-lift metrics -> " + str(out), flush=True)
    base_rate = analysis["baseHitRate"]
    lift = analysis["topDecileLift"]
    rho = analysis["spearmanDecile"]
    rho_row = analysis["spearmanRow"]
    print("[e26b] score " + str(prob_key) + " (" + score_def + ")")
    print("[e26b] base hitRate " + str(base_rate) + " (fired " +
          format(analysis["firedFish"], ",") + " / hits " + format(analysis["hits"], ",") + ")", flush=True)
    print("[e26b] top-decile lift " + str(lift) + " (need >= " + str(min_lift) + ")", flush=True)
    print("[e26b] spearman decile " + str(rho) + " (need >= " + str(min_spearman) +
          "); row " + str(rho_row) + "; 95% CI lift " + str(boot["lift95"]) +
          " rho " + str(boot["spearman95"]), flush=True)
    print("[e26b] VERDICT " + verdict.upper() + " (join gate " + str(join_info["passed"]) + ")", flush=True)
    return 0


# ── self-test (numpy only) ──────────────────────────────────────────────────


def run_selftest() -> int:
    # 1. rank metrics
    assert abs(spearman(np.array([1, 2, 3, 4]), np.array([10, 20, 30, 40])) - 1.0) < 1e-12
    assert abs(spearman(np.array([1, 2, 3, 4]), np.array([40, 30, 20, 10])) + 1.0) < 1e-12
    assert spearman(np.array([1, 1, 1, 1]), np.array([1, 2, 3, 4])) is None
    y = np.array([1.0, 1.0, 0.0, 0.0])
    s = np.array([0.9, 0.8, 0.2, 0.1])
    assert abs(average_precision(y, s) - 1.0) < 1e-12
    assert abs(roc_auc(y, s) - 1.0) < 1e-12
    assert log_loss(y, np.array([0.9, 0.8, 0.2, 0.1])) > 0.0
    # 2. deciles: highest prob -> decile 1; k deciles cover all rows
    p = np.arange(100, 0, -1, dtype=np.float64)
    dec = decile_ids(p, 10)
    assert dec[0] == 1 and dec[-1] == 10
    assert len(set(dec.tolist())) == 10
    # 3. decile table / lift on synthetic outcome signal
    rng = np.random.default_rng(0)
    n = 4000
    prob = rng.random(n)
    fired = rng.integers(1, 4, size=n)
    hits = np.array([int(rng.random() < q) * int(f) for q, f in zip(prob, fired)])
    a = analyze_launched(prob, fired, hits, np.zeros(n))
    assert a["topDecileLift"] is not None and a["topDecileLift"] > 1.0
    assert a["spearmanDecile"] is not None and a["spearmanDecile"] > 0.5
    tab = decile_table(prob, fired, hits, 10)
    assert len(tab) == 10 and all("hitRate" in r for r in tab)
    # 4. bootstrap reproducible + cluster-aware shape
    groups = rng.integers(0, 50, size=n)
    b1 = bootstrap_cluster(prob, fired, hits, np.zeros(n), groups, 60, 0)
    b2 = bootstrap_cluster(prob, fired, hits, np.zeros(n), groups, 60, 0)
    b3 = bootstrap_cluster(prob, fired, hits, np.zeros(n), groups, 60, 1)
    assert b1 == b2
    assert b1["lift95"] is not None and len(b1["lift95"]) == 2
    assert b1["clusters"] == 50
    assert b1["lift95"] != b3["lift95"]
    # 5. join boundary: synthetic OOF + sidecars
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        nrows = 6
        oof = {
            "probB": np.linspace(0.9, 0.1, nrows),
            "labelB": np.array([1.0, 1.0, 0.0, 1.0, 0.0, 0.0]),
            "labelA": np.array([1.0, 1.0, 1.0, 1.0, 0.0, 0.0]),
            "classCode": np.zeros(nrows, dtype=np.int8),
            "classNames": ["Destroyer"],
            "regionCode": np.array([0, 0, 0, 1, 1, 1], dtype=np.int8),
            "regionNames": ["apac", "own"],
            "groupCode": np.arange(nrows, dtype=np.int32),
            "groupNames": ["r" + str(i) for i in range(nrows)],
            "t": np.arange(nrows, dtype=np.float64),
            "shipId": np.arange(100, 100 + nrows, dtype=np.int64),
            "rowIndex": np.arange(nrows, dtype=np.int64),
        }
        rows = []
        for i in range(nrows):
            rows.append({
                "replayId": "r" + str(i),
                "t": float(i),
                "shipId": 100 + i,
                "labelACanLaunch": bool(oof["labelA"][i] == 1.0),
                "labelBLaunched": bool(oof["labelB"][i] == 1.0),
                "torp_fired_fish": 2,
                "torp_hits": 1,
                "torp_hp_lost_nearby": 1000.0,
                "torp_terminal_near": 1,
            })
        fa = root / "s0.jsonl"
        fb = root / "s1.jsonl"
        fa.write_text("\n".join(json.dumps(r) for r in rows[:3]) + "\n", encoding="utf-8")
        fb.write_text("\n".join(json.dumps(r) for r in rows[3:]) + "\n", encoding="utf-8")
        idx = np.arange(nrows, dtype=np.int64)
        j = join_sidecars(oof, [fa, fb], idx)
        assert j["joined"].all() and j["fired"].tolist() == [2] * nrows
        assert j["mismatch_replay"] == 0 and j["mismatch_t"] == 0 and j["mismatch_ship"] == 0
        assert j["terminalNear"].tolist() == [1] * nrows
        # label + outcome agreement on synthetic rows
        assert j["labelB_sidecar"].tolist() == oof["labelB"].tolist()
        # region-filtered selection: own rows = index 3..5
        sel, info = select_target_rows(oof, ["own"], 0)
        assert sel.tolist() == [3, 4, 5]
        fown = root / "own.jsonl"
        fown.write_text("\n".join(json.dumps(r) for r in rows[3:]) + "\n", encoding="utf-8")
        j2 = join_sidecars(oof, [fown], sel)
        assert j2["joined"].all() and len(j2["fired"]) == 3
        # count mismatch must be loud
        try:
            join_sidecars(oof, [fa], idx)
            raise AssertionError("expected SystemExit on row-count mismatch")
        except SystemExit:
            pass
        # explicit rowIndex mode: permuted shard order still joins correctly
        with_rowidx = []
        for i in (2, 0, 1, 3, 4, 5):
            r = dict(rows[i])
            r["rowIndex"] = i
            with_rowidx.append(r)
        fr = root / "rowidx.jsonl"
        fr.write_text("\n".join(json.dumps(r) for r in with_rowidx) + "\n", encoding="utf-8")
        jr = join_sidecars(oof, [fr], idx)
        assert jr["joined"].all() and jr["rowIndexMode"] is True
        # lenient mode: rows without replayId/t/shipId still join (counted)
        lite = [{"torp_fired_fish": 1, "torp_hits": 1, "torp_hp_lost_nearby": 10.0, "rowIndex": i}
                for i in range(nrows)]
        fl = root / "lite.jsonl"
        fl.write_text("\n".join(json.dumps(r) for r in lite) + "\n", encoding="utf-8")
        jl = join_sidecars(oof, [fl], idx, lenient=True)
        assert jl["joined"].all() and jl["joinKeyMissing"] == nrows
        strict_failed = False
        try:
            join_sidecars(oof, [fl], idx, lenient=False)
        except SystemExit:
            strict_failed = True
        assert strict_failed is False  # missing keys are counted, not fatal (only coverage drops)
        assert jl["fired"].sum() == nrows
        # field mismatch counted, row kept as unjoined
        bad = dict(rows[0])
        bad["replayId"] = "WRONG"
        fb2 = root / "bad.jsonl"
        fb2.write_text("\n".join(json.dumps(r) for r in ([bad] + rows[1:3])) + "\n", encoding="utf-8")
        j3 = join_sidecars(oof, [fb2], idx[:3])
        assert j3["mismatch_replay"] == 1 and int(j3["joined"].sum()) == 2
        # t tolerance boundary
        edge = dict(rows[0])
        edge["t"] = 0.0 + JOIN_T_TOL
        fe = root / "edge.jsonl"
        fe.write_text(json.dumps(edge) + "\n", encoding="utf-8")
        j4 = join_sidecars(oof, [fe], idx[:1])
        assert j4["joined"].all()
        edge2 = dict(rows[0])
        edge2["t"] = 2.0 * JOIN_T_TOL
        fe2 = root / "edge2.jsonl"
        fe2.write_text(json.dumps(edge2) + "\n", encoding="utf-8")
        j5 = join_sidecars(oof, [fe2], idx[:1])
        assert not j5["joined"].all() and j5["mismatch_t"] == 1
    # 6. no-fired launched rows must not crash analysis
    a0 = analyze_launched(np.array([0.5, 0.4]), np.array([0, 0]), np.array([0, 0]), np.zeros(2))
    assert a0["baseHitRate"] is None and a0["topDecileLift"] is None
    # 7. missing outcome fields counted
    assert pick_field({"replayId": "x"}, "fired") is None
    assert pick_field({"torpFiredFish": 3}, "fired") == 3
    print("PASS")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="E26e-b torpedo outcome-lift evaluation (numpy only)")
    p.add_argument("--oof", default="", help="E26e-a OOF npz (probB/labelB/... + rowIndex)")
    p.add_argument("--outcome", nargs="+", default=[], help="4 sidecar JSONL in apac,eu,na,own order")
    p.add_argument("--metrics-out", default="", help="output metrics JSON")
    p.add_argument("--bootstrap", type=int, default=1000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--regions", default="", help="comma list to restrict (e.g. own for P0)")
    p.add_argument("--max-replays", type=int, default=0, help="P0: keep first N replay groups")
    p.add_argument("--lenient-join", action="store_true",
                   help="tolerate sidecar rows without replayId/t/shipId (counted, not fatal)")
    p.add_argument("--prob-key", choices=["B", "C", "combined"], default="B",
                   help="score to evaluate: headB, headC (E26e-c), or combined=sqrt(probB*probC)")
    p.add_argument("--min-lift", type=float, default=PREREG_TOPDECILE_LIFT,
                   help="pre-registered top-decile lift threshold (E26e-c headC uses 1.35)")
    p.add_argument("--min-spearman", type=float, default=PREREG_SPEARMAN,
                   help="pre-registered decile Spearman threshold")
    p.add_argument("--selftest", action="store_true")
    args = p.parse_args(argv)
    if args.selftest:
        return run_selftest()
    if not args.oof:
        raise SystemExit("[e26b] --oof is required")
    if not args.outcome:
        raise SystemExit("[e26b] --outcome is required (4 files: apac,eu,na,own)")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())