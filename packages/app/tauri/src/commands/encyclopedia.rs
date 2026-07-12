//! Wargaming encyclopedia API (milestone M10).
//!
//! Two endpoints:
//!   info   GET /wows/encyclopedia/info/    → game_version + ships_total
//!   ships  GET /wows/encyclopedia/ships/   → full shipopedia (paginated, 100/page)
//!
//! Both are cached to AppData, keyed by game version, so a cold client pays
//! one big fetch on first use and then serves from disk until the game
//! patches. Version detection drives cache invalidation AND trend bucketing.

use std::fs;

use serde::Deserialize;
use wowsp_tauri_shared::{GameVersionInfo, ShipInfo};

/// Public WG app id (same constant as wg_api.rs — kept duplicated to avoid a
/// cross-module dependency on a private item).
const WG_APP_ID: &str = "447ec579e994976e39dec0e7d0bac644";

const INFO_CACHE: &str = "encyclopedia/info.json";

/// Fetch (and cache) the current WG game version + total ship count.
#[tauri::command]
pub async fn get_game_version() -> Result<GameVersionInfo, String> {
    get_game_version_pub().await
}

/// Non-#[tauri::command] entry point so sibling modules (ship_stats) can call
/// the version fetch without going through the command dispatcher.
pub async fn get_game_version_pub() -> Result<GameVersionInfo, String> {
    // Cache hit?
    if let Ok(Some(raw)) = appdata_read(INFO_CACHE.into()) {
        if let Ok(info) = serde_json::from_str::<GameVersionInfo>(&raw) {
            return Ok(info);
        }
    }
    let app_id = std::env::var("WOWSP_WG_APPLICATION_ID").unwrap_or_else(|_| WG_APP_ID.to_string());
    let client = wg_client()?;
    // encyclopedia/info isn't realm-specific in content, but the API requires a
    // valid realm host. Use asia as the canonical source.
    let url = format!(
        "https://api.worldofwarships.asia/wows/encyclopedia/info/?application_id={app_id}&language=en"
    );
    let resp: WgResponse<serde_json::Value> = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("encyclopedia/info request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("encyclopedia/info parse: {e}"))?;
    if resp.status != "ok" {
        return Err(format!(
            "encyclopedia/info: {}",
            resp.error.message.unwrap_or_default()
        ));
    }
    let data = resp.data.unwrap_or_default();
    let game_version = data
        .get("game_version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let ships_total = data.get("ships_total").and_then(|v| v.as_i64()).unwrap_or(0);
    let info = GameVersionInfo {
        game_version,
        ships_total,
        timestamp: now_ts(),
    };
    // Persist (best-effort).
    let _ = appdata_write(INFO_CACHE.into(), serde_json::to_string(&info).unwrap_or_default());
    Ok(info)
}

/// Fetch (and cache, per game version + language) the full ship encyclopedia.
/// `force_refresh` bypasses the cache.
///
/// **Language selection**: WoWSP uses compound locale tags (`zhs-cn`,
/// `zhs-asia`, `en-eu`, etc.) as cache keys for external data, because the
/// same WG language code can produce different ship names on different realms
/// (CN's zh-cn = animal names for IJN, ASIA's zh-cn = historical names).
///
/// The cache is keyed by `<version>-<compound>` so switching realm or UI
/// language re-fetches with the correct localization.
#[tauri::command]
pub async fn get_ship_encyclopedia(
    realm: String,
    force_refresh: bool,
    language: Option<String>,
) -> Result<Vec<ShipInfo>, String> {
    let version = get_game_version().await?.game_version;
    let (compound, wg_lang) = resolve_encyclopedia_language(&realm, language);
    // Schema version: bump when the cached ShipInfo shape changes (e.g. adding
    // the `images` field). This invalidates old caches automatically — users
    // don't need to manually clear AppData after an app update.
    const CACHE_SCHEMA: u32 = 2; // v2: added ShipImages
    let cache_file = format!("encyclopedia/ships-{version}-{compound}-s{CACHE_SCHEMA}.json");

    if !force_refresh {
        if let Ok(Some(raw)) = appdata_read(cache_file.clone()) {
            if let Ok(cached) = serde_json::from_str::<CachedShips>(&raw) {
                if cached.game_version == version {
                    return Ok(cached.ships);
                }
            }
        }
    }

    let app_id = std::env::var("WOWSP_WG_APPLICATION_ID").unwrap_or_else(|_| WG_APP_ID.to_string());
    let host = realm_host(&realm)?;
    let client = wg_client()?;

    let mut all: Vec<ShipInfo> = Vec::new();
    let mut page_no = 1;
    loop {
        let url = format!(
            "https://api.worldofwarships.{host}/wows/encyclopedia/ships/?application_id={app_id}&language={wg_lang}&limit=100&page_no={page_no}&fields=ship_id,name,tier,type,nation,is_premium,is_special,description,default_profile,images"
        );
        let resp: WgResponse<serde_json::Map<String, serde_json::Value>> = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("encyclopedia/ships page {page_no} request: {e}"))?
            .json()
            .await
            .map_err(|e| format!("encyclopedia/ships page {page_no} parse: {e}"))?;
        if resp.status != "ok" {
            return Err(format!(
                "encyclopedia/ships: {}",
                resp.error.message.unwrap_or_default()
            ));
        }
        let data = resp.data.unwrap_or_default();
        // data is { "<shipId>": { ... }, ... }
        for (_id, value) in data {
            if let Ok(ship) = parse_ship(&value, &version) {
                all.push(ship);
            }
        }
        // WG pagination: meta.page_total tells us how many pages.
        let page_total = resp
            .meta
            .as_ref()
            .and_then(|m| m.get("page_total"))
            .and_then(|v| v.as_i64())
            .unwrap_or(1);
        if page_no as i64 >= page_total {
            break;
        }
        page_no += 1;
    }

    // Persist cache.
    let cached = CachedShips {
        game_version: version.clone(),
        realm: realm.clone(),
        timestamp: now_ts(),
        ships: all.clone(),
    };
    let _ = appdata_write(
        cache_file,
        serde_json::to_string(&cached).unwrap_or_default(),
    );
    Ok(all)
}

fn parse_ship(value: &serde_json::Value, version: &str) -> Result<ShipInfo, String> {
    Ok(ShipInfo {
        ship_id: value
            .get("ship_id")
            .and_then(|v| v.as_i64())
            .ok_or("missing ship_id")?,
        name: value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        tier: value
            .get("tier")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i8,
        type_: value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        nation: value
            .get("nation")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        is_premium: value
            .get("is_premium")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        is_special: value
            .get("is_special")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        description: value
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        game_version: version.to_string(),
        default_profile: value.get("default_profile").cloned().unwrap_or(serde_json::Value::Null),
        images: parse_ship_images(value.get("images")),
    })
}

/// Extract the ShipImages struct from the WG `images` object. The WG API
/// returns `{"small": "...", "medium": "...", "large": "...", "contour": "..."}`.
/// Missing keys → empty string (graceful degradation).
fn parse_ship_images(images: Option<&serde_json::Value>) -> wowsp_tauri_shared::ShipImages {
    let img = match images {
        Some(v) if v.is_object() => v,
        _ => return Default::default(),
    };
    let get = |key: &str| -> String {
        img.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    wowsp_tauri_shared::ShipImages {
        small: get("small"),
        medium: get("medium"),
        large: get("large"),
        contour: get("contour"),
    }
}

/// Resolve the WG API `language` parameter for encyclopedia requests.
///
/// WoWSP uses a **compound locale** scheme for external data:
///   `<ui-lang>-<realm>` → e.g. "zhs-cn", "zhs-asia", "en-asia", "ja-asia".
///
/// This distinguishes the same language across different realms — notably
/// CN's zh-cn uses animal names for IJN ships ("动物园"), while ASIA's zh-cn
/// uses historical names. The compound tag is the cache key, so switching
/// realm re-fetches with the right names.
///
/// The caller passes the UI language (zhs/zht/en/fr/...) and the realm.
/// This function combines them into:
///   1. A compound tag for caching: "zhs-cn", "zhs-asia", etc.
///   2. A WG API language code for the request: zh-cn, zh-tw, en, ja, ...
fn resolve_encyclopedia_language(realm: &str, ui_language: Option<String>) -> (String, String) {
    let ui = ui_language.as_deref().unwrap_or("en");

    // Map UI locale → WG API language code.
    let wg_lang = match ui {
        "zhs" => "zh-cn",
        "zht" => "zh-tw",
        "en" => "en",
        "ja" => "ja",
        "ko" => "ko",
        "fr" => "fr",
        "es" => "es",
        "ru" => "ru",
        _ => "en", // unknown UI locale → English
    };

    // Compound tag: <ui-lang>-<realm>. This is the cache discriminator.
    // CN realm is special — it always uses WG's zh-cn, but the compound tag
    // still records it as "zhs-cn" (or "<ui>-cn") so switching from ASIA
    // to CN re-fetches.
    let compound = format!("{ui}-{realm}");

    (compound, wg_lang.to_string())
}

// ── helpers shared with wg_api.rs (duplicated to avoid cross-module churn) ──

fn wg_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("WoWSP/0.1 (https://github.com/celestia-island/wowsp)")
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn realm_host(realm: &str) -> Result<&'static str, String> {
    Ok(match realm {
        "ru" => "ru",
        "eu" => "eu",
        "na" => "com",
        "asia" => "asia",
        other => return Err(format!("unsupported realm '{other}'")),
    })
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// Reuse the appdata persistence (same logic as appdata.rs commands, but called
// internally — we can't call the #[tauri::command] fn directly without the
// invoke glue, so we read/write the same paths).
fn appdata_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs_next::data_dir().ok_or_else(|| "cannot resolve AppData dir".to_string())?;
    let dir = base.join("WoWSP");
    fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

fn appdata_read(file: String) -> Result<Option<String>, String> {
    let path = appdata_dir()?.join(&file);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

fn appdata_write(file: String, content: String) -> Result<(), String> {
    let dir = appdata_dir()?;
    let path = dir.join(&file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    let tmp = dir.join(format!("{file}.tmp"));
    fs::write(&tmp, &content).map_err(|e| format!("write {tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} → {path:?}: {e}"))?;
    Ok(())
}

// ── WG response envelope ────────────────────────────────────────────────

#[derive(Deserialize)]
struct WgResponse<T> {
    status: String,
    data: Option<T>,
    meta: Option<serde_json::Value>,
    #[serde(default)]
    error: WgError,
}
#[derive(Deserialize, Default)]
struct WgError {
    message: Option<String>,
}

#[derive(Deserialize, serde::Serialize)]
#[allow(dead_code)]
struct CachedShips {
    game_version: String,
    realm: String,
    timestamp: i64,
    ships: Vec<ShipInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_ship_entry() {
        // Shape lifted from a real /wows/encyclopedia/ships/ response.
        let raw = serde_json::json!({
            "ship_id": 4282948544_i64,
            "name": "Montana",
            "tier": 10,
            "type": "Battleship",
            "nation": "usa",
            "is_premium": false,
            "is_special": false,
            "description": "One of the most powerful battleships...",
            "default_profile": {
                "hull": { "health": 96300 },
                "artillery": { "max_dispersion": 289 }
            }
        });
        let ship = parse_ship(&raw, "0.11.4").unwrap();
        assert_eq!(ship.ship_id, 4282948544);
        assert_eq!(ship.name, "Montana");
        assert_eq!(ship.tier, 10);
        assert_eq!(ship.type_, "Battleship");
        assert_eq!(ship.nation, "usa");
        assert!(!ship.is_premium);
        assert_eq!(ship.game_version, "0.11.4");
        assert_eq!(
            ship.default_profile
                .get("hull")
                .and_then(|h| h.get("health"))
                .and_then(|v| v.as_i64()),
            Some(96300)
        );
    }

    #[test]
    fn parse_ship_handles_missing_optional_fields() {
        let raw = serde_json::json!({ "ship_id": 1, "name": "Test" });
        let ship = parse_ship(&raw, "1.0").unwrap();
        assert_eq!(ship.tier, 0);
        assert_eq!(ship.type_, "");
        assert_eq!(ship.nation, "");
        assert!(ship.default_profile.is_null());
    }

    #[test]
    fn realm_host_maps() {
        assert_eq!(realm_host("na").unwrap(), "com");
        assert_eq!(realm_host("asia").unwrap(), "asia");
        assert!(realm_host("cn").is_err());
    }

    #[test]
    fn cn_realm_compound_tag_and_wg_lang() {
        let (compound, wg) = resolve_encyclopedia_language("cn", Some("zhs".into()));
        assert_eq!(compound, "zhs-cn");
        assert_eq!(wg, "zh-cn");
    }

    #[test]
    fn asia_realm_compound_tag_and_wg_lang() {
        let (compound, wg) = resolve_encyclopedia_language("asia", Some("zhs".into()));
        assert_eq!(compound, "zhs-asia");
        assert_eq!(wg, "zh-cn");

        let (compound, wg) = resolve_encyclopedia_language("asia", Some("zht".into()));
        assert_eq!(compound, "zht-asia");
        assert_eq!(wg, "zh-tw");

        let (compound, wg) = resolve_encyclopedia_language("asia", Some("en".into()));
        assert_eq!(compound, "en-asia");
        assert_eq!(wg, "en");
    }

    #[test]
    fn unknown_ui_language_falls_back_to_english() {
        let (compound, wg) = resolve_encyclopedia_language("eu", Some("xxx".into()));
        assert_eq!(wg, "en");
        assert_eq!(compound, "xxx-eu");
    }

    #[test]
    fn cache_key_uses_compound_tag() {
        let v = "15.5.0";
        const SCHEMA: u32 = 2;
        let (compound, _) = resolve_encyclopedia_language("cn", Some("zhs".into()));
        let cache = format!("encyclopedia/ships-{v}-{compound}-s{SCHEMA}.json");
        assert_eq!(cache, "encyclopedia/ships-15.5.0-zhs-cn-s2.json");

        let (compound2, _) = resolve_encyclopedia_language("asia", Some("zhs".into()));
        let cache2 = format!("encyclopedia/ships-{v}-{compound2}-s{SCHEMA}.json");
        assert_eq!(cache2, "encyclopedia/ships-15.5.0-zhs-asia-s2.json");
    }
}
