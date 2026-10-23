# scripts/e2e — Playwright e2e harness (scaffolding only)

## Status: 0 test cases

This directory is a **harness**, not a test suite. There is no `test_*.py` here,
nothing is collected by pytest, and no CI job runs it. The former e2e cases
were deleted in `79f9a1c3` ("Land full UI shell, encyclopedia, stats, replay,
and dev test harness"); the fixtures, shared constants and page-object package
survived, which makes the directory *look* covered while it proves nothing.

Do not treat this directory as evidence that the webui is browser-tested.
The test pyramid currently is: Rust unit/integration tests, webui vitest
(happy-dom), and the Tauri visual suite under `scripts/visual` (screenshot
regression against a running app). Playwright is the only layer that would
drive the real WebView2 browser, and that layer is empty.

## What is here

- `conftest.py` — session fixtures that start the FastAPI mock backend
  (`scripts/mock`) on a free port: `mock_port`, `mock_url`. The Playwright
  `page` fixture comes from the `pytest-playwright` plugin (listed in
  `scripts/requirements.txt`) — this file does not point it at a server yet.
- `shared.py` — host/timeout constants and the `Method` command-name mirror of
  `packages/webui/src/rpc.ts`.
- `helpers/page_objects/` — empty package; page objects are meant to live here
  so tests stay declarative.
- Pytest config: `scripts/pyproject.toml` (`testpaths` includes `e2e`,
  `-m ui` marker, `pythonpath = [".", "e2e", "visual"]`).
- Runner: `just test e2e` → `python -m pytest scripts/e2e -c scripts/pyproject.toml -m ui`.
  It collects **0** tests today.

## Why it is empty

The webui was rewritten around the Tauri IPC surface and its in-browser
development mode (`just dev mock`) after the original e2e pass; the mock
backend paths the old cases asserted no longer match the current shell, so the
cases were removed rather than kept green-by-accident. Nobody has re-added the
first deterministic case since. Wiring a browser suite into CI needs a dev
server + mock backend lifecycle to be owned by a workflow, which is a separate
piece of work.

## Adding the first case

1. Install the toolchain: `just e2e-setup` (`pip install -r scripts/requirements.txt`
   + `python -m playwright install chromium`).
2. Start the browser-only dev stack: `just dev mock` (FastAPI mock backend plus
   the Vite dev server; no game client is involved — see AGENTS.md §0, the e2e
   layer must never launch the game).
3. Add a `base_url` fixture (or `--base-url` in the pytest invocation) pointing
   at the Vite dev server, and one `page`-using test, e.g.
   `scripts/e2e/test_smoke.py`:
   ```python
   import pytest

   @pytest.mark.ui
   def test_shell_renders(page, base_url):
       page.goto(base_url)
       page.wait_for_selector("[data-testid='app-shell']")
   ```
4. Put reusable selectors/actions in `helpers/page_objects/` (one class per
   screen, Playwright `Page` wrapped behind domain methods).
5. Run it: `just test e2e`. Only after the case is deterministic locally, add a
   CI job that starts `just dev mock` and the Playwright browsers — do not mark
   the CI job required while the suite is empty.

## Rules

- Never launch the game client, Steam, or any process that can enter a battle
  from these tests (AGENTS.md §0). The mock backend + webui dev server are the
  whole system under test.
- Screenshot/visual behaviour belongs to `scripts/visual`; keep this suite to
  deterministic DOM/IPC-visible behaviour.
- If a case cannot run without the game, it does not belong here.
