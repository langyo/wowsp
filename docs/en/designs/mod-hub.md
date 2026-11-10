# Mod Hub — mod management design

> **Status**: in design (M10 — the next milestone after 1.0).
> This document is the gap analysis, target architecture and delivery plan
> for WoWSP's mod management.

## Background & goals

The World of Warships mod ecosystem is dominated by modpacks (Aslain,
ModStation). Their shared problems:

- **Coarse granularity**: hundreds of entries checked at once — users don't
  know what they actually installed;
- **Every game update breaks everything**: when `res_mods/` layout shifts,
  mods are hand-carried and hand-confirmed one by one;
- **Content distribution lives on file lockers**: skin and voice packs — the
  bulk of the ecosystem — float around forums and Discord with no hashes, no
  version declarations, no compatibility metadata.

WoWSP already stepped into this space: the M6 mod installer drops a loader
file into `res_mods/` to launch the overlay. The Mod Hub completes the job:

1. **Aslain-layout compatible**: write into `res_mods/<game_version>/`,
   coexisting peacefully with Aslain/ModStation installs;
2. **GitHub Discussions as the publish & distribution channel**: authors post
   templated resource threads; an indexer aggregates them into a catalog
   shared by the website and the app;
3. **Official mini-patches ship with the installer**: the IME input fix, font
   corrections, etc. are first-class patches hosted by WoWSP itself;
4. **Content packs are the main course**: browsing, previewing and batch
   installing skin & voice packs is a first-class flow;
5. **Automatic migration on game updates**: after a game update, migrate
   working mods, flag unverified ones, roll back in one click.

## What exists today

| Capability | Location | Notes |
| --- | --- | --- |
| Game install detection | `game_detect.rs` | Registry + Steam + Lesta + 360 → `<game_path>` |
| Game version read | `game_detect.rs` | From `bin/<ver>/` or `version.xml` |
| Mod file writing | `mod_install.rs` (M6) | Writes the overlay loader into `res_mods/<ver>/` |
| Self-updater | tauri-updater | WoWSP's own update channel |

## Gap analysis

| # | Gap | Impact | Priority |
| --- | --- | --- | --- |
| G1 | **No mod manifest format** | Can't express "which game versions this supports, which files it ships, where they go" — the precondition for all automation | P0 |
| G2 | **No package source protocol** | Archive structure, Discussions post template, attachment & hash conventions all undefined | P0 |
| G3 | **Installer only handles our own loader** | No generic unpack → file-map → conflict-detect → restore-point flow | P0 |
| G4 | **No version migration / compat confirmation** | Mod directories drift after every game update; users clean up by hand | P1 |
| G5 | **No Discussions indexer** | Resource posts can't be aggregated into a browsable catalog | P1 |
| G6 | **No content browser** | Skins/voices need categories, previews (images/audio), batch ops, resumable downloads | P1 |
| G7 | **No Aslain migration assistant** | Existing users hand-map their Aslain installs | P2 |
| G8 | **No sandbox / permission model** | Packs with scripts (PnFMods) need explicit consent and provenance checks | P2 |

## Design

### 1. Mod manifest (`wowsp.mod.toml`)

Every package (zip root, or the first code block of a Discussions resource
post) carries a TOML manifest:

```toml
[mod]
id = "sea-haze-skins"            # globally unique slug
name = "Sea Haze skin pack"
version = "1.4.0"                # package semver
category = "skins"               # aux | skins | voice | patches
license = "CC0-1.0"
authors = ["@someone"]

[compat]
game = ">=14.3 <14.6"            # explicitly declared game-version range
# or game = "*" + a human-confirmed flag — see "Version migration"

[[files]]                        # in-pack path → res_mods-relative path
from = "gui/flash"
to = "gui/flash"
[[files]]
from = "content/gameplay/us/gun/main/textures"
to = "content/gameplay/us/gun/main/textures"

[hashes]                         # SHA-256 of key files (post-install verify)
"content/.../camouflages.dds" = "…"

[preview]                        # content packs: preview images / audio
images = ["preview/yamato.webp"]
audio = ["preview/sortie.ogg"]
```

Key points:

- **The `game` range is the single source of truth for compatibility.** `*`
  means "undeclared" and is always rendered as *unverified* during install
  and migration;
- `files.to` is always relative to `res_mods/<game_version>/` — the same
  shape Aslain writes, so mods from both ecosystems coexist and can see each
  other (WoWSP can adopt Aslain-installed entries for migration);
- The manifest is the truth: migrate, uninstall and rollback only need the
  manifest plus the install record — never the original package.

### 2. Three install sources

| Source | Form | Handling |
| --- | --- | --- |
| **Archive** | Drop a `.zip/.7z` containing `wowsp.mod.toml` | Local unpack → validate manifest → install |
| **GitHub Discussions post** | Templated thread (front-matter + attachment link) | Indexer crawls → catalog entry → one-click install in-app |
| **Bundled official patches** | Shipped inside the WoWSP installer (IME fix, fonts) | Offline-installable, always signed & trusted |

Discussions resource post template (excerpt):

    ---
    wowsp-mod: sea-haze-skins
    version: 1.4.0
    game: ">=14.3 <14.6"
    category: skins
    author: Someone
    author_url: https://github.com/someone
    aliases: SMO_HazeSkins, SeaHazeSkinsPy
    preview_video: https://github.com/langyo/wowsp/releases/download/preview-media/sea-haze.mp4
    license: CC0-1.0
    ---
    Body (Markdown, with preview images)…
    Attachment: sea-haze-skins-1.4.0.zip (SHA-256: …)

`aliases` (optional, comma-separated) lists the foreign-installer names the
entry answers to — the Aslain modpack's manifest row ids and on-disk
directory names. The indexer harvests them into `mod-index.json`, and the
app's pairing treats them as exact identity, so a raw directory name that
shares no words with the display name (`TeamHP` vs "Team HP by TTaro")
still resolves to the right entry.

