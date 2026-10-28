#!/usr/bin/env python3
"""E17 hard validation: per-ship decision scores vs post-battle outcomes.

The E17 scoring system (packages/app/tauri/src/commands/decision_score.rs)
rates every team-known ship's decisions through a replay — instant scores
at 4 s decision points (fire-alignment proper-scoring term + move-sector
softmax mass), a whole-game mean, and an INDEPENDENT confidence output.
This script answers the pre-registered question:

    **Do ships whose decisions the models agree with actually end the
    battle with more damage / XP / frags?**

Input: the score JSONL dumped by the env-gated Rust test (one
`ShipScoreReport` per line):

    WOWSP_TEST_REPLAY_DIR=<replay folder> \
    WOWSP_SCORE_OUT=<abs path> \
        cargo test -p wowsp_tauri e17_score_batch -- --nocapture

Each report already carries the per-ship BattleResults join (damage /
baseExp / frags / survived, parsed Rust-side from the replay's 0x22
payload), so this script never re-decodes replays — it only correlates.

Reported:
  1. COVERAGE — how many scored ships join 1:1 to a battle-results entry;
     mirror-ambiguous shipIds (same hull on both teams / twice on one
     team, the #1202 lesson) and missing joins are counted, never guessed.
  2. CORRELATIONS — Spearman ρ of wholeGame / wholeFire / wholeMove vs
     damage / baseExp / frags over the joined ships, sliced all-modes /
     pvp-only / per ship class (BB / CA-CL / DD / CV / SS, class joined
     from the webui's baked gameparam_ids.json via the GameParams hull
     naming grammar `^P<nation>S<class><tier>`).
  3. PER-REPLAY RANKING — ρ of the WITHIN-replay rank correlation
     (score rank vs damage rank inside one battle), which is fairer than
     the global absolute score: no cross-mode / cross-tier level effects.
     Pooled significance via Fisher z.
  4. TIME STRUCTURE — variance of the instant score by battle-progress
     decile (which phases of the match does the score fluctuate in).

Pre-registered acceptance line (decided BEFORE looking at the data):
  |ρ(wholeGame, damage)| ≥ 0.30 and positive  -> "评分有效" (valid)
  0.15 ≤ |ρ| < 0.30 and positive              -> "弱信号" (weak signal)
  otherwise                                   -> failure, reported honestly
     with the candidate causes (weakly-supervised models still weak,
     damage is RNG/team-dependent, scoring-window coverage too thin).

Usage:
    python scripts/experiments/validate_scores.py --selftest
    python scripts/experiments/validate_scores.py \
        --scores scripts/experiments/out/score_validation/corpus162.jsonl \
        [--gameparam-ids <path>] [--json-out <path>] [--verbose]

Dependencies: numpy only.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

# ── pre-registered acceptance thresholds ─────────────────────────────────────

RHO_VALID = 0.30
RHO_WEAK = 0.15

# ── ship class join (GameParams hull naming grammar) ─────────────────────────

# Real hulls read `P<nation>S<class><tier…>…` with a single-letter nation
# prefix (A=usa, G=germany, F=france, J=japan, R=russia, B=uk, I=italy,
# V=spain, H=netherlands, Z=pan-asia, W=pan-america, …); the class letter
# follows `S`. Multi-letter prefixes (P*C…, PX…, PA* non-hull species)
# are events/collabs/permoflages and must not match.
HULL_RE = re.compile(r"^P[A-Z]S([BCDAS])\d")
CLASS_BY_LETTER = {"B": "BB", "C": "CA/CL", "D": "DD", "A": "CV", "S": "SS"}
CLASS_ORDER = ["BB", "CA/CL", "DD", "CV", "SS"]

# ── statistics (scipy-free) ──────────────────────────────────────────────────


def rankdata(v: np.ndarray) -> np.ndarray:
    """Average ranks (ties share the mean rank) — the Spearman requirement."""
    v = np.asarray(v, dtype=np.float64)
    order = np.argsort(v, kind="stable")
    ranks = np.empty(len(v), dtype=np.float64)
    i = 0
    while i < len(v):
        j = i
        while j + 1 < len(v) and v[order[j + 1]] == v[order[i]]:
            j += 1
        avg = 0.5 * (i + j) + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def pearson(x: np.ndarray, y: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if len(x) < 2:
        return float("nan")
    sx, sy = x.std(), y.std()
    if sx == 0.0 or sy == 0.0:
        return float("nan")
    return float(((x - x.mean()) * (y - y.mean())).mean() / (sx * sy))


def spearman(x, y) -> tuple[float, int]:
    """Spearman ρ + n. NaN (with n) when either side is constant / n < 3."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    n = len(x)
    if n < 3:
        return float("nan"), n
    rho = pearson(rankdata(x), rankdata(y))
    return rho, n


