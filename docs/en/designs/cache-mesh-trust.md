# Cache-mesh trust — client-reported results, settlement, and the node console

> Status: contract (v1 proposal). Extends `cache-mesh.md` (read that
> first). Everything here is the design for the SECOND mesh wave:
> letting CLIENTS report lookup results into the cache without letting
> anyone poison it, plus the operator console that supervises it.
> English + zh-CN, like the other design docs.

## 1. The problem

Wave 1 nodes only cache what they fetch THEMSELVES (the lookup proxy
fill) or pull from peers (CID-consistent, but honest-content-trusted).
That leaves the biggest asset unused: **hundreds of game clients that
already fetch the upstreams natively** — CN players reach
vortex.wowsgame.cn fast at evening peak precisely when the official
edge node cannot. If clients reported what they fetched, every player's
slow cold miss would warm the cache for everyone after them.

The obstacle is trust: a report is attacker-controlled input claiming
"this is what upstream served". This document pins the anti-poisoning
design.

## 2. Design decisions (and why)

Three candidate mechanisms were considered:

1. **Quorum of independent reporters** ("三个不同来源确认") — adopted
   as the *silver* tier, refined: agreement must be over the exact
   content hash, from ≥3 distinct reporter keys AND ≥2 distinct IP
   subnets (one machine with many keys cannot settle anything), each
   reporter above the reputation floor, no competing settled mapping.
2. **Server-issued queries as the anchor** — adopted as the *gold*
   tier, with one premise corrected: serverless platforms CAN fetch
   upstreams (our Worker already does); the real constraint is
   geo-reachability and cost, not platform. So the **settler** runs
   everywhere (native background task, Worker cron, Vercel cron), and
   per-host reachability telemetry decides when quorum is the only
   path. A server fetch settles instantly and outranks any quorum.
3. **Nickname / clan-name whitelists** — rejected as the primary
   mechanism (impersonation, privacy, maintenance burden); replaced by
   cryptographic reporter identity + reputation + optional reporter
   gates (password/OAuth/trusted-list) for private nodes.

Tier summary (the served envelope gains `tier`):

| Tier | Meaning | How it got there | Servable? |
| --- | --- | --- | --- |
| `gold` | server-verified | this node fetched the upstream itself | yes |
| `silver` | quorum-settled | §4 settlement rules | yes (`x-wowsp-cache: quorum`) |
| `bronze` | candidate | 1–2 attestations, unverifiable so far | only as `unverified: true` |
| disputed | conflict | two hashes both reached quorum | never — fall to upstream, console decides |

Wave-1 blocks (server-fetched) are `gold` by definition; peer pulls
inherit the source row's tier (a peer's silver stays silver).

## 3. Reporter identity

- The client generates an **Ed25519 keypair once**, persists it, and
  enrolls the public key at each node it reports to:
  `POST /api/reports/enroll {pubKey}` → `{reporterId}` (the key
  fingerprint, 16 hex). No accounts, no nicknames, no personal data.
- Every report is **signed** over
  `line || contentHash || fetchedAt || nonce`; the node verifies the
  signature before anything else. The nonce (node-issued per reporter,
  monotonic) kills replay.
- Subnet diversity is computed server-side from the report's source
  address (/24 for v4, /64 for v6), stored TRUNCATED (diversity math +
  abuse views only — the console never shows full addresses).
