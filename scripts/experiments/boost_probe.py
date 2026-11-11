
#!/usr/bin/env python
"""E27e boost-signal probe: aggregate changeThrottleMode / squadronNotify /
squadronOutOfFuel / dropJato across every CV replay in the Steam replays
folder, and cross-reference throttle windows against the healForsage
consumable brackets. Standalone (pycryptodome), mirrors packets.rs framing."""
import struct, sys, zlib, glob, os, json
from collections import Counter, defaultdict
from Cryptodome.Cipher import Blowfish

KEY = bytes([0x29,0xB7,0xC9,0x09,0x38,0x3F,0x84,0x88,0xFA,0x98,0xEC,0x4E,0x13,0x19,0x79,0xFB])
IDS = {57:"throttle",56:"notify",49:"outOfFuel",50:"dropJato",60:"consUsed",64:"consStop",63:"consInterrupt",61:"consPaused",74:"consSelected",75:"consEnabled"}
# Corpus dir is machine-local; pass an alternative as argv[1].
REPLAY_DIR = sys.argv[1] if len(sys.argv) > 1 else r"D:\SteamLibrary\steamapps\common\World of Warships\replays\14.5.0.0"
CV_PAT = ("PJSA","PJSB","PASA")  # Shokaku/Hotaka/Yorktown hull prefixes

def decrypt_stream(dirty):
    cipher = Blowfish.new(KEY, Blowfish.MODE_ECB)
    out = bytearray(); prev = None
    blocks = [dirty[i:i+8] for i in range(0, len(dirty)-7, 8)]
    for chunk in blocks[1:]:
        dec = cipher.decrypt(chunk)
        v = struct.unpack("<q", dec)[0]
        if prev is not None: v ^= prev
        prev = v
        out += struct.pack("<q", v)
    return bytes(out)

def walk(path):
    with open(path, "rb") as f: data = f.read()
    nblocks = struct.unpack("<I", data[4:8])[0]
    cur = 8
    for _ in range(nblocks): 
        bl = struct.unpack("<I", data[cur:cur+4])[0]; cur += 4 + bl
    inflated = zlib.decompress(decrypt_stream(data[cur:]))
    kinds = {}; avatar = None; calls = []
    p = 0
    while p + 12 <= len(inflated):
        size = struct.unpack("<I", inflated[p:p+4])[0]
        ptype = struct.unpack("<I", inflated[p+4:p+8])[0]
        time = struct.unpack("<f", inflated[p+8:p+12])[0]
        end = p + 12 + size
        if size > 200_000 or end > len(inflated): break
        payload = inflated[p+12:end]; p = end
        if ptype == 5 and len(payload) >= 6:
            eid = struct.unpack("<i", payload[0:4])[0]
            kinds[eid] = struct.unpack("<h", payload[4:6])[0]
        elif ptype == 1 and len(payload) >= 4:
            avatar = struct.unpack("<i", payload[0:4])[0]; kinds[avatar] = 1
        elif ptype == 8 and len(payload) >= 12:
            eid = struct.unpack("<i", payload[0:4])[0]
            mid = struct.unpack("<i", payload[4:8])[0]
            alen = struct.unpack("<I", payload[8:12])[0]
            calls.append((time, eid, mid, payload[12:12+alen]))
    return avatar, kinds, calls

