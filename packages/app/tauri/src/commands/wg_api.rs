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
    let player_node = info
        .data
        .as_ref()
        .and_then(|d| {
            let key = entry.account_id.to_string();
            d.get(&key)
        });
    let stats_node = player_node.and_then(|v| v.get("statistics"));
    let p = PvpStats::extract(stats_node);
    let hidden = stats_node.map_or(true, |s| s.get("pvp").map_or(true, |p| p.is_null()));
    // Service record tier + points (for rank badge rendering).
    let leveling_tier = player_node
        .and_then(|v| v.get("leveling_tier"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);
    let leveling_points = player_node
        .and_then(|v| v.get("leveling_points"))
        .and_then(|v| v.as_i64());

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

    // 4. Dog tag lookup via the WG Vortex API (best-effort — never fails the
    //    whole call). Vortex returns the player's personalized emblem
    //    components (background, texture, symbol, border/background colors).
    let dog_tag = match client
        .get(format!(
            "https://vortex.worldofwarships.{host}/api/accounts/{}",
            entry.account_id
        ))
        .send()
        .await
    {
        Ok(r) => {
            let vortex: Option<serde_json::Value> = r.json().await.ok();
            vortex
                .as_ref()
                .and_then(|v| {
                    v.get("data")
                        .and_then(|d| d.get(&entry.account_id.to_string()))
                        .and_then(|p| p.get("dog_tag"))
                        .filter(|t| !t.is_null())
                })
                .and_then(parse_dog_tag)
        }
        Err(_) => None,
    };

    Ok(PlayerStats {
        account_id: entry.account_id,
        name: entry.nickname,
        realm,
        battles: p.battles,
        winrate: p.winrate,
        hidden,
        clan_tag,
        avg_damage: p.avg_damage,
        avg_xp: p.avg_xp,
        kd_ratio: p.kd_ratio,
        survival_rate: p.survival_rate,
        hit_rate: p.hit_rate,
        pr: p.pr,
        ships_played: p.ships_played,
        leveling_tier,
        leveling_points,
        dog_tag,
        solo_wr: p.solo_wr,
        div2_wr: p.div2_wr,
        div3_wr: p.div3_wr,
    })
}

/// Parse a dog_tag JSON object from the Vortex API into a DogTag struct.
/// The Vortex response has fields like `texture_id`, `symbol_id`,
/// `border_color_id`, `background_color_id`, `background_id`. The color
/// fields are ARGB-packed u32 values.
fn parse_dog_tag(v: &serde_json::Value) -> Option<wowsp_tauri_shared::DogTag> {
    let get_u32 = |key: &str| -> u32 {
        v.get(key)
            .and_then(|x| x.as_u64())
            .map(|x| x as u32)
            .unwrap_or(0)
    };
    let tag = wowsp_tauri_shared::DogTag {
        texture_id: get_u32("texture_id"),
        symbol_id: get_u32("symbol_id"),
        border_color: get_u32("border_color_id"),
        background_color: get_u32("background_color_id"),
        background_id: get_u32("background_id"),
    };
    // Only return if at least some fields are non-zero.
    if tag.background_color != 0 || tag.border_color != 0 {
        Some(tag)
    } else {
        None
    }
}

/// Extracts deep PvP stats from the WG account/info `statistics.pvp` node.
/// All fields are optional — hidden profiles yield null, and casual accounts
/// may lack division splits. PR (Personal Rating) uses a community proxy
/// derived from avg_damage and winrate (not WG's internal hidden score).
struct PvpStats {
    battles: Option<i64>,
    winrate: Option<f32>,
    avg_damage: Option<f32>,
    avg_xp: Option<f32>,
    kd_ratio: Option<f32>,
    survival_rate: Option<f32>,
    hit_rate: Option<f32>,
    pr: Option<i64>,
    ships_played: Option<i64>,
    solo_wr: Option<f32>,
    div2_wr: Option<f32>,
    div3_wr: Option<f32>,
}

impl PvpStats {
    fn extract(stats: Option<&serde_json::Value>) -> Self {
        let statistics = stats.filter(|v| !v.is_null());
        let statistics = match statistics {
            Some(s) => s,
            None => return Self::empty(),
        };
        let pvp = statistics.get("pvp").filter(|v| !v.is_null());
        let pvp = match pvp {
            Some(p) => p,
            None => return Self::empty(),
        };

        let battles = get_i64(pvp, "battles");
        let wins = get_i64(pvp, "wins");
        let winrate = match (wins, battles) {
            (Some(w), Some(b)) if b > 0 => Some(100.0 * w as f32 / b as f32),
            _ => None,
        };

        let damage = get_i64(pvp, "damage_dealt").or_else(|| get_i64(pvp, "damage_caused"));
        let avg_damage = match (damage, battles) {
            (Some(d), Some(b)) if b > 0 => Some(d as f32 / b as f32),
            _ => None,
        };

        let xp = get_i64(pvp, "xp");
        let avg_xp = match (xp, battles) {
            (Some(x), Some(b)) if b > 0 => Some(x as f32 / b as f32),
            _ => None,
        };

        let frags = get_i64(pvp, "frags");
        let survived = get_i64(pvp, "survived_battles");
        let kd_ratio = match (frags, battles, survived) {
            (Some(f), Some(b), Some(s)) if b > s => Some(f as f32 / (b - s) as f32),
            _ => None,
        };
        let survival_rate = match (survived, battles) {
            (Some(s), Some(b)) if b > 0 => Some(100.0 * s as f32 / b as f32),
            _ => None,
        };

        // Main battery shots/hits are nested under a "main_battery" sub-object
        // (WG changed the schema: formerly flat main_battery_shots/hits, now
        // main_battery.{shots,hits}). Try both layouts for compatibility.
        let mb = pvp.get("main_battery");
        let shots = mb
            .and_then(|m| get_i64(m, "shots"))
            .or_else(|| get_i64(pvp, "main_battery_shots"));
        let hits = mb
            .and_then(|m| get_i64(m, "hits"))
            .or_else(|| get_i64(pvp, "main_battery_hits"));
        let hit_rate = match (hits, shots) {
            (Some(h), Some(s)) if s > 0 => Some(100.0 * h as f32 / s as f32),
            _ => None,
        };

        let ships_played = get_i64(pvp, "battles").and_then(|_| {
            // ships_played is approximated by counting ship entries — but
            // account/info doesn't include per-ship; we leave it as battles
            // count fallback (the ships/{shipId} endpoint gives the real count
            // in a follow-up call). Set to None for now.
            None::<i64>
        });

        let pr = compute_pr(avg_damage, winrate, battles);

        Self {
            battles,
            winrate,
            avg_damage,
            avg_xp,
            kd_ratio,
            survival_rate,
            hit_rate,
            pr,
            ships_played,
            solo_wr: div_wr(statistics, "pvp_solo"),
            div2_wr: div_wr(statistics, "pvp_div2"),
            div3_wr: div_wr(statistics, "pvp_div3"),
        }
    }

