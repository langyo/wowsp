#!/usr/bin/env python3
"""E26e-ab: HP-drop magnitude label sensitivity on the r120 torch outcome sidecars.

Row-level variants of the shipped E26e-b hit label (hits = fish whose terminal was near
an enemy AND covered an HP drop). fired stays unchanged; only hits become 1/0:

  A        original r120 hits (control)
  B(t)     hits>0 and hp/hits >= t   (per-fish average covered HP drop; t=1000/2000/3000/5000)
  C(t)     hits>0 and hp >= t        (absolute covered HP drop)
  D        hits>0 and hits == terminalNear  (all near-enemy fish covered an HP drop; clean terminal)

Scores the E26e-g OOF probC on launched rows with the standard outcome_lift decile lift and
replay-cluster bootstrap (1000 reps / seed 0). Descriptive only: no retrain, no threshold line.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import sys
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from torpedo_outcome_lift import (  # noqa: E402
    analyze_launched, bootstrap_cluster, join_sidecars, load_oof, select_target_rows, spearman,
)

THRESHOLDS = (1000.0, 2000.0, 3000.0, 5000.0)


def build_variant_hits(hits: np.ndarray, hp: np.ndarray, terminal_near: np.ndarray,
                       variant: str, threshold: float = 0.0) -> np.ndarray:
    """Return the binary hit vector for one row-level label variant."""
    hits = np.asarray(hits, dtype=np.float64)
    hp = np.asarray(hp, dtype=np.float64)
    terminal_near = np.asarray(terminal_near, dtype=np.float64)
    positive = hits > 0
    if variant == "A":
        return hits.copy()
    if variant.startswith("B"):
        ratio = np.divide(hp, hits, out=np.zeros_like(hp), where=hits > 0)
        satisfied = positive & (ratio >= threshold)
    elif variant.startswith("C"):
        satisfied = positive & (hp >= threshold)
    elif variant == "D":
        satisfied = positive & (hits == terminal_near)
    else:
        raise SystemExit("[e26ab] unknown variant " + variant)
    return np.where(satisfied, 1.0, 0.0)


def variant_key(variant: str, threshold: float = 0.0) -> str:
    if variant in ("A", "D"):
        return variant
    return variant + ":" + str(int(threshold))


def metrics_for(prob, fired, hits, hp, groups, terminal_near, reps: int, seed: int) -> dict:
    analysis = analyze_launched(prob, fired, hits, hp, terminal_near=terminal_near)
    boot = bootstrap_cluster(prob, fired, hits, hp, groups, reps, seed)
    mean_rates = [d["meanProb"] for d in analysis["deciles"] if d["meanProb"] is not None]
    hit_rates = [d["hitRate"] for d in analysis["deciles"] if d["hitRate"] is not None]
    top = analysis["deciles"][0] if analysis["deciles"] else {}
    return {
        "rows": analysis["rows"],
        "firedFish": analysis["firedFish"],
        "hits": analysis["hits"],
        "baseHitRate": analysis["baseHitRate"],
        "topDecileHitRate": top.get("hitRate"),
        "topDecileRows": top.get("rows"),
        "topDecileLift": analysis["topDecileLift"],
        "spearmanDecile": analysis["spearmanDecile"],
        "spearmanRow": analysis["spearmanRow"],
        "lift95": boot["lift95"],
        "spearman95": boot["spearman95"],
        "clusters": boot["clusters"],
    }


def write_markdown(results: dict, path: Path) -> None:
    def f(v, d=4):
        return "-" if v is None else (str(round(v, d)) if isinstance(v, float) else str(v))

    lines = ["# E26e-ab HP-drop magnitude label sensitivity", ""]
    lines.append("E26e-g OOF probC on r120 launched rows; fired unchanged; standard outcome_lift decile lift.")
    lines.append("")
    lines.append("| variant | definition | rows | fired | hits | base | top-decile hitRate | lift | rho | lift95 | rho95 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for key in results["order"]:
        r = results["variants"][key]
        lines.append("| " + key + " | " + r["definition"] + " | " + str(r["metrics"]["rows"]) + " | "
                     + str(r["metrics"]["firedFish"]) + " | " + str(r["metrics"]["hits"]) + " | "
                     + f(r["metrics"]["baseHitRate"]) + " | " + f(r["metrics"].get("topDecileHitRate")) + " | "
                     + f(r["metrics"]["topDecileLift"]) + " | "
                     + f(r["metrics"]["spearmanDecile"]) + " | " + str(r["metrics"]["lift95"]) + " | "
                     + str(r["metrics"]["spearman95"]) + " |")
    lines.append("")
    lines.append("Per-variant keep rate vs control A: hits_variant / hits_A, rows unchanged.")
    lines.append("")
    lines.append("| variant | hits ratio vs A | mean hp/hit (A) |")
    lines.append("|---|---|---|")
    a_hits = results["variants"]["A"]["metrics"]["hits"]
    for key in results["order"]:
        r = results["variants"][key]
        ratio = (r["metrics"]["hits"] / a_hits) if a_hits else None
        lines.append("| " + key + " | " + f(ratio) + " | " + f(results["meanHpPerHit"]) + " |")
    lines.append("")
    lines.append("Descriptive only; per-fish server damage is not identifiable in the current replay schema "
                 "(see schema_audit.md). No 2.30 judgement.")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    hits = np.array([2.0, 1.0, 0.0, 1.0, 3.0])
    hp = np.array([3000.0, 500.0, 0.0, 2000.0, 9000.0])
    term = np.array([2.0, 2.0, 0.0, 1.0, 3.0])
    a = build_variant_hits(hits, hp, term, "A")
    assert np.array_equal(a, hits)
    b2 = build_variant_hits(hits, hp, term, "B", 2000)
    assert np.array_equal(b2, np.array([0.0, 0.0, 0.0, 1.0, 1.0])), b2
    c3 = build_variant_hits(hits, hp, term, "C", 3000)
    assert np.array_equal(c3, np.array([1.0, 0.0, 0.0, 0.0, 1.0])), c3
    d = build_variant_hits(hits, hp, term, "D")
    assert np.array_equal(d, np.array([1.0, 0.0, 0.0, 1.0, 1.0])), d
    # all-negative variant must not crash the metric helper
    prob = np.array([0.9, 0.8, 0.7, 0.6, 0.5])
    fired = np.array([2, 2, 2, 2, 2])
    met = metrics_for(prob, fired, np.zeros(5), fired.astype(float) * 0.0 + 1.0, np.arange(5), np.zeros(5), 10, 0)
    assert met["topDecileLift"] is None or isinstance(met["topDecileLift"], float)
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-ab HP-drop magnitude label sensitivity")
    ap.add_argument("--oof", default="")
    ap.add_argument("--outcome", nargs="+", default=[])
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--bootstrap", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("oof", "outcome", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26ab] missing arguments: " + ", ".join(missing))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    oof = load_oof(Path(args.oof))
    target_idx, sel_info = select_target_rows(oof, None, 0)
    sidecars = [Path(p) for p in args.outcome]
    if len(sidecars) != 4:
        raise SystemExit("[e26ab] expected 4 r120 sidecars (apac,eu,na,own)")
    j = join_sidecars(oof, sidecars, target_idx, lenient=False)
    joined = j["joined"]
    labelB = oof["labelB"][target_idx]
    probC = oof.get("probC")
    if probC is None:
        raise SystemExit("[e26ab] OOF npz has no probC")
    group_code = oof["groupCode"][target_idx]
    launched = joined & (labelB == 1.0)
    if int(launched.sum()) == 0:
        raise SystemExit("[e26ab] no launched rows")
    prob = probC[target_idx][launched]
    fired = np.asarray(j["fired"][launched], dtype=np.float64)
    hits = np.asarray(j["hits"][launched], dtype=np.float64)
    hp = np.asarray(j["hp"][launched], dtype=np.float64)
    terminal = np.asarray(j["terminalNear"][launched], dtype=np.float64)
    groups = group_code[launched]
    a_hits = int(hits.sum())
    mean_hp_per_hit = float(np.nansum(hp[hits > 0]) / max(a_hits, 1))
    variants = {}
    order = []
    definitions = {
        "A": "original r120 (control)",
        "D": "hits>0 and hits == torpTerminalNear (clean terminal)",
    }
    hits_a_metrics = metrics_for(prob, fired, hits, hp, groups, terminal, args.bootstrap, args.seed)
    variants["A"] = {"definition": definitions["A"], "metrics": hits_a_metrics}
    order.append("A")
    for t in THRESHOLDS:
        for prefix, label in (("B", "hits>0 and hp/hits >= " + str(int(t))),
                              ("C", "hits>0 and hp >= " + str(int(t)))):
            key = variant_key(prefix, t)
            vh = build_variant_hits(hits, hp, terminal, prefix, t)
            variants[key] = {"definition": label,
                             "metrics": metrics_for(prob, fired, vh, hp, groups, terminal, args.bootstrap, args.seed)}
            order.append(key)
    vh = build_variant_hits(hits, hp, terminal, "D")
    variants["D"] = {"definition": definitions["D"],
                     "metrics": metrics_for(prob, fired, vh, hp, groups, terminal, args.bootstrap, args.seed)}
    order.append("D")
    payload = {
        "_lineage": "E26e-ab HP-drop magnitude label sensitivity (descriptive; no retraining)",
        "protocol": {
            "oof": str(Path(args.oof)),
            "outcome": [str(p) for p in sidecars],
            "selectedRows": int(len(target_idx)),
            "joinedRows": int(joined.sum()),
            "joinCoverage": float(joined.mean()) if len(joined) else 0.0,
            "launchedRows": int(launched.sum()),
            "firedFish": int(fired.sum()),
            "controlHits": a_hits,
            "meanHpPerHit": mean_hp_per_hit,
            "bootstrap": {"reps": int(args.bootstrap), "seed": int(args.seed), "cluster": "replay"},
            "note": "row-level variants only; per-fish server damage is not identifiable (schema_audit.md)",
        },
        "order": order,
        "variants": variants,
        "meanHpPerHit": mean_hp_per_hit,
    }
    (out_dir / "magnitude.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    write_markdown(payload, out_dir / "magnitude_report.md")
    print("[e26ab] launched rows " + str(int(launched.sum())) + " firedFish " + str(int(fired.sum()))
          + " control hits " + str(a_hits))
    for key in order:
        m = variants[key]["metrics"]
        print("[e26ab] " + key + ": hits " + str(m["hits"]) + " base " + str(round(m["baseHitRate"], 4))
              + " lift " + str(round(m["topDecileLift"], 4)) + " rho " + str(round(m["spearmanDecile"], 4))
              + " CI " + str(m["lift95"]))
    print("[e26ab] summary -> " + str(out_dir / "magnitude.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
