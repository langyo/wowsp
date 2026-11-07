#!/usr/bin/env python3
"""packed-crack analysis companion for dump_sq_planes_health_series
(packages/app/replay_core/src/packets/tests.rs). Reads
scripts/experiments/out/sq_planes_health_dump.jsonl and verifies the
solved packing of receive_squadronPlanesHealth(PLANE_ID, UINT64):

  3 bits per flying plane, plane 0 = least significant digit;
  digit 1 = HP > 3/4 (full), 2 = (1/4, 3/4] (damaged), 4 = <= 1/4
  (critical); digit count = flying planes; a plane death drops the top
  digit; companion float hp = sum(plane HP) / numPlanes at spawn.

Usage: python scripts/experiments/sq_planes_health_analyze.py [dump.jsonl]
"""

import json
import sys
from collections import defaultdict

path = sys.argv[1] if len(sys.argv) > 1 else "scripts/experiments/out/sq_planes_health_dump.jsonl"
with open(path, encoding="utf-8") as fh:
    raw = [json.loads(line) for line in fh if line.strip()]

# De-duplicate per-avatar broadcast copies: same (m, t, planeId, payload).
seen = set()
events = []
for e in raw:
    payload = e.get("packed", e.get("hp", e.get("dead", e.get("hex", ""))))
    key = (e["m"], e["t"], e["planeId"], str(payload))
    if key in seen:
        continue
    seen.add(key)
    events.append(e)
events.sort(key=lambda e: e["t"])


def digits(packed):
    """Raw 3-bit fields of the packed u64, LSB-first (plane 0 first)."""
    d = []
    v = packed
    while v:
        d.append(v & 7)
        v >>= 3
    return d


by_squadron = defaultdict(list)
for e in events:
    by_squadron[e["planeId"]].append(e)

# Synchronized (packed, hp-float) rows, denominator = numPlanes at spawn
# (addSquadron arg byte 18 - NOT totalNumPlanes; partial launches exist).
rows = []
for pid, evs in by_squadron.items():
    add = next((e for e in evs if e["m"] == "add"), None)
    if not add or not add.get("numPlanes"):
        continue
    hps = [e for e in evs if e["m"] == "hp"]
    for p in (e for e in evs if e["m"] == "packed"):
        best = min(hps, key=lambda h: abs(h["t"] - p["t"]), default=None)
        if best is None or abs(best["t"] - p["t"]) > 0.35:
            continue
        rows.append({
            "pid": pid,
            "N": add["numPlanes"],
            "t": p["t"],
            "hp": best["hp"],
            "d": digits(p["packed"]),
            "y": best["hp"] * add["numPlanes"],
        })

hist = defaultdict(int)
for r in rows:
    for d in r["d"]:
        hist[d] += 1
print(f"events: {len(raw)} -> dedup {len(events)}; squadrons: {len(by_squadron)}; "
      f"synchronized samples: {len(rows)}")
print("digit histogram:", dict(sorted(hist.items())))


def violations(b12, b24):
    """Samples outside sum(band lows) <= hp*N <= sum(band highs)."""
    bad = []
    for r in rows:
        lo = hi = 0.0
        for dg in r["d"]:
            lo += {1: b12, 2: b24}.get(dg, 0.0)
            hi += {1: 1.0, 2: b12}.get(dg, b24)
        if not (lo <= r["y"] + 1e-4 and r["y"] <= hi + 1e-4):
            bad.append(r)
    return bad


for b12, b24 in [(0.75, 0.25), (0.8, 0.25), (0.85, 0.35), (0.75, 0.2),
                 (0.7, 0.25), (2 / 3, 1 / 3)]:
    print(f"bands {b12:.3f}/{b24:.3f}: violations {len(violations(b12, b24))}/{len(rows)}")

feas = []
b12 = 0.70
while b12 <= 0.8501:
    b24 = 0.15
    while b24 <= 0.3501:
        if not violations(b12, b24):
            feas.append((round(b12, 3), round(b24, 3)))
        b24 += 0.005
    b12 += 0.005
b12s = sorted({f[0] for f in feas})
b24s = sorted({f[1] for f in feas})
print(f"feasible grid: B12 in [{min(b12s)}, {max(b12s)}], "
      f"B24 in [{min(b24s):.3f}, {max(b24s):.3f}]")

# Death rule: zeroing the dead slot + trailing-zero truncation, allowing
# concurrent AA escalation (1->2, 2->4) on other planes.
fresh = exact = esc = top = 0
other = []
for pid, evs in by_squadron.items():
    packs = [e for e in evs if e["m"] == "packed"]
    for dth in (e for e in evs if e["m"] == "death"):
        before = next((p for p in reversed(packs) if p["t"] < dth["t"] - 1e-4), None)
        after = next((p for p in packs if dth["t"] - 1e-4 <= p["t"] <= dth["t"] + 2.5), None)
        if not before or not after or before["packed"] == after["packed"]:
            continue
        if dth["t"] - before["t"] > 3.0:
            continue
        fresh += 1
        db, da = digits(before["packed"]), digits(after["packed"])
        if all(i == len(db) - 1 for i in dth["dead"]):
            top += 1
        exp = db[:]
        ok = True
        for i in dth["dead"]:
            if i < len(exp):
                exp[i] = 0
            else:
                ok = False
        while exp and exp[-1] == 0:
            exp.pop()
        if ok and exp == da:
            exact += 1
        elif ok and len(exp) == len(da) and all(
            v == w or (v == 1 and w == 2) or (v == 2 and w == 4)
            for v, w in zip(exp, da)
        ):
            esc += 1
        else:
            other.append((pid, dth["t"], dth["dead"], db, da))
print(f"death transitions: fresh={fresh} exact={exact} +escalation={esc} "
      f"dead-was-top={top} other={len(other)}")
for pid, t, dead, db, da in other[:10]:
    print(f"  other: sq={pid} t={t:.2f} dead={dead} before={db} after={da}")

# Detailed per-squadron tables for the evidence squadrons.
for pid in (8590780230, 1108102407996, 2207614035772, 214749210410, 42950518588):
    evs = by_squadron.get(pid)
    if not evs:
        continue
    add = next((e for e in evs if e["m"] == "add"), None)
    print()
    print(f"=== evidence planeId={pid} "
          f"total={add and add.get('totalNumPlanes')} num={add and add.get('numPlanes')} "
          f"paramsId={add and add.get('paramsId')}")
    marks = {}
    for e in evs:
        key = f"{e['t']:.2f}"
        if e["m"] == "death":
            for i in e["dead"]:
                marks[key] = marks.get(key, "") + f" DEATH[{i}]r{e.get('reason')}"
        elif e["m"] == "deact":
            marks[key] = marks.get(key, "") + f" DEACT{e.get('v')}"
        elif e["m"] in ("consUsed", "consStop"):
            marks[key] = marks.get(key, "") + f" {e['m']}{e.get('ctype')}"
    hps = [e for e in evs if e["m"] == "hp"]
    for e in evs:
        if e["m"] != "packed":
            continue
        best = min(hps, key=lambda h: abs(h["t"] - e["t"]), default=None)
        hp = f"{best['hp']:.4f}" if best is not None else "  -   "
        print(f"  t={e['t']:8.2f} hp={hp} digits={digits(e['packed'])} "
              f"0x{e['packed']:x}{marks.get(f'{e['t']:.2f}', '')}")
