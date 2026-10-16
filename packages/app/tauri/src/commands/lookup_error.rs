//! Structured error payload for the interactive lookup commands
//! (`lookup_player_stats` / `lookup_clan_info`).
//!
//! The lookup UI needs more than the historical English sentences: it
//! localizes "not found" per error kind, suggests likely causes (typo /
//! rename / deleted account / wrong realm), highlights targets that were
//! looked up successfully before (a now-missing account was most likely
//! deleted), and shows the official API's own error message (rate limits,
//! maintenance windows…) when one came back. Making the frontend parse
//! English sentences would be brittle, so these two commands serialize a
//! `LookupError` through the IPC rejection instead. `message` keeps the
//! exact historical string byte-for-byte, so logs and anything still
//! reading `error.message` see no diff.

use std::fmt;

use serde::Serialize;

/// Which failure a lookup rejection is, for the UI to branch on. Serialized
/// `snake_case` over the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LookupErrorKind {
    /// No account matched the query (typo, renamed, deleted, wrong realm).
    AccountNotFound,
    /// No clan matched the id (disbanded, or the id is wrong).
    ClanNotFound,
    /// Everything else: transport failures, API-level errors, rate limits.
    Api,
}

/// Structured rejection payload of an interactive lookup command. Every
/// field is always present (no `Option` struct shape) so the TS side gets
/// one flat type; fields that don't apply to a kind carry neutral defaults
/// (`""` / `None`).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct LookupError {
    pub(crate) kind: LookupErrorKind,
    /// The query that found nothing — nickname, account UID or clan id.
    /// Empty for [`LookupErrorKind::Api`].
    pub(crate) query: String,
    /// Realm the failed "not found" search ran on. Empty for
    /// [`LookupErrorKind::Api`].
    pub(crate) realm: String,
    /// Human-readable fallback — the exact historical English string —
    /// doubling as the log-friendly rendering (see [`Display`]).
    pub(crate) message: String,
    /// The official API's own error message (e.g. REQUEST_LIMIT_EXCEEDED)
    /// when the response carried a non-empty one, else `None`.
    pub(crate) detail: Option<String>,
}

impl LookupError {
    /// Account "not found" for `query` (nickname or UID) on `realm`.
    pub(crate) fn not_found_account(query: impl Into<String>, realm: impl Into<String>) -> Self {
        let query = query.into();
        let realm = realm.into();
        Self {
            kind: LookupErrorKind::AccountNotFound,
            message: format!("no account found for '{query}' on {realm}"),
            query,
            realm,
            detail: None,
        }
    }

    /// Clan "not found" for `query` (the clan id) on `realm`.
    pub(crate) fn not_found_clan(query: impl Into<String>, realm: impl Into<String>) -> Self {
        let query = query.into();
        let realm = realm.into();
        Self {
            kind: LookupErrorKind::ClanNotFound,
            message: format!("no clan found for id {query} on {realm}"),
            query,
            realm,
            detail: None,
        }
    }

    /// API-level failure without an official error message.
    pub(crate) fn api(message: impl Into<String>) -> Self {
        Self::api_with_detail(message, None)
    }

    /// API-level failure, carrying the official API message when one
    /// arrived. An empty detail serializes as `None` — an empty string
    /// carries no information and the UI only highlights a real message.
    pub(crate) fn api_with_detail(message: impl Into<String>, detail: Option<String>) -> Self {
        Self {
            kind: LookupErrorKind::Api,
            query: String::new(),
            realm: String::new(),
            message: message.into(),
            detail: detail.filter(|d| !d.is_empty()),
        }
    }
}

impl fmt::Display for LookupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Plain-string errors from the shared request plumbing convert to the
/// `Api` kind — every pre-existing `?` / `map_err` site keeps working
/// unchanged and lands on the generic-failure UI branch.
impl From<String> for LookupError {
    fn from(message: String) -> Self {
        Self::api(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_account_serializes_all_fields() {
        let err = LookupError::not_found_account("dlrjsgml", "asia");
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "account_not_found");
        assert_eq!(v["query"], "dlrjsgml");
        assert_eq!(v["realm"], "asia");
        // The message is the historical English sentence, byte-for-byte.
        assert_eq!(v["message"], "no account found for 'dlrjsgml' on asia");
        assert_eq!(v["detail"], serde_json::Value::Null);
    }

    #[test]
    fn not_found_clan_serializes_kind_and_query() {
        let err = LookupError::not_found_clan("7000008303", "cn");
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "clan_not_found");
        assert_eq!(v["query"], "7000008303");
        assert_eq!(v["realm"], "cn");
        assert_eq!(v["message"], "no clan found for id 7000008303 on cn");
        assert_eq!(v["detail"], serde_json::Value::Null);
    }

    #[test]
    fn api_error_carries_empty_query_and_realm() {
        let v = serde_json::to_value(LookupError::api("account/info: boom")).unwrap();
        assert_eq!(v["kind"], "api");
        assert_eq!(v["query"], "");
        assert_eq!(v["realm"], "");
        assert_eq!(v["message"], "account/info: boom");
        assert_eq!(v["detail"], serde_json::Value::Null);
    }

    #[test]
    fn api_detail_keeps_official_message_and_drops_empty() {
        let err = LookupError::api_with_detail(
            "account/list: REQUEST_LIMIT_EXCEEDED",
            Some("REQUEST_LIMIT_EXCEEDED".to_owned()),
        );
        assert_eq!(err.detail.as_deref(), Some("REQUEST_LIMIT_EXCEEDED"));
        // An empty official message is no detail at all.
        let err = LookupError::api_with_detail("account/list: ", Some(String::new()));
        assert_eq!(err.detail, None);
        // Message text is kept verbatim even when its tail is empty.
        assert_eq!(err.message, "account/list: ");
    }

    #[test]
    fn from_string_maps_to_api_kind() {
        let err: LookupError = "http client: timeout".to_owned().into();
        assert_eq!(err.kind, LookupErrorKind::Api);
        assert_eq!(err.to_string(), "http client: timeout");
        assert_eq!(err.detail, None);
    }
}
