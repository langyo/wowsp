
#!/usr/bin/env python
"""Round 2: full 9-byte notify dump + mode -1 (slow?) window durations,
plus throttle-vs-attack correlation is skipped here (pitch lives on
updateSquadron). Same framing as boost_probe.py."""
import struct, zlib, glob, os, statistics
from collections import Counter, defaultdict
from Cryptodome.Cipher import Blowfish

KEY = bytes([0x29,0xB7,0xC9,0x09,0x38,0x3F,0x84,0x88,0xFA,0x98,0xEC,0x4E,0x13,0x19,0x79,0xFB])
REPLAY_DIR = r"D:\SteamLibrary\steamapps\common\World of Warships\replays\14.5.0.0"
CV_PAT = ("PJSA","PJSB","PASA")

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
    kinds = {}; calls = []
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
            kinds[struct.unpack("<i", payload[0:4])[0]] = 1
        elif ptype == 8 and len(payload) >= 12:
            eid = struct.unpack("<i", payload[0:4])[0]
            mid = struct.unpack("<i", payload[4:8])[0]
            alen = struct.unpack("<I", payload[8:12])[0]
            calls.append((time, eid, mid, payload[12:12+alen]))
    return kinds, calls

files = sorted(glob.glob(os.path.join(REPLAY_DIR, "*.wowsreplay")))
cv = [f for f in files if any(p in os.path.basename(f) for p in CV_PAT)]
notify_vals = Counter(); notify_lens = Counter()
slow_durs = []
per_squad_notify = defaultdict(Counter)
for path in cv:
    name = os.path.basename(path)[:26]
    kinds, calls = walk(path)
    evs = defaultdict(list)
    for time, eid, mid, a in calls:
        if kinds.get(eid) != 1: continue
        if mid == 56:
            notify_lens[len(a)] += 1
            if len(a) >= 9:
                pid = struct.unpack("<Q", a[0:8])[0]
                v = a[8]
                notify_vals[v] += 1
                per_squad_notify[(name, pid)][v] += 1
        elif mid == 57 and len(a) >= 9:
            pid = struct.unpack("<Q", a[0:8])[0]
            mode = struct.unpack("<b", a[8:9])[0]
            evs[pid].append((time, mode))
    for pid, lst in evs.items():
        lst.sort()
        for i, (t, m) in enumerate(lst):
            if m == -1:
                end = None
                for t2, m2 in lst[i+1:]:
                    if m2 != -1: end = t2; break
                if end is not None and end > t: slow_durs.append(end - t)
print("notify arg lens:", dict(notify_lens))
print("notify 9th-byte value distribution:", dict(sorted(notify_vals.items())))
print("per-squadron value sets (sample 6):")
for k, c in list(per_squad_notify.items())[:6]:
    print("  ", k, dict(sorted(c.items())))
print("\nslow (-1) windows:", len(slow_durs))
if slow_durs:
    slow_durs.sort()
    print(f"duration s: min {slow_durs[0]:.1f} med {slow_durs[len(slow_durs)//2]:.1f} max {slow_durs[-1]:.1f} mean {statistics.mean(slow_durs):.1f}")
