# WoWSP In-Game Plugin (first-party)

The in-game companion mod for WoWSP's live-battle overlay, maintained
here as a first-party subpackage. Design and evidence:
[`docs/en/designs/ingame-stats-plugin.md`](../../docs/en/designs/ingame-stats-plugin.md)
(all languages under `docs/<lang>/designs/`).

## What it is

A single Python file (`src/Main.py`) that runs inside the World of
Warships client through Wargaming's official **Mods API** (PnFMods
channel, `API_VERSION = 'API_v1.0'`). It renders nothing. It observes
the battle and hands everything to the WoWSP app through flat JSON
files in its own directory:

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
  README.md                      this file
```

`scripts/install_ingame_probe.py` (repo root `scripts/`) installs,
uninstalls and inspects it against a chosen game root; the WoWSP app's
`mod_install.rs` command is the production install path.
