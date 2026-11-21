//! Pull-through block sync (contract §5.4, wave-1 "P2P data sync"): on
//! a LOCAL lookup miss (store row absent or past its TTL), ask up to
//! `SYNC_PEERS_MAX` peers from the list (own table first, then the
//! upstream list) for `GET {peer}/api/blocks/<cid>` with a 3 s budget each,
//! verify the row (relay-core checks, worker-parity), store the copy
//! locally and serve it as `x-wowsp-cache: peer-hit`. All misses → the real
//! upstream. v1 sync is lazy and content-verified: no background
//! gossip, no push. Candidate selection uses relay-core's SEEDED pick
//! (deterministic per CID + hour, unpredictable to a hostile list
//! author).

use std::sync::Arc;

use relay_core::lookup::{BLOCK_GRACE_SECS, LookupEnvelope, STORE_CAP, cid_verify, classify_ttl};
use relay_core::peers::{PEER_FETCH_BUDGET_SECS, sync_candidates_seeded};

use crate::state::AppState;

/// Ask the mesh for one block. `host`/`path` describe the ORIGINAL
/// allowlisted request (the local TTL authority + the upstream-host
/// confusion guard).
pub async fn pull_through(
    app: &Arc<AppState>,
    cid: &str,
    request_line: &str,
    host: &str,
    path: &str,
) -> Option<LookupEnvelope> {
    let peers = sync_candidates(app, cid).await;
    let now = app.now() as u64;
    for peer in peers.iter().take(app.cfg.sync_peers_max) {
        let target = app
            .cfg
            .resolve_outbound(&format!("{}/api/blocks/{cid}", peer.url));
        let Ok(resp) = app
            .plain_http
            .get(target)
            .timeout(std::time::Duration::from_secs(PEER_FETCH_BUDGET_SECS))
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        // Never buffer an unbounded peer body: refuse anything over
        // the store cap before parsing (worker parity).
        let Some(bytes) = read_capped(resp, STORE_CAP).await else {
            continue;
        };
        let Ok(mut env) = serde_json::from_slice::<LookupEnvelope>(&bytes) else {
            continue;
        };
        if !verify(cid, request_line, host, path, &env, now) {
            // A lying peer's row fails the checks and is dropped —
            // never stored, never served (§4.2 / §8 mesh poisoning).
            continue;
        }
        // Local TTL authority: never trust a peer's claim beyond what
        // the request's own shape classifies to.
        env.ttl = env.ttl.min(classify_ttl(host, path));
        let expires = now as i64 + env.ttl as i64 + BLOCK_GRACE_SECS as i64;
        app.store.put_block(
            cid,
            &serde_json::to_string(&env).unwrap_or_default(),
            expires,
            request_line,
        );
        return Some(env);
    }
    None
}

/// Read a response body up to `cap` bytes; `None` when the body is
/// declared or actually larger (nothing is buffered beyond the cap).
async fn read_capped(resp: reqwest::Response, cap: usize) -> Option<Vec<u8>> {
    if resp.content_length().is_some_and(|len| len as usize > cap) {
        return None;
    }
    let mut buf = Vec::new();
    let mut resp = resp;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if buf.len() > cap {
                    return None;
                }
            },
            Ok(None) => return Some(buf),
            Err(_) => return None,
        }
    }
}

/// The peer candidate ladder: the merged public list (§5.4 "peers
/// from the list"), self excluded (it holds no block for OUR local
/// miss by definition), ordered by relay-core's seeded pick — the
/// seed is the CID + the hour bucket, so honest replays agree while a
/// hostile registry cannot monopolize the first slots.
async fn sync_candidates(app: &Arc<AppState>, cid: &str) -> Vec<relay_core::peers::PeerRow> {
    let self_url = app
        .cfg
        .public_url
        .as_deref()
        .map(|u| u.trim().trim_end_matches('/').to_string());
    let mut peers = crate::peers::merged_public_list(app).await;
    if let Some(self_url) = &self_url {
        peers.retain(|p| &p.url != self_url);
    }
    let hour = app.now().div_euclid(3600);
    let seed = format!("{cid}:{hour}");
    sync_candidates_seeded(&peers, usize::MAX, &seed)
        .into_iter()
        .cloned()
        .collect()
}

