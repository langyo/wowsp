//! URL classification for the gateway's HTTP + WebSocket routes. Both
//! the v2 shape under the `/relay` base and the v1 bare paths resolve to
//! the same [`Route`] values, so one handler serves both dialects.
//!
//! v2 (advertised by the manifest):
//!   GET  /v1/manifest
//!   GET  /v1/health
//!   WS   /relay/control?room=<64hex>&role=host|client
//!   WS   /relay/resolve?code=NNNNNN
//!   WS   /relay/data/<room>/<connId>[?role=host|client]
//!
//! v1 (legacy, kept verbatim):
//!   GET  /health
//!   WS   /control?room=<64hex>&role=host|client
//!   WS   /resolve?code=NNNNNN
//!   WS   /data/<room>?conn=<id>&side=host|client

use crate::room::Side;

/// What a request path (+query) asks for. Values borrow from the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route<'a> {
    /// GET /v1/manifest.
    Manifest,
    /// GET /v1/health or the legacy GET /health.
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
    /// Data socket for `<room>/<connId>` on `side`. One of the two
    /// wire shapes has already been normalized into fields.
    Data {
        room: &'a str,
        conn_id: &'a str,
        side: Side,
    },
    /// Nothing we serve.
    NotFound,
}

/// Strip a trailing slash so `/relay/control` and `/relay/control/`
/// route identically.
fn trim_path(path: &str) -> &str {
    let p = path.trim_end_matches('/');
    // Keep "/" as-is (it is NotFound either way).
    if p.is_empty() { "/" } else { p }
}

/// Classify a request. `query` is the raw query string WITHOUT the `?`
/// (may be empty).
pub fn classify<'a>(path: &'a str, query: &'a str) -> Route<'a> {
    let path = trim_path(path);
    match path {
        "/v1/manifest" => return Route::Manifest,
        "/v1/health" | "/health" => return Route::Health,
        "/relay/control" | "/control" => {
            return Route::Control {
                room: query_get(query, "room"),
                role: query_get(query, "role"),
            };
        },
        "/relay/resolve" | "/resolve" => {
            return Route::Resolve {
                code: query_get(query, "code"),
            };
        },
        _ => {},
    }
    // Data routes: v2 puts room AND connId in the path; v1 puts only the
    // room there and carries conn/side in the query. Both spellings are
    // accepted under both prefixes (a lenient superset: `/data/<room>/<id>`
    // and `/relay/data/<room>?conn=`).
    if let Some(rest) = path
        .strip_prefix("/relay/data/")
        .or_else(|| path.strip_prefix("/data/"))
    {
        let mut segs = rest.split('/');
        let room = segs.next().unwrap_or("");
        let conn_in_path = segs.next();
        if segs.next().is_some() || room.is_empty() {
            return Route::NotFound;
        }
        let conn_id = match conn_in_path {
            Some(c) if !c.is_empty() => c,
            // v1 shape: conn comes from the query.
            None => {
                return query_get(query, "conn").map_or(Route::NotFound, |conn| Route::Data {
                    room,
                    conn_id: conn,
                    side: data_side(query),
                });
            },
            Some(_) => return Route::NotFound,
        };
        return Route::Data {
            room,
            conn_id,
            side: data_side(query),
        };
    }
    Route::NotFound
}

/// The data side: v2 spells it `role`, v1 `side`; absent means client
/// (the phone dials first, the host answers).
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
        assert_eq!(classify("/v1/manifest", ""), Route::Manifest);
        assert_eq!(classify("/v1/health", ""), Route::Health);
        assert_eq!(classify("/health", ""), Route::Health);
        assert_eq!(classify("/v1/manifest/", ""), Route::Manifest);
        assert_eq!(classify("/nope", ""), Route::NotFound);
        assert_eq!(classify("/", ""), Route::NotFound);
        assert_eq!(classify("/v1", ""), Route::NotFound);
    }

    #[test]
    fn control_classifies_under_both_prefixes() {
        for path in ["/relay/control", "/control"] {
            assert_eq!(
                classify(path, "room=abc&role=host"),
                Route::Control {
                    room: Some("abc"),
                    role: Some("host")
                },
                "path {path}"
            );
        }
        assert_eq!(
            classify("/relay/control", "role=client&room=xyz"),
            Route::Control {
                room: Some("xyz"),
                role: Some("client")
            }
        );
        assert_eq!(
            classify("/relay/control", ""),
            Route::Control {
                room: None,
                role: None
            },
            "missing params route fine; the handler rejects them"
        );
    }

    #[test]
    fn resolve_classifies_under_both_prefixes() {
        for path in ["/relay/resolve", "/resolve"] {
            assert_eq!(
                classify(path, "code=123456"),
                Route::Resolve {
                    code: Some("123456")
                }
            );
        }
        assert_eq!(
            classify("/relay/resolve", ""),
            Route::Resolve { code: None }
        );
    }

    #[test]
    fn data_v2_shape_puts_room_and_conn_in_the_path() {
        assert_eq!(
            classify("/relay/data/aaaa/bbbb1111", "role=host"),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Host
            }
        );
        // Client leg has no query at all.
        assert_eq!(
            classify("/relay/data/aaaa/bbbb1111", ""),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Client
            }
        );
        // The v1 `side=` spelling works on the v2 path too.
        assert_eq!(
            classify("/relay/data/aaaa/bbbb1111", "side=host"),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Host
            }
        );
        // Junk roles fall back to client.
        assert_eq!(
            classify("/relay/data/aaaa/bbbb1111", "role=ninja"),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Client
            }
        );
    }

    #[test]
    fn data_v1_shape_carries_conn_and_side_in_the_query() {
        assert_eq!(
            classify("/data/aaaa", "conn=bbbb1111&side=host"),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Host
            }
        );
        assert_eq!(
            classify("/data/aaaa", "conn=bbbb1111"),
            Route::Data {
                room: "aaaa",
                conn_id: "bbbb1111",
                side: Side::Client
            }
        );
        assert_eq!(classify("/data/aaaa", ""), Route::NotFound);
        assert_eq!(classify("/data/", "conn=x"), Route::NotFound);
        assert_eq!(classify("/data", "conn=x"), Route::NotFound);
    }

    #[test]
    fn data_path_malformations_are_not_found() {
        assert_eq!(classify("/relay/data/a/b/c", ""), Route::NotFound);
        assert_eq!(classify("/relay/data/a//b", ""), Route::NotFound);
        assert_eq!(classify("/relay/data//b", ""), Route::NotFound);
        assert_eq!(classify("/relay/data/a/", "role=host"), Route::NotFound);
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
