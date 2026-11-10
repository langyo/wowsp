#!/usr/bin/env python3
"""Automate the mod-hub standard preview clip pipeline.

The catalog convention (docs/*/designs/mod-hub.md, scripts/mod_index.py)
lets a Discussion thread carry a small preview video through the
front-matter line:

    preview_video: https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>

The standard is AV1 in MP4 (H.264 acceptable fallback), 720p, 8-20 s,
<= 3 MB, faststart, optional AAC, hosted on the repository's release
download tree so the app's installer trust rules accept it.

This tool does the three manual steps a maintainer used to repeat by
hand — trim/crop/encode the clip, upload it as a release asset, and patch
the Discussion body — and it resolves ffmpeg from the flag, the FFMPEG
env var, PATH, or the pip-packaged imageio-ffmpeg wheel (installing that
wheel itself when the binary is missing). It never touches the game
client and it bundles nothing: the app plays previews through the Tauri
webview, and the external ffmpeg is only needed to PRODUCE clips.

Subcommands:
    encode    source video -> standard preview clip (auto lead-black trim)
    publish   upload the clip to the release and patch the Discussion
    selftest  offline checks of the body patchers and the ffmpeg ladder
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ASSET_PREFIX = "preview-"
FRONT_MATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
PREVIEW_LINE_RE = re.compile(r"^preview_video:.*$", re.MULTILINE)
SLUG_LINE_RE = re.compile(r"^wowsp-mod:\s*(\S+)\s*$", re.MULTILINE)
CLIP_BULLET_RE = re.compile(r"^- Preview clip:.*$", re.MULTILINE)
DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")

MAX_BYTES = 3 * 1024 * 1024
MAX_SECONDS = 20.0


def log(message: str) -> None:
    print(f"[preview-video] {message}", file=sys.stderr)


def run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    # gh/ffmpeg emit UTF-8; the Windows locale (GBK) must never decode them.
    kwargs.setdefault("encoding", "utf-8")
    kwargs.setdefault("errors", "replace")
    return subprocess.run(argv, capture_output=True, text=True, **kwargs)


def resolve_ffmpeg(explicit: str | None = None, allow_install: bool = True) -> str:
    """Flag -> FFMPEG env -> PATH -> imageio-ffmpeg (installing it when allowed)."""
    if explicit:
        if not Path(explicit).is_file():
            raise SystemExit(f"ffmpeg not found at {explicit}")
        return explicit
    from_env = os.environ.get("FFMPEG", "").strip()
    if from_env and Path(from_env).is_file():
        return from_env
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    try:
        import imageio_ffmpeg  # type: ignore[import-not-found]

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).is_file():
            log(f"using the imageio-ffmpeg wheel binary: {exe}")
            return exe
    except Exception:
        pass
    if allow_install:
        cmd = [sys.executable, "-m", "pip", "install", "--user", "imageio-ffmpeg"]
        log("ffmpeg missing — installing the pip-packaged wheel: " + " ".join(cmd))
        run(cmd)
        try:
            import imageio_ffmpeg  # type: ignore[import-not-found]

            exe = imageio_ffmpeg.get_ffmpeg_exe()
            if exe and Path(exe).is_file():
                return exe
        except Exception as exc:
            log(f"imageio-ffmpeg still unusable: {exc}")
    raise SystemExit(
        "ffmpeg is required to encode previews. Install ffmpeg and put it on PATH, "
        "set FFMPEG to its path, pass --ffmpeg <path>, or run "
        "python -m pip install --user imageio-ffmpeg and retry."
    )


def available_encoders(ffmpeg: str) -> set[str]:
    out = run([ffmpeg, "-hide_banner", "-encoders"]).stdout
    return {name for name in ("libsvtav1", "libaom-av1", "libx264") if name in out}


def pick_encoder(encoders: set[str]) -> tuple[str, str]:
    """Preferred AV1 encoder first, H.264 as the documented fallback."""
    if "libsvtav1" in encoders:
        return "libsvtav1", "av1"
    if "libaom-av1" in encoders:
        return "libaom-av1", "av1"
    if "libx264" in encoders:
        return "libx264", "h264"
    raise SystemExit("ffmpeg has no AV1 or H.264 encoder — install a full ffmpeg build.")


def detect_lead_black(ffmpeg: str, source: str, probe_seconds: float = 40.0) -> float:
    """Seconds of leading black to skip (0 when the clip opens on picture)."""
    out = run(
        [
            ffmpeg, "-hide_banner", "-nostats", "-t", f"{probe_seconds:.1f}",
            "-i", source, "-vf", "blackdetect=d=1:pix_th=0.10", "-an", "-f", "null", "-",
        ]
    ).stderr
    match = re.search(r"black_start:([\d.]+)\s+black_end:([\d.]+)", out)
    if match and float(match.group(1)) <= 0.5 and float(match.group(2)) > 1.0:
        return float(match.group(2)) + 0.05
    return 0.0


def probe_duration(ffmpeg: str, path: str) -> float:
    """Container duration in seconds, parsed from ffmpeg's input banner."""
    out = run([ffmpeg, "-hide_banner", "-i", path]).stderr
    match = DURATION_RE.search(out)
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def encode_argv(
    ffmpeg: str,
    source: str,
    out: str,
    start: float,
    duration: float,
    encoder: str,
    crf: int,
) -> list[str]:
    """The exact argv for one standard-clip encode (pure; selftested)."""
    argv = [ffmpeg, "-y", "-hide_banner", "-loglevel", "warning"]
    if start > 0:
        argv += ["-ss", f"{start:.3f}"]
    argv += ["-i", source, "-t", f"{duration:.3f}"]
    argv += ["-vf", "fps=25,scale=1280:720:flags=lanczos"]
    if encoder == "libsvtav1":
        argv += ["-c:v", "libsvtav1", "-crf", str(crf), "-preset", "8"]
    elif encoder == "libaom-av1":
        argv += ["-c:v", "libaom-av1", "-crf", str(crf), "-b:v", "0", "-cpu-used", "6", "-row-mt", "1"]
    else:
        argv += ["-c:v", "libx264", "-crf", str(crf + 4), "-preset", "medium"]
    argv += ["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out]
    return argv


def verify_clip_argv(ffmpeg: str, path: str) -> list[str]:
    """Decode pass that proves the produced file is actually readable."""
    return [ffmpeg, "-v", "error", "-i", path, "-f", "null", "-"]


def patch_preview_line(body: str, url: str) -> str:
    """Ensure exactly one preview_video line, as the last front-matter key."""
    front = FRONT_MATTER_RE.match(body)
    if not front:
        raise SystemExit("the discussion body has no front matter — is this a mod thread?")
    if PREVIEW_LINE_RE.search(body):
        return PREVIEW_LINE_RE.sub(f"preview_video: {url}", body, count=1)
    head = body[: front.end(1)]
    tail = body[front.end(1):]
    return head + f"\npreview_video: {url}" + tail


def clip_bullet(url: str, asset: str, duration: float, size_mb: float) -> str:
    return (
        f"- Preview clip: AV1 MP4, 720p, {duration:.0f} s, {size_mb:.1f} MB"
        f" — [{asset}]({url})"
    )


def patch_clip_bullet(body: str, line: str) -> str:
    """Replace the existing preview bullet, else add one before Download:."""
    if CLIP_BULLET_RE.search(body):
        return CLIP_BULLET_RE.sub(line, body, count=1)
    marker = "\nDownload:"
    if marker in body:
        index = body.index(marker)
        return body[:index] + "\n" + line + body[index:]
    return body.rstrip("\n") + "\n\n" + line + "\n"


def slug_of(body: str) -> str:
    match = SLUG_LINE_RE.search(body)
    return match.group(1) if match else ""


def patch_body(body: str, slug: str, url: str, asset: str, duration: float, size_mb: float) -> str:
    """Apply both patches, refusing a body whose wowsp-mod does not match."""
    found = slug_of(body)
    if found != slug:
        raise SystemExit(f"discussion slug is {found or '<missing>'}, expected {slug} — refusing to patch")
    return patch_clip_bullet(patch_preview_line(body, url), clip_bullet(url, asset, duration, size_mb))


def release_url(repo: str, tag: str, asset: str) -> str:
    return f"https://github.com/{repo}/releases/download/{tag}/{asset}"


def fetch_discussion(repo: str, number: int) -> dict:
    owner, _, name = repo.partition("/")
    query = (
        "query($owner: String!, $name: String!, $number: Int!) {"
        " repository(owner: $owner, name: $name) {"
        " discussion(number: $number) { id body } } }"
    )
    proc = run(
        [
            "gh", "api", "graphql",
            "-f", f"query={query}",
            "-f", f"owner={owner}",
            "-f", f"name={name}",
            "-F", f"number={number}",
            "--jq", ".data.repository.discussion",
        ]
    )
    if proc.returncode != 0:
        raise SystemExit(f"gh api graphql failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def update_discussion(discussion_id: str, body: str) -> str:
    query = (
        "mutation($id: ID!, $body: String!) {"
        " updateDiscussion(input: {discussionId: $id, body: $body}) {"
        " discussion { number url } } }"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
        json.dump({"query": query, "variables": {"id": discussion_id, "body": body}}, handle)
        payload = handle.name
    try:
        proc = run(
            ["gh", "api", "graphql", "--input", payload, "--jq",
             ".data.updateDiscussion.discussion.url"]
        )
        if proc.returncode != 0:
            raise SystemExit(f"gh api graphql failed: {proc.stderr.strip()}")
        return proc.stdout.strip()
    finally:
        Path(payload).unlink(missing_ok=True)


def upload_asset(file: Path, asset: str, tag: str) -> None:
    """Upload under the standard asset name (gh has no portable rename syntax)."""
    if file.name == asset:
        target = file
        temp_dir = None
    else:
        temp_dir = tempfile.mkdtemp(prefix="preview-video-")
        target = Path(temp_dir) / asset
        shutil.copyfile(file, target)
    try:
        proc = run(["gh", "release", "upload", tag, str(target), "--clobber"])
        if proc.returncode != 0:
            raise SystemExit(f"gh release upload failed: {proc.stderr.strip()}")
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)
    listing = run(["gh", "release", "view", tag, "--json", "assets"]).stdout
    names = {item.get("name") for item in json.loads(listing or "{}").get("assets", [])}
    if asset not in names:
        raise SystemExit(f"upload reported success but {asset} is not on the {tag} release")


def cmd_encode(args: argparse.Namespace) -> int:
    ffmpeg = resolve_ffmpeg(args.ffmpeg, allow_install=not args.no_install)
    if not Path(args.source).is_file():
        raise SystemExit(f"source video not found: {args.source}")
    encoders = available_encoders(ffmpeg)
    encoder, codec = pick_encoder(encoders)
    start = args.start
    if start is None:
        start = detect_lead_black(ffmpeg, args.source)
        log(f"lead-black trim detected: skip {start:.2f} s")
    out = Path(args.out or f"{ASSET_PREFIX}{args.slug}.mp4")
    out.parent.mkdir(parents=True, exist_ok=True)
    argv = encode_argv(ffmpeg, args.source, str(out), start, args.duration, encoder, args.crf)
    log("encoding: " + " ".join(argv))
    proc = run(argv)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-4000:])
        raise SystemExit(f"ffmpeg encode failed with exit code {proc.returncode}")
    verify = run(verify_clip_argv(ffmpeg, str(out)))
    if verify.returncode != 0:
        raise SystemExit("the produced clip does not decode: " + verify.stderr[-2000:])
    size = out.stat().st_size
    duration = probe_duration(ffmpeg, str(out)) or args.duration
    report = {
        "file": str(out),
        "bytes": size,
        "mb": round(size / (1024 * 1024), 2),
        "duration": round(duration, 2),
        "codec": codec,
        "encoder": encoder,
        "start": round(start, 2),
        "asset": f"{ASSET_PREFIX}{args.slug}.mp4",
    }
    if size > MAX_BYTES:
        log(f"warning: {report['mb']} MB is over the {MAX_BYTES / (1024 * 1024):.0f} MB budget")
    if duration > MAX_SECONDS:
        log(f"warning: {duration:.1f} s is over the {MAX_SECONDS:.0f} s budget")
    print(json.dumps(report, indent=2))
    over = size > MAX_BYTES or duration > MAX_SECONDS
    return 1 if (args.strict and over) else 0


