//! The singleton ReplayIndex Durable Object — the replay-share ledger.
//! All decisions (verdict precedence, claim acceptance, watermark,
//! drain semantics) live in [`relay_core::replay::Ledger`]; this module
//! persists the ledger's rows in DO storage (KV-style, same layout as
//! the code Directory: `h:<sha256>`, `c:<anonId>:<sha256>` mirrors,
//! `tok:<anonId>`, `meta:<anonId>`, `rule:<ruleId>`, `wm`) and
//! re-exposes them over the internal stub-fetch face. There are no
//! alarms — rows never expire on their own (drained hash rows stay
//! forever, keeping duplicate detection and rule counters honest).
//!
//! Internal routes (dialed by the main worker only):
//!   POST /check    {anon?, facts, rules}          → {results}
//!   GET  /mine?anon&thash                         → {staged, archiveBytes, creditCount}
//!                                                 | 404 unknown | 403 mismatch
//!   GET  /token?anon&thash                        → {known, matched}
//!   POST /claim   {phase: prepare|commit, …}      → 200 | 409 | 422 | 503
//!   GET  /admin-list                              → {contributors, watermark}
//!   POST /drain   {anonIds}                       → {drained, bytes}
//!   GET  /counters                                → {wm, rules}
//!
//! The wanted RULES arrive inside each /check and /claim call — the DO
//! never reads KV itself, so the ledger stays a pure function of its
//! storage rows plus the caller-supplied ruleset snapshot.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use relay_core::replay::{self, ClaimError, ClaimInput, ContributorMeta, HashRow, Ledger};
use serde_json::json;
use worker::*;

use crate::replay::{DoCheck, DoClaim, DoDrain};

/// Durable Object state is hydrated lazily on first use: rows are
/// listed from storage and folded into the pure [`Ledger`] machine,
/// which is then write-throughed on every mutation.
#[durable_object]
pub struct ReplayIndex {
    state: State,
    env: Env,
    ledger: Rc<RefCell<Option<Ledger>>>,
}

impl DurableObject for ReplayIndex {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            ledger: Rc::new(RefCell::new(None)),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let _ = &self.env;
        self.ensure_loaded().await?;
        let url = req.url()?;
        let query = url.query().unwrap_or("").to_string();
        match url.path() {
            "/check" => {
                if let Some(resp) = Self::require_post(&req) {
                    return Ok(resp);
                }
                let body: DoCheck = match req.json().await {
                    Ok(b) => b,
                    Err(_) => return Response::error("bad request", 400),
                };
                self.check(body).await
            },
            "/mine" => self.mine(&query).await,
            "/token" => self.token(&query).await,
            "/claim" => {
                if let Some(resp) = Self::require_post(&req) {
                    return Ok(resp);
                }
                let body: DoClaim = match req.json().await {
                    Ok(b) => b,
                    Err(_) => return Response::error("bad request", 400),
                };
                self.claim(body).await
            },
            "/admin-list" => self.admin_list().await,
            "/credits" => self.credits().await,
            "/drain" => {
                if let Some(resp) = Self::require_post(&req) {
                    return Ok(resp);
                }
                let body: DoDrain = match req.json().await {
                    Ok(b) => b,
                    Err(_) => return Response::error("bad request", 400),
                };
                self.drain(body).await
            },
            "/counters" => self.counters().await,
            _ => Response::error("not found", 404),
        }
    }
}

impl ReplayIndex {
    /// POST-only guard: the error response when the method is wrong,
    /// `None` when it may proceed.
    fn require_post(req: &Request) -> Option<Response> {
        if req.method() != Method::Post {
            return Response::error("method not allowed", 405).ok();
        }
        None
    }

    async fn ensure_loaded(&self) -> Result<()> {
        if self.ledger.borrow().is_some() {
            return Ok(());
        }
        let map = self.state.storage().list().await?;
        let mut hashes: Vec<(String, HashRow)> = Vec::new();
        let mut tokens: Vec<(String, String)> = Vec::new();
        let mut meta: Vec<(String, ContributorMeta)> = Vec::new();
        let mut rules: Vec<(String, u64)> = Vec::new();
        let mut wm: u64 = 0;
        for pair in map.entries() {
            let Ok(pair) = pair else { continue };
            let pair = js_sys::Array::from(&pair);
            let Some(key) = pair.get(0).as_string() else {
                continue;
            };
            let value = pair.get(1);
            if let Some(sha) = key.strip_prefix("h:") {
                if let Ok(row) = serde_wasm_bindgen::from_value::<HashRow>(value) {
                    hashes.push((sha.to_string(), row));
                }
            } else if key.starts_with("c:") {
                // Prefix mirrors of the h: rows — rebuilt from the
                // authoritative rows, never parsed back.
                continue;
            } else if let Some(anon) = key.strip_prefix("tok:") {
                if let Ok(hash) = serde_wasm_bindgen::from_value::<String>(value) {
                    tokens.push((anon.to_string(), hash));
                }
            } else if let Some(anon) = key.strip_prefix("meta:") {
                if let Ok(row) = serde_wasm_bindgen::from_value::<ContributorMeta>(value) {
                    meta.push((anon.to_string(), row));
                }
            } else if let Some(id) = key.strip_prefix("rule:") {
                if let Ok(count) = serde_wasm_bindgen::from_value::<u64>(value) {
                    rules.push((id.to_string(), count));
                }
            } else if key == replay::WM_KEY {
                if let Ok(total) = serde_wasm_bindgen::from_value::<u64>(value) {
                    wm = total;
                }
            }
        }
        *self.ledger.borrow_mut() = Some(Ledger::restore(hashes, tokens, meta, rules, wm));
        Ok(())
    }

