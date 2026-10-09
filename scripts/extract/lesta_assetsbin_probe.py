#!/usr/bin/env python3
"""Probe the Lesta (Мир кораблей) assets.bin — phase-1 format tooling.

Companion to docs/lesta-assets-bin-format.md. The 26.x file's outer
container (header / strings map / r2p map / path storage / database
directory) is fully mapped and parses with the WG layouts; the prototype
payload inside the blobs is a new recursive serialization this tool helps
crack. Outputs:

  - header + section table sanity report
  - path-entry census: live records vs the leading tombstone block
  - r2p value distribution by file extension (blob identification)
  - database directory listing
  - full-path reconstruction + coverage check for the Lesta-only tree
    ships' model dirs (reads ship_models.json + ships_lesta.json)
  - affine-matrix census of a chosen blob (the node-transform store)

Usage:
    python scripts/extract/lesta_assetsbin_probe.py <path/to/assets.bin> \
        [--repo-root <repo>] [--matrix-census]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from collections import defaultdict
from pathlib import Path

BWDB_MAGIC = 0x42574442
TOMBSTONE_RUN_MAX = 4096  # a contiguous leading invalid run at least this long


class Bin:
    def __init__(self, path: Path):
        self.data = path.read_bytes()
        self.n = len(self.data)
        self.u32 = lambda o: struct.unpack_from("<I", self.data, o)[0]
        self.u64 = lambda o: struct.unpack_from("<Q", self.data, o)[0]
        self.i64 = lambda o: struct.unpack_from("<q", self.data, o)[0]

    # ── header + body sections (WG field order, per-section relptr bases) ─
    def sections(self):
        d = self.data
        magic, version, checksum = struct.unpack_from("<III", d, 0)
        arch, endian = struct.unpack_from("<HH", d, 12)
        s = {
            "magic_ok": magic == BWDB_MAGIC,
            "version": f"{version:#010x}",
            "checksum": f"{checksum:#010x}",
            "arch": arch,
            "endian": endian,
        }
        B = 0x10
        s["offsets_map_capacity"] = self.u32(B)
        s["r2p_capacity"] = self.u32(B + 0x28)
        s["paths_count"] = self.u32(B + 0x40)
        s["paths_data"] = B + 0x40 + self.i64(B + 0x48)
        o_db = B + 0x28 + 0x18 + 0x10
        s["databases_count"] = self.u32(o_db)
        s["databases_entries"] = B + self.i64(o_db + 8)
        self.strings_buckets = B + self.i64(B + 8)
        self.strings_values = B + self.i64(B + 16)
        self.string_data = B + self.i64(B + 32)
        self.string_data_size = self.u32(B + 24)
        self.r2p_buckets = B + 0x28 + self.i64(B + 0x30)
        self.r2p_values = B + 0x28 + self.i64(B + 0x38)
        self.r2p_cap = s["r2p_capacity"]
        self.paths_data = s["paths_data"]
        self.paths_count = s["paths_count"]
        self.dbs = []
        for i in range(s["databases_count"]):
            e = s["databases_entries"] + i * 0x18
            mag, csum, size, pad = struct.unpack_from("<4I", self.data, e)
            self.dbs.append((e + self.i64(e + 16), size, mag))
        return s

    # ── strings offsets map (open addressing, 8B buckets, u32 values) ────
    def get_string_by_id(self, nid: int) -> str | None:
        cap = self.u32(0x10)
        if cap == 0:
            return None
        slot = nid % cap
        for probe in range(cap):
            s = (slot + probe) % cap
            key = self.u32(self.strings_buckets + s * 8)
            sentinel = self.u32(self.strings_buckets + s * 8 + 4)
            if key == 0 and sentinel == 0:
                return None
            if key == nid:
                off = self.u32(self.strings_values + s * 4)
                start = self.string_data + off
                end = self.data.find(b"\0", start)
                if end < 0:
                    return None
                try:
                    return self.data[start:end].decode("utf-8")
                except UnicodeDecodeError:
                    return None
        return None

    # ── r2p map (open addressing, 16B buckets, u32 values) ───────────────
    def lookup_r2p(self, sid: int) -> int | None:
        if self.r2p_cap == 0:
            return None
        slot = sid % self.r2p_cap
        for probe in range(self.r2p_cap):
            s = (slot + probe) % self.r2p_cap
            key = self.u64(self.r2p_buckets + s * 16)
            sentinel = self.u64(self.r2p_buckets + s * 16 + 8)
            if sentinel == 0 and key == 0:
                return None
            if key == sid:
                return self.u32(self.r2p_values + s * 4)
        return None

    # ── path entries (32B records; leading tombstones get name=None) ─────
    def path_entries(self):
        out = []
        for i in range(self.paths_count):
            e = self.paths_data + i * 32
            sid, pid = struct.unpack_from("<QQ", self.data, e)
            sz = self.u32(e + 16)
            rel = self.i64(e + 24)
            na = e + 16 + rel
            name = None
            if 1 <= sz <= 1_000_000 and 0 <= na and na + sz <= self.n:
                raw = self.data[na:na + sz]
                if raw.endswith(b"\0"):
                    raw = raw[:-1]
                try:
                    name = raw.decode("utf-8")
                except UnicodeDecodeError:
                    pass
            out.append((sid, pid, name))
        return out

    @staticmethod
    def reconstruct(entries, self_idx, i: int) -> str:
        parts, cur, hops = [], i, 0
        while cur is not None and hops < 100:
            sid, pid, nm = entries[cur]
            if nm:
                parts.append(nm)
            if pid == 0:
                break
            cur = self_idx.get(pid)
            hops += 1
        return "/".join(reversed(parts))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("assets_bin", type=Path)
    ap.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    ap.add_argument("--matrix-census", action="store_true",
                    help="census affine-matrix windows per database blob")
    args = ap.parse_args()

    b = Bin(args.assets_bin)
    s = b.sections()
    print("== header/sections ==")
    for k, v in s.items():
        print(f"  {k}: {v}")

    entries = b.path_entries()
    named = sum(1 for _, _, nm in entries if nm)
    first_live = next(i for i, (_, _, nm) in enumerate(entries) if nm)
    print(f"\n== path entries ==\n  total={len(entries):,} named={named:,} "
          f"tombstone prefix={first_live:,}")
    self_idx = {}
    for i, (sid, pid, nm) in enumerate(entries):
        self_idx.setdefault(sid, i)

    dist = defaultdict(lambda: defaultdict(int))
    for sid, pid, nm in entries:
        if not nm:
            continue
        ext = nm.rsplit(".", 1)[-1] if "." in nm else "(none)"
        v = b.lookup_r2p(sid)
        if v is None or v & 0xFF and (v & 0xFF) % 4:
            continue
        dist[ext][(v & 0xFF) // 4] += 1
    print("\n== r2p by extension (blob: count) ==")
    for ext in sorted(dist, key=lambda e: -sum(dist[e].values()))[:8]:
        print(f"  {ext:8s} {dict(sorted(dist[ext].items()))}")

    print("\n== databases ==")
    for i, (abs_, size, mag) in enumerate(b.dbs):
        rec = b.u64(abs_) if size >= 8 else 0
        print(f"  blob[{i}] data@{abs_:,} size={size:,} header.count={rec:,} magic={mag:#010x}")

    models = args.repo_root / "packages/webui/src/data/ship_models.json"
    overlay = args.repo_root / "packages/webui/src/data/ships_lesta.json"
    if models.is_file() and overlay.is_file():
        lesta_ids = {int(k) for k in json.loads(overlay.read_text(encoding="utf-8"))["ships"]}
        models = json.loads(models.read_text(encoding="utf-8"))
        dirs = set()
        for sid, m in models.items():
            if int(sid) not in lesta_ids:
                continue
            hm = m.get("hullModel")
            if hm:
                seg = [p for p in hm.split("/") if p]
                if len(seg) >= 2:
                    dirs.add(seg[-2])
        full = {d: 0 for d in dirs}
        for i, (sid, pid, nm) in enumerate(entries):
            if not nm or not nm.endswith(".visual"):
                continue
            path = Bin.reconstruct(entries, self_idx, i)
            for d in full:
                if f"/{d}/" in path:
                    full[d] += 1
        ok = sum(1 for c in full.values() if c > 0)
        print(f"\n== Lesta-only model dirs ==\n  full-path visual coverage: {ok}/{len(full)}")
        missing = [d for d, c in full.items() if c == 0]
        if missing:
            print(f"  missing: {missing}")

    if args.matrix_census:
        import numpy as np
        print("\n== affine-matrix census (f[15]≈1, f[3/7/11]≈0, |f|<5, nonzero tr) ==")
        for i, (abs_, size, _) in enumerate(b.dbs):
            if size < 0x10000:
                continue
            raw = b.data[abs_:abs_ + size]
            raw = raw[: len(raw) - (len(raw) % 4)]  # frombuffer needs a whole element count
            f = np.frombuffer(raw, dtype="<f4")
            m = len(f) - 16
            if m <= 0:
                continue
            st = np.arange(m, dtype=np.int64)
            ok = np.abs(f[st + 15] - 1.0) < 1e-3
            for k in (3, 7, 11):
                ok &= np.abs(f[st + k]) < 1e-3
            for k in (0, 5, 10):
                ok &= np.abs(f[st + k]) < 5.0
            tr = np.abs(f[st + 12]) + np.abs(f[st + 13]) + np.abs(f[st + 14])
            ok &= np.nan_to_num(tr, nan=1e9) > 1e-3
            print(f"  blob[{i}]: {int(ok.sum()):,} matrix-like windows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
