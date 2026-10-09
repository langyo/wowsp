# Lesta assets.bin format notes (26.10.0.0.8867689) — phase 1 findings

Status: **outer container fully mapped; the prototype payload (visuals /
models / materials) uses a new recursive serialization that is NOT yet
decoded.** This file records everything verified so far so the next pass
starts from this map instead of zero. The companion probe is
`scripts/extract/lesta_assetsbin_probe.py`.

## How to get the file

```sh
python scripts/extract/lesta_extract.py --game-dir "D:/WoWS_Korabli" \
    --out <stage> "content/assets.bin" "content/GameParams_py2.data"
```

(the same stage dir needs `scripts/*` — the entity-definition XMLs — plus a
ship's model dir when driving wowsunpack's `--disk-root`).

## Verified layout (identical to WG unless noted)

- **Header (16 B)**: magic `BWDB` (LE 0x42574442), version 0x01010000,
  checksum u32 (algorithm unknown — not plain CRC32 of anything obvious),
  arch u16 (64), endian u16 (0).
- **Body header @0x10** — four sections, same field order/sizes as the WG
  parser reads them (strings 0x28 B, r2p 0x18 B, paths 0x10 B, databases
  0x10 B). Relptr bases: strings/r2p/paths/databases resolve from 0x10,
  0x38, 0x50, 0x10 respectively (the WG code's bases — a hand-rolled parse
  that uses one flat base will misread by up to 96 bytes).
- **Strings section**: offsets-map hashmap (open addressing, linear
  probing; 8 B buckets = u32 key + u32 sentinel, sentinel bit 31 =
  occupied; parallel u32 values = string offsets) + the string pool.
  `get_string_by_id` works as-is; ~50k strings resolve.
- **r2p map**: open addressing, 16 B buckets (u64 key = path selfId, u64
  sentinel), parallel u32 values. Lookup works; values correlate strongly
  with payload type by low byte / 4 (blob index):
  `0`=mfm `1`/`2`=visual `3`=model `6`=xml … (verified over ~200k paths).
- **pathsStorage**: 32-byte records `(selfId u64, parentId u64, nameSize
  u32, pad u32, nameRelptr i64)` where `nameAbs = entryBase + 0x10 +
  nameRelptr`. count = 707,106; names blob follows the record array.
  **Divergence:** the leading **31,399 records are tombstones** — nameSize
  is plausible (5..47) but the name field holds a journal marker (u32
  offset, monotonically decreasing, plus a 0x95 tag byte), not a relptr.
  Their names are not in the file. All 675,707 live records parse
  byte-identically to the WG layout, and `reconstruct_path` (skip empty
  names, walk parents) yields full `content/gameplay/.../<MODEL>/x.visual`
  paths — verified for **58 of the 59** Lesta-only tree ships' model dirs
  (`GSD302_Z57_1945` — Otto Weddigen — has no visuals in this file at all).
- **databases**: 12 entries × 0x18 B `(magic u32, checksum u32, size u32,
  pad u32, dataRelptr i64)`. Blob headers claim `u64 count` + 0x10:
  blob0 (mfm) 29,377 records, blob1 39,793, blob2 119,631, blob3 (model)
  119,659 — counts look sane, **but see below**.

## The wall: payload serialization

Inside the blobs the WG fixed-size-record layouts (e.g. VisualPrototype
0x70 B) do not exist:

- No item size in 0x60..0xB0 yields sane WG-layout fields across blob1/blob2
  visual records (best case ~17% plausible — noise).
- The r2p value's upper 24 bits exceed the blob record counts (up to
  ~16.3 M while staying under the blob *size*), so the WG
  `(recordIndex << 8) | blob*4` decoding does not hold beyond the tag byte;
  the upper bits look like **byte offsets into the blob**, but records at
  those offsets are not WG-shaped either.
- What IS there: recursive 8-byte cells `(u32 kind, u32 payload)` — `kind`
  0 with an offset payload, or `(1,1)` separators — grouping runs of ~7
  offsets (seven ≈ the WG visual's seven node arrays, suggestive but
  unconfirmed). Following offsets lands in zero-filled array regions with
  `-360.0` sentinel floats (the game's null marker).
- **Node-transform arrays confirmed present** (verified after this doc was
  first drafted): blob1 contains ~381k affine-matrix 64-byte windows
  (`f[15]≈1`, `f[3]=f[7]=f[11]≈0`, finite, non-trivial translation) plus
  long runs of consecutive identity matrices (stride 64) — a plain-float
  scene-graph node store, not encoded/quantized. First strict hit in the
  26.10 file: blob1+0x26df88 (≈85.7M+2.55M absolute). blob5 (18.4 MB, the
  one whose header count reads as garbage) holds another ~15k matrix
  windows — likely a second graph database, so blob0..3 identification is
  incomplete too. The arrays' true starts (leading identities) and the
  cells that reference them were not yet pinned — u32/u64 searches for the
  strict-run start came up empty, so either the array header sits further
  back or references target the array's nominal base, not the first
  non-identity element.

So the visual/model prototypes are wrapped in a new tree/DOM container —
probably the same serialization the 26.x client uses for its new asset
pipeline. Decoding it needs the cell grammar → array encodings →
matrix/transform encoding → render-set/LOD → geometry-path resolution,
each of which is a separate reverse-engineering step.

## Also verified

- **Decode integrity is NOT the problem**: local install pkg and the CDN
  pkg decode to identical bytes; the idx CRC mismatch on this entry is a
  stale-CRC artifact of the 26.10 idx, not corruption (string pool, r2p
  map, 675k path names, and all 12 blob headers cohere).
- **Raw geometry files are readable** (`wowsunpack geometry` / `export-model
  --no-vfs`): per-part `.geometry` files parse, and the ship's main
  `<MODEL>.geometry` embeds the armor collision model (e.g. Zuiho:
  `CM_PA_united.armor`, 4,062 tris). BUT the per-part visual meshes are in
  **local/normalized space** (all parts share a ≈2.4×13.8-unit box) — the
  real placement/scale lives in the visual's node matrices, so parts cannot
  be assembled without the payload decode. `export-ship`/`export-armor-glb`
  both require the visual prototypes and stay blocked.
- The **WG client's** current `content/assets.bin` pkg entry is also a new
  chunked container (compression_info 0x100000005, not deflate, not the
  Lesta 0x700000006 Oodle layout) — upstream wows-toolkit has not cracked
  either (their 1.x releases sidestep via Steam depot downloads), so there
  is no reference implementation to borrow from for either game.

## Next steps (for whoever picks this up)

1. Decode the `(kind, payload)` cell grammar from a small visual (a single
   gun mount) by cross-referencing which cells the r2p byte-offset points
   at; the `-360.0` sentinel regions are likely zero-initialized name-id
   arrays — finding a NON-zero example (a visual with few nodes) will pin
   the array encodings fastest.
2. Matrices: scan blobs for 64-byte float blocks matching affine matrices
   (m[15]≈1, m[3]=m[7]=m[11]=0, finite |values|<1e4) and find the cells
   that reference them; that fixes the transform encoding and the
   record-base convention in one step.
3. Once nodes/matrices decode, port into
   `packages/tools/wowsunpack-vendor/.../models/visual.rs` behind a
   Lesta-signature gate (the tombstone block is a reliable detector), then
   `bake_lesta_ships.py` runs end to end.
