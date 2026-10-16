//! The singleton code Directory Durable Object — the server side of
//! every pairing-code policy. All logic lives in
//! [`relay_core::directory`]; this module only persists its state in DO
//! storage (KV-style rows; the class is SQLite-backed so it is
//! provisionable on the Workers free plan) and re-arms the expiry alarm.
//!
//! Internal routes (dialed by the Room DO and the main worker only):
//!   GET /bind?room=<64hex>&ip=<host-ip>&hostId=<hex, optional>
//!                                                  → {"code":"NNNNNN"}
//!                                                    | 429 (live-code cap reached)
//!                                                    | 503 (code space exhausted)
//!   GET /lookup?code=NNNNNN&ip=<client-ip>         → {"room":"<64hex>"}
//!                                                    | 404 | 429 (rate limited)

use std::cell::RefCell;
use std::rc::Rc;

use relay_core::directory::{
    AllocError, AllocateDelta, CodeEntry, CodeRng, Directory as CodeDirectory,
    GLOBAL_FAILURE_ALERT, RateState, ResolveOutcome, code_key, host_key_storage, rate_key,
};
use relay_core::{valid_code, valid_host_id, valid_room};
use worker::*;

/// CSPRNG over workerd's `crypto.getRandomValues` (getrandom's wasm
/// JavaScript backend). relay-core's `CodeRng` seam keeps this the only
/// piece of randomness in the gateway — and tests deterministic.
pub struct SystemCodeRng;

impl CodeRng for SystemCodeRng {
    fn code_draw(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        getrandom::fill(&mut buf).expect("workerd crypto.getRandomValues unavailable");
        u32::from_le_bytes(buf)
    }
}

/// Durable Object state is hydrated lazily on first use: rows are listed
/// from storage and folded into the pure [`Directory`] machine, which is
/// then write-throughed on every mutation.
#[durable_object]
pub struct Directory {
    state: State,
    env: Env,
    dir: Rc<RefCell<Option<CodeDirectory>>>,
}

impl DurableObject for Directory {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            dir: Rc::new(RefCell::new(None)),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let _ = &self.env;
        self.ensure_loaded().await?;
        let url = req.url()?;
        let query = url.query().unwrap_or("").to_string();
        match url.path() {
            "/bind" => self.bind(&query).await,
            "/lookup" => self.lookup(&query).await,
            _ => Response::error("not found", 404),
        }
    }

    /// Expiry sweep: drop dead rows from storage, re-arm to the next
    /// deadline (earliest code expiry or stale rate row), or clear the
    /// alarm when nothing is left.
    async fn alarm(&self) -> Result<Response> {
        self.ensure_loaded().await?;
        let now = Date::now().as_millis();
        let removed = {
            let mut slot = self.dir.borrow_mut();
            let Some(dir) = slot.as_mut() else {
                return not_hydrated();
            };
            dir.sweep(now).0
        };
        let storage = self.state.storage();
        if !removed.is_empty() {
            let _ = storage.delete_multiple(removed).await;
        }
        // Recompute after the await: a bind or lookup that ran meanwhile
        // may have added a deadline (and found no pending alarm, since
        // this one is firing), which a pre-await value would cancel.
        let next = {
            let slot = self.dir.borrow();
            let Some(dir) = slot.as_ref() else {
                return not_hydrated();
            };
            dir.next_deadline()
        };
        self.arm_alarm(next).await;
        Response::ok("swept")
    }
}

impl Directory {
    async fn ensure_loaded(&self) -> Result<()> {
        if self.dir.borrow().is_some() {
            return Ok(());
        }
        let map = self.state.storage().list().await?;
        let mut codes: Vec<(String, CodeEntry)> = Vec::new();
        let mut hosts: Vec<(String, String)> = Vec::new();
        let mut rate: Vec<(String, RateState)> = Vec::new();
        // Rows in a foreign format (the v1 TypeScript worker stored raw
        // codes and "room:<hex>" reverse keys) are collected for removal
        // — one lazy sweep retires the old deployment's data.
        let mut foreign: Vec<String> = Vec::new();
        for pair in map.entries() {
            let Ok(pair) = pair else { continue };
            let pair = js_sys::Array::from(&pair);
            let Some(key) = pair.get(0).as_string() else {
                continue;
            };
            let value = pair.get(1);
            if let Some(code) = key.strip_prefix("c:") {
                if let Ok(entry) = serde_wasm_bindgen::from_value::<CodeEntry>(value) {
                    codes.push((code.to_string(), entry));
                }
            } else if let Some(host) = key.strip_prefix("h:") {
                if let Ok(code) = serde_wasm_bindgen::from_value::<String>(value) {
                    hosts.push((host.to_string(), code));
                }
            } else if let Some(ip) = key.strip_prefix("r:") {
                if let Ok(state) = serde_wasm_bindgen::from_value::<RateState>(value) {
                    rate.push((ip.to_string(), state));
                }
            } else {
                foreign.push(key);
            }
        }
        if !foreign.is_empty() {
            let _ = self.state.storage().delete_multiple(foreign).await;
        }
        // host keys are stored under "h:<logical key>"; restore wants the
        // logical key (which host_key_storage re-prefixes on write).
        *self.dir.borrow_mut() = Some(CodeDirectory::restore(codes, hosts, rate));
        Ok(())
    }