def cmd_publish(args: argparse.Namespace) -> int:
    file = Path(args.file)
    if not file.is_file():
        raise SystemExit(f"preview clip not found: {file}")
    asset = f"{ASSET_PREFIX}{args.slug}.mp4"
    url = release_url(args.repo, args.tag, asset)
    discussion = fetch_discussion(args.repo, args.discussion)
    duration = args.duration
    if duration <= 0:
        probe = args.ffmpeg or os.environ.get("FFMPEG") or shutil.which("ffmpeg")
        duration = probe_duration(probe, str(file)) if probe else 0.0
    size_mb = file.stat().st_size / (1024 * 1024)
    patched = patch_body(discussion["body"], args.slug, url, asset, duration, size_mb)
    if args.dry_run:
        print(patched)
        log("dry run: no upload, no Discussion update")
        return 0
    upload_asset(file, asset, args.tag)
    target = update_discussion(discussion["id"], patched)
    log(f"published {asset} and patched {target}")
    print(json.dumps({"asset": asset, "url": url, "discussion": target}, indent=2))
    return 0


SELFTEST_BODY = """---
wowsp-mod: video.login.selftest
version: 1.0.0
game: "*"
category: video
author: Someone
license: Unspecified (upstream)
---

Replaces the opening clip.

Download:

- [`video.login.selftest.zip`](https://github.com/o/r/releases/download/mod-hub/x.zip) — 1 KB · SHA-256 `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`
"""


