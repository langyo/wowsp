# scripts/e2e — Playwright e2e suite

## Status: 5 files / 14 cases, wired into CI

The browser layer is no longer empty: deterministic layout-contract cases
drive the real webui through the FastAPI mock backend, and the
`E2E browser (ubuntu)` job in `ci.yml` runs the whole `-m ui` suite on
every dispatched CI run (the repo's workflows are `workflow_dispatch`-only;
the Mod Hub Sync digest lane is the routine trigger, so regressions like
the 2026-11-11 settings-floor conflict surface within hours).

- `test_settings_layout.py` — the desktop settings modal's content-fit
  frame contract: per-section shell height `max(floor, content)` (the
  24rem floor from #1940 reconciled with the 2026-11-08 content-fit fix),
  the capped-frame scroll ownership, and the frozen size-morph probe's
  frame-drop == shell-drop tell.
- `test_results_layout.py` — the post-battle window's frames.
- `test_chat_layout.py` — the chat frame.
- `test_live_roster.py` — the live roster surfaces (5 cases).
- `test_ui_shell.py` — the shell smoke cases (3).

All cases run against the mock backend only — no game client is ever
involved (AGENTS.md §0).

## Layout

- `conftest.py` — session fixtures: starts the FastAPI mock backend
  (`scripts/mock`) and the Vite dev server on free ports, hands tests a
  Playwright `page` pointed at the dev server.
- `shared.py` — host/timeout constants and the `Method` command-name
  mirror of `packages/webui/src/rpc.ts`.
- `helpers/page_objects/` — page-object package (kept for the cases that
  want declarative accessors).
- Pytest config: `scripts/pyproject.toml` (`testpaths` includes `e2e`,
  `-m ui` marker, `pythonpath = [".", "e2e", "visual"]`).

## Running locally

```sh
just test e2e          # = python -m pytest scripts/e2e -c scripts/pyproject.toml -m ui
```

Needs the `scripts/requirements.txt` deps (pytest, pytest-playwright,
pytest-timeout) and a `playwright install chromium` matching the pin.
First run pays the dev-server boot (~2 min for the whole suite; the
settings file alone ~1 min).
