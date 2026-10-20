# AGENTS.md — game-assets / game-assets-core rules

These two tool packages are WoWSP's in-repo forks of landaire's
wows-toolkit (`wowsunpack` / `wows-core`), flattened from the old
`wowsunpack-vendor` wrapper. The repository-root AGENTS.md governs
everything here except as noted below.

- Only the two library crates remain. Everything else from upstream —
  the egui desktop app, the wasm client, the collab/replay/insights
  crates, test fixtures, site, installer, screenshots, dev scripts,
  upstream CI — was removed. Do not restore peripheral infrastructure:
  these packages exist as pure dependency sources, nothing more.
- No upstream sync: dependency bumps and fixes here are WoWSP's own
  decisions; upstream commits are reference, not authority.
- The sources keep their historical formatting (`.rustfmt.toml`) and
  are exempt from the root fmt/clippy gates — do not reformat
  wholesale.
- `game_versions.toml` next to this manifest is consumed by build.rs
  for workspace-root discovery (optional test-build cfgs) — keep it in
  this directory.
- The WoWSP root workspace builds these crates as members and serves
  their `workspace = true` inheritance from the ROOT's
  `[workspace.dependencies]`.
- Commit-message rules, red lines and push rules follow the
  repository-root AGENTS.md without exception.