- Optional reporter gates (node policy, per the self-host audience):
  `open` (default) | `password` (the node's gateway password re-used)
  | `trusted` (admin-curated reporterId allowlist — the closest
  descendant of the nickname-whitelist idea, for legion nodes).

## 4. Settlement rules

A report is `{line, contentHash, bodyB64?, fetchedAt, sig, reporterId}`.
Candidates are keyed `(cid, contentHash)`; identical re-attestations
are idempotent (one reporter cannot inflate a hash's count).

A cid → contentHash mapping becomes **silver** when ALL hold:

- ≥ `REPORT_QUORUM` (default 3) distinct reporterIds attest that hash;
- they span ≥ `REPORT_SUBNET_DIVERSITY` (default 2) distinct subnets;
- every counted reporter has reputation ≥ −2;
- the attestations' `fetchedAt` all fall inside the entry's TTL window
  (a stale-but-once-true hash cannot ride old timestamps);
- no OTHER hash for the same cid currently holds silver/gold.

Any moment two hashes both satisfy quorum, the cid flips to
**disputed**: nothing is served for it (clients fall to upstream), the
row surfaces in the console, and the settler prioritizes it. An
admin can also adjudicate manually (settle-to-hash or discard both).

Reputation events: +1 to each reporter whose hash a later server
fetch confirms; −2 when a server fetch contradicts it; ban at score
< −5 or by console action. Slashed reporters' attestations stop
counting toward quorum.

## 5. Wire surface

```
POST /api/reports/enroll    {pubKey}                       → {reporterId}
POST /api/reports/submit    (the signed report, body ≤ 8 MiB, allowlisted line)
GET  /api/reports/status?cid=<cid>                          → tiers, hashes, counts
GET  /api/blocks/<cid>     envelope gains tier + attestation summary
```

- The report line must pass the SAME §3.2 host allowlist and caps as
  the lookup proxy; bodies over cap are rejected, not truncated.
- Rate limits: `REPORT_RATE_PER_HOUR` (default 60) per reporterId and
  per IP; 429 + retry-after as everywhere else.
- Served responses mark provenance in `x-wowsp-cache`:
  `hit | miss | peer-hit | quorum | unverified`. Clients surface
  `quorum`/`unverified` in the diagnostics row and treat
  `unverified` as display-grade (a user-initiated refresh always
  goes to the direct chain).

## 6. The settler

- **Native**: background task, `WOWSP_SERVER_SETTLER` (default on) —
  every few minutes settle the hottest unsettled cids + the oldest
  disputes by fetching upstream directly (the §3.1 proxy core, re-used).
- **Worker**: a cron trigger (10 min; the sponsors cron pattern),
  budget-capped per run; records per-host reachability. Hosts judged
  unreachable from the edge for 24 h stop being settled server-side —
  quorum becomes their only path and the console says so.
- **Vercel**: `vercel.json` cron (Hobby allows once a day — quorum is
  the workhorse there; Pro raises it).
- Every settler fetch doubles as a reputation oracle (§4).

## 7. Client behavior (the reporting side)

- After a SUCCESSFUL direct-path lookup (the §6.2 fallback chain, or
  any first-party upstream fetch — never a cache-served response, the
  `x-wowsp-cache` header prevents self-echo loops), the client reports
  the result to its FIRST cache server: enroll (once per node), then
  sign + submit, fire-and-forget on a background task, ≤ 8 MiB, 2xx
  JSON bodies only, silent-fail.
- Reports are anonymous (§3): the payload is exactly what the public
  upstream served, keyed by the public request line.
- The settings pane's cache card discloses the reporting behavior in
  one sentence next to the existing mesh toggle.

## 8. Node console (the /erp upgrade)

The existing hikari console (packages/console: Feishu OAuth → signed
session cookie → allowlist) becomes the **node console** by adding a
`缓存网格` section; the feedback/ERP views stay official-only:

- **总览** — block counts per tier, dispute queue depth, reporter
  census, per-host settler reachability (last 24 h success %), serve
  rates by provenance.
- **上报者** — one row per reporterId: first/last seen, truncated
  subnet summary, reports accepted / settled / contradicted / slashed,
  reputation score; actions: 降权 / 封禁 / 解封; subnet-level 收紧
  (raise that subnet's effective quorum by 1).
- **候选与争议** — disputed cids with each competing hash's
  attestation detail; actions: 立即复核 (trigger settler now) /
  人工裁定 (settle-to-hash) / 全部丢弃.
- **Peer 治理** — the announced-peer list with hide/blocklist and the
  announce log (who announced what, from which subnet, when).
- **策略** — quorum / diversity / rate knobs, reporter gate mode,
  reports on/off; changes are node vars with console-plumbed
  overrides stored in the admin KV row.

Authentication on self-hosts (no Feishu there): a first-run
**console token** is minted into the data dir and printed once (same
pattern as the feedback lookup token); the login view accepts it and
mints the same signed session cookie. `CONSOLE_TOKENS` (multi-admin)
via env. The official node keeps Feishu OAuth. The feedback view on a
self-host is hidden unless `FEEDBACK_SELFHOST=1` — and even then it
only LINKS to the official console, because the pipeline writes to
the official node's Feishu tenant by design (self-hosting a feedback
inbox nobody reads is not worth the surface).

## 9. Abuse budget summary

| Vector | Bound |
| --- | --- |
| Poisoned block | needs 3 keys + 2 subnets + reputation ≥ −2 on ALL of them, or one server-fetch contradiction kills it; disputed mappings never serve |
| Sybil keys | subnet diversity + per-subnet reporter caps + enrollment rate limits (10/h/IP) |
| Reputation farming | gains only on server-confirmed settles; settler is the only +1 source |
| Replay | per-reporter monotonic nonce in the signed envelope |
| Memory/storage | candidates expire with the entry TTL + grace; bodies over cap rejected; disputes expire in 48 h |
| Console takeover | same session-cookie + allowlist model as /erp today; self-host token minted server-side |
| Traffic | report rate limits per reporter AND per IP; body caps; settler budget caps |

## 10. Rollout

- T1 — relay-core report/quorum/reputation policy + Worker
  (`ReportLedger` SQLite DO for candidates + R2 bodies + endpoints +
  settler cron) + native (same policy over SQLite + settler task) +
  Vercel (Upstash). Reports ship DISABLED by default
  (`REPORTS_ENABLED`), enabled on the official node after a soak.
- T2 — client: keypair + enroll + signed report after direct fetches.
- T3 — console upgrade (mesh views, self-host token auth, feedback
  self-host link-mode).
- T4 — docs wave (guide + this file's zh-CN twin already shipped).
