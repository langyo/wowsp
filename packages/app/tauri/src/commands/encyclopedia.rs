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

/// Fetch (and cache, per game version) the full ship encyclopedia for a realm.
/// `force_refresh` bypasses the cache and re-pulls from WG.
#[tauri::command]
pub async fn get_ship_encyclopedia(
    realm: String,
    force_refresh: bool,
) -> Result<Vec<ShipInfo>, String> {
    let version = get_game_version().await?.game_version;
    let cache_file = format!("encyclopedia/ships-{version}.json");

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
            "https://api.worldofwarships.{host}/wows/encyclopedia/ships/?application_id={app_id}&language=en&limit=100&page_no={page_no}&fields=ship_id,name,tier,type,nation,is_premium,is_special,description,default_profile"
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
    })
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
}