    async fn bind(&self, query: &str) -> Result<Response> {
        let Some(room) = relay_core::route::query_get(query, "room") else {
            return Response::error("bad room key", 400);
        };
        if !valid_room(room) {
            return Response::error("bad room key", 400);
        }
        let host_id = relay_core::route::query_get(query, "hostId").filter(|h| valid_host_id(h));
        let ip = relay_core::route::query_get(query, "ip").unwrap_or("unknown");
        let now = Date::now().as_millis();
        let mut rng = SystemCodeRng;
        let delta: Result<AllocateDelta, _> = {
            let mut slot = self.dir.borrow_mut();
            let Some(dir) = slot.as_mut() else {
                return not_hydrated();
            };
            dir.allocate(now, &mut rng, ip, room, host_id)
        };
        let storage = self.state.storage();
        let delta = match delta {
            Ok(delta) => delta,
            Err(AllocError::RateLimited) => return Response::error("rate limited", 429),
            Err(AllocError::Exhausted) => return Response::error("code space exhausted", 503),
        };
        let _ = storage
            .put(&code_key(&delta.code), delta.entry.clone())
            .await;
        let _ = storage
            .put(
                &host_key_storage(&host_storage_key_of(&delta)),
                delta.code.clone(),
            )
            .await;
        if !delta.removed.is_empty() {
            let _ = storage.delete_multiple(delta.removed.clone()).await;
        }
        self.arm_if_idle(delta.entry.expires_at).await;
        Response::from_json(&serde_json::json!({ "code": delta.code }))
    }

    async fn lookup(&self, query: &str) -> Result<Response> {
        let Some(code) = relay_core::route::query_get(query, "code") else {
            return Response::error("bad code", 400);
        };
        if !valid_code(code) {
            return Response::error("bad code", 400);
        }
        let ip = relay_core::route::query_get(query, "ip").unwrap_or("unknown");
        let now = Date::now().as_millis();
        let (outcome, rows, alert) = {
            let mut slot = self.dir.borrow_mut();
            let Some(dir) = slot.as_mut() else {
                return not_hydrated();
            };
            let (outcome, rows) = dir.resolve(now, ip, code);
            (outcome, rows, dir.take_failure_alert())
        };
        if alert {
            console_warn!(
                "pairing directory: {GLOBAL_FAILURE_ALERT} failed code resolves within a minute \
                 (possible distributed guessing)"
            );
        }
        // Only rows this resolve changed are written: a refusal of an
        // already-blocked client costs no storage write.
        let storage = self.state.storage();
        let mut latest_deadline: Option<u64> = None;
        for (bucket, state) in rows {
            latest_deadline = latest_deadline.max(state.dead_at());
            if state.is_empty() {
                let _ = storage.delete(&rate_key(&bucket)).await;
            } else {
                let _ = storage.put(&rate_key(&bucket), state).await;
            }
        }
        // Rate rows must be swept even while no code is live.
        if let Some(deadline) = latest_deadline {
            self.arm_if_idle(deadline).await;
        }
        match outcome {
            ResolveOutcome::Room(room) => {
                // The resolve stamped resolved_by — persist the claim so
                // it survives DO eviction for the code's whole TTL.
                let stamped = {
                    let slot = self.dir.borrow();
                    let Some(dir) = slot.as_ref() else {
                        return not_hydrated();
                    };
                    dir.entry(code).cloned()
                };
                if let Some(entry) = stamped {
                    let _ = storage.put(&code_key(code), entry).await;
                }
                Response::from_json(&serde_json::json!({ "room": room }))
            },
            ResolveOutcome::Unknown => Response::error("unknown code", 404),
            ResolveOutcome::RateLimited => Response::error("rate limited", 429),
        }
    }

    /// Arm the sweep alarm for `deadline` unless one is already pending.
    /// A pending alarm is always re-armed by the sweep to the true next
    /// deadline, so this never needs to scan the tables; a deadline that
    /// lands before the pending alarm is merely swept a little late
    /// (resolve checks expiries itself, so that is harmless).
    async fn arm_if_idle(&self, deadline: u64) {
        let storage = self.state.storage();
        if storage.get_alarm().await.ok().flatten().is_none() {
            self.arm_alarm(Some(deadline)).await;
        }
    }

    async fn arm_alarm(&self, next: Option<u64>) {
        let storage = self.state.storage();
        match next {
            Some(expiry) => {
                let _ = storage.set_alarm(expiry as i64 + 1_000).await;
            },
            None => {
                let _ = storage.delete_alarm().await;
            },
        }
    }
}

/// The logical host key of a fresh allocation ("id:<hex>" or
/// "room:<64hex>"); the storage row key is host_key_storage of this.
fn host_storage_key_of(delta: &AllocateDelta) -> String {
    relay_core::directory::host_index_key(delta.entry.host_id.as_deref(), &delta.entry.room)
}

/// Error response for the (per the handlers' structure, unreachable) case of
/// touching the directory before [`Directory::ensure_loaded`] has hydrated
/// it. Handlers keep the ensure_loaded-then-use invariant, but a violation
/// now surfaces as this file's plain-text 500 convention instead of a panic
/// (which workerd reports as an opaque exception, swallowing any status).
fn not_hydrated() -> Result<Response> {
    Response::error("directory unavailable", 500)
}
