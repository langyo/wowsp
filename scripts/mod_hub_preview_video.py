#!/usr/bin/env python3
"""Mod Hub standard preview-video pipeline (encode -> upload -> Discussion).

The mod-hub catalog convention (docs/<lang>/designs/mod-hub.md) gives a
thread one optional "preview_video:" front-matter line pointing at a short
web-friendly clip: AV1 in MP4 (H.264 fallback), 720p, 8-20 s, at most 3 MB,
faststart, optional AAC, hosted on this repo's release download tree. Before
this script a maintainer ran ffmpeg by hand, uploaded the asset with gh and
hand-edited the Discussion body -- exactly how video.login.sea-monkey
(Discussion #1908, asset preview-video.login.sea-monkey.mp4) was made.

This script automates the whole chain:

    python scripts/mod_hub_preview_video.py encode --source raw.mkv --slug video.login.sea-monkey
    python scripts/mod_hub_preview_video.py publish --slug video.login.sea-monkey --file preview-video.login.sea-monkey.mp4 --discussion 1908
    python scripts/mod_hub_preview_video.py --selftest

encode skips a leading black segment longer than one second (ffmpeg's
blackdetect filter), prefers libsvtav1 (CRF 40, preset 8), falls back to
libaom-av1 and finally libx264 (recorded as a warning), scales/pads to
1280x720 at 25 fps, writes +faststart and adds AAC 96k only when the source
has audio. It only warns when the result exceeds the 3 MB / 20 s budget --
--strict turns that warning into a non-zero exit. The final size/duration are
read from ffmpeg's own output, so ffprobe is not needed.

publish needs no ffmpeg. It stages the file under the canonical
preview-<slug>.mp4 name when necessary, uploads with gh release upload
--clobber, verifies the release asset list, deletes stray same-stem assets,
then patches the Discussion through gh api graphql (query body + id, then
updateDiscussion): exactly one preview_video: front-matter line and one
visible "- Preview clip: ..." bullet. --dry-run --body-file <path> prints the
patched body and performs no network calls.

ffmpeg resolution (shared by encode and the self-test): explicit --ffmpeg ->
$FFMPEG -> shutil.which("ffmpeg") -> the pip-packaged imageio-ffmpeg ->
(unless --no-install) python -m pip install --user imageio-ffmpeg and retry.
Every failure prints actionable install instructions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

REPO_DEFAULT = "langyo/wowsp"
TAG_DEFAULT = "mod-hub"
ASSET_PREFIX = "preview-"
BUDGET_BYTES = 3 * 1024 * 1024
BUDGET_SECONDS = 20.0
VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 720
VIDEO_FPS = 25
# Letterbox to exactly 720p instead of distorting the source, then force the
# catalog frame rate and square pixels.
VIDEO_FILTER = (
    "scale=1280:720:force_original_aspect_ratio=decrease,"
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,"
    "fps=25,setsar=1"
)
ENCODER_NAMES = ("libsvtav1", "libaom-av1", "libx264")
DEFAULT_CRF = 40
BULLET_PREFIX = "- Preview clip:"
GH_GRAPHQL_COMMAND = ["gh", "api", "graphql", "--input", "-"]

FRONT_MATTER_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.DOTALL)
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAG_RE = re.compile(r"^[A-Za-z0-9._+-]+$")
BLACKDETECT_RE = re.compile(
    r"black_start:\s*(\d+(?:\.\d+)?)\s+black_end:\s*(\d+(?:\.\d+)?)\s+"
    r"black_duration:\s*(\d+(?:\.\d+)?)"
)
AUDIO_STREAM_RE = re.compile(r"(?m)^\s*Stream #\d+:\d+[^:\n]*: Audio:")
PROGRESS_SIZE_RE = re.compile(r"\bL?size=\s*(\d+)\s*[kK]i?B\b")
PROGRESS_TIME_RE = re.compile(r"\btime=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")

DISCUSSION_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) { id number url title body }
  }
}
"""

UPDATE_MUTATION = """
mutation($input: UpdateDiscussionInput!) {
  updateDiscussion(input: $input) { discussion { id number url } }
}
"""


class PipelineError(RuntimeError):
    """A user-actionable pipeline failure (main prints it as 'error:')."""


class FfmpegNotFound(PipelineError):
    """No ffmpeg executable could be resolved or installed."""


# ---------------------------------------------------------------- utilities


def _tail(text: str, lines: int = 12) -> str:
    """The last non-empty lines of a subprocess log (ffmpeg emits CR and LF)."""
    parts = [part.strip() for part in re.split(r"[\r\n]+", text or "") if part.strip()]
    return "\n".join(parts[-lines:])


def _command_text(command: list[str]) -> str:
    """A copy-pasteable rendering of an argv list (Windows quoting rules)."""
    return subprocess.list2cmdline(command)


def _format_number(value: float) -> str:
    """3.0 -> '3', 2.500 -> '2.5' (stable argv rendering for tests)."""
    text = f"{float(value):.3f}".rstrip("0").rstrip(".")
    return text or "0"


