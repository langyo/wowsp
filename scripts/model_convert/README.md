# WoWSP model converters

These Python scripts convert World of Warships' native asset formats into GLB
files that the three.js holographic map can load. They are **offline tooling**
run on demand — never at runtime. Adding a new map or ship is a data-only
operation: drop the source asset into `fixtures/`, run the converter, commit the
GLB, and the frontend picks it up automatically.

## Scripts

| Script | Input | Output |
|---|---|---|
| `convert_ship.py` | A ship's native hull model (from `<game>/res/content/...`) | `GLB` under `packages/webui/src/res/models/ships/` |
| `convert_map.py` | A map's space/geometry data (from `<game>/res/content/space/...`) | `GLB` under `packages/webui/src/res/models/maps/` |

## Usage

```bash
# Convert one ship by path
just convert-model ship --input path/to/ship_source --output ships/

# Convert one map by path
just convert-model map --input path/to/map_space --output maps/

# Or run directly
python scripts/model_convert/convert_ship.py --input ... --output ...
```

## Status

🚧 **Skeleton**. The argument parsing, path resolution, and output scaffolding
are in place; the actual format readers (dealing with the game's proprietary
primitives, UV layouts, material hints) are TODO and will be filled in as maps
and ships are needed. Each script carries explicit TODO markers where the real
conversion logic goes.

## How to add a new map or ship (once converters are real)

1. Locate the source asset in your World of Warships install.
2. Drop it (or a copy) under `scripts/mock/fixtures/`.
3. Run `just convert-model map --input fixtures/<name> --output maps/`
   (or `ship`).
4. Commit the resulting GLB under `packages/webui/src/res/models/`.
5. The holographic map auto-discovers models from that directory — no code
   changes needed.
