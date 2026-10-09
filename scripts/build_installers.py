#!/usr/bin/env python3
"""Build the WoWSP installers with the shun CLI.

WoWSP ships no custom installer shell: the published artifacts are built
by `shun build` (https://github.com/celestia-island/shun) from
``packages/installer/shun.toml.template`` against a staged, self-contained
tree. This script assembles that tree and drives the CLI.

Staging layout (``target/installer-stage/``), entirely relative-path
driven from the rendered manifest:

    shun.toml              ← template + __WOWSP_VERSION__ substituted
    logo.webp              ← product logo for the shell chrome
    licenses/              ← copyright notices + SySL agreements (10 locales)
    telemetry/             ← per-locale telemetry notices (from docs/)
    payload-lite/          ← wowsp.exe + wowsp-flavor.txt
    payload-webview2/      ← + models/ dogtags/ res stamp + webview2 runtime

Flavor split (the two build flavors, three published artifacts):

    - ``webview2`` — the complete build: application + the current 2D/3D
      model pack + the Evergreen offline WebView2 runtime. An install never
      touches the network for resources and survives machines without the
      WebView2 runtime (the shell silently runs the carried runtime and,
      failing that, degrades to its egui face).
    - ``lite`` — the bare application, NO model pack: most features work
      out of the box and the pack downloads on demand (Settings → cache
      management, or automatically on the first 3D view). The app's
      updater always picks the ``-lite`` artifact.

The legacy ``WoWSP_<version>_x64-installer.exe`` name (no flavor suffix)
stays published as a byte-identical copy of lite. The materials-only
plain installer it once named is retired, but every updater older than
v0.3.1 — v0.1.0/v0.2.0 unconditionally, v0.3.0 on a non-lite flavor —
resolves every update to exactly that bare name under
``releases/latest/download``; once a release stops carrying it those
installs 404 on their download and strand. One bridge update lands them
on a modern client that fetches ``-lite`` for good, so the alias simply
rides every release (it costs one extra copy of the small lite
artifact). The ``-webview2`` name is fresh-install only: no updater has
ever fetched it.

The shun checkout: pass ``--shun-repo`` or set ``SHUN_REPO`` (release CI
checks the pinned tag out into ``shun/`` and exports it). The CLI builds
shun's own shell with our manifest embedded; the first run is a full
cargo build of that workspace, later runs are incremental.

Artifacts land in ``target/release/bundle/installer/`` as
``WoWSP_<version>_x64-installer-webview2.exe``,
``WoWSP_<version>_x64-installer-lite.exe`` and the legacy alias
``WoWSP_<version>_x64-installer.exe``.

The Evergreen offline runtime (~180 MB) is cached under
``packages/installer/vendor/`` (gitignored).

    python scripts/build_installers.py [--skip-app-build] [--flavors ...] \
        [--shun-repo <path>]
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
MODELS = REPO / "packages" / "webui" / "src" / "res" / "models"
IMAGES = REPO / "packages" / "webui" / "src" / "res" / "images"
INSTALLER = REPO / "packages" / "installer"
VENDOR = INSTALLER / "vendor"
WV2_URL = "https://go.microsoft.com/fwlink/?linkid=2099617"
WV2_NAME = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
WV2_PAYLOAD_PREFIX = "webview2"
TARGET = REPO / "target" / "release"
OUT = TARGET / "bundle" / "installer"
STAGE = REPO / "target" / "installer-stage"
# Default shun source for local builds: a sibling checkout. CI points
# SHUN_REPO at the tag it checks out.
DEFAULT_SHUN_REPO = REPO.parent / "shun"

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

# Wizard locales → the telemetry document's docs/ language directory
# (de/pt have no localized page yet — they read the English one).
TELEMETRY_LOCALES = [
    ("en", "en"),
    ("zh-Hans", "zh-CN"),
    ("zh-Hant", "zh-TW"),
    ("ja", "ja"),
    ("ko", "ko"),
    ("ru", "ru"),
    ("fr", "fr"),
    ("es", "es"),
    ("de", "en"),
    ("pt", "en"),
]
# shun::license_sysl's locale → sysl-repo i18n directory mapping
SYSL_I18N_DIRS = {
    "zh-Hans": "zhs",
    "zh-Hant": "zht",
    "ja": "ja",
    "ko": "ko",
    "fr": "fr",
    "ru": "ru",
    "es": "es",
    "de": "de",
    "pt": "pt",
}
SYSL_REPO = "celestia-island/sysl"
SYSL_BRANCH = "master"


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
    """(treeSha256, publishedAt) the installer ships beside the pack, so
    the app's first-launch publication treats it as current instead of
    re-downloading; empty strings when the manifest is unreachable."""
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


def fetch_sysl_agreements(stage: Path) -> None:
    """Stage the SySL agreement per locale: fresh from the sysl repo when
    the network allows (matching the old installer-shell build), the
    vendored copy otherwise — a build must never fail over a translation."""
    licenses = stage / "licenses"
    licenses.mkdir(parents=True, exist_ok=True)
    for locale in ["en"] + list(SYSL_I18N_DIRS):
        vendored = INSTALLER / "licenses" / f"{locale}.txt"
        dest = licenses / f"{locale}.txt"
        if locale == "en":
            url = f"https://raw.githubusercontent.com/{SYSL_REPO}/{SYSL_BRANCH}/LICENSE.txt"
        else:
            i18n = SYSL_I18N_DIRS[locale]
            url = f"https://raw.githubusercontent.com/{SYSL_REPO}/{SYSL_BRANCH}/i18n/{i18n}/LICENSE.txt"
        text = None
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers={"User-Agent": "wowsp-installer-build"}),
                timeout=20,
            ) as resp:
                text = resp.read().decode("utf-8")
            print(f"[license] fetched SySL {locale} from upstream")
        except Exception as exc:
            print(f"[license] SySL {locale} fetch failed ({exc}); using vendored copy")
        if text is None:
            if not vendored.is_file():
                sys.exit(f"no SySL agreement for {locale}: fetch failed and no vendored copy")
            text = vendored.read_text(encoding="utf-8")
        dest.write_text(text, encoding="utf-8", newline="")


def stage_documents(stage: Path, version: str) -> None:
    """Render the manifest and stage every document it references."""
    # Manifest: version-stamped template.
    manifest = (INSTALLER / "shun.toml.template").read_text(encoding="utf-8")
    if "__WOWSP_VERSION__" not in manifest:
        sys.exit("shun.toml.template lost its __WOWSP_VERSION__ placeholder")
    (stage / "shun.toml").write_text(
        manifest.replace("__WOWSP_VERSION__", version), encoding="utf-8", newline=""
    )
    shutil.copy2(INSTALLER / "logo.webp", stage / "logo.webp")

    # Copyright notices (product-owned, vendored per locale).
    licenses = stage / "licenses"
    licenses.mkdir(parents=True, exist_ok=True)
    for src in sorted((INSTALLER / "licenses").glob("copyright-*.txt")):
        shutil.copy2(src, licenses / src.name)

    fetch_sysl_agreements(stage)

    # Telemetry notices: the canonical docs/<lang>/license pages.
    telemetry = stage / "telemetry"
    telemetry.mkdir(parents=True, exist_ok=True)
    for locale, doc_lang in TELEMETRY_LOCALES:
        src = REPO / "docs" / doc_lang / "license" / "usage-telemetry.md"
        if not src.is_file():
            sys.exit(f"telemetry document missing for `{locale}`: {src}")
        shutil.copy2(src, telemetry / f"{locale}.md")


def stage_payload(stage: Path, app_exe: Path, variant: str) -> Path:
    """Assemble one variant's payload directory."""
    payload = stage / f"payload-{variant}"
    shutil.rmtree(payload, ignore_errors=True)
    payload.mkdir(parents=True)
    shutil.copy2(app_exe, payload / app_exe.name)
    # Diagnostic flavor marker beside the app (the updater picks -lite
    # regardless — this is the wizard's identity line + older builds).
    (payload / "wowsp-flavor.txt").write_text(variant, encoding="utf-8", newline="")
    print(f"[stage] payload-{variant}: {payload} ({app_exe.name})")
    return payload


