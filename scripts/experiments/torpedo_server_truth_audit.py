#!/usr/bin/env python3
"""E26e-m: audit the 120u + HP-drop hit proxy against server damageStat truth.

The E26e-b/E26e-g hit label is a *proxy*: a torpedo salvo "hits" when its last
fish ends within 120 units of an enemy hull and an enemy HP drop is observed in
the +-0.4/0.6 s window. This script audits that proxy against the replay's
server-side cumulative damage counter (weapon=7 / category=0 = torpedo damage
DEALT by the recorder's ship; shared stream.rs documents category0 as
"damage dealt", matching the Rust fire_dataset exporter).

Truth contract (per launched row owned by the recorder):
  base   = damageCount(t_base)      # last cumulative sample with time <= t
  end    = damageCount(t + 2 + 120) # last cumulative sample with time <= t+122
  delta  = max(0, end - base), clamped to torpFiredFish
  serverHasTruth = 1 only for rows of the damage timeline's recorderEntityId;
  rows without a damage sample for their replay get serverHasTruth = 0.

Only the recorder's own rows can be verified (damageStat is the recorder's
local damage-dealt counter), and adjacent 2 s rows overlap the t+2..t+122
window, so the same server increment can be counted by several rows — both are
audit notes, not corrections.

Outputs:
  server_outcome_{shard}.jsonl  -- E26e-b schema, torpHits := server delta>0 count
  audit_summary.json            -- coverage, confusion, precision/recall, server-label lift

Usage:
  python scripts/experiments/torpedo_server_truth_audit.py \
    --rows  out/torpedo_model/e26e-m/apac/rows.jsonl ... \
    --damage out/torpedo_model/e26e-m/apac/damage.jsonl ... \
    --shards apac eu na own \
    --out-dir out/torpedo_model/e26e-m \
    --oof out/torpedo_model/e26e-g/e26e_g_oof.npz
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

SHARD_NAMES = ("apac", "eu", "na", "own")
SERVER_WINDOW_AFTER = 2.0 + 120.0  # t+2 .. t+120, same window as E26e-b outcome
MIN_TRUTH_ROWS = 200
LIFT_MIN = 2.30
RHO_MIN = 0.30
FIELD_ALIASES = {
    "replayId": ("replayId", "replay_id"),
    "t": ("t", "time"),
    "shipId": ("shipId", "ship_id"),
    "owner": ("ownerEntityId", "owner_entity_id", "ownerEntity"),
    "labelB": ("labelB", "label_b_launched", "labelBLaunched"),
    "fired": ("torpFiredFish", "torp_fired_fish", "firedFish"),
    "hits": ("torpHits", "torp_hits", "hits"),
    "recorder": ("recorderEntityId", "recorder_entity_id", "recorderEntity"),
    "count": ("count", "torpHitsCumulative"),
}


def pick(row: dict, key: str):
    for name in FIELD_ALIASES[key]:
        if name in row:
            return row[name]
    return None


def load_damage(path: Path) -> dict:
    """Load one shard's damage timeline: replayId -> {recorder, times, counts}."""
    timelines: dict[str, dict] = {}
    n = 0
    with Path(path).open("r", encoding="utf-8") as f:
        for line in f:
            st = line.strip()
            if not st:
                continue
            row = json.loads(st)
            rid = str(row.get("replayId"))
            t = float(row.get("time"))
            c = float(row.get("count", 0))
            rec = row.get("recorderEntityId")
            tl = timelines.get(rid)
            if tl is None:
                tl = {"recorder": rec, "times": [], "counts": []}
                timelines[rid] = tl
            tl["times"].append(t)
            tl["counts"].append(c)
            n += 1
    for tl in timelines.values():
        order = np.argsort(np.asarray(tl["times"], dtype=np.float64), kind="mergesort")
        tl["times"] = np.asarray(tl["times"], dtype=np.float64)[order]
        tl["counts"] = np.asarray(tl["counts"], dtype=np.float64)[order]
    return {"samples": n, "replays": len(timelines), "timelines": timelines}


def last_count(tl: dict, t: float) -> float:
    i = int(np.searchsorted(tl["times"], t, side="right")) - 1
    return float(tl["counts"][i]) if i >= 0 else 0.0


def server_delta(tl: dict | None, t: float, fired: int) -> float | None:
    """Server torpedo-hit delta in (t, t+122] for a recorder row, clamp to fired."""
    if tl is None:
        return None
    base = last_count(tl, t)
    end = last_count(tl, t + SERVER_WINDOW_AFTER)
    delta = max(0.0, end - base)
    return min(delta, float(max(int(fired), 0)))


