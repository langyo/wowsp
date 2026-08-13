#!/usr/bin/env python3
"""Bake a real .wowsreplay into a compact bundle for the marketing site.

Input : the Rust decoder's dump (WOWSP_TEST_REPLAY + dump_replay_json test).
Output: packages/website/src/res/replay/<slug>/battle.json  (+ prints the GLB
        copy list for the optimization step).

The site renders the battle LIVE with three.js — this script is the offline
half: roster resolution (entity -> player join, duplicate shipIds split by
spawn side), 1 Hz uniformly-sampled tracks, torpedoes & explosions.

Usage:
  python scripts/bake_site_replay.py <dump.json> <slug>
"""
from __future__ import annotations

import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHIP_MODELS = os.path.join(ROOT, "packages/webui/src/data/ship_models.json")
SHIP_NAMES = os.path.join(ROOT, "packages/webui/src/data/ship_names.json")
SHIP_GLBS = os.path.join(ROOT, "packages/webui/src/res/models/ships")
MAP_GLBS = os.path.join(ROOT, "packages/webui/src/res/models/maps")


def lerp_yaw(a: float, b: float, t: float) -> float:
    d = (b - a + math.pi) % (2 * math.pi) - math.pi
    return a + d * t


def sample_track(samples: list[dict], n: int) -> tuple[list, list, list]:
    """Uniform 1 Hz resample with linear interp (yaw wrapped)."""
    xs: list[float] = []
    zs: list[float] = []
    yaws: list[float] = []
    j = 0
    for i in range(n):
        t = float(i)
        while j + 1 < len(samples) and samples[j + 1]["time"] <= t:
            j += 1
        s0 = samples[j]
        s1 = samples[min(j + 1, len(samples) - 1)]
        span = s1["time"] - s0["time"]
        f = 0.0 if span <= 1e-6 else min(1.0, max(0.0, (t - s0["time"]) / span))
        xs.append(round(s0["x"] + (s1["x"] - s0["x"]) * f, 1))
        zs.append(round(s0["z"] + (s1["z"] - s0["z"]) * f, 1))
        yaws.append(round(lerp_yaw(s0["yaw"], s1["yaw"], f), 3))
    return xs, zs, yaws


def sample_hp(hp_samples: list[dict] | None, n: int) -> list[int]:
    """1 Hz HP trace from the raw hpSamples stream (hold-last per second).
    Returns [] when the stream is missing so the site hides the bar."""
    if not hp_samples:
        return []
    hp: list[int] = []
    j = 0
    for i in range(n):
        t = float(i)
        while j + 1 < len(hp_samples) and hp_samples[j + 1]["time"] <= t:
            j += 1
        hp.append(int(hp_samples[j]["value"]))
    return hp


