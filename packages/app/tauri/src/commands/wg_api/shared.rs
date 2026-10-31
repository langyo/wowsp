//! Request plumbing shared by every WG API surface: query encoding, the
//! exact-nickname verification rule, the account/list + account/info one-shot
//! helpers, WG rich-text/dog-tag parsing and the wire DTOs. Split from the
//! former single-file `commands/wg_api.rs`.

use anyhow::{Result, anyhow, bail};

use serde::Deserialize;

use super::lookup_error::LookupError;
use crate::commands::network::HttpPair;

/// Percent-encode one query component. The `format!`-built request URLs
/// inline user input; Url encodes spaces/unicode but leaves query-structural
/// characters (`&`, `#`, `+`) alone, which would silently truncate or
/// rewrite searches (clan names freely contain `&`). Also used for the CN
/// vortex path segments (it encodes `/` too, which a path segment needs).
pub(crate) fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            },
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A search hit is trusted only when its nickname IS the queried name
/// (trimmed, case-insensitive) — anything else counts as "not found", and
/// another player's stats can never be pinned onto a roster row. Shared by
/// the WG `account/list` path and the CN vortex search, which are both
/// prefix queries whose exact account is not contractually the top hit.
pub(crate) fn nickname_matches(query: &str, found: &str) -> bool {
    query.trim().to_lowercase() == found.trim().to_lowercase()
}

/// Live-nickname verification over one name's exact search hits — the
/// batch path's ghost guard (see the constant docs). A hit whose LIVE
/// nickname (the one account/info answers, vs the search index's possibly
/// stale copy) still equals the query wins. When the sweep answered a live
/// nickname for at least one hit and NONE matched, the index is provably
/// stale for this name and `None` beats pinning a renamed ghost's profile
/// on the roster row. Only a sweep with no evidence at all (no info node
/// for any hit) falls back to the first index hit — today's behavior, kept
/// for the case a later call would resolve. Pure — unit-tested.
pub(crate) fn pick_verified_entry(
    candidates: &[AccountListEntry],
    query: &str,
    info_data: Option<&serde_json::Value>,
) -> Option<AccountListEntry> {
    let mut verified = None;
    let mut saw_live_nickname = false;
    for c in candidates {
        let live = info_data
            .and_then(|d| d.get(c.account_id.to_string()))
            .and_then(|v| v.get("nickname"))
            .and_then(|n| n.as_str());
        if let Some(live) = live {
            saw_live_nickname = true;
            if nickname_matches(query, live) {
                verified = Some(c);
                break;
            }
        }
    }
    match verified {
        Some(c) => Some(c.clone()),
        None if candidates.is_empty() || saw_live_nickname => None,
        None => Some(candidates[0].clone()),
    }
}

/// account/list (limit=10) — one nickname → account entry. The search is a
/// prefix query, so the exact account is picked out of the hits; Ok(None)
/// when it isn't among them. Shared with `wg_composition`'s batch resolution
/// (which discards errors via `.ok()`, so its call sites are error-type
/// agnostic). The interactive lookup path wants the official API error
/// message, so API-level failures reject with [`LookupError`] carrying it in
/// `detail`; `From<String>` keeps the shared plumbing's plain strings
/// flowing through as generic `Api` errors.
pub(crate) async fn account_list_one(
    clients: &HttpPair,
    app_id: &str,
    host: &str,
    name: &str,
) -> Result<Option<AccountListEntry>, LookupError> {
    // One retry on the intermittent 504/SOURCE_NOT_AVAILABLE envelope, then
    // "no match": the add-player dialog asked a yes/no question and must not
    // turn an upstream hiccup into an English error card (the desktop hits
    // the same code — it is the ASIA pool, not the phone).
    let mut list: WgResponse<Vec<AccountListEntry>> = WgResponse {
        status: String::new(),
        data: None,
        error: WgError::default(),
    };
    for attempt in 0..2 {
        let resp = super::upstream_health::recorded_get(
            clients,
            host,
            "account/list",
            format!(
                "https://{host}/wows/account/list/?application_id={app_id}&search={}&limit=10",
                encode_query(name)
            ),
        )
        .await
        .map_err(|e| LookupError::from(e.to_string()))?;
        list = resp
            .json()
            .await
            .map_err(|e| format!("account/list parse: {e}"))?;
        if list.status == "ok" || attempt == 1 {
            break;
        }
        if !list.error.is_source_unavailable() {
            break;
        }
    }
    if list.status != "ok" {
        if list.error.is_source_unavailable() {
            return Ok(None);
        }
        let msg = list.error.message.clone().unwrap_or_default();
        return Err(LookupError::api_with_detail(
            format!("account/list: {msg}"),
            list.error.message,
        ));
    }
    Ok(list
        .data
        .and_then(|d| d.into_iter().find(|e| nickname_matches(name, &e.nickname))))
}