def process_shard(rows_path: Path, damage_path: Path, shard: str, out_dir: Path) -> dict:
    dmg = load_damage(damage_path)
    timelines = dmg["timelines"]
    server_path = out_dir / ("server_outcome_" + shard + ".jsonl")
    n_rows = 0
    n_launched = 0
    n_recorder_launched = 0
    n_truth = 0
    tp = fp = fn = tn = 0
    proxy_hit_sum = 0
    server_hit_sum = 0
    damage_replays_with_rows = set()
    with rows_path.open("r", encoding="utf-8") as fin, server_path.open("w", encoding="utf-8") as fout:
        for line in fin:
            st = line.strip()
            if not st:
                continue
            row = json.loads(st)
            n_rows += 1
            rid = str(pick(row, "replayId"))
            t = float(pick(row, "t"))
            ship = pick(row, "shipId")
            label_b = pick(row, "labelB")
            fired = int(pick(row, "fired") or 0)
            proxy_hits = int(pick(row, "hits") or 0)
            launched = bool(label_b) and fired > 0
            if launched:
                n_launched += 1
            tl = timelines.get(rid)
            recorder = tl.get("recorder") if tl is not None else None
            owner = pick(row, "owner")
            recorder_row = False
            try:
                recorder_row = recorder is not None and int(owner) == int(recorder)
            except (TypeError, ValueError):
                recorder_row = False
            delta = None
            if launched and recorder_row and tl is not None:
                n_recorder_launched += 1
                delta = server_delta(tl, t, fired)
                if delta is not None:
                    n_truth += 1
                    damage_replays_with_rows.add(rid)
                    proxy_hit = proxy_hits > 0
                    server_hit = delta > 0.0
                    if proxy_hit and server_hit:
                        tp += 1
                    elif proxy_hit and not server_hit:
                        fp += 1
                    elif (not proxy_hit) and server_hit:
                        fn += 1
                    else:
                        tn += 1
                    proxy_hit_sum += proxy_hits
                    server_hit_sum += int(round(delta))
            fout.write(json.dumps({
                "replayId": rid,
                "t": t,
                "shipId": ship,
                "torpFiredFish": fired if (launched and recorder_row) else 0,
                "torpHits": int(round(delta)) if (delta is not None and delta > 0.0) else 0,
                "torpHpLostNearby": 0.0,
                "torpTerminalNear": 0,
            }, ensure_ascii=False) + "\n")
    precision = (tp / (tp + fp)) if (tp + fp) > 0 else None
    recall = (tp / (tp + fn)) if (tp + fn) > 0 else None
    f1 = (2 * precision * recall / (precision + recall)) if (precision is not None and recall is not None and (precision + recall) > 0) else None
    return {
        "shard": shard,
        "rows": n_rows,
        "launchedRows": n_launched,
        "recorderLaunchedRows": n_recorder_launched,
        "truthRows": n_truth,
        "damageSamples": dmg["samples"],
        "damageReplays": dmg["replays"],
        "truthReplays": len(damage_replays_with_rows),
        "proxyHits": tp + fp,
        "serverHits": tp + fn,
        "proxyFishHits": proxy_hit_sum,
        "serverFishHits": server_hit_sum,
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "proxyHitRate": (tp + fp) / n_truth if n_truth else None,
        "serverHitRate": (tp + fn) / n_truth if n_truth else None,
        "serverOutcome": str(server_path),
    }


def evaluate_server_labels(oof_path: Path, server_paths: list[Path], reps: int, seed: int) -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import torpedo_outcome_lift as tol

    oof = tol.load_oof(Path(oof_path))
    target_idx = np.arange(len(oof["labelB"]), dtype=np.int64)
    joined = tol.join_sidecars(oof, server_paths, target_idx)
    launched = (oof["labelB"] == 1.0) & (joined["fired"] > 0)
    prob = oof["probC"][launched]
    fired = joined["fired"][launched]
    hits = joined["hits"][launched]
    hp = joined["hp"][launched]
    groups = oof["groupCode"][launched]
    analysis = tol.analyze_launched(prob, fired, hits, hp)
    boot = tol.bootstrap_cluster(prob, fired, hits, hp, groups, reps, seed)
    lift = analysis["topDecileLift"]
    rho = analysis["spearmanDecile"]
    lift_ci = boot["lift95"]
    verdict = (
        lift is not None and lift >= LIFT_MIN and rho is not None and rho >= RHO_MIN
        and lift_ci is not None and lift_ci[0] > 0.0
    )
    return {
        "oof": str(oof_path),
        "rows": int(launched.sum()),
        "truthRows": int(launched.sum()),
        "firedFish": int(fired.sum()),
        "hits": int(hits.sum()),
        "baseHitRate": analysis["baseHitRate"],
        "topDecileLift": lift,
        "spearmanDecile": rho,
        "bootstrap": boot,
        "verdict": "PASS" if verdict else "MIXED",
        "minLift": LIFT_MIN,
        "minRho": RHO_MIN,
        "rowsJoined": int(len(launched)),
        "rowsInOof": int(len(oof["labelB"])),
        "joined": {k: joined[k] for k in ("mismatch_replay", "mismatch_t", "mismatch_ship", "joinKeyMissing", "rowIndexMode")},
    }


