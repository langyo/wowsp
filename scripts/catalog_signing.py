#!/usr/bin/env python3
"""Ed25519 signing for the relay's release-digest docs (and, later, the
catalog/manifest envelopes).

Trust model: the app pins the PUBLIC keys at compile time
(`packages/app/tauri/res/keys/*.pub`, embedded via `include_str!`);
publish pipelines sign docs with the matching private seed. The relay
worker only transports the `key_id` + `sig` fields — every verification
happens in the app, so neither the worker, the KV store, nor a payload
mirror can forge a doc (they can at most replay an OLD signed doc,
which the per-channel `seq` ratchet refuses).

Canonical bytes (what gets signed) are the doc's JSON without the
`sig` member, keys sorted, compact separators, UTF-8 — byte-identical
to what the app reconstructs via serde_json's sorted Map rendering.
Every doc field that reaches the canonical form is ASCII (validated
upstream), so Python and Rust agree byte-for-byte.

Key ceremony (the private seed NEVER enters the repo — AGENTS.md §7):

    python scripts/catalog_signing.py genkey --key-id main \\
        --out-pub packages/app/tauri/res/keys/digest-main.pub \\
        --out-priv ~/.wowsp-signing/digest-main.key

Then: commit the `.pub`, wire it into `PINNED_DIGEST_KEYS` in
`packages/app/tauri/src/commands/release_digest.rs`, and export
`WOWSP_DIGEST_SIGNING_KEY=<contents of the .key file>` wherever docs
get published (locally, and as a repo secret for release.yml). A
backup key (`--key-id backup`) provides rotation: pin both, sign with
main, fall back to backup if the seed is ever lost.

Usage:
    python scripts/catalog_signing.py genkey ...   # as above
    python scripts/catalog_signing.py --selftest
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives import serialization

REPO_ROOT = Path(__file__).resolve().parent.parent
KEYS_DIR = REPO_ROOT / "packages/app/tauri/res/keys"

KEY_ID_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-")
SIG_B64_LEN = 88  # 64-byte Ed25519 signature, standard base64 + padding


def _die(msg: str) -> "SystemExit":
    return SystemExit(f"error: {msg}")


def valid_key_id(key_id: str) -> bool:
    """1–16 chars of `[a-z0-9-]` — mirrors the app's pinned-key ids."""
    return 1 <= len(key_id) <= 16 and set(key_id) <= KEY_ID_CHARS


# ── canonical form ─────────────────────────────────────────────────────