    /// POST /check — verdicts for a batch of facts.
    async fn check(&self, body: DoCheck) -> Result<Response> {
        if body.facts.is_empty() || body.facts.len() > replay::MEMBERS_MAX {
            return Response::error("bad request", 400);
        }
        for f in &body.facts {
            if relay_core::replay::validate_facts(f).is_err() {
                return Response::error("bad facts", 400);
            }
        }
        let results = {
            let slot = self.ledger.borrow();
            let Some(ledger) = slot.as_ref() else {
                return not_hydrated();
            };
            ledger.check(body.anon.as_deref(), &body.facts, &body.rules)
        };
        Response::from_json(&json!({ "results": results }))
    }

    /// GET /mine?anon&thash — token-verify + the staged view.
    async fn mine(&self, query: &str) -> Result<Response> {
        let (Some(anon), Some(thash)) = (
            relay_core::route::query_get(query, "anon"),
            relay_core::route::query_get(query, "thash"),
        ) else {
            return Response::error("bad request", 400);
        };
        if !relay_core::replay::valid_anon_id(anon) || !relay_core::replay::valid_hex64(thash) {
            return Response::error("bad request", 400);
        }
        let slot = self.ledger.borrow();
        let Some(ledger) = slot.as_ref() else {
            return not_hydrated();
        };
        let (known, matched) = ledger.token_state(anon, thash);
        if !known {
            return Response::error("unknown contributor", 404);
        }
        if !matched {
            return Response::error("token mismatch", 403);
        }
        let Some((staged, archive_bytes, credit_count)) = ledger.mine(anon) else {
            return Response::error("unknown contributor", 404);
        };
        Response::from_json(&relay_core::replay::mine_response(
            &staged,
            archive_bytes,
            credit_count,
        ))
    }

    /// GET /token?anon&thash — the auth probe (200 with booleans).
    async fn token(&self, query: &str) -> Result<Response> {
        let (Some(anon), Some(thash)) = (
            relay_core::route::query_get(query, "anon"),
            relay_core::route::query_get(query, "thash"),
        ) else {
            return Response::error("bad request", 400);
        };
        if !relay_core::replay::valid_anon_id(anon) || !relay_core::replay::valid_hex64(thash) {
            return Response::error("bad request", 400);
        }
        let slot = self.ledger.borrow();
        let Some(ledger) = slot.as_ref() else {
            return not_hydrated();
        };
        let (known, matched) = ledger.token_state(anon, thash);
        Response::from_json(&json!({ "known": known, "matched": matched }))
    }

    /// POST /claim — prepare (dry-run before the R2 write) or commit
    /// (the ledger transaction). The worker maps the statuses 1:1 onto
    /// the client face (409 / 422 rejected / 422 dropped_members / 503
    /// watermark).
    async fn claim(&self, body: DoClaim) -> Result<Response> {
        if !relay_core::replay::valid_anon_id(&body.anon)
            || !relay_core::replay::valid_hex64(&body.thash)
            || !relay_core::replay::valid_credited_name(&body.credited_name)
            || !relay_core::replay::valid_realm(&body.realm)
            || body.members.is_empty()
            || body.members.len() > replay::MEMBERS_MAX
            || body.archive_bytes > replay::ARCHIVE_MAX_BYTES
        {
            return Response::error("bad request", 400);
        }
        let input = ClaimInput {
            anon: &body.anon,
            token_hash: &body.thash,
            credited_name: &body.credited_name,
            realm: &body.realm,
            archive_bytes: body.archive_bytes,
            members: &body.members,
            rules: &body.rules,
        };
        let now = Date::now().as_millis();
        if body.phase == "prepare" {
            let slot = self.ledger.borrow();
            let Some(ledger) = slot.as_ref() else {
                return not_hydrated();
            };
            return match ledger.evaluate_claim(&input) {
                Ok(_) => Response::from_json(&json!({ "ok": true })),
                Err(e) => claim_error(e),
            };
        }
        if body.phase != "commit" {
            return Response::error("bad request", 400);
        }
        let delta = {
            let mut slot = self.ledger.borrow_mut();
            let Some(ledger) = slot.as_mut() else {
                return not_hydrated();
            };
            match ledger.apply_claim(&input, now) {
                Ok(delta) => delta,
                Err(e) => return claim_error(e),
            }
        };
        // Write-through: rows the pure machine says changed.
        let storage = self.state.storage();
        for member in &delta.plan.accepted {
            let row = HashRow {
                contributor: body.anon.clone(),
                status: relay_core::replay::RowStatus::Staged,
                rule_id: member.rule_id.clone(),
                size: member.size,
                file_name: member.file_name.clone(),
                at: now,
            };
            let _ = storage
                .put(&replay::h_key(&member.sha256), row.clone())
                .await;
            let _ = storage
                .put(&replay::c_key(&body.anon, &member.sha256), row)
                .await;
        }
        for (id, total) in &delta.plan.rule_totals {
            let _ = storage.put(&replay::rule_key(id), *total).await;
        }
        if delta.plan.register_token {
            let _ = storage
                .put(&replay::tok_key(&body.anon), body.thash.clone())
                .await;
        }
        let _ = storage
            .put(&replay::meta_key(&body.anon), delta.plan.new_meta.clone())
            .await;
        let _ = storage.put(replay::WM_KEY, delta.plan.wm).await;
        Response::from_json(&json!({
            "accepted": delta.accepted_count,
            "archiveBytes": delta.archive_bytes,
            "creditCount": delta.plan.new_meta.credit_count,
        }))
    }

