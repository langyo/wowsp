//! Supporter Bilibili avatars for the About page's special-thanks cards,
//! plus the afdian sponsor list for the credits section's bottom group.
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
//!
//! The sponsor list follows the same never-fail shape: it is pulled from
//! the pairing relay's `/api/sponsors` (the worker's daily cron refreshes
//! it from afdian's open API — see packages/pairing-relay
//! crates/relay-core/src/sponsors.rs for the document's meaning), cached
//! last-good under `supporters/sponsors.json`, and answered empty when
//! neither exists (the frontend then hides the group).

use anyhow::{Context as _, Result};
use std::collections::BTreeMap;
use std::time::Duration;

use futures::future::join_all;
use wowsp_tauri_shared::{CommandResult, SponsorListDoc, SupporterAvatar};

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
async fn fetch_one(
    clients: &super::network::HttpPair,
    uid: u64,
    cached: Option<String>,
) -> SupporterAvatar {
    let fallback = || SupporterAvatar {
        uid,
        face: cached.clone(),
    };
    // Bilibili needs no mirror ladder, but the card GET still rides the
    // proxy→direct chain so a dead configured proxy cannot blank every
    // card behind the 6 s cap.
    let url = format!("{CARD_API}?mid={uid}");
    let host = super::upstream_health::host_of_url(&url).to_string();
    let resp =
        match super::upstream_health::send_with_fallback(clients, &host, "supporters", |client| {
            client
                .get(&url)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .timeout(Duration::from_secs(6))
        })
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
pub async fn get_supporter_avatars(uids: Vec<u64>) -> CommandResult<Vec<SupporterAvatar>> {
    let clients = super::network::HttpPair::build(|b| b)?;
    let mut cache = load_cache();
    let results = join_all(
        uids.iter()
            .map(|uid| fetch_one(&clients, *uid, cache.get(&uid.to_string()).cloned())),
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

// ── afdian sponsor list (relay-served, last-good cached) ────────────────

const SPONSORS_PATH: &str = "/api/sponsors";
const SPONSORS_CACHE: &str = "supporters/sponsors.json";
const SPONSORS_TIMEOUT: Duration = Duration::from_secs(8);

/// Shape gate on a sponsor document fresh off the wire — the relay
/// validates its own store, this re-checks what actually arrived (a
/// hijacked or broken response must never reach the UI). Pure and
/// unit-tested.
fn sponsors_doc_sane(doc: &SponsorListDoc) -> bool {
    doc.updated_at >= 0
        && doc.sponsors.len() <= 10_000
        && doc.sponsors.iter().all(|s| {
            !s.name.trim().is_empty()
                && !s.user_id.is_empty()
                && s.all_sum.is_finite()
                && s.all_sum >= 0.0
                && s.month_sum.is_finite()
                && s.month_sum >= 0.0
                && s.game_id.as_deref().is_none_or(game_id_plausible)
        })
}

/// The nickname alphabet the relay's remark parser whitelists — a game
/// id off the wire must still read as one.
fn game_id_plausible(id: &str) -> bool {
    (2..=24).contains(&id.chars().count())
        && id
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Live pull from the relay (the contribution module's relay-fetch
/// grammar: shared proxy-aware client, explicit timeouts, HTTP-status
/// and shape gates). Any failure answers Err — the command decides the
/// fallback.
async fn fetch_sponsor_list() -> Result<SponsorListDoc> {
    let clients = super::network::HttpPair::build(|b| b).context("build http client")?;
    let url = format!(
        "{}{SPONSORS_PATH}",
        super::pairing_relay::builtin_relay_root()
    );
    let host = super::upstream_health::host_of_url(&url).to_string();
    let resp =
        super::upstream_health::send_with_fallback(&clients, &host, "supporters", |client| {
            client
                .get(&url)
                .header("User-Agent", USER_AGENT)
                .timeout(SPONSORS_TIMEOUT)
        })
        .await
        .context("fetch sponsor list")?;
    if !resp.status().is_success() {
        anyhow::bail!("fetch sponsor list: HTTP {}", resp.status());
    }
    let doc = resp
        .json::<SponsorListDoc>()
        .await
        .context("parse sponsor list")?;
    if !sponsors_doc_sane(&doc) {
        anyhow::bail!("sponsor list failed validation");
    }
    Ok(doc)
}

/// The afdian sponsor list for the credits section's bottom group (see
/// the module docs): live relay answer, else the AppData last-good
/// cache, else an empty document. Never fails — an unreachable relay
/// merely freezes yesterday's list.
#[tauri::command]
pub async fn get_sponsor_list() -> CommandResult<SponsorListDoc> {
    match fetch_sponsor_list().await {
        Ok(doc) => {
            if let Ok(body) = serde_json::to_string(&doc) {
                // Best-effort: a failed cache write only costs a re-fetch.
                let _ = appdata::write_appdata_json(SPONSORS_CACHE, &body);
            }
            Ok(doc)
        },
        Err(_) => Ok(appdata::read_appdata_json(SPONSORS_CACHE)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<SponsorListDoc>(&raw).ok())
            .filter(sponsors_doc_sane)
            .unwrap_or_default()),
    }
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

    fn entry(name: &str) -> wowsp_tauri_shared::SponsorEntry {
        wowsp_tauri_shared::SponsorEntry {
            user_id: "u1".into(),
            name: name.into(),
            avatar: None,
            all_sum: 1.0,
            month_sum: 0.0,
            active: false,
            first_pay: 1,
            last_pay: 1,
            game_id: None,
        }
    }

    #[test]
    fn sponsors_doc_sane_gates_the_wire_shape() {
        let doc = SponsorListDoc {
            updated_at: 10,
            sponsors: vec![entry("猪猪子zy")],
        };
        assert!(sponsors_doc_sane(&doc));
        // Negative amounts, negative timestamps and blank names all
        // refuse — a hijacked response never reaches the UI.
        let mut bad = doc.clone();
        bad.sponsors[0].all_sum = -0.01;
        assert!(!sponsors_doc_sane(&bad));
        let mut blank = doc;
        blank.sponsors[0].name = " ".into();
        assert!(!sponsors_doc_sane(&blank));
        let mut junk_id = SponsorListDoc {
            updated_at: 10,
            sponsors: vec![entry("n")],
        };
        junk_id.sponsors[0].game_id = Some("not an id!".into());
        assert!(!sponsors_doc_sane(&junk_id));
        let mut stale = SponsorListDoc::default();
        stale.updated_at = -1;
        assert!(!sponsors_doc_sane(&stale));
        // The default (empty) document is a valid cold-start answer.
        assert!(sponsors_doc_sane(&SponsorListDoc::default()));
    }

    #[test]
    fn sponsors_doc_camel_case_wire_names_round_trip() {
        let doc = SponsorListDoc {
            updated_at: 12,
            sponsors: vec![entry("SomePlayer_01")],
        };
        let wire = serde_json::to_string(&doc).unwrap();
        assert!(wire.contains("\"updatedAt\""));
        assert!(wire.contains("\"allSum\""));
        assert!(wire.contains("\"gameId\""));
        assert_eq!(serde_json::from_str::<SponsorListDoc>(&wire).unwrap(), doc);
    }
}
