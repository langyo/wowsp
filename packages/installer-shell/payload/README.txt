Smoke payload for plain `cargo build` (CI): the installer shell embeds
whatever directory `metadata.shun.payload` — or the `SHUN_PAYLOAD` env
override — points at, so the workspace builds without the real
application binaries.

Real installer staging points `SHUN_PAYLOAD` at a directory holding the
built application (`wowsp.exe` plus anything that ships beside it), e.g.:

    SHUN_PAYLOAD=<staged-app-dir> cargo build -p wowsp_installer_shell --release
