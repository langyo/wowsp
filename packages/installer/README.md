# installer

WoWSP's installer configuration — a shun manifest and its document
sources. There is no installer code in this repository anymore: the
published artifacts are built by the
[shun](https://github.com/celestia-island/shun) CLI from
`shun.toml.template` (version-stamped by `scripts/build_installers.py`),
rendering shun's own shell — hikari webview wizard, egui degrade face,
TUI, headless lane, ten-locale license flow — against the WoWSP payload.

```
shun.toml.template   ← the manifest (product, install, webview2, licenses, variants)
licenses/            ← copyright notices + vendored SySL agreements (per locale)
logo.webp            ← caption-bar logo source
```

## Published artifacts

`shun build --variant lite|webview2` → `WoWSP_<version>_x64-installer-lite.exe`
and `WoWSP_<version>_x64-installer-webview2.exe`:

- **lite** — the bare application; the model pack downloads on demand.
- **webview2** — the complete build: model pack, dog-tag art, and the
  Evergreen offline WebView2 runtime (silently installed on runtime-less
  machines; the egui degrade face warns and links Microsoft's official
  download page otherwise).

The build script also publishes `WoWSP_<version>_x64-installer.exe` (no
suffix) as a byte-identical copy of lite. The name is not a flavor — the
materials-only plain installer it once named is retired — but every
updater older than v0.3.1 resolves every update to exactly that bare
name, so it must ride every release or those installs strand mid-update
(they fetch it from `releases/latest/download` on GitHub and the
mirrors). One such bridge update lands them on a client that fetches
`-lite` for good.

## Who does what

- The **installer** (shun) delivers files, registers ARP/uninstall,
  applies shortcuts, honors the updater's `--silent --dir
  --shortcut-menu/--shortcut-desktop` contract, and relaunches the app
  after unattended updates (`launch-after-install = "always"`).
- The **app** publishes the shipped resource pack into its cache root on
  first launch (`packages/app/tauri/src/resource_pack.rs` — the
  transactional relocation that used to live in the old installer shell),
  stamps `.res-version.json`, and drops the bootstrap `webview2/`
  subtree.
- The **updater** (`packages/app/tauri/src/commands/update.rs`) keeps
  fetching the `-lite` artifact and spawning it silently.

## Building

```
just build installers            # or: python scripts/build_installers.py
```

The script needs a shun checkout — env `SHUN_REPO` (release CI checks
the pinned `SHUN_TAG` out into `shun/`) or `--shun-repo <path>` for a
local build; it never clones on its own. See
`scripts/build_installers.py` and the release workflow for the exact
invocation.
