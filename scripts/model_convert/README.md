# WoWSP model converters

WoWS ships its assets in a proprietary `.pkg` container format (NOT zip — it
uses a per-version `idx` index plus binary volumes in `res_packages/`), and the
mesh data inside is a custom `.geometry` format. Reverse-engineering that stack
from scratch is multi-week work, so WoWSP drives
[`wowsunpack`](https://github.com/landaire/wows-toolkit) (from landaire's
wows-toolkit) — a mature, actively-maintained Rust tool that reads the idx/pkg
VFS and exports `.geometry` + `.visual` straight to GLB.

These two scripts are **thin orchestrators**: they auto-detect the game install
(reusing WoWSP's registry + Steam logic), locate `wowsunpack`, and invoke its
`export-ship` / `export-map` subcommands. Adding a new map or ship is a
data-only operation — drop the name into a call and run.

## Prerequisites

Install `wowsunpack` once (any one method):

```bash
# Option A: prebuilt binary (Windows) — download from
#   https://github.com/landaire/wows-toolkit/releases/latest
#   (look for wows_toolkit_tools_<platform>.zip), then put wowsunpack.exe on PATH
#   or set WOWSP_WOWSUNPACK=/path/to/wowsunpack.exe

# Option B: from crates.io
cargo install wowsunpack

# Option C: from source
cargo install --git https://github.com/landaire/wows-toolkit wowsunpack
```

The game install is auto-detected the same way WoWSP's desktop shell does it
(Windows registry + Steam `appmanifest_552990.acf`). Override with
`WOWSP_GAME_PATH` if needed.

## Scripts

| Script | wowsunpack subcommand | Output |
|---|---|---|
| `convert_ship.py` | `export-ship` | `GLB` under `packages/webui/src/res/models/ships/` |
| `convert_map.py` | `export-map` | `GLB` under `packages/webui/src/res/models/maps/` |

## Usage

```bash
# Convert one ship by display name (fuzzy-matched) or model dir name
just convert-model ship --name Montana --output ships/
just convert-model ship --name USA001_Montana_1945 --hull B

# Convert one map/space by its internal id
just convert-model map --name 15_NE_north --output maps/

# Or run directly
python scripts/model_convert/convert_ship.py --name Montana
python scripts/model_convert/convert_map.py --name 15_NE_north
```

Run `--help` on either script for all flags (LOD, hull selection, terrain
decimation, texture downsampling — all forwarded to `wowsunpack`).

## Baking (low-poly holographic GLBs)

`bake_model.py` simplifies a high-poly exporter GLB down to a small low-poly
GLB (~60–150 KB) for the holographic viewer, using vertex-clustering
decimation that keeps surfaces continuous. `batch_bake.py` runs the full
export→bake pipeline for every playable ship.

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

1. Make sure `wowsunpack` is installed and the game is detected (run WoWSP once
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
# Requires the patched wowsunpack (below). One map at a time:
just convert-map-holo --name 18_NE_ice_islands
just convert-map-holo --name 15_NE_north

# Or directly (set the patched binary path):
WOWSP_WOWSUNPACK=target/model-tools-patched/wowsunpack.exe \
  python scripts/model_convert/convert_map_holo.py --name 18_NE_ice_islands
```

### Why a patched wowsunpack?

Stock `wowsunpack export-map` clamps terrain to sea level (Y ≥ 0) and culls
fully-submerged triangles — so sea-floor bathymetry and trenches (where
submarines operate) are discarded before the GLB is written. The raw
`terrain.bin` heightmap *does* contain negative depths; the exporter just
throws them away with no flag to disable it.

WoWSP's fork ([`langyo/wows-toolkit`](https://github.com/langyo/wows-toolkit))
adds a `--keep-submerged` flag that skips both the clamp and the cull, so
below-sea-level geometry exports as real negative-Y vertices. Build it once:

```bash
just build-wowsunpack-patched
```

This clones the fork into `../wows-toolkit-patched`, builds it with the stable
Rust toolchain (~2 min), and copies the binary to
`target/model-tools-patched/wowsunpack.exe`. `convert_map_holo.py` auto-detects
and uses it. The script also degrades gracefully: if only the stock
`wowsunpack` is available it retries without `--keep-submerged`, so islands +
land contours still work (just without trench depth).

The frontend renders the contour terrain via `holoContourShader.ts` — land is
banded by elevation, shallow sea teal, and deep trenches deep-blue with the
densest contour lines.

## Status

Working orchestrators. The actual format decoding is `wowsunpack`'s job; these
scripts add WoWSP-specific game detection, output placement, and friendly CLI.