def main() -> None:
    dump_path, slug = sys.argv[1], sys.argv[2]
    dump = json.load(open(dump_path, encoding="utf-8"))
    ship_models = json.load(open(SHIP_MODELS, encoding="utf-8"))
    ship_names = json.load(open(SHIP_NAMES, encoding="utf-8"))

    map_name = dump["mapName"].replace("spaces/", "")
    vehicles = dump["meta"]["vehicles"]
    trajs = dump["trajectories"]

    ships = [t for t in trajs if (t.get("kind") or {}).get("entityType") == 2]
    avatar = next((t for t in trajs if (t.get("kind") or {}).get("entityType") == 1), None)

    duration = max(s["time"] for t in ships for s in t["samples"])
    n = int(duration) + 1

    # ── team split: two spawn clusters, ally = the one holding the avatar ──
    spawns = [(t["entityId"], t["kind"]["initialX"], t["kind"]["initialZ"]) for t in ships]
    seed_a, seed_b = max(
        ((a, b) for a in spawns for b in spawns),
        key=lambda p: (p[0][1] - p[1][1]) ** 2 + (p[0][2] - p[1][2]) ** 2,
    )
    side: dict[int, str] = {}
    for eid, x, z in spawns:
        da = (x - seed_a[1]) ** 2 + (z - seed_a[2]) ** 2
        db = (x - seed_b[1]) ** 2 + (z - seed_b[2]) ** 2
        side[eid] = "A" if da <= db else "B"
    ally_side = "A"
    if avatar is not None:
        ax, az = avatar["kind"]["initialX"], avatar["kind"]["initialZ"]
        da = (ax - seed_a[1]) ** 2 + (az - seed_a[2]) ** 2
        db = (ax - seed_b[1]) ** 2 + (az - seed_b[2]) ** 2
        ally_side = "A" if da <= db else "B"

    # ── entity -> player join (per shipId, nearest spawn within the side) ──
    by_ship: dict[int, list[dict]] = {}
    for t in ships:
        by_ship.setdefault(t["kind"]["shipId"], []).append(t)

    roster: list[dict] = []
    used: set[int] = set()
    recorder_eid: int | None = None
    recorder_sid = next(v["shipId"] for v in vehicles if v["relation"] == 0)

    # Recorder FIRST — it claims the track nearest the avatar spawn, so later
    # same-ship allies can't steal it (roster order is arbitrary).
    for v in sorted(vehicles, key=lambda x: 0 if x["relation"] == 0 else 1):
        sid = v["shipId"]
        want_side = ally_side if v["relation"] in (0, 1) else ("B" if ally_side == "A" else "A")
        cands = [
            t for t in by_ship.get(sid, [])
            if t["entityId"] not in used and side[t["entityId"]] == want_side
        ]
        if not cands:  # fall back to any unused track with this shipId
            cands = [t for t in by_ship.get(sid, []) if t["entityId"] not in used]
        track = None
        if cands:
            if v["relation"] == 0 and avatar is not None:
                ax, az = avatar["kind"]["initialX"], avatar["kind"]["initialZ"]
                track = min(cands, key=lambda t: (t["kind"]["initialX"] - ax) ** 2 + (t["kind"]["initialZ"] - az) ** 2)
            else:
                # spread duplicates: pick the track farthest from already-taken ones
                track = cands[0]
            used.add(track["entityId"])
        if v["relation"] == 0 and track is not None:
            recorder_eid = track["entityId"]

        entry = ship_models.get(str(sid), {})
        model = entry.get("baseName") or entry.get("index") or ""
        names = ship_names.get(str(sid), {})
        roster.append({
            "e": track["entityId"] if track else -1,
            "name": v["name"],
            "shipZh": (names.get("names") or {}).get("zh-cn") or entry.get("baseName") or "?",
            "shipEn": (names.get("names") or {}).get("en") or entry.get("baseName") or "?",
            "model": model,
            "rel": v["relation"],
        })

    # ── GLB existence → copy list (model names WITHOUT the .glb ext) ──
    files = {f[:-4].lower(): f for f in os.listdir(SHIP_GLBS) if f.endswith(".glb")}
    glbs: list[str] = []
    fallback = "Nagato"
    for r in roster:
        stem = files.get((r["model"] or "").lower())
        r["model"] = (stem[:-4] if stem else fallback)
        if r["model"] not in glbs:
            glbs.append(r["model"])

    # ── tracks @1Hz ──
    tracks: dict[str, dict] = {}
    for t in ships:
        eid = t["entityId"]
        xs, zs, yaws = sample_track(t["samples"], n)
        entry: dict = {"x": xs, "z": zs, "yaw": yaws}
        hp = sample_hp(t.get("hpSamples"), n)
        if hp:
            entry["hp"] = hp
        dt = t.get("deathTime")
        if dt is not None:
            entry["die"] = round(dt, 1)
        tracks[str(eid)] = entry

    # ── torpedoes / explosions (flavor) ──
    by_eid = {t["entityId"]: t for t in ships}

    def pos_at(t: dict, tm: float) -> tuple[float, float]:
        ss = t["samples"]
        k = 0
        while k + 1 < len(ss) and ss[k + 1]["time"] <= tm:
            k += 1
        return ss[k]["x"], ss[k]["z"]

    torps = []
    for tp in dump.get("torpedoes") or []:
        src = by_eid.get(tp["entityId"])
        if not src:
            continue
        x, z = pos_at(src, tp["time"])
        torps.append([round(tp["time"], 1), round(x, 1), round(z, 1),
                      round(tp["dirX"], 3), round(tp["dirZ"], 3)])

    expl = [[round(e["time"], 1), round(e["x"], 1), round(e["z"], 1)]
            for e in (dump.get("explosions") or [])]

    # ── capture zones (entityType 14: controlPointIndex + ownership) ──
    caps = []
    for z in trajs:
        k = z.get("kind") or {}
        if k.get("entityType") != 14:
            continue
        idx = k.get("controlPointIndex", 0)
        initial = k.get("initialTeam", -1)
        samples = z.get("capSamples") or []
        if not samples:
            continue
        # ownership timeline: value 0 neutral · 1 ally · 2 enemy (game caps
        # every ownership change; the site interpolates capture progress).
        timeline = [[round(s["time"], 1), s["value"]] for s in samples]
        caps.append({
            "letter": chr(ord("A") + idx),
            "x": round(k.get("initialX", 0), 1),
            "z": round(k.get("initialZ", 0), 1),
            "initial": initial,
            "timeline": timeline,
        })
    # Conquest ships multiple cap groups; keep the first letter-group per
    # controlPointIndex (dedupe by letter, keep earliest creation).
    seen_letters: set[str] = set()
    caps_dedup = []
    for c in sorted(caps, key=lambda c: (c["letter"], c["timeline"][0][0] if c["timeline"] else 0)):
        if c["letter"] in seen_letters:
            continue
        seen_letters.add(c["letter"])
        caps_dedup.append(c)
    caps = caps_dedup

    out = {
        "map": map_name,
        "duration": round(duration, 1),
        "dt": 1.0,
        "roster": roster,
        "recorder": recorder_eid,
        "tracks": tracks,
        "torps": torps,
        "explosions": expl,
        "caps": caps,
    }

    out_dir = os.path.join(ROOT, "packages/website/src/res/replay", slug)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "battle.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    size_kb = os.path.getsize(out_path) / 1024
    print(f"battle.json: {size_kb:.0f} KB, {n}s, {len(roster)} ships, {len(torps)} torps, {len(expl)} explosions")
    print("MAP_GLB", os.path.join(MAP_GLBS, map_name + ".glb"))
    for g in glbs:
        print("SHIP_GLB", os.path.join(SHIP_GLBS, g))


if __name__ == "__main__":
    main()
