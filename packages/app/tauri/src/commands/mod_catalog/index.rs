//! Index fetch + cache + wire-schema parse (split from the former
//! single-file `commands/mod_catalog.rs`; see the parent module for the
//! surface's history).

use anyhow::anyhow;

use super::*;
#[tauri::command]
pub async fn mod_catalog_refresh(force: bool) -> CommandResult<CatalogIndex> {
    let mut cached = if force { None } else { load_cached_index() };
    if let Some(index) = cached.as_ref() {
        // A cache written by an older app build can lack the i18n maps
        // (schema drifted when threads gained the wowsp:i18n block);
        // such a copy is stale by definition. Beyond the freshness TTL,
        // the official digest is the freshness arbiter: a cheap signed
        // lookup tells whether the release asset moved since this copy
        // was verified, so hub updates land on the next view load
        // instead of after the TTL. When the digest lookup fails
        // (offline), the TTL alone decides and the cache stays the
        // offline fallback if the fetch below fails too.
        let localized = index.mods.iter().any(|m| !m.i18n.is_empty()) || index.mods.is_empty();
        let fresh = fetched_recently(&index.fetched_at);
        let client = crate::commands::network::build_http_client().ok();
        let digest = match client {
            Some(client) => release_digest::fetch_official_sha256(
                &client,
                INDEX_CHANNEL,
                INDEX_TAG,
                INDEX_ASSET,
            )
            .await
            .ok(),
            None => None,
        };
        let matches_release = match (&digest, index.source_sha256.as_str()) {
            // A legacy cache without a stamp can only be TTL-checked.
            (Some(remote), local) => local.is_empty() || remote == local,
            (None, _) => true,
        };
        if localized && fresh && matches_release {
            return Ok(index.clone());
        }
        if digest.is_some() && !matches_release {
            tracing::info!("cached mod catalog predates the release digest — refetching");
        }
        if !localized && !index.mods.is_empty() {
            tracing::info!("cached mod catalog predates i18n — refetching");
            cached = None;
        }
    }
    let fetched = fetch_index().await;
    match fetched {
        Ok((index, _)) => {
            let path = data_file(INDEX_CACHE_FILE)?;
            let json =
                serde_json::to_string(&index).map_err(|e| anyhow!("serialize index: {e}"))?;
            let tmp = path.with_extension("json.tmp");
            fs::write(&tmp, json).map_err(|e| anyhow!("write cache: {e}"))?;
            fs::rename(&tmp, &path).map_err(|e| anyhow!("rename cache: {e}"))?;
            if let Ok(legacy) = data_file(LEGACY_INDEX_CACHE_FILE) {
                let _ = fs::remove_file(legacy);
            }
            Ok(index)
        },
        Err(e) => match cached {
            Some(index) => {
                tracing::warn!(error = %e, "catalog refresh failed — serving the stale cache");
                Ok(index)
            },
            None => Err(e.into()),
        },
    }
}

/// Whether the index's fetch stamp is younger than the cache TTL.
fn fetched_recently(fetched_at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(fetched_at)
        .map(|t| Utc::now().signed_duration_since(t).num_hours() < INDEX_CACHE_TTL_HOURS)
        .unwrap_or(false)
}

/// The cached catalog index, shared read-only with sibling modules
/// (foreign-unit pairing reads it; writes stay in this module).
pub(crate) fn load_cached_index() -> Option<CatalogIndex> {
    let raw = fs::read_to_string(data_file(INDEX_CACHE_FILE).ok()?).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) async fn fetch_index() -> anyhow::Result<(CatalogIndex, String)> {
    let client = crate::commands::network::build_http_client()?;
    // The official digest comes first, over the two channels the payload
    // mirrors can influence neither (the pairing relay's signed doc,
    // cross-checked with api.github.com): a mirror could otherwise forge
    // the index together with every package hash inside it. No digest →
    // no refresh (the caller keeps serving the last verified cache).
    let expected =
        release_digest::fetch_official_sha256(&client, INDEX_CHANNEL, INDEX_TAG, INDEX_ASSET)
            .await
            .map_err(|e| anyhow!("catalog index cannot be verified: {e}"))?;
    let mut last_err = String::from("no index url attempted");
    for url in index_urls() {
        // The shared client caps only the CONNECT phase; a mirror that
        // accepts the connection but trickles the body would otherwise
        // hang `mod_catalog_refresh` (and every freshness assessment
        // joined onto it) forever. A 30s total cap per URL keeps the
        // failover ladder moving instead.
        let resp = client
            .get(&url)
            .timeout(std::time::Duration::from_secs(30))
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache")
            .send()
            .await;
        let resp = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("{url}: HTTP {}", r.status());
                continue;
            },
            Err(e) => {
                last_err = format!("{url}: {e}");
                continue;
            },
        };
        match resp.bytes().await {
            // A stale or tampered mirror copy fails over to the next one.
            Ok(bytes) if release_digest::sha256_hex(&bytes) != expected => {
                last_err = format!("{url}: index does not match the official sha256 digest");
            },
            Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(raw) => {
                    let mut index = parse_index(&raw)?;
                    index.fetched_at = Utc::now().to_rfc3339();
                    index.source_sha256 = expected.clone();
                    return Ok((index, expected));
                },
                Err(e) => last_err = format!("{url}: parse: {e}"),
            },
            Err(e) => last_err = format!("{url}: read: {e}"),
        }
    }
    Err(anyhow!("catalog index unreachable: {last_err}"))
}