def stage_res(payload: Path, tree: str, version: str) -> None:
    """Stage the resource pack (models + dog-tag art) and its stamp file.

    The app's first-launch pass (resource_pack.rs) publishes these trees
    into its cache root and stamps it with wowsp-res-stamp.json — the
    stamp ships as a plain payload file, no installer code involved."""
    shutil.copytree(MODELS, payload / "models")
    dogtags = REPO / "packages" / "webui" / "src" / "res" / "dogtags"
    if dogtags.is_dir():
        shutil.copytree(dogtags, payload / "dogtags")
        print(f"[stage] dog-tag art: {payload / 'dogtags'}")
    if tree:
        stamp = {"treeSha256": tree, "version": version}
        (payload / "wowsp-res-stamp.json").write_text(
            json.dumps(stamp), encoding="utf-8", newline=""
        )
        print(f"[stage] res stamp: tree {tree[:12]}…")
    print(f"[stage] model pack: {payload / 'models'}")


def stage_webview2(payload: Path, wv2: Path) -> None:
    """Copy the offline runtime into the payload under ``webview2/`` — the
    prefix shun's Evergreen bootstrap extracts and runs silently."""
    dest = payload / WV2_PAYLOAD_PREFIX
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(wv2, dest / WV2_NAME)


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


def resolve_shun_repo(explicit: str | None) -> Path:
    repo = Path(explicit or os.environ.get("SHUN_REPO") or DEFAULT_SHUN_REPO)
    if not (repo / "Cargo.toml").is_file() or not (repo / "shell").is_dir():
        sys.exit(
            f"no shun checkout at {repo} — pass --shun-repo <path> or set SHUN_REPO "
            "(release CI checks the pinned tag out into `shun/`)"
        )
    return repo


