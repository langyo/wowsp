# Core Concepts

> **Audience**: Developers who want a conceptual understanding of WoWSP's design.

## Two modes, one binary

WoWSP is one Tauri desktop app. The same executable runs in standalone review
mode (open a replay, watch the holographic map) or in overlay mode (transparent
window over the running game). The frontend selects the mode by route: `/replay`
vs `/overlay`.

## Data sources

| Source | Mode | What it gives WoWSP |
|---|---|---|
| `.wowsreplay` file | Review | Match descriptor (roster, map, match type) + packet stream (positions over time) |
| `tempArenaInfo.json` | Overlay | Live roster the moment a battle loads |
| `<game>/profile/clientrunner.log` | Both | Realm detection (`Selected realm:` line) |
| Windows registry + Steam manifest | Both | Game install path |
| Wargaming Public / Vortex API | Both (optional) | Per-player stats (winrate, clan, etc.) |

## Model conversion

The holographic map renders map geometry and ship hulls as GLB consumed by
three.js. The game's native asset formats are converted by Python scripts under
`scripts/model_convert/`:

- `convert_map.py` — map space data → GLB
- `convert_ship.py` — ship hull → GLB

Adding a new map or ship is a data-only operation: drop the source asset into
`scripts/mock/fixtures/`, run `just convert-model map` (or `ship`), and the
frontend picks it up. No Rust or TS changes required.

## Overlay interaction model

The overlay is invisible except while `Tab` is held. On each Tab press:

1. WoWSP captures the game window (Win32 `BitBlt`).
2. A lightweight detector locates the central team-list region.
3. The rendered roster is re-anchored to sit on top of that region.
4. On Tab release, the overlay hides again.

This keeps CPU cost near zero outside Tab presses, and re-anchors every time so
resolution / window-size changes never desync the overlay.

## Provenance

The replay-parsing, game-detection, and `tempArenaInfo.json` polling principles
are adapted from ApeRadar. The frontend shell and build infrastructure are
adapted from shittim-chest. See `LICENSE` for the BSL-1.1 → SySL-1.0 terms.