files = sorted(glob.glob(os.path.join(REPLAY_DIR, "*.wowsreplay")))
cv = [f for f in files if any(p in os.path.basename(f) for p in CV_PAT)]
print(f"replays total {len(files)}, CV {len(cv)}")
agg = defaultdict(lambda: {"n":0,"lens":Counter(),"modes":Counter(),"vals":Counter()})
throttle_events = []   # (replay, planeId, t, mode)
forsage = []           # (replay, planeId, used_t, stop_t or None)
per_replay = []
for path in cv:
    name = os.path.basename(path)[:33]
    try:
        avatar, kinds, calls = walk(path)
    except Exception as e:
        print("SKIP", name, e); continue
    rep = {"replay": name, "throttle": 0, "boost_on": 0, "modes": Counter(), "notify": Counter(), "lens": Counter()}
    for time, eid, mid, a in calls:
        if kinds.get(eid) != 1 or mid not in IDS: continue
        key = IDS[mid]
        agg[key]["n"] += 1
        agg[key]["lens"][len(a)] += 1
        rep["lens"][(key, len(a))] = rep["lens"].get((key, len(a)), 0) + 1
        if mid == 57 and len(a) >= 9:
            pid = struct.unpack("<Q", a[0:8])[0]
            mode = struct.unpack("<b", a[8:9])[0]
            agg[key]["modes"][mode] += 1
            rep["modes"][mode] += 1
            rep["throttle"] += 1
            throttle_events.append((name, pid, time, mode))
            if mode == 1: rep["boost_on"] += 1
        elif mid == 56:
            agg[key]["vals"][a.hex()[:16]] += 1
            rep["notify"][a.hex()[:16]] += 1
        elif mid in (49, 50):
            agg[key]["vals"][a.hex()[:20]] += 1
        elif mid in (60, 64, 63):
            if len(a) >= 9:
                pid = struct.unpack("<Q", a[0:8])[0]
                ctype = a[8]
                agg[key]["vals"][ctype] += 1
                if mid == 60 and ctype == 20:
                    forsage.append((name, pid, time, None))
                elif mid == 64 and ctype == 20:
                    # close the latest open window for this plane
                    for i in range(len(forsage)-1, -1, -1):
                        if forsage[i][0] == name and forsage[i][1] == pid and forsage[i][3] is None:
                            forsage[i] = (name, pid, forsage[i][2], time); break
    per_replay.append(rep)

print("\n== per-method aggregates ==")
for key, d in sorted(agg.items()):
    print(f"{key:12s} n={d['n']:6d} lens={dict(d['lens'])} modes={dict(d['modes'])} vals={dict(list(d['vals'].items())[:8])}")

# throttle window durations: pair consecutive mode1 -> next mode0 for same plane
wins = defaultdict(list)
for name, pid, t, m in throttle_events:
    wins[(name, pid)].append((t, m))
durs = []; overlaps = 0; total_on = 0
forsage_by = defaultdict(list)
for name, pid, u, s in forsage:
    forsage_by[(name, pid)].append((u, s))
for (name, pid), evs in wins.items():
    evs.sort()
    for i, (t, m) in enumerate(evs):
        if m == 1:
            total_on += 1
            end = None
            for t2, m2 in evs[i+1:]:
                if m2 == 0: end = t2; break
            if end is not None and end > t:
                durs.append(end - t)
                # overlap with a healForsage window covering t?
                for (u, s) in forsage_by.get((name, pid), []):
                    if u <= t + 0.5 and (s is None or t < s):
                        overlaps += 1; break
print(f"\n== throttle boost windows == total mode1 {total_on}, closed {len(durs)}")
if durs:
    durs.sort()
    import statistics
    print(f"duration s: min {durs[0]:.1f} p25 {durs[len(durs)//4]:.1f} med {durs[len(durs)//2]:.1f} p75 {durs[3*len(durs)//4]:.1f} max {durs[-1]:.1f} mean {statistics.mean(durs):.1f}")
    print(f"durations within 5±0.6s: {sum(1 for d in durs if abs(d-5)<=0.6)}/{len(durs)}")
print(f"mode1 windows overlapping a healForsage window (±0.5s): {overlaps}/{len(durs)} closed ({total_on} open events)")
print(f"healForsage windows: {len(forsage)} (unclosed {sum(1 for _,_,_,s in forsage if s is None)})")
print("\n== per-replay modes ==")
for rep in per_replay:
    print(f"{rep['replay']} throttle {rep['throttle']} modes {dict(rep['modes'])} notify {dict(rep['notify'])}")
