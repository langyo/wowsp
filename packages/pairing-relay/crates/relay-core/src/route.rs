//! URL classification for the gateway's HTTP + WebSocket routes. The
//! worker answers a fixed list of paths and nothing else: the API under
//! `/api` (no version segment — the health document carries the version
//! instead) plus the two server-rendered pages `/feedback` and `/erp`.
//! The `run_worker_first` list in `wrangler.toml` sends exactly these
//! paths here; the rest of the hostname is served by the worker's
//! static-assets layer.
//!
//!   GET  /api/health                     — merged health + discovery doc
//!   GET  /api/digests/<channel>[/tag]    — release digests (updater trust)
//!   WS   /api/relay/control?room=<64hex>&role=host|client
//!   WS   /api/relay/resolve?code=NNNNNN
//!   WS   /api/relay/data/<room>/<connId>[?role=host|client]
//!   GET  /feedback                       — feedback form page (Turnstile)
//!   GET  /erp                            — review console page (Feishu login)
//!   POST /api/feedback/submit            — form target (multipart)
//!   GET  /api/feedback/list              — records JSON (erp session)
//!   POST /api/feedback/update            — status/PR-link write (erp session)
//!   GET  /api/feedback/attachment?file_token=… — 302 to a Feishu tmp url
//!   GET  /api/erp/login                  — 302 to the Feishu authorize page
//!   GET  /api/erp/callback?code=…&state=… — OAuth return, mints session
//!   GET  /api/erp/session                — console whoami probe
//!   POST /api/erp/logout                 — clear the session cookie
//!   GET  /api/replays/wanted             — replay-share ruleset (cached)
//!   POST /api/replays/check              — per-replay verdicts (no auth)
//!   GET  /api/replays/mine               — the caller's staged set (auth)
//!   GET  /api/replays/archive            — the caller's shard stream (auth)
//!   POST /api/replays/upload             — tar.zst shard + manifest (auth)
//!   GET  /api/replays/admin/list         — drain console rows (erp session)
//!   GET  /api/replays/admin/archive?anon_id=… — one shard (erp session)
//!   POST /api/replays/admin/drain        — mark drained + free space

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
    /// GET /feedback — the embedded feedback form page.
    FeedbackPage,
    /// GET /erp — the embedded review console page.
    ErpPage,
    /// GET /api/erp/login — 302 into the Feishu OAuth authorize page.
    ErpLogin,
    /// GET /api/erp/callback?code=…&state=… — OAuth return (the handler
    /// re-parses code/state plus the origin, so nothing is carried here).
    ErpCallback,
    /// GET /api/erp/session — the console shell's whoami probe.
    ErpSession,
    /// POST /api/erp/logout — clear the session cookie.
    ErpLogout,
    /// POST /api/feedback/submit — multipart form target.
    FeedbackSubmit,
    /// GET /api/feedback/list — records JSON for the console / agents.
    FeedbackList,
    /// GET /api/feedback/history?contact=… — public lookup of one
    /// contact's own submissions + processing status (rate-limited).
    FeedbackHistory { contact: Option<&'a str> },
    /// POST /api/feedback/update — status/PR-link write.
    FeedbackUpdate,
    /// POST /api/qqbot/callback — QQ 开放平台 webhook（URL 校验 + 事件）。
    QqBotCallback,
    /// GET /api/feedback/attachment?file_token=… — 302 to a Feishu
    /// temporary download URL; `file_token` is the raw query value.
    FeedbackAttachment { file_token: Option<&'a str> },
    /// GET /api/digests/<channel> — the channel's latest digest doc.
    /// GET /api/digests/<channel>/<tag> — the doc pinned to one tag.
    /// `channel`/`tag` are the raw path segments — validation happens
    /// in the handler (this layer only routes).
    Digests {
        channel: &'a str,
        tag: Option<&'a str>,
    },
    /// GET /api/replays/wanted — the replay-share ruleset with live
    /// counters (cacheable for 5 minutes).
    ReplaysWanted,
    /// POST /api/replays/check — per-replay verdicts (headers optional).
    ReplaysCheck,
    /// GET /api/replays/mine — the caller's staged set (auth headers).
    ReplaysMine,
    /// GET /api/replays/archive — the caller's shard as a zstd stream.
    ReplaysArchive,
    /// POST /api/replays/upload — tar.zst body + `x-manifest` header.
    ReplaysUpload,
    /// GET /api/replays/admin/list — drain-console contributor rows
    /// (erp session; the handler gates).
    ReplaysAdminList,
    /// GET /api/replays/admin/archive?anon_id=… — one contributor's
    /// shard (erp session); `anon_id` is the raw query value.
    ReplaysAdminArchive { anon_id: Option<&'a str> },
    /// POST /api/replays/admin/drain — mark staged members drained,
    /// decrement the watermark, delete the shards (erp session).
    ReplaysAdminDrain,
    /// Nothing we serve — every path outside `run_worker_first` is
    /// answered by the static-assets layer (any miss gets the SPA
    /// shell, navigation or not), so in production this only happens
    /// on unknown shapes under `/api*`, `/feedback*` and `/erp*`.
    NotFound,
}

/// Strip a trailing slash so `/api/relay/control` and
/// `/api/relay/control/` route identically.
fn trim_path(path: &str) -> &str {
    let p = path.trim_end_matches('/');
    // Keep "/" as-is (it is NotFound either way — the site's index.html
    // comes from the static-assets layer, never this code).
    if p.is_empty() { "/" } else { p }
}

/// Classify a request. `query` is the raw query string WITHOUT the `?`
/// (may be empty).
pub fn classify<'a>(path: &'a str, query: &'a str) -> Route<'a> {
    let path = trim_path(path);
    match path {
        "/api/health" => return Route::Health,
        "/feedback" => return Route::FeedbackPage,
        "/erp" => return Route::ErpPage,
        "/api/feedback/submit" => return Route::FeedbackSubmit,
        "/api/feedback/list" => return Route::FeedbackList,
        "/api/feedback/history" => {
            return Route::FeedbackHistory {
                contact: query_get(query, "contact"),
            };
        },
        "/api/feedback/update" => return Route::FeedbackUpdate,
        "/api/qqbot/callback" => return Route::QqBotCallback,
        "/api/erp/login" => return Route::ErpLogin,
        "/api/erp/callback" => return Route::ErpCallback,
        "/api/erp/session" => return Route::ErpSession,
        "/api/erp/logout" => return Route::ErpLogout,
        "/api/feedback/attachment" => {
            return Route::FeedbackAttachment {
                file_token: query_get(query, "file_token"),
            };
        },
        "/api/replays/wanted" => return Route::ReplaysWanted,
        "/api/replays/check" => return Route::ReplaysCheck,
        "/api/replays/mine" => return Route::ReplaysMine,
        "/api/replays/archive" => return Route::ReplaysArchive,
        "/api/replays/upload" => return Route::ReplaysUpload,
        "/api/replays/admin/list" => return Route::ReplaysAdminList,
        "/api/replays/admin/archive" => {
            return Route::ReplaysAdminArchive {
                anon_id: query_get(query, "anon_id"),
            };
        },
        "/api/replays/admin/drain" => return Route::ReplaysAdminDrain,
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
    if let Some(rest) = path.strip_prefix("/api/digests/") {
        let mut segs = rest.split('/');
        let channel = segs.next().unwrap_or("");
        let tag_in_path = segs.next();
        if segs.next().is_some() || channel.is_empty() {
            return Route::NotFound;
        }
        return Route::Digests {
            channel,
            tag: tag_in_path.filter(|t| !t.is_empty()),
        };
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
    fn feedback_routes_classify() {
        assert_eq!(classify("/feedback", ""), Route::FeedbackPage);
        assert_eq!(classify("/erp", ""), Route::ErpPage);
        assert_eq!(classify("/erp/", ""), Route::ErpPage);
        assert_eq!(classify("/api/erp/login", ""), Route::ErpLogin);
        assert_eq!(
            classify("/api/erp/callback", "code=c1&state=s1"),
            Route::ErpCallback
        );
        assert_eq!(classify("/api/erp/callback", ""), Route::ErpCallback);
        assert_eq!(classify("/api/erp/session", ""), Route::ErpSession);
        assert_eq!(classify("/api/erp/logout", ""), Route::ErpLogout);
        // Unknown erp subpaths stay NotFound.
        assert_eq!(classify("/api/erp/other", ""), Route::NotFound);
        assert_eq!(classify("/api/feedback/submit", ""), Route::FeedbackSubmit);
        assert_eq!(classify("/api/feedback/list", ""), Route::FeedbackList);
        assert_eq!(
            classify("/api/feedback/history", "contact=12345"),
            Route::FeedbackHistory {
                contact: Some("12345")
            }
        );
        assert_eq!(
            classify("/api/feedback/history", ""),
            Route::FeedbackHistory { contact: None }
        );
        assert_eq!(classify("/api/feedback/update", ""), Route::FeedbackUpdate);
        assert_eq!(
            classify("/api/feedback/attachment", "file_token=ftok123"),
            Route::FeedbackAttachment {
                file_token: Some("ftok123")
            }
        );
        assert_eq!(
            classify("/api/feedback/attachment", ""),
            Route::FeedbackAttachment { file_token: None }
        );
        // Unknown feedback subpaths stay NotFound.
        assert_eq!(classify("/api/feedback/other", ""), Route::NotFound);
        assert_eq!(classify("/feedback/sub", ""), Route::NotFound);
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
        assert_eq!(
            classify("/api/relay/resolve", ""),
            Route::Resolve { code: None }
        );
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
        assert_eq!(classify("/api/relay/data/a/", "role=host"), Route::NotFound);
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

    #[test]
    fn classify_qqbot_routes() {
        assert_eq!(classify("/api/qqbot/callback", ""), Route::QqBotCallback);
        // The retired verification endpoints (qq/code, qq/status) stay gone.
        assert_eq!(classify("/api/feedback/qq/code", ""), Route::NotFound);
        assert_eq!(classify("/api/feedback/qq/status", ""), Route::NotFound);
    }

    #[test]
    fn digest_routes_classify() {
        assert_eq!(
            classify("/api/digests/app", ""),
            Route::Digests {
                channel: "app",
                tag: None
            }
        );
        // Trailing slash routes like the bare channel path.
        assert_eq!(
            classify("/api/digests/app/", ""),
            Route::Digests {
                channel: "app",
                tag: None
            }
        );
        assert_eq!(
            classify("/api/digests/res/res-delta-a-b", ""),
            Route::Digests {
                channel: "res",
                tag: Some("res-delta-a-b")
            }
        );
        // The bare endpoint and deeper paths are NotFound.
        assert_eq!(classify("/api/digests", ""), Route::NotFound);
        assert_eq!(classify("/api/digests/", ""), Route::NotFound);
        assert_eq!(classify("/api/digests/app/v0.6.1/extra", ""), Route::NotFound);
        // trim_path strips every trailing slash, so `app//` is `app`.
        assert_eq!(
            classify("/api/digests/app//", ""),
            Route::Digests {
                channel: "app",
                tag: None
            }
        );
        // Raw values ride along; validation is the handler's job.
        assert_eq!(
            classify("/api/digests/../evil", ""),
            Route::Digests {
                channel: "..",
                tag: Some("evil")
            },
            "path-injected segments route; the handler's channel/tag \
             validation is what refuses them"
        );
    }

    #[test]
    fn replay_routes_classify() {
        assert_eq!(classify("/api/replays/wanted", ""), Route::ReplaysWanted);
        assert_eq!(classify("/api/replays/wanted/", ""), Route::ReplaysWanted);
        assert_eq!(classify("/api/replays/check", ""), Route::ReplaysCheck);
        assert_eq!(classify("/api/replays/mine", ""), Route::ReplaysMine);
        assert_eq!(classify("/api/replays/archive", ""), Route::ReplaysArchive);
        assert_eq!(classify("/api/replays/upload", ""), Route::ReplaysUpload);
        assert_eq!(
            classify("/api/replays/admin/list", ""),
            Route::ReplaysAdminList
        );
        assert_eq!(
            classify(
                "/api/replays/admin/archive",
                "anon_id=01234567-89ab-4cde-8f01-23456789abcd"
            ),
            Route::ReplaysAdminArchive {
                anon_id: Some("01234567-89ab-4cde-8f01-23456789abcd")
            }
        );
        assert_eq!(
            classify("/api/replays/admin/archive", ""),
            Route::ReplaysAdminArchive { anon_id: None }
        );
        assert_eq!(
            classify("/api/replays/admin/drain", ""),
            Route::ReplaysAdminDrain
        );
        // Unknown replays subpaths stay NotFound.
        assert_eq!(classify("/api/replays/other", ""), Route::NotFound);
        assert_eq!(classify("/api/replays/admin/other", ""), Route::NotFound);
        assert_eq!(classify("/api/replays", ""), Route::NotFound);
        assert_eq!(classify("/api/replays/", ""), Route::NotFound);
    }
}
