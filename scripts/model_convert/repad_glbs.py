#!/usr/bin/env python3
"""One-shot normalization of the baked GLBs' JSON-chunk padding.

Two historical writer defects shipped in the pack (both fixed at the source —
bake_model.py and wowsunpack's write_armor_glb since #904):

  1. JSON chunks padded with NUL bytes — rejected by strict JSON parsers
     (three's GLTFLoader: "Unexpected non-whitespace character after JSON").
     The loader still carries the runtime `fixGlbPadding` workaround for
     cached packs, and `repair_glbs.py` trimmed some files in place earlier.
  2. `repair_glbs.py`-era files carry a TRIMMED JSON chunk: byte-exact but
     shorter than 4-aligned, leaving the BIN chunk header unaligned.

This script rewrites every GLB under src/res/models into the one conformant
form: the JSON chunk is space-padded (0x20) back to 4-byte alignment, the
chunks that follow shift accordingly, and the header length is fixed up.
Geometry bytes are untouched. Idempotent: files already in this form come
back byte-identical.

Usage:
    python scripts/model_convert/repad_glbs.py           # apply
    python scripts/model_convert/repad_glbs.py --dry-run # report only
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models"


def repad_glb(data: bytes) -> tuple[bytes, str]:
    """Return (new_bytes, action) with action one of
    'ok' (already conformant), 'nul->space' (in-place NULs swapped),
    'realigned' (chunk lengths changed), or 'skip:<reason>'."""
    if len(data) < 20 or data[0:4] != b"glTF":
        return data, "skip:not-glb"
    version, total = struct.unpack_from("<II", data, 4)
    if version != 2:
        return data, "skip:not-v2"
    json_len, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:  # 'JSON'
        return data, "skip:no-json-chunk"
    json_chunk = data[20 : 20 + json_len]
    rest = data[20 + json_len :]
    if len(json_chunk) != json_len:
        return data, "skip:truncated"

    # Find the JSON's real end (strip legacy NUL/space padding), then re-pad
    # to 4-byte alignment with spaces per the glTF 2.0 GLB container rule.
    end = len(json_chunk)
    while end > 0 and json_chunk[end - 1] in (0, 32):
        end -= 1
    try:
        json.loads(json_chunk[:end].decode("utf-8"))
    except Exception as e:
        return data, f"skip:json-parse:{e}"

    pad = (4 - end % 4) % 4
    new_chunk = json_chunk[:end] + b" " * pad
    if new_chunk == json_chunk and total == len(data):
        return data, "ok"

    action = "realigned" if len(new_chunk) != json_len else "nul->space"
    new_total = 12 + 8 + len(new_chunk) + len(rest)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, new_total)
    out += struct.pack("<II", len(new_chunk), 0x4E4F534A)
    out += new_chunk
    out += rest
    return bytes(out), action


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--root", type=Path, default=MODELS_DIR,
                    help="models tree to process (defaults to this checkout's res/models)")
    args = ap.parse_args()

    files = sorted(args.root.rglob("*.glb"))
    counts: dict[str, int] = {}
    for path in files:
        data = path.read_bytes()
        new, action = repad_glb(data)
        counts[action.split(":")[0]] = counts.get(action.split(":")[0], 0) + 1
        if action == "ok" or action.startswith("skip:"):
            continue
        if args.dry_run:
            print(f"[dry] {action:11s} {path.relative_to(args.root)}")
            continue
        path.write_bytes(new)
    for key in sorted(counts):
        print(f"{key:12s} {counts[key]}")
    print(f"total        {len(files)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