def selftest() -> int:
    slug = "video.login.selftest"
    url = release_url("o/r", "mod-hub", "preview-video.login.selftest.mp4")
    patched = patch_body(SELFTEST_BODY, slug, url, "preview-video.login.selftest.mp4", 12.4, 2.5)
    assert patched.count("preview_video:") == 1, patched
    assert f"preview_video: {url}" in patched
    assert patched.index("preview_video:") < patched.index("\n---"), "must stay in the front matter"
    assert "- Preview clip: AV1 MP4, 720p, 12 s, 2.5 MB" in patched
    assert patched.index("- Preview clip:") < patched.index("Download:")
    again = patch_body(patched, slug, url, "preview-video.login.selftest.mp4", 12.0, 2.0)
    assert again.count("preview_video:") == 1 and again.count("- Preview clip:") == 1, again
    try:
        patch_body(SELFTEST_BODY, "other.slug", url, "x.mp4", 1, 1)
        raise AssertionError("slug mismatch must be refused")
    except SystemExit:
        pass
    argv = encode_argv("ffmpeg", "in.mp4", "out.mp4", 10.5, 12, "libsvtav1", 40)
    assert argv[argv.index("-ss") + 1] == "10.500"
    assert argv[argv.index("-t") + 1] == "12.000"
    assert "fps=25,scale=1280:720:flags=lanczos" in argv
    assert argv[-1] == "out.mp4"
    assert pick_encoder({"libsvtav1", "libaom-av1", "libx264"}) == ("libsvtav1", "av1")
    assert pick_encoder({"libx264"}) == ("libx264", "h264")
    try:
        pick_encoder(set())
        raise AssertionError("no encoder must be refused")
    except SystemExit:
        pass
    assert clip_bullet("u", "a.mp4", 12, 1.5).startswith("- Preview clip: AV1 MP4, 720p, 12 s, 1.5 MB")
    try:
        patch_preview_line("no front matter here", "u")
        raise AssertionError("missing front matter must be refused")
    except SystemExit:
        pass
    print("selftest ok")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--selftest", action="store_true", help="run the offline selftest")
    sub = parser.add_subparsers(dest="command")

    encode = sub.add_parser("encode", help="encode a standard preview clip")
    encode.add_argument("--source", required=True)
    encode.add_argument("--out")
    encode.add_argument("--slug", required=True)
    encode.add_argument("--start", type=float)
    encode.add_argument("--duration", type=float, default=12.0)
    encode.add_argument("--crf", type=int, default=40)
    encode.add_argument("--ffmpeg")
    encode.add_argument("--no-install", action="store_true")
    encode.add_argument("--strict", action="store_true")
    encode.set_defaults(func=cmd_encode)

    publish = sub.add_parser("publish", help="upload the clip and patch the Discussion")
    publish.add_argument("--file", required=True)
    publish.add_argument("--slug", required=True)
    publish.add_argument("--discussion", type=int, required=True)
    publish.add_argument("--repo", default="langyo/wowsp")
    publish.add_argument("--tag", default="mod-hub")
    publish.add_argument("--duration", type=float, default=0.0)
    publish.add_argument("--ffmpeg")
    publish.add_argument("--dry-run", action="store_true")
    publish.set_defaults(func=cmd_publish)

    args = parser.parse_args(argv)
    if args.selftest or args.command is None:
        return selftest()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