def build_variant(
    shun_repo: Path, stage: Path, variant: str, out_name: str
) -> Path:
    """Drive `shun build` for one variant and collect the artifact under
    its published name."""
    print(f"[installer:{variant}] shun build --variant {variant} …")
    env = {
        **os.environ,
        # The multi-hundred-MB embedded payload defeats LTO (the link step
        # fail-fasts with STATUS_STACK_BUFFER_OVERRUN under thin LTO) and
        # gains nothing from it; skip LTO and any rustc wrapper cache.
        "CARGO_PROFILE_RELEASE_LTO": "off",
        "RUSTC_WRAPPER": "",
    }
    subprocess.run(
        [
            "cargo", "run", "--release",
            "--manifest-path", shun_repo / "Cargo.toml",
            "-p", "shun",
            "--", "build",
            "--manifest", stage / "shun.toml",
            "--variant", variant,
            "--out", stage / "out",
            # Artifacts are published unsigned (--no-sign): release CI
            # uploads them as-is, and a local build has no signing config.
            "--no-sign",
        ],
        check=True,
        env=env,
        # The shun CLI resolves its default `shell/` (and its target
        # dir) against the INVOKING directory — pin it to the shun
        # checkout or a wowsp-root invocation cannot find a shell.
        cwd=shun_repo,
    )
    produced = list((stage / "out").glob(f"wowsp-*-{variant}*.exe"))
    if len(produced) != 1:
        sys.exit(
            f"expected exactly one shun artifact for `{variant}`, found: "
            f"{[p.name for p in produced]}"
        )
    OUT.mkdir(parents=True, exist_ok=True)
    artifact = OUT / out_name
    shutil.copy2(produced[0], artifact)
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
        default="webview2,lite",
        help="comma list of artifacts to build: webview2, lite "
        "(the webview2 flavor carries the model pack and the WebView2 "
        "runtime; lite downloads the pack on demand)",
    )
    ap.add_argument(
        "--shun-repo",
        default=None,
        help="path to a shun checkout to build with (default: $SHUN_REPO, "
        "else a sibling checkout at ../shun)",
    )
    args = ap.parse_args()

    variants = [f.strip() for f in args.flavors.split(",") if f.strip()]
    unknown = [f for f in variants if f not in ("webview2", "lite")]
    if unknown:
        sys.exit(
            f"unknown flavor(s): {', '.join(unknown)} — expected webview2, lite"
        )

    version = app_version()
    shun_repo = resolve_shun_repo(args.shun_repo)

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

    # The res-latest stamp shipped beside the pack (empty when GitHub is
    # unreachable — the app then re-downloads as usual).
    res_tree, res_version = res_stamp()

    # The Evergreen download is only needed when the webview2 flavor builds.
    wv2 = ensure_payload() if "webview2" in variants else None

    # Stage the self-contained tree, then build each variant.
    shutil.rmtree(STAGE, ignore_errors=True)
    STAGE.mkdir(parents=True)
    stage_documents(STAGE, version)

    # The lite payload packs the BARE app: build it before the model pack
    # is staged, so its payload stays slim.
    if "lite" in variants:
        stage_payload(STAGE, app_exe, "lite")
        lite = build_variant(shun_repo, STAGE, "lite", f"WoWSP_{version}_x64-installer-lite.exe")
        # The legacy bare name stays live for pre-v0.3.1 updaters (see the
        # module docstring): a byte-identical copy of the lite installer.
        alias = OUT / f"WoWSP_{version}_x64-installer.exe"
        shutil.copy2(lite, alias)
        print(f"[ok] {alias.name}: legacy alias of {lite.name}")

    if "webview2" in variants:
        payload = stage_payload(STAGE, app_exe, "webview2")
        ensure_models(force_fetch=args.models == "fetch")
        stage_res(payload, res_tree, res_version)
        stage_webview2(payload, wv2)
        build_variant(
            shun_repo, STAGE, "webview2", f"WoWSP_{version}_x64-installer-webview2.exe"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