def canonical_bytes(doc: dict) -> bytes:
    """The signed bytes: the doc minus `sig`, sorted keys, compact JSON.

    Parity with the app: serde_json's Map (BTreeMap) renders keys in
    sorted order with no whitespace, exactly like `sort_keys=True,
    separators=(",", ":")`. Non-ASCII never reaches this form (channel,
    tag, asset names, digest hex, RFC 3339 timestamps are all ASCII by
    upstream validation), so `ensure_ascii=False` is byte-identical on
    both sides.
    """
    unsigned = {k: v for k, v in doc.items() if k != "sig"}
    return json.dumps(
        unsigned, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


# ── keys ───────────────────────────────────────────────────────────────


def load_private_seed(path: Path) -> bytes:
    text = path.read_text(encoding="utf-8").strip()
    try:
        seed = base64.b64decode(text, validate=True)
    except Exception as exc:  # noqa: BLE001 - surfaced as a CLI error
        raise _die(f"{path} is not a base64 seed file: {exc}") from exc
    if len(seed) != 32:
        raise _die(f"{path} seed is {len(seed)} bytes (wanted 32)")
    return seed


def genkey(key_id: str, out_pub: Path, out_priv: Path) -> None:
    if not valid_key_id(key_id):
        raise _die(f"bad key id {key_id!r} (1-16 chars of [a-z0-9-])")
    if out_pub.exists() or out_priv.exists():
        raise _die("refusing to overwrite an existing key file")
    private = Ed25519PrivateKey.generate()
    seed = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    out_priv.parent.mkdir(parents=True, exist_ok=True)
    # 0o600 from the first byte (os.open mode), not write-then-chmod —
    # no default-umask window for the seed on POSIX.
    fd = os.open(out_priv, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(base64.b64encode(seed).decode("ascii") + "\n")
    out_pub.parent.mkdir(parents=True, exist_ok=True)
    out_pub.write_text(base64.b64encode(pub).decode("ascii") + "\n", encoding="utf-8")
    print(f"wrote private seed {out_priv}  (KEEP OUT OF THE REPO)")
    print(f"wrote public key   {out_pub}   (commit this)")
    print(
        "next: pin the .pub in release_digest.rs PINNED_DIGEST_KEYS and export "
        "WOWSP_DIGEST_SIGNING_KEY with the seed where docs get published"
    )


# ── sign / verify ──────────────────────────────────────────────────────


def sign_doc(doc: dict, seed: bytes, key_id: str) -> dict:
    """Add `key_id` + `sig` to a copy of the doc (idempotent: any
    existing signature is re-signed over the canonical bytes)."""
    if not valid_key_id(key_id):
        raise _die(f"bad key id {key_id!r}")
    private = Ed25519PrivateKey.from_private_bytes(seed)
    payload = {k: v for k, v in doc.items() if k not in ("sig", "key_id")}
    payload["key_id"] = key_id
    sig = private.sign(canonical_bytes(payload))
    payload["sig"] = base64.b64encode(sig).decode("ascii")
    return payload


def verify_doc(doc: dict, pubkeys_b64: dict[str, str]) -> bool:
    key_id = doc.get("key_id")
    sig_b64 = doc.get("sig")
    if not isinstance(key_id, str) or not isinstance(sig_b64, str):
        return False
    pub_b64 = pubkeys_b64.get(key_id)
    if pub_b64 is None:
        return False
    try:
        pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(pub_b64, validate=True))
        sig = base64.b64decode(sig_b64, validate=True)
    except Exception:  # noqa: BLE001 - any decode failure is just "no"
        return False
    if len(sig) != 64:
        return False
    try:
        pub.verify(sig, canonical_bytes(doc))
    except Exception:  # noqa: BLE001
        return False
    return True


def sign_doc_from_env(doc: dict) -> dict | None:
    """Sign `doc` when WOWSP_DIGEST_SIGNING_KEY is exported, else return
    it unchanged (the app accepts unsigned docs while no key is pinned;
    once one is, publishes MUST sign)."""
    seed_b64 = os.environ.get("WOWSP_DIGEST_SIGNING_KEY", "").strip()
    if not seed_b64:
        return doc
    key_id = os.environ.get("WOWSP_DIGEST_SIGNING_KEY_ID", "main").strip()
    seed = base64.b64decode(seed_b64, validate=True)
    if len(seed) != 32:
        raise _die("WOWSP_DIGEST_SIGNING_KEY is not a 32-byte base64 seed")
    return sign_doc(doc, seed, key_id)


# ── selftest ───────────────────────────────────────────────────────────


def _selftest() -> None:
    assert valid_key_id("main") and valid_key_id("backup-2") and valid_key_id("k1")
    for bad in ("", "Main", "key with space", "toolongkeyiddddddddd"):
        assert not valid_key_id(bad), bad

    doc = {
        "channel": "app",
        "tag": "v0.6.2",
        "seq": 9,
        "generated_at": "2026-10-14T12:00:00Z",
        "assets": {"a.exe": "0" * 64, "b.exe": "f" * 64},
    }
    seed = Ed25519PrivateKey.generate().private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_b64 = base64.b64encode(
        Ed25519PrivateKey.from_private_bytes(seed)
        .public_key()
        .public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
    ).decode("ascii")

    signed = sign_doc(doc, seed, "main")
    assert signed["key_id"] == "main" and len(signed["sig"]) == SIG_B64_LEN
    assert verify_doc(signed, {"main": pub_b64})

    # Tampering any signed member breaks verification.
    for field, value in (
        ("tag", "v0.6.3"),
        ("seq", 10),
        ("assets", {"a.exe": "1" * 64}),
    ):
        tampered = dict(signed)
        tampered[field] = value
        assert not verify_doc(tampered, {"main": pub_b64}), field

    # Wrong key / unknown id / half-signed / unsigned all fail.
    assert not verify_doc(signed, {"other": pub_b64})
    assert not verify_doc({"key_id": "main"}, {"main": pub_b64})
    assert not verify_doc(doc, {"main": pub_b64})

    # Re-signing over an existing signature replaces it cleanly.
    resigned = sign_doc(signed, seed, "main")
    assert verify_doc(resigned, {"main": pub_b64})

    # The canonical form is exactly sorted-key compact JSON.
    assert canonical_bytes(signed) == json.dumps(
        {k: v for k, v in signed.items() if k != "sig"},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    print("selftest ok")


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--selftest", action="store_true")
    sub = parser.add_subparsers(dest="cmd")
    gen = sub.add_parser("genkey", help="generate a keypair (see the ceremony above)")
    gen.add_argument("--key-id", required=True)
    gen.add_argument("--out-pub", type=Path, required=True)
    gen.add_argument(
        "--out-priv",
        type=Path,
        required=True,
        help="private seed path — MUST live outside the repository",
    )
    args = parser.parse_args(argv)

    if args.selftest:
        _selftest()
    elif args.cmd == "genkey":
        genkey(args.key_id, args.out_pub, args.out_priv)
    else:
        parser.error("specify genkey or --selftest")


if __name__ == "__main__":
    main(sys.argv[1:])
