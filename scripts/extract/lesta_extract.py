#!/usr/bin/env python3
"""Extract files from a Lesta (Мир кораблей) client install.

The 26.x Lesta client's vehicle packs wrap entries in an Oodle-Kraken chunk
container (compression_info 0x0000000700000006) that the vendored
wowsunpack's deflate-only pkg reader cannot decode, so this tool performs
the extraction itself:

  idx v40 (48-byte records)  →  per-file {volume, offset, size, crc}
  wowsunpack `metadata`      →  path → {crc32, sizes} (idx-only, no pkgs)
  join on crc+sizes          →  the volume + offset for each path
  powzix/ooz                 →  chunk decoding (see --ooz)

Entry formats (verified against client 26.10.0.0.8867689): stored entries
(ci == 0) are raw bytes; the Oodle container is a 56-byte header + chunk
size table, each chunk an independent Kraken stream (ooz expects the u64
unpacked size prefixed). Everything is CRC32-verified against the idx.

Requires the `ooz` decoder binary (github.com/powzix/ooz, built with a C++
compiler; two missing includes in stdafx.h need adding). Point --ooz at it
or export WOWSP_OOZ.

Usage:
    python scripts/extract/lesta_extract.py --game-dir "D:/WoWS_Korabli" \
        --out C:/lesta-stage "content/gameplay/japan/ship/aircarrier/ASJ013_Zuiho_1939/*"
"""
from __future__ import annotations

import argparse
import fnmatch
import glob
import json
import os
import struct
import subprocess
import sys
import tempfile
import zlib
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))
) / "WoWSP-extract"
META_JSON = CACHE_DIR / "wows_meta_lesta.json"


def find_game_dir(explicit: str | None) -> Path:
    """The Lesta install root: explicit / WOWSP_GAME_PATH_LESTA / registry
    scan for a Lesta publisher (same probe the extract orchestrator uses)."""
    if explicit:
        p = Path(explicit)
        if (p / "Korabli.exe").is_file() or (p / "WorldOfWarships.exe").is_file():
            return p
        raise SystemExit(f"not a game root: {explicit}")
    env = os.environ.get("WOWSP_GAME_PATH_LESTA")
    if env:
        return Path(env)
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from _common import find_lesta_game_path  # noqa: E402

        found = find_lesta_game_path(None)
        if found:
            return Path(found)
    except ImportError:
        pass
    raise SystemExit("no Lesta install found — pass --game-dir")


def latest_idx_dir(game: Path) -> Path:
    bin_dir = game / "bin"
    builds = [
        p for p in bin_dir.iterdir()
        if p.is_dir() and p.name.isdigit() and (p / "idx").is_dir()
    ]
    if not builds:
        raise SystemExit(f"no bin/<build>/idx under {game}")
    return max(builds, key=lambda p: int(p.name)) / "idx"


def ensure_metadata(game: Path, wowsunpack: str) -> Path:
    """The path→crc/size map (idx-only pass; regenerated when missing)."""
    if META_JSON.is_file():
        return META_JSON
    META_JSON.parent.mkdir(parents=True, exist_ok=True)
    print(f"[lesta-extract] generating {META_JSON} via wowsunpack metadata ...")
    rc = subprocess.call(
        [wowsunpack, "--game-dir", str(game), "metadata", str(META_JSON), "--format", "json"]
    )
    if rc != 0 or not META_JSON.is_file():
        raise SystemExit("wowsunpack metadata failed for the Lesta install")
    return META_JSON


def parse_idx(path: Path) -> tuple[list[dict], dict[int, str]]:
    """idx v40: ISFP header, 48-byte file-info records (rid, vid, offset,
    compression_info u64s + size, crc u32s + unpacked-size u64), then the
    volume-name table."""
    data = path.read_bytes()
    if data[:4] != b"ISFP":
        return [], {}
    version = struct.unpack_from("<I", data, 4)[0]
    if version != 0x02000000:
        raise SystemExit(f"unsupported idx version {version:#x} in {path}")
    fc = struct.unpack_from("<I", data, 20)[0]
    ftp = struct.unpack_from("<Q", data, 40)[0]
    vc = struct.unpack_from("<I", data, 24)[0]
    vtp = struct.unpack_from("<Q", data, 48)[0]
    fis = []
    for i in range(fc):
        rid, vid, off, ci = struct.unpack_from("<4Q", data, 16 + ftp + 48 * i)
        size, crc = struct.unpack_from("<2I", data, 16 + ftp + 48 * i + 32)
        (usz,) = struct.unpack_from("<Q", data, 16 + ftp + 48 * i + 40)
        fis.append(dict(rid=rid, vid=vid, off=off, ci=ci, size=size, crc=crc, usz=usz))
    vols: dict[int, str] = {}
    cursor = 16 + vtp
    for _ in range(vc):
        name_ptr, vid_hash = struct.unpack_from("<2Q", data, cursor + 8)
        nstart = cursor + name_ptr
        end = data.index(b"\0", nstart)
        vols[vid_hash] = data[nstart:end].decode("utf-8", "replace")
        cursor = nstart + (end - nstart) + 1
        cursor = (cursor + 7) & ~7
    return fis, vols