#[derive(Deserialize)]
struct RawIndex {
    #[serde(default)]
    source: Option<RawSource>,
    #[serde(default)]
    mods: std::collections::HashMap<String, RawMod>,
}

#[derive(Deserialize)]
struct RawSource {
    #[serde(default)]
    content_version: Option<String>,
    #[serde(default)]
    game_version: Option<String>,
}

#[derive(Deserialize)]
struct RawMod {
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    discussion: Option<u64>,
    #[serde(default)]
    latest: Option<String>,
    /// Withdrawn from the catalog (its discussion thread was closed);
    /// the entry is kept so deep links can explain the delisting.
    #[serde(default)]
    delisted: Option<bool>,
    /// Registry tag ids (front-matter `tags:` — licensed, AI-generated,
    /// IP origins…). Definitions live in the mod-tags registry.
    #[serde(default)]
    tags: Vec<String>,
    /// Foreign-installer names (front-matter `aliases:`) — Aslain manifest
    /// row ids and on-disk directory names this entry answers to exactly.
    #[serde(default)]
    aliases: Vec<String>,
    /// Server realms this entry applies to (front-matter `servers:`),
    /// canonical realm codes — `ru`/`eu`/`na`/`asia`/`cn`. Empty
    /// means universal (applies on every server).
    #[serde(default)]
    servers: Vec<String>,
    /// Folded style family: legacy one-entry-per-variant ids → preset
    /// ids (see `CatalogEntry::supersedes`).
    #[serde(default)]
    supersedes: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    versions: std::collections::HashMap<String, RawVersion>,
}

#[derive(Clone, Deserialize)]
struct RawPreset {
    id: String,
    #[serde(default)]
    name_zh: String,
    #[serde(default)]
    name_en: String,
    #[serde(default)]
    packages: Option<Vec<RawPackage>>,
    /// This scheme's own preview screenshot — folded style families
    /// carry one per variant so the detail pane swaps images with the
    /// button group.
    #[serde(default)]
    preview: Option<String>,
    /// This scheme's own description pair (the variant's caveats).
    #[serde(default)]
    desc_zh: Option<String>,
    #[serde(default)]
    desc_en: Option<String>,
}

#[derive(Clone, Deserialize)]
struct RawVersion {
    #[serde(default)]
    game: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    name_en: Option<String>,
    #[serde(default)]
    name_zh: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// Ships inside the WoWSP app — listed without download packages.
    #[serde(default)]
    bundled: Option<bool>,
    #[serde(default)]
    i18n: std::collections::HashMap<String, RawI18n>,
    /// First preview screenshot, a GitHub user-attachment URL. Rendered in
    /// the catalog detail pane through the `media` proxy (mirror ladder +
    /// app proxy + disk cache) — the raw URL is neither inside the webview's
    /// CSP `img-src` nor reliably reachable directly.
    #[serde(default)]
    preview: Option<String>,
    #[serde(default)]
    authors: Option<Vec<RawCatalogAuthor>>,
    /// Legacy singular author fields from pre-array indexes; synthesized
    /// into the authors list when `authors` is absent.
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    author_url: Option<String>,
    #[serde(default)]
    packages: Option<Vec<RawPackage>>,
    /// Named install-time schemes, declaration order preserved. Version-
    /// level like every other catalog-facing payload (the indexer writes
    /// them beside `packages`).
    #[serde(default)]
    presets: Vec<RawPreset>,
}

#[derive(Clone, Deserialize)]
struct RawCatalogAuthor {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Clone, Deserialize)]
struct RawI18n {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    desc: Option<String>,
}

#[derive(Clone, Deserialize)]
struct RawPackage {
    url: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    name: Option<String>,
}

/// Raw wire packages → DTO (name falls back to the last URL segment).
fn raw_packages(list: Vec<RawPackage>) -> Vec<CatalogPackage> {
    list.into_iter()
        .map(|p| {
            let name = p.name.unwrap_or_else(|| {
                p.url
                    .rsplit('/')
                    .next()
                    .unwrap_or("package.zip")
                    .to_string()
            });
            CatalogPackage {
                url: p.url,
                sha256: p.sha256.unwrap_or_default(),
                size: p.size.unwrap_or(0),
                name,
            }
        })
        .collect()
}

