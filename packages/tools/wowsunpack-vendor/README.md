# WoWSP's vendored wowsunpack / wows-core

An independent in-repo fork of [landaire/wows-toolkit]
(https://github.com/landaire/wows-toolkit), slimmed to the two library
crates WoWSP consumes:

- `crates/wowsunpack` — game data unpacking, models, game params
- `crates/wows-core` — shared domain types and primitives

Everything else from upstream (desktop app, wasm client, collab and
replay crates, site, installer, dev tooling) was removed — this tree
is a pure dependency source. There is no upstream sync: bumps and
fixes here are WoWSP's own. The sources keep their historical
formatting and upstream MIT licensing (`LICENSE`).

Working rules for agents live in `AGENTS.md`; build wiring is
documented in the `Cargo.toml` header comment (the WoWSP root
workspace is the primary consumer).
