//! URL classification for the gateway's HTTP + WebSocket routes. The
//! worker serves the WEBSITE statically at `/`; everything it answers
//! itself lives under `/api` (no version segment — the health document
//! carries the version instead).
//!
//!   GET  /api/health                     — merged health + discovery doc
//!   WS   /api/relay/control?room=<64hex>&role=host|client
//!   WS   /api/relay/resolve?code=NNNNNN
//!   WS   /api/relay/data/<room>/<connId>[?role=host|client]

use crate::room::Side;

/// What a request path (+query) asks for. Values borrow from the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route<'a> {
    /// GET /api/health — the merged health/discovery document.
    Health,
    /// Control socket. `room`/`role` are the raw query values —
    /// validation happens in the handler (this layer only routes).
    Control {
        room: Option<&'a str>,
        role: Option<&'a str>,
    },
    /// Resolve socket; `code` is the raw query value (may be absent or
    /// malformed — the handler decides).
    Resolve { code: Option<&'a str> },
    /// Data socket for `<room>/<connId>` on `side`.
    Data {
        room: &'a str,
        conn_id: &'a str,
        side: Side,
    },
    /// Nothing we serve — the static-asset layer already answered every
    /// non-API path, so in production this only happens on unknown
    /// `/api/*` shapes.
    NotFound,
}

/// Strip a trailing slash so `/api/relay/control` and
/// `/api/relay/control/` route identically.
fn trim_path(path: &str) -> &str {
    let p = path.trim_end_matches('/');
    // Keep "/" as-is (it is NotFound either way — the site's index.html
    // comes from the asset layer, never the worker).
    if p.is_empty() { "/" } else { p }
}

/// Classify a request. `query` is the raw query string WITHOUT the `?`
/// (may be empty).
pub fn classify<'a>(path: &'a str, query: &'a str) -> Route<'a> {
    let path = trim_path(path);
    match path {
        "/api/health" => return Route::Health,
        "/api/relay/control" => {
            return Route::Control {
                room: query_get(query, "room"),
                role: query_get(query, "role"),
            };
        },
        "/api/relay/resolve" => {
            return Route::Resolve {
                code: query_get(query, "code"),
            };
        },
        _ => {},
    }
    if let Some(rest) = path.strip_prefix("/api/relay/data/") {
        let mut segs = rest.split('/');
        let room = segs.next().unwrap_or("");
        let conn_in_path = segs.next();
        if segs.next().is_some() || room.is_empty() {
            return Route::NotFound;
        }
        let Some(conn_id) = conn_in_path.filter(|c| !c.is_empty()) else {
            return Route::NotFound;
        };
        return Route::Data {
            room,
            conn_id,
            side: data_side(query),
        };
    }
    Route::NotFound
}

/// The data socket's side: `role` in the query (the legacy `side=`
/// spelling is tolerated); absent means client (the phone dials first,
/// the host answers).
fn data_side(query: &str) -> Side {
    Side::parse(query_get(query, "role").or_else(|| query_get(query, "side")))
        .unwrap_or(Side::Client)
}

/// Tiny query-string getter for the handful of well-known keys. Values
/// on the wire are always plain `[0-9a-zA-Z_-]` shapes; anything percent
/// encoded simply fails the caller's validation.
pub fn query_get<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then_some(v)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_routes_classify() {
        assert_eq!(classify("/api/health", ""), Route::Health);
        assert_eq!(classify("/api/health/", ""), Route::Health);
        assert_eq!(classify("/nope", ""), Route::NotFound);
        assert_eq!(classify("/", ""), Route::NotFound);
        assert_eq!(classify("/api", ""), Route::NotFound);
        assert_eq!(classify("/api/", ""), Route::NotFound);
    }

    #[test]
    fn retired_routes_are_not_found() {
        // The pre-unification spellings (v1 bare, /v1/*, /relay/*) are
        // retired: the only consumers are the unreleased 0.5.0 apps that
        // this same change updates, so no compatibility shims remain.
        for path in [
            "/health",
            "/v1/health",
            "/v1/manifest",
            "/manifest",
            "/control",
            "/resolve",
            "/relay/control",
            "/relay/resolve",
            "/relay/data/a/b",
            "/data/a",
        ] {
            assert_eq!(classify(path, ""), Route::NotFound, "path {path}");
        }
    }

    #[test]
    fn control_classifies() {
        assert_eq!(
            classify("/api/relay/control", "room=abc&role=host"),
            Route::Control {
                room: Some("abc"),
                role: Some("host")
            }
        );
        assert_eq!(
            classify("/api/relay/control", "role=client&room=xyz"),
            Route::Control {
                room: Some("xyz"),
                role: Some("client")
            }
        );
        assert_eq!(
            classify("/api/relay/control", ""),
            Route::Control {
                room: None,
                role: None
            },
            "missing params route fine; the handler rejects them"
        );
    }

    #[test]
    fn resolve_classifies() {
        assert_eq!(
            classify("/api/relay/resolve", "code=123456"),
            Route::Resolve {
                code: Some("123456")
            }
        );
        assert_eq!(classify("/api/relay/resolve", ""), Route::Resolve { code: None });
    }

    #[test]
    fn data_puts_room_and_conn_in_the_path() {
        assert_eq!(
            classify("/api/relay/data/aaaa/bbbb1111", "role=host"),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Host
            }
        );
        // Client leg has no query at all.
        assert_eq!(
            classify("/api/relay/data/aaaa/bbbb1111", ""),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Client
            }
        );
        // The legacy `side=` spelling still works.
        assert_eq!(
            classify("/api/relay/data/aaaa/bbbb1111", "side=host"),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Host
            }
        );
        // Junk roles fall back to client.
        assert_eq!(
            classify("/api/relay/data/aaaa/bbbb1111", "role=ninja"),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Client
            }
        );
    }

    #[test]
    fn data_path_malformations_are_not_found() {
        assert_eq!(classify("/api/relay/data/a/b/c", ""), Route::NotFound);
        assert_eq!(classify("/api/relay/data/a//b", ""), Route::NotFound);
        assert_eq!(classify("/api/relay/data//b", ""), Route::NotFound);
        assert_eq!(
            classify("/api/relay/data/a/", "role=host"),
            Route::NotFound
        );
        assert_eq!(classify("/api/relay/data/a", ""), Route::NotFound);
        assert_eq!(classify("/api/relay/data/", "conn=x"), Route::NotFound);
        assert_eq!(classify("/api/relay/data", "conn=x"), Route::NotFound);
    }

    #[test]
    fn query_get_handles_the_edge_keys() {
        assert_eq!(query_get("code=123456", "code"), Some("123456"));
        assert_eq!(query_get("a=1&code=42", "code"), Some("42"));
        assert_eq!(query_get("code=", "code"), Some(""));
        assert_eq!(query_get("code=1", "cod"), None);
        assert_eq!(query_get("", "code"), None);
        assert_eq!(query_get("codec=1", "code"), None);
    }
}
