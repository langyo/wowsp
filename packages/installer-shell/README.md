# installer-shell

Custom installer front-end for WoWSP: a single-file Tauri shell (this
crate + `web/`) that renders the install wizard — 本机安装 / U 盘（网吧
模式）— and drives the shun install flow directly. The payload (staged
application directory, packed at build time by build.rs) is embedded in
the binary itself; `shun::targets::install` performs the delivery
(files, registry, uninstaller, shortcuts, `.portable` marker).
`scripts/build_installers.py` builds the two published flavors:

```
WoWSP_<version>_x64-installer-webview2.exe  ← app + model pack + WebView2 runtime (the complete build)
WoWSP_<version>_x64-installer-lite.exe      ← bare app; the pack downloads on demand
```

A materials-only flavor (model pack but no runtime) is intentionally not
built — the complete flavor always carries the runtime so the
WebView2-less story stays single and testable.

## WebView2

The shell is itself a Tauri app, so the WebView2 runtime is a hard
prerequisite for its own UI — but never a fatal one. The runtime check
probes with the loader's own verdict (`wry::webview_version()`, the
exact call tauri-runtime-wry gates webview creation on), so the shell's
probe can never disagree with tauri's gate; a registry-based probe used
to accept stale `pv` keys and send broken setups into tauri's English
"Could not find the WebView2 Runtime" box. On a runtime-less machine:

1. the carried Evergreen offline installer (a file beside the shell, or
   the `webview2/` subtree of the embedded payload — the `-webview2`
   flavor) runs silently (`/silent /install`, UAC-relaunched through
   PowerShell when the manifest requires elevation) and the loader is
   re-checked — gated by `[package.metadata.wowsp-installer.webview2]`
   `silent-install` (default on);
2. still missing → the native degrade notice: a locale-resolved
   message box (i18n'd across the ten wizard locales) plus Microsoft's
   official WebView2 download page — per the `warn-missing` policy
   (default on). The degraded WIZARD face (egui) is deliberately not
   hand-rolled here: shun's own shell renders it, and this crate is
   slated to converge on shun-built installers driven by a config
   manifest.

Silent runs (`--silent` / `/S`, the updater flow) stay fully headless:
no UAC prompts, no wizard — they log and continue.