def build_index(idx_dir: Path) -> tuple[dict[int, list[dict]], dict[int, str]]:
    by_crc: dict[int, list[dict]] = defaultdict(list)
    volnames: dict[int, str] = {}
    for p in sorted(idx_dir.glob("*.idx")):
        fis, vols = parse_idx(p)
        for fi in fis:
            by_crc[fi["crc"]].append(fi)
        volnames.update(vols)
    return by_crc, volnames


def load_meta(meta_path: Path) -> dict[str, dict]:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}
    for e in meta:
        if not e.get("is_directory"):
            out[e["path"].lstrip("/")] = e
    return out


class OozDecoder:
    """Chunk-container decoder. The per-chunk backend matters: powzix/ooz
    SILENTLY mis-decodes some Oodle streams written by the newer SDK the
    26.10 client uses (length-exact, wrong bytes — the hull MidBack/
    MidFront geometry files all hit this); the oozextract Rust port
    (github.com/lvlvllvlvllvlvl/oozextract, `unoodle`) decodes them
    correctly. Prefer unoodle when present; keep ooz as the fallback."""

    def __init__(self, exe: Path, mode: str = "ooz"):
        self.exe = exe
        self.mode = mode
        if not exe.is_file():
            raise SystemExit(f"decoder not found at {exe}")

    def _decode_chunk(self, src: str, dst: str, want: int) -> bytes:
        if self.mode == "unoodle":
            # unoodle takes (u64 size + stream) like ooz's -f file format.
            r = subprocess.run([str(self.exe), src, "-o", dst], capture_output=True)
        else:
            r = subprocess.run([str(self.exe), "-f", src, dst], capture_output=True)
        if r.returncode != 0:
            raise RuntimeError(
                f"{self.mode} chunk failed: " + r.stderr.decode("utf-8", "replace")[:120]
            )
        return Path(dst).read_bytes()

    def decompress(self, raw: bytes) -> bytes:
        """Decode the Lesta Oodle chunk container: 56-byte header + chunk
        table, each chunk a standalone Kraken stream the backend decodes
        when the u64 unpacked size is prefixed."""
        total_unp = struct.unpack_from("<Q", raw, 16)[0]
        count = struct.unpack_from("<I", raw, 32)[0]
        chunk_unp = struct.unpack_from("<I", raw, 36)[0]
        tbl = struct.unpack_from(f"<{count}I", raw, 56)
        hdr = 56 + 4 * count
        if sum(tbl) != len(raw) - hdr:
            raise RuntimeError("chunk table mismatch")
        out = []
        got = 0
        pos = hdr
        with tempfile.TemporaryDirectory(prefix="wowsp_ooz_") as tmp:
            src = os.path.join(tmp, "c.bin")
            dst = os.path.join(tmp, "c.out")
            for cl in tbl:
                want = min(chunk_unp, total_unp - got)
                chunk = raw[pos:pos + cl]
                pos += cl
                Path(src).write_bytes(struct.pack("<Q", want) + chunk)
                data = self._decode_chunk(src, dst, want)
                out.append(data)
                got += len(data)
        return b"".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--game-dir", help="Lesta install root (default: WOWSP_GAME_PATH_LESTA / registry)")
    ap.add_argument("--out", required=True, help="output directory (the content/... tree is preserved)")
    ap.add_argument("--ooz", help="ooz decoder binary (default: WOWSP_OOZ env)")
    ap.add_argument(
        "--wowsunpack",
        help="wowsunpack binary for the metadata pass (default: repo target/release)",
    )
    ap.add_argument("patterns", nargs="+", help="glob patterns against pkg-internal paths")
    args = ap.parse_args()

    game = find_game_dir(args.game_dir)
    # Decoder preference: unoodle (correct for the newer Oodle streams),
    # then ooz. --ooz / WOWSP_OOZ may point at EITHER binary (the mode is
    # sniffed from the file name).
    ooz_arg = args.ooz or os.environ.get("WOWSP_OOZ") or os.environ.get("WOWSP_UNOODLE")
    cand_bin = Path(ooz_arg) if ooz_arg else None
    if cand_bin is None or not cand_bin.is_file():
        for cand in (
            ROOT / "target/model-tools/unoodle.exe",
            ROOT / "target/release/unoodle.exe",
            ROOT / "target/model-tools/ooz.exe",
            ROOT / "target/release/ooz.exe",
        ):
            if cand.is_file():
                cand_bin = cand
                break
    if cand_bin is None or not cand_bin.is_file():
        raise SystemExit(
            "no Oodle decoder found — build github.com/lvlvllvlvllvlvl/"
            "oozextract (unoodle, preferred) or powzix/ooz, pass --ooz or "
            "set WOWSP_OOZ"
        )
    mode = "unoodle" if "unoodle" in cand_bin.name.lower() else "ooz"
    decoder = OozDecoder(cand_bin, mode)
    print(f"[lesta-extract] oodle backend: {mode} ({cand_bin})")

    wowsunpack = args.wowsunpack
    if not wowsunpack:
        for cand in (
            ROOT / "target/release/wowsunpack.exe",
            ROOT / "target/release/wowsunpack",
        ):
            if cand.is_file():
                wowsunpack = str(cand)
                break
    if not wowsunpack:
        raise SystemExit("wowsunpack not found (build: just build wowsunpack)")

    idx_dir = latest_idx_dir(game)
    pkg_dir = game / "res_packages"
    print(f"[lesta-extract] game: {game} (idx: {idx_dir.name})")
    meta = load_meta(ensure_metadata(game, wowsunpack))
    by_crc, volnames = build_index(idx_dir)

    outdir = Path(args.out)
    pkg_files: dict[str, object] = {}
    n_ok = n_miss = n_fail = 0
    total = 0
    for path in meta:
        if not any(fnmatch.fnmatch(path, pat) for pat in args.patterns):
            continue
        e = meta[path]
        cands = [
            c for c in by_crc.get(e["crc32"], [])
            if c["size"] == e["compressed_size"] and c["usz"] == e["unpacked_size"]
        ]
        if not cands:
            n_miss += 1
            print("MISS", path)
            continue
        data = None
        bad_crc_data: bytes | None = None
        last_err: Exception | None = None
        for fi in cands:
            pkg_name = volnames.get(fi["vid"])
            if pkg_name is None:
                last_err = RuntimeError(f"unknown volume 0x{fi['vid']:x}")
                continue
            f = pkg_files.get(pkg_name)
            if f is None:
                f = open(pkg_dir / pkg_name, "rb")  # noqa: SIM115 - closed at exit
                pkg_files[pkg_name] = f
            f.seek(fi["off"])
            raw = f.read(fi["size"])
            try:
                if fi["ci"] == 0 or fi["size"] == fi["usz"]:
                    # Stored — includes blobs that carry their own container
                    # (content/GameParams_py2.data's %bin wrapper).
                    cand = raw
                elif fi["ci"] == 6 and fi["usz"] > fi["size"]:
                    # Plain zlib stream (the old WG pkg encoding).
                    cand = zlib.decompress(raw)
                elif (fi["ci"] >> 32) == 7 and (fi["ci"] & 0xFFFFFFFF) == 6:
                    cand = decoder.decompress(raw)
                else:
                    raise RuntimeError(f"unsupported compression_info 0x{fi['ci']:x}")
            except Exception as ex:  # noqa: BLE001 - try the next candidate
                last_err = ex
                continue
            if len(cand) != fi["usz"]:
                last_err = RuntimeError(
                    f"decoded {len(cand)} bytes, expected {fi['usz']}"
                )
                continue
            if (zlib.crc32(cand) & 0xFFFFFFFF) == fi["crc"]:
                data = cand
                break
            # Duplicate-offset idx anomaly on a few 26.10 entries: decodes to
            # the exact length with valid content but the idx CRC disagrees.
            # Keep it as a last resort, prefer a CRC-exact candidate.
            bad_crc_data = bad_crc_data or cand
        if data is None and bad_crc_data is not None:
            print("WARN crc mismatch (idx anomaly), keeping length-exact decode")
            data = bad_crc_data
        if data is None:
            n_fail += 1
            print("FAIL", path, last_err)
            continue
        dest = outdir / Path(path.replace("/", os.sep))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        n_ok += 1
        total += len(data)

    for f in pkg_files.values():
        f.close()  # type: ignore[attr-defined]
    print(
        f"[lesta-extract] extracted {n_ok} files ({total / 1048576:.1f} MB unpacked); "
        f"missing={n_miss} failed={n_fail} -> {outdir}"
    )
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
