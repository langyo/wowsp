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
`unoodle.exe` into `target/release/` — or let
`scripts/extract/fetch_oodle.py` do exactly that (shallow `--depth 1`
clone + build; `just build unoodle`, and the Lesta extraction/bake routes
invoke it automatically when no decoder is found).

## Phase 4 addendum (2026-10-10, later): the format map above was partly corruption

Re-extracting assets.bin with **unoodle** (the working decoder, see the
phase-3 addendum) and re-running the probe shows the outer container is
**entirely WG-compatible**: zero tombstone prefix (all 707,106 path
entries name cleanly), the r2p extension map lands exactly on the blob
record counts (visual→1/2, model→3, mfm→0 — the WG `(record<<8)|blob*4`
decoding), and every database header count parses. The phase-1/2
"divergences" (tombstone journal markers, byte-offset r2p theory,
recursive cell serialization) were **artifacts of ooz's silent
mis-decodes**. The visual record header at a WG-computed address
(blob1+16+rec*0x70) also starts WG-shaped for the Zuiho root (nodes_count
+ five in-range node-array relptrs, identity matrices at the targets) —
export-ship still trips deeper in (the tail layout past +0x30 differs),
so the full-fidelity Rust port remains future work, but anyone resuming
it should start from the UNOODLE-decoded file and distrust every
conclusion above that was drawn from ooz output.

## Phase 5 (2026-10-18): the WG-format records are a minority; ship visuals mostly new-format

Motivated by wanting secondary/AA mount placements for the Lesta-only
bakes (splash boxes anchor main turrets only — the `CM_SB_ss_*` boxes
turn out to be superstructure hit volumes, not secondary mounts). The
mount transforms exist ONLY in the visual prototypes, so this phase
re-audited how much of the visual store is actually WG-parseable,
starting from the unoodle-decoded `content/assets.bin` (223,841,548 B):

- **blob1 (abs 85,695,377, size 78,349,548, count 39,793) holds WG-layout
  VisualPrototype records at `base + 0x10 + rec*0x70` — but only a
  minority parse**: a full-stride scan with a strict sanity gate
  (nodes_count ≤ 3000, five in-bounds relptrs, last-node matrix affine)
  validates **5,685 / 39,793**. Zuiho's root (rec 11196) parses perfectly
  — 7 nodes `Scene Root + Full + HP_Bow/Full/MidBack/MidFront/Stern`,
  identity matrices — so the WG reader itself is fine; the other ~34k
  slots hold something else (new-format records, OOL spill, or both).
  Note the sanity gate is what phase-4's hand-check lacked: scanning
  *every* 8-byte offset produces ~39.8k plausible-looking headers, most
  of them false positives (their offsets mod 0x70 scatter over
  {0,16,32,48,64,80,96}).
- **Coverage over the 111 turret-anchored Lesta-only ships: 2** —
  PJSC111 (rec 12352) and PFSC519 (rec 4540). New Jersey's root visual
  (r2p `0x0069ba08`, rec 27066, both path twins agree) lands mid-blob on
  bytes that read as a packed-transform array (f32 runs with 1.0f
  terminators ~60 B apart, no `nodes_count` prologue) — consistent with
  phase-4's "tail layout past +0x30 differs": reworked ships are stored
  in the new layout, unmigrated ones keep the WG one.
- **Why this blocks secondaries/AA**: WG `VisualPrototype` carries the
  full node tree (names + matrices + parent chain), and GameParams'
  `A_ATBA` / `A_AirDefense` gun entities carry the models — together
  they are everything `export-ship` needs to mount secondaries and AA
  (plus every boat/crane). With 109/111 ship visuals in the new format,
  a harvest-from-the-WG-client fallback is no substitute either: only
  11 of the 111 hull dirs still exist there verbatim (+4 more under a
  different revision prefix), because WG pruned retired model dirs.
