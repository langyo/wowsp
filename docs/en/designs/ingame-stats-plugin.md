# In-Game Stats Plugin — precision telemetry design

> **Status**: experiment concluded (2026-09-28); ready for implementation.
> Companion doc for the overlay: the display layer stays the transparent
> window; this plugin is the in-game data source that makes the overlay's
> ordering exact on every setup, including exclusive fullscreen.
>
> **Update (2026-10-01)**: a second view mode landed — 游戏内展示 renders
> the stats INSIDE the game through this plugin's unbound view
> (`gui/unbound2/PnFMods/WoWSPProbe.unbound` + the ForgeBlueprints mount),
> replacing this doc's "renders nothing" stance for the new `table =
> "ingame"` mode only. The overlay mode (`"detect"`) keeps the original
> data-source design below; the bridge (`commands/ingame_bridge.rs`)
> answers `request.json` only while the ingame mode is active, so the two
> displays never run at once.

## Background & goals

The live-battle overlay today infers the TAB team table's geometry by
capturing the screen (`overlay/capture.rs`, `overlay_detect.rs`) and polls
`GetAsyncKeyState(VK_TAB)` at 30 ms. This works, but:

- screen capture is the most fragile layer (DRM/capture exclusions, HDR,
  multi-DPI, windowed-vs-fullscreen quirks);
- key polling cannot tell "Tab held" from "Tab typed in battle chat";
- row order is inferred from a static roster plus sink heuristics.

An in-game mod running on Wargaming's official **Mods API** (the PnFMods
channel, no injection, no memory writes) can observe the battle state from
inside the client and hand it to WoWSP through a file bridge. The mod
renders **nothing** — the transparent overlay remains the display — so the
approach carries none of the per-game-version UI maintenance that killed
earlier "render in game" ideas.

Goal: make "mod telemetry > screen-capture inference > static order" the
priority chain for the overlay's data, keyed by a new roster mode
`"plugin"` in `overlay_config.toml`.

## What the experiment proved

Verified on Steam-ASIA 15.8.0 (build 13187581) and 360-CN 15.8.1 (build
13243917), several battles each, probe artifact at
`packages/ingame-plugin/src/Main.py` (reports itself as `0.1.0`
forever; iteration lives in git history only):

| Capability | Mechanism | Latency / notes |
| --- | --- | --- |
| Mod loads, both realms | `res_mods/<bin>/PnFModsLoader.py` (0-byte marker) + `PnFMods/<Mod>/Main.py`, `API_VERSION = 'API_v1.0'` | coexists with Aslain's mods |
| Injected API modules | `events, ui, utils, battle, callbacks, dataHub, constants` are loader-injected globals; `import` of them fails (allowlist), never shadow them | builtins are whitelisted too: no `globals()`/`eval` |
| Roster + identity | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm | records are `SafeClass`: subscripts work, dict protocol does not; iterate early-loading defensively (container is briefly non-dict) |
| Sink attribution | `isAlive` flips, polled at 1 s | validated 1:1 against the game's own `typeDeath` log lines, ≤1 s lag, across 4 battles |
| Live health & spotting | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]` (`.value/.max/.isAlive`), `entity[CC.relation]` | enemy HP stays 0/0 until spotted — same fog-of-war as the game's own table; a 0→value jump is itself a spotting event |
| TAB screen state | SFM events `input.tabModeIn` / `input.tabModeOut` | fires ≤3 ms after the key; does **not** fire for Tab-in-chat — fixes the false-positive class outright |
| Roster churn | `events.onPlayersListUpdated` | 14 events in one battle |
| Battle lifecycle | `sfm.battleLoadingStarted`, `request.showBattle`, `onBattleStart`, `up.exitBattle`, `window.hide(Battle)` | finer-grained than tempArenaInfo file appearance/removal |

**Not available** (and not needed): per-player score/XP components do not
exist on avatar entities, and the unbound-side `$datahub.getCollection()
.getChildByPath('team.ally.sortedAlive')` path has no Python-side
equivalent (`getCollection` does not exist on the injected dataHub).

**Ordering rule** (confirmed by owner experience; matches the collection
name `sortedAlive`): the TAB table keeps the initial order and only moves
sunk players into a trailing "dead" group. Therefore:

```
overlay order = arena vehicle order (tempArenaInfo — already parsed)
                with isAlive=false players re-appended in sinking order
```

is a **exact** replication, not an approximation.

## Sandbox constraints (hard-won, keep in the mod's style guide)

- Python is **2.7**; keep syntax conservative (no f-strings; the existing
  probe is intentionally 2/3-compatible).
- `open()` has **no append mode** ('a' returns None instead of raising):
  rewrite files whole from in-memory buffers.
- Missing files log an engine-side error line before raising: seed every
  polled mailbox once at load (see `manual_refresh.flag` seeding).
- Exceptions escaping a callback kill the mod silently: wrap everything,
  dedupe repeated errors before logging.
- `dir()` on the injected modules returns `[]` (SafeClass wrappers): the
  API surface is only the proven-names list above.
- Two loader channels exist: the classic unsigned PnFMods 1.0 path we use,
  and "ModsAPI 2.0" with WG signature validation (ModStation-class signed
  mods). Unsigned community mods coexist fine; signature failures of
  third-party packs are not our concern.

## Architecture