def rho_pvalue(rho: float, n: int) -> float | None:
    """Two-sided p under H0 ρ=0 (t-statistic + normal approx; labelled ≈)."""
    if not math.isfinite(rho) or n < 4:
        return None
    if abs(rho) >= 1.0:
        return 0.0
    t = rho * math.sqrt((n - 2) / (1.0 - rho * rho))
    return math.erfc(abs(t) / math.sqrt(2.0))


def fisher_z(rho: float, n: int) -> float:
    """Fisher z for one correlation (clamped, guard |rho|→1)."""
    rho = max(-0.999999, min(0.999999, rho))
    return math.atanh(rho) * math.sqrt(max(n - 3, 1))


# ── loading ──────────────────────────────────────────────────────────────────


def load_reports(path: Path) -> list[dict]:
    reports = []
    with open(path, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                reports.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise SystemExit(f"[e17] malformed score JSONL at {path}:{ln}: {e}") from e
    if not reports:
        raise SystemExit(f"[e17] no reports in {path} — rerun the e17_score_batch dump")
    return reports


def load_gameparam_ids(path: Path) -> dict[int, str]:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return {int(k): str(v) for k, v in raw.items()}


def default_gameparam_ids_path() -> Path:
    return Path(__file__).resolve().parents[2] / "packages/webui/src/data/gameparam_ids.json"


def ship_class(gp: dict[int, str], ship_id) -> str | None:
    if ship_id is None:
        return None
    name = gp.get(int(ship_id))
    if not name:
        return None
    m = HULL_RE.match(name)
    return CLASS_BY_LETTER[m.group(1)] if m else None


# ── flattening ───────────────────────────────────────────────────────────────


def flatten(reports: list[dict], gp: dict[int, str]) -> tuple[list[dict], dict]:
    """One row per scored ship + the coverage tally."""
    rows: list[dict] = []
    cov = {"ships": 0, "ok": 0, "ambiguous": 0, "missing": 0, "noShipId": 0, "classed": 0}
    for rep in reports:
        for s in rep.get("perShip", []):
            cov["ships"] += 1
            status = s.get("outcome", {}).get("status")
            cov[status if status in cov else "missing"] += 1
            if ship_class(gp, s.get("shipId")) is not None:
                cov["classed"] += 1
            rows.append(
                {
                    "replayId": rep.get("replayId"),
                    "mode": rep.get("gameMode") or "unknown",
                    "version": rep.get("replayVersion"),
                    "entityId": s["entityId"],
                    "shipId": s.get("shipId"),
                    "teamId": s.get("teamId"),
                    "isRecorder": bool(s.get("isRecorder")),
                    "cls": ship_class(gp, s.get("shipId")),
                    "samples": len(s.get("samples", [])),
                    "whole": s["wholeGame"],
                    "wholeFire": s.get("wholeFire"),
                    "wholeMove": s["wholeMove"],
                    "status": status,
                    "damage": s["outcome"].get("damage"),
                    "baseExp": s["outcome"].get("baseExp"),
                    "frags": s["outcome"].get("frags"),
                    "survived": s["outcome"].get("survived"),
                    "sample_series": s.get("samples", []),
                }
            )
    return rows, cov


# ── correlation battery ──────────────────────────────────────────────────────


def corr_entry(name: str, rows: list[dict], score_key: str, outcome_key: str) -> dict | None:
    xs = [r[score_key] for r in rows if r["status"] == "ok" and r.get(score_key) is not None
          and r.get(outcome_key) is not None]
    ys = [float(r[outcome_key]) for r in rows if r["status"] == "ok" and r.get(score_key) is not None
          and r.get(outcome_key) is not None]
    if not xs:
        return None
    rho, n = spearman(xs, ys)
    return {
        "name": name,
        "score": score_key,
        "outcome": outcome_key,
        "rho": None if not math.isfinite(rho) else rho,
        "n": n,
        "p": rho_pvalue(rho, n) if math.isfinite(rho) else None,
    }


def correlation_table(rows: list[dict], title: str) -> list[dict]:
    """The full battery over one slice: wholeGame vs damage/xp/frags plus
    the fire/move components vs damage."""
    out = []

    def add(slice_rows: list[dict], label: str) -> None:
        for sk, ok in [
            ("whole", "damage"),
            ("whole", "baseExp"),
            ("whole", "frags"),
            ("wholeFire", "damage"),
            ("wholeMove", "damage"),
        ]:
            e = corr_entry(f"{label}: {sk} vs {ok}", slice_rows, sk, ok)
            if e:
                out.append(e)

    add(rows, "all modes")
    pvp = [r for r in rows if r["mode"] == "pvp"]
    if pvp:
        add(pvp, "pvp only")
    for cls in CLASS_ORDER:
        sub = [r for r in rows if r["cls"] == cls]
        if sub:
            add(sub, f"class {cls}")
    return out


def min_samples_sensitivity(rows: list[dict], floor: int = 20) -> dict | None:
    """Sensitivity line (NOT the pre-registered metric): re-run the primary
    correlation over ships with ≥ `floor` scored samples — enemies spend
    most of a match dark, so their row counts are thin and their whole
    scores noisy; this shows how much of the primary ρ rides on them."""
    sub = [r for r in rows if r["status"] == "ok" and r["samples"] >= floor]
    e = corr_entry(f"samples ≥ {floor}: whole vs damage", sub, "whole", "damage")
    return e


def per_replay_ranking(rows: list[dict], min_ships: int = 4) -> dict:
    """Within-replay Spearman (score vs damage among joined ships) — the
    fairer comparison (no cross-mode level effects). Pooled via Fisher z."""
    by_replay: dict[str, list[dict]] = {}
    for r in rows:
        if r["status"] == "ok":
            by_replay.setdefault(r["replayId"], []).append(r)
    rhos: list[float] = []
    zs: list[float] = []
    skipped = 0
    for rid, rs in sorted(by_replay.items()):
        if len(rs) < min_ships:
            skipped += 1
            continue
        rho, n = spearman([r["whole"] for r in rs], [float(r["damage"]) for r in rs])
        if not math.isfinite(rho):
            skipped += 1
            continue
        rhos.append(rho)
        zs.append(fisher_z(rho, n))
    pooled_z = sum(zs) / math.sqrt(len(zs)) if zs else float("nan")
    pooled_rho = math.tanh(pooled_z / math.sqrt(len(zs))) if zs else float("nan")
    return {
        "replays_used": len(rhos),
        "replays_skipped": skipped,
        "min_ships": min_ships,
        "mean": float(np.mean(rhos)) if rhos else float("nan"),
        "median": float(np.median(rhos)) if rhos else float("nan"),
        "std": float(np.std(rhos)) if rhos else float("nan"),
        "positive_share": float(np.mean([r > 0 for r in rhos])) if rhos else float("nan"),
        "pooled_rho": pooled_rho,
        "pooled_z": pooled_z,
        "pooled_p": (
            math.erfc(abs(pooled_z) / math.sqrt(2.0)) if math.isfinite(pooled_z) else None
        ),
        "rhos": rhos,
    }


def time_structure(reports: list[dict], buckets: int = 10) -> list[dict]:
    """Instant-score variance by battle-progress decile: per replay, t is
    normalized by that replay's latest sample time, then samples pool."""
    insts: list[float] = []
    confs: list[float] = []
    fire_avail: list[float] = []
    progress: list[float] = []
    for rep in reports:
        t_max = max(
            (s["t"] for sh in rep.get("perShip", []) for s in sh.get("samples", [])),
            default=0.0,
        )
        if t_max <= 0:
            continue
        for sh in rep.get("perShip", []):
            for s in sh.get("samples", []):
                insts.append(s["inst"])
                confs.append(s["confidence"])
                fire_avail.append(1.0 if s.get("fire") is not None else 0.0)
                progress.append(s["t"] / t_max)
    if not insts:
        return []
    p = np.array(progress)
    i = np.array(insts)
    c = np.array(confs)
    f = np.array(fire_avail)
    edges = np.linspace(0.0, 1.0, buckets + 1)
    out = []
    for k in range(buckets):
        lo, hi = edges[k], edges[k + 1]
        m = (p >= lo) & (p < hi if hi < 1.0 else p <= hi)
        if not m.any():
            continue
        out.append(
            {
                "bucket": k,
                "progress_lo": float(lo),
                "n": int(m.sum()),
                "inst_mean": float(i[m].mean()),
                "inst_std": float(i[m].std()),
                "conf_mean": float(c[m].mean()),
                "fire_avail": float(f[m].mean()),
            }
        )
    return out


def verdict_line(rho: float | None) -> str:
    if rho is None:
        return "UNDEFINED (no joined ships / constant scores)"
    if rho >= RHO_VALID:
        return f"评分有效 (ρ ≥ {RHO_VALID:.2f}, positive)"
    if rho >= RHO_WEAK:
        return f"弱信号 ({RHO_WEAK:.2f} ≤ ρ < {RHO_VALID:.2f}, positive)"
    return f"未过线 (ρ < {RHO_WEAK:.2f} 或为负) — 如实报告并分析原因"


# ── rendering ────────────────────────────────────────────────────────────────


def fmt_p(p: float | None) -> str:
    if p is None:
        return "     —"
    if p == 0.0:
        return "  ~0   "
    if p < 1e-4:
        return f"{p:7.1e}"
    return f"{p:7.4f}"


def print_table(entries: list[dict]) -> None:
    print(f"  {'slice / metric':44s} {'ρ':>8s} {'n':>6s} {'p≈':>8s}")
    for e in entries:
        rho = "    —" if e["rho"] is None else f"{e['rho']:+8.4f}"
        print(f"  {e['name']:44s} {rho} {e['n']:6d} {fmt_p(e['p'])}")


# ── main / selftest ──────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(
        description=(
            "E17: correlate per-ship decision scores with post-battle "
            "damage/XP/frags (pre-registered Spearman acceptance line)."
        )
    )
    p.add_argument(
        "--scores",
        default=str(here / "out/score_validation/corpus162.jsonl"),
        help="score JSONL from the e17_score_batch Rust test (WOWSP_SCORE_OUT)",
    )
    p.add_argument(
        "--gameparam-ids",
        default=str(default_gameparam_ids_path()),
        help="webui baked gameparam_ids.json (shipId -> GameParams name)",
    )
    p.add_argument("--json-out", default=None, help="optional machine-readable report")
    p.add_argument("--min-ships-per-replay", type=int, default=4)
    p.add_argument("--selftest", action="store_true", help="synthetic-data self-validation")
    return p.parse_args(argv)