- Practical consequence for `bake_lesta_ships.py`: main-turret mounting
  stays splash-anchored (see the script's mirror calibration); universal
  secondary/AA mounting waits on decoding the new visual record layout.
  Suggested next probe: diff a known WG-format record (Zuiho rec 11196)
  against the byte layout at its live r2p address to find the
  new-format's field order, then walk NJ rec 27066 as the reworked-ship
  specimen.

## Phase 6 (2026-10-18): CRACKED — the node trees are WG-shaped OOL blocks in blob1

The decode that matters for the bakes is done. The new-format visual
records' *headers* remain unlinked, but their **payload — the node
trees with every hardpoint transform — sits in blob1 as plain WG-shaped
OOL array blocks**, findable by structure scan with no header needed:

- **Block layout** (one per ship PART visual, i.e. Bow / MidFront /
  MidBack / Stern): `[name_map_name_ids u32×N][name_map_node_ids
  u16×N][name_ids u32×N][matrices 16×f32×N][parent_ids u16×N]` — byte
  for byte the WG `VisualNodes` OOL layout. Matrices are ROW-major
  (translation in the last row, elements 12–14) where WG's were
  column-major; parents carry the 0xFFFF root sentinel.
- **Where**: blob1's out-of-line zone, roughly offsets 59.7M–68.3M of
  78.3M. A structural scan (walk `Scene Root`-anchored u32 runs that
  resolve as strings, then validate the map/matrices/parents layout)
  finds **4,534 blocks**, 105 of which contain `HP_AGM_*` main-turret
  nodes — matching the 111 turret-anchored Lesta-only ships (some ships
  share hulls/twins).
- **Frame**: blocks are in the SHIP-GLOBAL SPLASH frame (+z = bow, the
  mirrored one). New Jersey's bow block has `HP_AGM_1 = (0, 0.349,
  +4.065)` and `HP_AGM_2 = (0, 0.536, +2.608)` — the splash `gk_1_1` /
  `gk_2_1` box (center-x, **top-y**, center-z) to three decimals. The
  splash-mount calibration in `bake_lesta_ships.py` is hereby confirmed
  by the game's own visual layer.
- **Everything is there**: NJ's bow block (312 nodes) carries 32
  `HP_AGA_*` AA mounts + 6 `HP_AGS_*` secondaries; the stern block (295
  nodes) carries 35 + 4 more, plus `HP_AGM_3 = (0, 0.406, −4.451)`.
  Combined `AGS_1..10` and `AGA_1..67` match the GameParams
  `A_ATBA`/`A_AirDefense` HP name sets EXACTLY — that name-set equality
  is the attribution signature (see below).
- **Rotation is real**: side mounts carry ±90° yaw matrices (row-major
  `[[0,0,1],[0,1,0],[-1,0,0]]`), verified mirror-consistent against the
  WG client's own export of the same hull's mounts; translations agree
  within the two clients' ship-revision differences (~0.1).
- **Attribution without headers**: nothing in the file references a
  block by offset (u32/u64/relptr searches all come up empty — the
  formal record→block linkage is still unknown), but attribution by
  content is exact: (a) a block's `HP_AGM_N` (y, z) must equal the
  ship's splash `gk_N` box (top-y, center-z), and (b) the union of a
  ship's blocks' HP names must equal the GameParams HP name set.
  Sister ships with identical turret signatures (Iowa-class sterns)
  disambiguate via (b) — their AA/secondary name sets differ.
- **Bogus lead eliminated**: the tag-0x08 r2p values read as full-u32
  byte offsets into blob2 land on scenery tiles (`LNT035_*` nature
  geometry) — that addressing is a coincidence, not a linkage. The
  0x40-stride AABB "cells" near those addresses and the 0x50-stride
  render-set bundles (with `TL2_SHIPMAT_*` strings and `.mfm` path
  selfIds resolving cleanly) elsewhere in blob2 are real structures but
  unrelated to ship node trees.
- **Bake integration path** (next PR): parse assets.bin once per bake
  run → attribute part blocks per ship as above → for every GameParams
  HP gun entity (`A_Artillery`/`A_ATBA`/`A_AirDefense`), export the gun
  geometry and place it with the block's full matrix (rotation finally
  becomes per-mount exact, replacing the positional bow/stern yaw
  inference for mains too — the AGM nodes carry true facing).
  `place_gun_glb` needs a general 4×4 path (it currently only does the
  180° yaw flip); sub-mounts (`HP_AGM_2_HP_AGA_4` — AA riding turret
  tops) ride the parent chain via the block's parent_ids.
  `scripts/extract/lesta_assetsbin_probe.py --node-blocks` now
  implements the scan.

## Phase 7 (2026-10-19): the .visual text format confirmed via WG's ModsSDK; Lesta's SDK needs the live client

Internet research on the remaining edge (ships whose part visuals never
entered the readable node-block store):

- **The visual prototype's source form is XML.** WG publishes a ModsSDK
  repo (github.com/WG-devacc/ModSDK) whose per-ship folders carry the
  extracted `.model`/`.visual`/`.geometry`/`.splash` as TEXT: a
  `.visual` is a `<node>` tree with `<identifier>` names and ROW-major
  4×4 `<transform>` rows (translation in row3) — exactly the structure
  the blob1 node blocks serialize. This retro-validates the phase-6
  block layout including the row-major convention.
- **Lesta's equivalent (the forum's Content SDK) cannot be used
  offline.** Its `ModsSDK.zip` (Google Drive, linked from the korabli.su
  Content SDK guides) feeds an in-client dump: a `PnFMods` mod calls
  `contentSdk.extractSources(mod, ship_id)` and the CLIENT writes the
  ship's sources on next launch. Extracting that way means launching
  the game and writing under `res_mods/` — forbidden by this repo's
  §0 client-safety gate (and the Drive folder is unreachable from CN
  networks anyway). No public offline spec for the 26.x recursive
  serialization exists; gamemodels3d's 2023-era PHP parser predates it.
- Consequence: the seven hulls with no node-block coverage (Akagi's
  main deck, the Jean Bart stub, Borodino 04, two Soviet cruisers,
  Patagonia, Izmail-class twin) stay on the splash fallback — mains
  only, secondaries/AA absent. A deck-proximity validator was prototyped
  as an alternative discriminator for their pure-AA blocks and FAILED
  calibration (wrong-family blocks score 1.0 near the centerline of any
  hull; a ship's own superstructure AA scores 0.6) — geometric context
  does not separate revisions here. The path to full coverage is a
  future crack of the recursive cell serialization (see the follow-up
  below — the SDK dump turned out not to contain placements either).

### Phase 7b: the ModsSDK dump obtained and closed as a placement source

With proxy access restored, the community ModsSDK_26.10.0.zip (532 MB,
167,563 files, 891 ship folders keyed by GameParams entity names minus
the leading P) was pulled from the maintainer's Drive. Findings:

- 93 of the 111 turret-anchored ships and 3 of the 7 no-block hulls
  (Akagi `JSA508`, Tranalucator `ISB529`, Patagonia `VSB509`) have
  source folders — but the dumped `.visual` files are MESH CONTAINERS
  only: the ship-part visuals carry render-set nodes (`Bow_0001`-style
  mesh names, `TL2_*` materials, `HP_flag_*` flag poles) and ZERO
  weapon hardpoints. The client injects `HP_*G?_*` mounts from the
  COMPILED visual layer at load time; the text source format never
  contains them. This closes the SDK avenue definitively: no text
  artifact in Lesta's ecosystem carries mount transforms.
- The dump's `gun/*.visual` files are the gun models' own containers
  (gun-local, no ship placement) — equivalent to what
  `wowsunpack export-model` already produces.
- Also in the Drive folder: `pfsunpack2.exe` (Lesta's newer official
  pkg unpacker — not needed, `lesta_extract.py` + unoodle already
  decode everything we consume) and `geometrypack.zip` (a repacker for
  pushing mods back INTO the client — out of scope by §0).

So the ONLY remaining path to the seven hulls' secondaries/AA is
cracking blob2's recursive cell serialization (the phase-4 wall).

## Phase 8 (2026-10-19, later): the legacy record walk; blob2 cells mapped

- **Second harvester — the legacy record walk.** blob1's 0x70-stride
  headers are authoritative entry points: each valid one carries five
  relptrs to the same arrays the structure scan hunts, but records whose
  names array lacks a `Scene Root` anchor escape the scan. Walking all
  39,793 headers (nodes 4..4000, relptrs in range, names resolvable,
  first matrix affine) yields ~700 gun-mount blocks; ~220 are NEW vs the
  scan (content-deduped by mount signature). Merged into the bake
  digest, coverage jumps: Moonsund PRSC540 goes 0 -> 5 sec + 5 AA (its
  MidFront part IS a legacy record whose names don't start with Scene
  Root), and a dozen partial ships complete (Prinz Eitel Friedrich
  18->36 mounts, Santander 19->33, North Dakota full, ...).
- **blob2 identity settled: it is NOT the ship-visual store.** Its
  136k names-runs resolve to CREW SKELETON bones (sailor animation
  rigs, Character1_*). The tag-0x08 r2p values for the six remaining
  no-block ships point at blob2 slots holding the recursive cell
  format: plausible ship-space float triplets, ±FLT_MAX AABB sentinels,
  u64 material hashes, and `(count=1, byte-offset)` pointer pairs into
  blob2's 10-15 MB zone — which holds RENDER-SET cells (the phase-2
  0x40-stride AABB+hash records), not node trees. The ships' node data
  in this format is either deeper in the cell graph or absent; the
  pointers to chase are recorded (Akagi rec 11315 blob2+1,267,296,
  Patagonia 14,872,060, Hanko 14,995,300).
- Nation-mismatch theory tested and dead: blob1 rec 11316 (the r2p slot
  coincidentally labeled Akagi_Bow) carries HP_RGM_* casemates whose
  positions do NOT match Akagi's gk boxes (y 0.30 vs 1.115) — it is a
  different Russian ship's part; r2p rec numbers do not index blob1
  slots for new-format ships.
- Related hardening that DID land: revision-twin mounts of the same
  class dedupe at per-axis 0.15 (two mounts of one class cannot share
  a pivot; the fleet-wide same-class pair histogram is empty 0.05-0.15
  and dense above), different classes keep 0.05.
