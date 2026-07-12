"""WoWSP visual regression tests.

External Python scripts that drive a running Tauri app (built with the
`test-harness` cargo feature) via the dev-only HTTP control server. Captures
real screenshots of the live webview for visual verification.

Unlike the old frontend-bundled autoTest.ts, this code is NEVER shipped to
users — it lives entirely in scripts/ and only runs during development.
"""
