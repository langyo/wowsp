#!/usr/bin/env python3
"""Account for where the WoWSP installer bytes go.

WoWSP publishes four Windows artifacts per release (assembled by
scripts/build_installers.py — this script is that one's read-only
companion):

    WoWSP_<v>_x64-portable.exe            bare ``--no-default-features
                                          --features portable`` compile,
                                          no installer shell
    WoWSP_<v>_x64-installer-lite.exe      shun shell around wowsp.exe
    WoWSP_<v>_x64-installer.exe           byte-identical alias of lite
    WoWSP_<v>_x64-installer-webview2.exe  shun shell around wowsp.exe +
                                          the model pack + dog-tag art +
                                          the offline WebView2 runtime

Every one of those sizes is an accident of composition: the app binary
embeds the whole webui dist (tauri's ``generate_context!`` reads
``dist/webui`` at compile time), the webview2 payload carries a ~1.4 GB
unpacked model pack beside a ~180 MB runtime, and the shun container
re-compresses whatever it wraps. Answering "why is the full installer
734 MB" by hand means re-deriving those layers every single time — this
script does it reproducibly, per release, against any checkout:

    python scripts/analyze_installer_size.py
    python scripts/analyze_installer_size.py --repo-root ../wowsp --tag v0.6.1

Sections (each degrades to a printed note when its input is missing —
a fresh worktree has no dist/ and no target/, and that must not be an
error):

    webui dist   ``dist/webui`` by top-level dir and by extension, ship
                 portraits called out specifically (they are gitignored
                 derived downloads that only exist on machines that
                 fetched them; their absence silently shrinks the exe by
                 tens of MB — see build_installers.py ensure_images)
    app exe      the PE section table of wowsp.exe parsed with stdlib
                 struct. ``.rdata`` is where the embedded frontend lives
                 (brotli-compressed — tauri's default ``compression``
                 feature), ``.text`` the compiled code. An exe whose
                 mtime predates the newest dist file is flagged stale:
                 what is on disk is NOT what is embedded.
    model pack   ``packages/webui/src/res/models`` split into the
                 untracked 3D bake (``*.glb``) and the git-tracked 2D
                 subset (everything else), plus the top glb offenders
    dogtags      ``packages/webui/src/res/dogtags`` total
    webview2     the vendored Evergreen offline runtime
    installers   whatever ``target/release/bundle/installer`` holds
    published    release asset sizes via ``gh api`` (``--tag`` /
                 ``--published``). Metadata ONLY: this script never
                 downloads an asset, ever.
    summary      the per-flavor payload→container arithmetic, pairing
                 locally measured ingredient sizes with published or
                 locally built artifact sizes — every number labeled
                 which side it came from, because a local exe and a CI
                 exe are NOT the same bytes (the CI exe embeds the
                 fetched ship portraits; a local one may not).

``--repo-root`` exists precisely so a worktree can analyze the main
checkout (or any other machine's) without touching it: the script is
strictly read-only and its only output is stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GH_REPO = "langyo/wowsp"
MB = 1024 * 1024

# Published-asset suffixes scanned out of a release's asset list, so any
# tag works without hardcoding its version string. The bare -installer
# alias never collides with the suffixed names (nothing that ends in
# "-installer-lite.exe" also ends in "-installer.exe").
PUB_PORTABLE = "-portable.exe"
PUB_LITE = "-installer-lite.exe"
PUB_WEBVIEW2 = "-installer-webview2.exe"
RES_ARCHIVE = "wowsp-res.tar.gz"
IMAGES_ARCHIVE = "wowsp-images.tar.gz"
RES_MANIFEST = "wowsp-res.json"

# Staged payload extras (build_installers.py stage_payload/stage_res): the
# flavor marker is exactly the variant string, the res stamp a two-field
# JSON — rounded up so the byte arithmetic stays honest at MB scale. Both
# installer payloads also carry DirectML.dll (the AI build's load-time
# dependency); this is the current 1.15.4 x64 redistributable size.
DIRECTML_BYTES = 18_527_776
LITE_EXTRAS = len("lite") + DIRECTML_BYTES
WEBVIEW2_EXTRAS = len("webview2") + 128 + DIRECTML_BYTES


def fmt_bytes(n: int) -> str:
    return f"{n:,} B"


def fmt_mb(n: int) -> str:
    return f"{n / MB:.1f} MB"


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# tree scanning
# --------------------------------------------------------------------------

def scan_tree(root: Path) -> dict | None:
    """Relpath/size/mtime inventory of a directory tree (None when the
    directory is absent — callers print a note instead of failing).

    Directories that hold no file at ANY depth below them are collected
    separately: the vite build prunes the baked glb files out of the
    dist copy of models/, and an accidentally empty dir is exactly the
    kind of dead weight a size audit should surface."""
    if not root.is_dir():
        return None
    files: list[list] = []
    all_dirs: set[str] = set()
    file_ancestors: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        for name in dirnames:
            all_dirs.add(f"{rel_dir}/{name}" if rel_dir != "." else name)
        for name in filenames:
            try:
                st = (Path(dirpath) / name).stat()
            except OSError:
                continue  # temp file vanished mid-walk — skip, not fail
            rel = Path(dirpath, name).relative_to(root).as_posix()
            files.append([rel, st.st_size, st.st_mtime])
            parts = rel.split("/")
            for i in range(1, len(parts)):
                file_ancestors.add("/".join(parts[:i]))
    return {
        "files": files,
        "empty_dirs": sorted(d for d in all_dirs if d not in file_ancestors),
    }


def by_top_level(files: list[list]) -> list[dict]:
    """Sizes bucketed by first path component; root-level files (the
    html entry points, favicon set, manifests) get their own bucket."""
    agg: dict[str, list] = {}
    for rel, size, _ in files:
        key = rel.split("/")[0] if "/" in rel else "(root)"
        cell = agg.setdefault(key, [0, 0])
        cell[0] += 1
        cell[1] += size
    return [
        {"name": k, "files": v[0], "bytes": v[1]}
        for k, v in sorted(agg.items(), key=lambda kv: -kv[1][1])
    ]


def by_extension(files: list[list]) -> list[dict]:
    agg: dict[str, list] = {}
    for rel, size, _ in files:
        suffix = Path(rel).suffix.lower() or "(none)"
        cell = agg.setdefault(suffix, [0, 0])
        cell[0] += 1
        cell[1] += size
    return [
        {"ext": k, "files": v[0], "bytes": v[1]}
        for k, v in sorted(agg.items(), key=lambda kv: -kv[1][1])
    ]


def ext_census(files: list[list]) -> dict[str, int]:
    agg: dict[str, int] = {}
    for rel, _, _ in files:
        suffix = Path(rel).suffix.lower() or "(none)"
        agg[suffix] = agg.get(suffix, 0) + 1
    return dict(sorted(agg.items(), key=lambda kv: -kv[1]))


# --------------------------------------------------------------------------
# section builders (each returns a JSON-ready dict)
# --------------------------------------------------------------------------

def section_dist(root: Path) -> dict:
    dist = root / "dist" / "webui"
    scan = scan_tree(dist)
    if scan is None:
        return {"note": f"no webui dist at {dist} (build the webui first)"}
    files = scan["files"]
    total = sum(f[1] for f in files)
    newest = max(files, key=lambda f: f[2]) if files else None
    # The portraits are the one dist subtree whose presence varies per
    # machine (fetched, gitignored) — measure them explicitly.
    ships = [f for f in files if f[0].startswith("images/ships/")]
    ships_total = sum(f[1] for f in ships)
    return {
        "path": str(dist),
        "total_bytes": total,
        "total_files": len(files),
        "top_level": by_top_level(files),
        "by_extension": by_extension(files),
        "ships": {
            "files": len(ships),
            "bytes": ships_total,
            "avg_bytes": ships_total // len(ships) if ships else 0,
            "extensions": ext_census(ships),
        },
        "empty_dirs": scan["empty_dirs"],
        "newest_file": {"path": newest[0], "mtime": newest[2], "iso": iso(newest[2])} if newest else None,
    }


def pe_sections(exe: Path) -> dict | None:
    """The section table of a PE image, parsed by hand with stdlib struct
    (DOS e_lfanew at 0x3C → PE signature → COFF section count at PE+6,
    optional-header size at PE+20, 40-byte section records from
    PE+24+optSize: 8-byte name, then virtualSize / virtualAddress /
    sizeOfRawData / pointerToRawData as u32s). The file is only ever
    READ — nothing is executed, no third-party dependency is pulled in.
    Reads are seek-driven, so a padded DOS stub of any size works and a
    truncated/crafted image just comes back unparsable."""
    try:
        with open(exe, "rb") as fh:
            dos = fh.read(0x40)
            if len(dos) < 0x40 or dos[:2] != b"MZ":
                return None
            e_lfanew = struct.unpack_from("<I", dos, 0x3C)[0]
            # Real linkers keep the stub tiny; anything past a sanity
            # bound is a crafted offset aimed at unbounded reads.
            if not 0x40 <= e_lfanew <= (1 << 26):
                return None
            fh.seek(e_lfanew)
            coff = fh.read(24)
            if len(coff) < 24 or coff[:4] != b"PE\x00\x00":
                return None
            num_sections = struct.unpack_from("<H", coff, 6)[0]
            opt_size = struct.unpack_from("<H", coff, 20)[0]
            table = fh.read(opt_size + 40 * num_sections)
    except OSError:
        return None
    if len(table) < opt_size + 40 * num_sections:
        return None
    sections = []
    for i in range(num_sections):
        rec = table[opt_size + 40 * i:opt_size + 40 * (i + 1)]
        name = rec[:8].split(b"\x00", 1)[0].decode("ascii", "replace")
        vsize, _vaddr, rsize, _rptr = struct.unpack_from("<IIII", rec, 8)
        sections.append({"name": name, "virtual_size": vsize, "raw_size": rsize})
    return {
        "sections": sections,
        "raw_total": sum(s["raw_size"] for s in sections),
    }


def section_exe(exe: Path, dist_section: dict) -> dict:
    if not exe.is_file():
        return {"note": f"no app binary at {exe} (cargo build -p wowsp_tauri --release)"}
    try:
        st = exe.stat()
    except OSError as exc:
        return {"note": f"{exe} vanished before it could be measured: {exc}"}
    pe = pe_sections(exe)
    if pe is None:
        return {"note": f"{exe} exists but is not a parsable PE image"}
    out = {
        "path": str(exe),
        "bytes": st.st_size,
        "mtime": st.st_mtime,
        "iso": iso(st.st_mtime),
        "sections": pe["sections"],
        "raw_total": pe["raw_total"],
        "non_section_bytes": st.st_size - pe["raw_total"],
    }
    # Stale-embedding caveat: the frontend is baked in at COMPILE time.
    # An exe older than the newest dist file embeds an older frontend —
    # notably the ship portraits, which release CI fetches before the
    # build while a local checkout may have gained them afterwards.
    newest = dist_section.get("newest_file")
    if newest and st.st_mtime < newest["mtime"]:
        out["stale_vs_dist"] = True
        out["newer_dist_file"] = newest
    elif newest:
        out["stale_vs_dist"] = False
    return out


def section_models(root: Path) -> dict:
    models = root / "packages" / "webui" / "src" / "res" / "models"
    scan = scan_tree(models)
    if scan is None:
        return {"note": f"no model pack directory at {models}"}
    files = scan["files"]
    glbs = [f for f in files if f[0].lower().endswith(".glb")]
    two_d = [f for f in files if not f[0].lower().endswith(".glb")]
    glb_total = sum(f[1] for f in glbs)
    two_d_total = sum(f[1] for f in two_d)
    return {
        "path": str(models),
        "total_bytes": glb_total + two_d_total,
        "total_files": len(files),
        "glb": {
            "files": len(glbs),
            "bytes": glb_total,
            "avg_bytes": glb_total // len(glbs) if glbs else 0,
            # The 3D bake is the multi-GB part — the biggest single
            # files are what an optimization pass should look at first.
            "top10": [
                {"path": rel, "bytes": size}
                for rel, size, _ in sorted(glbs, key=lambda f: -f[1])[:10]
            ],
        },
        "two_d": {
            "files": len(two_d),
            "bytes": two_d_total,
            "per_dir": by_top_level(two_d),
        },
        "empty_dirs": scan["empty_dirs"],
        # has_baked_glb() in build_installers.py uses the same signal.
        "bake_present": bool(glbs),
    }


def section_dogtags(root: Path) -> dict:
    dogtags = root / "packages" / "webui" / "src" / "res" / "dogtags"
    scan = scan_tree(dogtags)
    if scan is None:
        return {"note": f"no dog-tag art at {dogtags}"}
    files = scan["files"]
    return {"path": str(dogtags), "files": len(files), "bytes": sum(f[1] for f in files)}


def section_webview2(root: Path) -> dict:
    wv2 = root / "packages" / "installer" / "vendor" / "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
    if not wv2.is_file():
        return {"note": f"no vendored WebView2 runtime at {wv2} (gitignored; build_installers.py ensure_payload fetches it)"}
    try:
        size = wv2.stat().st_size
    except OSError as exc:
        return {"note": f"{wv2} vanished before it could be measured: {exc}"}
    return {"path": str(wv2), "bytes": size}


def section_built(root: Path) -> dict:
    out_dir = root / "target" / "release" / "bundle" / "installer"
    if not out_dir.is_dir():
        return {"note": f"no local installer output at {out_dir}"}
    artifacts = []
    for p in sorted(out_dir.glob("WoWSP_*_x64-*.exe")):
        try:
            st = p.stat()
        except OSError:
            continue  # vanished mid-glob — skip, not fail (scan_tree's rule)
        artifacts.append(
            {"name": p.name, "bytes": st.st_size, "mtime": st.st_mtime, "iso": iso(st.st_mtime)}
        )
    artifacts.sort(key=lambda a: -a["mtime"])
    if not artifacts:
        return {"note": f"{out_dir} holds no WoWSP_*_x64-*.exe"}
    return {"path": str(out_dir), "artifacts": artifacts}


def gh_release(endpoint: str) -> dict:
    """One release object (tag, published_at, asset name/size list) via
    gh. Any failure — gh missing, logged out, offline, timeout — comes
    back as an ``error`` note instead of an exception, mirroring
    release_asset_field() in build_installers.py. Metadata only."""
    try:
        out = subprocess.run(
            ["gh", "api", endpoint],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
    except Exception as exc:
        return {"error": f"gh api {endpoint} failed: {exc}"}
    if out.returncode != 0:
        return {"error": f"gh api {endpoint} failed: {out.stderr.strip()[:160]}"}
    try:
        rel = json.loads(out.stdout)
    except json.JSONDecodeError as exc:
        return {"error": f"gh api {endpoint} returned unparsable JSON: {exc}"}
    return {
        "tag": rel.get("tag_name", ""),
        "published_at": rel.get("published_at", ""),
        "assets": [
            {"name": a.get("name", ""), "bytes": int(a.get("size", 0))}
            for a in rel.get("assets", [])
        ],
    }


def section_published(tag: str | None, want: bool) -> dict:
    if not want:
        return {"note": "skipped — pass --tag <tag> and/or --published to query release asset sizes"}
    release = gh_release(
        f"repos/{GH_REPO}/releases/tags/{tag}" if tag
        else f"repos/{GH_REPO}/releases/latest"
    )
    # res-latest rides alongside whichever app release was asked for: it
    # is the pack the webview2 flavor stages and the lite flavor
    # downloads on demand, so the ratio math needs its archive size.
    res_latest = gh_release(f"repos/{GH_REPO}/releases/tags/res-latest")
    return {"release": release, "res_latest": res_latest}


# --------------------------------------------------------------------------
# flavor summary arithmetic
# --------------------------------------------------------------------------

def _pub_asset(pub: dict, which: str, suffix: str) -> tuple[int | None, str]:
    """Size of the one asset whose name ends in `suffix` (None when the
    release was unreachable or carries no such asset)."""
    rel = pub.get(which)
    if not isinstance(rel, dict) or "error" in rel:
        return None, ""
    for a in rel["assets"]:
        if a["name"].endswith(suffix):
            return a["bytes"], rel.get("tag", "")
    return None, rel.get("tag", "")


def _local_artifact(built: dict, suffix: str) -> dict | None:
    """Newest locally built artifact matching the suffix (a stale one
    from an older version is still informative — its mtime is shown)."""
    arts = [a for a in built.get("artifacts", []) if a["name"].endswith(suffix)]
    return max(arts, key=lambda a: a["mtime"]) if arts else None


def section_summary(
    exe_s: dict, models_s: dict, dogtags_s: dict, wv2_s: dict,
    built_s: dict, pub_s: dict,
) -> dict:
    exe_local = exe_s.get("bytes")
    models_total = models_s.get("total_bytes")
    dogtags_total = dogtags_s.get("bytes")
    wv2_bytes = wv2_s.get("bytes")

    lite_local = _local_artifact(built_s, PUB_LITE)
    webview2_local = _local_artifact(built_s, PUB_WEBVIEW2)
    pub_portable, pub_tag = _pub_asset(pub_s, "release", PUB_PORTABLE)
    pub_lite, _ = _pub_asset(pub_s, "release", PUB_LITE)
    pub_webview2, _ = _pub_asset(pub_s, "release", PUB_WEBVIEW2)
    pub_res_archive, res_tag = _pub_asset(pub_s, "res_latest", RES_ARCHIVE)

    # ---- lite: wowsp.exe + DirectML.dll + wowsp-flavor.txt ---------------
    lite: dict = {
        "payload_recipe": "wowsp.exe + DirectML.dll + wowsp-flavor.txt (4 B)",
        "exe_local": exe_local,
        "payload_local": exe_local + LITE_EXTRAS if exe_local is not None else None,
        "container_local": lite_local,
        "container_published": {"bytes": pub_lite, "tag": pub_tag} if pub_lite is not None else None,
        # The published portable artifact IS the CI-compiled exe (its own
        # feature build, but the closest published proxy for the exe size
        # the CI embeds — with the portraits a local checkout may lack).
        "published_exe_proxy": pub_portable,
    }
    if lite["payload_local"] and lite_local:
        lite["ratio_local_over_local"] = round(lite_local["bytes"] / lite["payload_local"], 3)
    if lite["payload_local"] and pub_lite:
        lite["ratio_published_over_local"] = round(pub_lite / lite["payload_local"], 3)
    if pub_lite and pub_portable:
        lite["ratio_published_over_published"] = round(pub_lite / pub_portable, 3)

    # ---- webview2: exe + models/ + dogtags/ + webview2 runtime ------------
    ingredients = [exe_local, models_total, dogtags_total, wv2_bytes]
    payload_wv = sum(ingredients) + WEBVIEW2_EXTRAS if None not in ingredients else None
    webview2: dict = {
        "payload_recipe": (
            "wowsp.exe + DirectML.dll + flavor marker (8 B) + models/ "
            "unpacked + dogtags/ + webview2 runtime + res stamp (~128 B)"
        ),
        "exe_local": exe_local,
        "models_unpacked": models_total,
        "dogtags": dogtags_total,
        "webview2_runtime": wv2_bytes,
        "payload_local": payload_wv,
        "container_local": webview2_local,
        "container_published": {"bytes": pub_webview2, "tag": pub_tag} if pub_webview2 is not None else None,
        "published_exe_proxy": pub_portable,
        "missing_ingredients": [
            name for name, v in [
                ("app exe", exe_local), ("model pack", models_total),
                ("dogtags", dogtags_total), ("webview2 runtime", wv2_bytes),
            ] if v is None
        ],
    }
    if payload_wv and webview2_local:
        webview2["ratio_local_over_local"] = round(webview2_local["bytes"] / payload_wv, 3)
    if payload_wv and pub_webview2:
        webview2["ratio_published_over_local"] = round(pub_webview2 / payload_wv, 3)
    proxy_parts = [pub_portable, models_total, dogtags_total, wv2_bytes]
    if None not in proxy_parts:
        proxy = sum(proxy_parts) + WEBVIEW2_EXTRAS
        webview2["payload_published_proxy"] = proxy
        if pub_webview2:
            webview2["ratio_published_over_published"] = round(pub_webview2 / proxy, 3)

    # ---- res-latest: archive vs the unpacked tree it installs -------------
    res: dict = {
        "archive_published": {"bytes": pub_res_archive, "tag": res_tag} if pub_res_archive is not None else None,
        "unpacked_local": models_total,
    }
    if pub_res_archive and models_total:
        res["ratio_unpacked_per_compressed"] = round(models_total / pub_res_archive, 3)
        res["bytes_saved_by_compression"] = models_total - pub_res_archive

    return {"lite": lite, "webview2": webview2, "res_latest": res}


# --------------------------------------------------------------------------
# human rendering
# --------------------------------------------------------------------------

def row(name: str, files: int | None, size: int) -> str:
    count = f"{files:>7,}" if files is not None else " " * 7
    return f"  {name:<24} {count} {size:>13,} B {size / MB:>9.1f} MB"


def render_dist(s: dict) -> None:
    print("== webui dist ==")
    if "note" in s:
        print(f"  (skipped) {s['note']}")
        return
    print(f"  {s['path']}")
    print(f"  total {s['total_files']:,} files, {fmt_bytes(s['total_bytes'])} ({fmt_mb(s['total_bytes'])})")
    print("\n  by top-level directory")
    for t in s["top_level"]:
        print(row(t["name"], t["files"], t["bytes"]))
    print("\n  by extension")
    for e in s["by_extension"][:12]:
        print(row(e["ext"], e["files"], e["bytes"]))
    ships = s["ships"]
    if ships["files"]:
        census = ", ".join(f"{v:,} {k}" for k, v in ships["extensions"].items())
        print("\n  ship portraits (images/ships — gitignored fetched downloads;")
        print("  release CI embeds them, a local exe may predate them)")
        print(f"    {ships['files']:,} files ({census}), {fmt_bytes(ships['bytes'])} "
              f"({fmt_mb(ships['bytes'])}), avg {ships['avg_bytes'] / 1024:.1f} KiB/file")
    else:
        print("\n  ship portraits: none in dist (portrait-less build)")
    if s["empty_dirs"]:
        print(f"\n  empty directories (no file at any depth): {', '.join(s['empty_dirs'])}")
    if s["newest_file"]:
        print(f"  newest dist file: {s['newest_file']['path']} @ {s['newest_file']['iso']}")


def render_exe(s: dict) -> None:
    print("\n== app exe ==")
    if "note" in s:
        print(f"  (skipped) {s['note']}")
        return
    print(f"  {s['path']}")
    print(f"  {fmt_bytes(s['bytes'])} ({fmt_mb(s['bytes'])}), built {s['iso']}")
    print("\n  PE sections (raw = bytes in the file, virtual = memory image)")
    for sec in s["sections"]:
        print(f"    {sec['name']:<8} raw {sec['raw_size']:>13,} B {sec['raw_size'] / MB:>8.1f} MB"
              f"   virtual {sec['virtual_size'] / MB:>8.1f} MB")
    print(f"    section raw data totals {fmt_bytes(s['raw_total'])} ({fmt_mb(s['raw_total'])});"
          f" {fmt_bytes(s['non_section_bytes'])} outside any section (headers/padding/certificates)")
    print("  .rdata = embedded frontend assets (brotli-compressed by tauri's default")
    print("           `compression` feature) + other read-only data; .text = compiled code")
    if s.get("stale_vs_dist"):
        n = s["newer_dist_file"]
        print(f"  !! exe ({s['iso']}) predates the newest dist file ({n['path']} @ {n['iso']}) —")
        print("     the embedded frontend is stale: what is on disk is NOT what is embedded")
    elif s.get("stale_vs_dist") is False:
        print("  exe is newer than every dist file — embedding considered current")


def render_models(s: dict) -> None:
    print("\n== model pack (packages/webui/src/res/models) ==")
    if "note" in s:
        print(f"  (skipped) {s['note']}")
        return
    print(f"  total {s['total_files']:,} files, {fmt_bytes(s['total_bytes'])} ({fmt_mb(s['total_bytes'])})")
    glb, two = s["glb"], s["two_d"]
    if glb["files"]:
        print(f"  3D bake (*.glb): {glb['files']:,} files, {fmt_bytes(glb['bytes'])} "
              f"({fmt_mb(glb['bytes'])}), avg {glb['avg_bytes'] / MB:.1f} MB/file")
        print("  top 10 largest glb:")
        for g in glb["top10"]:
            print(f"    {g['path']:<44} {g['bytes']:>13,} B {g['bytes'] / MB:>8.1f} MB")
    else:
        print("  3D bake: ABSENT — no glb anywhere (tracked 2D subset only; the")
        print("           webview2 payload would stage this tree without any 3D model)")
    print(f"  tracked 2D subset: {two['files']:,} files, {fmt_bytes(two['bytes'])} ({fmt_mb(two['bytes'])})")
    for t in two["per_dir"]:
        print(row(f"  2D/{t['name']}", t["files"], t["bytes"]))
    if s["empty_dirs"]:
        print(f"  empty directories: {', '.join(s['empty_dirs'])}")


def render_simple(title: str, s: dict, unit_noun: str) -> None:
    print(f"\n== {title} ==")
    if "note" in s:
        print(f"  (skipped) {s['note']}")
        return
    print(f"  {s['path']}: {s['files']:,} {unit_noun}, {fmt_bytes(s['bytes'])} ({fmt_mb(s['bytes'])})")


def render_wv2(s: dict) -> None:
    print("\n== WebView2 offline runtime ==")
    if "note" in s:
        print(f"  (skipped) {s['note']}")
        return
    print(f"  {s['path']}")
    print(f"  {fmt_bytes(s['bytes'])} ({fmt_mb(s['bytes'])})")


def render_built(s: dict) -> None:
    print("\n== locally built installers ==")
    if "note" in s:
        print(f"  (skipped) {s['note']}")
        return
    print(f"  {s['path']}")
    for a in s["artifacts"]:
        print(f"    {a['name']:<44} {a['bytes']:>13,} B {a['bytes'] / MB:>8.1f} MB   built {a['iso']}")


def _render_release(label: str, rel: dict) -> None:
    if "error" in rel:
        print(f"  {label}: unreachable — {rel['error']}")
        return
    when = f", published {rel['published_at'][:10]}" if rel.get("published_at") else ""
    print(f"  {label}: {rel['tag']}{when}")
    if not rel["assets"]:
        print("    (no assets)")
    for a in sorted(rel["assets"], key=lambda a: -a["bytes"]):
        print(f"    {a['name']:<44} {a['bytes']:>13,} B {a['bytes'] / MB:>8.1f} MB")


def render_published(s: dict) -> None:
    print("\n== published releases (gh api — metadata only, nothing downloaded) ==")
    if "note" in s:
        print(f"  (skipped) {s['note']}")
        return
    _render_release("app release", s["release"])
    _render_release("res-latest", s["res_latest"])


def _ratio_line(label: str, ratio: float, caveat: str) -> str:
    return f"    ratio {label}: {ratio:.3f}{caveat}"


def _sum_line(label: str, value: int, tail: str = "") -> str:
    return f"    {label:<33} {value:>13,} B {value / MB:>8.1f} MB{tail}"


def render_summary(s: dict) -> None:
    print("\n== flavor summary (payload → container arithmetic) ==")
    lite = s["lite"]
    print("\n  [lite] payload = wowsp.exe + wowsp-flavor.txt (4 B)")
    if lite["exe_local"] is not None:
        print(_sum_line("exe (local)", lite["exe_local"]))
        print(_sum_line("payload (local exe)", lite["payload_local"]))
    else:
        print("    exe (local): missing — payload not computable")
    if lite["container_local"]:
        c = lite["container_local"]
        print(_sum_line("container (local)", c["bytes"], f"   {c['name']}, built {c['iso']}"))
    if lite["container_published"]:
        c = lite["container_published"]
        print(_sum_line(f"container (published {c['tag']})", c["bytes"]))
    if lite["published_exe_proxy"]:
        print(_sum_line("exe proxy (published portable)", lite["published_exe_proxy"],
                        "   — the CI-compiled exe"))
    if "ratio_local_over_local" in lite:
        print(_ratio_line("local/local", lite["ratio_local_over_local"], ""))
        print("      (today's local exe vs a container packed on its own build date — not the same bytes)")
    if "ratio_published_over_local" in lite:
        print(_ratio_line("published/local", lite["ratio_published_over_local"],
                          "  — MIXED: payload measured locally, container published"))
    if "ratio_published_over_published" in lite:
        print(_ratio_line("published/published", lite["ratio_published_over_published"],
                          "  — CI-consistent (the shun container's compression of the exe)"))

    wv = s["webview2"]
    print("\n  [webview2] payload = wowsp.exe + flavor marker (8 B) + models/ unpacked")
    print("              + dogtags/ + webview2 runtime + res stamp (~128 B)")
    for label, key in [
        ("exe (local)", "exe_local"),
        ("models/ unpacked (local walk)", "models_unpacked"),
        ("dogtags/ (local)", "dogtags"),
        ("webview2 runtime (local vendor)", "webview2_runtime"),
    ]:
        v = wv[key]
        print(_sum_line(label, v) if v is not None else f"    {label:<33} missing")
    if wv["payload_local"] is not None:
        print(_sum_line("payload total", wv["payload_local"]))
    else:
        print(f"    payload total: not computable (missing: {', '.join(wv['missing_ingredients']) or 'none'})")
    if wv["container_local"]:
        c = wv["container_local"]
        print(_sum_line("container (local)", c["bytes"], f"   {c['name']}, built {c['iso']}"))
    if wv["container_published"]:
        c = wv["container_published"]
        print(_sum_line(f"container (published {c['tag']})", c["bytes"]))
    if wv["published_exe_proxy"]:
        print(_sum_line("exe proxy (published portable)", wv["published_exe_proxy"]))
    if "payload_published_proxy" in wv:
        print(_sum_line("payload proxy (published exe)", wv["payload_published_proxy"],
                        "   — published exe + local trees"))
    if "ratio_local_over_local" in wv:
        print(_ratio_line("local/local", wv["ratio_local_over_local"], ""))
        print("      (today's local exe/trees vs a container packed on its own build date — not the same bytes)")
    if "ratio_published_over_local" in wv:
        print(_ratio_line("published/local", wv["ratio_published_over_local"],
                          "  — MIXED: payload measured locally, container published"))
    if "ratio_published_over_published" in wv:
        print(_ratio_line("published/published", wv["ratio_published_over_published"],
                          "  — published exe proxy + locally measured trees"))

    res = s["res_latest"]
    print("\n  [res-latest] published archive vs the unpacked tree it installs")
    if res["archive_published"]:
        a = res["archive_published"]
        print(f"    wowsp-res.tar.gz (published {a['tag']}) {a['bytes']:>13,} B {a['bytes'] / MB:>8.1f} MB")
    else:
        print("    wowsp-res.tar.gz (published): unreachable")
    if res["unpacked_local"] is not None:
        u = res["unpacked_local"]
        print(f"    models/ unpacked (local walk)    {u:>13,} B {u / MB:>8.1f} MB")
    if "ratio_unpacked_per_compressed" in res:
        print(f"    ratio: {res['ratio_unpacked_per_compressed']:.2f}x unpacked per compressed byte"
              f" ({res['bytes_saved_by_compression'] / MB:.1f} MB saved by tar.gz)")


def render(report: dict) -> None:
    render_dist(report["dist"])
    render_exe(report["exe"])
    render_models(report["models"])
    render_simple("dog-tag art (packages/webui/src/res/dogtags)", report["dogtags"], "files")
    render_wv2(report["webview2"])
    render_built(report["built_installers"])
    render_published(report["published"])
    render_summary(report["summary"])


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def build_report(root: Path, exe_arg: str | None, tag: str | None, published: bool) -> dict:
    dist_s = section_dist(root)
    exe = root / "target" / "release" / "wowsp.exe"
    if exe_arg:
        # Relative --exe joins the repo root (the same base every other
        # path in the report resolves against), never the process CWD.
        exe = Path(exe_arg) if Path(exe_arg).is_absolute() else root / exe_arg
    exe_s = section_exe(exe, dist_s)
    models_s = section_models(root)
    dogtags_s = section_dogtags(root)
    wv2_s = section_webview2(root)
    built_s = section_built(root)
    # The published section activates on EITHER flag: --tag names the
    # release, --published alone means "the latest one".
    pub_s = section_published(tag, bool(tag) or published)
    return {
        "repo_root": str(root),
        "dist": dist_s,
        "exe": exe_s,
        "models": models_s,
        "dogtags": dogtags_s,
        "webview2": wv2_s,
        "built_installers": built_s,
        "published": pub_s,
        "summary": section_summary(exe_s, models_s, dogtags_s, wv2_s, built_s, pub_s),
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--repo-root",
        default=str(REPO),
        help="analyze this checkout instead of the one the script lives in — "
        "the read-only way for a worktree to measure the main checkout "
        "(every section resolves its inputs under this path)",
    )
    ap.add_argument(
        "--exe",
        default=None,
        help="path to the app binary to parse; a RELATIVE path resolves "
        "against --repo-root like every other input (default: "
        "<repo-root>/target/release/wowsp.exe)",
    )
    ap.add_argument(
        "--tag",
        default=None,
        help="list this published release tag's asset sizes via gh api "
        "(e.g. v0.6.1); metadata only — this script never downloads "
        "anything",
    )
    ap.add_argument(
        "--published",
        action="store_true",
        help="query the latest published release's asset sizes (used when "
        "--tag is absent; res-latest is always queried alongside either "
        "flag, because the summary needs the archive size)",
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help="emit the whole report as one JSON object on stdout instead "
        "of the human tables (for automation; same data)",
    )
    args = ap.parse_args()

    # Paths on this machine carry non-ASCII (D:\源代码\…): a legacy console
    # codepage must turn into replacement characters, never a crash. --json
    # forces UTF-8 so machine consumers get stable bytes.
    try:
        sys.stdout.reconfigure(errors="replace")
        if args.json:
            sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

    root = Path(args.repo_root).resolve()
    report = build_report(root, args.exe, args.tag, args.published)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        render(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
