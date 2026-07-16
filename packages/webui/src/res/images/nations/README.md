# Nation faction emblems

These are in-game **faction crests** (not real-world national flags), one per WG
`nation` code. **Format: `.webp`** (lossless, ~40% smaller than PNG) to keep
the repo lean. The loader keys by **lowercased filename stem** and accepts
`.webp` or `.png`.

| file               | nation (WG code)  |
|--------------------|-------------------|
| `usa.webp`         | usa               |
| `japan.webp`       | japan             |
| `ussr.webp`        | ussr              |
| `germany.webp`     | germany           |
| `uk.webp`          | uk                |
| `france.webp`      | france            |
| `italy.webp`       | italy             |
| `netherlands.webp` | netherlands       |
| `spain.webp`       | spain             |
| `pan_america.webp` | pan_america       |
| `pan_asia.webp`    | pan_asia          |
| `commonwealth.webp`| commonwealth      |
| `pan_europe.webp`  | pan_europe        |
| `europe.webp`      | europe            |

`arabia` has no dedicated crest in-game; it falls back to the initial-letter
badge.

## How these were generated

Run `scripts/model_convert/extract_game_assets.py` against an unpacked game
install. It scans `gui_0001.pkg` for PNG blobs, matches them by size to the
`wowsunpack metadata` path→size map, and converts to webp via Pillow. See that
script's docstring. Source paths in the game: `/gui/nation_flag_tree/<Name>.png`.
