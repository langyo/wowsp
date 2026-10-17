# AGENTS.md — wowsunpack-vendor rules

This tree is WoWSP's independent in-repo fork of landaire's
wows-toolkit, slimmed (2026-10) to the two library crates WoWSP
actually consumes. The repository-root AGENTS.md governs everything
here except as noted below.

- Only `crates/wowsunpack` and `crates/wows-core` remain. Everything
  else from upstream — the egui desktop app, the wasm client, the
  collab/replay/insights crates, test fixtures, site, installer,
  screenshots, dev scripts, upstream CI — was removed. Do not restore
  peripheral infrastructure: this tree exists as a pure dependency
  source, nothing more.
- No upstream sync: dependency bumps and fixes here are WoWSP's own
  decisions; upstream commits are reference, not authority.
- The sources keep their historical formatting (`.rustfmt.toml`) and
  are exempt from the root fmt/clippy gates — do not reformat
  wholesale.
- `game_versions.toml` at this root is consumed by wowsunpack's
  build.rs for workspace-root discovery — keep it next to this
  manifest.
- The WoWSP root workspace builds these crates as members and serves
  their `workspace = true` inheritance from the ROOT's
  `[workspace.dependencies]`; this directory's own table only applies
  when building from inside it. Touching a dependency means updating
  BOTH tables (see the header comment in Cargo.toml).
- Commit-message rules, red lines and push rules follow the
  repository-root AGENTS.md without exception.
