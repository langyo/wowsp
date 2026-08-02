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
- Entity -> roster join: the EntityCreate state blob embeds the ship's
  GameParams id, so `read_replay_positions` scans it against the descriptor
  roster shipIds (`EntityKind.shipId`). The packet-level `vehicleId` field is
  a per-version constant (7770/10513) and useless for joins. Duplicate
  shipIds (mirror picks, bots) are broken by spawn-side centroids in the
  frontend. Team roles and ship models resolve for every player; a
  pathological 3+-way same-ship mirror may still swap player *names* within
  the same team, never team colors.
- The recorder's own ship emits no Position (0x0a) packets; its transform
  arrives on the PlayerPosition packet instead (0x2c on current clients,
  0x2b on older ones — Monstrofil `replays_unpack` `PlayerPosition.py`). The
  decoder merges both packet ids into the entity's trajectory, so the white
  self marker/label renders like any other ship.
- Ship HP is the EntityProperty `health` field, encoded as an f32 in a 4-byte
  value (index 28 on 14.5, 29 on 0.11.x — drifting per version). The int
  properties at 20/21 look HP-ish by magnitude but are noise (they alternate
  every tick and jump +86% in one step). `detect_hp_property` scores every
  index under both int and float interpretations — plausible range, first
  sample >= 0.8 * entity max (streams open with a full-health sync), no
  single-step increase above 35% of max — and rounds float HP to u32 for the
  wire. Labels show a role-tinted HP bar plus current/max HP (absolute, no
  delta); maxHp is the entity's own stream peak (battle-accurate incl.
  event-mode scaling), never the encyclopedia's stock hull value.
- Complete offline ship-name DB: `webui/src/data/ship_names.json` (1202
  ships) baked from GameParams (id/index/level/species/nation) +
  `res/texts/<lang>/LC_MESSAGES/global.mo` (IDS_<index> -> localized name)
  by `scripts/model_convert/extract_ship_names.py`, covering all 9 WG
  languages incl. event/clone ships the WG encyclopedia misses. Labels and
  the Tab roster resolve names through encyclopedia -> offline DB -> model
  DB; tier/type icons also come from the offline DB when the encyclopedia
  lacks the ship.
- Active battle area: camera fit and the minimap use ship + capture-zone
  bounds (planes/torpedoes ignored — they roam past the border). When the
  active area covers under 70% of the map (brawls/events with a restricted
  border, e.g. a 1v1 fighting inside a 600x600 area), the minimap crops the
  game art to that region and re-projects dots instead of showing the whole
  map with dots compressed in a corner.
- Map-version drift: terrain GLBs and minimap art are baked from the current
  client, so replays from before a map rework (e.g. 2022 "North" vs 14.5)
  show tracks crossing islands. The mock fixture therefore uses a
  current-version replay. Not fixable without per-version terrain bakes.
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