def _configure_stdio() -> None:
    """Keep Discussion bodies (CJK, em dash) UTF-8 even on a GBK console."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (AttributeError, OSError):
                pass


def validate_slug(slug: str) -> str:
    """Trim and validate a catalog mod slug (category.genus.species)."""
    value = (slug or "").strip()
    if not value or ".." in value or not SLUG_RE.fullmatch(value):
        raise PipelineError(
            f"invalid --slug {value!r}: expected lowercase [a-z0-9.-] segments "
            "(for example video.login.sea-monkey)"
        )
    return value


def validate_repo(repo: str) -> str:
    value = (repo or "").strip()
    if not REPO_RE.fullmatch(value):
        raise PipelineError(f"invalid --repo {value!r}: expected <owner>/<name>")
    return value


def validate_tag(tag: str) -> str:
    value = (tag or "").strip()
    if not TAG_RE.fullmatch(value):
        raise PipelineError(f"invalid --tag {value!r}: expected one release tag segment")
    return value


def asset_name(slug: str) -> str:
    """Canonical release asset name for a mod slug."""
    return f"{ASSET_PREFIX}{slug}.mp4"


def release_url(repo: str, tag: str, asset: str) -> str:
    """The release download URL the Discussion front matter points at."""
    return f"https://github.com/{repo}/releases/download/{tag}/{asset}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_sha256(value: str) -> str:
    text = (value or "").strip().lower()
    if text.startswith("sha256:"):
        text = text[7:].strip()
    if not re.fullmatch(r"[0-9a-f]{64}", text):
        raise PipelineError("--sha256 must be a 64-digit hexadecimal SHA-256")
    return text


# ---------------------------------------------------------------- ffmpeg lookup


def _default_imageio_getter() -> str | None:
    """The binary bundled by the optional imageio-ffmpeg wheel (or None)."""
    try:
        import imageio_ffmpeg
    except ImportError:
        return None
    try:
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # noqa: BLE001 - optional runtime dependency
        print(f"warning: imageio-ffmpeg is installed but unusable: {exc}", file=sys.stderr)
        return None


def install_imageio_ffmpeg() -> bool:
    """Install the pip-packaged ffmpeg build, logging the command and output."""
    command = [sys.executable, "-m", "pip", "install", "--user", "imageio-ffmpeg"]
    print(f"ffmpeg: installing the pip-packaged build: {_command_text(command)}", file=sys.stderr)
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except OSError as exc:
        print(f"warning: could not run pip: {exc}", file=sys.stderr)
        return False
    if result.returncode != 0:
        print(
            f"warning: pip install failed (exit {result.returncode}):\n"
            f"{_tail(result.stderr or result.stdout)}",
            file=sys.stderr,
        )
        return False
    print("ffmpeg: imageio-ffmpeg installed", file=sys.stderr)
    return True


def resolve_ffmpeg(
    explicit: str | None = None,
    no_install: bool = False,
    *,
    env: dict[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
    imageio_getter: Callable[[], str | None] = _default_imageio_getter,
    installer: Callable[[], bool] = install_imageio_ffmpeg,
) -> str:
    """Resolve ffmpeg in the documented order, installing imageio on demand.

    Order: explicit --ffmpeg, $FFMPEG, PATH, the installed imageio-ffmpeg
    wheel, then (unless no_install) a pip install and one retry. The keyword
    arguments exist so the offline self-test can drive every branch.
    """
    if explicit:
        print(f"ffmpeg: using --ffmpeg -> {explicit}", file=sys.stderr)
        return explicit
    environment = os.environ if env is None else env
    from_env = (environment.get("FFMPEG") or "").strip()
    if from_env:
        print(f"ffmpeg: using $FFMPEG -> {from_env}", file=sys.stderr)
        return from_env
    found = which("ffmpeg")
    if found:
        print(f"ffmpeg: using PATH -> {found}", file=sys.stderr)
        return found
    packaged = imageio_getter()
    if packaged:
        print(f"ffmpeg: using imageio-ffmpeg -> {packaged}", file=sys.stderr)
        return packaged

    installed = False
    if not no_install:
        installed = installer()
        if installed:
            packaged = imageio_getter()
            if packaged:
                print(f"ffmpeg: using imageio-ffmpeg -> {packaged}", file=sys.stderr)
                return packaged

    hint = (
        "Install ffmpeg and put it on PATH (Windows: winget install Gyan.FFmpeg; "
        "Linux: sudo apt install ffmpeg), pass --ffmpeg <path>, set the FFMPEG "
        "environment variable, or let this script install the pip-packaged build: "
        "python -m pip install --user imageio-ffmpeg"
    )
    if no_install:
        hint += " (re-run without --no-install to allow that install)"
    if installed:
        hint = "imageio-ffmpeg was installed but exposed no binary. " + hint
    raise FfmpegNotFound("no usable ffmpeg found.\n" + hint)


# ---------------------------------------------------------------- ffmpeg argv


def encoder_list_command(ffmpeg: str) -> list[str]:
    return [ffmpeg, "-hide_banner", "-nostdin", "-encoders"]


def stream_probe_command(ffmpeg: str, source: str | Path) -> list[str]:
    """A metadata-only ffmpeg -i pass (exit code 1 is expected)."""
    return [ffmpeg, "-hide_banner", "-nostdin", "-i", str(source)]


def blackdetect_command(ffmpeg: str, source: str | Path) -> list[str]:
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-i",
        str(source),
        "-vf",
        "blackdetect=d=0.1:pix_th=0.10",
        "-an",
        "-f",
        "null",
        "-",
    ]


def codec_args(encoder: str, crf: int) -> list[str]:
    if encoder == "libsvtav1":
        return ["-c:v", "libsvtav1", "-crf", str(crf), "-preset", "8"]
    if encoder == "libaom-av1":
        return [
            "-c:v",
            "libaom-av1",
            "-crf",
            str(crf),
            "-cpu-used",
            "6",
            "-row-mt",
            "1",
        ]
    if encoder == "libx264":
        return ["-c:v", "libx264", "-crf", str(crf), "-preset", "medium"]
    raise PipelineError(f"unknown encoder: {encoder}")


def encode_command(
    ffmpeg: str,
    source: str | Path,
    out: str | Path,
    *,
    start: float,
    duration: float,
    crf: int,
    encoder: str,
    has_audio: bool,
) -> list[str]:
    """The exact ffmpeg argv for one standard preview encode."""
    command = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        _format_number(start),
        "-i",
        str(source),
        "-t",
        _format_number(duration),
        "-map",
        "0:v:0",
        "-vf",
        VIDEO_FILTER,
        *codec_args(encoder, crf),
        "-pix_fmt",
        "yuv420p",
    ]
    if has_audio:
        command += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "96k"]
    else:
        command += ["-an"]
    command += ["-sn", "-dn", "-movflags", "+faststart", str(out)]
    return command


# ---------------------------------------------------------------- ffmpeg output


def parse_encoders(text: str) -> set[str]:
    """The supported encoders among the names this pipeline prefers."""
    found: set[str] = set()
    for name in ENCODER_NAMES:
        if re.search(rf"(?m)^\s*V\S*\s+{re.escape(name)}\b", text or ""):
            found.add(name)
    return found


def choose_encoder(available: set[str], crf: int) -> tuple[str, str, str | None]:
    """Pick libsvtav1 -> libaom-av1 -> libx264; return (encoder, codec, warning)."""
    if "libsvtav1" in available:
        return "libsvtav1", "av1", None
    if "libaom-av1" in available:
        return "libaom-av1", "av1", None
    warning = (
        "ffmpeg has neither libsvtav1 nor libaom-av1; falling back to libx264 "
        "(H.264, the catalog's accepted fallback)"
    )
    return "libx264", "h264", warning


def parse_blackdetect(text: str) -> tuple[float, float, float] | None:
    """The first leading black segment longer than 1 s, as (start, end, len)."""
    for match in BLACKDETECT_RE.finditer(text or ""):
        start, end, duration = (float(group) for group in match.groups())
        if start <= 0.25 and duration > 1.0:
            return start, end, duration
    return None


def parse_has_audio(stderr: str) -> bool:
    """Whether ffmpeg's stream listing contains an audio stream."""
    return bool(AUDIO_STREAM_RE.search(stderr or ""))


