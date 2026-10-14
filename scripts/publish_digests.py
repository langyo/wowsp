#!/usr/bin/env python3
"""Publish release digests to the pairing relay's `/api/digests` store.

The app updater's SECOND official channel: `wowsp.langyo.xyz` is
reachable where `api.github.com` is not, so every publish pipeline also
pushes `{asset -> sha256}` docs into the worker's `DIGESTS` KV namespace
(the worker serves them at `GET /api/digests/<channel>[/<tag>]` — see
`packages/pairing-relay/crates/relay-core/src/digests.rs`).

Channels and their publishers:

  app      `v*` tags          .github/workflows/release.yml (after publish)
  mod-hub  `mod-hub`          scripts/mod_hub_publish.py (index stage)
  res      `res-latest`/deltas scripts/release_models.py (publish stage)
  data     `data-latest`      scripts/publish_data_pack.py (main)

KV layout (see relay-core): `digest:<channel>:<tag>` holds the pinned
doc, `digest-latest:<channel>` the channel's rolling pointer. `seq` is
per-channel and strictly increasing — the app refuses regressions.

Credentials (env, never committed): `CLOUDFLARE_API_TOKEN` (a token
scoped to Workers KV Storage ▶ Edit on the one namespace is enough) and
`CLOUDFLARE_ACCOUNT_ID`. The namespace id is read from
`packages/pairing-relay/wrangler.toml` (binding `DIGESTS`).

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
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import toml
except ImportError:  # pragma: no cover - toml is in scripts/requirements.txt
    toml = None

REPO_ROOT = Path(__file__).resolve().parent.parent
WRANGLER_TOML = REPO_ROOT / "packages/pairing-relay/wrangler.toml"
REPO = "langyo/wowsp"
CF_API = "https://api.cloudflare.com/client/v4"
DIGEST_BINDING = "DIGESTS"

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


# ── Cloudflare KV transport ─────────────────────────────────────────────


def namespace_id() -> str:
    if toml is None:
        raise _die("the `toml` package is required (scripts/requirements.txt)")
    config = toml.loads(WRANGLER_TOML.read_text(encoding="utf-8"))
    for ns in config.get("kv_namespaces", []):
        if ns.get("binding") == DIGEST_BINDING:
            return str(ns["id"])
    raise _die(
        f"binding {DIGEST_BINDING} not found in {WRANGLER_TOML} — "
        "create the namespace and uncomment the block first "
        "(packages/pairing-relay/README.md ▶ Deploy)"
    )


def _cf_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def kv_get(token: str, account: str, ns: str, key: str) -> dict | None:
    """The value stored under `key`, or None when the key is absent."""
    quoted = urllib.parse.quote(key, safe="")
    url = (
        f"{CF_API}/accounts/{account}/storage/kv/namespaces/{ns}"
        f"/values/{quoted}"
    )
    req = urllib.request.Request(url, headers=_cf_headers(token))
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        body = e.read().decode("utf-8", "replace")[:300]
        raise _die(f"kv get {key!r}: HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise _die(f"kv get {key!r}: {e.reason}") from e


def kv_put(token: str, account: str, ns: str, key: str, doc: dict) -> None:
    quoted = urllib.parse.quote(key, safe="")
    url = (
        f"{CF_API}/accounts/{account}/storage/kv/namespaces/{ns}"
        f"/values/{quoted}"
    )
    body = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
    req = urllib.request.Request(
        url, data=body, headers=_cf_headers(token), method="PUT"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        if not payload.get("success"):
            raise _die(f"kv put {key!r}: cloudflare rejected: {payload}")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")[:300]
        raise _die(f"kv put {key!r}: HTTP {e.code}: {text}") from e
    except urllib.error.URLError as e:
        raise _die(f"kv put {key!r}: {e.reason}") from e


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


# ── the publish operation ──────────────────────────────────────────────


def publish(
    channel: str,
    tag: str,
    assets: dict[str, str],
    latest: bool,
    token: str | None = None,
    account: str | None = None,
) -> dict:
    """Write the tag doc (and the latest pointer); returns the doc."""
    if channel not in CHANNELS:
        raise _die(f"unknown channel {channel!r} (one of {', '.join(CHANNELS)})")
    if not TAG_RE.fullmatch(tag):
        raise _die(f"bad tag {tag!r}")
    token = token or os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = account or os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not account:
        raise _die("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set")
    ns = namespace_id()

    current = kv_get(token, account, ns, f"digest-latest:{channel}")
    doc = build_doc(channel, tag, assets, next_seq(current))
    kv_put(token, account, ns, f"digest:{channel}:{tag}", doc)
    if latest:
        kv_put(token, account, ns, f"digest-latest:{channel}", doc)
    return doc


def push_if_configured(
    channel: str, tag: str, assets: dict[str, str], latest: bool = False
) -> dict | None:
    """Sibling-publisher hook: skip quietly without credentials, publish
    with them, and raise loudly on a real failure (a half-published
    digest channel must never pass silently)."""
    if not os.environ.get("CLOUDFLARE_API_TOKEN") or not os.environ.get(
        "CLOUDFLARE_ACCOUNT_ID"
    ):
        print(
            f"digest relay: no Cloudflare credentials — skipping the "
            f"/api/digests push for {channel}:{tag}"
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

    sample = """
[[kv_namespaces]]
binding = "FEEDBACK_KV"
id = "111"

[[kv_namespaces]]
binding = "DIGESTS"
id = "abc123"
"""
    if toml is None:
        raise _die("the `toml` package is required (scripts/requirements.txt)")
    parsed = toml.loads(sample)["kv_namespaces"]
    match = [n for n in parsed if n.get("binding") == DIGEST_BINDING]
    assert match and match[0]["id"] == "abc123"

    assert urllib.parse.quote("digest:app:v0.6.2", safe="") == (
        "digest%3Aapp%3Av0.6.2"
    )

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


if __name__ == "__main__":
    main(sys.argv[1:])