def run_validation(args: argparse.Namespace) -> dict:
    scores = Path(args.scores)
    if not scores.is_file():
        raise SystemExit(
            f"[e17] score file not found: {scores}\n"
            "      produce it with:\n"
            "      WOWSP_TEST_REPLAY_DIR=<folder> WOWSP_SCORE_OUT=<abs path> "
            "cargo test -p wowsp_tauri e17_score_batch -- --nocapture"
        )
    reports = load_reports(scores)
    gp_path = Path(args.gameparam_ids)
    if gp_path.is_file():
        gp = load_gameparam_ids(gp_path)
    else:
        print(f"[e17] WARNING: {gp_path} not found — class buckets disabled")
        gp = {}

    rows, cov = flatten(reports, gp)
    print(
        f"[e17] {len(reports)} replays, {cov['ships']} scored ships; "
        f"join ok {cov['ok']} / ambiguous {cov['ambiguous']} / missing {cov['missing']} "
        f"/ noShipId {cov['noShipId']}"
        f" ({cov['ok'] / max(cov['ships'], 1):.1%} coverage)"
    )
    if gp:
        print(f"[e17] ship class resolved for {cov['classed']}/{cov['ships']} ships")
    modes: dict[str, int] = {}
    for r in rows:
        modes[r["mode"]] = modes.get(r["mode"], 0) + 1
    print(f"[e17] modes: {dict(sorted(modes.items(), key=lambda kv: -kv[1]))}")

    print("\n[corr] Spearman ρ (joined ships only):")
    table = correlation_table(rows, "all")
    print_table(table)

    sens = min_samples_sensitivity(rows)
    if sens:
        print("[sensitivity] coverage check (not the pre-registered metric):")
        print_table([sens])

    pr = per_replay_ranking(rows, args.min_ships_per_replay)
    print(
        f"\n[within-replay] score rank vs damage rank inside one battle "
        f"(≥{pr['min_ships']} joined ships): {pr['replays_used']} replays used, "
        f"{pr['replays_skipped']} skipped\n"
        f"  mean ρ {pr['mean']:+.4f} (median {pr['median']:+.4f}, σ {pr['std']:.4f}, "
        f"positive in {pr['positive_share']:.1%} of replays); "
        f"pooled ρ {pr['pooled_rho']:+.4f} (z {pr['pooled_z']:+.1f}, p≈{fmt_p(pr['pooled_p']).strip()})"
    )

    ts = time_structure(reports)
    print("\n[time] instant-score structure by battle-progress decile:")
    print(
        f"  {'bucket':>6s} {'progress':>12s} {'n':>7s} {'inst μ':>8s} {'inst σ':>8s} "
        f"{'conf μ':>8s} {'can-fire':>8s}"
    )
    for b in ts:
        print(
            f"  {b['bucket']:6d} {b['progress_lo']:5.0%}+     {b['n']:7d} "
            f"{b['inst_mean']:8.4f} {b['inst_std']:8.4f} {b['conf_mean']:8.4f} "
            f"{b['fire_avail']:8.1%}"
        )
    if ts:
        head = [b for b in ts if b["bucket"] <= 1]
        tail = [b for b in ts if b["bucket"] >= 8]
        hs = sum(b["inst_std"] * b["n"] for b in head) / max(sum(b["n"] for b in head), 1)
        tstd = sum(b["inst_std"] * b["n"] for b in tail) / max(sum(b["n"] for b in tail), 1)
        print(
            f"  opening (first 20%) inst σ {hs:.4f} vs endgame (last 20%) {tstd:.4f} "
            f"→ {'endgame' if tstd > hs else 'opening'} fluctuates more"
        )

    main_row = next(
        (e for e in table if e["name"] == "all modes: whole vs damage"),
        None,
    )
    main_rho = main_row["rho"] if main_row else None
    print(f"\n[verdict] wholeGame vs damage (all joined ships): "
          f"ρ = {'—' if main_rho is None else f'{main_rho:+.4f}'} → {verdict_line(main_rho)}")
    pvp_row = next((e for e in table if e["name"] == "pvp only: whole vs damage"), None)
    if pvp_row and pvp_row["rho"] is not None:
        print(f"[verdict] pvp-only slice: ρ = {pvp_row['rho']:+.4f} (n {pvp_row['n']})")

    result = {
        "scores": str(scores),
        "replays": len(reports),
        "coverage": cov,
        "modes": modes,
        "correlations": table,
        "min_samples_sensitivity": sens,
        "within_replay": {k: v for k, v in pr.items() if k != "rhos"},
        "time_structure": ts,
        "verdict": {
            "metric": "wholeGame vs damage (all joined)",
            "rho": main_rho,
            "n": main_row["n"] if main_row else 0,
            "p": main_row["p"] if main_row else None,
            "call": verdict_line(main_rho),
            "thresholds": {"valid": RHO_VALID, "weak": RHO_WEAK},
        },
    }
    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"[e17] wrote {args.json_out}")
    return result


