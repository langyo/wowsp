#!/usr/bin/env python3
"""One-shot repair of baked GLB files in src/res/models/.

Two defects from an earlier bake_model.py (both now fixed at the source) shipped
in the committed GLBs:

  1. The index bufferView's `byteLength` was `len(idx) - len(vert)` instead of
     `len(idx)`, so it went NEGATIVE on any ship whose vertex data is larger
     than its index data → "Invalid typed array length" in GLTFLoader.
  2. The JSON chunk was null-padded to 4-byte alignment, which some loader
     JSON.parse paths reject ("Unexpected non-whitespace character after JSON").

This script rewrites the JSON chunk of every affected GLB in place:
  - recomputes any negative bufferView byteLength as (buffer.total - byteOffset)
  - trims trailing null/space padding from the declared JSON chunk length

Idempotent: re-running on already-fixed files is a no-op.

Usage:
    python scripts/model_convert/repair_glbs.py
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

MODELS = Path(__file__).resolve().parents[2] / "packages" / "webui" / "src" / "res" / "models"


def repair_glb(path: Path) -> str:
    """Return 'repaired', 'ok', or 'skip:<reason>'."""
    data = bytearray(path.read_bytes())
    if len(data) < 20 or data[0:4] != b"glTF":
        return "skip:not-glb"
    version, total_len = struct.unpack_from("<II", data, 4)
    if version != 2:
        return "skip:not-v2"
    # JSON chunk
    json_len, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:  # 'JSON'
        return "skip:no-json-chunk"
    json_raw = bytes(data[20 : 20 + json_len])
    # Trim trailing nulls/spaces to find real end.
    end = json_len
    while end > 0 and json_raw[end - 1] in (0, 32):
        end -= 1
    try:
        gjson = json.loads(json_raw[:end].decode("utf-8"))
    except Exception as e:
        return f"skip:json-parse:{e}"

    # Repair negative bufferView byteLengths.
    repaired_bv = False
    for bv in gjson.get("bufferViews", []):
        bl = bv.get("byteLength")
        if isinstance(bl, (int, float)) and bl < 0:
            buf_idx = bv.get("buffer", 0)
            buf_total = gjson.get("buffers", [{}])[buf_idx].get("byteLength")
            if isinstance(buf_total, (int, float)):
                bv["byteLength"] = buf_total - bv.get("byteOffset", 0)
                repaired_bv = True

    if not repaired_bv and end == json_len:
        return "ok"  # nothing to do

    # Re-serialize. New JSON must fit in the existing chunk slot (it's always
    # shorter: a negative number like -74008 → 15740 is fewer digits, and
    # trimming padding only shortens it).
    new_json = json.dumps(gjson, separators=(",", ":")).encode("utf-8")
    if len(new_json) > json_len:
        return f"skip:new-json-longer:{len(new_json)}>{json_len}"
    # Overwrite the chunk with the new JSON + space padding to original length.
    data[20 : 20 + len(new_json)] = new_json
    for i in range(len(new_json), json_len):
        data[20 + i] = 32  # space pad (JSON.parse tolerates trailing spaces)
    # Keep the declared chunk length as json_len (unchanged) so BIN offset is
    # untouched; the trailing spaces are valid JSON whitespace.
    path.write_bytes(bytes(data))
    return "repaired" + ("+bv" if repaired_bv else "") + ("+trim" if end != json_len else "")


def main() -> int:
    for sub in ("ships", "maps"):
        d = MODELS / sub
        if not d.is_dir():
            continue
        repaired = 0
        ok = 0
        skipped = 0
        for p in sorted(d.glob("*.glb")):
            res = repair_glb(p)
            if res.startswith("repaired"):
                repaired += 1
            elif res == "ok":
                ok += 1
            else:
                skipped += 1
                if skipped <= 3:
                    print(f"  {p.name}: {res}")
        print(f"{sub}/: repaired={repaired} ok={ok} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
