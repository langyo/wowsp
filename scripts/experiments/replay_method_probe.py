#!/usr/bin/env python
"""E10 empirical probe: walk a .wowsreplay and dump avatar EntityMethod calls.

Standalone (no Rust build needed — parallel experiments may have the tree in
an unbuildable state). Mirrors packets.rs: blowfish-ECB decrypt with plaintext
XOR chain, zlib inflate, then the `[u32 size][u32 type][f32 time][payload]`
frame walk. Collects EntityMethod (0x08) calls joined to entity types from
EntityCreate (0x05), with the recorder's avatar from CellPlayerCreate (0x01).

Usage:
    python replay_method_probe.py <replay> [--entity-type 1] [--ids 50,51,...]
                                  [--samples N] [--hex N]
"""

import argparse
import struct
import sys
import zlib
from collections import Counter, defaultdict

from Cryptodome.Cipher import Blowfish

KEY = bytes([0x29, 0xB7, 0xC9, 0x09, 0x38, 0x3F, 0x84, 0x88,
             0xFA, 0x98, 0xEC, 0x4E, 0x13, 0x19, 0x79, 0xFB])

PKT_ENTITY_METHOD = 0x08
PKT_ENTITY_CREATE = 0x05
PKT_CELL_PLAYER_CREATE = 0x01


def decrypt_stream(dirty: bytes) -> bytes:
    cipher = Blowfish.new(KEY, Blowfish.MODE_ECB)
    out = bytearray()
    prev = None
    blocks = [dirty[i:i + 8] for i in range(0, len(dirty) - 7, 8)]
    for chunk in blocks[1:]:  # first block is a marker — skip
        dec = cipher.decrypt(chunk)
        v = struct.unpack("<q", dec)[0]
        if prev is not None:
            v ^= prev
        prev = v
        out += struct.pack("<q", v)
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("replay")
    ap.add_argument("--entity-type", type=int, default=1)
    ap.add_argument("--ids", default="")
    ap.add_argument("--samples", type=int, default=4)
    ap.add_argument("--hex", type=int, default=24)
    args = ap.parse_args()

    with open(args.replay, "rb") as f:
        data = f.read()
    nblocks = struct.unpack("<I", data[4:8])[0]
    cur = 8
    for _ in range(nblocks):
        bl = struct.unpack("<I", data[cur:cur + 4])[0]
        cur += 4 + bl
    inflated = zlib.decompress(decrypt_stream(data[cur:]))

    kinds = {}  # entity_id -> entity_type
    avatar_id = None
    calls = []  # (time, entity_id, method_id, args bytes)
    p = 0
    while p + 12 <= len(inflated):
        size = struct.unpack("<I", inflated[p:p + 4])[0]
        ptype = struct.unpack("<I", inflated[p + 4:p + 8])[0]
        time = struct.unpack("<f", inflated[p + 8:p + 12])[0]
        end = p + 12 + size
        if size > 200_000 or end > len(inflated):
            break
        payload = inflated[p + 12:end]
        p = end
        if ptype == PKT_ENTITY_CREATE and len(payload) >= 6:
            eid = struct.unpack("<i", payload[0:4])[0]
            kinds[eid] = struct.unpack("<h", payload[4:6])[0]
        elif ptype == PKT_CELL_PLAYER_CREATE and len(payload) >= 4:
            avatar_id = struct.unpack("<i", payload[0:4])[0]
            kinds[avatar_id] = 1
        elif ptype == PKT_ENTITY_METHOD and len(payload) >= 12:
            eid = struct.unpack("<i", payload[0:4])[0]
            mid = struct.unpack("<i", payload[4:8])[0]
            alen = struct.unpack("<I", payload[8:12])[0]
            argsb = payload[12:12 + alen]
            calls.append((time, eid, mid, argsb))

    target_ids = {int(x) for x in args.ids.split(",") if x.strip()}
    hist = Counter()
    samples = defaultdict(list)
    for time, eid, mid, argsb in calls:
        if kinds.get(eid) != args.entity_type:
            continue
        hist[mid] += 1
        if len(samples[mid]) < args.samples:
            samples[mid].append((time, argsb))

    print(f"avatar_id={avatar_id} method calls on type-{args.entity_type} "
          f"entities: {sum(hist.values())} calls, {len(hist)} distinct ids")
    for mid in sorted(hist):
        mark = " *" if mid in target_ids else ""
        print(f"  mid={mid:4d} n={hist[mid]:6d}{mark}")
    if target_ids:
        shown = target_ids & set(samples) or target_ids
        for mid in sorted(shown):
            print(f"--- mid={mid} samples:")
            for time, argsb in samples.get(mid, []):
                hx = argsb[: args.hex].hex()
                print(f"  t={time:8.1f} len={len(argsb):4d} {hx}")


if __name__ == "__main__":
    main()