/// account/info for one id → the nickname. Ok(None) when the id doesn't
/// exist (WG returns an empty data object for unknown ids).
pub(super) async fn account_nickname_by_id(
    clients: &HttpPair,
    app_id: &str,
    host: &str,
    account_id: i64,
) -> Result<Option<String>> {
    let resp = super::upstream_health::recorded_get(
        clients,
        host,
        "account/info",
        format!(
            "https://{host}/wows/account/info/?application_id={app_id}&account_id={account_id}"
        ),
    )
    .await?;
    let parsed: WgResponse<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| anyhow!("account/info parse: {e}"))?;
    if parsed.status != "ok" {
        // Unknown ids and the ASIA pool's 504 both land here; the UID fast
        // path treats either as "no such account".
        if parsed.error.is_source_unavailable() {
            return Ok(None);
        }
        bail!("account/info: {}", parsed.error.message.unwrap_or_default());
    }
    Ok(parsed
        .data
        .as_ref()
        .and_then(|d| d.get(account_id.to_string()))
        .and_then(|v| v.get("nickname"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_owned()))
}
/// Named HTML entities that show up in WG-escaped clan text (players type
/// quotes, arrows, dashes); anything outside this table must arrive
/// numeric-encoded or it passes through visibly.
const WG_NAMED_ENTITIES: &[(&str, &str)] = &[
    ("quot", "\""),
    ("amp", "&"),
    ("lt", "<"),
    ("gt", ">"),
    ("apos", "'"),
    ("nbsp", "\u{00a0}"),
    ("hellip", "…"),
    ("mdash", "—"),
    ("ndash", "–"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("laquo", "«"),
    ("raquo", "»"),
    ("deg", "°"),
    ("middot", "·"),
    ("copy", "©"),
    ("reg", "®"),
    ("trade", "™"),
];

/// Parse one entity at the start of `s` (which must begin with '&').
/// Returns the decoded text and the consumed byte length; `None` leaves the
/// '&' literal. Handles named entities plus decimal (`&#39;`) and hex
/// (`&#x27;`) character references — WG encodes newlines as `&#10;` in some
/// descriptions, so control characters decode normally.
fn parse_wg_entity(s: &str) -> Option<(String, usize)> {
    let body = s.strip_prefix('&')?;
    if let Some(rest) = body.strip_prefix('#') {
        let (digits, radix, head) =
            if let Some(rest) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
                (rest, 16, 3) // '&' '#' 'x'
            } else {
                (rest, 10, 2) // '&' '#'
            };
        let end = digits.find(';')?;
        if end == 0 {
            return None;
        }
        let num = u32::from_str_radix(&digits[..end], radix).ok()?;
        let ch = char::from_u32(num)?;
        return Some((ch.to_string(), head + end + 1)); // + ';'
    }
    let end = body.find(';')?;
    let name = &body[..end];
    let text = WG_NAMED_ENTITIES
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, text)| *text)?;
    Some((text.to_owned(), 2 + end)) // '&' + name + ';'
}

/// Clean a WG-provided rich-text field (clan description) for display:
/// decode HTML entities in a single left-to-right pass (`&amp;quot;`
/// correctly yields `&quot;`, not a double decode; unknown or malformed
/// entities pass through untouched), then normalize whitespace — CRLF/CR to
/// LF and tabs to spaces — so the UI can render the result verbatim with
/// `white-space: pre-line`. Entity-idempotent, so it also serves the CN
/// clan descriptions (plain text) for the whitespace pass alone.
pub(crate) fn decode_wg_text(raw: &str) -> String {
    // Longest decodable form is `&#x10FFFF;` (10 bytes); anything longer is
    // not an entity we care about.
    const MAX_ENTITY: usize = 10;

    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            let end = bytes[i..]
                .iter()
                .position(|&b| b == b'&')
                .map_or(bytes.len(), |p| i + p);
            out.push_str(&raw[i..end]);
            i = end;
            continue;
        }
        // Clamp the window end down to a char boundary — `i + MAX_ENTITY`
        // can land inside a multi-byte character (e.g. "&公会" after a bare
        // '&'), which would panic the slice.
        let mut window_end = raw.len().min(i + MAX_ENTITY);
        while window_end < raw.len() && !raw.is_char_boundary(window_end) {
            window_end -= 1;
        }
        let window = &raw[i..window_end];
        match parse_wg_entity(window) {
            Some((text, consumed)) => {
                out.push_str(&text);
                i += consumed;
            },
            None => {
                out.push('&');
                i += 1;
            },
        }
    }
    out.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', " ")
}

