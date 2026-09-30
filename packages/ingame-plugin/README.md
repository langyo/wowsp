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
- battle lifecycle marks, heartbeat, request/response stats bridge.

The in-game reported version is pinned at `0.1.0` by owner decision;
iteration happens in git history only.

## The in-game display mode

Besides feeding the transparent overlay window, the plugin can render
the stats **inside the game** (the app's 游戏内展示 view mode): two stat
tables (allies / enemies) in exact TAB order with winrate, PR and
alive-state per player, shown while Tab is held. The pieces:

- `src/WoWSPProbe.unbound` — the unbound 2 view (auto-discovered from
  `gui/unbound2/PnFMods/`), a deliberately dumb template: it watches the
  probe's single `wowspProbe.panel` data component and draws whatever
  Main.py put there (rows, texts, colors, visibility are all decided in
  Python).
- `src/WoWSPProbe.xml` — the ForgeBlueprints mount declaration
  (`res_mods/ForgeBlueprints/`), instantiating the view's root element
  in battle, click-through.
- Main.py merges the app's `response.json` stats rows into the TAB
  order (`team.ally/enemy.sortedAlive` collections) and rewrites the
  panel component whenever Tab state, ordering or alive flags change.
  No answer from the app means no panel: the transparent-overlay view
  mode simply never turns the bridge on.

## Sandbox rules the code must obey

The client executes this file under a Python 2.7 sandbox: builtins are
whitelisted (`globals`/`eval` are absent), imports are allowlisted to
the standard library (injected API modules are referenced as bare
names, never imported-and-shadowed), `open()` has no append mode, and
any exception escaping a callback kills the mod silently. The file is
intentionally conservative; see the design doc's constraints section
before touching it.

## Layout

```
packages/ingame-plugin/
  src/Main.py                    the mod (installed to PnFMods/WoWSPProbe)
  src/WoWSPProbe.unbound         in-game panel view (gui/unbound2/PnFMods)
  src/WoWSPProbe.xml             battle mount (ForgeBlueprints)
  README.md                      this file
```

`scripts/install_ingame_probe.py` (repo root `scripts/`) installs,
uninstalls and inspects it against a chosen game root; the WoWSP app's
`ingame_plugin_install` command is the production install path.
