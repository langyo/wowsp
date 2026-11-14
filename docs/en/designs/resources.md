# Runtime Resource Registry

> Single source of truth for everything the app downloads or manages at
> runtime. The machine-readable twin lives in
> `packages/app/tauri/src/commands/resources.rs` (`REGISTRY`), and the
> Settings → resources details panel renders its walk (`resources_status`).

## Compatibility rule

The **app-update channel is frozen**: old clients must be able to reach new
versions through it, so its manifest/stamp flow is never reformatted. Every
other row below ships only to current clients and may reformat freely —
users must update the app to receive new resource content anyway.

## The registry

| id | kind | channel | trigger | progress | what it is | where it lands |
| --- | --- | --- | --- | --- | --- | --- |
| `app-update` | update | `app` | user | `update` | The app's own installer (GitHub `v*` + mirror ladder). **Read-only row.** | downloaded temp → installer |
| `res-pack` | pack | `res` | user | `res-pack` | The resource pack: 3D ship models, dog-tag avatars, optional insights tree. Content-addressed by tree hash; chain patches (`res-delta-*`) keep updates small. | `%LOCALAPPDATA%/WoWSP/{models,dogtags,insights}` |
| `data-kit` | dataset | `data` | boot | silent | The Tab overlay's consumable kit (~15 KB). | `%APPDATA%/WoWSP/data-pack/ship-consumable-kit.json` |
| `data-ship-gameparams` | dataset | `data` | boot | silent | Both realms' GameParams slices as a zip (~15 MB) — serves the armor/ballistics/sonar panel without any game install. | `%APPDATA%/WoWSP/data-pack/ship-gameparams.zip` |
| `mod-catalog` | index | `mod-hub` | on-demand | silent | The mod-hub catalog index (TTL cache, refreshed on view load). | in-memory + TTL cache |
| `cache-image-cache` | cache | — | passive | — | WG CDN ship portraits fetched through the `media://` proxy. | `%LOCALAPPDATA%/WoWSP/image-cache` |
| `cache-gameparams` | cache | — | pairing | — | Per-ship GameParams slices (install unpacks, pairing sync, bulk fill). | `%APPDATA%/WoWSP/gameparams` |
| `cache-encyclopedia` | cache | — | passive | — | Encyclopedia bundle cache. | `%APPDATA%/WoWSP/encyclopedia` |
| `cache-community` | cache | — | passive | — | Community/trends data cache. | `%APPDATA%/WoWSP/community` |
| `decisions-pack` | pack | `ai` | boot | `ai-models` | The Hugging Face published decision models (ONNX fire/move/advice/torpedo, the attribute table, optional LOS rasters). One signed manifest pins the Hub commit and every file sha256; per-file downloads install into the pack directory. | `%LOCALAPPDATA%/WoWSP/decisions` |
| `bundled-lesta` | bundled | — | static | — | The Lesta-only slice snapshot compiled into the binary (`include_bytes!`). | inside the app binary |

## Shared infrastructure

- **Download hub** (`commands/download_hub.rs`): one FIFO queue, the
  GitHub mirror ladder, streaming sha256, byte caps, cancellation, and the
  single `wowsp://download-progress` event every UI subscribes to.
- **Download context** (`packages/webui/src/stores/downloads.ts`): the webui
  layer ABOVE that event, and the one place a pass is presented. It owns the
  CONTEXT REGISTRY (one row per bus kind: presentation, label, cancel verb),
  the PASS LEDGER (one `ResourcePass` per kind, fed by the ticks and gated by
  the owning command's lifetime, so "is this running?" has exactly one
  answer), the PASS LIFECYCLE (`track` raises / folds / settles a pass and
  keeps a user cancel neutral) and the PRESENTATION DECISION. See
  "Presentation" below.
- **Mirror context** (`commands/mirror/`): the provider registry behind
  every download candidate — GitHub's ghproxy prefix rewrite and the
  Hugging Face endpoint substitution (user endpoints, then the built-in
  mainland mirrors, then the official route).
- **Signed model manifest** (`commands/ai_pack.rs` + `release_digest`'s
  pinned Ed25519 keys): the `ai` channel fetches `manifest.json` from the
  Hugging Face repository `langyo/wowsp-d1`, verifies the signature and
  the `seq` ratchet, downloads each file at the pinned Hub commit and
  installs only after the tree hash and ONNX shapes match.