`servers` (optional, comma-separated) declares WHICH game servers the mod
applies to, as canonical realm codes — `ru` / `eu` / `na` / `asia` / `cn`
(the app's `REALMS`). An absent, empty, or all-five list means universal:
the mod applies everywhere. The scope is entry-level metadata only — the
CN-server ship-name restoration declares `servers: cn`, while the
real/romanized ship-name packs and the East-Asia font supplement (built
for non-Chinese clients) declare `servers: ru, eu, na, asia`. The app
filters mod lists by the realm of the client selected in the sidebar —
inapplicable entries simply never appear — and renders a compressed
scope badge on scoped entries. The curated mapping for republished mods
lives in `MOD_SERVERS` (`scripts/mod_hub_publish.py`).

`author` (optional) is the mod author's display name and `author_url`
(optional) their official page. Both live ONLY here — localized display
names never carry the attribution ("Team Panels", not "Team Panels by
AutoSpy"): the indexer copies the pair into `mod-index.json` and the
catalog renders them as the author tag, clickable when the URL is
verified. The registry backing these lines lives in
`scripts/mod_hub_authors.json`.

#### Standard preview video (`preview_video`)

A thread may point at ONE short preview clip with an optional
`preview_video:` front-matter line. The clip is the catalog's play-gated
preview (the detail pane keeps the screenshot when the line is absent), so
it must be small and web-friendly: **AV1 in MP4** (H.264 is the accepted
fallback), 720p, 8–20 s, at most 3 MB, `faststart` (moov atom first),
optional AAC audio. Host it on this repo's release download tree
(`…/releases/download/preview-media/<slug>.mp4`) or use a GitHub
user-attachment / raw URL. The indexer keeps the line only for https URLs
on those GitHub hosts, emits it as `preview_video` in the version payload,
and the app streams it through hikari's media player behind a play button.

#### Slug taxonomy (`category.genus.species`)

Every mod id is a permanent, three-field taxonomical name — big to small, like
biological nomenclature:

    battle.timer.shot        port.carousel.filters
    battle.marker.regen      port.sessionstats.v2
    minimap.rpf.2d           text.shipname.real
    patch.ime.compat         battle.ingame.stats

- `category` is a closed whitelist: `battle` / `minimap` / `port` / `text`
  (new categories are maintainer-gated; the one-off `patch` bucket was folded
  into `text` — `patch.ime.compat` keeps its permanent id but is filed under
  `text`);
- `genus` is the functional family (`timer`, `meter`, `marker`, `panel`,
  `carousel`, `techtree`, `crew`, `chat`, `shipname`, `font`, …);
- `species` carries the specifics, hyphenated modifiers and variant tails
  (`-v2`, `-cb`, author names when the author *is* the identity).
- Character set per field: `[a-z0-9]` plus inner hyphens. **Never** dates,
  package versions, `final`/`new`/`latest` suffixes, or underscores. The
  version lives in the `version:` front-matter, compatibility in `game:`,
  integrity in the thread's SHA-256 — never in the name.
- Package files mirror the slug exactly: `<slug>.zip` or `<slug>.partN.zip`.

The full posting rules (template, i18n block, update flow, content scope)
live in the pinned Discussions post; the indexer refuses ids that do not
match this shape.

**Thread titles are English-only** — `[Mod] <English name> <slug> <version>`.
Localized names live in the i18n block, which also renders as a collapsed
`📖 Description in 8 languages` details section in every thread; the rules
post itself is locked with one comment per locale carrying the translated
rules.

#### Localized name & description (`wowsp:i18n`)

Every thread carries an invisible HTML comment right after the front-matter,
holding the name + one-line description in all supported locales (8 today:
en-US, zh-CN, zh-TW, ja-JP, ko-KR, ru-RU, de-DE, fr-FR). It renders as nothing
on GitHub but is machine-readable in the raw body, so the indexer and the app
share one translation source:

    <!--
    wowsp:i18n
    en-US: Shot Timer | Counts down the 20s detection window after firing.
    zh-CN: 开火后倒计时20s | 主炮开火被点亮后按 20 秒倒计时提示灭点。
    zh-TW: 開火後倒計時 | 主炮開火被點亮後按 20 秒倒數提示滅點。
    ja-JP: 射撃後タイマー | 主砲発射後に20秒のカウントダウンを表示。
    ko-KR: 발사 후 타이머 | 주포 발사 후 20초 카운트다운을 표시합니다.
    ru-RU: Таймер после залпа | Отсчёт 20 секунд после выстрела ГК.
    de-DE: Schuss-Timer | 20-Sekunden-Countdown nach dem Schuss.
    fr-FR: Minuteur de tir | Compte à rebours de 20 s après le tir.
    wowsp:i18n
    -->

Constraints: one entry per line, `<BCP-47>: <name> | <description>`; the
description is a single line (no markup); unknown locales are preserved by
the indexer and ignored by the app; missing locales fall back to en-US.

Why Discussions and not Releases: the comment thread *is* the feedback and
compatibility channel ("works on 14.6" reports get absorbed by the indexer
as compatibility signals), Watch = subscription, zero backend cost.

#### Install-time schemes (`wowsp:presets`)

Mods that ship several prebuilt configurations (a marker's color palette, a
panel's position) declare them as named presets instead of splitting into
`-v1`/`-v2` listings — plugins roll forward, versions are not variants. A
thread carries a hidden label block plus preset-tagged download lines:

    <!--
    wowsp:presets
    sasagcy: Sasagcy 配色 | Sasagcy palette
    classic: 经典配色 | Classic palette
    wowsp:presets
    -->

    - [`smi-sasagcy.zip`](url) — 1 KB · SHA-256 `…` · preset `sasagcy`
    - [`smi-classic.zip`](url) — 1 KB · SHA-256 `…` · preset `classic`

Rules: one label line per preset, `id: <zh> | <en>` (ids are
`[a-z0-9-]`, declaration order is catalog order); a preset line is a normal
download line plus a trailing `· preset `id``; a fully preset-driven
thread backfills its plain package list from the first (default) preset, so
pre-preset app builds keep installing something sane. The app renders the
schemes as a segmented picker on the detail pane and installs the chosen
preset's packages; a label without packages is dropped by the indexer.

#### Style-family folding and `supersedes`

Historical one-entry-per-variant listings of the same HUD element (six team
panels, three mini panels, five traffic-light SMIs) read as duplicate rows.
Both index builders (`build_index` in `scripts/mod_hub_publish.py` and
`index_discussions` in `scripts/mod_index.py`) run
`fold_families` from `scripts/mod_hub_families.py` after the
latest-version pass: family members fold into ONE preset-carrying entry —
the Discussions threads stay one-per-variant, only the published
`mod-index.json` merges. Folded entries carry:

- **Per-scheme media**: each preset may carry `preview` (that variant's
  screenshot) and `desc_zh` / `desc_en` (that variant's caveats — mutual
  exclusions, replay breakage…). The detail pane swaps the preview image
  and the note with the segmented picker; entries without scheme media
  fall back to the entry-level preview/description.
- **`supersedes` (entry level)**: legacy one-entry-per-variant ids →
  preset ids. Ledger pairing treats a record under a superseded id as
  this entry installed with that scheme (records, corner lights, scheme
  landing, drift detection, uninstall and deep links all follow), and
  the installer rewinds the family's legacy records before writing the
  new one — styles are mutually exclusive, installing one replaces the
  other.

Folding configuration (families, preset ids, bilingual labels) lives in
the `FAMILIES` table of `mod_hub_families.py`; family intros and
per-variant descriptions reuse `scripts/mod_hub_desc_i18n.json`. The
`drop_missing_assets` gate sweeps preset package lists too, and both
scripts' `selftest` covers the fold and the gate.

### 3. Installer

Writes strictly follow the Aslain convention:

```
<game>/res_mods/<game_version>/<files.to…>
```

Flow: `unpack → manifest validation → hash verification → conflict
detection (same-path entries) → restore point → atomic write → install
record`.

- **Restore points**: paths about to be overwritten are snapshotted to
  `%AppData%/wowsp/mods/restore/<ts>-<name>/`; the snapshot is mandatory —
  a failure aborts the install instead of clobbering an unrestorable
  original (nested snapshot directories are created, which the old
  best-effort copy silently skipped);
- **Atomic write + rollback**: every file lands via
  `<dest>.wowsp-part` → rename, journaled; any failure rewinds the whole
  install (restored snapshots, new files removed, emptied dirs pruned) so
  a half-copied mod tree never reaches the client;
- **Install record**: `%AppData%/wowsp/mods/installed.json` stores each mod's
  manifest, source, install time and written-file list — uninstall and
  migration both rely on it. Local-folder installs are recorded too
  (source `local`), so their uninstall restores overwritten originals;
  reinstalling the same mod (same id, or same plan name for local
  installs) first rewinds the previous record — snapshots always point at
  VANILLA files and files dropped by the new version don't linger;
- **Game guard**: every mutating command (catalog/local install, uninstall,
  unit toggle, overlay stub) refuses to run while the game client process
  is live, the same way Aslain's installer warns — mid-session writes tear
  half-loaded mods;
- **Conflict policy**: later installs win, but the UI explicitly warns
  "this will overwrite N files from mod X".
- **Shared component trees**: the runtime components every Aslain
  dependent clones (TTaroModUtils, ModForge, `ModsInstaller_4_3_1`, the
  ttaro GUI/config trees and their unbound fragments, the per-locale
  `ttaro-mod-config.mo` catalogs, the `@game` gettext DLL) belong to the
  component, not to any one pack — mirroring Aslain's `<Implicit>`
  shared-runtime layout. They never block an uninstall: while another
  consumer of the same component remains, the tree stays at the live
  bytes (later installs win and stay) and the departing record's
  snapshot layer is dropped; the LAST consumer's uninstall removes it
  and restores its snapshot. Private files keep the newer-owner refusal
  unchanged.

  The record model mirrors that ownership: at install, each component's
  written files are attributed to one UPSERTED `shared.<root-slug>`
  ledger record (e.g. `shared.pnfmods.ttaromodutils` for
  `PnFMods/TTaroModUtils/…`) instead of being cloned into every
  dependent's file list. The newest install defines the component's
  generation — files replaced wholesale, exactly ONE snapshot layer per
  content generation (the capture at that generation's own install,
  never one layer per pack): a dependent re-shipping IDENTICAL bytes
  adds only its own pack record and captures nothing, while DIFFERENT
  bytes capture the old generation's bytes as the new layer and raise
  the mixed-version divergence warning. Pack records keep only their
  private files plus a `shared_roots` dependency edge, and dependents
  are always COMPUTED, never stored: the edge union the inlined shared
  file paths legacy ledgers carry (no migration — old records keep
  every existing behavior). A component's lifetime is bound to that
  consumer set: the last consumer out (catalog uninstall, unit
  uninstall or a legacy departure alike) removes the `shared.*`
  record, deletes its files and restores its generation layer (a
  component whose file set SHRANK across a generation leaves the
  shrunken-away files in no record — the root-granularity policy's
  consequence: such strays ride along until the tree itself goes).
  Reconcile
  judges `shared.*` records like any other — files on disk mean alive —
  and the webui never shows them as user-installed entries (they match
  no catalog id; the records-driven sync rows filter them).

#### 3.1 Managing installed plugins

The installed list is anchored on **Aslain's
`bin/<build>/res_mods/installed_mods.xml`** (rows of
`<mod name version installer/>`) when present: filesystem groups
(`banks/<bank>`, `PnFMods/<dir>`, `gui/unbound2/<mod>`, `gui/<child>`,
top-level `*.xml` patches, leftover top-level dirs) are attached to
manifest rows by normalized-name similarity (exact > containment >
shared prefix), so the app shows what the installer actually installed
instead of raw directories. Rows without matched files stay listed as
manifest-only entries; groups no row claims keep their heuristic identity.

Texture-override units (the `content/`, `particles/`, `spaces/`, … catch-all
groups, including ones merged under a claimed manifest row) carry a
**structured content analysis** (`textureAnalysis`, bounded walk ≤ 20k
files): paths classify by signature (`content/gameplay/<nation>/<class>/…`
ship & component textures, `content/unlocks/…` camo icons,
`spaces/<map>/…` scenes, particles/texts/system), and the covered model
units are parsed out of texture file names (`JSB039_Yamato_1945_Hull_a.dds`
→ `JSB039 Yamato 1945`; the first `_` segment is a 2–6 capitals + 2–4
digits unit code, the readable name stops at component words like
Hull/Gun). Nations/classes/categories stay language-neutral codes the
frontend localizes; the local-folder install plan reuses the same analyzer,
and `particles`/`spaces`-style override roots are recognized package-layout
signatures too.

Each unit supports two operations:

- **Temporary disable** — every file of the unit is renamed with a `.bak`
  suffix; enabling strips it again. The scanner recognizes `.bak` files
  (`mod.xml.bak`, `Main.py.bak`, `x.xml.bak`), so disabled units stay
  visible and toggleable. Directory names are never touched — the game
  stops loading the files, PnF's loader finds no `Main.py` to import.
  Disabling a shared catch-all group (all of `content/`, loose gui files)
  that also carries files of a ledger-recorded mod living elsewhere is
  refused: a PnF payload whose textures or unbound fragments just
  vanished is a load-time crash, so the toggle points at that mod's own
  entry instead.
- **Uninstall** — the unit (including `.bak` twins) is deleted, emptied
  parent dirs are pruned up to `res_mods`, and a manifest-backed unit's
  row is removed from `installed_mods.xml` (rewritten atomically). Ledger
  records the unit covers *completely* get the full uninstall — snapshot
  restore plus record drop; a record that also owns files outside the
  unit (another mod sharing the tree) is trimmed instead: only its
  covered files and their snapshots are removed, so deleting one plugin
  never silently uninstalls a neighbor. Ledger uninstalls also remove
  `.bak` twins of recorded files so disabled mods cannot survive as
  ghosts.

**Known-mod relations.** One on-disk unit is not necessarily one mod: several
known mods claim files inside the same tree. Shared runtime components
(`PnFMods/TTaroModUtils`, `gui/ttaro`, the per-locale `ttaro-mod-config.mo`
catalogs, the `@game` gettext DLL, the `PnFModsLoader.py` marker) are dropped
in by every dependent pack, and catch-all override trees (`content/`,
`gui/`) accumulate files from several packs. The installed list therefore
annotates every row that has associations with the number of KNOWN mods
associated with the unit,
computed in the webui from data the client already holds: ledger records whose
written-file list lands under the unit's paths, the consumer set of a shared
component the unit carries (pack records whose `shared_roots` edge names it),
and the foreign/Aslain or catalog pairing of the unit's own identity. Opening a
row shows the detail pane's **related mods** section at the end of its
body (expanded by default; a unit with nothing else to show starts it
directly under the pane head instead of leaving the flex-grown empty body
above a bottom-pinned drawer): each associated mod lists its role (own /
shared component / dependent), the files it claims in this unit and in
total, with a jump to its catalog entry when one exists. Managed rows offer a
full uninstall — the same ledger rewind as the catalog uninstall, so every
file the mod owns anywhere in `res_mods` (including its residual files in
other trees and their `.bak` twins) is removed, overwritten originals are
restored, and shared components whose last consumer leaves go with it.
Aslain/manifest rows route through the unit uninstall (which also cuts
`installed_mods.xml`), and a shared-component OWNER row is not removable on
its own: the component's lifetime belongs to its consumers.

**Junk pruning (previews and screenshots).** Aslain-ingested packs and several
authors' payloads ship promo material — screenshots, preview folders,
`desktop.ini`/`Thumbs.db` noise — that is not game payload and used to land in
`res_mods`, polluting the mod tree. One predicate (`junk::is_junk_rel`) is the
single source of truth: an image (`png/jpg/jpeg/gif/bmp/webp/tif/tiff`) whose
basename or any path segment carries a screenshot/preview/showcase/thumbnail
marker (English or Chinese), plus Explorer metadata files. The installer skips
junk DESTINATIONS before their directories are created — a screenshot-only
folder never lands, and the plan's file-list preview agrees with what is
written — and reports the pruned count (`prunedFiles`) so the UI can say the
pack's promo material did not land. Functional assets (HUD art, scene and
gameplay textures, `.dds` payloads, `PnFMods` scripts) never match. Installs
that already polluted a tree are cleaned explicitly: the scan annotates each
unit with its junk footprint (`junkCount` plus a capped `junkFiles` sample),
the detail pane shows the notice with a clean action, and
`mod_hub_clean_unit_junk` (gated like every `res_mods` mutation) deletes the
junk files and their `.bak` twins, prunes the emptied directories, and drops
those paths from the ledger records' file lists so a later uninstall does not
chase ghosts.

**Safe mode** quarantines the whole current `res_mods` in one atomic
rename (`res_mods` → `res_mods.wowsp-disabled`) — WG's "safe mode"
support move: run the game with every res_mods mod bypassed, without
deleting anything — the fastest way to bisect "is it the mods or the
game?". (A few text mods also drop a DLL into the game root itself;
those files are not part of res_mods and stay in place.) One click
brings the exact pre-quarantine state back — including a twin stranded
in an old version dir by a game update that happened while safe mode
was on. While active, every mutating command
(install/uninstall/toggle/migrate/overlay) refuses to run — writes
would land in a fresh `res_mods` and drift from the quarantined tree.

**Unit warnings**: the scan flags two installed skins overriding the same
`registerShipMod` ship id — exactly one can take effect, so both units
carry a warning in their detail pane.

**Ledger reconciliation** runs alongside the installed scan: records
whose files are all gone from disk (manual cleanup, lost bin dir —
`.bak` twins and the safe-mode quarantine still count as alive) are
dropped so the "installed" badges stay truthful. Records carry the game
install they belong to (`gameRoot`); reconciling one install never
touches another install's records. Snapshot dirs no record references
anymore are garbage-collected after a 24h grace window, so a just-
failed install's snapshots survive a retry.

All mutations (catalog install/uninstall, unit toggle/uninstall, and the
overlay stub's install/uninstall) serialize through an async gate so
parallel catalog installs can download simultaneously without interleaving
ledger writes or file renames.

#### 3.2 The shared manifest (`res_mods/wowsp.toml`)

Next to the mods it manages, WoWSP maintains `bin/<version>/res_mods/wowsp.toml`
(schema 1) — the shared half of the app-data ledger: tool plugins read their
config from it, and anyone inspecting the game folder can see what WoWSP
installed and with which scheme. WoWSP rewrites the file on every install,
uninstall and unit toggle; `[tools.*]` tables belong to their tools and are
carried over untouched by rewrites (hand edits there are safe).

    version = 1

    [managed."battle.marker.traffic-v4"]
    name = "Ship Movement Indicator"
    version = "15.7.0.10"
    category = "battle"          # catalog category, "local" for folder installs
    source = "mod-hub"           # mod-hub | local | bundled
    preset = "sasagcy"           # chosen scheme, when installed with one
    enabled = true               # kept in step with the `.bak` toggles
    installed_at = "2026-10-05T00:00:00+00:00"

    [tools."battle.ingame.stats"]
    panel_fade_ticks = 3         # tool-defined keys — WoWSP seeds defaults,
    journal_limit = 300          # existing keys are never overwritten

Contract: `version` gates the schema (a build that sees a NEWER version
leaves the file untouched); an unparseable file is quarantined as
`wowsp.toml.invalid` and maintenance restarts from scratch; an emptied
manifest deletes itself. Stale-bin migrations never transplant the file —
its surviving content (toggle states, tool configs) merges into the current
bin's manifest. The first consumer is the bundled in-game stats plugin,
which reads `panel_fade_ticks` and `journal_limit` from its `[tools]` table
with the values above as fallbacks.

Inside the process the file has exactly ONE writer context: every mutation
ships a `ManifestOp` down an mpsc pipe to a dedicated writer thread and
waits for its receipt, while reads parse an atomic (tmp+rename) snapshot —
many-read/one-write, no parallel copy of the file can drift. The sections:

- `[managed.*]` — units WoWSP installed and owns (rewritten on every
  install / uninstall / toggle / reconcile / migration);
- `[tools.*]` — tool-plugin configs (owned by their tools; WoWSP only
  seeds missing defaults and never overwrites existing keys);
- `[foreign.<installer>.<key>]` — recognition of units FOREIGN installers
  put on disk: `aslain` rows come from the modpack's own
  `installed_mods.xml` ledger, `modstation` units from WG's official
  station's `bin/<version>/mods/` tree (wiped by every game update, which
  is why it is re-scanned rather than remembered). Each row carries a
  best-effort `identity` — the catalog id its name pairs against — so
  every surface can read the pairing verdict from this one file instead
  of re-deriving it. The scan refreshes these rows on every installed-list
  sweep. Pairing is tiered (exact name > containment > character-bigram
  similarity, stopwords stripped on both sides) so CamelCase modpack names
  reach the catalog's prose names. WoWSP describes foreign units by
  default, and manages them on explicit demand: the foreign pane offers
  disable/uninstall (Aslain rows through the same unit ops — the pack's
  manifest row is cut in sync; ModStation trees through a dedicated
  whole-directory uninstall), and installing a catalog entry over a
  paired foreign copy is a REGISTRATION — the entry's manifest rows are
  cut, the files snapshotted, and the unit lands under WoWSP's ledger.

### 4. Version migration & compatibility confirmation

**Landed (detection + one-click migrate)**: the scan reports every older
`bin/<version>/res_mods` that still carries files (`mod_hub_stale_versions`)
and the resources page shows a warning banner;
`mod_hub_migrate_stale_bin` moves the stranded files into the current
version's `res_mods` (same-volume per-file renames; **keep-new** on
conflicts — a stranded file is dropped when the current tree has it live
or as a disabled twin, and a stranded twin is dropped when its live
counterpart exists, so nothing is ever overwritten; disabled twins carry
over when the current tree lacks the live file; the stranded Aslain
`installed_mods.xml` dies with the old directory instead of
transplanting ghost rows; the old directory is emptied afterwards and
ledger records re-pointed at the current version; guarded by the mod-hub
gate and the game-running check).

