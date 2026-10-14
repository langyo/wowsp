# Release-digest signing keys

This directory holds the PUBLIC half of the Ed25519 keypairs that sign
the relay's release-digest docs (`/api/digests`, see
`packages/pairing-relay/crates/relay-core/src/digests.rs`). The app
embeds them at compile time (`PINNED_DIGEST_KEYS` in
`packages/app/tauri/src/commands/update.rs` via `include_str!`), which
is what makes the KV store and the worker itself unable to forge a doc.

**Private seeds never enter this repository** (AGENTS.md §7). Ceremony:

```sh
# 1. generate a keypair — the private seed lands OUTSIDE the repo
python scripts/catalog_signing.py genkey --key-id main \
    --out-pub packages/app/tauri/res/keys/digest-main.pub \
    --out-priv ~/.wowsp-signing/digest-main.key

# 2. pin the public key (one line in update.rs)
#    ("main", include_str!("../../res/keys/digest-main.pub")),
#    → PINNED_DIGEST_KEYS, after which signed docs are REQUIRED

# 3. export the seed where docs get published
export WOWSP_DIGEST_SIGNING_KEY="$(cat ~/.wowsp-signing/digest-main.key)"
# (release.yml reads the same value from the WOWSP_DIGEST_SIGNING_KEY
#  repo secret; WOWSP_DIGEST_SIGNING_KEY_ID overrides the id, default
#  "main")
```

**Rollout ordering (the one rule that matters):** pinning the key and
setting the secret must land in the same wave, BEFORE the next release
tag. A build with an EMPTY pin list refuses signed docs (unknown key),
and a pin-carrying build refuses unsigned ones — cutting a release
either side of the flip only degrades the relay leg to the GitHub
fallback (CN users lose relay auto-update for that release), never a
hard brick, but keep the wave tight anyway.

Generate a `backup` keypair at the same time and pin BOTH while signing
with `main`: if a seed is ever lost, publishing switches to `backup`
with no app release needed. Rotation forward = generate a new id, pin
it alongside, sign with it, retire the old ids in a later release.

File format: one line, standard base64 of the 32 raw key bytes.
