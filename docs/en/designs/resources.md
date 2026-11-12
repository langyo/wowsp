# Runtime Resource Registry

> Single source of truth for everything the app downloads or manages at
> runtime. The machine-readable twin lives in
> `packages/app/tauri/src/commands/resources.rs` (`REGISTRY`), and the
> Settings → resources panel renders its walk (`resources_status`).

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

A resource download is a GLOBAL event, not a property of the panel it was
started from, so its progress renders in the top-right toast stack — never
inline in the Settings pane:

| kind | presentation | surface |
| --- | --- | --- |
| `update` | bespoke | `UpdateToast` — the updater's own pass card (verify / race / download / install copy, the installer hand-off) |
| `res-pack` | card | the shared `DownloadToast` card |
| `ai-models` | card | the shared `DownloadToast` card |
| `data-pack` | silent | none (a boot-time lane behind the settings card's stamp) |
| `mod-package` | bespoke | `ModUpdateToast` — the batch pass's step/percent copy |

The two bespoke cards stay because their copy is pass-specific (a mirror race
and an installer hand-off are not "downloading"); they are registered here so
the registry remains the complete answer to "what can this app download, and
where does it show up?". A new resource adds a registry row — with
`presentation: "card"` it inherits the shared card, the cancel verb, the
outcome toasts and the mount grace for free. A new settings card must NOT grow
its own progress bar: the settings cards keep the management verbs and gate
their buttons on `downloads.busyFor(kind)`.

The shared card's contract:

- **Raise on the ledger, not on a tick.** The owning command's lifetime is the
  truth (`track`), so a queued or stalled pass (no spaces in the byte stream
  yet) still shows. Ticks for a context nobody raised are ignored, so a stray
  producer cannot paint a ghost card.
- **Mount grace** (`DOWNLOAD_CARD_GRACE_MS`, 400 ms): a pass that lands inside
  it never mounts the card — its outcome is the toast instead (a
  flash-in/flash-out reads as a glitch, and "already current" is the most
  common shape).
- **Fold-out, not snap-away**: the terminal pass keeps the card mounted for the
  leave transition, serving a frozen snapshot (real text, real progress).
- **One cancel**: the card's 取消 and the owning settings card's own affordance
  both call `downloads.cancel(kind)`, which runs the registry's verb. A
  cancel is not a failure — the pass settles neutrally and no error toast
  fires.
- **One error line**: the failure text stays in the owning settings card (beside
  the button that retries it) via `downloads.errorFor(kind)`; the card folds
  out and a toast carries the reason, because a folded card cannot be read.

## Status walk

`resources_status()` joins the registry with on-disk state — presence,
the resource's own stamp (pack timestamps, dataset publish stamps, cache
build numbers), content hash where addressable, and recursive size — in a
single IPC call. The walk is read-only: management actions stay in each
resource's own settings card, and the app-update row reports the running
version without touching the updater.

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
