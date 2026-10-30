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
| `decisions-pack` | pack | — | manual | — | The out-of-band decisions model/LOS pack (no downloader; inventory/clear only). | `%LOCALAPPDATA%/WoWSP/decisions` |
| `bundled-lesta` | bundled | — | static | — | The Lesta-only slice snapshot compiled into the binary (`include_bytes!`). | inside the app binary |

## Shared infrastructure

- **Download hub** (`commands/download_hub.rs`): one FIFO queue, the
  GitHub mirror ladder, streaming sha256, byte caps, cancellation, and the
  single `wowsp://download-progress` event every UI subscribes to.
- **Signed digests** (`commands/release_digest.rs`, served by the pairing
  relay at `/api/digests/<channel>`): the `app` / `mod-hub` / `res` /
  `data` channels pin official content hashes and refuse regressions.
- **Machine scopes** (`tauri_shared::resource`): the clearable cache
  roots behind the Settings panel's aux-cache rows.

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
