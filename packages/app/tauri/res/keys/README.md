# Release-digest signing keys

This directory holds the PUBLIC half of the Ed25519 keypairs that sign
the relay's release-digest docs (`/api/digests`, see
`packages/pairing-relay/crates/relay-core/src/digests.rs`). The app
embeds them at compile time (`PINNED_DIGEST_KEYS` in
`packages/app/tauri/src/commands/release_digest.rs` via `include_str!`), which
is what makes the KV store and the worker itself unable to forge a doc.

**Private seeds never enter this repository** (AGENTS.md §7).

**Current state (since 2026-10-14):** `main` + `backup` are generated
and pinned; a valid signature by a listed key is REQUIRED. The seeds
live at `~/.wowsp-signing/` on the maintainer's machine, and the
`WOWSP_DIGEST_SIGNING_KEY` repo secret carries the `main` seed for
release.yml (local publishes export the same value).

Restoring / rotating after a seed loss (the `backup` path needs no app
release — it is already pinned):

```sh
# sign with backup instead of main (local publish or secret swap):
export WOWSP_DIGEST_SIGNING_KEY="$(cat ~/.wowsp-signing/digest-backup.key)"
gh secret set WOWSP_DIGEST_SIGNING_KEY < ~/.wowsp-signing/digest-backup.key
```

Rotation forward = generate a new id (`genkey` below), pin it
alongside, sign with it, retire the old ids in a later release.

Fresh keypair ceremony (for a new id):

```sh
python scripts/catalog_signing.py genkey --key-id <id> \
    --out-pub packages/app/tauri/res/keys/digest-<id>.pub \
    --out-priv ~/.wowsp-signing/digest-<id>.key
# pin the .pub in release_digest.rs PINNED_DIGEST_KEYS, set/swap the secret,
# and land pin + secret in the same wave before the next release tag.
```

File format: one line, standard base64 of the 32 raw key bytes.
