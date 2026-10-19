# WoWSP In-Game Plugin (first-party)

The in-game companion mod for WoWSP's live-battle overlay, maintained
here as a first-party subpackage. Design and evidence:
[`docs/en/designs/ingame-stats-plugin.md`](../../docs/en/designs/ingame-stats-plugin.md)
(all languages under `docs/<lang>/designs/`; the design doc predates the
2026-10-19 rendering retirement described below and records the full
experiment, stats bridge included).

## What it is

A single Python file (`src/Main.py`) that runs inside the World of
Warships client through Wargaming's official **Mods API** (PnFMods
channel, `API_VERSION = 'API_v1.0'`). It observes the battle and hands
everything to the WoWSP app through flat JSON files in its own directory:

- roster + identity (`battle.getPlayersInfo()`, includes `realm`),
- sink attribution (`isAlive` flips, ≤1 s, validated against the game's
  `typeDeath` log),
- live health / relation / spotting (`dataHub.getEntityCollections` +
  `entity[CC.health]`),
- exact TAB-screen state (`input.tabModeIn/Out` SFM events) and roster
  churn (`onPlayersListUpdated`),
- battle lifecycle marks and heartbeat,
- the crosshair aim verdict (2026-10-18): per tick, the avatar entity
  whose `target` component carries a lockable-weapon bit
  (`flags & 0x35C7`, the client's own marker lock mask) is the aimed
  player — latched into telemetry (`aim`) and logged on every switch,
- `order_probe.json` — one-shot per stabilized session: the client's
  exact-order source surface (`battle.getCollection` presence, SYNCED
  collection counts, bounded `children`/`battleInfo` container samples,
  the roster's `prebattleIndex`, and any `team.<side>.sortedAlive` order
  the build exposes). Diagnostic only; no ordering consumer reads it.

The in-game reported version is pinned at `0.1.0` by owner decision;
iteration happens in git history only.

## The removed in-game rendering

The app's 游戏内展示 (in-game panel) view mode — the plugin rendering
stats tables and a crosshair mini-panel INSIDE the game through the
unbound view — was retired on 2026-10-19 together with its stats bridge
(the app no longer ships the bridge responder, and a stored
`table = "ingame"` pick migrates to the transparent-overlay mode). The
plugin side is REMOVED, not dormant:

- Main.py no longer writes `request.json`, reads `response.json`, writes
  `manual_refresh.flag`, or puts the one-shot `wowspProbe.status` data
  component — the side-channel set is exactly heartbeat / roster_raw /
  roster_journal / telemetry / order_probe.
- The unbound view (`src/WoWSPProbe.unbound`) renders ONLY the capture
  side channel's barcode strips (next section); the stats tables, the
  crosshair aim panel and their CSS/elements are cut from the file.
- The per-player stats columns and the aim panel's companion-configured
  column list died with the bridge; the aim verdict itself lives on as
  pure telemetry (`aim`: `{name, flags}` on every tick), with the
  client's lock masks (`AIM_LOCKABLE`/`AIM_MAIN_BITS`) still pinned in
  Main.py. The tool config table keeps only `panel_fade_ticks`,
  `journal_limit` and `barcode`.

Replay playback does not mount unbound battle views. The transparent
overlay's chips drop their nickname column per side when the probe's
telemetry sort keys cover every row and the realm is not CN; the name
cell returns on partial coverage, a stale stream, or CN.

## The capture side channel (barcode strips)

In the overlay view mode the same unbound view renders, per side, a tiny
barcode strip (top-left ally / top-right enemy) whose rows follow the
client's own `sortedAlive` order, each row encoding that player's rank
in the telemetry `rosterOrder` — the overlay's capture pipeline decodes
the blocks back into exact per-row attribution (see the design doc for
the frozen geometry/encoding contract and the decoder spec). The strip
is gated by the probe's wowsp.toml `barcode` key: the overlay watcher
declares `barcode = 1` when it starts, and the probe re-reads the table
at every battle start.

## Sandbox rules the code must obey

The client executes this file under a Python 2.7 sandbox: builtins are
whitelisted (`globals`/`eval` are absent), imports are allowlisted to
the standard library (injected API modules are referenced as bare
names, never imported-and-shadowed), `open()` has no append mode, and
any exception escaping a callback kills the mod silently. The file is
intentionally conservative; see the design doc's constraints section
before touching it.

## Testing discipline

Game-client testing is governed by `AGENTS.md` §0: static analysis
first. A live or replay session needs explicit per-action developer
permission, must never log into a live match, and any `res_mods/`
files installed for the test must be restored to their previous state
afterwards.

## Layout

```
packages/ingame-plugin/
  src/Main.py                    the mod (installed to PnFMods/WoWSPProbe)
  src/WoWSPProbe.unbound         unbound view (barcode strips only; the in-game rendering is removed)
  README.md                      this file
```

`scripts/install_ingame_probe.py` (repo root `scripts/`) installs,
uninstalls and inspects it against a chosen game root; the WoWSP app's
`ingame_plugin_install` command is the production install path.
