#!/usr/bin/env python3
"""Publish release digests into the pairing relay's static digests tree.

The app updater's SECOND official channel: `wowsp.langyo.xyz` is
reachable where `api.github.com` is not, so every publish pipeline also
writes `{asset -> sha256}` docs into the tracked tree
`packages/pairing-relay/digests/<channel>/*.json` (served statically at
`GET /api/digests/<channel>[/<tag>]` from the worker's [assets] layer —
see `packages/pairing-relay/crates/relay-core/src/digests.rs`).

Channels and their publishers:

  app      `v*` tags          the maintainer, after a release lands
  mod-hub  `mod-hub`          scripts/mod_hub_publish.py (index stage)
  res      `res-latest`/deltas scripts/release_models.py (publish stage)
  data     `data-latest`      scripts/publish_data_pack.py (main)

File layout (see relay-core): `<channel>/<tag>.json` holds the pinned
doc, `<channel>/latest.json` the channel's rolling pointer; the site
build (scripts/build_worker_site.py) copies the tree verbatim to
`assets/api/digests/**` and generates the `_redirects` rules that map
the extensionless client paths onto these `.json` files. `seq` is
per-channel and strictly increasing — the app refuses regressions.

No credentials, no runtime storage (the 2026-10-22 KV read-quota
incident retired the KV store): publishing writes tracked files, and
they go live with the next deploy — commit + push (the Deploy Site
workflow carries them) or, for an immediate manual upload, run
`npx wrangler deploy` in packages/pairing-relay (the script also mirrors
into that checkout's live `assets/` tree when it exists). After adding a
channel's FIRST doc, add its two `!` negation entries to
run_worker_first in packages/pairing-relay/wrangler.toml (the site
build fails without them) and extend `DIGEST_PUBLISHED_CHANNELS`.

Requires `gh` when using `--from-gh-release`. Usage:

    python scripts/publish_digests.py --channel app --tag v0.6.2 \\
        --from-gh-release --latest
    python scripts/publish_digests.py --channel mod-hub --tag mod-hub \\
        --assets mod-index.json=<sha256> --latest
    python scripts/publish_digests.py --selftest
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Sibling module (same directory — sys.path[0] when run as a script).
import catalog_signing

REPO_ROOT = Path(__file__).resolve().parent.parent
REPO = "langyo/wowsp"

# Mirrors relay_core::digests::DIGEST_CHANNELS / valid_tag (the cap must
# cover the 139-char res-delta-<64hex>-<64hex> tags).
CHANNELS = ("app", "mod-hub", "res", "data")
TAG_RE = re.compile(r"^[A-Za-z0-9._-]{1,160}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def _die(msg: str) -> "SystemExit":
    return SystemExit(f"error: {msg}")


# ── validation (shared with the Rust side's rules) ─────────────────────


def validate_assets(assets: dict[str, str]) -> None:
    if not assets:
        raise _die("no assets to publish")
    for name, sha in assets.items():
        # Byte-length cap and control-char refusal mirror the worker's
        # doc_is_sane (U+007F–U+009F included) so a published doc can
        # never fail the worker's shape validation.
        encoded = name.encode("utf-8")
        if not 1 <= len(encoded) <= 128 or any(
            ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F for c in name
        ):
            raise _die(f"bad asset name {name!r}")
        if not SHA_RE.fullmatch(sha):
            raise _die(f"asset {name!r} digest is not a lowercase sha256 hex")


# ── doc assembly ───────────────────────────────────────────────────────


def now_rfc3339() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def build_doc(channel: str, tag: str, assets: dict[str, str], seq: int) -> dict:
    validate_assets(assets)
    return {
        "channel": channel,
        "tag": tag,
        "seq": seq,
        "generated_at": now_rfc3339(),
        "assets": dict(sorted(assets.items())),
    }


def next_seq(latest_doc: dict | None) -> int:
    return (latest_doc.get("seq", 0) + 1) if latest_doc else 1


# ── the tracked digests tree (the relay's static store) ────────────────

# Source of truth (tracked in git; the site build copies it onto the
# worker's [assets] layer) and the live assets mirror of a local
# checkout (gitignored build output — written too when it exists, so an
# immediate `npx wrangler deploy` serves the fresh doc without a full
# site rebuild).
DIGESTS_TREE = REPO_ROOT / "packages/pairing-relay/digests"
LIVE_ASSETS = REPO_ROOT / "packages/pairing-relay/assets/api/digests"


def read_latest(channel: str, tree: Path = DIGESTS_TREE) -> dict | None:
    """The channel's latest-pointer doc from the tree, or None."""
    latest = tree / channel / "latest.json"
    if not latest.is_file():
        return None
    try:
        return json.loads(latest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise _die(f"cannot read {latest}: {e}") from e


def write_doc(
    channel: str,
    stem: str,
    doc: dict,
    tree: Path = DIGESTS_TREE,
    live: Path | None = None,
) -> Path:
    """Write one doc as `<channel>/<stem>.json` (pretty, sorted keys).

    When `live` is given (the local checkout's assets mirror), the same
    file lands under `live/<channel>/` with the same name — the site
    build and this mirror keep the identical layout the worker's
    ASSETS-binding fetches expect (`latest.json` pointer, `<tag>.json`
    pinned docs).
    """
    dest_dir = tree / channel
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{stem}.json"
    dest.write_text(
        json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    if live is not None:
        live_dir = live / channel
        live_dir.mkdir(parents=True, exist_ok=True)
        (live_dir / dest.name).write_text(dest.read_text(encoding="utf-8"), encoding="utf-8")
    return dest


# ── the publish operation ──────────────────────────────────────────────


def publish(
    channel: str,
    tag: str,
    assets: dict[str, str],
    latest: bool,
    tree: Path = DIGESTS_TREE,
    live: Path | None = LIVE_ASSETS,
) -> dict:
    """Write the tag doc (and the latest pointer); returns the doc."""
    if channel not in CHANNELS:
        raise _die(f"unknown channel {channel!r} (one of {', '.join(CHANNELS)})")
    if not TAG_RE.fullmatch(tag) or tag == "latest":
        # `latest` is reserved: its `<tag>.json` would collide with the
        # pointer's own `latest.json` in the tree.
        raise _die(f"bad tag {tag!r}")
    if live is not None and not live.parent.parent.is_dir():
        # No local assets build in this checkout (e.g. CI): tracked
        # tree only.
        live = None

    current = read_latest(channel, tree)
    doc = build_doc(channel, tag, assets, next_seq(current))
    # Sign when key material is exported (WOWSP_DIGEST_SIGNING_KEY);
    # unsigned docs remain servable while the app has no pinned key.
    doc = catalog_signing.sign_doc_from_env(doc)
    write_doc(channel, tag, doc, tree, live)
    if latest:
        write_doc(channel, "latest", doc, tree, live)
    return doc


def push_if_configured(
    channel: str, tag: str, assets: dict[str, str], latest: bool = False
) -> dict | None:
    """Sibling-publisher hook: write into the tracked digests tree when
    a repository checkout is present, skip quietly otherwise (e.g.
    ephemeral CI), and raise loudly on a real failure (a half-published
    digest channel must never pass silently)."""
    if not DIGESTS_TREE.parent.is_dir():
        print(
            f"digest relay: no repository checkout — skipping the "
            f"/api/digests publish for {channel}:{tag}"
        )
        return None
    doc = publish(channel, tag, assets, latest)
    print(
        f"digest relay: published {channel}:{tag} "
        f"(seq {doc['seq']}, {len(assets)} assets"
        + (", latest)" if latest else ")")
    )
    return doc


# ── gh-backed asset collection ─────────────────────────────────────────


def assets_from_release(tag: str) -> dict[str, str]:
    proc = subprocess.run(
        ["gh", "api", f"repos/{REPO}/releases/tags/{tag}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise _die(f"gh api releases/tags/{tag} failed:\n{proc.stderr.strip()}")
    release = json.loads(proc.stdout)
    assets: dict[str, str] = {}
    for asset in release.get("assets", []):
        digest = asset.get("digest") or ""
        hex_sha = digest.strip().removeprefix("sha256:").lower()
        if not SHA_RE.fullmatch(hex_sha):
            print(
                f"warning: asset {asset.get('name')!r} carries no usable "
                "digest — skipped (GitHub computes digests on upload)"
            )
            continue
        assets[asset["name"]] = hex_sha
    return assets


# ── selftest ───────────────────────────────────────────────────────────


def _selftest() -> None:
    good = {"a.zip": "0" * 64, "b.zip": "f" * 64}
    validate_assets(good)

    for bad in (
        {"a.zip": "A" * 64},
        {"a.zip": "0" * 63},
        {},
        {"a\n": "0" * 64},
        # DEL and C1 controls sit above 0x20 — refused like the rest.
        {"a\x7f": "0" * 64},
        {"a\x9f": "0" * 64},
        # Byte-length cap, not char count.
        {"é" * 65: "0" * 64},
    ):
        try:
            validate_assets(bad)
        except SystemExit:
            pass
        else:
            raise AssertionError(f"validate_assets accepted {bad!r}")

    if not TAG_RE.fullmatch("res-delta-" + "a" * 64 + "-" + "b" * 64):
        raise AssertionError("the 139-char delta tag must be accepted")
    if TAG_RE.fullmatch("x" * 161):
        raise AssertionError("161 chars must be refused")

    assert next_seq(None) == 1
    assert next_seq({"seq": 41}) == 42

    doc = build_doc("app", "v0.6.2", good, 3)
    assert doc["seq"] == 3 and list(doc["assets"]) == ["a.zip", "b.zip"]
    assert set(doc) == {"channel", "tag", "seq", "generated_at", "assets"}

    # The file sink: publish into a temp tree + live mirror and check
    # the layout the site build and the worker's ASSETS fetches both
    # depend on — `<channel>/<tag>.json` and `<channel>/latest.json`,
    # mirrored verbatim.
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        tree, live = Path(tmp) / "tree", Path(tmp) / "live"
        doc = publish("app", "v0.6.2", good, True, tree, live)
        assert (tree / "app" / "v0.6.2.json").is_file()
        assert (tree / "app" / "latest.json").is_file()
        assert (live / "app" / "v0.6.2.json").is_file()
        assert (live / "app" / "latest.json").is_file()
        assert read_latest("app", tree)["seq"] == doc["seq"]
        # The seq ratchet reads the tree's own pointer: the next
        # publish advances.
        assert next_seq(read_latest("app", tree)) == doc["seq"] + 1
        try:
            publish("app", "latest", good, False, tree, live)
        except SystemExit:
            pass
        else:
            raise AssertionError("the reserved `latest` tag must be refused")

    print("selftest ok")


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--channel", choices=CHANNELS)
    parser.add_argument("--tag")
    parser.add_argument(
        "--from-gh-release",
        action="store_true",
        help="collect assets+digests from the GitHub release TAG via gh",
    )
    parser.add_argument(
        "--assets",
        action="append",
        default=[],
        metavar="NAME=SHA256",
        help="explicit asset digest (repeatable)",
    )
    parser.add_argument(
        "--latest",
        action="store_true",
        help="also move the channel's latest pointer",
    )
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)

    if args.selftest:
        _selftest()
        return
    if not args.channel or not args.tag:
        raise _die("--channel and --tag are required")
    if bool(args.from_gh_release) == bool(args.assets):
        raise _die("exactly one of --from-gh-release / --assets is required")

    if args.from_gh_release:
        assets = assets_from_release(args.tag)
    else:
        assets = {}
        for pair in args.assets:
            name, _, sha = pair.partition("=")
            assets[name] = sha

    doc = publish(args.channel, args.tag, assets, args.latest)
    print(
        f"published {doc['channel']}:{doc['tag']} seq={doc['seq']} "
        f"({len(assets)} assets{' +latest' if args.latest else ''})"
    )
    print(
        "next: commit the digests/ tree (the Deploy Site workflow ships "
        "it), or run `npx wrangler deploy` in packages/pairing-relay "
        "for an immediate upload; a first doc on a new channel also "
        "needs DIGEST_PUBLISHED_CHANNELS extended in wrangler.toml"
    )


if __name__ == "__main__":
    main(sys.argv[1:])