/// Tolerant `mod-index.json` → DTO: community-crawled indexes fill fewer
/// fields than the publisher's; entries without packages are not installable
/// and get dropped here so the UI only ever renders actionable rows.
pub(crate) fn parse_index(raw: &serde_json::Value) -> anyhow::Result<CatalogIndex> {
    let raw: RawIndex =
        serde_json::from_value(raw.clone()).map_err(|e| anyhow!("index shape: {e}"))?;
    let mut mods = Vec::new();
    for (id, m) in raw.mods {
        let latest = match m.latest.clone() {
            Some(v) => v,
            None => match m.versions.keys().max() {
                Some(v) => v.clone(),
                None => continue,
            },
        };
        let Some(ver) = m.versions.get(&latest) else {
            continue;
        };
        let packages: Vec<CatalogPackage> = raw_packages(ver.packages.clone().unwrap_or_default());
        // Entries with no packages ship inside the app itself (the in-game
        // stats plugin is the first) — they stay listed, marked
        // bundled-installed by the UI, and are not downloadable. A delisted
        // entry survives package-less too: deep links need it to explain
        // the withdrawal even if the closed thread lost its links.
        let delisted = m.delisted.unwrap_or(false);
        if !ver.bundled.unwrap_or(false) && packages.is_empty() && !delisted {
            continue;
        }
        mods.push(CatalogEntry {
            id: id.clone(),
            category: m.category.unwrap_or_else(|| "aux".into()),
            discussion: m.discussion,
            version: latest,
            game: ver.game.clone().unwrap_or_else(|| "*".into()),
            bundled: ver.bundled.unwrap_or(false),
            delisted,
            tags: m.tags.clone(),
            presets: ver
                .presets
                .clone()
                .into_iter()
                .filter_map(|p| {
                    let pkgs = raw_packages(p.packages.clone().unwrap_or_default());
                    if pkgs.is_empty() {
                        return None;
                    }
                    Some(CatalogPreset {
                        id: p.id,
                        name_zh: p.name_zh,
                        name_en: p.name_en,
                        packages: pkgs,
                        preview: p.preview,
                        desc_zh: p.desc_zh,
                        desc_en: p.desc_en,
                    })
                })
                .collect(),
            title: ver.title.clone().unwrap_or_else(|| id.clone()),
            name_zh: ver.name_zh.clone().unwrap_or_default(),
            name_en: ver
                .name_en
                .clone()
                .unwrap_or_else(|| ver.title.clone().unwrap_or_else(|| id.clone())),
            description: ver.description.clone().unwrap_or_default(),
            authors: ver
                .authors
                .clone()
                .map(|list| {
                    list.into_iter()
                        .map(|a| CatalogAuthor {
                            name: a.name.unwrap_or_default(),
                            url: a.url.unwrap_or_default(),
                        })
                        .filter(|a| !a.name.is_empty())
                        .collect()
                })
                .unwrap_or_else(|| {
                    // Legacy index: synthesize the single tag from the
                    // singular fields.
                    match (ver.author.clone(), ver.author_url.clone()) {
                        (Some(name), _) if !name.is_empty() => {
                            vec![CatalogAuthor {
                                name,
                                url: ver.author_url.clone().unwrap_or_default(),
                            }]
                        },
                        _ => Vec::new(),
                    }
                }),
            aliases: m.aliases.clone(),
            servers: m.servers.clone(),
            preview: ver.preview.clone(),
            supersedes: m.supersedes.clone(),
            i18n: ver
                .i18n
                .iter()
                .map(|(lang, text)| {
                    (
                        lang.clone(),
                        CatalogEntryI18n {
                            name: text.name.clone().unwrap_or_default(),
                            description: text.desc.clone().unwrap_or_default(),
                        },
                    )
                })
                .collect(),
            packages,
        });
    }
    mods.sort_by(|a, b| a.category.cmp(&b.category).then(a.id.cmp(&b.id)));
    let source = raw.source.unwrap_or(RawSource {
        content_version: None,
        game_version: None,
    });
    Ok(CatalogIndex {
        source_version: source
            .content_version
            .unwrap_or_else(|| "community crawl".into()),
        game_version: source.game_version.unwrap_or_else(|| "*".into()),
        fetched_at: Utc::now().to_rfc3339(),
        // Filled in by `fetch_index` once the bytes match the official
        // digest; parse-only paths (tests) carry an empty stamp.
        source_sha256: String::new(),
        mods,
    })
}
