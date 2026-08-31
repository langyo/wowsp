# hikari-vendor

In-tree vendor of the upstream [hikari](https://github.com/celestia-island/hikari)
component library, following the same convention as
`packages/tools/wowsunpack-vendor` (tracked in-tree, refreshed by re-copying).

## Provenance

- Upstream repo: `https://github.com/celestia-island/hikari`
- Vendored commit: `e3d695844388e9edd3db4e7ddfa7775e1669dc0d`
  (♻️ Simplify the font stacks to the Apple-style system batch. (#332))
- License: SySL-1.0 (same as WoWSP)

## What is vendored

Only the two subtrees the Vue package needs at build time — the repo's Rust
crates (WASM renderer), docs, and baselines are NOT vendored:

```
packages/vue       ← the @celestia-island/hikari package (tsx components + scss)
packages/theme     ← shared SCSS the vue styles entry @use's
```

The vue package keeps its own `pnpm-workspace.yaml` / `pnpm-lock.yaml` (standalone
dev workflow upstream); pnpm only reads the repo-root workspace file, so they are
inert here.

## How it is consumed

- `pnpm-workspace.yaml` registers `packages/hikari-vendor/packages/vue` as a
  workspace member; `packages/webui` / `packages/website` depend on it as
  `"@celestia-island/hikari": "workspace:*"`.
- Apps import styles through their own SCSS entry that `@use`s the theme
  foundation + `admin-tokens.scss` (mirroring shittim-chest's
  `hikari-chrome.scss`). Do NOT use the `hikari/styles` package export: it also
  pulls the legacy `packages/components` style aggregate whose class names
  collide with the current components.
- The `hikari/styles` export's `../../../` SCSS paths resolve fine here because
  the monorepo-relative structure (`packages/vue` + `packages/theme`) is
  preserved — but we simply don't use that entry.

## Refreshing

```bash
rm -rf packages/hikari-vendor/packages/{vue,theme}
cp -r <hikari-checkout>/packages/{vue,theme} packages/hikari-vendor/packages/
# update this file's vendored-commit line, pnpm install, typecheck, build
```
