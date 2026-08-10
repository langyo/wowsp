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
    license: CC0-1.0
    ---
    Body (Markdown, with preview images)…
    Attachment: sea-haze-skins-1.4.0.zip (SHA-256: …)

Why Discussions and not Releases: the comment thread *is* the feedback and
compatibility channel ("works on 14.6" reports get absorbed by the indexer
as compatibility signals), Watch = subscription, zero backend cost.

### 3. Installer

Writes strictly follow the Aslain convention:

```
<game>/res_mods/<game_version>/<files.to…>
```

Flow: `unpack → manifest validation → hash verification → conflict
detection (same-path entries) → restore point → atomic write → install
record`.

- **Restore points**: paths about to be overwritten are snapshotted to
  `%AppData%/wowsp/restore/<ts>/`; rollback = reverse copy;
- **Install record**: `%AppData%/wowsp/mods/installed.json` stores each mod's
  manifest, source, install time and written-file list — uninstall and
  migration both rely on it;
- **Conflict policy**: later installs win, but the UI explicitly warns
  "this will overwrite N files from mod X".

### 4. Version migration & compatibility confirmation

After a game update (a new `bin/<version>/` directory appears), the
migration wizard runs automatically:

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
   hashes, compatibility signals), committed to the `gh-pages` branch;
4. The website `/mods` catalog page and the in-app browser share this
   JSON — **no self-hosted backend**.

## Milestones (M10)

| Item | Content | Depends on |
| --- | --- | --- |
| M10.1 Manifest & repo conventions | manifest schema, package layout, Discussions post template, index JSON schema | — |
| M10.2 Installer | generic unpack/write/conflict/restore-point/install-record | M10.1 |
| M10.3 Indexer | Actions workflow emitting `mod-index.json`; website catalog page | M10.1 |
| M10.4 Migration engine | version-drift detection, classified migration, rollback, compat UI | M10.2 |
| M10.5 Content browser | categorized browsing, previews & audition, batch install, resumable downloads | M10.3 |
| M10.6 Aslain migration assistant | recognize Aslain-installed entries into the install record | M10.2 |

## Security & compliance

- Only resources with a declared free license (CC0 preferred) are indexed;
  copyrighted content (e.g. official collab voices) is excluded;
- SHA-256 verification is mandatory for every package; packs containing
  executable scripts (PnFMods) require explicit consent and are marked in
  the UI;
- Bundled official patches (IME fix etc.) are signed with the WoWSP
  installer.

## Open questions

- Does the Lesta (RU) client need a separate layout adapter;
- Should voice-pack soundbanks dependencies be modeled as a real dependency
  graph (or a simple "same package" convention);
- The confidence threshold for absorbing comment-section "works" reports as
  community confirmation (how many independent reports).
