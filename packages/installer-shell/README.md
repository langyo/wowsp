# installer-shell

Custom installer front-end for WoWSP: a small Tauri shell (this crate +
`web/`) that renders the three install modes — 本机安装 / U 盘（网吧模式）/
绿色版直接运行 — and drives the existing NSIS engine headlessly. The NSIS
template keeps every engine responsibility (files, registry, uninstaller,
shortcuts, `.portable` marker, WebView2 gate); the shell owns only the UI.

## Shipped layout

The shell is distributed side by side with its engine in one directory:

```
wowsp-installer.exe                          ← this shell
WoWSP_<version>_x64-setup-webview2.exe       ← NSIS engine, WebView2 bundled (preferred)
WoWSP_<version>_x64-setup.exe                ← NSIS engine, standard
MicrosoftEdgeWebView2RuntimeInstallerX64.exe ← optional, offline WebView2 for the shell itself
```

`find_setup_exe` prefers the `-setup-webview2` variant and falls back to the
plain `-setup` artifact produced by `cargo tauri build --bundles nsis` /
`scripts/build_installers.py`.

## Engine contract

`installer/installer.nsi` accepts `/MODE=local|usb|green` for silent (`/S`)
runs, mapping onto the interactive mode page (passive/`/P` and updater
`/UPDATE` flows still force local mode). The shell always passes `/D=<dir>`
as the LAST argument, unquoted even when the path contains spaces (`raw_arg`,
per the NSIS command-line quirk). Exit status is surfaced to the UI.

Portable modes (usb / green) make the engine write the `.portable` marker;
the app then keeps all writable data next to the exe and disables in-app
updates. The shell never writes app state itself.

## WebView2

The shell is itself a Tauri app, so it pre-flights the WebView2 runtime
before creating any window (registry check identical to installer.nsi):

1. runtime present → straight to the UI;
2. missing + `MicrosoftEdgeWebView2RuntimeInstallerX64.exe` next to the
   shell → run it silently (`/silent /install`, UAC-relaunched through
   PowerShell when the manifest requires elevation) and re-check;
3. still missing → native message box (no WebView needed) + open the
   releases page, then exit.

Pairing the shell with the `-setup-webview2` engine plus the offline
payload gives a fully offline installer story on clean machines.