# ── selftest (numpy-only, synthetic) ─────────────────────────────────────────


def run_selftest() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        # Synthetic gameparam table: hull grammar -> class.
        gp = {
            9001: "PGSB908_Some_Battleship",
            9002: "PFSD508_Some_Destroyer",
            9003: "PASC508_Some_Cruiser",
            9004: "PAES384_Not_A_Hull_Event",  # multi-letter prefix: no class
        }
        assert ship_class(gp, 9001) == "BB"
        assert ship_class(gp, 9002) == "DD"
        assert ship_class(gp, 9003) == "CA/CL"
        assert ship_class(gp, 9004) is None
        assert ship_class(gp, None) is None
        assert ship_class(gp, 424242) is None

        # ranks / spearman: perfect, tied, inverted, constant.
        r = rankdata(np.array([3.0, 1.0, 2.0, 2.0]))
        assert list(r) == [4.0, 1.0, 2.5, 2.5], r
        assert abs(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])[0] - 1.0) < 1e-12
        assert abs(spearman([1, 2, 3], [3, 2, 1])[0] + 1.0) < 1e-12
        # ties: still +1 when monotone on averaged ranks.
        assert abs(spearman([1, 2, 2, 3], [1, 2, 2, 3])[0] - 1.0) < 1e-12
        assert math.isnan(spearman([1, 1, 1], [1, 2, 3])[0])
        assert math.isnan(spearman([1, 2], [2, 1])[0])  # n < 3
        assert rho_pvalue(1.0, 10) == 0.0
        p = rho_pvalue(0.3, 100)
        assert 0.001 < p < 0.01, p

        # Synthetic reports: replayA's ships' scores perfectly monotone in
        # damage; replayB inverted (anti-correlated); plus one AMBIGUOUS
        # ship per replay with extreme values that must never leak into ρ.
        def rep(rid, mode, specs):
            per_ship = []
            for ent, ship_id, whole, damage, status in specs:
                outcome = (
                    {"status": "ok", "damage": damage, "baseExp": damage / 20.0,
                     "frags": damage / 40000.0, "survived": damage > 60000}
                    if status == "ok"
                    else {"status": status}
                )
                per_ship.append(
                    {
                        "entityId": ent,
                        "shipId": ship_id,
                        "teamId": ent % 2,
                        "isRecorder": ent == 1,
                        "wholeGame": whole,
                        "wholeFire": 0.5,
                        "wholeMove": whole,
                        "samples": [
                            {"t": 10.0 * i, "inst": whole, "fire": None, "move": whole,
                             "confidence": 0.5}
                            for i in range(6)
                        ],
                        "outcome": outcome,
                    }
                )
            return {
                "replayId": rid,
                "gameMode": mode,
                "replayVersion": "15,8,0,0",
                "perShip": per_ship,
            }

        dmg_a = [20000.0, 40000.0, 60000.0, 80000.0, 100000.0, 120000.0]
        specs_a = [(i + 1, 9001 + i % 3, 0.2 + 0.12 * i, d, "ok") for i, d in enumerate(dmg_a)]
        # Ambiguous mirror ship with a wild score — excluded from ρ.
        specs_a.append((99, 9001, 0.99, 999999.0, "ambiguous"))
        specs_a.append((98, 9004, 0.01, 0.0, "missing"))
        specs_b = [(i + 1, 9001, 0.9 - 0.1 * i, 20000.0 + 20000.0 * i, "ok") for i in range(5)]
        reports = [rep("replayA", "pvp", specs_a), rep("replayB", "brawl", specs_b)]
        rows, cov = flatten(reports, gp)
        assert cov["ships"] == 13 and cov["ok"] == 11
        assert cov["ambiguous"] == 1 and cov["missing"] == 1

        # Global ρ over the pooled rows (mixing a +1 replay and a −1 replay
        # lands somewhere finite — the exact per-replay values are asserted
        # below, where the exclusion of ambiguous/missing also shows).
        e = corr_entry("t", rows, "whole", "damage")
        assert e["n"] == 11 and math.isfinite(e["rho"]), e
        rows_a = [r for r in rows if r["replayId"] == "replayA"]
        ea = corr_entry("a", rows_a, "whole", "damage")
        assert abs(ea["rho"] - 1.0) < 1e-12, ea  # ambiguous/missing excluded
        rows_b = [r for r in rows if r["replayId"] == "replayB"]
        eb = corr_entry("b", rows_b, "whole", "damage")
        assert abs(eb["rho"] + 1.0) < 1e-12, eb

        # Per-replay ranking: mean of (+1, −1) = 0; positive share 0.5.
        pr = per_replay_ranking(rows, min_ships=4)
        assert pr["replays_used"] == 2
        assert abs(pr["mean"]) < 1e-12 and abs(pr["positive_share"] - 0.5) < 1e-12

        # Class buckets: A used shipIds 9001/9002/9003 cyclically.
        table = correlation_table(rows, "t")
        names = [e["name"] for e in table]
        assert "class BB: whole vs damage" in names
        assert "pvp only: whole vs damage" in names  # replayA is pvp

        # Time structure: one bucket set, uniform σ 0 here, t_max normalized.
        ts = time_structure(reports)
        assert ts and sum(b["n"] for b in ts) == 13 * 6
        assert all(b["fire_avail"] == 0.0 for b in ts)  # fire: None everywhere

        # Verdict thresholds.
        assert "valid" in verdict_line(0.42).lower() or "有效" in verdict_line(0.42)
        assert "弱" in verdict_line(0.2)
        assert "弱" not in verdict_line(0.1)

        # Full round-trip through the file loader.
        path = tdp / "scores.jsonl"
        with open(path, "w", encoding="utf-8") as f:
            for r in reports:
                f.write(json.dumps(r) + "\n")
        assert len(load_reports(path)) == 2

    print("[selftest] E17 validate_scores logic OK (ranks/spearman/join/buckets/verdict)")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.selftest:
        return run_selftest()
    run_validation(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
