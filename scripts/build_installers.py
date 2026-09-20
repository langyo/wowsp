#!/usr/bin/env python3
"""Build the WoWSP shun installer artifacts.

1. Build the application and stage its executable as the installer payload.
2. Build the installer shell once per variant with ``SHUN_PAYLOAD`` pointing
   at the staged directory (the payload is packed into the shell binary —
   the single-file installer pattern; see packages/installer-shell/build.rs).
   Flavor split:

     - ``full`` (default) — application + the current 2D/3D model pack, so an
       install never touches the network for resources. The pack comes from a
       local bake (``packages/webui/src/res/models`` — ``scripts/fetch_models.py``
       output) when present, and is otherwise fetched ONCE from the published
       ``res-latest`` release and extracted into the same layout — which is
       what release CI does on its clean runners. The ship preview portraits
       (``wowsp-images.tar.gz``, gitignored derived downloads) are likewise
       fetched from ``res-latest`` BEFORE the webui build, because they embed
       into the app binary itself via the frontend dist.
   - ``webview2`` — the full payload with the Evergreen offline runtime
     embedded for machines without the WebView2 runtime.
   - ``lite`` — the bare application, NO model pack: most features work
     out of the box and the pack downloads on demand (Settings → cache
     management, or automatically on the first 3D view). The shell stages a
     ``wowsp-flavor.txt`` marker so the app's updater keeps picking the
     ``-lite`` artifact.

The shell's own frontend (``@wowsp/installer-web`` → ``web/dist``) is
rebuilt before the shell compiles, and the shell's codegen cache is
purged so the embedded UI is never stale — plain ``cargo build`` would
happily re-link with a previously expanded asset set.

Artifacts land in ``target/release/bundle/installer/`` as
``WoWSP_<version>_x64-installer[-webview2|-lite].exe``.

The Evergreen offline runtime (~180 MB) is cached under
``packages/installer-shell/vendor/`` (gitignored).

    python scripts/build_installers.py [--skip-app-build] [--flavors ...]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TAURI = REPO / "packages" / "app" / "tauri"
SHELL = REPO / "packages" / "installer-shell"
MODELS = REPO / "packages" / "webui" / "src" / "res" / "models"
IMAGES = REPO / "packages" / "webui" / "src" / "res" / "images"
SHELL_WEB = REPO / "packages" / "installer-shell" / "web"
SHELL_ENTRY = REPO / "packages" / "installer-shell" / "src" / "main.rs"
VENDOR = SHELL / "vendor"
WV2_URL = "https://go.microsoft.com/fwlink/?linkid=2099617"
WV2_NAME = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
WV2_PAYLOAD_PREFIX = "webview2"
TARGET = REPO / "target" / "release"
OUT = TARGET / "bundle" / "installer"
SHELL_BUILD_DIR = TARGET / "build"

# Resource-pack fetch (release CI runners hold no local bake): the published
# res-latest assets and where the one-time downloads cache themselves.
MODELS_CACHE = TARGET / "model-pack"
RES_ARCHIVE = "wowsp-res.tar.gz"
RES_MANIFEST = "wowsp-res.json"
IMAGES_ARCHIVE = "wowsp-images.tar.gz"
RES_RELEASE_API = "repos/langyo/wowsp/releases/tags/res-latest"
RES_RELEASE_DL = (
    "https://github.com/langyo/wowsp/releases/download/res-latest/"
)
RES_ASSET_URL = RES_RELEASE_DL + RES_ARCHIVE
IMAGES_ASSET_URL = RES_RELEASE_DL + IMAGES_ARCHIVE
GH_REPO = "langyo/wowsp"


def app_version() -> str:
    raw = (REPO / "package.json").read_text(encoding="utf-8")
    return json.loads(raw)["version"]


def run(cmd: list[str], **kwargs) -> None:
    print(f"[run] {' '.join(str(c) for c in cmd)}")
    subprocess.run([str(c) for c in cmd], check=True, **kwargs)


def release_asset_field(name: str, field: str) -> str:
    """One field of a res-latest asset via the release API ("" when the
    query fails — callers treat that as "unknown")."""
    try:
        out = subprocess.run(
            ["gh", "api", RES_RELEASE_API,
             "--jq", f'[.assets[] | select(.name == "{name}") | .{field}] | first // ""'],
            capture_output=True, text=True, check=True, timeout=60,
        )
        return out.stdout.strip()
    except Exception as exc:
        print(f"[warn] res-latest {name} {field} fetch failed: {exc}")
        return ""


def res_manifest() -> dict | None:
    """The res-latest wowsp-res.json manifest, fetched through gh (None on
    failure — callers treat that as "unknown")."""
    out = MODELS_CACHE / RES_MANIFEST
    out.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["gh", "release", "download", "res-latest", "--repo", GH_REPO,
         "--pattern", RES_MANIFEST, "--output", str(out)],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        print(f"[warn] res-latest {RES_MANIFEST} fetch failed — {r.stderr.strip()[:160]}")
        return None
    try:
        return json.loads(out.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[warn] res manifest unreadable: {exc}")
        return None


def res_stamp() -> tuple[str, str]:
    """(treeSha256, publishedAt) the installer stamps the shipped pack
    with, so first launch treats it as current instead of re-downloading;
    empty strings when the manifest is unreachable."""
    manifest = res_manifest()
    if not manifest:
        return "", ""
    return str(manifest.get("treeSha256", "")), str(manifest.get("version", ""))


def res_asset_meta() -> tuple[int | None, str]:
    """(expected size, expected sha256) for the res archive, from the
    manifest; the size falls back to the release API and both degrade to
    None/"" when unreachable (the download then skips its checks)."""
    manifest = res_manifest()
    size = manifest.get("assetSize") if manifest else None
    sha = str(manifest.get("assetSha256", "")) if manifest else ""
    if size is None:
        raw = release_asset_field(RES_ARCHIVE, "size")
        try:
            size = int(raw) if raw else None
        except ValueError:
            size = None
    return size, sha


def images_asset_size() -> int | None:
    raw = release_asset_field(IMAGES_ARCHIVE, "size")
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


def download_asset(url: str, archive: Path, expected: int | None,
                   expected_sha: str = "") -> None:
    """Download an asset with HTTP Range resume and a BOUNDED retry count —
    never an unbounded loop. A server that ignores the Range header answers
    200 instead of 206; that restarts the file from zero rather than
    appending a corrupted tail."""
    attempts = 5
    for attempt in range(1, attempts + 1):
        have = archive.stat().st_size if archive.exists() else 0
        headers = {"User-Agent": "wowsp-installer-build"}
        if have:
            headers["Range"] = f"bytes={have}-"
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=headers),
                timeout=120,
            ) as resp:
                resume = have > 0 and getattr(resp, "status", None) == 206
                start = have if resume else 0
                total = start + int(resp.headers.get("Content-Length", 0) or 0)
                with open(archive, "ab" if resume else "wb") as fh:
                    copied = 0
                    while True:
                        chunk = resp.read(1 << 20)
                        if not chunk:
                            break
                        fh.write(chunk)
                        copied += len(chunk)
                        if copied % (64 << 20) < (1 << 20):
                            print(f"[res] {start + copied:,} / {total or '?':,} bytes")
            size = archive.stat().st_size
            if expected is not None and size != expected:
                raise IOError(f"downloaded size {size:,} != release size {expected:,}")
            if expected_sha:
                got = _sha256(archive)
                if got.lower() != expected_sha.lower():
                    raise IOError(
                        f"sha256 mismatch: got {got[:12]}..., "
                        f"manifest says {expected_sha[:12]}..."
                    )
            return
        except Exception as exc:
            print(f"[warn] asset download attempt {attempt}/{attempts} failed: {exc}")
    sys.exit(f"asset download failed after bounded retries: {url}")


def _sha256(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def has_baked_glb() -> bool:
    """Whether MODELS holds a REAL bake. The git-tracked models subset is
    2D-only (silhouettes/minimaps, ~27 MB) and always present in a fresh
    checkout — including CI's — so directory existence proves nothing. The
    untracked bake output is what carries ships/<id>.glb, so one glb file
    discriminates bake-present from tracked-subset-only."""
    ships = MODELS / "ships"
    return ships.is_dir() and any(p.suffix == ".glb" for p in ships.glob("*"))


def ensure_models(force_fetch: bool = False) -> None:
    """Guarantee the FULL model pack exists for staging. A local bake wins
    in auto mode (glb files present — see has_baked_glb); otherwise the
    published res-latest archive is fetched once into target/model-pack and
    extracted OVER whatever the checkout holds — restoring the exact layout
    release_models.py packed (top-level ``models/`` under res/). CI passes
    ``--models fetch`` to force this even though its tracked subset exists."""
    if not force_fetch and has_baked_glb():
        print(f"[models] using local bake: {MODELS}")
        return
    MODELS_CACHE.mkdir(parents=True, exist_ok=True)
    archive = MODELS_CACHE / RES_ARCHIVE
    expected_size, expected_sha = res_asset_meta()
    reusable = archive.exists() and (
        expected_size is None or archive.stat().st_size == expected_size
    )
    if reusable and expected_sha:
        # A size match alone can hide a truncated-then-padded copy — the
        # cached archive re-verifies against the manifest hash before use.
        reusable = _sha256(archive).lower() == expected_sha.lower()
    if not reusable:
        if archive.exists():
            print("[models] cached archive failed verification — refetching")
        print(f"[models] no local bake — fetching {RES_ASSET_URL}")
        download_asset(RES_ASSET_URL, archive, expected_size, expected_sha)
    else:
        print(f"[models] reusing cached archive: {archive}")
    print(f"[models] extracting into {MODELS.parent}")
    run(["tar", "-xzf", str(archive), "-C", str(MODELS.parent)])
    if not has_baked_glb():
        sys.exit(f"model pack extraction left {MODELS} without any baked glb")


def has_ship_images() -> bool:
    """Whether the gitignored ship preview portraits are present. They are
    derived downloads (scripts/extract/download_ship_images.py), so a fresh
    checkout — including release CI's — never carries them; without the
    fetch the webui build embeds a frontend with no ship previews and the
    app binary silently shrinks ~21 MB vs a machine that has them."""
    ships = IMAGES / "ships"
    if not ships.is_dir():
        return False
    return any(
        p.name == "_index.json"
        or (p.suffix == ".png" and p.name[:1].isdigit())
        for p in ships.iterdir()
    )


def ensure_images(mode: str = "auto") -> None:
    """Guarantee the ship preview portraits exist before the webui build.

    The portraits ride publicDir into the frontend dist and the Tauri shell
    embeds the whole dist into wowsp.exe, so they must be on disk BEFORE
    ``build_app`` runs — fetching them later (like the model pack) would
    ship a portrait-less binary. Sources mirror the model pack: local files
    win in auto mode, otherwise the res-latest wowsp-images.tar.gz archive
    is fetched once and extracted over res/ (top-level ``images/``).
    ``skip`` never touches the network (offline dev builds)."""
    if mode == "skip":
        print("[images] skipped (--images skip)")
        return
    if mode == "auto" and has_ship_images():
        print(f"[images] using local portraits: {IMAGES / 'ships'}")
        return
    MODELS_CACHE.mkdir(parents=True, exist_ok=True)
    archive = MODELS_CACHE / IMAGES_ARCHIVE
    if not (
        archive.exists()
        and (images_asset_size() in (None, archive.stat().st_size))
    ):
        print(f"[images] no local portraits — fetching {IMAGES_ASSET_URL}")
        download_asset(IMAGES_ASSET_URL, archive, images_asset_size())
    else:
        print(f"[images] reusing cached archive: {archive}")
    print(f"[images] extracting into {IMAGES.parent}")
    run(["tar", "-xzf", str(archive), "-C", str(IMAGES.parent)])
    if not has_ship_images():
        sys.exit(f"portrait pack extraction left {IMAGES / 'ships'} empty")


def build_app() -> Path:
    print("[app] building webui + wowsp_tauri (release) …")
    # pnpm ships as a .cmd shim on Windows — subprocess needs the resolved
    # path (bare "pnpm" fails CreateProcess's extension-less lookup).
    pnpm = shutil.which("pnpm") or "pnpm"
    run([pnpm, "--filter", "@wowsp/webui", "build"])
    run(["cargo", "build", "-p", "wowsp_tauri", "--release"])
    exe = TARGET / "wowsp.exe"
    if not exe.is_file():
        sys.exit(f"application binary missing: {exe}")
    return exe


def build_shell_web() -> None:
    """Builds the installer shell's own frontend into web/dist.

    The shell embeds that directory at compile time (tauri's
    frontendDist), and plain `cargo build` runs no beforeBuildCommand —
    without this step the binary would carry whatever stale bundle last
    landed in web/dist."""
    print("[shell-web] building installer shell frontend …")
    pnpm = shutil.which("pnpm") or "pnpm"
    run([pnpm, "--filter", "@wowsp/installer-web", "build"])


def reset_shell_codegen() -> None:
    """Forces the shell's embedded-frontend codegen to re-expand.

    cargo's fingerprint cannot see inside the `generate_context!` proc
    macro: when only `web/dist` changed, the shell may re-link with a
    fresh payload while quietly keeping the previously expanded assets.
    Purging the build-script outputs and touching the entry source makes
    the re-expansion unconditional (verified by decompressing the emitted
    tauri-codegen-assets bundle)."""
    for path in SHELL_BUILD_DIR.glob("wowsp_installer_shell-*"):
        shutil.rmtree(path, ignore_errors=True)
    SHELL_ENTRY.touch()


def stage_payload(app_exe: Path) -> Path:
    stage = TARGET / "installer-stage"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    shutil.copy2(app_exe, stage / app_exe.name)
    print(f"[stage] payload: {stage} ({app_exe.name})")
    return stage


def stage_res(stage: Path) -> None:
    """Stage the resource pack (models + dog-tag art) into the payload. The
    shell relocates both sub-directories into the app's resource cache
    after extraction (replacing, not merging), so a fresh install ships
    with ships/maps/planes models AND the dog-tag snapshot — and existing
    caches never keep files a newer pack dropped."""
    dest = stage / "models"
    shutil.copytree(MODELS, dest)
    print(f"[stage] model pack: {dest}")
    dogtags = REPO / "packages" / "webui" / "src" / "res" / "dogtags"
    if dogtags.is_dir():
        shutil.copytree(dogtags, stage / "dogtags")
        print(f"[stage] dog-tag art: {stage / 'dogtags'}")


def build_installer(stage: Path, flavor: str = "lite",
                    res_tree: str = "", res_version: str = "") -> Path:
    print(f"[installer:{flavor}] cargo build -p wowsp_installer_shell --release …")
    env = {
        **os.environ,
        "SHUN_PAYLOAD": str(stage),
        "SHUN_FLAVOR": flavor,
        # Baked into the shell so it can stamp the relocated pack with the
        # content tree hash it was packed from (empty → no stamp, the app
        # falls back to its normal update check).
        "SHUN_RES_TREE_SHA256": res_tree,
        "SHUN_RES_VERSION": res_version,
        # The multi-hundred-MB embedded payload defeats LTO (the link step
        # fail-fasts with STATUS_STACK_BUFFER_OVERRUN under thin LTO) and
        # gains nothing from it; skip LTO and any rustc wrapper cache.
        "CARGO_PROFILE_RELEASE_LTO": "off",
        "RUSTC_WRAPPER": "",
    }
    subprocess.run(
        ["cargo", "build", "-p", "wowsp_installer_shell", "--release"],
        check=True,
        env=env,
    )
    exe = TARGET / "wowsp-installer.exe"
    if not exe.is_file():
        sys.exit(f"installer binary missing: {exe}")
    return exe


def stage_webview2(stage: Path, wv2: Path) -> Path:
    """Copy the offline runtime into the staging tree under ``webview2/`` —
    the payload-relative prefix the shell extracts it from."""
    dest = stage / WV2_PAYLOAD_PREFIX
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(wv2, dest / WV2_NAME)
    return stage


def ensure_payload() -> Path:
    VENDOR.mkdir(parents=True, exist_ok=True)
    payload = VENDOR / WV2_NAME
    if payload.is_file() and payload.stat().st_size > 100 * 1024 * 1024:
        print(f"[wv2] cached payload: {payload}")
        return payload
    print(f"[wv2] downloading Evergreen x64 offline installer ({WV2_URL}) …")
    tmp = payload.with_suffix(".part")
    # curl is dramatically faster than urllib on some Windows setups
    # (observed 10 MB/s vs 25 KB/s through the same fwlink) — prefer it.
    curl = shutil.which("curl")
    if curl:
        run([curl, "-sL", "--retry", "3", "-o", tmp, WV2_URL])
    else:
        urllib.request.urlretrieve(WV2_URL, tmp)  # follows the fwlink redirect
    if tmp.stat().st_size < 100 * 1024 * 1024 or tmp.read_bytes()[:2] != b"MZ":
        sys.exit(f"downloaded payload looks wrong: {tmp} ({tmp.stat().st_size} bytes)")
    tmp.replace(payload)
    print(f"[wv2] saved {payload.stat().st_size:,} bytes -> {payload}")
    return payload


def emit(version: str, installer: Path, suffix: str) -> Path:
    """Copies a freshly built installer into the artifact name. Called right
    after each variant's build: the second build overwrites the shared
    target/release/wowsp-installer.exe, so the bare copy must land on disk
    before the webview2 build starts."""
    OUT.mkdir(parents=True, exist_ok=True)
    artifact = OUT / f"WoWSP_{version}_x64-installer{suffix}.exe"
    shutil.copy2(installer, artifact)
    print(f"[ok] {artifact.name}: {artifact.stat().st_size:,} bytes")
    return artifact


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-app-build", action="store_true", help="reuse target/release/wowsp.exe")
    ap.add_argument(
        "--models",
        choices=("auto", "fetch"),
        default="auto",
        help="model pack source: auto uses a local bake when one is present "
        "(glb files under models/ships) and otherwise fetches the res-latest "
        "archive; fetch ALWAYS fetches-and-extracts it — what release CI "
        "passes, since its checkout holds only the tracked 2D subset",
    )
    ap.add_argument(
        "--images",
        choices=("auto", "fetch", "skip"),
        default="auto",
        help="ship portrait source: auto uses local portraits when present "
        "and otherwise fetches the res-latest wowsp-images archive; fetch "
        "ALWAYS fetches-and-extracts it — what release CI passes, since the "
        "portraits are gitignored and absent from every checkout; skip never "
        "touches the network",
    )
    ap.add_argument(
        "--flavors",
        default="full,full-webview2,lite",
        help="comma list of artifacts to build: full, full-webview2, lite "
        "(full flavors carry the model pack; lite downloads it on demand)",
    )
    args = ap.parse_args()

    flavors = [f.strip() for f in args.flavors.split(",") if f.strip()]
    unknown = [f for f in flavors if f not in ("full", "full-webview2", "lite")]
    if unknown:
        sys.exit(f"unknown flavor(s): {', '.join(unknown)} — expected full, full-webview2, lite")

    version = app_version()

    # The portraits ride publicDir into the webui dist and from there into
    # the app binary itself — they must be on disk BEFORE build_app, which
    # is why this runs unconditionally (all flavors embed the same dist).
    ensure_images(args.images)

    app_exe = TARGET / "wowsp.exe"
    if args.skip_app_build:
        if not app_exe.is_file():
            sys.exit(f"--skip-app-build but {app_exe} is missing")
        print("[app] skipped cargo build (--skip-app-build)")
    else:
        app_exe = build_app()

    # The shell's embedded UI must be rebuilt from current sources and
    # re-expanded unconditionally — see the two functions above.
    build_shell_web()
    reset_shell_codegen()

    # The res-latest stamp baked into the shell so relocated packs count
    # as current on first launch (empty when GitHub is unreachable — the
    # app then re-downloads as usual).
    res_tree, res_version = res_stamp()

    # One shared staging directory: application + full model pack; the
    # webview2 variant just adds the offline runtime subdirectory. The
    # Evergreen download is only needed when a webview2 flavor is built.
    wv2 = ensure_payload() if any(f.endswith("webview2") for f in flavors) else None

    suffixes = {
        "full": "",
        "full-webview2": "-webview2",
        "lite": "-lite",
    }

    stage = stage_payload(app_exe)
    # The lite installer packs the BARE app: build it before the model pack
    # is staged into the shared directory, so its payload stays slim.
    if "lite" in flavors:
        exe = build_installer(stage, "lite", res_tree, res_version)
        emit(version, exe, suffixes["lite"])

    full_flavors = [f for f in flavors if f != "lite"]
    if full_flavors:
        ensure_models(force_fetch=args.models == "fetch")
        stage_res(stage)
    for flavor in full_flavors:
        flavor_stage = stage
        if flavor.endswith("webview2"):
            flavor_stage = stage_webview2(stage, wv2)
        exe = build_installer(flavor_stage, flavor, res_tree, res_version)
        # Copy right after the build: the next variant overwrites the
        # shared output binary.
        emit(version, exe, suffixes[flavor])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