**Planned (compatibility-graded migration wizard)**: after a game update
(a new `bin/<version>/` directory appears), the migration wizard runs
automatically:

1. **Scan**: read the old `res_mods/<old>/` and the install record;
2. **Classify**:
   - `game` range covers the new version → **auto-migrate** (copy into the
     new directory);
   - Range miss but Discussions reports say it works → **"community
     confirmed"** badge, one click to adopt;
   - Range miss, no signal → **unverified** — the user decides per mod (try
     enabling / shelve / wait for an update);
   - Known broken (author deprecated, index flagged) → **suggest removal**;
3. **Rollback**: migration creates a fresh restore point — one click back.

### 5. Content browser (the main course)

Skin & voice packs are 90%+ of the content, so the browser is built for
them:

- **Axes**: ship / series / character / language; skins get image carousels,
  voice packs get in-place audition;
- **Batch ops**: multi-select installs, automatic dependency completion
  (a voice pack's base soundbanks pack rides along);
- **Downloads**: chunked resumable transfers (voice packs routinely exceed
  100 MB), concurrency caps, post-download verification;
- **CC0 first**: the index only lists resources declaring CC0 (or a
  compatible free license); the license is shown prominently on install.

### 6. Discussions indexer

A scheduled GitHub Actions workflow (also manually triggerable):

1. GraphQL-crawl resource posts carrying the `wowsp-mod` front-matter;
2. Parse front-matter + attachment links + version reports from comments;
3. Emit `mod-index.json` (aggregated by category, with latest versions,
   hashes, compatibility signals) — published by
   `scripts/mod_hub_sync.py` as the `mod-index.json` asset of the
   `mod-hub` release;
4. The website `/mods` catalog page and the in-app browser share this
   JSON — **no self-hosted backend**.

### 7. Upstream sync automation

The catalog's 142 tool-class entries were carried over from Aslain's
WoWs Modpack in an offline batch port (`scripts/mod_hub_publish.py`,
run by the maintainer on demand). Upstream never stands still: drops
roll continuously, each tagged with its `ContentVersion` (e.g.
`v.15.9.0 #05`), and the public catalog keeps only the current version
(older Configuration pages 404) — so the ported snapshot goes stale on
every upstream update. Upstream zip file names embed the first 8 hex
digits of the content md5, a free content fingerprint (the 204
absolute-URL `.7z` entries are the exception — no fingerprint).

`.github/workflows/mod-hub-sync.yml` (a `schedule` every 6 hours plus
manual `workflow_dispatch`, runs serialized by `concurrency`) calls
`scripts/mod_hub_sync.py` (pipeline subcommands `detect` / `apply` /
`index-only` plus the offline `selftest`; `render-summary` /
`upsert-issue` re-render a saved report):

| Command | Behavior |
| --- | --- |
| `detect` | Read-only diff against upstream + report |
| `apply` | The real sync; flags `--dry-run` / `--include-new` / `--no-gc` |
| `index-only` | Rebuild + re-publish the index only |
| `selftest` | Offline self-check |

#### Stateless reconciliation

No upstream snapshot is persisted anywhere. Packages switch to
content-addressed names — `pkg-<md5 8>.zip` / `pkg7-<sha256 12>.zip`
(identical content shared across entries dedupes automatically) — so
the published Discussion threads themselves (the asset name + sha256
in each download line) **are** the sync state: every run diffs
upstream's Configuration against the live threads and acts on the
delta. The first migration run rewraps the legacy `<slug>-partN.zip`
naming wholesale (a one-time pass).

#### Version semantics

Only entries whose package content actually changed get a `version`
bump (the webui `pluginUpdates` store signals updates by string
equality, so unchanged content must never bump). The game
compatibility range (the `game` front-matter) is refreshed on every
run — derived from upstream `root.xml` `Cache.Version` into a range
like `>=15.9 <15.10` — without bumping `version`, therefore without a
mass update prompt. Game minor-version bumps are followed
automatically (maintainer's decision); no human gate.

#### Resource hygiene (previews and screenshots)

Re-hosted packages are stripped of non-functional promo material before
they are zipped and uploaded: `scripts/mod_package_hygiene.py` is the
publish-side twin of the app's install-time filter (`commands/mod_hub/
junk.rs` — the two predicates carry the same truth table). Junk is an
Explorer/OS metadata file (`desktop.ini`, `Thumbs.db`, …) or an image
whose basename or ANY path segment names a screenshot/preview/showcase/
thumbnail marker (English or Chinese); `.dds` and every normally named
functional asset never match. A package that carries no junk keeps its
bytes (and therefore its content address and discussion line) untouched,
so junk-free assets never churn. Both engines run the filter: the manual
publisher's `download` stage and the sync engine's
`download_record_packages`.

The filter runs at DOWNLOAD time in both engines, so every newly ingested
version of a package is served already clean. The current re-hosted
catalog was verified clean end to end (all 170 unique assets scanned: 604
image members, every one functional `res_mods/gui` HUD art, zero
preview/screenshot members) — promo material observed on a user's disk
comes from a foreign installer's own tree, not from the hub's packages,
and the app's install-time skip plus the per-unit clean command
(`mod_hub_clean_unit_junk`) is the second line of defence there.

#### Two-phase delisting

When an upstream entry disappears / is disabled / leaves the sync
scope:

1. **Stale mark**: the thread body gains a hidden `wowsp:sync-stale`
   comment block (`reason` / `since` / `content_version`) plus a
   visible bilingual warning ("sync source closed, pending manual
   review before delisting"); the entry stays installable;
2. **Delist** (manual): closing the Discussion is the takedown — the
   crawler reads `closed` as delisted. Release assets no longer
   referenced by any thread are garbage-collected after a 24 h grace
   window (150 assets per run cap; the GC pass is skipped when the
   reference set looks too small). The sync-report issue lists every
   entry pending review.

If upstream restores the entry, the next sync removes the stale mark
on its own.

#### New entries go through curation

New Aslain entries without a `SLUG_MAP` row are never auto-published:
they only show up in the report's `pending` list. The
maintainer fills `scripts/mod_hub_slugs.py` (optionally also
`mod_hub_authors.json` / `mod_hub_desc_i18n.json` /
`mod_hub_families.py`), then publishes them with a `workflow_dispatch`
run (`mode=apply`, `include_new=true`).

#### Trust chain & relay hardening

`mod-index.json` remains an asset of the `mod-hub` release. The same
facility also brings the relay's signed `mod-hub` digest channel
online: whenever the index bytes change, the workflow signs a document
under `packages/pairing-relay/digests/mod-hub/` with
`WOWSP_DIGEST_SIGNING_KEY`:

    scripts/publish_digests.py --channel mod-hub --tag mod-hub \
        --assets mod-index.json=<sha256> --latest --require-signed

The same PR adds the two `!/api/digests/mod-hub` negation rules and
the `DIGEST_PUBLISHED_CHANNELS` extension to `wrangler.toml`. The
first digest document MUST ship in the same deploy batch as its
negation rules — otherwise the path falls through to a SPA 200
instead of a gated 404. The PR auto-squash-merges and triggers the
site deployment, then the workflow verifies
`https://wowsp.langyo.xyz/api/digests/mod-hub`. Details mirror the
app digest job of `release.yml`.

#### Safety gates

- zip magic / unpack / repack validation for every downloaded package;
- content-based package-set audit on every downloaded package: a package
  whose payload is nothing but the raw OlliN `ShipIdentity.unbound` template
  (`res_mods/gui/unbound2/!shipidentity/`) is excluded — Aslain resolves the
  template's `*_INSTALLED` component switches at install time, so WoWSP would
  ship the unresolved template and blank new collab ships' port names (#1634);
  a package mixing that template into functional payload refuses the publish
  (the maintainer must split the template out of the package);
- two packages of one entry writing the same target path with different bytes
  publish with a warning instead of an install-order last-wins (the app's
  install merge keeps the first package's copy deterministically and reports
  the conflict; byte-identical duplicate targets stay silent, as shared-runtime
  dedupe); legacy duplicates in already-published entries are reported so the
  maintainer can resolve them upstream;
- asset uploads are digest-idempotent (same sha → skip);
- index asset-existence gate: more than 25% missing assets refuses the
  index upload (delisted / stale entries are exempt);
- post-publish readback verification of the released index;
- on failure: roll back to the previous index and open an alert issue;
- Discussion batch updates are rate-limited to ≥ 1 s per call.
- Shared runtime packages (Aslain's `<Implicit>` blocks — TTaroModUtils, the
  ModForge blueprint engine) are bundled into every `RequiresAny` dependent's
  package list, so installs are self-contained; several mods share one copy,
  and the thread says so (under Aslain a sibling mod can stop working after
  an uninstall — reinstall any of them; WoWSP's shared-component policy
  instead keeps the tree while any consumer remains, so its own uninstalls
  never break the siblings). Package-level `Requires`/`RequiresAny` attributes
  are Aslain's conditional-variant selectors ("install the part matching your
  other choices"); WoWSP ships every package of an entry, as it always has, so
  they are deliberately not modeled. `UnpackTo`/`Preserve` need no modeling
  either: the installer already carries zip-root native libraries (the
  `gettext_x64r.dll` class) to the game root as `@game/...` drops.

#### Per-entry sync policies

`scripts/mod_hub_sync_policies.json` maps catalog slugs to a policy the sync
honors on every run: `"auto"` (default — full sync), `"manual"` (selected,
but upstream changes are held out of the publish and listed in the report
until the policy flips back to auto), and `"skip"` (removed from the catalog;
threads of skipped entries are never stale-marked). Absent means auto, so
nothing changes without a deliberate registry edit.

#### Reporting

Every run writes `sync-report.json` next to the run and renders it into
the step summary plus a fixed-title issue **"[mod-hub-sync] Upstream sync
report"** (its body is overwritten on every run and embeds a hidden
JSON block, so agents and humans read the same source). A failed
`apply` opens a separate alert issue.

#### Runbook

- Manual trigger: the Actions page (`workflow_dispatch`), or
  `gh workflow run mod-hub-sync.yml -f mode=apply`;
- New-entry curation: fill the slug registry (see above), then run
  apply with `include_new=true`;
- Stale review: closing the Discussion delists the entry; if upstream
  comes back, the next sync clears the stale mark automatically.
- Content-guard migration: after changing the package content guard, run
  `apply --reaudit` once — it forces a download + audit pass over every
  in-scope entry, including the ones the diff would call unchanged (regular
  runs stay incremental and only audit entries whose packages changed).

#### Compliance posture

The rehosting posture is unchanged — rehost + attribution + source
link + takedown on notice (`license: Unspecified (upstream)`).
Automation does not change that posture but does scale it up;
adjusting the sync policy entry by entry via a per-author /
per-license registry is a follow-up item.

## Milestones (M10)

| Item | Content | Depends on |
| --- | --- | --- |
| M10.1 Manifest & repo conventions | manifest schema, package layout, Discussions post template, index JSON schema | — |
| M10.2 Installer | generic unpack/write/conflict/restore-point/install-record | M10.1 |
| M10.3 Indexer | Actions workflow emitting `mod-index.json`; website catalog page | M10.1 |
| M10.4 Migration engine | version-drift detection, classified migration, rollback, compat UI | M10.2 |
| M10.5 Content browser | categorized browsing, previews & audition, batch install, resumable downloads | M10.3 |
| M10.6 Aslain migration assistant | recognize Aslain-installed entries into the install record — DONE via tiered pairing + register-and-reinstall takeover (install cuts the pack's manifest rows) | M10.2 |

## Security & compliance

- Only resources with a declared free license (CC0 preferred) are indexed;
  copyrighted content (e.g. official collab voices) is excluded;
- SHA-256 verification is mandatory for every package; packs containing
  executable scripts (PnFMods) require explicit consent and are marked in
  the UI;
- Bundled official patches (IME fix etc.) are signed with the WoWSP
  installer.

## Beautify layers (ordered asset packs)

The client reads exactly ONE override tree, `bin/<build>/res_mods`, with
whole-file shadowing and no priority — so layering is materialised by the
app, not by the game. Every pure-asset install is also copied into a layer
store (`<app-data>/mods/layers/<packId>/<version>/`, holding `files/` and
`layer.json`), and `layer-stack.json` keeps one ordered stack per game
install: index 0 is the top, the highest priority.

- **Zero-code stack**: code-bearing packs (PnFMods, `ModSchemas` /
  `ForgeBlueprints`, `gui/unbound2`) are not layers — a stack only replaces
  visuals and audio, which the WG mod policy allows.
- **Stack order**: a fresh stack is the install order reversed (newest on
  top), so existing installs behave exactly as before — the later install
  wins.
- **Rendering**: per path, the highest enabled layer wins. Writes are
  atomic (temp + rename) with a pre-overwrite snapshot and roll back on
  failure. Paths owned by legacy, foreign or functional records are never
  overwritten and are reported as blocked. A path that loses its winner is
  removed only while its bytes still equal a layer's store copy, so foreign
  files and restored snapshots survive; pre-release `bin` twins are
  mirrored.
- **Classes**: `override` is whole-file; `additive` covers voice banks (one
  slot per `banks/mods` folder, selected in-game); `registered` is the
  PnF-style exclusive slot and stays reserved. Slot conflicts surface in the
  UI.
- **Lifecycle**: install appends the pack on top and leaves it rendered;
  reorder and toggle only mark the stack dirty. An explicit render applies
  it and is refused while the client runs. Uninstall drops the layer and
  marks the stack dirty, so the next render lets a layer below take over; a
  game update (a new `bin/<build>`) re-renders from the store instead of
  moving files.
- **UI**: the texture and voice categories merge into one **Beautify**
  category, and the installed list becomes a draggable layer swimlane
  (hikari `HkDraggableList`, top = highest priority). The detail pane shows
  the priority position, `covered_by` / `shadowed` counts, slots and the
  actions (top / up / down / bottom / disable / uninstall / update), plus a
  render report of blocked and conflicting paths.

### Video packs

A video pack replaces the client's login/opening clip: main.webm (1080p)
and main_low.webm (720p) under `gui/video/login/`, VP9 + Vorbis at 25 fps;
a pack may ship either tier or both. The stock files stay inside the
game's pkg VFS and `res_mods` shadows them by path — no `idx`/VFS write
is involved, and removing the pack's files restores the stock clip. The
layer pane lists installed videos through `mod_hub_list_assets`
(`kind: "video"`) and plays them inline: `mod_hub_asset_file_path`
resolves the file to an absolute path for Tauri's asset protocol, so the
bytes stream to the player and never cross IPC. Exactly ONE tier plays
(hikari's media player): `main.webm` first, then the first non-`_low`
clip, then the first by name; the remaining tiers list as compact
name + size rows instead of a second player.

## Custom import (自定义导入安装)

The Mod Hub's local entry is **自定义导入安装** (custom import): a three-step
wizard for material the user made or downloaded outside the catalog — a login
clip, a voice bank, a texture drop. Instead of demanding a ready-made package
tree, the wizard BUILDS the compliant `res_mods` shape and then runs the
ordinary local-install pipeline (install journal, pre-overwrite snapshots,
ledger record, `wowsp.toml` row, layer adoption), so a custom import can
never plant a tree the platform would refuse.

- **Step 1 — what to install**: login video / voice pack / texture pack /
  other assets, each row stating its requirement (the rules below). A whole
  plugin package (PnFMods, scripts) still installs through the plain folder
  flow, linked from this step.
- **Step 2 — source**: the video kind opens the native single-file picker
  (`.webm` / `.mp4` / `.mov` / `.mkv`); the other kinds reuse the folder
  picker. The picked path becomes a session grant, and a read-only backend
  PROBE reports the file name, the size, the res_mods-relative shape the
  import would write, and every blocking problem (localized from
  language-neutral codes). "Next" stays disabled while a problem remains.
  The optional display name names the ledger record and the adopted layer —
  and, for a loose voice pack, its bank folder.
- **Step 3 — compliance & register**: the payload is assembled under
  `<app-data>/mods/import-staging/<uuid>/` (removed afterwards, success or
  failure), classified by the same classifier the catalog pipeline uses,
  installed through the local pipeline and adopted into the beautify stack.
  The step shows a progress bar fed by `wowsp://custom-import-progress`
  (`{stage, percent}`) and, on success, "registered as layer: <name>" with
  the new layer selected in the swimlane.

Per-kind compliance rules (`mod_hub_import_custom`):

| Kind | Accepted source | Written |
| --- | --- | --- |
| video | one `.webm` (copied as-is, 200 MB cap; a `*_low.webm` source is the 720p tier) or `.mp4` / `.mov` / `.mkv` (transcoded) | `gui/video/login/main.webm` (1080p) plus `main_low.webm` (720p) |
| voice | a folder with `banks/mods/<bank>/mod.xml` (+ `.wem` files), or a loose `mod.xml` with `.wem` files | the tree as-is, or the loose pack wrapped into `banks/mods/<display name>/` |
| texture | a folder with at least one override root: `content/`, `gui/`, `spaces/`, `particles/`, `texts/`, `camouflage/`, `system/` | the tree as-is |
| misc | the same root rule as texture | the tree as-is (`category: local`) |

Anything else is refused with the expected layout instead of being installed
half-way. Link-shaped source entries (symlinks, directory junctions) are
refused by the same no-follow walk the folder install uses, and the app's own
data tree is never a valid source. A single wrapper folder around the payload
is peeled (the extracted-archive layer), so both the outer folder and the
payload folder can be picked.

### ffmpeg dependency (video only)

The client only loads VP9 + Vorbis WebM, so a non-WebM clip needs an EXTERNAL
ffmpeg — the app never bundles or downloads one. The lookup order is:

1. `ffmpeg.exe` beside the app executable (portable installs keep it there);
2. `%LOCALAPPDATA%\WoWSP\tools\ffmpeg.exe`;
3. `PATH`.

With ffmpeg present the importer runs the two documented encodes (25 fps,
lanczos scaling, libvpx-vp9, libvorbis 48 kHz stereo, progress parsed from
ffmpeg's `-progress` stream and reported through the event above):

    ffmpeg -y -i <src> -vf "fps=25,scale=1920:1080:flags=lanczos" -c:v libvpx-vp9 -row-mt 1 -cpu-used 4 -crf 31 -b:v 0 -c:a libvorbis -ar 48000 -ac 2 main.webm
    ffmpeg -y -i <src> -vf "fps=25,scale=1280:720:flags=lanczos" -c:v libvpx-vp9 -row-mt 1 -cpu-used 4 -crf 38 -b:v 0 -c:a libvorbis -ar 48000 -ac 2 main_low.webm

A missing ffmpeg blocks the non-WebM source at the probe (no "next"), and a
direct command call fails with the same explanation plus the exact commands;
a failed encode reports ffmpeg's stderr tail and the command that ran.

Commands: `mod_hub_pick_custom_file` (single-file picker + grant),
`mod_hub_probe_custom_import` (read-only step-2 verdict) and
`mod_hub_import_custom` (stage + classify + install + adopt, returning the
standard `InstallReport` plus the adopted layer id).

## Open questions

- Does the Lesta (RU) client need a separate layout adapter;
- Should voice-pack soundbanks dependencies be modeled as a real dependency
  graph (or a simple "same package" convention);
- The confidence threshold for absorbing comment-section "works" reports as
  community confirmation (how many independent reports).
