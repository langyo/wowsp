//! Wargaming Public API client (milestone M9).
//!
//! Looks up a player by name on a given realm and returns a compact stats
//! summary (battles, winrate, hidden flag, clan tag). The application_id is the
//! well-known public WG app id (same one ApeRadar ships — it is meant for
//! client-side use and rate-limited per IP, not secret).
//!
//! Endpoints (per realm):
//!   list    GET https://api.worldofwarships.<realm>/wows/account/list/?application_id=..&search=<name>
//!   stats   GET https://api.worldofwarships.<realm>/wows/account/info/?application_id=..&account_id=<id>
//!   clan    GET https://api.worldofwarships.<realm>/wows/clans/accountinfo/?application_id=..&account_id=<id>
//!
//! Realm → host suffix: ru→ru, eu→eu, na→com, asia→asia, cn→cn (the cn realm
//! uses a different host; treated as unsupported here with a clear error).

use serde::Deserialize;
use wowsp_tauri_shared::PlayerStats;

/// Public WG application id (from ApeRadar's open source — rate-limited per IP,
/// not secret). Override with the `WOWSP_WG_APPLICATION_ID` env var.
const WG_APP_ID: &str = "447ec579e994976e39dec0e7d0bac644";

/// Look up one player's stats by name on the given realm.
#[tauri::command]
pub async fn lookup_player_stats(name: String, realm: String) -> Result<PlayerStats, String> {
    let app_id = std::env::var("WOWSP_WG_APPLICATION_ID").unwrap_or_else(|_| WG_APP_ID.to_string());
    let host = realm_host(&realm)?;
    let client = reqwest::Client::builder()
        .user_agent("WoWSP/0.1 (https://github.com/celestia-island/wowsp)")
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // 1. Resolve name → account_id via account/list.
    let list_url = format!(
        "https://api.worldofwarships.{host}/wows/account/list/?application_id={app_id}&search={name}&limit=1"
    );
    let list: WgResponse<Vec<AccountListEntry>> = client
        .get(&list_url)
        .send()
        .await
        .map_err(|e| format!("account/list request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("account/list parse: {e}"))?;
    if list.status != "ok" {
        return Err(format!(
            "account/list: {}",
            list.error.message.unwrap_or_default()
        ));
    }
    let entry = list
        .data
        .and_then(|mut d| d.pop())
        .ok_or_else(|| format!("no account found for '{name}' on {realm}"))?;

    // 2. Fetch account/info for battles + winrate. Hidden profiles return null
    //    statistics; we surface those as hidden=true.
    let info_url = format!(
        "https://api.worldofwarships.{host}/wows/account/info/?application_id={app_id}&account_id={}",
        entry.account_id
    );
    let info: WgResponse<serde_json::Value> = client
        .get(&info_url)
        .send()
        .await
        .map_err(|e| format!("account/info request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("account/info parse: {e}"))?;
    let stats_node = info
        .data
        .as_ref()
        .and_then(|d| {
            let key = entry.account_id.to_string();
            d.get(&key)
        })
        .and_then(|v| v.get("statistics"));
    let (battles, winrate, hidden) = match stats_node {
        Some(s) if !s.is_null() => {
            let battles_pvp = s
                .get("pvp")
                .and_then(|p| p.get("battles"))
                .and_then(|b| b.as_i64());
            let wins = s
                .get("pvp")
                .and_then(|p| p.get("wins"))
                .and_then(|w| w.as_i64());
            let wr = match (wins, battles_pvp) {
                (Some(w), Some(b)) if b > 0 => Some(100.0 * w as f32 / b as f32),
                _ => None,
            };
            (battles_pvp, wr, false)
        },
        _ => (None, None, true),
    };

    // 3. Optional clan tag lookup (best-effort — never fails the whole call).
    let clan_tag = match client
        .get(format!(
            "https://api.worldofwarships.{host}/wows/clans/accountinfo/?application_id={app_id}&account_id={}&extra=clan",
            entry.account_id
        ))
        .send()
        .await
    {
        Ok(r) => r
            .json::<WgResponse<serde_json::Value>>()
            .await
            .ok()
            .and_then(|resp| resp.data)
            .and_then(|d| {
                let key = entry.account_id.to_string();
                d.get(&key).cloned()
            })
            .and_then(|v| {
                v.get("clan")
                    .and_then(|c| c.get("tag"))
                    .and_then(|t| t.as_str())
                    .map(str::to_owned)
            }),
        Err(_) => None,
    };

    Ok(PlayerStats {
        account_id: entry.account_id,
        name: entry.nickname,
        realm,
        battles,
        winrate,
        hidden,
        clan_tag,
    })
}

fn realm_host(realm: &str) -> Result<&'static str, String> {
    Ok(match realm {
        "ru" => "ru",
        "eu" => "eu",
        "na" => "com",
        "asia" => "asia",
        other => {
            return Err(format!(
                "unsupported realm '{other}' (cn not supported by WG public API)"
            ));
        },
    })
}

#[derive(Deserialize)]
struct WgResponse<T> {
    status: String,
    data: Option<T>,
    #[serde(default)]
    error: WgError,
}
#[derive(Deserialize, Default)]
struct WgError {
    message: Option<String>,
}
#[derive(Deserialize)]
struct AccountListEntry {
    account_id: i64,
    nickname: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realm_host_maps_known_realms() {
        assert_eq!(realm_host("ru").unwrap(), "ru");
        assert_eq!(realm_host("na").unwrap(), "com");
        assert_eq!(realm_host("asia").unwrap(), "asia");
        assert!(realm_host("cn").is_err());
        assert!(realm_host("xx").is_err());
    }
}
