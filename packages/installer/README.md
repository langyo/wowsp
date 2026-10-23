# installer

WoWSP's installer configuration — a shun manifest and its document
sources. There is no installer code in this repository anymore: the
published artifacts are built by the
[shun](https://github.com/celestia-island/shun) CLI from
`shun.toml.template` (version-stamped by `scripts/build_installers.py`),
rendering shun's own shell — hikari webview wizard, egui degrade face,
TUI, headless lane, ten-locale license flow — against the WoWSP payload.

```
shun.toml.template   ← the manifest (product, install, webview2, script, licenses, variants)
licenses/            ← copyright notices, vendored SySL agreements (per locale)
                       and the Microsoft DirectML notice
check-dir.dk         ← the install-location guard script (the manifest's
                       `check-dir` hook — staged into every payload at
                       installer/check-dir.dk; shun >= 0.6.30)
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

Both installer payloads also carry `DirectML.dll` beside `wowsp.exe`. The
default-on `ai` feature statically links ONNX Runtime, whose Windows
prebuilt libraries always link DirectML even though WoWSP infers on the
CPU; the DLL is a load-time import, so a machine without it (Win10 before
1903, LTSC 2019, Server, trimmed images) dies before the app starts. It
must ride **both** payloads because auto-updates always install the lite
artifact and shun swaps the whole install directory.

Both payloads also carry `installer/check-dir.dk`, the manifest's
`check-dir` hook (shun >= 0.6.30): a **fresh** install whose target
directory holds a game-client root stub (`WorldOfWarships.exe` /
`Korabli.exe` — the same identification set as the app's
`game_client.rs`) is refused before anything is written, with a
localized reason. Installing beside the game would make WoWSP's
uninstall sweep delete the game itself — two players hit exactly that.
The check never fires on upgrades (a directory already holding a WoWSP
install is an upgrade, whatever its location), so auto-updates are
never stranded. The drive-root refusal needs no manifest entry — it is
shun's built-in default guard since 0.6.30.

The build script also publishes `WoWSP_<version>_x64-portable.exe`: the
single-exe 便捷版 — a dedicated `--no-default-features --features portable`
compile of the app (no install step, no marker or file-name probing):
data lands next to the exe, the auto-updater and the 3D views stay
disabled, and the `ai` feature is compiled out entirely — the portable exe
links neither ONNX Runtime nor DirectML, so it needs no extra runtime file.
Its settings UI reports AI inference/scoring as unavailable and points at
the full installer.

The build script also publishes `WoWSP_<version>_x64-installer.exe` (no
suffix) as a byte-identical copy of lite. The name is not a flavor — the
materials-only plain installer it once named is retired — but every
updater older than v0.3.1 resolves every update to exactly that bare
name, so it must ride every release or those installs strand mid-update
(they fetch it from `releases/latest/download` on GitHub and the
mirrors). One such bridge update lands them on a client that fetches
`-lite` for good.

## Who does what

- The **installer** (shun) delivers files, guards the install location
  (shun >= 0.6.30: a bare drive root is refused outright — the default
  `forbid-drive-root` guard — and the manifest's `check-dir` hook
  vetoes a fresh install into the game folder; upgrades never
  re-veto their location), registers ARP/uninstall,
  refreshes existing shortcuts by presence (a kept launcher is updated
  in place, a deleted one is never re-created — silent updates must not
  spray `.lnk` files), honors the updater's `--silent --dir
  --shortcut-menu/--shortcut-desktop` contract, upgrades the registered
  install in place on dir-less silent runs (shun >= 0.6.26: ARP
  `InstallLocation` leads the resolution, so a silent run without
  `--dir` never relocates a custom-path install to the pinned
  default-dir), survives a lock survivor holding the install directory
  (shun >= 0.6.28: the atomic swap retries through the survivor — the
  WebView2 children a taskkilled host leaves behind keep the directory
  as their working directory — and degrades to an in-place merge when
  the lock never lifts), parks its own working directory off the
  install target (shun >= 0.6.29: an installer spawned from inside the
  install directory no longer pins its own swap), renders the
  `silent-progress` window over unattended updates (shun >= 0.6.29:
  the visible auto-update — every artifact built from this manifest
  shows its own progress, whatever frozen updater spawned it), and
  relaunches the app after unattended updates
  (`launch-after-install = "always"`).
- The **app** publishes the shipped resource pack into its cache root on
  first launch (`packages/app/tauri/src/resource_pack.rs` — the
  transactional relocation that used to live in the old installer shell),
  stamps `.res-version.json`, and drops the bootstrap `webview2/`
  subtree.
- The **updater** (`packages/app/tauri/src/commands/update.rs`) keeps
  fetching the `-lite` artifact and spawning it silently — with the
  child's working directory re-homed to the temp dir (an inherited
  install-dir CWD pins the swap target: Windows refuses to rename a
  directory any process holds as its CWD, so the installer would fight
  its own swap through shun's lock-retry window) — and exits itself
  right after the handoff, so the WebView2 children close with the app
  and never pin the install directory in the first place. The install's
  visibility is the installer's own job — the manifest's
  `silent-progress` window (shun >= 0.6.29) — never the old build's.

## Building

```
just build installers            # or: python scripts/build_installers.py
```

The script needs a shun checkout — env `SHUN_REPO` (release CI checks
the pinned `SHUN_TAG` out into `shun/`) or `--shun-repo <path>` for a
local build; it never clones on its own. See
`scripts/build_installers.py` and the release workflow for the exact
invocation.