def run_selftest() -> int:
    import tempfile

    root = Path(tempfile.mkdtemp(prefix="e26m-selftest-"))
    timeline = {"recorder": 42, "times": np.array([90.0, 95.0, 101.0, 130.0, 220.0]), "counts": np.array([0.0, 1.0, 1.0, 2.0, 3.0])}
    assert last_count(timeline, 5.0) == 0.0
    assert last_count(timeline, 90.0) == 0.0 and last_count(timeline, 92.0) == 0.0
    assert last_count(timeline, 95.0) == 1.0 and last_count(timeline, 200.0) == 2.0
    # base at t=100 -> 1, end at t+122=222 -> 3 => delta 2 (clamped to fired 2)
    assert server_delta(timeline, 100.0, 5) == 2.0
    assert server_delta(timeline, 100.0, 1) == 1.0
    # no samples in the window -> same count at both ends -> 0
    assert server_delta(timeline, 230.0, 5) == 0.0
    # no timeline -> no truth
    assert server_delta(None, 100.0, 3) is None

    rows = [
        {"replayId": "r1", "t": 100.0, "shipId": 1, "ownerEntityId": 42, "labelB": True, "torpFiredFish": 2, "torpHits": 1},
        {"replayId": "r1", "t": 200.0, "shipId": 1, "ownerEntityId": 42, "labelB": True, "torpFiredFish": 2, "torpHits": 0},
        {"replayId": "r1", "t": 100.0, "shipId": 2, "ownerEntityId": 7, "labelB": True, "torpFiredFish": 3, "torpHits": 1},
        {"replayId": "r1", "t": 10.0, "shipId": 1, "ownerEntityId": 42, "labelB": None, "torpFiredFish": 0, "torpHits": 0},
    ]
    damage = [
        {"replayId": "r1", "recorderEntityId": 42, "time": 101.0, "weapon": 7, "category": 0, "count": 1, "total": 5000.0},
        {"replayId": "r1", "recorderEntityId": 42, "time": 130.0, "weapon": 7, "category": 0, "count": 2, "total": 9000.0},
    ]
    rows_p = root / "rows.jsonl"
    dmg_p = root / "damage.jsonl"
    rows_p.write_text(chr(10).join(json.dumps(r) for r in rows) + chr(10), encoding="utf-8")
    dmg_p.write_text(chr(10).join(json.dumps(d) for d in damage) + chr(10), encoding="utf-8")
    out = root / "out"
    out.mkdir()
    a = process_shard(rows_p, dmg_p, "t", out)
    assert a["rows"] == 4 and a["launchedRows"] == 3 and a["recorderLaunchedRows"] == 2
    assert a["truthRows"] == 2, a
    # file timeline is [101:1, 130:2]:
    #   row1 t=100: base 0, end 2 -> delta 2, proxy 1 -> TP
    #   row2 t=200: base 2, end 2 -> delta 0, proxy 0 -> TN
    assert a["confusion"] == {"tp": 1, "fp": 0, "fn": 0, "tn": 1}, a["confusion"]
    assert abs(a["precision"] - 1.0) < 1e-12 and abs(a["recall"] - 1.0) < 1e-12
    side = [json.loads(line) for line in (out / "server_outcome_t.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(side) == 4
    assert side[0]["torpFiredFish"] == 2 and side[0]["torpHits"] == 2
    assert side[1]["torpFiredFish"] == 2 and side[1]["torpHits"] == 0
    assert side[2]["torpFiredFish"] == 0 and side[2]["torpHits"] == 0  # non-recorder excluded
    assert side[3]["torpFiredFish"] == 0 and side[3]["torpHits"] == 0  # not launched
    b = process_shard(rows_p, dmg_p, "t", out)
    assert b["confusion"] == a["confusion"], "audit must be deterministic"
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-m server damageStat truth audit")
    ap.add_argument("--rows", nargs="+", default=[])
    ap.add_argument("--damage", nargs="+", default=[])
    ap.add_argument("--shards", nargs="+", default=list(SHARD_NAMES))
    ap.add_argument("--out-dir", default="out/torpedo_model/e26e-m")
    ap.add_argument("--oof", default="")
    ap.add_argument("--bootstrap", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    if not args.rows or not args.damage:
        raise SystemExit("[e26m] --rows and --damage are required")
    if len(args.rows) != len(args.damage):
        raise SystemExit("[e26m] --rows and --damage must pair up shard by shard")
    if len(args.rows) != len(args.shards):
        raise SystemExit("[e26m] --shards must name every --rows/--damage pair")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    per_shard = []
    for rows_p, dmg_p, shard in zip(args.rows, args.damage, args.shards):
        r = process_shard(Path(rows_p), Path(dmg_p), shard, out_dir)
        per_shard.append(r)
        print(
            "[e26m] " + shard + ": rows " + format(r["rows"], ",") + ", launched " + format(r["launchedRows"], ",")
            + ", recorder-launched " + format(r["recorderLaunchedRows"], ",") + ", truth " + format(r["truthRows"], ",")
            + ", conf tp/fp/fn/tn " + str([r["confusion"][k] for k in ("tp", "fp", "fn", "tn")]),
            flush=True,
        )
    tot = {k: sum(r[k] for r in per_shard) for k in ("rows", "launchedRows", "recorderLaunchedRows", "truthRows", "damageSamples", "damageReplays", "truthReplays", "proxyHits", "serverHits", "proxyFishHits", "serverFishHits")}
    conf = {k: sum(r["confusion"][k] for r in per_shard) for k in ("tp", "fp", "fn", "tn")}
    precision = conf["tp"] / (conf["tp"] + conf["fp"]) if (conf["tp"] + conf["fp"]) > 0 else None
    recall = conf["tp"] / (conf["tp"] + conf["fn"]) if (conf["tp"] + conf["fn"]) > 0 else None
    f1 = (2 * precision * recall / (precision + recall)) if (precision is not None and recall is not None and (precision + recall) > 0) else None
    summary = {
        "lineage": "E26e-m 120u+HP-drop proxy vs server damageStat truth (recorder rows only)",
        "windowSeconds": SERVER_WINDOW_AFTER,
        "shards": per_shard,
        "totals": tot,
        "overall": {
            "confusion": conf,
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "proxyHitRate": (conf["tp"] + conf["fp"]) / max(tot["truthRows"], 1) if tot["truthRows"] else None,
            "serverHitRate": (conf["tp"] + conf["fn"]) / max(tot["truthRows"], 1) if tot["truthRows"] else None,
            "proxyFishHits": tot["proxyFishHits"],
            "serverFishHits": tot["serverFishHits"],
            "truthRows": tot["truthRows"],
        },
        "notes": [
            "damageStat is the recorder's local damage-dealt counter (weapon=7 / category=0 = damage dealt; shared stream.rs); only rows whose ownerEntityId == the damage timeline recorderEntityId have truth",
            "server delta is computed on the same (t, t+2+120] window as the E26e-b outcome proxy",
            "adjacent 2 s rows overlap the 122 s window, so one server increment can be counted by several rows",
            "proxy label = torpHits > 0 from the E26e-b sidecar; server label = delta > 0",
            "server sidecars keep the E26e-b schema; non-recorder rows carry fired=0/hits=0 so the base counts recorder fish only",
            "proxyHitRate = (tp+fp)/truthRows; serverHitRate = (tp+fn)/truthRows; fish-level uses proxyFishHits/serverFishHits over the same fired fish",
        ],
    }
    eval_info = None
    if args.oof:
        server_paths = [out_dir / ("server_outcome_" + s + ".jsonl") for s in args.shards]
        eval_info = evaluate_server_labels(Path(args.oof), server_paths, args.bootstrap, args.seed)
        summary["serverLabelEval"] = eval_info
        summary["judgement"] = {
            "rule": "truth rows >= 200 => server-label headC lift >= 2.30, rho >= 0.30, CI excludes 0",
            "truthRows": tot["truthRows"],
            "runsLiftGate": bool(tot["truthRows"] >= MIN_TRUTH_ROWS),
            "verdict": eval_info["verdict"] if tot["truthRows"] >= MIN_TRUTH_ROWS else "DESCRIPTIVE",
        }
        print(
            "[e26m] server-label headC: lift " + str(eval_info["topDecileLift"]) + ", rho " + str(eval_info["spearmanDecile"])
            + ", CI " + str(eval_info["bootstrap"]["lift95"]) + ", verdict " + eval_info["verdict"],
            flush=True,
        )
    summary_path = out_dir / "audit_summary.json"
    summary_path.write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    print("[e26m] audit -> " + str(summary_path), flush=True)
    if eval_info is not None:
        lift_path = out_dir / "server_lift.json"
        lift_path.write_text(json.dumps({"protocol": {"probKey": "C", "minLift": LIFT_MIN, "bootstrap": args.bootstrap, "seed": args.seed}, "eval": eval_info}, indent=1, ensure_ascii=False), encoding="utf-8")
        print("[e26m] server lift -> " + str(lift_path), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())