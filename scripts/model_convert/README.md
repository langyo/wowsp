# WoWSP model converters

WoWS ships its assets in a proprietary `.pkg` container format (NOT zip — it
uses a per-version `idx` index plus binary volumes in `res_packages/`), and the
mesh data inside is a custom `.geometry` format. Reverse-engineering that stack
from scratch is multi-week work, so WoWSP drives
[`game-assets`](https://github.com/landaire/wows-toolkit) (from landaire's
wows-toolkit) — a mature, actively-maintained Rust tool that reads the idx/pkg
VFS and exports `.geometry` + `.visual` straight to GLB.

These two scripts are **thin orchestrators**: they auto-detect the game install
(reusing WoWSP's registry + Steam logic), locate `game-assets`, and invoke its
`export-ship` / `export-map` subcommands. Adding a new map or ship is a
data-only operation — drop the name into a call and run.

## Prerequisites

Install `game-assets` once (any one method):

```bash
# Option A: prebuilt binary (Windows) — download from
#   https://github.com/landaire/wows-toolkit/releases/latest
#   (look for wows_toolkit_tools_<platform>.zip), then put game-assets.exe on PATH
#   or set WOWSP_GAME_ASSETS=/path/to/game-assets.exe

# Option B: from crates.io
cargo install game-assets

# Option C: from source
cargo install --git https://github.com/landaire/wows-toolkit game-assets
```

The game install is auto-detected the same way WoWSP's desktop shell does it
(Windows registry + Steam `appmanifest_552990.acf`). Override with
`WOWSP_GAME_PATH` if needed.

## Scripts

| Script | game-assets subcommand | Output |
|---|---|---|
| `convert_ship.py` | `export-ship` | `GLB` under `packages/webui/src/res/models/ships/` |
| `convert_map.py` | `export-map` | `GLB` under `packages/webui/src/res/models/maps/` |
| `bake_planes.py` | `export-model` | `GLB` under `packages/webui/src/res/models/planes/` + `props/` |
| `extract_lesta_planes.py` | — (GameParams → tables) | rows in `src/data/plane_types.json` + `plane_models.json` |
| `extract_plane_specs.py` | — (GameParams → tables) | rows in `src/data/plane_specs.json` (aircraft performance specs) |
| `bake_lesta_planes.py` | `export-model` (staged Lesta) | `GLB` under `packages/webui/src/res/models/planes/` (Lesta airframes) |
| `bake_missing_ships.py` | (model-exporter) | backfills specific ship GLBs under `ships/` |

## Battle-effect models (planes / shells / torpedoes)

`bake_planes.py` exports the real aircraft and projectile models the replay
viewer renders for squadrons, shell flights, and torpedoes:

```bash
# Bake the planes that appear in a replay dump (usual case):
python scripts/model_convert/bake_planes.py --from-dump dump.json

# Specific planes by GameParams name, or everything:
python scripts/model_convert/bake_planes.py --planes PJAF206_Ryujo_top
python scripts/model_convert/bake_planes.py --all

# Re-bake planes whose output GLB already exists:
python scripts/model_convert/bake_planes.py --all --force

# Just the shared shell + torpedo props:
python scripts/model_convert/bake_planes.py --props-only
```

- Plane GLBs are named by GameParams index (`PJAF206.glb`); the frontend maps
  a squadron's paramsId → index → GLB via `src/data/plane_types.json`.
- `src/data/plane_models.json` (GP name → VFS `.geometry` path) comes from each
  GameParams entry's `model` field — regenerate after a game update.
- Props are shared game models: `props/shell.glb` (all gun shells),
  `props/torpedo.glb`.
- The bake only assembles correctly when `export-model` resolves the airframe's
  `.visual` — its node transforms place the bone-local render sets (propeller,
  antenna wire, …). The in-tree `assets_bin.rs` normalizes the leading slash of
  VFS-style paths before its suffix match; without that normalization every
  leading-slash query misses and the export silently falls back to raw
  geometry, scattering the unplaced sets around the airframe. Seeing
  `No matching .visual found; exporting raw geometry` for a WG-client airframe
  in the bake log means that resolution broke again.
- Requires the in-tree patched `game-assets` (`target/release/game-assets.exe`):
  stock `export-model` pairs vertex/index mappings positionally, which corrupts
  multi-buffer raw exports (most planes). The vendored patch pairs them by the
  mappings' shared `packed_texel_density` render-set hash instead.

### Lesta (Мир кораблей) airplanes

The Lesta client's pkgs are Oodle-compressed, so `bake_planes.py` cannot read
its airframes off the pkg VFS. Two Lesta-only steps cover them — the plane
tables first, then the staged bake:

```bash
# 1. Merge the Lesta-only carriers' airframes into the plane tables
#    (plane_types.json rows gain "lesta": true; idempotent).
python scripts/model_convert/extract_lesta_planes.py   # needs GameParams_lesta.json

# 2. Bake those airframes: lesta_extract.py stages the .geometry (Oodle),
#    export-model --no-vfs converts, bake_model --dedup-lods decimates.
python scripts/model_convert/bake_lesta_planes.py \
    --game-dir "D:/WoWS_Korabli" --stage "C:/lesta-work/stage"
```

`just extract techtree` normally runs step 1 for you (it rides the same Lesta
client snapshot as the tech tree and the encyclopedia overlay); step 2 runs
by hand, like the Lesta hull bakes — the Oodle decoder (unoodle) it needs is
shallow-cloned and built automatically on first use
(`scripts/extract/fetch_oodle.py`, also `just build unoodle`;
`WOWSP_OODLE_NO_BUILD=1` or `--ooz` to opt out/supply your own).
The Lesta-only ships' **armor/ballistics** slices are a third piece of the
same snapshot — `scripts/extract/build_lesta_shipdata.py` bundles them into
The Lesta-only ships' **armor/ballistics** slices are a third piece of the
same snapshot — `scripts/extract/build_lesta_shipdata.py` bundles them into
the Rust tree (`packages/app/tauri/data/lesta_ship_gameparams.json.gz`,
embedded via `include_bytes!` and inflated once per process — see
`commands/gameparams.rs`), so those ids never depend on a game install.

### Aircraft performance specs (ship-detail panel)

`packages/webui/src/data/plane_specs.json` feeds the ship-detail
Specifications tab when the 3D stage's model dropdown is switched from the
hull to a carrier aircraft (`shipPlaneSpecs.ts` → `buildPlaneSpecs`). The
script documents the exact field mapping and damage formulas; every number
comes from the full GameParams dumps — the aircraft entity itself plus the
projectile its carried-ammunition reference resolves to.

The table mirrors every committed `plane_types.json` row, including legacy,
event and internal `Aircraft` entities that no playable ship currently
references; a handful of those legacy airframes carry placeholder GameParams
stats (very low HP, 0.1 s restoration) that are faithful to the dump but read
oddly — the 3D picker only lists airframes a ship's own GameParams references,
and every such airframe currently resolves to a spec row (verified against the
mobile offline pack and the bundled Lesta slices). Keep the raw values rather
than filtering: they are the data the client itself carries.

**Refresh both realms, in this order** (WG first; each run owns its own rows):

```bash
python scripts/model_convert/extract_plane_specs.py \
    --input "%LOCALAPPDATA%/WoWSP-extract/GameParams.json"
python scripts/model_convert/extract_plane_specs.py \
    --input "%LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json"
```

`--check` (write-nothing, non-zero exit on drift) takes the same two
invocations:

```bash
python scripts/model_convert/extract_plane_specs.py --check \
    --input "%LOCALAPPDATA%/WoWSP-extract/GameParams.json"
python scripts/model_convert/extract_plane_specs.py --check \
    --input "%LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json"
```

The two dumps are **not interchangeable**, which is why the script partitions
the table by realm instead of letting a later run overwrite earlier rows: the
Lesta client's numbers diverge from the WG client's on 339 of the 528 airframes
both still carry (restoration time alone differs on 193, damage on 152; 118 of
them dropped their carried-ammunition reference entirely — e.g. Midway's stock
fighter `PAAF110` has `timeToRestore` 68.0 s on WG vs 74.0 s on Lesta). The
committed values — and the contract anchors in `shipPlaneSpecs.test.ts` — are
the WG ones the wargaming wiki documents. Each airframe is therefore taken
from the client that authored it: rows without `"lesta": true` from the WG
dump, the marked Lesta-only airframes (added by `extract_lesta_planes.py`)
from the Lesta dump. The source is auto-detected from the standard cache file
name; pass `--source wg` / `--source lesta` explicitly for renamed dumps.

`just extract models` refreshes the WG slice; `just extract techtree`
refreshes the Lesta slice (after `extract_lesta_planes.py` merges the
Lesta-only carriers' airframes).

## Usage

```bash
# Convert one ship by display name (fuzzy-matched) or model dir name
just convert-ship --name Montana --output ships/
just convert-ship --name USA001_Montana_1945 --hull B

# Convert one map/space by its internal id
just convert-map --name 15_NE_north --output maps/

# Or run directly
python scripts/model_convert/convert_ship.py --name Montana
python scripts/model_convert/convert_map.py --name 15_NE_north
```

Run `--help` on either script for all flags (LOD, hull selection, terrain
decimation, texture downsampling — all forwarded to `game-assets`).

## Baking (low-poly holographic GLBs)

`bake_model.py` simplifies a high-poly exporter GLB down to a small low-poly
GLB (~60–150 KB) for the holographic viewer, using vertex-clustering
decimation that keeps surfaces continuous. `batch_bake.py` runs the full
export→bake pipeline for every playable ship: the ship list comes from
the extract cache's `GameParams.json`, and export goes through the Rust
`model-exporter` tool package (`packages/tools/model-exporter`, built by
`just build model-exporter`) in one `--batch` process — the GameParams
parse is paid once for the whole fleet. It replaced the vendored C++
wows-model-exporter (and its CMake/vcpkg chain) outright.

### Resumable / batched runs

The batch driver is **resumable by default**. It inspects each existing GLB's
triangle count (via JSON accessor metadata only — no binary decode) and treats
ones below `--resume-min-tris` (default 3000) as *stale* and re-bakes only
those. This separates the current ~6000-tri vertex-clustering bakes from old
~2000-tri shard bakes, so you can interrupt and re-run freely — each run only
touches what still needs work.

```bash
# Bake everything stale (full run, ~4.5h for ~900 ships) — safe to Ctrl-C
python scripts/model_convert/batch_bake.py

# Batched: bake 100 stale ships then exit. Re-run to pick up the next 100.
# Each invocation is short (~30min) so no single run must finish the lot.
python scripts/model_convert/batch_bake.py --limit 100
python scripts/model_convert/batch_bake.py --limit 100   # continues where the last left off

# Re-bake absolutely everything (ignore freshness)
python scripts/model_convert/batch_bake.py --force

# One ship at a time (no batch driver) — useful for debugging one model
python scripts/model_convert/bake_model.py input_raw.glb -o ships/Foo.glb --triangles 6000
```

The driver checkpoints progress implicitly via the output files themselves:
there's no separate state to corrupt, and a killed run leaves every file it
finished in a valid state.


## How to add a new map or ship

1. Make sure `game-assets` is installed and the game is detected (run WoWSP once
   or set `WOWSP_GAME_PATH`).
2. `just convert-ship --name <ShipName>` (or `just convert-map --name <space_id>`).
3. Commit the resulting GLB under `packages/webui/src/res/models/ships/` or
   `packages/webui/src/res/models/maps/`.
4. The frontend auto-discovers models via Vite's static asset glob
   (`import.meta.glob` in `features/holographic/modelLoader.ts`). Model files
   are matched case-insensitively by filename stem (without `.glb`):
   - Ships: `<displayName>.glb` (e.g. `Montana.glb`) or `<modelDir>.glb`
     (e.g. `PASB510_Montana.glb`). Both are tried in that order.
   - Maps: `<spaceId>.glb` (e.g. `15_NE_north.glb`). Any `spaces/` prefix is
     stripped before matching.
   - Planes: `<gpIndex>.glb` under `planes/` (e.g. `PJAF206.glb`).
   - Props: `shell.glb` / `torpedo.glb` under `props/`.
5. No code changes are needed — placing the GLB in the right directory is
   enough. The holographic map progressively enriches: ships without models
   use procedural cone markers, maps without terrain use a grid helper.

## Contour maps (terrain elevation + sea-floor bathymetry)

`convert_map_holo.py` produces the **holographic contour map** the replay
viewer renders: a multi-mesh GLB with a decimated `Terrain` height-field
(showing contour bands + sea-floor bathymetry/trenches) and simplified
`Islands`. `convert_map.py` (above) only emits island geometry and drops the
terrain — use `convert_map_holo.py` for the full topographic result.

```bash
# Requires the patched game-assets (below). One map at a time:
just convert-map-holo --name 18_NE_ice_islands
just convert-map-holo --name 15_NE_north

# Or directly (set the patched binary path):
WOWSP_GAME_ASSETS=target/model-tools-patched/game-assets.exe \
  python scripts/model_convert/convert_map_holo.py --name 18_NE_ice_islands
```

### Why `game-assets`?

Stock `game-assets export-map` clamps terrain to sea level (Y >= 0) and culls
fully-submerged triangles — so sea-floor bathymetry and trenches are discarded
before the GLB is written. The raw `terrain.bin` heightmap *does* contain
negative depths; the exporter just throws them away with no flag to disable it.

`game-assets` is vendored as a workspace member (`packages/tools/game-assets tree/`)
from the official [`landaire/wows-toolkit`](https://github.com/landaire/wows-toolkit)
repo. Build it once:

```bash
just build game-assets
```

The vendor tree is tracked in-tree (an independent fork of landaire's
wows-toolkit, slimmed to the library crates — never a nested clone inside
this checkout) and the build compiles the `game-assets`
workspace member into `target/release/game-assets.exe`.
`convert_map_holo.py` auto-detects and uses it. The script gracefully
degrades without `--keep-submerged` (trenches flattened, contours still work).

The frontend renders the contour terrain via `holoContourShader.ts` — land is
banded by elevation, shallow sea teal, and deep trenches deep-blue with the
densest contour lines.

### Batch bake + minimap art + names (the full map refresh)

```bash
# Bake every space the install carries (resume-safe; new/changed maps only):
just bake-maps                                # or batch_bake_maps.py --terrain-step 2

# Minimap art (minimaps/<id>.webp) + world bounds (minimaps.json) for the
# spaces that got a GLB:
python scripts/model_convert/extract_minimaps.py

# Localized map names (map_names.json) from the gettext catalogs:
python scripts/model_convert/extract_map_names.py                 # WG install
python scripts/model_convert/extract_map_names.py \
  --game-dir "D:/WoWS_Korabli" --merge   # Lesta: fill ids WG lacks, keep WG names
```

### Lesta-only maps

The Lesta (Мир кораблей) client's pkgs are Oodle-compressed, so the WG VFS
route cannot read its spaces. `bake_lesta_maps.py` stages each Lesta-only
space via `scripts/extract/lesta_extract.py`, exports terrain-only
(`export-map --no-models` — the holo pack keeps just the `Terrain` mesh, and
Lesta 26.x `models.bin` is beyond the vendored parser for now), and writes
the same GLB + minimap art + bounds artifacts as the WG route. Spaces whose
GLB already exists are skipped — shared ids keep the WG bake (dedupe), so a
run only ever adds Lesta-exclusives (event maps like `e17_2026_Lukomorye`,
new numbered maps like `56_Kamchatka`, ports):

```bash
python scripts/model_convert/bake_lesta_maps.py \
  --game-dir "D:/WoWS_Korabli" --stage "C:/lesta-work/mapstage"
```

When no Oodle decoder is present one (unoodle) is built automatically
(`scripts/extract/fetch_oodle.py`). If a stale `unoodle` from cargo's bin
sits first on the probe path (it exits 0 without writing output), point
`--ooz` at the freshly built one under
`%LOCALAPPDATA%/WoWSP-extract/oozextract/target/release/unoodle.exe`.

## Status

Working orchestrators. The actual format decoding is `game-assets`'s job; these
scripts add WoWSP-specific game detection, output placement, and friendly CLI.
