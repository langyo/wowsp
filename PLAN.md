# WoWSP Roadmap

> This file tracks the high-level plan for WoWSP (World of WarShip Panel). It is
> living documentation — update it as work lands on the `dev` branch.

## Two operating modes

WoWSP is one binary with two modes, sharing the same frontend shell and a large
chunk of the Rust backend.

### Mode 1 — Standalone review (no game running)

Goal: open a `.wowsreplay` and watch the whole match rendered on a holographic
3D map, without launching World of Warships.

- **Game install detection.** On first launch WoWSP scans the Windows Uninstall
  registry for Wargaming / Lesta / 360 publisher entries (mirroring ApeRadar's
  `ConfigWindow.AutoDetectGamePath`), then also walks Steam library folders for
  `appmanifest_552990.acf` (Steam appid 552990 = World of Warships) — the case
  ApeRadar misses. The detected path is cached under `.wowsp-cache/`.
- **Replay loading.** A `.wowsreplay` starts with an 8-byte magic
  (`{0x12, 0x32, 0x34, 0x11}`), a 4-byte little-endian length, a JSON match
  descriptor block, then an encrypted packet stream. Phase 1 reads the
  descriptor (match type, map, roster, ship ids) — the same dual-format parser
  ApeRadar's `FileUtils.ReadTempArenaInfoFile` already handles. Phase 2 decodes
  the packet stream into per-entity position/heading/time events.
- **Holographic map (three.js).** Each map's geometry is converted to GLB by
  `scripts/model_convert/convert_map.py`; each ship hull is converted by
  `convert_ship.py`. The frontend `features/holographic/` renders the scene and
  scrubs the decoded event timeline. Adding a new map or ship = drop the source
  asset into `scripts/mock/fixtures/` and re-run the converter — no app change.
- **Realm detection.** Parsed from `<game_path>/profile/clientrunner.log`
  (`Selected realm:` line) so any optional Wargaming stat lookup hits the right
  region (ru/eu/na/asia/cn), exactly like ApeRadar's `Server.AutoDetectServer`.

### Mode 2 — In-game overlay (game running)

Goal: while you play, a transparent WoWSP window overlays both teams' rosters,
visible only while `Tab` is held.

- **Mod install.** WoWSP drops a small mod file into the game's `res_mods/` that
  launches the WoWSP executable when the game process starts (and exits it when
  the game exits). The overlay window is created transparent and always-on-top.
- **Live roster.** The game writes `<game_path>/replays/tempArenaInfo.json` the
  moment a battle loads. WoWSP polls that file (same mechanic as ApeRadar) and
  immediately has both teams' player names + ship ids.
- **Tab-triggered re-anchor.** Holding `Tab` is the only time the overlay is
  visible. On each Tab press WoWSP captures the game window, runs a lightweight
  detector to locate the team-list region in the center of the screen, and
  re-positions the rendered roster to sit exactly on top of it. Release Tab and
  the overlay hides again. This keeps CPU cost near zero outside Tab presses.

## Build infrastructure (done in this scaffold)

- [x] Cargo + pnpm workspace mirroring shittim-chest's desktop subset
- [x] Tauri 2 shell with `commands/{game_detect,replay,arena_info,overlay}.rs` skeletons
- [x] Vue 3 (TSX) + UnoCSS + co-located SCSS frontend, Pinia stores, vue-i18n (en + zhs)
- [x] three.js holographic-map skeleton + `useThreeScene` rAF composable
- [x] Python model-conversion scripts (`scripts/model_convert/`) with README
- [x] FastAPI mock backend (`scripts/mock/`) so the frontend can develop without the game
- [x] Playwright e2e harness, lagrange docs (en + zhs), GitHub CI + community files
- [x] BSL-1.1 → SySL-1.0 license (Change Date 2030-01-01), signed langyo

## Feature milestones (dev branch)

- [ ] M1 — Real game-detection (registry + Steam), cached to `.wowsp-cache/`
- [ ] M2 — Replay header parser (8-byte magic + JSON descriptor) end-to-end
- [ ] M3 — Replay packet-stream decoder → per-entity event timeline
- [ ] M4 — three.js holographic map renders one full match from a replay
- [ ] M5 — Model converters produce GLB for at least one map + a handful of ships
- [ ] M6 — Mod installer: launches WoWSP with the game, transparent overlay window
- [ ] M7 — `tempArenaInfo.json` polling → live roster in overlay mode
- [ ] M8 — Tab-triggered capture + roster re-anchoring
- [ ] M9 — Optional Wargaming stat lookup (Vortex / WG Public API)

Each milestone is a focused PR against `dev`. The skeleton in this repository is
the foundation for all of them — every TODO in the code points at the milestone
it belongs to.