- **Signed digests** (`commands/release_digest.rs`, served by the pairing
  relay at `/api/digests/<channel>`): the `app` / `mod-hub` / `res` /
  `data` channels pin official content hashes and refuse regressions.
- **Machine scopes** (`tauri_shared::resource`): the clearable cache
  roots behind the Settings panel's aux-cache rows.

## Presentation

A download is a GLOBAL event, not a property of the panel it was started from,
so progress renders in ONE place: the top-right `DownloadToast` card. Never
inline in a Settings pane, and never a second bespoke card — an earlier revision
had three cards (`UpdateToast`, `ModUpdateToast`, the shared one) and the split
itself was the bug: three mount machines, three ways for "is it running?" to go
stale, and a decision-model bar stranded in the middle of the resources pane.

| kind | presentation | source | surface |
| --- | --- | --- | --- |
| `update` | card | bus | the shared `DownloadToast` (mirror race → stream → installer hand-off) |
| `res-pack` | card | bus | the shared `DownloadToast` |
| `ai-models` | card | bus | the shared `DownloadToast` |
| `mod-package` | card | owner | the shared `DownloadToast` (the owner pushes the batch's overall percent) |
| `data-pack` | silent | none | nothing — a boot-time lane behind the settings card's stamp |

**Two sources of numbers.** `bus` contexts fold the unified progress ticks (one
artifact, one stream). `owner` contexts PUSH their pass with `report()`, which
is the batch shape: several artifacts behind one overall percent, so a raw
per-file tick cannot be the card's number. Either way the ledger is the only
thing the card reads, and `busyFor(kind)` is the single answer to "is this
running?" — no surface derives it from a phase.

A new downloadable resource adds a registry row and nothing else: it inherits
the card, the mount grace, the outcome toasts and (when it declares a cancel
verb) the cancel action. A new settings card must NOT grow its own progress
bar: settings cards keep the management verbs and gate their buttons on
`downloads.busyFor(kind)`.

The shared card's contract:

- **Raise on the ledger, not on a tick.** The owning command's lifetime is the
  truth (`track`, or `begin`/`settle` for an owner), so a queued or stalled
  pass — no bytes yet — still shows. A tick for a context nobody raised is
  ignored, so a stray producer cannot paint a ghost card.
- **One row shape for both kinds of pass**: HEADLINE (the resource, or the batch
  item a pass is on), STEP line (the phase verb, or the owner's step text), the
  never-shrinking meta (`% · rate · ETA`) and one fraction. That is everything
  the retired cards showed.
- **Mount grace** (`DOWNLOAD_CARD_GRACE_MS`, 400 ms): a pass that lands inside
  it never mounts the card — its outcome is the toast instead (a
  flash-in/flash-out reads as a glitch, and "already current" is the most
  common shape).
- **Fold-out, not snap-away**: the terminal pass keeps the card mounted for the
  leave transition, serving a frozen snapshot (real text, real progress).
- **One cancel**: only a context that declares a registry cancel verb offers
  one, and it runs through `downloads.cancel(kind)`. A cancel is not a failure
  — the pass settles neutrally and no error toast fires. The batch declares no
  verb (catalog writes are atomic), so it simply runs to completion.
- **One error line**: the failure text stays in the owning settings card (beside
  the button that retries it) via `downloads.errorFor(kind)`; the card folds
  out and a toast carries the reason, because a folded card cannot be read.

## Settings pane hierarchy

The panel is player-first (2026-11-14 rework): it answers "do I need to do
anything?" before it shows any per-resource detail. It used to be the
opposite — the audit table sat on top and eleven individually managed
mini-cards with seventeen visible verbs sat below it.

1. **Status card** — a tone rail + one sentence (ready / not checked yet /
   updates available / something missing), the on-disk footprint and the
   panel's check verb. TWO contextual verbs grow out of the same slot: a
   download when the resource pack itself is missing, and UPDATE ALL when a
   check already reported pending updates — one click queues every pending
   pass (the download hub is a strict FIFO, so the pack and the decision
   models queue in arrival order; each pass keeps its own cancel on the
   shared card, and the res-pack half re-checks the app-first gate). The
   rows repeat their own verbs in their natural places; every path calls the
   same store methods, so they cannot diverge. "Ready" is only claimed when
   BOTH the walk's ledger stamps and the res manifest snapshot were refreshed
   this session; "not checked yet" is a first-class state, because the
   numbers arrive from five sources with five freshness rules (the walk's
   ledger stamps, the res manifest snapshot, the AI manifest's 24h TTL, the
   app updater, the capability probe). A pending app update is explained
   here with no verb of its own: the app update comes first, and only the
   RESOURCE PACK waits for it — the decision-model pack rides its own signed
   channel.
2. **Family card** — four rows (game data / resource pack / decision models /
   caches), at most ONE verb each, because same-family items are the same
   action. The ship-data datasets are the boot-time lane the shell's refresh
   entry covers; the mod-hub index is ON DEMAND and not part of that plan, so
   the status card's check forces it client-side before re-reading it. The
   game-data row therefore carries no verb of its own — it shows the freshest
   of the two stamps. The four clearable caches clear behind one two-step
   confirm (`clear_aux_cache` run per scope in a front-end loop — no new
   command, so the per-scope rows in the details panel cannot diverge from
   the family row on the wire). The resource pack's single slot switches role
   with its state (download → integrity check → update) and keeps the
   app-first gate; it only grows an update verb once a manifest actually
   reported one. Raw current/latest hashes, the pack version stamp and the
   legacy flag stay VISIBLE in the details window (the row chip also carries
   them as a tooltip — hover alone would hide them from keyboards and screen
   readers).
3. **Details window** — the audit table, the per-cache controls, the AI
   runtime's technical facts and the destructive deletes open as a CHILD
   WINDOW from a quiet entry row, stacked through the shared popup context
   (the same overlay stack the settings window lives on — focus, ESC, the
   overlay and the phone back gesture close it before the settings window
   reacts). ONE body (`ResourcesDetails`), two form factors from that one
   shell: a centered frame on desktop and a docked `HkModal` sheet on
   phones. The pane itself never inlines a six-column table, the window is
   the only gate, and the destructive verbs live behind it.

The footprint is the walk's OWN sum (present, non-bundled rows). It must never
add `aux_cache_overview` on top: both measure the same directories.

## Status walk

`resources_status()` joins the registry with on-disk state — presence,
the resource's own stamp (pack timestamps, dataset publish stamps, cache
build numbers), content hash where addressable, and recursive size — in a
single IPC call. The walk is read-only and feeds three surfaces: the status
card's footprint, the family rows' sizes and the details panel's audit table.
The app-update row reports the running version without touching the updater.

## Publishing (maintainer, gh-authenticated)

- `just publish-data` — the data channel's datasets.
- `just publish-shipdata` — bake the two-realm bundle + publish it.
- `scripts/release_models.py` — the res pack (+ deltas).
- `scripts/mod_hub_publish.py` — the mod-hub catalog.
- `just publish-ai-models` — the decision models (signed Hugging Face
  manifest + artifacts; `--dry-run` first, needs `hf auth login` or
  `HF_TOKEN` and the digest signing key).

## Unified state layer (the freshness ledger)

Stamped rows (res-pack, data-kit, data-ship-gameparams, decisions-pack)
carry a ledger
entry at `<data>/resources/<id>.json` — ONE schema
(`{schema, id, sha256, version, installedAt, checkedAt}`) across every
resource, whatever its owner's internal stamp looks like. The owner stamps
remain the CONTENT truth (the walk reads them directly); the ledger records
WHEN: `installedAt` is backfilled on the first walk that sees an owner
stamp (approximate for pre-ledger installs) and re-stamped when the content
hash moves; `checkedAt` is set by the refresh entry. Unstamped rows
(caches, the bundled snapshot) never grow a ledger file.

## The refresh entry

`refresh_resources(ids?)` is the one IPC that re-checks the refreshable
rows: the data-pack lane (both datasets, the same single-flight boot path)
and the res-pack manifest check (fetch-only — downloads stay behind their
own consented cards). Unknown ids are ignored; a failed lane is logged and
absent from the returned id list, never failing the whole call. The
inventory's refresh button calls it with no ids (refresh everything
refreshable). The app-update row is deliberately not refreshable here: its
channel is frozen (see above) and the updater owns its checks.

## Manifest envelope equivalence

No wire format changed in S3. The data channel's `wowsp-data.json` IS the
canonical envelope (`{format, datasets: {id: {version, sha256, asset,
size}}}`); the res manifest (`wowsp-res.json`) is a single-entry document
whose fields map one-to-one onto an envelope entry
(`treeSha256`→`sha256`, `version`→`version`, `assetSha256`/`assetSize`→
asset identity), and the unified state ledger gives both the same
client-side shape. Forcing the envelope onto single-entry channels would
have been schema churn with no reader — the equivalence plus the ledger
deliver the actual coherence.
