//! Supporter (合作主播) Bilibili avatars for the About page's cards.
//!
//! The credits section leads with the partner streamers, each card showing
//! their CURRENT Bilibili avatar — "current" as in fetched live, so a
//! changed avatar shows up without an app release. Source is Bilibili's
//! public user-card API (`api.bilibili.com/x/web-interface/card?mid=`),
//! which needs no auth from residential networks.
//!
//! Design points:
//!
//!   - NO mirror ladder: Bilibili is directly reachable in mainland China
//!     (the ladder exists for GitHub, which is the blocked one); the
//!     request still goes through the shared proxy-aware client.
//!   - last-good cache: `supporters/avatars.json` under the AppData root
//!     maps uid → face URL. A successful answer refreshes the entry; a
//!     failure (API risk-control, offline) answers the cached URL; no
//!     cached URL either → the frontend renders the initial-letter
//!     fallback. Nothing here ever fails the command.
//!   - The FACE URL is then loaded through the `media://` image proxy
//!     (allowlisted for `*.hdslb.com`), which disk-caches it — repeated
//!     About opens cost nothing.

use std::collections::BTreeMap;
use std::time::Duration;

use futures::future::join_all;
use wowsp_tauri_shared::SupporterAvatar;

use super::appdata;

const CARD_API: &str = "https://api.bilibili.com/x/web-interface/card";
const CACHE_FILE: &str = "supporters/avatars.json";
/// A browser-shaped UA: Bilibili's risk control rejects plainly bot-ish
/// agents.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

fn load_cache() -> BTreeMap<String, String> {
    appdata::read_appdata_json(CACHE_FILE)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_cache(cache: &BTreeMap<String, String>) {
    if let Ok(body) = serde_json::to_string(cache) {
        // Best-effort: a failed cache write only costs a re-fetch next time.
        let _ = appdata::write_appdata_json(CACHE_FILE, &body);
    }
}

/// One uid's avatar: live answer, else cached, else `face: null` (the
/// frontend falls back to the initial letter). Never errors.
async fn fetch_one(client: &reqwest::Client, uid: u64, cached: Option<String>) -> SupporterAvatar {
    let fallback = || SupporterAvatar {
        uid,
        face: cached.clone(),
    };
    let resp = match client
        .get(format!("{CARD_API}?mid={uid}"))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(6))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp,
        _ => return fallback(),
    };
    let body = match resp.text().await {
        Ok(body) => body,
        Err(_) => return fallback(),
    };
    // `{"code":0,"data":{"card":{"face":"https://i0.hdslb.com/bfs/face/…"}}}`.
    let face = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("data")
                .and_then(|d| d.get("card"))
                .and_then(|c| c.get("face"))
                .and_then(|f| f.as_str())
                .map(str::to_string)
        })
        .filter(|f| f.starts_with("https://"));
    match face {
        Some(face) => SupporterAvatar {
            uid,
            face: Some(face),
        },
        None => fallback(),
    }
}

/// Resolve the supporters' avatar URLs (see the module docs). One entry
/// per input uid, in order. The only rejection is client construction
/// (broken proxy config) — per-uid failures answer the cached URL or a
/// `null` face.
#[tauri::command]
pub async fn get_supporter_avatars(uids: Vec<u64>) -> Result<Vec<SupporterAvatar>, String> {
    let client = super::network::build_http_client()?;
    let mut cache = load_cache();
    let results = join_all(
        uids.iter()
            .map(|uid| fetch_one(&client, *uid, cache.get(&uid.to_string()).cloned())),
    )
    .await;
    for avatar in &results {
        if let Some(face) = &avatar.face {
            cache.insert(avatar.uid.to_string(), face.clone());
        }
    }
    if !results.is_empty() {
        save_cache(&cache);
    }
    Ok(results)
}
