# Threat Model & Trust Boundaries

> **Version**: 2026-10-23. This document is the review baseline the
> 2026-10-21 security audit asked for (its finding L-12): an inventory of
> what each input is treated as, where trust boundaries sit, and which
> guards enforce them. Review any PR that touches these boundaries against
> this page.

## Principles

1. **Everything crossing a boundary is untrusted until validated** — file
   paths, zip entries, HTTP headers and bodies, query strings, webview
   parameters.
2. **The main webview is the only privileged caller.** Secondary windows
   (`overlay`, `aim-card`, `tray-panel`) are event-only by design; the
   authoritative gated-command list lives in
   `scripts/check_rpc_parity.py::WINDOW_GATED_COMMANDS` (CI-enforced — the
   parameter alone is not enough, the `ensure_main_window_label` call is
   checked too). Deliberate exemptions are documented beside that list and
   in the gate's rustdoc (`commands/mod.rs`).
3. **Fail closed** on malformed, ambiguous, or unresolvable input; log the
   refusal where it is cheap, stay silent where logging would leak.

## Boundaries and what crosses them

### Game install ↔ app (read-mostly)

- **Untrusted**: anything under the game install (`replays/`, `bin/`,
  `res_mods/`, `profile/`). The game process may be running; files may be
  half-written (the live `temp.*` container) or replaced between stat and
  read.
- **Guards**: replay walks read the link itself, never traverse symlinks
  or Windows reparse points (junctions/mount points) — a planted link
  cannot redirect a listed or served file outside the tree; replay header
  reads are length-bounded; `appdata`-style path joins refuse `..`,
  absolute paths, drive-relative forms, NTFS alternate data streams,
  device names, and junctions (see `appdata.rs`).

### Mod Hub local installs (webview → game tree)

- **Untrusted**: the source folder is webview-named; zip contents are
  attacker-influenceable.
- **Guards**: the source must be a folder the **native folder dialog**
  handed out this session (`pick_source` grant registry, 1h sliding TTL,
  16-entry cap; grants under the app's own data tree are refused — that
  tree is webview-writable); the install plan is **derived server-side**
  by the same classifier the preview uses (the webview's plan copy is
  display-only); symlink/reparse entries abort the copy; zip extraction
  rides actual bytes with entry/per-file/total budgets plus a
  declared-size early abort; installs are journaled (temp+rename,
  mandatory pre-overwrite snapshots, full rollback).
- **Residual (accepted)**: a user who picks a folder containing a
  malicious Python mod installs exactly that — Python mods are the
  format's legitimate core, so content vetting is the user's and the
  catalog's job, not a local-install gate.

### LAN pairing (phone ↔ desktop)

- **Untrusted**: everything arriving on the pairing TCP port. The LAN is
  plaintext HTTP by design — assume a passive observer can read, and an
  active one can attempt, everything.
- **Guards**: OS CSPRNG 256-bit bearer tokens (constant-time compare,
  `Authorization: Bearer` only — the query channel is dead), 24h sliding
  TTL **capped at mint + 7 days absolute life** (a stolen actively-used
  token still dies within the week), per-IP PIN throttles before
  comparison, Origin refused + Host allowlist + Content-Type checks,
  64-connection / 32 KB-header / 8 KB-body / 60 s-deadline budgets, and a
  gamedata/replay serving path that walks links-free and serves only
  plain files.
- **Residual (accepted)**: the plaintext LAN channel itself — a passive
  sniffer sees responses and a token thief can use it until mint + 7
  days; pairing codes rotate and PIN throttles are per-IP. A future
  phase may add an encrypted transport.

### Cloudflare relay (worker, public internet)

- **Untrusted**: every request. The worker serves the public internet
  with no authentication on its public reads.
- **Guards**: closed route allowlist; KV/R2/DO key shape validation;
  Content-Length required up front (411) + per-route body caps before any
  buffering; Turnstile fail-closed on submission; per-IP budgets on
  public reads (429 + Retry-After, fail-closed on budget-write failure);
  ERP admin via Feishu-OAuth session (HMAC cookie, re-validated
  allowlist) or an empty-refused admin key; feedback ownership via
  one-time lookup tokens (hash-stored, constant-time compared) scoped to
  the minting record; Ed25519-signed release digests with monotonic
  sequence; QQ webhook signature verification (Ed25519 over
  timestamp+body) before parse; upload extract budgets (entries / bytes /
  ratio early abort).
- **Residual (accepted)**: the free tier's daily KV budgets are a real
  ceiling — public reads are rate-limited but a determined flood can
  still exhaust the day; edge-cached responses keep serving after the
  limiter closes.

### Update / release channel

- **Untrusted**: anything not produced by this repository's pipeline.
- **Guards**: release digests are Ed25519-signed (app-pinned keys,
  unsigned = refuse), monotonic `seq` (no rollback / no same-version
  reinstall confusion), strict version-string validation, and the release
  workflow requires the tagged commit's CI run green before publishing
  (`RELEASE_SKIP_PREFLIGHT` waives only for a recorded emergency).

### Telemetry

- Minimal anonymous usage events, switchable off in settings; the payload
  is documented in `docs/en/license/usage-telemetry.md` and carries no
  account identifiers.

## Known residuals (reviewed, accepted, re-checked each audit)

- `replay-admin` write endpoints rely on session/secret-key auth without
  a same-origin check (L-3-class depth).
- A replay-listing path that follows a link is refused at serve time, but
  the relay's `/api/replays` archive listing still walks its full store
  per request (bounded, budgeted).
- The pairing grant registry is path-level, not content-level: a source
  folder inside the app data tree is refused, but a picked folder
  elsewhere can change between preview and install (bounded by the grant
  TTL).
- The threat model itself is review baseline, not proof — re-read the
  guards, not the docs, when touching a boundary.
