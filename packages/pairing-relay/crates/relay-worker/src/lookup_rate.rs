//! The lookup namespace's per-IP hourly budget (§3.5) — a tiny SQLite
//! Durable Object, NOT a KV counter. The KV-counter shape the feedback
//! pipeline uses costs one WRITE per request against the namespace's
//! 1000-writes/day free budget; /api/lookup at 240 requests/hour/IP
//! would exhaust it in minutes and (fail-closed) take every
//! KV-dependent route down with it — exactly the 2026-10-22 incident
//! shape. DO storage has no such shared quota.
//!
//! Sharding: one instance per (hour bucket, IP) via `id_from_name`,
//! so hot IPs never contend on one object and no cross-IP state
//! exists. The hour bucket is part of the instance name, so a shard is
//! born, serves its window and dies — the alarm (armed on the first
//! spend, hour + slack ahead) deletes the storage and the instance
//! goes idle until workerd reaps it. No sweep cron is needed.
//!
//! Internal routes (the GatewayAuth DO is the pattern):
//!   GET /spend?limit=<u64>  → 200 (counted, under/at limit)
//!                            | 429 (over limit)

use worker::*;

/// The lookup rate-limit DO (binding LOOKUP_RATE, migration v6).
#[durable_object]
pub struct LookupRate {
    state: State,
}

impl DurableObject for LookupRate {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        if url.path() != "/spend" || req.method() != Method::Get {
            return Response::error("not found", 404);
        }
        let query = url.query().unwrap_or("");
        let limit = relay_core::route::query_get(query, "limit")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(relay_core::lookup::LOOKUP_RATE_PER_HOUR);
        let count: u64 = self
            .state
            .storage()
            .get::<u64>("count")
            .await
            .ok()
            .flatten()
            .unwrap_or(0)
            .saturating_add(1);
        if count > limit {
            return Ok(Response::empty()?.with_status(429));
        }
        self.state.storage().put("count", count).await?;
        // Arm the self-destruct for the hour window + slack if no
        // alarm is pending (first spend of the shard).
        let now = Date::now().as_millis() as i64;
        let deadline = now + 2 * 3_600_000;
        if self
            .state
            .storage()
            .get_alarm()
            .await
            .ok()
            .flatten()
            .is_none()
        {
            let _ = self.state.storage().set_alarm(deadline).await;
        }
        Ok(Response::empty()?.with_status(200))
    }

    /// The shard's hour window has passed: delete the counter. The
    /// instance name embeds the hour, so this shard is never asked to
    /// count again.
    async fn alarm(&self) -> Result<Response> {
        let _ = self.state.storage().delete_all().await;
        Response::ok("expired")
    }
}
