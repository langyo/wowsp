# WoWSP In-Game Plugin (first-party)

The in-game companion mod for WoWSP's live-battle overlay, maintained
here as a first-party subpackage. Design and evidence:
[`docs/en/designs/ingame-stats-plugin.md`](../../docs/en/designs/ingame-stats-plugin.md)
(all languages under `docs/<lang>/designs/`).

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
- battle lifecycle marks, heartbeat, request/response stats bridge,
- `order_probe.json` — one-shot per stabilized session: the client's
  exact-order source surface (`battle.getCollection` presence, SYNCED
  collection counts, bounded `children`/`battleInfo` container samples,
  the roster's `prebattleIndex`, and any `team.<side>.sortedAlive` order
  the build exposes). Diagnostic only; no ordering consumer reads it.

The in-game reported version is pinned at `0.1.0` by owner decision;
iteration happens in git history only.

## The in-game display mode

Besides feeding the transparent overlay window, the plugin can render
the stats **inside the game** (the app's 游戏内展示 view mode): two stat
tables (allies / enemies) in the client's own TAB order — the unbound
view reads `$datahub.getCollection().getChildByPath('team.<side>.sortedAlive')`
and maps each collection entry to its panel row by avatar id; the
Python sort-key/walk order is the fallback when the collection is
absent — with winrate, PR and alive-state per player, shown while Tab is
held. The pieces:

- `src/WoWSPProbe.unbound` — the unbound 2 view, auto-discovered AND
  auto-mounted by the game from `gui/unbound2/mods/` (the folder the
  working battle views live in; a ForgeBlueprints/ manifest was tried
  first and never worked — those XMLs are installer-only metadata the
  game ignores). A deliberately dumb template: it watches the probe's
  single `wowspProbe.panel` data component and draws whatever Main.py
  put there (rows, texts, colors, visibility are all decided in
  Python).
- Main.py merges the app's `response.json` stats rows into the
  relation-walk sides (`entity_walk`: PlayerRelation.SELF/ALLY — the
  injected `dataHub` and `battle` wrapper do not forward the client's
  raw collection/`getChildByPath` API; the one-shot `order_probe.json`
  records what this build does expose) and rewrites the panel component
  whenever Tab state, ordering or alive flags change. No answer from the
  app means no panel: the transparent-overlay view mode simply never
  turns the bridge on.

The in-game panel carries player names itself, so the overlay's
nickname-column question does not apply there. Replay playback does not
mount unbound battle views; this path needs a real-battle smoke test.
The transparent overlay's chips drop their nickname column per side when
the probe's telemetry sort keys cover every row and the realm is not CN;
the name cell returns on partial coverage, a stale stream, or CN.

## The capture side channel (barcode strips)

In the overlay view mode the same unbound view renders, per side, a tiny
barcode strip (top-left ally / top-right enemy) whose rows follow the
client's own `sortedAlive` order, each row encoding that player's rank
in the telemetry `rosterOrder` — the overlay's capture pipeline will decode
the blocks back into exact per-row attribution (see the design doc for
the frozen geometry/encoding contract and the decoder spec). The strip
and the stats tables are mode-gated by the probe's wowsp.toml keys
`panel`/`barcode`: the active mode's consumer (the in-game bridge or
the overlay watcher) declares them when it starts, and the probe
re-reads the table at every battle start.

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
  src/WoWSPProbe.unbound         in-game panel view (gui/unbound2/mods)
  README.md                      this file
```

`scripts/install_ingame_probe.py` (repo root `scripts/`) installs,
uninstalls and inspects it against a chosen game root; the WoWSP app's
`ingame_plugin_install` command is the production install path.
