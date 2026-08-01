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
- [x] Pure SySL-1.0 license (Synthetic Source License, no BSL/change-date), signed langyo

## Feature milestones (dev branch)

- [ ] M1 — Real game-detection (registry + Steam), cached to `.wowsp-cache/`
- [ ] M2 — Replay header parser (8-byte magic + JSON descriptor) end-to-end
- [ ] M3 — Replay packet-stream decoder → per-entity event timeline
- [~] M4 — three.js holographic map renders one full match from a replay
- [ ] M5 — Model converters produce GLB for at least one map + a handful of ships
- [ ] M6 — Mod installer: launches WoWSP with the game, transparent overlay window
- [ ] M7 — `tempArenaInfo.json` polling → live roster in overlay mode
- [ ] M8 — Tab-triggered capture + roster re-anchoring
- [ ] M9 — Optional Wargaming stat lookup (Vortex / WG Public API)

### M4 state / known gaps

- Bottom-right minimap draws the game's own minimap art (water+land composite
  from `scripts/model_convert/extract_minimaps.py`) with ship dots projected
  via the map's *minimap* world bounds (`minimaps.json`, `(chunks-4)*100` —
  the terrain GLB rect is 2 chunks wider per side than the minimap art).
- Terrain GLBs keep real seabed depth (`wowsunpack export-map
  --keep-submerged` no longer clamps to sea level), so the contour shader's
  bathymetric bands render; a deep-sea floor plane hides the terrain edge.
- Entity z is mirrored into three.js space (`z' = -z`, yaw → `PI - yaw`) to
  match the GLBs' right-handed export; verified against terrain heights.
- vehicleId from EntityCreate/Position packets is NOT usable for roster
  matching (packet-level field is a constant, e.g. spaceId). Team roles fall
  back to entity-id spawn order; the recorder's own ship never gets the self
  tint. Proper fix needs the shipConfig prop in the EntityCreate state blob
  (per-version entity defs) or the onArenaStateReceived player list.
- Capture zones (A/B/C rings + scorebar cap status) are missing on replays
  that carry no InteractiveZone (type 14) EntityCreate — e.g. the 0.11.0
  ranked fixture. Their zones live in the BattleLogic state blob / per-version
  entity defs, or in static scenario GameParams (scenarioConfigId).
- Dock maps Dock_Kure / Dock_Fjords fail the batch map bake (non-battle maps).

Each milestone is a focused PR against `dev`. The skeleton in this repository is
the foundation for all of them — every TODO in the code points at the milestone
it belongs to.

## Known CI gaps

- cargo-deny steps are disabled: the dockerized action trips over
  rust-toolchain.toml (stable-musl fetch) and rejects deny.toml values.
  Re-enable once the action/deny.toml combo is compatible. pnpm audit still
  runs for the npm side.
