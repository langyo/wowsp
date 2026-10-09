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

## Phase 2 (2026-10-10): r2p addressing SOLVED, records located

The decisive oracle: a ship `.geometry` file's **vertex/indices mapping IDs**
(printed by `wowsunpack geometry --no-vfs`) must appear verbatim inside the
visual payload that references it. Searching the file for Zuiho's main
geometry mapping IDs (`0x3F66C155`/`0x3622C904` vertex, `0x1A080768`/
`0x8017BAF0` indices) surfaced the render-set store and cracked the chain:

- **r2p value = byte offset, taken as the FULL u32, into the owning blob.**
  For `.visual` payloads use only the entries whose low byte is `0x08`
  (blob2 = the visual database): record @ `blob2_base + value`. Verified:
  2,637 building visuals (`LBV*/LL*/LMC*`) land exactly on their render-set
  zone, and Zuiho's root visual sits at `blob2 + 0x002BBC08` (= 2,867,208).
- The same path name has multiple r2p entries: low byte `0x08` = live
  (byte offset); odd low bytes (`0x95/0x99/0x9d/0xa1/0xa5` — same values as
  the tombstone journal tag!) = legacy/junk twins; low byte `0x04` entries
  are a second (older?) pointer space. Ignore everything but `0x08` for
  visuals. `.mfm` (tag 0) values do NOT fit the full-offset reading (their
  upper 24 bits look like the offset instead) — per-type encodings differ;
  visuals are the only ones the bake needs.
- **Render-set records** (found around `blob2+25.4M..26.3M`): the geometry
  mapping-id pair `(vertices_mapping_id, indices_mapping_id)` appears
  side-by-side as leading u32s, followed by a material-ish hash, a `0x100`
  flags word, a u64 hash (mfm path id shape), node-count-ish u32s
  (`0x50/0x54`), sentinel float3 arrays (`0x7F7FFFFF`/`0xFF7FFFFF` —
  ±FLT_MAX defaults), and more material hashes — WG `RenderSet` semantics
  (0x28-byte fixed record in WG) in a new variable layout with inline
  arrays.
- **Node records** (Zuiho root visual @ `blob2+0x2BBC08`): ~0x40-stride
  records = `(u32 link_offset, u32 0, transform floats (small values —
  angles/translations), id hashes, 01 00 00 00 00 00 00 00 separator)`.
  The link offsets (e.g. `0x0165D0E0` ≈ blob2+23.4M) chain deeper toward
  the render-set zone — the visual's arrays are linked, not contiguous.
- The earlier phase-1 read of `blob1 + upper` was a mis-address; blob1's
  role remains unclear (possibly the older twin store) — not needed.

## Also verified## Also verified

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

## Next steps (phase 3)

1. Finish the render-set field map: collect many `(vert_id, idx_id)` pairs
   across the store, diff their byte layouts against WG's 0x28 layout
   (`parse_render_set_fields`: name/material/vertices/indices u32s + mfm
   u64 + skinned/count u8s + relptr) — pin the variable-length prefix and
   where the inline node-id arrays start/end.
2. Decode the node grammar at the visual record: walk the link chain
   (link → child arrays), identify matrices (plain f32 4x4s exist in blob1
   by the hundreds of thousands; find them relative to the link targets),
   and the name-map/parent-id arrays.
3. Python-prototype the full decode for Zuiho's root visual + its Bow/
   MidBack/MidFront/Stern sub-visuals (r2p 0x08 values 11,196..11,204),
   validating against the geometry mapping IDs, then port into vendored
   `visual.rs` behind a Lesta gate (`r2p_lowByte==8` is a clean detector).
4. `bake_lesta_ships.py` end-to-end, then the res pack publish.

## Phase 3 addendum (2026-10-10): the models are baked — decoder was the bug

The payload crack turned out to be unnecessary for the holographic bakes:
the per-part `.geometry` files are **already positioned in ship space**
(Connecticut MidFront z∈[-7.2, 0.4] vs MidBack z∈[-0.1, 7.3] — disjoint
halves), so each ship is the union of its non-LOD part meshes and
`bake_lesta_ships.py` bakes straight from them (extract → export-model
--no-vfs → merge → bake_model, 58/58 Lesta-only ships, 12-15k tris each).

The remaining decode mystery also fell: **powzix/ooz silently mis-decodes
the Oodle streams of files written by the newer SDK in 26.10** (the
MidBack/MidFront hull parts — length-exact output, wrong bytes, meshopt
`UnexpectedEof` downstream). The oozextract Rust port
(github.com/lvlvllvlvllvlvl/oozextract, `unoodle`) decodes every such
stream CRC-exact. `lesta_extract.py` now prefers unoodle and falls back to
ooz; build it with `cargo build --release --features cli` and drop
`unoodle.exe` into `target/release/`.
