# Contributing to WoWSP

Thank you for your interest in contributing!

## Contribution policy

WoWSP targets correctness first — a broken replay parser or a mis-positioned
overlay directly hurts players. Please read this before opening a pull request.

- **Focused changes welcome**: bug reports, focused fixes, well-scoped
  improvements to detection / parsing / rendering, new map or ship model
  conversions, and documentation.
- **Design discussion first** for anything architectural (new modes, changing
  the replay format handling, altering the overlay interaction model).
- **CLA required** for accepted contributions. Commits must carry a
  `Signed-off-by` line (`git commit -s`).

## Development Environment Setup

See [Building](./building.md). Quick start:

```bash
git clone https://github.com/celestia-island/wowsp.git
cd wowsp
cp .env.example .env
just init
just dev --mock      # frontend + FastAPI mock, no game needed
```

## Code Style

```bash
just fmt     # Rust (cargo fmt + clippy) + TS import grouping
just lint    # fmt-check + clippy + pnpm lint
just test    # cargo test --workspace
```

- Rust: `snake_case` functions, `CamelCase` types, `workspace = true` deps.
- TypeScript: Vue 3 TSX (`defineComponent`), strict mode, Pinia stores.
- i18n: add new UI strings to both `en` and `zhs` under `res/i18n/locales/`.

## Pull Request Process

1. Branch from `dev`: `git checkout -b feat/my-feature dev`.
2. Atomic commits, [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(replay): ...`, `fix(overlay): ...`, `docs: ...`.
3. `just lint && just test` before pushing.
4. Open a PR against `dev`.

## License & CLA

WoWSP is licensed under the **Business Source License 1.1 (BUSL-1.1)** with a
**Change Date of 2030-01-01**, on which it converts to the **Synthetic Source
License (SySL-1.0)**. For all internal, academic, government, educational, and
non-commercial use it is already equivalent to SySL-1.0 today. See
[`LICENSE`](../../../LICENSE).