/// Verify a peer-sourced envelope before storing — the worker's five
/// checks (relay-worker lookup.rs pull_from_peers parity):
/// 1. the CID recomputes from OUR request line (cid_verify);
/// 2. the `line` anchor is REQUIRED and must name the same canonical
///    line (anchor-less rows fail closed, like the worker);
/// 3. the envelope's upstream is the host we are proxying (confusion
///    guard);
/// 4. the row is 2xx with a decodable body and a live TTL;
/// 5. the row is still FRESH (a stale grace-window row is skipped —
///    fall through to the next peer / the real upstream).
fn verify(
    cid: &str,
    request_line: &str,
    host: &str,
    path: &str,
    env: &LookupEnvelope,
    now: u64,
) -> bool {
    let _ = path;
    cid_verify(cid, request_line)
        && env.line.as_deref() == Some(request_line)
        && env.upstream == host
        && env.v == 1
        && (200..300).contains(&env.status)
        && env.body().is_some()
        && env.ttl > 0
        && env.is_fresh(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use relay_core::lookup::{canonical_request_line, cid_of_request};

    fn env_for(host: &str, line: &str) -> LookupEnvelope {
        LookupEnvelope::new(200, "application/json", b"[]", 1_000, 120, host, line)
    }

    const LINE: &str = "GET https://vortex.wowsgame.cn/x";
    const CID_ARGS: (&str, &str, Option<&str>) = ("GET", "https://vortex.wowsgame.cn/x", None);

    #[test]
    fn verification_rejects_wrong_upstream_or_bad_shape() {
        let line = canonical_request_line(CID_ARGS.0, CID_ARGS.1, CID_ARGS.2);
        let cid = cid_of_request(CID_ARGS.0, CID_ARGS.1, CID_ARGS.2);
        let good = env_for("vortex.wowsgame.cn", &line);
        assert!(verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &good,
            1_100
        ));
        // Wrong upstream host under the right CID → refused.
        assert!(!verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &env_for("vortex.worldofwarships.eu", &line),
            1_100
        ));
        // Bad shape: non-2xx status, corrupt body, v≠1.
        let mut bad = env_for("vortex.wowsgame.cn", &line);
        bad.status = 404;
        assert!(!verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &bad,
            1_100
        ));
        let mut bad2 = env_for("vortex.wowsgame.cn", &line);
        bad2.body_b64 = "!!not base64!!".into();
        assert!(!verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &bad2,
            1_100
        ));
        let mut bad3 = env_for("vortex.wowsgame.cn", &line);
        bad3.v = 2;
        assert!(!verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &bad3,
            1_100
        ));
        // Wrong request line (CID does not recompute) → refused.
        assert!(!verify(
            &cid,
            "GET https://vortex.wowsgame.cn/other",
            "vortex.wowsgame.cn",
            "/x",
            &good,
            1_100
        ));
        // Stale row (past the TTL window): skipped, not served.
        assert!(!verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &good,
            1_000 + 120
        ));
    }

    #[test]
    fn the_line_anchor_is_required() {
        let line = canonical_request_line(CID_ARGS.0, CID_ARGS.1, CID_ARGS.2);
        let cid = cid_of_request(CID_ARGS.0, CID_ARGS.1, CID_ARGS.2);
        let mut anchorless = env_for("vortex.wowsgame.cn", &line);
        anchorless.line = None;
        assert!(!verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &anchorless,
            1_100
        ));
        let mut lying = env_for("vortex.wowsgame.cn", &line);
        lying.line = Some("GET https://vortex.wowsgame.cn/other".into());
        assert!(!verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &lying,
            1_100
        ));
        assert!(verify(
            &cid,
            &line,
            "vortex.wowsgame.cn",
            "/x",
            &env_for("vortex.wowsgame.cn", &line),
            1_100
        ));
    }

    #[test]
    fn local_ttl_authority_clamps_peer_claims() {
        // A peer claiming 86_400 s for a vortex account path (120 s
        // locally) is clamped by the caller via classify_ttl — pin the
        // classification used for the clamp.
        assert_eq!(classify_ttl("vortex.wowsgame.cn", "/x"), 300);
        assert_eq!(classify_ttl("vortex.wowsgame.cn", "/api/accounts/1"), 120);
    }
}