```
┌─ game client (Mods API sandbox, no network) ─────────────┐
│ PnFMods/WoWSPStats/Main.py                               │
│  · roster poll (1 s, stable-confirm) → request.json      │
│  · entity walk → telemetry (hp/relation/alive)           │
│  · SFM events → tabMode marks, lifecycle marks           │
│  · heartbeat.json (phase port/battle, 1–2 s)             │
└──────────────┬────────────────────────────────────────────┘
               │ flat JSON files in the mod's own directory
┌──────────────┴────────────────────────────────────────────┐
│ WoWSP app (Rust, existing processes)                      │
│  · bridge reader/writer (replaces the experiment probe's │
│    companion role; same request/response protocol the    │
│    third-party reference plugin established)             │
│  · ordering engine: arena order + dead-sinking           │
│  · roster mode "plugin" in overlay_config                │
│  · health check: parse profile/python.log for the mod's  │
│    load/self-check lines (api[load] dh=True …)           │
└───────────────────────────────────────────────────────────┘
```

Bridge files (protocol v1, all in the mod directory):

```jsonc
// request.json — written by the mod on a stable roster (and re-written on
// manual refresh). Companion answers with stats rows.
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json — written by WoWSP; revision must be monotonic per session;
// an empty file (no trailing newline) means "pending".
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json — rewritten every 1–2 s; stale = mod dead or game closed.
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3 }

// telemetry journal — whole-file rewrite of a bounded per-battle ring;
// every distinct state plus event marks on one timeline:
{ "t": 1690000000000, "players": { "<avatarId>": { /* projection */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag — WoWSP writes a fresh epoch-seconds stamp to trigger a
// re-query; the mod consumes it within a 10 s window.
```

## Product integration

1. **Auto-install on toggle**: enabling the in-game ordering source in
   settings writes the mod via the existing `mod_install.rs` /
   `packages/ingame-plugin` path (`PnFModsLoader.py` marker only if absent; own
   files only; snapshot + rollback; game-closed guard). Disabling
   uninstalls. This is the "special" registration behavior the owner
   specified: the plugin never appears as a manual install step.
2. **Own-repo Discussions registration**: publish a templated resource
   thread on `langyo/wowsp/discussions` and reference it from a
   `mod-index.json` entry (`category`, `discussion`, `versions[].game`
   compatibility) so the Mod Hub can also list/verify it like any other
   mod — first-party provenance, same catalog machinery (mod-hub.md gap
   G8 consent model).
3. **Fallback chain**: telemetry missing/stale (heartbeat older than N s,
   `api[load] dh=False`, game updated and the mod broke) → silently fall
   back to the current inference pipeline. The overlay never depends on
   the mod to function.

## Risks & maintenance

- **WG API drift** is now the only coupling (no unbound, no stock-element
  copies). The Mods API v1.0 surface has been stable across 13.x→15.8;
  the probe's self-check line makes breakage loud and diagnosable.
- **CN client**: verified working; the 360 client runs the same Mods API
  loader (its log scans for `PnFModsLoader.py` natively). Watch CN
  anti-cheat policy changes each major version.
- **Perf**: 1 s polling of `getPlayersInfo` + entity walk is well within
  budget (TeamHP-style mods walk entities per frame); never use
  `callbacks.perTick` for this.
- **Journal growth**: bounded ring per battle; ship segments with the
  replay if useful for post-battle analysis.

## Rust integration map (exact touch points)

| Concern | File (existing unless noted) | Change |
| --- | --- | --- |
| Bridge file watcher | `commands/arena_info.rs` sibling: new `commands/ingame_bridge.rs` | `notify`-watch the mod directory; parse heartbeat/request/journal; expose Tauri events `wowsp://ingame-*` |
| Ordering engine | new module `overlay/order_source.rs` | arena order + dead-sinking reducer fed by bridge events; emits the final row order the overlay renders |
| Config schema | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster` gains `"plugin"` (priority chain `plugin > inferred > ocr > off`) |
| Overlay key gating | `overlay/placement.rs` (`tab_key_down`) | when the bridge is live, drive show/hide from `input.tabModeIn/Out` marks instead of `GetAsyncKeyState` polling |
| Install / uninstall | `commands/mod_install.rs` + `packages/ingame-plugin/` (new subpackage) | template becomes the subpackage's `Main.py`; snapshot + rollback; game-closed guard; legacy probe cleanup |
| Health check | `commands/ingame_bridge.rs` | parse `profile/python.log` for the mod's `probe … loaded` / `api[load] dh=True` self-check lines; expose status for the settings UI |
| Stats rows | existing `wg_api.rs` / `wg_api_cn.rs` | unchanged — the companion writes `response.json` from the same batch lookup the overlay uses today |

## Test plan

- **Sandbox conformance**: every shipped `Main.py` change is validated
  against the constraints list (py2.7 parse, no blocked builtins, no
  append-mode opens, guarded callbacks) plus `python -m py_compile`.
- **Port-only smoke test** (no battle): launch the game, sit in port
  ~15 s, exit; assert `injected names=[…]`, `api[load] dh=True`, and a
  fresh heartbeat in `python.log`. This is the cheap protocol that kept
  the experiment honest — keep it as the acceptance test for installs.
- **Battle fixtures**: one co-op per realm; assert journal contains the
  roster snapshot, ≥1 sink-driven `alive` flip, tabMode marks, and that
  `typeDeath` lines in `python.log` match the flips 1:1.
- **Fallback drill**: stop the app (no companion), assert the mod's 180 s
  busy timeout recovers and the next battle still requests; corrupt the
  mod dir, assert the overlay silently falls back to inference.

## Delivery plan

- **M1** — productionize: strip the probe's discovery batteries into a
  debug flag; freeze the bridge protocol; Rust bridge + ordering engine +
  `roster = "plugin"` mode wired into the overlay store.
- **M2** — settings toggle, auto-install/uninstall, python.log health
  check, stale-fallback logic.
- **M3** — Discussions registration, catalog entry, update channel
  (template bumps ride the app release; the mod file itself changes
  rarely).
