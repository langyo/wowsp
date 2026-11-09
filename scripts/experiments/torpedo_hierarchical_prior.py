#!/usr/bin/env python3
"""E26e-x: hierarchical early + historical / mode empirical-Bayes priors (no retraining).

For each walk-forward test block (Q2/Q3/Q4) and early fraction (0.2 primary, 0.4 secondary):
  launched rows are sorted by battle time t; the earliest fraction estimates priors, the rest is eval.

Variants (all scored as score = prior + eps * within-cell probC rank on eval rows):
  A  early cell EB alpha=20 toward early global; fallback early mode -> early global (E26e-w baseline)
  B  hierarchical cell->mode EB alpha=50: cell shrinks to early mode base, mode to early global;
     missing early mode -> historical mode prior -> early global
  C  early cell + historical same-cell counts pooled (alpha=20 toward early global); missing -> B
  D  early cell alpha=20; missing cell -> historical mode prior -> early mode -> early global
Controls on the same eval subset: raw probC and full-label oracle cell prior (upper bound).

No retraining.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from torpedo_outcome_lift import decile_table, top_decile_lift, roc_auc  # noqa: E402

BLOCKS = ("Q1", "Q2", "Q3", "Q4")
RUN_TO_BLOCK = {"runQ2": "Q2", "runQ3": "Q3", "runQ4": "Q4"}
PREV = {"Q2": "Q1", "Q3": "Q2", "Q4": "Q3"}
PRIOR_BLOCKS = {"Q2": ("Q1",), "Q3": ("Q1", "Q2"), "Q4": ("Q1", "Q2", "Q3")}
FRACTIONS = (0.2, 0.4)
EPS = 1e-3
ALPHA_EARLY = 20.0
ALPHA_HIER = 50.0
MIN_CELL_ROWS = 5
MIN_EVAL_ROWS = 10


def cell_key(game_mode, map_name, ship_class) -> str:
    def norm(v, fallback="unknown"):
        if v is None:
            return fallback
        s = str(v).strip()
        return s if s else fallback
    return norm(game_mode) + "|" + norm(map_name) + "|" + norm(ship_class)


def rank_pct(x) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    if n == 0:
        return np.zeros(0)
    order = np.argsort(x, kind="mergesort")
    ranks = np.empty(n, dtype=np.float64)
    ranks[order] = np.arange(1, n + 1, dtype=np.float64)
    _, inv = np.unique(x, return_inverse=True)
    for g in np.unique(inv):
        m = inv == g
        ranks[m] = ranks[m].mean()
    return ranks / float(n)


def within_group_rank(prob, groups) -> np.ndarray:
    out = np.empty(len(prob), dtype=np.float64)
    groups = np.asarray(groups, dtype=object)
    for g in np.unique(groups):
        m = groups == g
        out[m] = rank_pct(prob[m])
    return out


def score_block(prob, fired, hits) -> dict:
    n = len(prob)
    y = (hits > 0).astype(np.float64)
    base = float(hits.sum() / fired.sum()) if fired.sum() > 0 else None
    table = decile_table(prob, fired, hits)
    lift = top_decile_lift(table, base) if base else None
    order = np.argsort(-prob, kind="mergesort")
    k = max(1, n // 10)
    top = order[:k]
    return {
        "rows": int(n), "firedFish": int(fired.sum()), "hits": int(hits.sum()),
        "baseHitRate": base, "meanScore": float(np.mean(prob)) if n else None,
        "auc": roc_auc(y, prob) if len(np.unique(y)) == 2 else None,
        "topDecileHitRate": float(hits[top].sum() / fired[top].sum()) if fired[top].sum() > 0 else None,
        "topDecileFishLift": lift,
    }


def group_rates(groups, fired, hits) -> dict:
    out = {}
    for g in np.unique(groups):
        m = groups == g
        f = float(fired[m].sum())
        if f > 0:
            out[str(g)] = {"firedFish": f, "hits": float(hits[m].sum()), "rows": int(m.sum()),
                           "baseHitRate": float(hits[m].sum() / f)}
    return out


def eb_prior(rates: dict, global_base: float, alpha: float) -> dict:
    return {k: float((v["hits"] + alpha * global_base) / (v["firedFish"] + alpha)) for k, v in rates.items()}


def load_blocks(dataset_path: Path, split_summary: dict, class_of: dict):
    blocks = {q: {"rows": []} for q in BLOCKS}
    block_of_replay = {}
    for q in BLOCKS:
        for rid in split_summary["blocks"][q]["replayIds"]:
            block_of_replay[rid] = q
    n = 0
    with Path(dataset_path).open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            q = block_of_replay.get(row.get("replayId"))
            if q is None:
                continue
            sid = row.get("shipId")
            cls = class_of.get(int(sid), "unknown") if sid is not None else "unknown"
            blocks[q]["rows"].append({
                "gameMode": str(row.get("gameMode")),
                "mapName": str(row.get("mapName")),
                "shipClass": cls,
                "cell": cell_key(row.get("gameMode"), row.get("mapName"), cls),
                "labelB": bool(row.get("labelBLaunched")),
            })
            n += 1
    if n == 0:
        raise SystemExit("[e26x] no dataset rows matched the Q blocks")
    return blocks


def attach_outcomes(blocks: dict, outcome_dir: Path):
    for q in BLOCKS:
        path = outcome_dir / ("outcome_own_block_" + q + ".jsonl")
        if not path.exists():
            raise SystemExit("[e26x] missing " + str(path))
        fired, hits = [], []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                rec = json.loads(line)
                fired.append(int(rec.get("torpFiredFish", 0) or 0))
                hits.append(int(rec.get("torpHits", 0) or 0))
        rows = blocks[q]["rows"]
        if len(fired) != len(rows):
            raise SystemExit("[e26x] outcome rows mismatch for " + q)
        blocks[q]["fired"] = np.asarray(fired, dtype=np.int64)
        blocks[q]["hits"] = np.asarray(hits, dtype=np.int64)
        blocks[q]["modes"] = np.asarray([r["gameMode"] for r in rows], dtype=object)
        blocks[q]["cells"] = np.asarray([r["cell"] for r in rows], dtype=object)
        blocks[q]["labelB"] = np.asarray([r["labelB"] for r in rows], dtype=bool)


def launched_arrays(block):
    mask = block["labelB"] & (block["fired"] >= 1)
    return {"mask": mask, "cells": block["cells"][mask], "modes": block["modes"][mask],
            "fired": block["fired"][mask], "hits": block["hits"][mask]}


def historical_stats(blocks, block_names):
    fired_all, hits_all, cells_all, modes_all = [], [], [], []
    for q in block_names:
        la = launched_arrays(blocks[q])
        fired_all.append(la["fired"])
        hits_all.append(la["hits"])
        cells_all.append(la["cells"])
        modes_all.append(la["modes"])
    if not fired_all or sum(len(x) for x in fired_all) == 0:
        return {"cell": {}, "mode": {}, "global": 0.0, "rows": 0}
    fired = np.concatenate(fired_all)
    hits = np.concatenate(hits_all)
    cells = np.concatenate(cells_all)
    modes = np.concatenate(modes_all)
    gb = float(hits.sum() / fired.sum())
    cr = group_rates(cells, fired, hits)
    mr = group_rates(modes, fired, hits)
    return {"cell": eb_prior(cr, gb, ALPHA_EARLY), "mode": eb_prior(mr, gb, ALPHA_EARLY),
            "global": gb, "rows": int(len(fired)), "cellRates": cr, "modeRates": mr}


def oracle_priors(la):
    gb = float(la["hits"].sum() / la["fired"].sum())
    cr = group_rates(la["cells"], la["fired"], la["hits"])
    mr = group_rates(la["modes"], la["fired"], la["hits"])
    cp = {k: v["baseHitRate"] for k, v in cr.items() if v["rows"] >= MIN_CELL_ROWS}
    mp = {k: v["baseHitRate"] for k, v in mr.items() if v["rows"] >= MIN_CELL_ROWS}
    return {"cell": cp, "mode": mp, "global": gb, "cellRates": cr, "modeRates": mr}


def build_eval(prob, t, row_index, cells, modes, fired, hits, frac):
    n = len(prob)
    order = np.lexsort((row_index, t))
    early_n = max(1, int(round(n * frac)))
    if n - early_n < MIN_EVAL_ROWS:
        raise SystemExit("[e26x] eval subset too small")
    e_idx = order[:early_n]
    v_idx = order[early_n:]
    e = {"cells": cells[e_idx], "modes": modes[e_idx], "fired": fired[e_idx], "hits": hits[e_idx],
         "prob": prob[e_idx], "t": t[e_idx]}
    v = {"cells": cells[v_idx], "modes": modes[v_idx], "fired": fired[v_idx], "hits": hits[v_idx],
         "prob": prob[v_idx], "t": t[v_idx], "idx": v_idx}
    return e, v


def variant_priors(e, v, hist):
    """Return per-variant prior vectors for the eval rows plus fallback coverage counts."""
    e_global = float(e["hits"].sum() / e["fired"].sum()) if e["fired"].sum() > 0 else 0.0
    h_global = hist["global"]
    e_cells = group_rates(e["cells"], e["fired"], e["hits"])
    e_modes = group_rates(e["modes"], e["fired"], e["hits"])
    h_cells = hist["cellRates"]
    h_modes = hist["modeRates"]
    cell_mode = {}
    for c, m in zip(e["cells"], e["modes"]):
        cell_mode[str(c)] = str(m)

    # A: early cell EB alpha=20 toward early global; fallback early mode EB -> early global
    a_cell = eb_prior(e_cells, e_global, ALPHA_EARLY)
    a_mode = eb_prior(e_modes, e_global, ALPHA_EARLY)

    def resolve_a(cells, modes):
        out = np.empty(len(cells), dtype=np.float64)
        for i, (c, m) in enumerate(zip(cells, modes)):
            if str(c) in a_cell:
                out[i] = a_cell[str(c)]
            elif str(m) in a_mode:
                out[i] = a_mode[str(m)]
            else:
                out[i] = e_global
        return out

    # B: hierarchical cell -> mode EB alpha=50: cell shrinks to early mode base, mode to early global;
    # missing early mode -> historical mode prior -> early global
    b_mode = eb_prior(e_modes, e_global, ALPHA_HIER)
    h_mode = hist["mode"]
    b_cell = {}
    for c, cr in e_cells.items():
        mode = cell_mode.get(c)
        mode_ref = b_mode.get(mode, h_mode.get(mode, e_global)) if mode else e_global
        b_cell[c] = float((cr["hits"] + ALPHA_HIER * mode_ref) / (cr["firedFish"] + ALPHA_HIER))

    def resolve_b(cells, modes):
        out = np.empty(len(cells), dtype=np.float64)
        for i, (c, m) in enumerate(zip(cells, modes)):
            c = str(c); m = str(m)
            if c in b_cell:
                out[i] = b_cell[c]
            elif m in b_mode:
                out[i] = b_mode[m]
            elif m in h_mode:
                out[i] = h_mode[m]
            else:
                out[i] = e_global
        return out

    # C: pool early + historical same-cell counts, alpha=20 toward early global; missing -> B
    c_cell = {}
    for c in set(list(e_cells) + list(h_cells)):
        ef = e_cells.get(c, {}).get("firedFish", 0.0)
        eh = e_cells.get(c, {}).get("hits", 0.0)
        hf = h_cells.get(c, {}).get("firedFish", 0.0)
        hh = h_cells.get(c, {}).get("hits", 0.0)
        c_cell[c] = float((eh + hh + ALPHA_EARLY * e_global) / (ef + hf + ALPHA_EARLY))

    def resolve_c(cells, modes):
        out = np.empty(len(cells), dtype=np.float64)
        for i, (c, m) in enumerate(zip(cells, modes)):
            c = str(c); m = str(m)
            if c in c_cell:
                out[i] = c_cell[c]
            elif c in b_cell:
                out[i] = b_cell[c]
            elif m in b_mode:
                out[i] = b_mode[m]
            elif m in h_mode:
                out[i] = h_mode[m]
            else:
                out[i] = e_global
        return out

    # D: early cell alpha=20; missing -> historical mode -> early mode -> early global
    def resolve_d(cells, modes):
        out = np.empty(len(cells), dtype=np.float64)
        for i, (c, m) in enumerate(zip(cells, modes)):
            c = str(c); m = str(m)
            if c in a_cell:
                out[i] = a_cell[c]
            elif m in h_mode:
                out[i] = h_mode[m]
            elif m in a_mode:
                out[i] = a_mode[m]
            else:
                out[i] = e_global
        return out

    def coverage(cells, modes, fn):
        # count how many eval rows are resolved by cell / mode / global under the variant's chain
        cnt = {"cell": 0, "mode": 0, "historical": 0, "global": 0}
        for c, m in zip(cells, modes):
            c = str(c); m = str(m)
            if fn == "A":
                if c in a_cell: cnt["cell"] += 1
                elif m in a_mode: cnt["mode"] += 1
                else: cnt["global"] += 1
            elif fn == "B":
                if c in b_cell: cnt["cell"] += 1
                elif m in b_mode: cnt["mode"] += 1
                elif m in h_mode: cnt["historical"] += 1
                else: cnt["global"] += 1
            elif fn == "C":
                if c in c_cell: cnt["cell"] += 1
                elif c in b_cell: cnt["mode"] += 1
                elif m in b_mode: cnt["mode"] += 1
                elif m in h_mode: cnt["historical"] += 1
                else: cnt["global"] += 1
            else:
                if c in a_cell: cnt["cell"] += 1
                elif m in h_mode: cnt["historical"] += 1
                elif m in a_mode: cnt["mode"] += 1
                else: cnt["global"] += 1
        return cnt

    return {
        "A": resolve_a(v["cells"], v["modes"]),
        "B": resolve_b(v["cells"], v["modes"]),
        "C": resolve_c(v["cells"], v["modes"]),
        "D": resolve_d(v["cells"], v["modes"]),
        "earlyGlobalBase": e_global,
        "historicalGlobalBase": h_global,
        "earlyCells": len(e_cells), "earlyModes": len(e_modes),
        "bModeExample": {k: round(v, 4) for k, v in list(b_mode.items())[:6]},
        "coverage": {k: coverage(v["cells"], v["modes"], k) for k in ("A", "B", "C", "D")},
    }


def analyze_run(run: str, npz_path: Path, blocks: dict) -> dict:
    test_q = RUN_TO_BLOCK[run]
    block = blocks[test_q]
    z = np.load(npz_path, allow_pickle=False)
    n_block = len(block["cells"])
    if len(z["labelB"]) != n_block:
        raise SystemExit("[e26x] prediction rows != block rows for " + run)
    row_index = z["rowIndex"].astype(np.int64) if "rowIndex" in z.files else np.arange(n_block)
    labelB = z["labelB"].astype(np.float64)
    fired = z["fired"].astype(np.int64)
    hits = z["hits"].astype(np.int64)
    prob = z["probC"].astype(np.float64)
    t = z["t"].astype(np.float64) if "t" in z.files else np.arange(n_block, dtype=np.float64)
    mask = (labelB == 1.0) & (fired >= 1)
    cells = block["cells"][row_index[mask]]
    modes = block["modes"][row_index[mask]]
    prob_l = prob[mask]
    fired_l = fired[mask]
    hits_l = hits[mask]
    t_l = t[mask]
    ri_l = row_index[mask]
    hist = historical_stats(blocks, PRIOR_BLOCKS[test_q])
    ora = oracle_priors({"cells": cells, "modes": modes, "fired": fired_l, "hits": hits_l})
    gb = float(hits_l.sum() / fired_l.sum())

    out = {"run": run, "testBlock": test_q, "launched": int(len(prob_l)),
           "firedFish": int(fired_l.sum()), "hits": int(hits_l.sum()), "baseHitRate": gb,
           "historical": {"blocks": list(PRIOR_BLOCKS[test_q]), "rows": hist["rows"],
                          "global": hist["global"], "cells": len(hist["cell"]), "modes": len(hist["mode"])},
           "fractions": {}}
    for frac in FRACTIONS:
        e, v = build_eval(prob_l, t_l, ri_l, cells, modes, fired_l, hits_l, frac)
        priors = variant_priors(e, v, hist)
        within = within_group_rank(v["prob"], v["cells"])
        raw = score_block(v["prob"], v["fired"], v["hits"])
        oracle_score = (np.asarray([{"x": 0}]) if False else None)
        # oracle: full-launched cell base n>=5 -> mode -> global, then + eps * eval within rank
        ora_prior = np.empty(len(v["cells"]), dtype=np.float64)
        for i, (c, m) in enumerate(zip(v["cells"], v["modes"])):
            c = str(c); m = str(m)
            if c in ora["cell"]:
                ora_prior[i] = ora["cell"][c]
            elif m in ora["mode"]:
                ora_prior[i] = ora["mode"][m]
            else:
                ora_prior[i] = gb
        variants = {}
        for name in ("A", "B", "C", "D"):
            variants[name] = score_block(priors[name] + EPS * within, v["fired"], v["hits"])
        out["fractions"][str(frac)] = {
            "earlyN": int(len(e["cells"])), "evalN": int(len(v["cells"])),
            "earlyFired": int(e["fired"].sum()), "evalFired": int(v["fired"].sum()),
            "earlyGlobalBase": priors["earlyGlobalBase"],
            "evalBaseHitRate": float(v["hits"].sum() / v["fired"].sum()),
            "earlyModeBase": {str(k): round(x["baseHitRate"], 4) for k, x in
                              group_rates(e["modes"], e["fired"], e["hits"]).items()},
            "evalModeBase": {str(k): round(x["baseHitRate"], 4) for k, x in
                             group_rates(v["modes"], v["fired"], v["hits"]).items()},
            "earlyCells": priors["earlyCells"], "earlyModes": priors["earlyModes"],
            "coverage": priors["coverage"],
            "raw": raw, "oracle": score_block(ora_prior + EPS * within, v["fired"], v["hits"]),
            "variants": variants,
        }
    return out


def write_markdown(results: dict, path: Path):
    def f(v):
        return "-" if v is None else str(round(v, 4))

    lines = ["# E26e-x hierarchical early + historical / mode EB priors", ""]
    lines.append("Launched rows sorted by t; early 20%/40% estimate priors, eval on the rest. "
                 "Variants: A early-cell EB20, B hierarchical cell->mode EB50, C early+historical cell pool, D early-cell + historical mode fallback.")
    lines.append("")
    lines.append("| run | frac | eval n | raw | A | B | C | D | oracle |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        for frac in ("0.2", "0.4"):
            fr = r["fractions"][frac]
            lines.append("| " + run + " | " + frac + " | " + str(fr["evalN"]) + " | " + f(fr["raw"]["topDecileFishLift"])
                         + " | " + " | ".join(f(fr["variants"][k]["topDecileFishLift"]) for k in ("A", "B", "C", "D"))
                         + " | " + f(fr["oracle"]["topDecileFishLift"]) + " |")
    lines.append("")
    lines.append("| run | frac | raw AUC | A AUC | B AUC | C AUC | D AUC | oracle AUC |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        for frac in ("0.2", "0.4"):
            fr = r["fractions"][frac]
            lines.append("| " + run + " | " + frac + " | " + f(fr["raw"]["auc"])
                         + " | " + " | ".join(f(fr["variants"][k]["auc"]) for k in ("A", "B", "C", "D"))
                         + " | " + f(fr["oracle"]["auc"]) + " |")
    lines.append("")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        lines.append("## " + run + " (test " + r["testBlock"] + ", launched " + str(r["launched"]) + ")")
        lines.append("")
        for frac in ("0.2", "0.4"):
            fr = r["fractions"][frac]
            lines.append("### early " + frac + ": early rows " + str(fr["earlyN"]) + " fired " + str(fr["earlyFired"])
                         + " cells " + str(fr["earlyCells"]) + " | eval rows " + str(fr["evalN"]) + " fired "
                         + str(fr["evalFired"]) + " base " + f(fr["evalBaseHitRate"]))
            lines.append("")
            lines.append("coverage A/B/C/D: " + json.dumps(fr["coverage"]))
            lines.append("early mode base " + json.dumps(fr["earlyModeBase"]) + " | eval mode base " + json.dumps(fr["evalModeBase"]))
            lines.append("")
            lines.append("| metric | raw | A | B | C | D | oracle |")
            lines.append("|---|---|---|---|---|---|---|")
            for key in ("topDecileFishLift", "auc", "topDecileHitRate", "meanScore"):
                vals = [f(fr["raw"][key])] + [f(fr["variants"][k][key]) for k in ("A", "B", "C", "D")] + [f(fr["oracle"][key])]
                lines.append("| " + key + " | " + " | ".join(vals) + " |")
            lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    assert cell_key("brawl", "m", "Cruiser") == "brawl|m|Cruiser"
    assert cell_key(None, "", None) == "unknown|unknown|unknown"
    t = np.array([5.0, 1.0, 3.0, 2.0])
    assert np.lexsort((np.arange(4), t)).tolist() == [1, 3, 2, 0]
    # EB formula
    assert abs(eb_prior({"c": {"firedFish": 100, "hits": 50, "rows": 10, "baseHitRate": 0.5}}, 0.2, 20)["c"]
               - (50 + 20 * 0.2) / (100 + 20)) < 1e-12
    # hierarchical B: cell shrinks toward mode prior
    e = {"cells": np.array(["c1", "c2"], dtype=object), "modes": np.array(["m1", "m1"], dtype=object),
         "fired": np.array([100, 50]), "hits": np.array([60, 10])}
    v = {"cells": np.array(["c1", "c2", "c3"], dtype=object), "modes": np.array(["m1", "m1", "m9"], dtype=object),
         "fired": np.array([1, 1, 1]), "hits": np.array([0, 0, 0])}
    hist = {"cell": {}, "mode": {"m1": 0.3, "m9": 0.25}, "global": 0.2,
            "cellRates": {}, "modeRates": {"m1": {"firedFish": 10, "hits": 3, "rows": 5, "baseHitRate": 0.3},
                                            "m9": {"firedFish": 10, "hits": 2.5, "rows": 5, "baseHitRate": 0.25}},
            "rows": 20}
    pr = variant_priors(e, v, hist)
    assert abs(pr["A"][0] - (60 + 20 * (70 / 150)) / (100 + 20)) < 1e-12
    mode_b = (70 / 150)
    assert abs(pr["B"][0] - (60 + 50 * mode_b) / (100 + 50)) < 1e-12
    assert abs(pr["B"][2] - hist["mode"]["m9"]) < 1e-12  # missing early mode -> historical mode
    # pooled C: c2 early 50/10 + historical c2 (say 30 fired / 20 hits) would be bigger; no hist cell -> equals early
    assert abs(pr["C"][1] - (10 + 20 * (70 / 150)) / (50 + 20)) < 1e-12
    # D: early cell c1 exists; c3 missing cell -> historical mode m9
    assert abs(pr["D"][0] - pr["A"][0]) < 1e-12
    assert abs(pr["D"][2] - hist["mode"]["m9"]) < 1e-12
    # rank determinism
    x = np.array([0.1, 0.5, 0.5, 0.9])
    assert np.allclose(rank_pct(x), rank_pct(x))
    # metrics sanity
    fired = np.full(20, 5, dtype=np.int64)
    hits = np.array([0] * 10 + [1] * 10, dtype=np.int64)
    prob = np.concatenate([np.linspace(0.0, 0.4, 10), np.linspace(0.6, 1.0, 10)])
    met = score_block(prob, fired, hits)
    assert met["auc"] > 0.9 and met["topDecileFishLift"] > 1.0, met
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-x hierarchical early/historical/mode EB priors")
    ap.add_argument("--runs-dir", default="")
    ap.add_argument("--split-summary", default="")
    ap.add_argument("--dataset", default="")
    ap.add_argument("--ships", default="")
    ap.add_argument("--outcome-dir", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("runs_dir", "split_summary", "dataset", "ships", "outcome_dir", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26x] missing arguments: " + ", ".join(missing))
    ships = json.loads(Path(args.ships).read_text(encoding="utf-8"))
    class_of = {}
    for sid, info in ships.get("ships", {}).items():
        if isinstance(info, dict) and info.get("type"):
            class_of[int(sid)] = str(info["type"])
    split = json.loads(Path(args.split_summary).read_text(encoding="utf-8"))
    blocks = load_blocks(Path(args.dataset), split, class_of)
    attach_outcomes(blocks, Path(args.outcome_dir))
    results = {}
    for run in ("runQ2", "runQ3", "runQ4"):
        results[run] = analyze_run(run, Path(args.runs_dir) / run / "holdout_ensemble.npz", blocks)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_lineage": "E26e-x hierarchical early+historical/mode EB priors (descriptive; no retraining)",
               "fractions": list(FRACTIONS), "alphaEarly": ALPHA_EARLY, "alphaHier": ALPHA_HIER,
               "results": results}
    (out_dir / "hierarchical_prior.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False) + chr(10), encoding="utf-8")
    write_markdown(results, out_dir / "hierarchical_prior_report.md")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        for frac in ("0.2", "0.4"):
            fr = r["fractions"][frac]
            print("[e26x] " + run + " " + frac + " evalN " + str(fr["evalN"])
                  + " raw " + str(round(fr["raw"]["topDecileFishLift"], 4))
                  + " A " + str(round(fr["variants"]["A"]["topDecileFishLift"], 4))
                  + " B " + str(round(fr["variants"]["B"]["topDecileFishLift"], 4))
                  + " C " + str(round(fr["variants"]["C"]["topDecileFishLift"], 4))
                  + " D " + str(round(fr["variants"]["D"]["topDecileFishLift"], 4))
                  + " oracle " + str(round(fr["oracle"]["topDecileFishLift"], 4))
                  + " | AUC raw " + str(round(fr["raw"]["auc"], 4))
                  + " B " + str(round(fr["variants"]["B"]["auc"], 4))
                  + " A " + str(round(fr["variants"]["A"]["auc"], 4))
                  + " C " + str(round(fr["variants"]["C"]["auc"], 4))
                  + " D " + str(round(fr["variants"]["D"]["auc"], 4)))
    print("[e26x] summary -> " + str(out_dir / "hierarchical_prior.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
