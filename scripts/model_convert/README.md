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

## Status

Working orchestrators. The actual format decoding is `wowsunpack`'s job; these
scripts add WoWSP-specific game detection, output placement, and friendly CLI.