    /// GET /admin-list — contributor rows + watermark.
    async fn admin_list(&self) -> Result<Response> {
        let slot = self.ledger.borrow();
        let Some(ledger) = slot.as_ref() else {
            return not_hydrated();
        };
        Response::from_json(&relay_core::replay::admin_list_response(
            &ledger.admin_list(),
            ledger.counters().0,
        ))
    }

    /// GET /credits — per-identity lifetime share counts.
    async fn credits(&self) -> Result<Response> {
        let slot = self.ledger.borrow();
        let Some(ledger) = slot.as_ref() else {
            return not_hydrated();
        };
        Response::from_json(&relay_core::replay::credits_response(&ledger.credits()))
    }

    /// POST /drain — mark staged members drained, zero blob totals,
    /// decrement the watermark (rule counters unchanged), delete the c:
    /// mirrors.
    async fn drain(&self, body: DoDrain) -> Result<Response> {
        if body.anon_ids.is_empty() || body.anon_ids.len() > 1000 {
            return Response::error("bad request", 400);
        }
        for id in &body.anon_ids {
            if !relay_core::replay::valid_anon_id(id) {
                return Response::error("bad request", 400);
            }
        }
        let now = Date::now().as_millis();
        let delta = {
            let mut slot = self.ledger.borrow_mut();
            let Some(ledger) = slot.as_mut() else {
                return not_hydrated();
            };
            ledger.drain(&body.anon_ids, now)
        };
        let storage = self.state.storage();
        for (sha, row) in &delta.h_updates {
            let _ = storage.put(&replay::h_key(sha), row.clone()).await;
        }
        if !delta.c_deletes.is_empty() {
            let _ = storage.delete_multiple(delta.c_deletes.clone()).await;
        }
        for (anon, meta) in &delta.meta_updates {
            let _ = storage.put(&replay::meta_key(anon), meta.clone()).await;
        }
        let _ = storage.put(replay::WM_KEY, delta.wm).await;
        Response::from_json(&json!({
            "drained": delta.drained,
            "bytes": delta.bytes,
        }))
    }

    /// GET /counters — the live watermark + rule counters (the /wanted
    /// merge half that lives in the ledger).
    async fn counters(&self) -> Result<Response> {
        let slot = self.ledger.borrow();
        let Some(ledger) = slot.as_ref() else {
            return not_hydrated();
        };
        let (wm, rules) = ledger.counters();
        let map: HashMap<String, u64> = rules.into_iter().collect();
        Response::from_json(&json!({ "wm": wm, "rules": map }))
    }
}

/// Map a claim failure onto the client-facing error shape (the DO uses
/// the same status codes so the worker passes them through 1:1).
fn claim_error(e: ClaimError) -> Result<Response> {
    match e {
        ClaimError::TokenMismatch => error_json(409, "anon_exists_token_mismatch", None),
        ClaimError::Rejected(rejected) => {
            error_json(422, "rejected", Some(json!({ "rejected": rejected })))
        },
        ClaimError::DroppedMembers(dropped) => {
            error_json(422, "dropped_members", Some(json!({ "dropped": dropped })))
        },
        ClaimError::Watermark => error_json(503, "watermark", None),
    }
}

/// A JSON error with the `{"ok":false,"error":…}` convention plus
/// optional detail fields, at an explicit status.
fn error_json(status: u16, code: &str, detail: Option<serde_json::Value>) -> Result<Response> {
    let mut body = json!({ "ok": false, "error": code });
    if let (Some(obj), Some(detail)) = (body.as_object_mut(), detail) {
        if let Some(detail_obj) = detail.as_object() {
            for (k, v) in detail_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(Response::from_json(&body)?.with_status(status))
}

/// Error response for the (per the handlers' structure, unreachable)
/// case of touching the ledger before hydration — the plain-text 500
/// convention of the Directory DO.
fn not_hydrated() -> Result<Response> {
    Response::error("replay index unavailable", 500)
}
