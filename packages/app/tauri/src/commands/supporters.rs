//! Supporter Bilibili avatars for the About page's special-thanks cards.
//!
//! The credits section leads with the special-thanks cards, each showing
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
    // Cached values re-run the same normalization the live path applies,
    // so a hand-edited cache file answers nothing normalize_face would
    // have rejected (defense in depth — the media proxy's host allowlist
    // gates the actual fetch either way).
    appdata::read_appdata_json(CACHE_FILE)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(uid, face)| normalize_face(&face).map(|f| (uid, f)))
        .collect()
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
                .and_then(normalize_face)
        });
    match face {
        Some(face) => SupporterAvatar {
            uid,
            face: Some(face),
        },
        None => fallback(),
    }
}

/// Accept a Bilibili face URL in any of the forms the card API returns —
/// `https://…`, `http://…` (animated GIF avatars in particular keep
/// arriving as plain http), or protocol-relative `//…` — and normalize it
/// to `https://` (the media proxy only fetches https). Anything else is
/// rejected. Pure and unit-tested.
fn normalize_face(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("//"))?;
    Some(format!("https://{rest}"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_face_upgrades_schemes_and_rejects_foreign_urls() {
        // https passes through untouched (animated GIF avatars arrive as
        // plain http on some accounts — the reason one supporter's avatar
        // initially fell back to the initial disc).
        assert_eq!(
            normalize_face("https://i2.hdslb.com/bfs/face/abc.gif"),
            Some("https://i2.hdslb.com/bfs/face/abc.gif".to_string())
        );
        assert_eq!(
            normalize_face("http://i2.hdslb.com/bfs/face/abc.gif"),
            Some("https://i2.hdslb.com/bfs/face/abc.gif".to_string())
        );
        assert_eq!(
            normalize_face("//i2.hdslb.com/bfs/face/a.jpg"),
            Some("https://i2.hdslb.com/bfs/face/a.jpg".to_string())
        );
        // Anything the media proxy could not vouch for is dropped.
        assert_eq!(normalize_face("ftp://i2.hdslb.com/a.gif"), None);
        assert_eq!(normalize_face("javascript:alert(1)"), None);
        assert_eq!(normalize_face(""), None);
    }
}