/// Parse a dog_tag JSON object from the Vortex API into a DogTag struct.
/// The Vortex response has fields like `texture_id`, `symbol_id`,
/// `border_color_id`, `background_color_id`, `background_id`. The color
/// fields are ARGB-packed u32 values. Standalone medal emblems (patches /
/// unique emblems) carry only `symbol_id` and zero out every other field,
/// so the all-zero tag — an account that never customised anything — is
/// the only shape rejected here.
pub(crate) fn parse_dog_tag(v: &serde_json::Value) -> Option<wowsp_tauri_shared::DogTag> {
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
    // Only return if at least one field is non-zero.
    if tag.texture_id != 0
        || tag.symbol_id != 0
        || tag.border_color != 0
        || tag.background_color != 0
        || tag.background_id != 0
    {
        Some(tag)
    } else {
        None
    }
}
#[derive(Deserialize)]
pub(super) struct WgResponse<T> {
    pub(super) status: String,
    pub(super) data: Option<T>,
    #[serde(default)]
    pub(super) error: WgError,
}
#[derive(Deserialize, Default)]
pub(super) struct WgError {
    /// WG numeric error code when one is carried (e.g. 504 for
    /// SOURCE_NOT_AVAILABLE). Optional: not every upstream answers it.
    #[serde(default)]
    pub(super) code: Option<i64>,
    pub(super) message: Option<String>,
}

impl WgError {
    /// WG answers code 504 / SOURCE_NOT_AVAILABLE (HTTP 200!) both for
    /// zero-match searches and for intermittent backend-pool failures on
    /// the ASIA cluster — the interactive lookups see it as "the upstream
    /// cannot answer this name right now". Callers either retry once
    /// (transient) or degrade to "no match"; it must never surface as a
    /// raw English error card.
    pub(super) fn is_source_unavailable(&self) -> bool {
        self.code == Some(504) || self.message.as_deref() == Some("SOURCE_NOT_AVAILABLE")
    }
}
#[derive(Clone, Deserialize)]
pub(crate) struct AccountListEntry {
    pub(crate) account_id: i64,
    pub(crate) nickname: String,
}

#[cfg(test)]
mod tests {
    use super::WgResponse;

    /// The ASIA pool answers HTTP 200 + code 504 / SOURCE_NOT_AVAILABLE for
    /// zero-match searches AND sporadic backend failures; the classifier is
    /// what lets the lookups retry once and then degrade instead of showing
    /// the raw English text.
    #[test]
    fn source_unavailable_is_classified_by_code_or_message() {
        let by_code: WgResponse<serde_json::Value> = serde_json::from_str(
            r#"{"status":"error","error":{"code":504,"message":"SOURCE_NOT_AVAILABLE"}}"#,
        )
        .expect("parse");
        assert!(by_code.error.is_source_unavailable());

        let by_message: WgResponse<serde_json::Value> = serde_json::from_str(
            r#"{"status":"error","error":{"message":"SOURCE_NOT_AVAILABLE"}}"#,
        )
        .expect("parse");
        assert!(by_message.error.is_source_unavailable());

        // A genuine credential error must keep surfacing as an error.
        let invalid_id: WgResponse<serde_json::Value> = serde_json::from_str(
            r#"{"status":"error","error":{"code":407,"message":"INVALID_APPLICATION_ID"}}"#,
        )
        .expect("parse");
        assert!(!invalid_id.error.is_source_unavailable());

        let ok: WgResponse<serde_json::Value> =
            serde_json::from_str(r#"{"status":"ok","data":null}"#).expect("parse");
        assert!(!ok.error.is_source_unavailable());
    }
}