def parse_progress_size(text: str) -> int | None:
    """The last size=...kB ffmpeg progress value, in bytes."""
    matches = PROGRESS_SIZE_RE.findall(text or "")
    return int(matches[-1]) * 1024 if matches else None


def parse_progress_time(text: str) -> float | None:
    """The last time=HH:MM:SS.ss ffmpeg progress value, in seconds."""
    matches = PROGRESS_TIME_RE.findall(text or "")
    if not matches:
        return None
    hours, minutes, seconds = matches[-1]
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def detect_encoders(
    ffmpeg: str,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> set[str]:
    try:
        result = runner(
            encoder_list_command(ffmpeg),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        print(f"warning: could not list ffmpeg encoders: {exc}", file=sys.stderr)
        return set()
    if result.returncode != 0:
        print(
            f"warning: ffmpeg -encoders failed:\n{_tail(result.stderr or result.stdout)}",
            file=sys.stderr,
        )
        return set()
    return parse_encoders(result.stdout)


def detect_leading_black(
    ffmpeg: str,
    source: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> tuple[float, float, float] | None:
    try:
        result = runner(
            blackdetect_command(ffmpeg, source),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        print(f"warning: blackdetect probe could not run: {exc}", file=sys.stderr)
        return None
    if result.returncode != 0:
        print(
            "warning: blackdetect probe failed; starting at 0:\n"
            f"{_tail(result.stderr)}",
            file=sys.stderr,
        )
        return None
    return parse_blackdetect(result.stderr)


def source_has_audio(
    ffmpeg: str,
    source: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> bool:
    """Inspect ffmpeg's stream listing (no ffprobe)."""
    try:
        result = runner(
            stream_probe_command(ffmpeg, source),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        print(f"warning: could not inspect the source's streams: {exc}", file=sys.stderr)
        return False
    stderr = result.stderr or ""
    if "Input #0" not in stderr:
        print(
            "warning: could not inspect the source's streams; encoding without audio",
            file=sys.stderr,
        )
        return False
    return parse_has_audio(stderr)


# ---------------------------------------------------------------- encode


def resolve_start(value: str, ffmpeg: str, source: Path) -> tuple[float, str]:
    """Resolve --start ('auto' skips a leading black segment > 1 s)."""
    if str(value).strip().lower() == "auto":
        segment = detect_leading_black(ffmpeg, source)
        if segment is not None:
            _start, end, duration = segment
            print(
                f"auto start: skipping {duration:.2f}s of leading black "
                f"(0.00s-{end:.2f}s)",
                file=sys.stderr,
            )
            return end, "auto"
        print("auto start: no leading black longer than 1s; starting at 0", file=sys.stderr)
        return 0.0, "auto"
    try:
        start = float(value)
    except (TypeError, ValueError) as exc:
        raise PipelineError(f"invalid --start {value!r}: use seconds or 'auto'") from exc
    if start < 0:
        raise PipelineError("--start must be non-negative")
    return start, "manual"


def encode(args: argparse.Namespace) -> int:
    source = Path(args.source)
    if not source.is_file():
        raise PipelineError(f"source video not found: {source}")
    slug = validate_slug(args.slug)
    out = Path(args.out) if args.out else Path(asset_name(slug))
    if out.suffix.lower() != ".mp4":
        raise PipelineError(f"--out must be an MP4 path (got {out})")
    if args.duration <= 0:
        raise PipelineError("--duration must be greater than zero")
    if not 0 <= args.crf <= 63:
        raise PipelineError("--crf must be between 0 and 63")
    if out.resolve() == source.resolve():
        raise PipelineError("--out must not overwrite --source")
    out.parent.mkdir(parents=True, exist_ok=True)

    ffmpeg = resolve_ffmpeg(args.ffmpeg, args.no_install)
    start, start_mode = resolve_start(args.start, ffmpeg, source)
    has_audio = source_has_audio(ffmpeg, source)
    available = detect_encoders(ffmpeg)
    encoder, codec, warning = choose_encoder(available, args.crf)
    warnings: list[str] = []
    if warning:
        warnings.append(warning)
        print(f"warning: {warning}", file=sys.stderr)

    command = encode_command(
        ffmpeg,
        source,
        out,
        start=start,
        duration=args.duration,
        crf=args.crf,
        encoder=encoder,
        has_audio=has_audio,
    )
    print(f"ffmpeg: encoding {source} -> {out}", file=sys.stderr)
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except OSError as exc:
        raise PipelineError(
            f"could not run ffmpeg ({ffmpeg}): {exc}\n"
            "Pass --ffmpeg <path>, set FFMPEG, or install ffmpeg on PATH."
        ) from exc
    if result.returncode != 0:
        raise PipelineError(
            f"ffmpeg encode failed (exit {result.returncode}):\n"
            f"{_tail(result.stderr)}\ncommand: {_command_text(command)}"
        )
    if not out.is_file():
        raise PipelineError(f"ffmpeg reported success but produced no file at {out}")

    size_bytes = parse_progress_size(result.stderr)
    if size_bytes is None:
        size_bytes = out.stat().st_size
        warnings.append("could not parse ffmpeg's final size; used the output file size")
    duration = parse_progress_time(result.stderr)
    if duration is None:
        duration = float(args.duration)
        warnings.append("could not parse ffmpeg's final duration; used --duration")

    over_size = size_bytes > BUDGET_BYTES
    over_duration = duration > BUDGET_SECONDS
    budget_ok = not over_size and not over_duration
    if over_size:
        warnings.append(
            f"clip is {size_bytes / (1024 * 1024):.2f} MB, over the 3 MB preview budget"
        )
    if over_duration:
        warnings.append(f"clip is {duration:.2f}s, over the 20 s preview budget")
    for message in warnings:
        print(f"warning: {message}", file=sys.stderr)

    codec_label = "AV1" if codec == "av1" else "H.264"
    report = {
        "source": str(source),
        "out": str(out),
        "slug": slug,
        "encoder": encoder,
        "codec": codec,
        "width": VIDEO_WIDTH,
        "height": VIDEO_HEIGHT,
        "fps": VIDEO_FPS,
        "start": round(start, 3),
        "start_mode": start_mode,
        "duration": round(duration, 3),
        "size_bytes": size_bytes,
        "has_audio": has_audio,
        "budget": {
            "max_bytes": BUDGET_BYTES,
            "max_seconds": BUDGET_SECONDS,
            "ok": budget_ok,
        },
        "warnings": warnings,
    }
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        size_note = "over budget" if over_size else "budget ok"
        duration_note = "over budget" if over_duration else "budget ok"
        print(f"encoded: {out}")
        print(f"  codec: {codec_label} ({encoder})")
        print(
            f"  size: {size_bytes / (1024 * 1024):.2f} MB ({size_bytes:,} bytes)"
            f" -- {size_note}"
        )
        print(f"  duration: {duration:.2f} s -- {duration_note}")
        print(f"  start: {start:.2f} s ({start_mode})")
        print(f"  audio: {'AAC 96 kbps' if has_audio else 'none'}")

    if args.strict and not budget_ok:
        print(
            "error: preview clip exceeds the 3 MB / 20 s budget (--strict)",
            file=sys.stderr,
        )
        return 1
    return 0


# ---------------------------------------------------------------- discussion body


def front_matter_value(lines: list[str], key: str) -> str | None:
    pattern = re.compile(rf"^{re.escape(key)}[ \t]*:[ \t]*(.*?)[ \t]*$")
    for line in lines:
        match = pattern.match(line)
        if not match:
            continue
        value = match.group(1).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value
    return None


def ensure_preview_video_line(front: list[str], url: str) -> list[str]:
    """Exactly one preview_video: line, after license: or at the end."""
    line = f"preview_video: {url}"
    existing = [
        index
        for index, value in enumerate(front)
        if re.match(r"^\s*preview_video\s*:", value)
    ]
    if existing:
        rebuilt: list[str] = []
        for index, value in enumerate(front):
            if index == existing[0]:
                rebuilt.append(line)
            elif index in existing:
                continue
            else:
                rebuilt.append(value)
        return rebuilt
    insert_at = len(front)
    for index, value in enumerate(front):
        if re.match(r"^\s*license\s*:", value):
            insert_at = index + 1
    return front[:insert_at] + [line] + front[insert_at:]


def preview_bullet(asset: str, url: str) -> str:
    return f"{BULLET_PREFIX} AV1 MP4, 720p, 25 fps \u2014 [{asset}]({url})"


def ensure_preview_bullet(body: str, bullet: str) -> str:
    """Exactly one visible '- Preview clip:' bullet in the body text."""
    lines = body.split("\n")
    existing = [
        index for index, value in enumerate(lines) if value.startswith(BULLET_PREFIX)
    ]
    if existing:
        lines[existing[0]] = bullet
        for index in reversed(existing[1:]):
            del lines[index]
        return "\n".join(lines)
    lead = 0
    while lead < len(lines) and not lines[lead].strip():
        lead += 1
    if lead == 0:
        lines[0:0] = ["", bullet, ""]
    else:
        lines[lead:lead] = [bullet, ""]
    return "\n".join(lines)


def patch_discussion_body(body: str, slug: str, asset: str, url: str) -> str:
    """Patch a Discussion body: front-matter value + visible bullet.

    Raises PipelineError when the body has no front matter or its wowsp-mod:
    slug does not match the requested slug.
    """
    text = (body or "").replace("\r\n", "\n").replace("\r", "\n")
    match = FRONT_MATTER_RE.match(text)
    if not match:
        raise PipelineError(
            "discussion body has no front matter (expected a leading '---' ... '---' block)"
        )
    front = match.group(1).split("\n")
    rest = text[match.end():]
    declared = front_matter_value(front, "wowsp-mod")
    if declared is None:
        raise PipelineError("discussion front matter has no 'wowsp-mod:' slug line")
    if declared != slug:
        raise PipelineError(
            f"slug mismatch: discussion declares wowsp-mod: {declared!r}, "
            f"but --slug is {slug!r}"
        )
    front = ensure_preview_video_line(front, url)
    rest = ensure_preview_bullet(rest, preview_bullet(asset, url))
    return "---\n" + "\n".join(front) + "\n---\n" + rest


# ---------------------------------------------------------------- gh commands


def upload_command(repo: str, tag: str, path: str | Path) -> list[str]:
    return ["gh", "release", "upload", tag, str(path), "--repo", repo, "--clobber"]


def release_assets_command(repo: str, tag: str) -> list[str]:
    return ["gh", "release", "view", tag, "--repo", repo, "--json", "assets"]


def delete_asset_command(repo: str, tag: str, name: str) -> list[str]:
    return ["gh", "release", "delete-asset", tag, name, "--repo", repo, "--yes"]


def run_gh(
    command: list[str], *, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as exc:
        raise PipelineError(
            "gh CLI not found; install GitHub CLI (https://cli.github.com/) "
            "and run 'gh auth login'"
        ) from exc
    if result.returncode != 0:
        raise PipelineError(
            f"'{_command_text(command)}' failed (exit {result.returncode}):\n"
            f"{_tail(result.stderr or result.stdout)}"
        )
    return result


def gh_graphql(query: str, variables: dict) -> dict:
    payload = json.dumps({"query": query, "variables": variables})
    result = run_gh(GH_GRAPHQL_COMMAND, input_text=payload)
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PipelineError(f"gh api graphql returned invalid JSON: {exc}") from exc
    errors = parsed.get("errors")
    if errors:
        message = "; ".join(
            str(entry.get("message", entry)) if isinstance(entry, dict) else str(entry)
            for entry in errors
        )
        raise PipelineError(f"GitHub GraphQL rejected the request: {message}")
    data = parsed.get("data")
    if not isinstance(data, dict):
        raise PipelineError("GitHub GraphQL returned no data")
    return data


def fetch_release_assets(repo: str, tag: str) -> list[dict]:
    result = run_gh(release_assets_command(repo, tag))
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PipelineError(f"gh release view returned invalid JSON: {exc}") from exc
    assets = parsed.get("assets")
    if not isinstance(assets, list):
        raise PipelineError(f"gh release view returned no asset list for {tag}")
    return assets


def fetch_discussion(repo: str, number: int) -> dict:
    owner, name = repo.split("/", 1)
    data = gh_graphql(
        DISCUSSION_QUERY, {"owner": owner, "name": name, "number": number}
    )
    repository = data.get("repository") or {}
    node = repository.get("discussion")
    if not isinstance(node, dict):
        raise PipelineError(f"discussion #{number} was not found in {repo}")
    return node


def update_discussion_body(discussion_id: str, body: str) -> dict:
    data = gh_graphql(
        UPDATE_MUTATION, {"input": {"discussionId": discussion_id, "body": body}}
    )
    node = (data.get("updateDiscussion") or {}).get("discussion")
    if not isinstance(node, dict):
        raise PipelineError("GitHub accepted updateDiscussion but returned no discussion")
    return node


# ---------------------------------------------------------------- publish


def stage_asset(
    file: Path, asset: str
) -> tuple[Path, tempfile.TemporaryDirectory | None]:
    """Return an upload path named asset, staging through a temp copy."""
    if file.name == asset:
        return file, None
    temp_dir = tempfile.TemporaryDirectory(prefix="wowsp-preview-")
    staged = Path(temp_dir.name) / asset
    shutil.copy2(file, staged)
    print(f"staged: {file} -> {staged}", file=sys.stderr)
    return staged, temp_dir


def publish(args: argparse.Namespace) -> int:
    slug = validate_slug(args.slug)
    repo = validate_repo(args.repo)
    tag = validate_tag(args.tag)
    asset = asset_name(slug)
    file = Path(args.file)
    if not file.is_file():
        raise PipelineError(f"preview file not found: {file}")
    digest = sha256_file(file)
    if args.sha256:
        expected = normalize_sha256(args.sha256)
        if digest != expected:
            raise PipelineError(
                f"sha256 mismatch: local file is {digest}, --sha256 says {expected}"
            )
        print(f"sha256: verified {digest}", file=sys.stderr)
    else:
        print(f"sha256: {digest}", file=sys.stderr)
    if repo != REPO_DEFAULT:
        print(
            f"warning: the catalog indexer only accepts preview clips under "
            f"{REPO_DEFAULT}; {repo} URLs will be dropped",
            file=sys.stderr,
        )
    url = release_url(repo, tag, asset)

    if args.dry_run:
        if not args.body_file:
            raise PipelineError(
                "--dry-run needs --body-file <path> (offline; no GitHub fetch)"
            )
        body = Path(args.body_file).read_text(encoding="utf-8")
        patched = patch_discussion_body(body, slug, asset, url)
        print(patched, end="" if patched.endswith("\n") else "\n")
        return 0
    if args.body_file:
        raise PipelineError("--body-file is only valid with --dry-run")
    if args.discussion is None:
        raise PipelineError("--discussion <number> is required to patch the thread")
    if args.discussion <= 0:
        raise PipelineError("--discussion must be a positive number")
    if args.ffmpeg_agnostic:
        print("publish: ffmpeg is not used (--ffmpeg-agnostic)", file=sys.stderr)

    try:
        fetch_release_assets(repo, tag)
    except PipelineError as exc:
        raise PipelineError(
            f"cannot read release {tag!r} on {repo}: {exc}\n"
            "Create the release first (scripts/mod_hub_publish.py release) "
            "or pass a different --tag."
        ) from exc

    staged, temp_dir = stage_asset(file, asset)
    try:
        run_gh(upload_command(repo, tag, staged))
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()

    assets = fetch_release_assets(repo, tag)
    match = next((entry for entry in assets if entry.get("name") == asset), None)
    if match is None:
        names = ", ".join(sorted(str(entry.get("name")) for entry in assets)) or "(none)"
        raise PipelineError(
            f"upload verification failed: {asset} is not on release {tag}; assets: {names}"
        )
    if "size" in match and int(match["size"]) != file.stat().st_size:
        raise PipelineError(
            f"uploaded asset size mismatch: release says {match['size']} bytes, "
            f"local file is {file.stat().st_size} bytes"
        )
    print(f"verified: {asset} on release {tag}")

    stem = Path(asset).stem
    strays = sorted(
        str(entry.get("name"))
        for entry in assets
        if entry.get("name")
        and entry.get("name") != asset
        and Path(str(entry.get("name"))).stem == stem
    )
    for name in strays:
        print(f"removing stray same-stem asset: {name}", file=sys.stderr)
        run_gh(delete_asset_command(repo, tag, name))
    if strays:
        fetch_release_assets(repo, tag)

    node = fetch_discussion(repo, args.discussion)
    patched = patch_discussion_body(node.get("body") or "", slug, asset, url)
    updated = update_discussion_body(str(node["id"]), patched)
    if int(updated.get("number", 0)) != args.discussion:
        raise PipelineError(
            f"GitHub updated discussion #{updated.get('number')} instead of "
            f"#{args.discussion}"
        )
    print(f"patched discussion #{args.discussion}: {updated.get('url', '')}")
    print(f"published {asset} -> {url}")
    return 0


# ---------------------------------------------------------------- selftest


def selftest() -> None:
    """Offline checks: no network, no ffmpeg, no gh."""
    repo = "langyo/wowsp"
    tag = "mod-hub"
    slug = "video.login.sea-monkey"
    asset = asset_name(slug)
    url = release_url(repo, tag, asset)

    # Asset naming and URL shape.
    assert asset == "preview-video.login.sea-monkey.mp4", asset
    assert url == (
        "https://github.com/langyo/wowsp/releases/download/mod-hub/"
        "preview-video.login.sea-monkey.mp4"
    ), url
    assert validate_slug(slug) == slug
    for bad in ("", "Video.Login", "../clip", "a b", "-clip", "clip-", "a..b"):
        try:
            validate_slug(bad)
        except PipelineError:
            pass
        else:
            raise AssertionError(f"slug should be rejected: {bad!r}")

    # Front-matter insertion after license, plus the visible bullet.
    body = (
        "---\n"
        f"wowsp-mod: {slug}\n"
        "version: 1.4.0\n"
        "category: video\n"
        "license: CC0-1.0\n"
        "---\n"
        "\n"
        "Body text.\n"
    )
    patched = patch_discussion_body(body, slug, asset, url)
    expected = (
        "---\n"
        f"wowsp-mod: {slug}\n"
        "version: 1.4.0\n"
        "category: video\n"
        "license: CC0-1.0\n"
        f"preview_video: {url}\n"
        "---\n"
        "\n"
        f"- Preview clip: AV1 MP4, 720p, 25 fps \u2014 [{asset}]({url})\n"
        "\n"
        "Body text.\n"
    )
    assert patched == expected, patched
    assert patched.count("preview_video:") == 1
    assert patched.count("- Preview clip:") == 1

    # Without a license line the value lands at the end of the front matter.
    no_license = patch_discussion_body(
        f"---\nwowsp-mod: {slug}\nversion: 1\n---\nbody\n", slug, asset, url
    )
    assert f"version: 1\npreview_video: {url}\n---\n" in no_license, no_license

    # Replacement: existing value and bullet are rewritten, duplicates drop.
    replaced_in = (
        f"---\nwowsp-mod: {slug}\nlicense: CC0-1.0\n"
        "preview_video: https://example.com/old.mp4\n"
        "preview_video: https://example.com/older.mp4\n"
        "---\n\n"
        "- Preview clip: old \u2014 [old.mp4](https://example.com/old.mp4)\n"
        "- Preview clip: duplicate\n"
        "\nTail.\n"
    )
    replaced = patch_discussion_body(replaced_in, slug, asset, url)
    assert replaced.count("preview_video:") == 1, replaced
    assert replaced.count("- Preview clip:") == 1, replaced
    assert f"preview_video: {url}" in replaced, replaced
    assert f"- Preview clip: AV1 MP4, 720p, 25 fps \u2014 [{asset}]({url})" in replaced
    assert "old.mp4" not in replaced and "duplicate" not in replaced, replaced

    # Refusals: no front matter, no slug line, slug mismatch.
    def expect_error(call: Callable[[], str], needle: str) -> None:
        try:
            call()
        except PipelineError as exc:
            assert needle in str(exc), exc
        else:
            raise AssertionError(f"expected PipelineError containing {needle!r}")

    expect_error(
        lambda: patch_discussion_body("no front matter here\n", slug, asset, url),
        "no front matter",
    )
    expect_error(
        lambda: patch_discussion_body("---\nversion: 1\n---\nbody\n", slug, asset, url),
        "wowsp-mod",
    )
    expect_error(
        lambda: patch_discussion_body(
            "---\nwowsp-mod: something.else\n---\nbody\n", slug, asset, url
        ),
        "slug mismatch",
    )

    # ffmpeg resolution order: explicit -> $FFMPEG -> PATH -> imageio ->
    # pip install + retry -> actionable failure.
    def no_installer() -> bool:
        raise AssertionError("installer must not run in this branch")

    assert resolve_ffmpeg(
        "explicit-ffmpeg",
        env={"FFMPEG": "env-ffmpeg"},
        which=lambda _name: "path-ffmpeg",
        imageio_getter=lambda: "imageio-ffmpeg",
        installer=no_installer,
    ) == "explicit-ffmpeg"
    assert resolve_ffmpeg(
        None,
        env={"FFMPEG": "env-ffmpeg"},
        which=lambda _name: "path-ffmpeg",
        imageio_getter=lambda: "imageio-ffmpeg",
        installer=no_installer,
    ) == "env-ffmpeg"
    calls: list[str] = []

    def which_path(name: str) -> str | None:
        calls.append(f"which:{name}")
        return "path-ffmpeg"

    assert resolve_ffmpeg(
        None,
        env={},
        which=which_path,
        imageio_getter=lambda: "imageio-ffmpeg",
        installer=no_installer,
    ) == "path-ffmpeg"
    assert calls == ["which:ffmpeg"], calls
    calls.clear()
    assert resolve_ffmpeg(
        None,
        env={},
        which=lambda _name: None,
        imageio_getter=lambda: "imageio-ffmpeg",
        installer=no_installer,
    ) == "imageio-ffmpeg"
    calls.clear()

    def imageio_after_install() -> str | None:
        calls.append("imageio")
        return "pip-ffmpeg" if calls.count("imageio") == 2 else None

    def installer() -> bool:
        calls.append("install")
        return True

    assert resolve_ffmpeg(
        None,
        env={},
        which=lambda _name: None,
        imageio_getter=imageio_after_install,
        installer=installer,
    ) == "pip-ffmpeg"
    assert calls == ["imageio", "install", "imageio"], calls
    try:
        resolve_ffmpeg(
            None,
            True,
            env={},
            which=lambda _name: None,
            imageio_getter=lambda: None,
            installer=no_installer,
        )
    except FfmpegNotFound as exc:
        assert "imageio-ffmpeg" in str(exc), exc
        assert "no usable ffmpeg" in str(exc), exc
    else:
        raise AssertionError("missing ffmpeg must raise FfmpegNotFound")

    # Parsers: encoder order, blackdetect, audio stream, progress values.
    encoders_output = (
        " V....D libaom-av1           libaom AV1 (codec av1)\n"
        " V..... libsvtav1            SVT-AV1 encoder (codec av1)\n"
        " V....D libx264              libx264 H.264 / AVC\n"
        " V....D libx265              libx265 H.265 / HEVC\n"
    )
    assert parse_encoders(encoders_output) == {
        "libsvtav1",
        "libaom-av1",
        "libx264",
    }, parse_encoders(encoders_output)
    assert choose_encoder({"libsvtav1", "libaom-av1", "libx264"}, 40)[:2] == (
        "libsvtav1",
        "av1",
    )
    assert choose_encoder({"libaom-av1", "libx264"}, 40)[:2] == (
        "libaom-av1",
        "av1",
    )
    fallback_encoder, fallback_codec, fallback_warning = choose_encoder(
        {"libx264"}, 40
    )
    assert (fallback_encoder, fallback_codec) == ("libx264", "h264")
    assert fallback_warning and "falling back" in fallback_warning
    assert parse_blackdetect(
        "[blackdetect @ 0x1] black_start:0 black_end:2.5 black_duration:2.5"
    ) == (0.0, 2.5, 2.5)
    assert parse_blackdetect(
        "[blackdetect @ 0x1] black_start:0 black_end:0.8 black_duration:0.8"
    ) is None
    assert parse_blackdetect(
        "[blackdetect @ 0x1] black_start:3 black_end:4.5 black_duration:1.5"
    ) is None
    assert parse_has_audio(
        "  Stream #0:1(und): Audio: aac (LC), 48000 Hz, stereo, fltp\n"
    )
    assert not parse_has_audio("  Stream #0:0: Video: h264, yuv420p\n")
    progress = (
        "frame=  1 time=00:00:00.04\r"
        "frame=300 size=  1024kB time=00:00:12.50 bitrate=1.0kbits/s\n"
    )
    assert parse_progress_size(progress) == 1024 * 1024
    assert parse_progress_size(
        "frame=25 fps=0.0 Lsize=     109KiB time=00:00:00.96"
    ) == 109 * 1024
    assert parse_progress_time(progress) == 12.5
    assert parse_progress_time("time=00:01:02.25") == 62.25
    assert parse_progress_size("no progress") is None
    assert parse_progress_time("no progress") is None

    # Exact argv rendering.
    assert encoder_list_command("ffmpeg") == [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-encoders",
    ]
    assert stream_probe_command("ffmpeg", "src.mp4") == [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-i",
        "src.mp4",
    ]
    assert blackdetect_command("ffmpeg", "src.mp4") == [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-i",
        "src.mp4",
        "-vf",
        "blackdetect=d=0.1:pix_th=0.10",
        "-an",
        "-f",
        "null",
        "-",
    ]
    assert codec_args("libsvtav1", 40) == [
        "-c:v",
        "libsvtav1",
        "-crf",
        "40",
        "-preset",
        "8",
    ]
    assert codec_args("libaom-av1", 40) == [
        "-c:v",
        "libaom-av1",
        "-crf",
        "40",
        "-cpu-used",
        "6",
        "-row-mt",
        "1",
    ]
    assert codec_args("libx264", 30) == [
        "-c:v",
        "libx264",
        "-crf",
        "30",
        "-preset",
        "medium",
    ]
    assert encode_command(
        "ffmpeg",
        "src.mp4",
        "out.mp4",
        start=2.5,
        duration=12,
        crf=40,
        encoder="libsvtav1",
        has_audio=True,
    ) == [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        "2.5",
        "-i",
        "src.mp4",
        "-t",
        "12",
        "-map",
        "0:v:0",
        "-vf",
        VIDEO_FILTER,
        "-c:v",
        "libsvtav1",
        "-crf",
        "40",
        "-preset",
        "8",
        "-pix_fmt",
        "yuv420p",
        "-map",
        "0:a:0",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-sn",
        "-dn",
        "-movflags",
        "+faststart",
        "out.mp4",
    ]
    assert encode_command(
        "ffmpeg",
        "src.mp4",
        "out.mp4",
        start=0,
        duration=12,
        crf=40,
        encoder="libaom-av1",
        has_audio=False,
    ) == [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        "0",
        "-i",
        "src.mp4",
        "-t",
        "12",
        "-map",
        "0:v:0",
        "-vf",
        VIDEO_FILTER,
        "-c:v",
        "libaom-av1",
        "-crf",
        "40",
        "-cpu-used",
        "6",
        "-row-mt",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-sn",
        "-dn",
        "-movflags",
        "+faststart",
        "out.mp4",
    ]

    # Exact gh argv rendering.
    assert upload_command(repo, tag, "C:/tmp/preview-clip.mp4") == [
        "gh",
        "release",
        "upload",
        tag,
        "C:/tmp/preview-clip.mp4",
        "--repo",
        repo,
        "--clobber",
    ]
    assert release_assets_command(repo, tag) == [
        "gh",
        "release",
        "view",
        tag,
        "--repo",
        repo,
        "--json",
        "assets",
    ]
    assert delete_asset_command(repo, tag, "preview-clip.mov") == [
        "gh",
        "release",
        "delete-asset",
        tag,
        "preview-clip.mov",
        "--repo",
        repo,
        "--yes",
    ]
    assert GH_GRAPHQL_COMMAND == ["gh", "api", "graphql", "--input", "-"]

    print("selftest ok")


# ---------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--selftest", action="store_true", help="run the offline self-test and exit"
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    encode_parser = sub.add_parser(
        "encode",
        help="cut and transcode a source video into the standard preview clip",
        description="Cut a clip, skip leading black, and encode AV1-in-MP4 at 720p/25 fps.",
    )
    encode_parser.add_argument("--source", required=True, help="source recording")
    encode_parser.add_argument("--out", help="output MP4 (default: preview-<slug>.mp4)")
    encode_parser.add_argument(
        "--slug", required=True, help="mod slug (for example video.login.sea-monkey)"
    )
    encode_parser.add_argument(
        "--start",
        default="auto",
        help="start offset in seconds, or 'auto' (default) to skip leading black",
    )
    encode_parser.add_argument(
        "--duration",
        type=float,
        default=12.0,
        help="clip length in seconds (default: 12)",
    )
    encode_parser.add_argument(
        "--ffmpeg",
        help="ffmpeg executable (default: $FFMPEG, PATH, then imageio-ffmpeg)",
    )
    encode_parser.add_argument(
        "--no-install",
        action="store_true",
        help="never pip-install imageio-ffmpeg when ffmpeg is missing",
    )
    encode_parser.add_argument(
        "--crf", type=int, default=DEFAULT_CRF, help=f"CRF (default: {DEFAULT_CRF})"
    )
    encode_parser.add_argument("--json", action="store_true", help="print a JSON report")
    encode_parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero when the 3 MB / 20 s budget is exceeded",
    )

    publish_parser = sub.add_parser(
        "publish",
        help="upload the clip and patch the Discussion front matter + bullet",
        description="Upload preview-<slug>.mp4 to the release, verify it, and patch the thread.",
    )
    publish_parser.add_argument("--repo", default=REPO_DEFAULT)
    publish_parser.add_argument("--tag", default=TAG_DEFAULT)
    publish_parser.add_argument("--file", required=True, help="local preview MP4")
    publish_parser.add_argument("--slug", required=True, help="mod slug")
    publish_parser.add_argument(
        "--discussion",
        type=int,
        help="Discussion number to patch (required unless --dry-run)",
    )
    publish_parser.add_argument(
        "--sha256", help="expected SHA-256 of the local file (verified before upload)"
    )
    publish_parser.add_argument(
        "--ffmpeg-agnostic",
        action="store_true",
        help="accepted for symmetry: publish never invokes ffmpeg",
    )
    publish_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the patched body; performs no network calls",
    )
    publish_parser.add_argument(
        "--body-file", help="offline Discussion body for --dry-run"
    )

    sub.add_parser("selftest", help="run the offline self-test")
    return parser


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    if args.command == "selftest":
        selftest()
        return 0
    if args.command == "encode":
        try:
            return encode(args)
        except PipelineError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    if args.command == "publish":
        try:
            return publish(args)
        except PipelineError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
