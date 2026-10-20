# game-assets

WoWSP's game-asset library and CLI — an in-tree fork of
[landaire/wows-toolkit](https://github.com/landaire/wows-toolkit)'s
`wowsunpack` crate (declared WoWSP-owned 2026-10; flattened from the old
`packages/tools/wowsunpack-vendor` wrapper the same month), renamed and
maintained as a first-party tool package. There is no upstream sync:
bumps and fixes here are WoWSP's own decisions; upstream commits are
reference, not authority. Sources keep their historical formatting
(`.rustfmt.toml`) — exempt from the root fmt/clippy gates — and the
upstream MIT licensing (`LICENSE`, also in `../game-assets-core/`).

What it provides:

- `game_assets::vfs` — the idx/pkg VFS over a game install
  (`vfs-mmap` feature: memory-mapped pkg source)
- `game_assets::game_params` — GameParams parsing (pickle → params),
  vehicle/hull/mount model
- `game_assets::models` — `.geometry` / `.visual` / `assets.bin`
  parsers, ship GLB export (`export::ship`), armor export
- `game_assets::export::ship` — the ship-export API
  `packages/tools/model-exporter` drives
- the `game-assets` binary (`bin` feature) — the extraction/export CLI
  the Python scripts drive (`game-assets game-params`,
  `export-model`, `export-ship`, `export-armor-glb`, `extract`, …)

Its companion `../game-assets-core/` holds the shared domain types
(`wows-core` upstream). Both are workspace members of the repo root and
inherit their external dependencies from the root
`[workspace.dependencies]`.

`game_versions.toml` here doubles as the build.rs workspace-root marker
for optional test-build discovery (`WOWS_GAME_DATA` env or a `game_data/`
registry — irrelevant to normal builds).

Working rules for agents: see this directory's `AGENTS.md` and the
repository-root `AGENTS.md`.