    fn empty() -> Self {
        Self {
            battles: None,
            winrate: None,
            avg_damage: None,
            avg_xp: None,
            kd_ratio: None,
            survival_rate: None,
            hit_rate: None,
            pr: None,
            ships_played: None,
            solo_wr: None,
            div2_wr: None,
            div3_wr: None,
        }
    }
}

fn get_i64(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

/// Extracts winrate from a per-division stats node (pvp_solo / pvp_div2 / pvp_div3).
fn div_wr(pvp: &serde_json::Value, key: &str) -> Option<f32> {
    let node = pvp.get(key)?;
    if node.is_null() {
        return None;
    }
    let b = node.get("battles")?.as_i64()?;
    let w = node.get("wins")?.as_i64()?;
    if b > 0 {
        Some(100.0 * w as f32 / b as f32)
    } else {
        None
    }
}

/// Community PR proxy (wows-numbers-style simplified). Returns None when the
/// needed inputs are absent. The real PR weights expected-damage by ship tier
/// — this is a coarse single-number approximation that's good enough for a
/// tier badge.
fn compute_pr(avg_damage: Option<f32>, winrate: Option<f32>, battles: Option<i64>) -> Option<i64> {
    let dmg = avg_damage?;
    let wr = winrate?;
    let _ = battles?;
    // Simplified weights (wows-numbers-inspired):
    //   damage carries ~70%, winrate carries ~30%.
    let damage_score = (dmg / 100.0).clamp(0.0, 40.0);
    let wr_score = ((wr - 35.0) / 5.0).clamp(0.0, 12.0);
    let pr = 200.0 + damage_score * 35.0 + wr_score * 30.0;
    Some(pr.round() as i64)
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

    #[test]
    fn pvp_stats_extracts_all_fields() {
        // Mirrors the real WG account/info response shape: the top-level is
        // "statistics", with "pvp" as a child. Damage is "damage_dealt" (WG
        // renamed it from "damage_caused"). Main battery shots/hits are nested
        // under a "main_battery" sub-object. Division splits are siblings of
        // "pvp" under "statistics" (pvp_solo / pvp_div2 / pvp_div3).
        let raw = serde_json::json!({
            "pvp": {
                "battles": 1000,
                "wins": 550,
                "damage_dealt": 1_500_000,
                "xp": 1_200_000,
                "frags": 800,
                "survived_battles": 300,
                "main_battery": { "shots": 5000, "hits": 1500 }
            },
            "pvp_solo": { "battles": 600, "wins": 330 },
            "pvp_div2": { "battles": 200, "wins": 110 },
            "pvp_div3": { "battles": 200, "wins": 110 }
        });
        let p = PvpStats::extract(Some(&raw));
        assert_eq!(p.battles, Some(1000));
        assert_eq!(p.winrate, Some(55.0));
        assert_eq!(p.avg_damage, Some(1500.0));
        assert_eq!(p.avg_xp, Some(1200.0));
        // 800 frags / 700 deaths ≈ 1.143
        assert!((p.kd_ratio.unwrap() - 1.143).abs() < 0.01);
        assert_eq!(p.survival_rate, Some(30.0));
        assert_eq!(p.hit_rate, Some(30.0));
        assert_eq!(p.solo_wr, Some(55.0));
        assert_eq!(p.div2_wr, Some(55.0));
        assert_eq!(p.div3_wr, Some(55.0));
        assert!(p.pr.is_some());
    }

    #[test]
    fn pvp_stats_empty_when_null() {
        let raw = serde_json::json!({ "pvp": null });
        let p = PvpStats::extract(Some(&raw));
        assert_eq!(p.battles, None);
        assert_eq!(p.winrate, None);
        assert_eq!(p.pr, None);
    }

    #[test]
    fn pvp_stats_empty_when_no_statistics_node() {
        let p = PvpStats::extract(None);
        assert_eq!(p.battles, None);
    }

    #[test]
    fn compute_pr_returns_none_for_missing_inputs() {
        assert_eq!(compute_pr(None, Some(55.0), Some(100)), None);
        assert_eq!(compute_pr(Some(1500.0), None, Some(100)), None);
        assert!(compute_pr(Some(1500.0), Some(55.0), Some(100)).is_some());
    }
}
