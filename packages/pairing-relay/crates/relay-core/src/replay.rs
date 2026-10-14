//! Replay-share collection policy — the pure half of the /api/replays/*
//! surface. The maintainer declares WHAT they currently want (a ruleset
//! in the `replays:wanted` KV value), clients claim facts about each
//! replay (plausibility-checked only — the server never parses the
//! package), and a singleton ledger (the `ReplayIndex` Durable Object,
//! hydrated from its storage rows like the code Directory) decides
//! accept / own_staged / duplicate / unwanted per hash.
//!
//! Split (mirrors feedback/directory):
//! - this module: wanted-ruleset parsing + rule matching, facts
//!   plausibility, verdict precedence, upload-manifest validation,
//!   quota/key constants, the ledger state machine, wire shapes —
//!   plain Rust over injected time, host-testable, no Cloudflare types.
//! - `relay-worker/src/replay.rs`: request plumbing — KV rate-limit
//!   counters, the R2 shard bucket, JSON exchange with the DO.
//! - `relay-worker/src/replay_index.rs`: the DO itself, persisting the
//!   ledger's rows and re-exposing its decisions over the internal
//!   stub-fetch face.
//!
//! Auth model (contract §3): no accounts. A client generates once and
//! persists `anonId` (uuid v4) + `uploadToken` (32 chars
//! `[A-Za-z0-9_-]`); the FIRST successful upload registers
//! sha256(uploadToken) in the ledger and every later call must match.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

// ── constants: keys, quotas, caps ──────────────────────────────────────

/// FEEDBACK_KV key holding the wanted ruleset (maintainer-written via
/// wrangler; absent/empty rules = collection CLOSED).
pub const KV_WANTED_KEY: &str = "replays:wanted";
/// Rate-limit counter key prefix inside FEEDBACK_KV (contract §7).
pub const RL_KEY_PREFIX: &str = "replays:rl:";

/// Uploads per UTC day per anonId.
pub const QUOTA_UPLOADS_PER_ANON_DAY: u64 = 8;
/// Uploads per UTC day per IP.
pub const QUOTA_UPLOADS_PER_IP_DAY: u64 = 24;
/// Archive fetches per UTC day per anonId.
pub const QUOTA_ARCHIVE_FETCHES_DAY: u64 = 20;
/// /check calls per UTC day per IP.
pub const QUOTA_CHECKS_PER_IP_DAY: u64 = 60;

/// One contributor's archive blob (tar.zst) may not exceed this.
pub const ARCHIVE_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Members per manifest / facts per /check call.
pub const MEMBERS_MAX: usize = 400;
/// Total staged bytes across all contributors (the watermark ceiling).
pub const LIMIT_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// The only manifest/consent version wave 1 speaks (contract §4/§11).
pub const MANIFEST_VERSION: u32 = 1;
pub const CONSENT_VERSION: u32 = 1;

/// The five game servers (the app's realm ids, same set as feedback).
pub const REALMS: [&str; 5] = ["ru", "eu", "na", "asia", "cn"];
/// The ship classes a facts row may name.
pub const SHIP_CLASSES: [&str; 5] = [
    "AirCarrier",
    "Battleship",
    "Cruiser",
    "Destroyer",
    "Submarine",
];

/// Facts plausibility bounds (contract §2).
pub const SIZE_MIN: u64 = 1024;
pub const SIZE_MAX: u64 = 67_108_864;
pub const PLAYERS_MAX: u32 = 64;
pub const TIER_MAX: u8 = 11;
pub const FILENAME_MAX: usize = 128;
/// `creditedName` length window (chars).
pub const CREDIT_NAME_MIN: usize = 3;
pub const CREDIT_NAME_MAX: usize = 24;

/// R2 key of a contributor's shard (the blob their manifest describes).
pub fn shard_key(anon_id: &str) -> String {
    format!("shards/{anon_id}.tar.zstd")
}

/// Ledger storage keys (contract §6; same "prefix:" style as Directory).
pub fn h_key(sha256: &str) -> String {
    format!("h:{sha256}")
}
/// Prefix-mirror of an accepted member under its contributor.
pub fn c_key(anon_id: &str, sha256: &str) -> String {
    format!("c:{anon_id}:{sha256}")
}
/// The stored sha256hex of a contributor's uploadToken.
pub fn tok_key(anon_id: &str) -> String {
    format!("tok:{anon_id}")
}
pub fn meta_key(anon_id: &str) -> String {
    format!("meta:{anon_id}")
}
/// Per-rule counter of distinct accepted replays ever (staged+drained —
/// drain never reopens a closed rule).
pub fn rule_key(rule_id: &str) -> String {
    format!("rule:{rule_id}")
}
/// The watermark: total staged ARCHIVE bytes across all contributors.
pub const WM_KEY: &str = "wm";

// ── auth shapes ────────────────────────────────────────────────────────

/// `anonId` is a uuid v4: 8-4-4-4-12 lowercase hex, version nibble 4,
/// RFC 4122 variant.
pub fn valid_anon_id(id: &str) -> bool {
    let b = id.as_bytes();
    if b.len() != 36 {
        return false;
    }
    let hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
    for (i, &c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if c != b'-' {
                    return false;
                }
            },
            _ => {
                if !hex(c) {
                    return false;
                }
            },
        }
    }
    b[14] == b'4' && matches!(b[19], b'8'..=b'b')
}

/// `uploadToken` is 32 chars of the URL-safe base64 alphabet.
pub fn valid_upload_token(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `creditedName`: 3..=24 chars, no control characters.
pub fn valid_credited_name(name: &str) -> bool {
    let n = name.chars().count();
    (CREDIT_NAME_MIN..=CREDIT_NAME_MAX).contains(&n) && !name.chars().any(char::is_control)
}

/// A realm code from the five the game runs.
pub fn valid_realm(realm: &str) -> bool {
    REALMS.contains(&realm)
}

/// sha256hex of the upload token — the only form ever persisted.
pub fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
    }
    out
}

// ── wanted ruleset ─────────────────────────────────────────────────────

/// One acceptance rule. Absent or empty array/None fields mean "any"
/// for that dimension; `collected` is overwritten with the live ledger
/// counter whenever verdicts are computed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WantedRule {
    /// `^[a-z0-9-]{1,64}$` — identifies the rule in manifests/ledger.
    pub id: String,
    /// Distinct accepted replays ever matched to this rule.
    #[serde(default)]
    pub collected: u64,
    /// `None` = unlimited.
    #[serde(default)]
    pub max_count: Option<u64>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub maps: Vec<String>,
    /// Canonical match-group keys (`standard` etc.).
    #[serde(default)]
    pub modes: Vec<String>,
    #[serde(default)]
    pub scenarios: Vec<String>,
    #[serde(default)]
    pub realms: Vec<String>,
    #[serde(default)]
    pub ship_classes: Vec<String>,
    #[serde(default)]
    pub ship_ids: Vec<u64>,
    #[serde(default)]
    pub tiers: Vec<u8>,
    #[serde(default)]
    pub player_count_min: Option<u32>,
    #[serde(default)]
    pub player_count_max: Option<u32>,
    #[serde(default)]
    pub bot_max: Option<u32>,
    /// Dot-numeric minimum client version (14.5.0 ≥ 14.0).
    #[serde(default)]
    pub client_version_min: Option<String>,
}

/// The parsed `replays:wanted` KV value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WantedDoc {
    #[serde(default)]
    pub ruleset_version: u64,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub rules: Vec<WantedRule>,
}

/// `^[a-z0-9-]{1,64}$`.
pub fn valid_rule_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Parse the KV value. Tolerant by rule: a rule with a malformed shape
/// or an invalid id is DROPPED (a maintainer typo disables that rule,
/// not the whole collection); a doc that is not a JSON object at all
/// parses as `None` = collection closed.
pub fn parse_wanted_doc(raw: &str) -> Option<WantedDoc> {
    if raw.trim().is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(raw).ok()?;
    if !v.is_object() {
        return None;
    }
    let mut doc = WantedDoc {
        ruleset_version: v.get("rulesetVersion").and_then(Value::as_u64).unwrap_or(0),
        updated_at: v
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        rules: Vec::new(),
    };
    for rule_v in v
        .get("rules")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let Ok(mut rule) = serde_json::from_value::<WantedRule>(rule_v.clone()) else {
            continue;
        };
        if !valid_rule_id(&rule.id) {
            continue;
        }
        // Defensive caps on maintainer-supplied arrays: a runaway ruleset
        // must not blow up matching cost per facts row.
        rule.maps.truncate(64);
        rule.modes.truncate(32);
        rule.scenarios.truncate(64);
        rule.realms.truncate(8);
        rule.ship_classes.truncate(8);
        rule.ship_ids.truncate(256);
        rule.tiers.truncate(16);
        doc.rules.push(rule);
    }
    Some(doc)
}

/// Dot-numeric `a` ≥ `b` ("14.5.0" ≥ "14.0"). Missing or non-numeric
/// components count as 0, so junk strings simply fail every real floor.
pub fn version_ge(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|c| c.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (va, vb) = (parse(a), parse(b));
    let n = va.len().max(vb.len());
    for i in 0..n {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    true
}

/// Whether the rule still has headroom (`collected < maxCount`).
pub fn rule_open(rule: &WantedRule) -> bool {
    rule.max_count.is_none_or(|max| rule.collected < max)
}

fn list_ok(list: &[String], v: &str) -> bool {
    list.is_empty() || list.iter().any(|x| x == v)
}

/// Does the rule match the facts? Absent/empty dimension = any.
pub fn rule_matches(rule: &WantedRule, f: &ReplayFacts) -> bool {
    let opt_ok = |list: &[String], v: &Option<String>| match v {
        Some(v) => list_ok(list, v),
        None => list.is_empty(),
    };
    list_ok(&rule.maps, &f.map)
        && list_ok(&rule.modes, &f.mode)
        && opt_ok(&rule.scenarios, &f.scenario)
        && list_ok(&rule.realms, &f.realm)
        && opt_ok(&rule.ship_classes, &f.ship_class)
        && (rule.ship_ids.is_empty() || rule.ship_ids.contains(&f.own_ship_id))
        && (rule.tiers.is_empty() || f.tier.is_some_and(|t| rule.tiers.contains(&t)))
        && rule.player_count_min.is_none_or(|m| f.player_count >= m)
        && rule.player_count_max.is_none_or(|m| f.player_count <= m)
        && rule.bot_max.is_none_or(|m| f.bot_count <= m)
        && rule
            .client_version_min
            .as_deref()
            .is_none_or(|min| version_ge(&f.client_version, min))
}

// ── replay facts ───────────────────────────────────────────────────────

/// Client-claimed facts about one replay (plausibility-checked only).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFacts {
    pub sha256: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub map: String,
    pub mode: String,
    pub scenario: Option<String>,
    pub realm: String,
    pub own_ship_id: u64,
    pub ship_class: Option<String>,
    pub tier: Option<u8>,
    pub player_count: u32,
    pub bot_count: u32,
    pub client_version: String,
    pub battle_time: String,
}

/// The facts a manifest member carries (the sha256/fileName/sizeBytes
/// live on the member itself).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberFacts {
    pub map: String,
    pub mode: String,
    pub scenario: Option<String>,
    pub realm: String,
    pub own_ship_id: u64,
    pub ship_class: Option<String>,
    pub tier: Option<u8>,
    pub player_count: u32,
    pub bot_count: u32,
    pub client_version: String,
    pub battle_time: String,
}

impl MemberFacts {
    /// Reassemble full facts for validation/matching.
    pub fn to_facts(&self, sha256: &str, file_name: &str, size_bytes: u64) -> ReplayFacts {
        ReplayFacts {
            sha256: sha256.to_string(),
            file_name: file_name.to_string(),
            size_bytes,
            map: self.map.clone(),
            mode: self.mode.clone(),
            scenario: self.scenario.clone(),
            realm: self.realm.clone(),
            own_ship_id: self.own_ship_id,
            ship_class: self.ship_class.clone(),
            tier: self.tier,
            player_count: self.player_count,
            bot_count: self.bot_count,
            client_version: self.client_version.clone(),
            battle_time: self.battle_time.clone(),
        }
    }
}

/// Exactly 64 lowercase hex chars (a facts sha256 or a token hash).
pub fn valid_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Path-free display name (no separators, no empty).
fn valid_file_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= FILENAME_MAX && !name.contains(['/', '\\'])
}

/// Plausibility per contract §2. `Err` carries a stable code.
pub fn validate_facts(f: &ReplayFacts) -> Result<(), &'static str> {
    if !valid_hex64(&f.sha256) {
        return Err("bad_sha256");
    }
    if !valid_file_name(&f.file_name) {
        return Err("bad_file_name");
    }
    if !(SIZE_MIN..=SIZE_MAX).contains(&f.size_bytes) {
        return Err("bad_size");
    }
    if f.map.is_empty() || f.map.chars().count() > 64 {
        return Err("bad_map");
    }
    if f.mode.is_empty() || f.mode.chars().count() > 32 {
        return Err("bad_mode");
    }
    if let Some(s) = f.scenario.as_deref() {
        if s.is_empty() || s.chars().count() > 64 {
            return Err("bad_scenario");
        }
    }
    if !valid_realm(&f.realm) {
        return Err("bad_realm");
    }
    if let Some(c) = f.ship_class.as_deref() {
        if !SHIP_CLASSES.contains(&c) {
            return Err("bad_ship_class");
        }
    }
    if f.tier.is_some_and(|t| t == 0 || t > TIER_MAX) {
        return Err("bad_tier");
    }
    if !(1..=PLAYERS_MAX).contains(&f.player_count) {
        return Err("bad_player_count");
    }
    if f.bot_count > PLAYERS_MAX {
        return Err("bad_bot_count");
    }
    if f.client_version.chars().count() > 32 {
        return Err("bad_client_version");
    }
    if f.battle_time.chars().count() > 40 {
        return Err("bad_battle_time");
    }
    Ok(())
}

// ── verdicts + /check wire shapes ──────────────────────────────────────

/// The per-replay verdict, in contract precedence order
/// duplicate > own_staged > accept > unwanted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Accept,
    OwnStaged,
    Duplicate,
    Unwanted,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::Accept => "accept",
            Verdict::OwnStaged => "own_staged",
            Verdict::Duplicate => "duplicate",
            Verdict::Unwanted => "unwanted",
        }
    }
}

/// One row of a /check reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub sha256: String,
    pub verdict: Verdict,
    /// The rule the server matched (accept only; else null).
    pub rule_id: Option<String>,
}

// ── upload manifest ────────────────────────────────────────────────────

/// One member of an upload manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestMember {
    pub sha256: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub facts: MemberFacts,
    /// The app's matched rule (hint; the server's own match wins).
    #[serde(default)]
    pub rule_id: Option<String>,
}

/// The decoded `x-manifest` payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadManifest {
    pub manifest_version: u32,
    pub consent_version: u32,
    pub credited_name: String,
    pub realm: String,
    pub app_version: String,
    pub members: Vec<ManifestMember>,
}

/// Why a manifest was refused. `Shape` codes map to HTTP 400;
/// `TooManyMembers` to 413.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    Shape(&'static str),
    TooManyMembers,
}

/// Validate the manifest's shape end-to-end (versions, credit fields,
/// member caps, per-member facts plausibility, in-manifest uniqueness).
pub fn parse_manifest(raw: &str) -> Result<UploadManifest, ManifestError> {
    let shape = |code: &'static str| Err(ManifestError::Shape(code));
    let v: Value = serde_json::from_str(raw).map_err(|_| ManifestError::Shape("bad_json"))?;
    let m: UploadManifest =
        serde_json::from_value(v).map_err(|_| ManifestError::Shape("bad_manifest"))?;
    if m.manifest_version != MANIFEST_VERSION {
        return shape("bad_manifest_version");
    }
    if m.consent_version != CONSENT_VERSION {
        return shape("bad_consent_version");
    }
    if !valid_credited_name(&m.credited_name) {
        return shape("bad_credited_name");
    }
    if !valid_realm(&m.realm) {
        return shape("bad_realm");
    }
    if m.app_version.chars().count() > 32 {
        return shape("bad_app_version");
    }
    if m.members.is_empty() {
        return shape("no_members");
    }
    if m.members.len() > MEMBERS_MAX {
        return Err(ManifestError::TooManyMembers);
    }
    let mut seen: Vec<&str> = Vec::with_capacity(m.members.len());
    for member in &m.members {
        let facts = member
            .facts
            .to_facts(&member.sha256, &member.file_name, member.size_bytes);
        if let Err(code) = validate_facts(&facts) {
            return shape(code);
        }
        if let Some(id) = member.rule_id.as_deref() {
            if !valid_rule_id(id) {
                return shape("bad_rule_id");
            }
        }
        if seen.contains(&member.sha256.as_str()) {
            return shape("duplicate_member");
        }
        seen.push(&member.sha256);
    }
    Ok(m)
}

// ── unpadded/padded base64url (RFC 4648 §5) ───────────────────────────

/// Decode base64url, tolerating up to two `=` pads (the app emits
/// unpadded; other encoders pad).
pub fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    let trimmed = text.trim_end_matches('=');
    if text.len() - trimmed.len() > 2 {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(trimmed.len() * 3 / 4);
    for chunk in trimmed.as_bytes().chunks(4) {
        if chunk.len() < 2 {
            return None;
        }
        let mut n: u32 = 0;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

// ── ledger (the ReplayIndex DO's state machine) ───────────────────────

/// Status of a known hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    Staged,
    Drained,
}

/// `h:<sha256>` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashRow {
    /// The contributor's anonId.
    pub contributor: String,
    pub status: RowStatus,
    pub rule_id: String,
    /// The member's RAW replay size (not the archive blob size).
    pub size: u64,
    pub file_name: String,
    /// When the row reached its current status (ms since epoch).
    pub at: u64,
}

/// `meta:<anonId>` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributorMeta {
    pub credited_name: String,
    pub realm: String,
    /// The contributor's CURRENT archive blob size (0 once drained).
    pub archive_bytes: u64,
    /// Distinct accepted replays ever credited (survives drain).
    pub credit_count: u64,
    pub updated_at: u64,
}

/// The whole ledger. Hydrated from storage rows on DO cold start; every
/// mutation goes through a `*_delta` result the DO writes through.
#[derive(Debug, Clone, Default)]
pub struct Ledger {
    /// sha256 → row (drained rows stay forever: they keep the hash
    /// known globally and the rule counters honest).
    hashes: HashMap<String, HashRow>,
    /// anonId → sha256hex(uploadToken).
    tokens: HashMap<String, String>,
    meta: HashMap<String, ContributorMeta>,
    /// ruleId → collected counter.
    rules: HashMap<String, u64>,
    wm: u64,
}

impl Ledger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rehydrate from persisted rows. The c: mirror rows are NOT read —
    /// the member sets are rebuilt from the authoritative h: rows (each
    /// carries its contributor).
    pub fn restore(
        hashes: impl IntoIterator<Item = (String, HashRow)>,
        tokens: impl IntoIterator<Item = (String, String)>,
        meta: impl IntoIterator<Item = (String, ContributorMeta)>,
        rules: impl IntoIterator<Item = (String, u64)>,
        wm: u64,
    ) -> Self {
        Self {
            hashes: hashes.into_iter().collect(),
            tokens: tokens.into_iter().collect(),
            meta: meta.into_iter().collect(),
            rules: rules.into_iter().collect(),
            wm,
        }
    }

    /// The rules with `collected` replaced by the live counters (a
    /// counter that never fired keeps the doc's seeded value — a DO
    /// storage wipe must not silently reopen a closed rule).
    pub fn live_rules(&self, doc: &[WantedRule]) -> Vec<WantedRule> {
        doc.iter()
            .map(|r| {
                let mut live = r.clone();
                live.collected = self.rules.get(&r.id).copied().unwrap_or(r.collected);
                live
            })
            .collect()
    }

    /// Watermark accepting (for /check and /wanted): total staged bytes
    /// still under the ceiling.
    pub fn watermark_accepting(&self) -> bool {
        self.wm < LIMIT_BYTES
    }

    /// The matching open rule for a facts row: scarcest first (lowest
    /// remaining = maxCount − collected, unlimited last, doc order on
    /// ties) so the reported ruleId matches the app's smart-select
    /// ordering. `None` = no open rule matches.
    fn best_rule<'r>(rules: &'r [WantedRule], f: &ReplayFacts) -> Option<&'r WantedRule> {
        rules
            .iter()
            .filter(|r| rule_open(r) && rule_matches(r, f))
            .min_by(|a, b| {
                let remaining = |r: &WantedRule| r.max_count.map(|m| m.saturating_sub(r.collected));
                remaining(a)
                    .unwrap_or(u64::MAX)
                    .cmp(&remaining(b).unwrap_or(u64::MAX))
                    .then_with(|| a.id.cmp(&b.id))
            })
    }

    /// /check: verdicts for a batch of facts. `anon` (the validated
    /// anonId header, when sent) splits own_staged from duplicate;
    /// without it every known hash reports duplicate.
    pub fn check(
        &self,
        anon: Option<&str>,
        facts: &[ReplayFacts],
        rules: &[WantedRule],
    ) -> Vec<CheckResult> {
        let rules = self.live_rules(rules);
        let accepting = self.watermark_accepting();
        facts
            .iter()
            .map(|f| match self.hashes.get(&f.sha256) {
                Some(row)
                    if anon == Some(row.contributor.as_str())
                        && row.status == RowStatus::Staged =>
                {
                    CheckResult {
                        sha256: f.sha256.clone(),
                        verdict: Verdict::OwnStaged,
                        rule_id: None,
                    }
                },
                Some(_) => CheckResult {
                    sha256: f.sha256.clone(),
                    verdict: Verdict::Duplicate,
                    rule_id: None,
                },
                None => match accepting.then(|| Self::best_rule(&rules, f)).flatten() {
                    Some(rule) => CheckResult {
                        sha256: f.sha256.clone(),
                        verdict: Verdict::Accept,
                        rule_id: Some(rule.id.clone()),
                    },
                    None => CheckResult {
                        sha256: f.sha256.clone(),
                        verdict: Verdict::Unwanted,
                        rule_id: None,
                    },
                },
            })
            .collect()
    }

    /// /mine for one contributor: staged members (newest first, sha
    /// tiebreak), blob size, credit count. `None` = unknown anonId.
    pub fn mine(&self, anon: &str) -> Option<(Vec<StagedMember>, u64, u64)> {
        let meta = self.meta.get(anon)?;
        let mut staged: Vec<StagedMember> = self
            .hashes
            .iter()
            .filter(|(_, row)| row.contributor == anon && row.status == RowStatus::Staged)
            .map(|(sha, row)| StagedMember {
                sha256: sha.clone(),
                file_name: row.file_name.clone(),
                size_bytes: row.size,
                at: row.at,
            })
            .collect();
        staged.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.sha256.cmp(&b.sha256)));
        Some((staged, meta.archive_bytes, meta.credit_count))
    }

    /// The contributor's currently staged hashes (the c: mirror's
    /// in-memory form).
    fn staged_shas(&self, anon: &str) -> Vec<String> {
        self.hashes
            .iter()
            .filter(|(_, row)| row.contributor == anon && row.status == RowStatus::Staged)
            .map(|(sha, _)| sha.clone())
            .collect()
    }

    /// Token state: `(known, matches)` — the /token face.
    pub fn token_state(&self, anon: &str, thash: &str) -> (bool, bool) {
        match self.tokens.get(anon) {
            Some(known) => (true, known == thash),
            None => (false, false),
        }
    }

    /// Evaluate an upload (contract §4 order: per-member verdicts →
    /// superset → watermark delta). Pure: `apply_claim` runs this and
    /// then mutates, so a DO can dry-run (prepare) before the R2 write
    /// and re-validate atomically at commit.
    pub fn evaluate_claim(&self, input: &ClaimInput) -> Result<ClaimPlan, ClaimError> {
        if let Some(known) = self.tokens.get(input.anon) {
            if known != input.token_hash {
                return Err(ClaimError::TokenMismatch);
            }
        }

        let rules = self.live_rules(input.rules);
        // Batch-aware rule headroom: accepted-so-far in THIS manifest
        // counts against maxCount, so a 199/200 rule cannot take two.
        let mut pending: HashMap<&str, u64> = HashMap::new();
        let watermark_open = self.wm < LIMIT_BYTES;
        let mut accepted: Vec<AcceptedMember> = Vec::new();
        let mut rejected: Vec<RejectedMember> = Vec::new();
        for member in input.members {
            match self.hashes.get(&member.sha256) {
                Some(row) => {
                    let own_staged =
                        row.contributor == input.anon && row.status == RowStatus::Staged;
                    if own_staged {
                        continue;
                    }
                    rejected.push(RejectedMember {
                        sha256: member.sha256.clone(),
                        verdict: Verdict::Duplicate,
                    });
                },
                None => {
                    let facts =
                        member
                            .facts
                            .to_facts(&member.sha256, &member.file_name, member.size_bytes);
                    let matched = watermark_open
                        .then(|| {
                            rules
                                .iter()
                                .filter(|r| {
                                    let effective = r.collected
                                        + pending.get(r.id.as_str()).copied().unwrap_or(0);
                                    let open = r.max_count.is_none_or(|max| effective < max);
                                    open && rule_matches(r, &facts)
                                })
                                .min_by(|a, b| {
                                    let remaining = |r: &WantedRule| {
                                        r.max_count.map(|m| {
                                            m.saturating_sub(
                                                r.collected
                                                    + pending
                                                        .get(r.id.as_str())
                                                        .copied()
                                                        .unwrap_or(0),
                                            )
                                        })
                                    };
                                    remaining(a)
                                        .unwrap_or(u64::MAX)
                                        .cmp(&remaining(b).unwrap_or(u64::MAX))
                                        .then_with(|| a.id.cmp(&b.id))
                                })
                        })
                        .flatten();
                    match matched {
                        Some(rule) => {
                            *pending.entry(rule.id.as_str()).or_default() += 1;
                            accepted.push(AcceptedMember {
                                sha256: member.sha256.clone(),
                                rule_id: rule.id.clone(),
                                size: member.size_bytes,
                                file_name: member.file_name.clone(),
                            });
                        },
                        None => rejected.push(RejectedMember {
                            sha256: member.sha256.clone(),
                            verdict: Verdict::Unwanted,
                        }),
                    }
                },
            }
        }
        if !rejected.is_empty() {
            return Err(ClaimError::Rejected(rejected));
        }

        // Superset: dropping a staged member is a 422 — the archive is
        // the contributor's WHOLE staged set, not a delta.
        let manifest_shas: Vec<&str> = input.members.iter().map(|m| m.sha256.as_str()).collect();
        let dropped: Vec<String> = self
            .staged_shas(input.anon)
            .into_iter()
            .filter(|sha| !manifest_shas.contains(&sha.as_str()))
            .collect();
        if !dropped.is_empty() {
            return Err(ClaimError::DroppedMembers(dropped));
        }

        // Watermark delta: total' = wm − oldBlob + newBlob ≤ limit.
        let old_bytes = self
            .meta
            .get(input.anon)
            .map(|m| m.archive_bytes)
            .unwrap_or(0);
        let wm_after = self
            .wm
            .saturating_sub(old_bytes)
            .saturating_add(input.archive_bytes);
        if wm_after > LIMIT_BYTES {
            return Err(ClaimError::Watermark);
        }

        let mut rule_totals: HashMap<String, u64> = HashMap::new();
        for (id, inc) in pending {
            let total = self.rules.get(id).copied().unwrap_or(0) + inc;
            rule_totals.insert(id.to_string(), total);
        }
        let credit_before = self
            .meta
            .get(input.anon)
            .map(|m| m.credit_count)
            .unwrap_or(0);
        Ok(ClaimPlan {
            new_meta: ContributorMeta {
                credited_name: input.credited_name.to_string(),
                realm: input.realm.to_string(),
                archive_bytes: input.archive_bytes,
                credit_count: credit_before + accepted.len() as u64,
                updated_at: 0, // stamped by apply_claim's now_ms
            },
            register_token: !self.tokens.contains_key(input.anon),
            rule_totals,
            accepted,
            wm: wm_after,
        })
    }

    /// Commit an upload: evaluate, mutate, and report everything the DO
    /// must write through. A second evaluate inside the same DO request
    /// is impossible (single-threaded), so prepare→R2→commit only needs
    /// the commit-side re-validation this performs.
    pub fn apply_claim(
        &mut self,
        input: &ClaimInput,
        now_ms: u64,
    ) -> Result<ClaimDelta, ClaimError> {
        let mut plan = self.evaluate_claim(input)?;
        plan.new_meta.updated_at = now_ms;
        let accepted_count = plan.accepted.len() as u64;
        let archive_bytes = input.archive_bytes;
        for member in plan.accepted.clone() {
            let row = HashRow {
                contributor: input.anon.to_string(),
                status: RowStatus::Staged,
                rule_id: member.rule_id.clone(),
                size: member.size,
                file_name: member.file_name.clone(),
                at: now_ms,
            };
            self.hashes.insert(member.sha256.clone(), row);
        }
        for (id, total) in &plan.rule_totals {
            self.rules.insert(id.clone(), *total);
        }
        if plan.register_token {
            self.tokens
                .insert(input.anon.to_string(), input.token_hash.to_string());
        }
        self.meta
            .insert(input.anon.to_string(), plan.new_meta.clone());
        self.wm = plan.wm;
        Ok(ClaimDelta {
            plan,
            accepted_count,
            archive_bytes,
        })
    }

    /// Drain: mark every staged member of the given contributors
    /// drained (rule counters unchanged — `collected` counts distinct
    /// accepted ever), zero their blob totals, decrement the watermark.
    /// Returns the storage writes/deletes plus `{drained, bytes}`.
    pub fn drain(&mut self, anon_ids: &[String], now_ms: u64) -> DrainDelta {
        let mut delta = DrainDelta::default();
        for anon in anon_ids {
            let Some(meta) = self.meta.get_mut(anon) else {
                continue;
            };
            let blob = meta.archive_bytes;
            meta.archive_bytes = 0;
            meta.updated_at = now_ms;
            let meta_row = meta.clone();
            for sha in self.staged_shas(anon) {
                let Some(row) = self.hashes.get_mut(&sha) else {
                    continue;
                };
                row.status = RowStatus::Drained;
                row.at = now_ms;
                delta.h_updates.push((sha.clone(), row.clone()));
                delta.c_deletes.push(c_key(anon, &sha));
            }
            self.meta.insert(anon.clone(), meta_row.clone());
            delta.meta_updates.push((anon.clone(), meta_row));
            delta.bytes += blob;
            self.wm = self.wm.saturating_sub(blob);
            delta.drained.push(anon.clone());
        }
        delta.wm = self.wm;
        delta
    }

    /// /admin-list rows: every known contributor, newest activity
    /// first, plus its live staged count.
    pub fn admin_list(&self) -> Vec<AdminContributor> {
        let mut rows: Vec<AdminContributor> = self
            .meta
            .iter()
            .map(|(anon, meta)| AdminContributor {
                anon_id: anon.clone(),
                credited_name: meta.credited_name.clone(),
                realm: meta.realm.clone(),
                staged_count: self.staged_shas(anon).len() as u64,
                archive_bytes: meta.archive_bytes,
                updated_at: meta.updated_at,
            })
            .collect();
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.anon_id.cmp(&b.anon_id))
        });
        rows
    }

    /// The /counters face: watermark total + every rule counter.
    pub fn counters(&self) -> (u64, Vec<(String, u64)>) {
        let mut rules: Vec<(String, u64)> =
            self.rules.iter().map(|(k, v)| (k.clone(), *v)).collect();
        rules.sort();
        (self.wm, rules)
    }
}

/// One staged member of a /mine reply (with the accept timestamp for
/// ordering; the wire shape below drops it).
#[derive(Debug, Clone, PartialEq)]
pub struct StagedMember {
    pub sha256: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub at: u64,
}

/// `/check`/`/claim` upload evaluation input.
#[derive(Debug, Clone)]
pub struct ClaimInput<'a> {
    pub anon: &'a str,
    pub token_hash: &'a str,
    pub credited_name: &'a str,
    pub realm: &'a str,
    /// The NEW archive blob's size (the upload's Content-Length).
    pub archive_bytes: u64,
    pub members: &'a [ManifestMember],
    /// The wanted doc's rules (live counters are merged internally).
    pub rules: &'a [WantedRule],
}

/// Why a claim failed; each variant maps to a contract §4 status.
#[derive(Debug, Clone, PartialEq)]
pub enum ClaimError {
    /// 409 — the stored token hash differs.
    TokenMismatch,
    /// 422 — some member is neither accept nor own_staged NOW.
    Rejected(Vec<RejectedMember>),
    /// 422 — staged members missing from the manifest.
    DroppedMembers(Vec<String>),
    /// 503 — the watermark delta would pass the ceiling.
    Watermark,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedMember {
    pub sha256: String,
    pub verdict: Verdict,
}

/// What a successful claim changes (rows for the DO to write through).
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimPlan {
    pub accepted: Vec<AcceptedMember>,
    /// ruleId → NEW counter total for rules this claim touched.
    pub rule_totals: HashMap<String, u64>,
    /// First upload by this contributor registers the token hash.
    pub register_token: bool,
    pub new_meta: ContributorMeta,
    pub wm: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedMember {
    pub sha256: String,
    pub rule_id: String,
    pub size: u64,
    pub file_name: String,
}

/// The write-through payload of a committed claim.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimDelta {
    pub plan: ClaimPlan,
    pub accepted_count: u64,
    pub archive_bytes: u64,
}

/// The write-through payload of a drain.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DrainDelta {
    pub h_updates: Vec<(String, HashRow)>,
    pub c_deletes: Vec<String>,
    pub meta_updates: Vec<(String, ContributorMeta)>,
    pub drained: Vec<String>,
    pub bytes: u64,
    pub wm: u64,
}

/// /admin-list row.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminContributor {
    pub anon_id: String,
    pub credited_name: String,
    pub realm: String,
    pub staged_count: u64,
    pub archive_bytes: u64,
    pub updated_at: u64,
}

// ── served documents ───────────────────────────────────────────────────

/// The merged /wanted response: KV doc fields + live watermark and
/// per-rule counters. `doc: None` = collection closed (missing/empty KV
/// value) — still a 200 with an empty rule list and `accepting: false`.
pub fn wanted_response(doc: Option<&WantedDoc>, wm: u64, counters: &HashMap<String, u64>) -> Value {
    let accepting = wm < LIMIT_BYTES
        && doc.is_some_and(|d| {
            d.rules.iter().any(|r| {
                let collected = counters.get(&r.id).copied().unwrap_or(r.collected);
                r.max_count.is_none_or(|max| collected < max)
            })
        });
    let rules: Vec<Value> = doc
        .map(|d| {
            d.rules
                .iter()
                .map(|r| {
                    let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert(
                            "collected".into(),
                            json!(counters.get(&r.id).copied().unwrap_or(r.collected)),
                        );
                    }
                    v
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "rulesetVersion": doc.map(|d| d.ruleset_version).unwrap_or(0),
        "updatedAt": doc.and_then(|d| d.updated_at.clone()),
        "watermark": {
            "stagedBytes": wm,
            "limitBytes": LIMIT_BYTES,
            "accepting": accepting,
        },
        "rules": rules,
    })
}

/// /mine reply body.
pub fn mine_response(staged: &[StagedMember], archive_bytes: u64, credit_count: u64) -> Value {
    json!({
        "staged": staged
            .iter()
            .map(|m| json!({
                "sha256": m.sha256,
                "fileName": m.file_name,
                "sizeBytes": m.size_bytes,
            }))
            .collect::<Vec<_>>(),
        "archiveBytes": archive_bytes,
        "creditCount": credit_count,
    })
}

/// /admin-list reply body.
pub fn admin_list_response(rows: &[AdminContributor], wm: u64) -> Value {
    json!({
        "contributors": rows
            .iter()
            .map(|c| json!({
                "anonId": c.anon_id,
                "creditedName": c.credited_name,
                "realm": c.realm,
                "stagedCount": c.staged_count,
                "archiveBytes": c.archive_bytes,
                "updatedAt": iso8601_utc(c.updated_at),
            }))
            .collect::<Vec<_>>(),
        "watermark": {
            "stagedBytes": wm,
            "limitBytes": LIMIT_BYTES,
        },
    })
}

// ── time + rate-limit helpers ─────────────────────────────────────────

/// ms since epoch → `YYYY-MM-DDTHH:MM:SSZ` (Gregorian; Howard Hinnant's
/// civil-from-days). Negative inputs clamp to the epoch.
pub fn iso8601_utc(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let rem = ms % 86_400_000;
    let (h, mi, s) = (
        rem / 3_600_000,
        (rem % 3_600_000) / 60_000,
        (rem % 60_000) / 1000,
    );
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// UTC day bucket of a timestamp (integer buckets stay clock-format
/// free, like the feedback counters).
pub fn day_bucket(now_ms: i64) -> i64 {
    now_ms.div_euclid(86_400_000)
}

/// Upload quota keys + limits (anon + IP), in check order.
pub fn rl_upload_keys(anon: &str, ip: &str, day: i64) -> Vec<(String, u64)> {
    vec![
        (
            format!("{RL_KEY_PREFIX}up:a:{anon}:{day}"),
            QUOTA_UPLOADS_PER_ANON_DAY,
        ),
        (
            format!("{RL_KEY_PREFIX}up:i:{ip}:{day}"),
            QUOTA_UPLOADS_PER_IP_DAY,
        ),
    ]
}

/// Archive-fetch quota key + limit.
pub fn rl_archive_key(anon: &str, day: i64) -> (String, u64) {
    (
        format!("{RL_KEY_PREFIX}arch:{anon}:{day}"),
        QUOTA_ARCHIVE_FETCHES_DAY,
    )
}

/// /check quota key + limit.
pub fn rl_check_key(ip: &str, day: i64) -> (String, u64) {
    (
        format!("{RL_KEY_PREFIX}chk:{ip}:{day}"),
        QUOTA_CHECKS_PER_IP_DAY,
    )
}

/// Seconds until the current day bucket rolls over (a 429's Retry-After,
/// rounded up so a sub-second remainder still says "1").
pub fn day_retry_after_secs(now_ms: i64) -> u64 {
    let next = (day_bucket(now_ms) + 1) * 86_400_000;
    ((next - now_ms).max(1) as u64).div_ceil(1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_790_000_000_000;
    const ANON: &str = "01234567-89ab-4cde-8f01-23456789abcd";
    const ANON2: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyz012345";
    const TOKEN2: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ5678";

    fn rule(id: &str) -> WantedRule {
        WantedRule {
            id: id.into(),
            ..WantedRule::default()
        }
    }

    fn facts(sha: &str) -> ReplayFacts {
        ReplayFacts {
            sha256: sha.into(),
            file_name: format!("{sha}.wowsreplay"),
            size_bytes: 8_123_456,
            map: "008_SOLOMONS".into(),
            mode: "standard".into(),
            scenario: None,
            realm: "asia".into(),
            own_ship_id: 4_183_301_234,
            ship_class: Some("Battleship".into()),
            tier: Some(10),
            player_count: 12,
            bot_count: 0,
            client_version: "14.5.0".into(),
            battle_time: "2026-10-14T09:00:00Z".into(),
        }
    }

    fn member(sha: &str) -> ManifestMember {
        let f = facts(sha);
        ManifestMember {
            sha256: f.sha256.clone(),
            file_name: f.file_name.clone(),
            size_bytes: f.size_bytes,
            facts: MemberFacts {
                map: f.map,
                mode: f.mode,
                scenario: f.scenario,
                realm: f.realm,
                own_ship_id: f.own_ship_id,
                ship_class: f.ship_class,
                tier: f.tier,
                player_count: f.player_count,
                bot_count: f.bot_count,
                client_version: f.client_version,
                battle_time: f.battle_time,
            },
            rule_id: None,
        }
    }

    /// An owned claim fixture — `ClaimInput` borrows, so tests override
    /// fields here and call [`ClaimFixture::input`].
    struct ClaimFixture {
        anon: &'static str,
        thash: String,
        credited_name: &'static str,
        realm: &'static str,
        archive_bytes: u64,
        members: Vec<ManifestMember>,
        rules: Vec<WantedRule>,
    }

    fn fx(anon: &'static str, token: &'static str, members: Vec<ManifestMember>) -> ClaimFixture {
        ClaimFixture {
            anon,
            thash: token_hash(token),
            credited_name: "Player",
            realm: "asia",
            archive_bytes: 100,
            members,
            rules: vec![rule("r-all")],
        }
    }

    impl ClaimFixture {
        fn input(&self) -> ClaimInput<'_> {
            ClaimInput {
                anon: self.anon,
                token_hash: &self.thash,
                credited_name: self.credited_name,
                realm: self.realm,
                archive_bytes: self.archive_bytes,
                members: &self.members,
                rules: &self.rules,
            }
        }
    }

    // ── auth shapes ────────────────────────────────────────────────────

    #[test]
    fn anon_id_must_be_a_uuid_v4() {
        assert!(valid_anon_id(ANON));
        assert!(valid_anon_id(ANON2));
        // v1/v5 version nibbles, bad variant, bad hex, wrong shape.
        assert!(!valid_anon_id("01234567-89ab-1cde-8f01-23456789abcd"));
        assert!(!valid_anon_id("01234567-89ab-4cde-0f01-23456789abcd"));
        assert!(!valid_anon_id("01234567-89ab-4cde-8f01-23456789abcD"));
        assert!(!valid_anon_id("01234567-89ab-4cde-8f0123456789abcd"));
        assert!(!valid_anon_id(""));
    }

    #[test]
    fn upload_token_and_credited_name_shapes() {
        assert!(valid_upload_token(TOKEN));
        assert!(valid_upload_token("AbC-_123AbC-_123AbC-_123AbC-_123"));
        assert!(!valid_upload_token("short"), "31 chars");
        assert!(!valid_upload_token(&"x".repeat(33)));
        assert!(!valid_upload_token("has space pad______________"));
        assert!(valid_credited_name("Player"));
        assert!(valid_credited_name("玩家一号"));
        assert!(!valid_credited_name("ab"), "too short");
        assert!(!valid_credited_name(&"x".repeat(25)));
        assert!(!valid_credited_name("bad\u{7}name"));
    }

    #[test]
    fn token_hash_is_sha256_hex() {
        let h = token_hash(TOKEN);
        assert_eq!(h.len(), 64);
        assert!(h.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(h, token_hash(TOKEN));
        assert_ne!(h, token_hash(TOKEN2));
        // Reference vector: sha256("abc") = ba7816bf8f01cfea…
        assert!(token_hash("abc").starts_with("ba7816bf"));
    }

    // ── wanted doc parsing + rule ids ─────────────────────────────────

    #[test]
    fn rule_ids_follow_the_contract_shape() {
        assert!(valid_rule_id("solomon-std-asia"));
        assert!(valid_rule_id("a"));
        assert!(valid_rule_id(&"x".repeat(64)));
        assert!(!valid_rule_id(""));
        assert!(!valid_rule_id(&"x".repeat(65)));
        assert!(!valid_rule_id("Upper-Case"));
        assert!(!valid_rule_id("under_score"));
    }

    #[test]
    fn wanted_doc_parses_and_drops_bad_rules() {
        let raw = r#"{
            "rulesetVersion": 3,
            "updatedAt": "2026-10-14T00:00:00Z",
            "rules": [
                { "id": "solomon-std-asia", "collected": 123, "maxCount": 200,
                  "note": " Solomon standard ",
                  "maps": ["008_SOLOMONS"], "modes": ["standard"],
                  "scenarios": [], "realms": ["asia"],
                  "shipClasses": ["Battleship"], "shipIds": [], "tiers": [10],
                  "playerCountMin": 12, "playerCountMax": 12, "botMax": 0,
                  "clientVersionMin": "14.0" },
                { "id": "Bad_ID" },
                { "collected": 5 },
                "junk"
            ]
        }"#;
        let doc = parse_wanted_doc(raw).unwrap();
        assert_eq!(doc.ruleset_version, 3);
        assert_eq!(doc.updated_at.as_deref(), Some("2026-10-14T00:00:00Z"));
        assert_eq!(doc.rules.len(), 1, "two malformed rules dropped");
        let r = &doc.rules[0];
        assert_eq!(r.id, "solomon-std-asia");
        assert_eq!(r.collected, 123);
        assert_eq!(r.max_count, Some(200));
        assert_eq!(r.maps, vec!["008_SOLOMONS".to_string()]);
        assert_eq!(r.tiers, vec![10u8]);
        assert_eq!(r.player_count_min, Some(12));
        assert_eq!(r.client_version_min.as_deref(), Some("14.0"));
        // A doc with only malformed rules is open-but-empty (closed).
        let empty = parse_wanted_doc(r#"{ "rules": [ { "id": "X" } ] }"#).unwrap();
        assert!(empty.rules.is_empty());
    }

    #[test]
    fn wanted_doc_missing_or_malformed_means_closed() {
        assert!(parse_wanted_doc("").is_none());
        assert!(parse_wanted_doc("   ").is_none());
        assert!(parse_wanted_doc("not json").is_none());
        assert!(parse_wanted_doc("[1,2]").is_none());
        // `{"rules":[...]}` with no other fields still parses.
        let doc = parse_wanted_doc(r#"{ "rules": [] }"#).unwrap();
        assert_eq!(doc.ruleset_version, 0);
        assert!(doc.rules.is_empty());
    }

    #[test]
    fn wanted_doc_rule_missing_fields_default_to_any() {
        let doc = parse_wanted_doc(r#"{ "rules": [ { "id": "all" } ] }"#).unwrap();
        let r = &doc.rules[0];
        assert_eq!(r.collected, 0);
        assert_eq!(r.max_count, None);
        assert!(r.maps.is_empty() && r.modes.is_empty() && r.tiers.is_empty());
        assert_eq!(r.player_count_min, None);
        assert_eq!(r.client_version_min, None);
    }

    // ── version compare ────────────────────────────────────────────────

    #[test]
    fn dot_numeric_versions_compare_correctly() {
        assert!(version_ge("14.5.0", "14.0"));
        assert!(version_ge("14.0", "14.0"));
        assert!(version_ge("15", "14.9.9"));
        assert!(version_ge("14", "13"));
        assert!(!version_ge("14.0", "14.0.1"));
        assert!(!version_ge("13.9", "14"));
        assert!(version_ge("14.0.0.0", "14"));
        assert!(!version_ge("junk", "1"), "junk counts as 0.0.0");
        assert!(version_ge("", ""), "empty == empty");
        assert!(version_ge("14.", "13.9"), "empty tail counts as 0");
    }

    // ── rule matching matrix ──────────────────────────────────────────

    #[test]
    fn empty_rule_matches_any_plausible_facts() {
        let r = rule("all");
        assert!(rule_matches(&r, &facts(&"a".repeat(64))));
    }

    #[test]
    fn rule_matching_matrix_per_dimension() {
        let f = ReplayFacts {
            scenario: Some("SOLOMON_STD".into()),
            ..facts(&"a".repeat(64))
        };
        let mut r = rule("m");
        r.maps = vec!["008_SOLOMONS".into()];
        r.modes = vec!["standard".into(), "domination".into()];
        r.scenarios = vec!["SOLOMON_STD".into()];
        r.realms = vec!["asia".into(), "eu".into()];
        r.ship_classes = vec!["Battleship".into()];
        r.ship_ids = vec![4_183_301_234];
        r.tiers = vec![10];
        r.player_count_min = Some(12);
        r.player_count_max = Some(12);
        r.bot_max = Some(0);
        r.client_version_min = Some("14.0".into());
        assert!(rule_matches(&r, &f), "the fixture satisfies every field");

        let mismatch = |mut f: ReplayFacts, mutate: fn(&mut ReplayFacts)| {
            mutate(&mut f);
            !rule_matches(&r, &f)
        };
        assert!(mismatch(f.clone(), |f| f.map = "01_OTHER".into()));
        assert!(mismatch(f.clone(), |f| f.mode = "coop".into()));
        assert!(mismatch(f.clone(), |f| f.scenario = Some("OTHER".into())));
        assert!(mismatch(f.clone(), |f| f.realm = "na".into()));
        assert!(mismatch(f.clone(), |f| f.ship_class = Some("Cruiser".into())));
        assert!(mismatch(f.clone(), |f| f.ship_class = None));
        assert!(mismatch(f.clone(), |f| f.own_ship_id = 1));
        assert!(mismatch(f.clone(), |f| f.tier = Some(9)));
        assert!(mismatch(f.clone(), |f| f.tier = None));
        assert!(mismatch(f.clone(), |f| f.player_count = 11));
        assert!(mismatch(f.clone(), |f| f.bot_count = 1));
        assert!(mismatch(f.clone(), |f| f.client_version = "13.9.9".into()));
    }

    #[test]
    fn null_facts_dimensions_match_only_any_lists() {
        let f = ReplayFacts {
            scenario: None,
            ship_class: None,
            tier: None,
            ..facts(&"a".repeat(64))
        };
        let mut r = rule("m");
        assert!(rule_matches(&r, &f), "empty lists = any");
        r.scenarios = vec!["X".into()];
        assert!(
            !rule_matches(&r, &f),
            "rule wanting a scenario never matches null"
        );
        r.scenarios.clear();
        r.ship_classes = vec!["Battleship".into()];
        assert!(
            !rule_matches(&r, &f),
            "rule wanting a class never matches null"
        );
        r.ship_classes.clear();
        r.tiers = vec![10];
        assert!(
            !rule_matches(&r, &f),
            "rule wanting a tier never matches null"
        );
    }

    #[test]
    fn rule_open_respects_max_count() {
        let mut r = rule("m");
        assert!(rule_open(&r), "no maxCount = unlimited");
        r.max_count = Some(200);
        assert!(rule_open(&r));
        r.collected = 200;
        assert!(!rule_open(&r), "at the cap the rule closes");
    }

    // ── facts plausibility ────────────────────────────────────────────

    #[test]
    fn facts_plausibility_bounds() {
        assert!(validate_facts(&facts(&"a".repeat(64))).is_ok());
        let bad = |mut f: ReplayFacts, expect: &str, mutate: fn(&mut ReplayFacts)| {
            mutate(&mut f);
            assert_eq!(validate_facts(&f), Err(expect));
        };
        bad(facts(&"A".repeat(64)), "bad_sha256", |f| {
            f.sha256 = "A".repeat(64)
        });
        bad(facts(&"g".repeat(64)), "bad_sha256", |f| {
            f.sha256 = "g".repeat(64)
        });
        bad(facts(&"a".repeat(63)), "bad_sha256", |f| {
            f.sha256 = "a".repeat(63)
        });
        bad(facts(&"a".repeat(64)), "bad_file_name", |f| {
            f.file_name = "a/b".into()
        });
        bad(facts(&"a".repeat(64)), "bad_file_name", |f| {
            f.file_name = String::new()
        });
        bad(facts(&"a".repeat(64)), "bad_file_name", |f| {
            f.file_name = "x".repeat(129)
        });
        bad(facts(&"a".repeat(64)), "bad_size", |f| f.size_bytes = 1023);
        bad(facts(&"a".repeat(64)), "bad_size", |f| {
            f.size_bytes = 67_108_865
        });
        assert!(
            validate_facts(&ReplayFacts {
                size_bytes: 1024,
                ..facts(&"a".repeat(64))
            })
            .is_ok()
        );
        assert!(
            validate_facts(&ReplayFacts {
                size_bytes: 67_108_864,
                ..facts(&"a".repeat(64))
            })
            .is_ok()
        );
        bad(facts(&"a".repeat(64)), "bad_realm", |f| {
            f.realm = "na2".into()
        });
        bad(facts(&"a".repeat(64)), "bad_ship_class", |f| {
            f.ship_class = Some("Frigate".into())
        });
        bad(facts(&"a".repeat(64)), "bad_tier", |f| f.tier = Some(12));
        bad(facts(&"a".repeat(64)), "bad_tier", |f| f.tier = Some(0));
        assert!(
            validate_facts(&ReplayFacts {
                tier: None,
                ..facts(&"a".repeat(64))
            })
            .is_ok()
        );
        bad(facts(&"a".repeat(64)), "bad_player_count", |f| {
            f.player_count = 0
        });
        bad(facts(&"a".repeat(64)), "bad_player_count", |f| {
            f.player_count = 65
        });
        bad(facts(&"a".repeat(64)), "bad_bot_count", |f| {
            f.bot_count = 65
        });
        bad(facts(&"a".repeat(64)), "bad_map", |f| f.map = String::new());
        bad(facts(&"a".repeat(64)), "bad_mode", |f| {
            f.mode = String::new()
        });
        bad(facts(&"a".repeat(64)), "bad_client_version", |f| {
            f.client_version = "x".repeat(33)
        });
        bad(facts(&"a".repeat(64)), "bad_battle_time", |f| {
            f.battle_time = "x".repeat(41)
        });
        bad(facts(&"a".repeat(64)), "bad_scenario", |f| {
            f.scenario = Some("x".repeat(65))
        });
    }

    // ── manifest validation ───────────────────────────────────────────

    fn manifest_json(members_json: &str) -> String {
        format!(
            r#"{{ "manifestVersion": 1, "consentVersion": 1, "creditedName": "Player",
                 "realm": "asia", "appVersion": "0.6.1", "members": [{members_json}] }}"#
        )
    }

    fn member_json(sha: &str) -> String {
        let f = facts(sha);
        format!(
            r#"{{ "sha256": "{sha}", "fileName": "{file}", "sizeBytes": {size},
                 "facts": {{ "map": "{map}", "mode": "{mode}", "scenario": null,
                   "realm": "{realm}", "ownShipId": {ship}, "shipClass": "{cls}",
                   "tier": {tier}, "playerCount": {pc}, "botCount": {bc},
                   "clientVersion": "{cv}", "battleTime": "{bt}" }},
                 "ruleId": null }}"#,
            file = f.file_name,
            size = f.size_bytes,
            map = f.map,
            mode = f.mode,
            realm = f.realm,
            ship = f.own_ship_id,
            cls = f.ship_class.unwrap(),
            tier = 10,
            pc = f.player_count,
            bc = f.bot_count,
            cv = f.client_version,
            bt = f.battle_time,
        )
    }

    #[test]
    fn manifest_round_trips_and_validates() {
        let raw = manifest_json(&member_json(&"a".repeat(64)));
        let m = parse_manifest(&raw).unwrap();
        assert_eq!(m.manifest_version, 1);
        assert_eq!(m.credited_name, "Player");
        assert_eq!(m.realm, "asia");
        assert_eq!(m.members.len(), 1);
        assert_eq!(m.members[0].sha256, "a".repeat(64));
        assert_eq!(m.members[0].facts.tier, Some(10));
    }

    #[test]
    fn manifest_shape_failures_carry_stable_codes() {
        let sha = "a".repeat(64);
        let cases: Vec<(String, &'static str)> = vec![
            ("not json".into(), "bad_json"),
            ("{}".into(), "bad_manifest"),
            (
                manifest_json(&member_json(&sha)).replacen(
                    "\"manifestVersion\": 1",
                    "\"manifestVersion\": 2",
                    1,
                ),
                "bad_manifest_version",
            ),
            (
                manifest_json(&member_json(&sha)).replacen(
                    "\"consentVersion\": 1",
                    "\"consentVersion\": 0",
                    1,
                ),
                "bad_consent_version",
            ),
            (
                manifest_json(&member_json(&sha)).replacen("Player", "ab", 1),
                "bad_credited_name",
            ),
            (
                manifest_json(&member_json(&sha)).replacen("\"asia\"", "\"moon\"", 1),
                "bad_realm",
            ),
            (
                r#"{ "manifestVersion": 1, "consentVersion": 1, "creditedName": "Player",
                     "realm": "asia", "appVersion": "1", "members": [] }"#
                    .into(),
                "no_members",
            ),
        ];
        for (raw, code) in cases {
            assert_eq!(
                parse_manifest(&raw),
                Err(ManifestError::Shape(code)),
                "{raw}"
            );
        }
        // Malformed member facts (upper-case sha).
        let bad_member = member_json(&sha).replacen(&sha, &"A".repeat(64), 1);
        assert_eq!(
            parse_manifest(&manifest_json(&bad_member)),
            Err(ManifestError::Shape("bad_sha256"))
        );
        // Duplicate member sha.
        let dup = format!("{},{}", member_json(&sha), member_json(&sha));
        assert_eq!(
            parse_manifest(&manifest_json(&dup)),
            Err(ManifestError::Shape("duplicate_member"))
        );
        // Bad ruleId hint.
        let hinted = member_json(&sha).replacen("\"ruleId\": null", "\"ruleId\": \"BAD_ID\"", 1);
        assert_eq!(
            parse_manifest(&manifest_json(&hinted)),
            Err(ManifestError::Shape("bad_rule_id"))
        );
    }

    #[test]
    fn manifest_member_cap_is_a_413_not_a_400() {
        let members: Vec<String> = (0..MEMBERS_MAX + 1)
            .map(|i| member_json(&format!("{i:064x}")))
            .collect();
        assert_eq!(
            parse_manifest(&manifest_json(&members.join(","))),
            Err(ManifestError::TooManyMembers)
        );
        let at_cap: Vec<String> = (0..MEMBERS_MAX)
            .map(|i| member_json(&format!("{i:064x}")))
            .collect();
        assert!(parse_manifest(&manifest_json(&at_cap.join(","))).is_ok());
    }

    // ── base64url ─────────────────────────────────────────────────────

    #[test]
    fn base64url_decode_accepts_padded_and_unpadded() {
        // "Manifest" vectors from RFC 4648-style spot checks.
        assert_eq!(b64url_decode("").unwrap(), b"");
        assert_eq!(b64url_decode("Zg").unwrap(), b"f");
        assert_eq!(b64url_decode("Zm8").unwrap(), b"fo");
        assert_eq!(b64url_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(b64url_decode("Zm9vYg").unwrap(), b"foob");
        assert_eq!(b64url_decode("Zm9vYmE").unwrap(), b"fooba");
        assert_eq!(b64url_decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(b64url_decode("Zm9vYmE=").unwrap(), b"fooba");
        assert_eq!(b64url_decode("Zm9vYg==").unwrap(), b"foob");
        assert!(b64url_decode("Zm9vYg===").is_none(), "three pads");
        assert!(b64url_decode("Zm9 v").is_none(), "whitespace");
        assert!(b64url_decode("Zm9+").is_none(), "standard alphabet +");
        assert!(b64url_decode("A").is_none(), "1-char tail");
        // A JSON doc round-trips.
        let doc = br#"{"manifestVersion":1}"#;
        let enc: String = {
            // encode via decode inverse: build with a tiny local encoder
            // (test-only, mirrors erp.rs's encoder).
            const B64URL: &[u8; 64] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            for chunk in doc.chunks(3) {
                let b = [
                    chunk[0],
                    *chunk.get(1).unwrap_or(&0),
                    *chunk.get(2).unwrap_or(&0),
                ];
                let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
                out.push(B64URL[(n >> 18) as usize & 63] as char);
                out.push(B64URL[(n >> 12) as usize & 63] as char);
                if chunk.len() > 1 {
                    out.push(B64URL[(n >> 6) as usize & 63] as char);
                }
                if chunk.len() > 2 {
                    out.push(B64URL[n as usize & 63] as char);
                }
            }
            out
        };
        assert_eq!(b64url_decode(&enc).unwrap(), doc);
    }

    // ── ledger: check precedence ──────────────────────────────────────

    #[test]
    fn check_verdict_precedence() {
        let known = &"b".repeat(64);
        let mine = &"c".repeat(64);
        let drained = &"d".repeat(64);
        let row = |contributor: &str, status: RowStatus| HashRow {
            contributor: contributor.into(),
            status,
            rule_id: "r-all".into(),
            size: 100,
            file_name: "x".into(),
            at: T0,
        };
        // Another contributor's staged hash + my staged hash + my drained.
        let led = Ledger::restore(
            vec![
                (known.to_string(), row(ANON2, RowStatus::Staged)),
                (mine.to_string(), row(ANON, RowStatus::Staged)),
                (drained.to_string(), row(ANON, RowStatus::Drained)),
            ],
            [],
            [],
            [],
            0,
        );
        let rules = vec![rule("r-all")];
        let fresh = &"a".repeat(64);
        let query = |led: &Ledger, anon: Option<&str>| {
            let facts = vec![facts(known), facts(mine), facts(drained), facts(fresh)];
            led.check(anon, &facts, &rules)
                .into_iter()
                .map(|r| (r.sha256, r.verdict, r.rule_id))
                .collect::<Vec<_>>()
        };
        // With my anonId: duplicate (other), own_staged (mine), duplicate
        // (drained — even my own), accept (fresh).
        let out = query(&led, Some(ANON));
        assert_eq!(
            out,
            vec![
                (known.to_string(), Verdict::Duplicate, None),
                (mine.to_string(), Verdict::OwnStaged, None),
                (drained.to_string(), Verdict::Duplicate, None),
                (fresh.to_string(), Verdict::Accept, Some("r-all".into())),
            ]
        );
        // Without headers the staged-by-me hash degrades to duplicate.
        let out = query(&led, None);
        assert_eq!(out[1], (mine.to_string(), Verdict::Duplicate, None));
    }

    #[test]
    fn check_accept_needs_open_rule_and_watermark() {
        let led = Ledger::new();
        let mut closed = rule("closed");
        closed.max_count = Some(1);
        closed.collected = 1;
        let out = led.check(None, &[facts(&"a".repeat(64))], &[closed]);
        assert_eq!(out[0].verdict, Verdict::Unwanted);

        // Watermark full: even an open rule cannot accept.
        let led = Ledger::restore([], [], [], [], LIMIT_BYTES);
        let out = led.check(None, &[facts(&"a".repeat(64))], &[rule("open")]);
        assert_eq!(out[0].verdict, Verdict::Unwanted);
        let led = Ledger::restore([], [], [], [], LIMIT_BYTES - 1);
        let out = led.check(None, &[facts(&"a".repeat(64))], &[rule("open")]);
        assert_eq!(out[0].verdict, Verdict::Accept);
    }

    #[test]
    fn check_reports_the_scarcest_open_rule() {
        let led = Ledger::new();
        let mut broad = rule("broad");
        broad.max_count = Some(1000);
        let mut scarce = rule("scarce");
        scarce.max_count = Some(10);
        scarce.collected = 9;
        let mut unlimited = rule("unlimited");
        unlimited.realms = vec!["asia".into()];
        // All three match the fixture; the scarcest wins.
        let all = vec![broad.clone(), scarce.clone(), unlimited.clone()];
        let out = led.check(None, &[facts(&"a".repeat(64))], &all);
        assert_eq!(out[0].rule_id.as_deref(), Some("scarce"));
        // With the scarce rule closed, the bounded one beats unlimited.
        let mut closed = scarce;
        closed.collected = 10;
        let rest = vec![broad, closed, unlimited];
        let out = led.check(None, &[facts(&"a".repeat(64))], &rest);
        assert_eq!(out[0].rule_id.as_deref(), Some("broad"));
    }

    #[test]
    fn live_counters_seed_from_doc_when_the_ledger_has_none() {
        let mut seeded = rule("seeded");
        seeded.max_count = Some(5);
        seeded.collected = 5;
        let led = Ledger::restore([], [], [], [("seeded".into(), 0u64)], 0);
        // Counter 0 exists → it WINS over the doc's 5 (live truth).
        let live = led.live_rules(&[seeded.clone()]);
        assert_eq!(live[0].collected, 0);
        assert!(rule_open(&live[0]));
        // Counter absent → the doc's seed survives (DO-wipe protection).
        let led = Ledger::new();
        let live = led.live_rules(&[seeded]);
        assert_eq!(live[0].collected, 5);
        assert!(!rule_open(&live[0]));
    }

    // ── ledger: claim (upload) ────────────────────────────────────────

    #[test]
    fn first_claim_registers_token_and_counts() {
        let mut led = Ledger::new();
        let f = fx(
            ANON,
            TOKEN,
            vec![member(&"a".repeat(64)), member(&"b".repeat(64))],
        );
        let delta = led.apply_claim(&f.input(), T0).unwrap();
        assert_eq!(delta.accepted_count, 2);
        assert!(delta.plan.register_token);
        assert_eq!(delta.plan.new_meta.credit_count, 2);
        assert_eq!(delta.plan.new_meta.archive_bytes, 100);
        assert_eq!(delta.plan.wm, 100);
        assert_eq!(led.counters().0, 100);
        let rule_total = delta.plan.rule_totals.get("r-all").copied().unwrap_or(0);
        assert_eq!(rule_total, 2);
        // /mine reflects the staged members.
        let (staged, archive, credit) = led.mine(ANON).unwrap();
        assert_eq!(staged.len(), 2);
        assert_eq!(archive, 100);
        assert_eq!(credit, 2);
    }

    #[test]
    fn later_calls_with_a_wrong_token_are_rejected() {
        let mut led = Ledger::new();
        let f = fx(ANON, TOKEN, vec![member(&"a".repeat(64))]);
        led.apply_claim(&f.input(), T0).unwrap();
        let wrong = fx(ANON, TOKEN2, f.members.clone());
        assert_eq!(
            led.evaluate_claim(&wrong.input()),
            Err(ClaimError::TokenMismatch)
        );
        let (known, matches) = led.token_state(ANON, &token_hash(TOKEN2));
        assert!(known && !matches);
        let (known, matches) = led.token_state(ANON, &token_hash(TOKEN));
        assert!(known && matches);
        let (known, _) = led.token_state(ANON2, &token_hash(TOKEN));
        assert!(!known);
    }

    #[test]
    fn claim_rejects_duplicates_from_anyone_and_unwanted() {
        let mut led = Ledger::new();
        let f = fx(ANON, TOKEN, vec![member(&"a".repeat(64))]);
        led.apply_claim(&f.input(), T0).unwrap();
        // Another contributor claiming the same hash → duplicate.
        let claim2 = fx(
            ANON2,
            TOKEN,
            vec![member(&"a".repeat(64)), member(&"e".repeat(64))],
        );
        assert_eq!(
            led.evaluate_claim(&claim2.input()),
            Err(ClaimError::Rejected(vec![RejectedMember {
                sha256: "a".repeat(64),
                verdict: Verdict::Duplicate,
            }]))
        );
        // No rules at all → unwanted (the known hash still duplicate).
        let mut no_rules = fx(
            ANON2,
            TOKEN,
            vec![member(&"a".repeat(64)), member(&"e".repeat(64))],
        );
        no_rules.rules = Vec::new();
        assert_eq!(
            led.evaluate_claim(&no_rules.input()),
            Err(ClaimError::Rejected(vec![
                RejectedMember {
                    sha256: "a".repeat(64),
                    verdict: Verdict::Duplicate,
                },
                RejectedMember {
                    sha256: "e".repeat(64),
                    verdict: Verdict::Unwanted,
                },
            ]))
        );
    }

    #[test]
    fn own_staged_members_reupload_without_new_credit() {
        let mut led = Ledger::new();
        let mut f = fx(ANON, TOKEN, vec![member(&"a".repeat(64))]);
        led.apply_claim(&f.input(), T0).unwrap();
        // Re-upload the same staged member: no rejection, no new credit,
        // rule counter unchanged, meta refreshed.
        f.archive_bytes = 120;
        let delta = led.apply_claim(&f.input(), T0 + 1).unwrap();
        assert_eq!(delta.accepted_count, 0);
        assert!(delta.plan.accepted.is_empty());
        assert_eq!(delta.plan.new_meta.credit_count, 1);
        assert_eq!(delta.plan.new_meta.archive_bytes, 120);
        assert_eq!(delta.plan.wm, 120, "blob replaced, not stacked");
        assert!(delta.plan.rule_totals.is_empty());
    }

    #[test]
    fn manifest_must_be_a_superset_of_staged() {
        let mut led = Ledger::new();
        let both = fx(
            ANON,
            TOKEN,
            vec![member(&"a".repeat(64)), member(&"b".repeat(64))],
        );
        led.apply_claim(&both.input(), T0).unwrap();
        // Dropping `b` from the archive: 422 dropped_members.
        let only_a = fx(ANON, TOKEN, vec![member(&"a".repeat(64))]);
        assert_eq!(
            led.evaluate_claim(&only_a.input()),
            Err(ClaimError::DroppedMembers(vec!["b".repeat(64)]))
        );
        // Drained members no longer bind the superset check — but the
        // drained hash itself is now a duplicate forever, so a fresh
        // claim needs fresh members.
        led.drain(&[ANON.to_string()], T0 + 2);
        assert_eq!(
            led.evaluate_claim(&only_a.input()),
            Err(ClaimError::Rejected(vec![RejectedMember {
                sha256: "a".repeat(64),
                verdict: Verdict::Duplicate,
            }]))
        );
        let fresh = fx(ANON, TOKEN, vec![member(&"c".repeat(64))]);
        assert!(led.evaluate_claim(&fresh.input()).is_ok());
    }

    #[test]
    fn watermark_delta_bounds_the_total() {
        let mut led = Ledger::new();
        // A first blob of 100 with the limit far away.
        let mut f = fx(ANON, TOKEN, vec![member(&"a".repeat(64))]);
        f.archive_bytes = 100;
        led.apply_claim(&f.input(), T0).unwrap();
        // A REPLACEMENT never trips the ceiling while it fits the limit
        // itself: the contributor's old blob bytes are released first
        // (and the manifest keeps the staged member — superset rule).
        let mut repl = fx(
            ANON,
            TOKEN,
            vec![member(&"a".repeat(64)), member(&"b".repeat(64))],
        );
        repl.archive_bytes = LIMIT_BYTES;
        let delta = led.apply_claim(&repl.input(), T0).unwrap();
        assert_eq!(delta.plan.wm, LIMIT_BYTES);
        // A FRESH contributor's member under the full watermark is
        // unwanted (the verdict gate runs before the delta check).
        let mut fresh = fx(ANON2, TOKEN, vec![member(&"c".repeat(64))]);
        fresh.archive_bytes = 100;
        assert_eq!(
            led.evaluate_claim(&fresh.input()),
            Err(ClaimError::Rejected(vec![RejectedMember {
                sha256: "c".repeat(64),
                verdict: Verdict::Unwanted,
            }]))
        );
        // The 503 itself: verdicts pass (own_staged re-upload), but the
        // blob delta would push the total over — others filled the tank.
        let full = Ledger::restore(
            vec![(
                "a".repeat(64),
                HashRow {
                    contributor: ANON.into(),
                    status: RowStatus::Staged,
                    rule_id: "r-all".into(),
                    size: 8_123_456,
                    file_name: "a.wowsreplay".into(),
                    at: T0,
                },
            )],
            vec![(ANON.to_string(), token_hash(TOKEN))],
            vec![(
                ANON.to_string(),
                ContributorMeta {
                    credited_name: "Player".into(),
                    realm: "asia".into(),
                    archive_bytes: 100,
                    credit_count: 1,
                    updated_at: T0,
                },
            )],
            vec![("r-all".into(), 1u64)],
            LIMIT_BYTES,
        );
        let mut bigger = fx(ANON, TOKEN, vec![member(&"a".repeat(64))]);
        bigger.archive_bytes = 200;
        assert_eq!(
            full.evaluate_claim(&bigger.input()),
            Err(ClaimError::Watermark)
        );
        // Headroom for exactly one small archive: 100 fits, filling it.
        let mut led2 = Ledger::restore([], [], [], [], LIMIT_BYTES - 100);
        let mut fits = fx(ANON, TOKEN, vec![member(&"d".repeat(64))]);
        fits.archive_bytes = 100;
        assert!(led2.apply_claim(&fits.input(), T0).is_ok());
        assert_eq!(led2.counters().0, LIMIT_BYTES);
    }

    #[test]
    fn rule_headroom_is_batch_aware() {
        let mut scarce = rule("scarce");
        scarce.max_count = Some(2);
        let mut led = Ledger::new();
        let mut three = fx(
            ANON,
            TOKEN,
            vec![
                member(&"a".repeat(64)),
                member(&"b".repeat(64)),
                member(&"c".repeat(64)),
            ],
        );
        three.rules = vec![scarce.clone()];
        assert_eq!(
            led.evaluate_claim(&three.input()),
            Err(ClaimError::Rejected(vec![RejectedMember {
                sha256: "c".repeat(64),
                verdict: Verdict::Unwanted,
            }])),
            "the third member finds the rule full"
        );
        let mut two = fx(
            ANON,
            TOKEN,
            vec![member(&"a".repeat(64)), member(&"b".repeat(64))],
        );
        two.rules = vec![scarce];
        let delta = led.apply_claim(&two.input(), T0).unwrap();
        assert_eq!(delta.plan.rule_totals.get("scarce"), Some(&2));
    }

    #[test]
    fn claim_updates_credit_name_and_realm() {
        let mut led = Ledger::new();
        let mut f = fx(ANON, TOKEN, vec![member(&"a".repeat(64))]);
        led.apply_claim(&f.input(), T0).unwrap();
        f.credited_name = "NewName";
        f.realm = "eu";
        led.apply_claim(&f.input(), T0 + 5).unwrap();
        let list = led.admin_list();
        assert_eq!(list[0].credited_name, "NewName");
        assert_eq!(list[0].realm, "eu");
        assert_eq!(list[0].updated_at, T0 + 5);
    }

    // ── ledger: drain ─────────────────────────────────────────────────

    #[test]
    fn drain_marks_drained_zeroes_blob_and_keeps_counters() {
        let mut led = Ledger::new();
        let mut f = fx(
            ANON,
            TOKEN,
            vec![member(&"a".repeat(64)), member(&"b".repeat(64))],
        );
        f.archive_bytes = 400;
        led.apply_claim(&f.input(), T0).unwrap();
        let delta = led.drain(&[ANON.to_string(), ANON2.to_string()], T0 + 9);
        assert_eq!(
            delta.drained,
            vec![ANON.to_string()],
            "unknown anon skipped"
        );
        assert_eq!(delta.bytes, 400);
        assert_eq!(delta.wm, 0);
        assert_eq!(delta.c_deletes.len(), 2);
        assert_eq!(delta.h_updates.len(), 2);
        assert!(
            delta
                .h_updates
                .iter()
                .all(|(_, r)| r.status == RowStatus::Drained)
        );
        // Rule counters survive (drain never reopens a rule).
        assert_eq!(led.counters().1, vec![("r-all".to_string(), 2)]);
        // /mine shows empty staged, zero blob, kept credit.
        let (staged, archive, credit) = led.mine(ANON).unwrap();
        assert!(staged.is_empty());
        assert_eq!(archive, 0);
        assert_eq!(credit, 2);
        // The drained hash is a duplicate for everyone, forever.
        let out = led.check(Some(ANON), &[facts(&"a".repeat(64))], &[rule("r-all")]);
        assert_eq!(out[0].verdict, Verdict::Duplicate);
        // The watermark reopened.
        assert!(led.watermark_accepting());
        // A fresh upload by the same contributor replaces their (deleted)
        // shard: the old blob bytes are no longer counted.
        let mut fresh = fx(ANON, TOKEN, vec![member(&"c".repeat(64))]);
        fresh.archive_bytes = 100;
        let delta = led.apply_claim(&fresh.input(), T0 + 10).unwrap();
        assert_eq!(delta.plan.wm, 100);
    }

    // ── admin list + counters + responses ─────────────────────────────

    #[test]
    fn admin_list_sorts_newest_first_with_staged_counts() {
        let mut led = Ledger::new();
        let a = fx(ANON, TOKEN, vec![member(&"a".repeat(64))]);
        led.apply_claim(&a.input(), 100).unwrap();
        let b = fx(ANON2, TOKEN, vec![member(&"b".repeat(64))]);
        led.apply_claim(&b.input(), 200).unwrap();
        let rows = led.admin_list();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].anon_id, ANON2, "newest activity first");
        assert_eq!(rows[0].staged_count, 1);
        assert_eq!(rows[0].archive_bytes, 100);
        let body = admin_list_response(&rows, led.counters().0);
        assert_eq!(body["contributors"][0]["stagedCount"], json!(1));
        assert_eq!(body["watermark"]["stagedBytes"], json!(200));
        assert_eq!(body["watermark"]["limitBytes"], json!(LIMIT_BYTES));
        assert_eq!(
            body["contributors"][1]["updatedAt"],
            json!(iso8601_utc(100))
        );
    }

    #[test]
    fn wanted_response_merges_live_counters_and_watermark() {
        let raw = r#"{ "rulesetVersion": 3, "updatedAt": "2026-10-14T00:00:00Z",
            "rules": [ { "id": "r1", "collected": 5, "maxCount": 10 },
                       { "id": "r2", "collected": 0 } ] }"#;
        let doc = parse_wanted_doc(raw).unwrap();
        let mut counters = HashMap::new();
        counters.insert("r1".to_string(), 7u64);
        let v = wanted_response(Some(&doc), 123, &counters);
        assert_eq!(v["rulesetVersion"], json!(3));
        assert_eq!(v["updatedAt"], json!("2026-10-14T00:00:00Z"));
        assert_eq!(v["watermark"]["stagedBytes"], json!(123));
        assert_eq!(v["watermark"]["limitBytes"], json!(8_589_934_592u64));
        assert!(v["watermark"]["accepting"].as_bool().unwrap());
        assert_eq!(v["rules"][0]["collected"], json!(7), "live counter wins");
        assert_eq!(
            v["rules"][1]["collected"],
            json!(0),
            "absent counter seeds 0"
        );
        // All rules closed → not accepting.
        let mut counters2 = HashMap::new();
        counters2.insert("r1".to_string(), 10u64);
        let r1_doc = WantedDoc {
            rules: vec![WantedRule {
                id: "r1".into(),
                collected: 5,
                max_count: Some(10),
                ..rule("r1")
            }],
            ..doc.clone()
        };
        let v = wanted_response(Some(&r1_doc), 0, &counters2);
        assert!(!v["watermark"]["accepting"].as_bool().unwrap());
        // Watermark full → not accepting.
        let v = wanted_response(Some(&doc), LIMIT_BYTES, &counters);
        assert!(!v["watermark"]["accepting"].as_bool().unwrap());
        // Closed collection (no doc): 200-shaped empty body.
        let v = wanted_response(None, 5, &counters);
        assert_eq!(v["rulesetVersion"], json!(0));
        assert_eq!(v["rules"], json!([]));
        assert!(v["updatedAt"].is_null());
        assert!(!v["watermark"]["accepting"].as_bool().unwrap());
        assert_eq!(v["watermark"]["stagedBytes"], json!(5));
    }

    #[test]
    fn mine_response_drops_the_internal_timestamp() {
        let staged = vec![StagedMember {
            sha256: "a".repeat(64),
            file_name: "f.wowsreplay".into(),
            size_bytes: 10,
            at: 7,
        }];
        let v = mine_response(&staged, 100, 3);
        assert_eq!(v["archiveBytes"], json!(100));
        assert_eq!(v["creditCount"], json!(3));
        assert_eq!(v["staged"][0]["sha256"], json!("a".repeat(64)));
        assert!(v["staged"][0].get("at").is_none());
    }

    // ── keys, quotas, iso8601 ─────────────────────────────────────────

    #[test]
    fn storage_and_rate_limit_keys_follow_the_layout() {
        assert_eq!(h_key("abc"), "h:abc");
        assert_eq!(c_key(ANON, "abc"), format!("c:{ANON}:abc"));
        assert_eq!(tok_key(ANON), format!("tok:{ANON}"));
        assert_eq!(meta_key(ANON), format!("meta:{ANON}"));
        assert_eq!(rule_key("r1"), "rule:r1");
        assert_eq!(WM_KEY, "wm");
        assert_eq!(shard_key(ANON), format!("shards/{ANON}.tar.zstd"));
        assert_eq!(KV_WANTED_KEY, "replays:wanted");

        let day = 20_000;
        let keys = rl_upload_keys(ANON, "198.51.100.7", day);
        assert_eq!(
            keys,
            vec![
                (
                    format!("replays:rl:up:a:{ANON}:{day}"),
                    QUOTA_UPLOADS_PER_ANON_DAY
                ),
                (
                    format!("replays:rl:up:i:198.51.100.7:{day}"),
                    QUOTA_UPLOADS_PER_IP_DAY
                ),
            ]
        );
        assert_eq!(
            rl_archive_key(ANON, day),
            (
                format!("replays:rl:arch:{ANON}:{day}"),
                QUOTA_ARCHIVE_FETCHES_DAY
            )
        );
        assert_eq!(
            rl_check_key("198.51.100.7", day),
            (
                format!("replays:rl:chk:198.51.100.7:{day}"),
                QUOTA_CHECKS_PER_IP_DAY
            )
        );
        assert_eq!(QUOTA_UPLOADS_PER_ANON_DAY, 8);
        assert_eq!(QUOTA_UPLOADS_PER_IP_DAY, 24);
        assert_eq!(QUOTA_ARCHIVE_FETCHES_DAY, 20);
        assert_eq!(QUOTA_CHECKS_PER_IP_DAY, 60);
    }

    #[test]
    fn day_bucket_and_retry_after_math() {
        let day_ms = 86_400_000i64;
        assert_eq!(day_bucket(0), 0);
        assert_eq!(day_bucket(day_ms - 1), 0);
        assert_eq!(day_bucket(day_ms), 1);
        assert_eq!(day_retry_after_secs(0), 86_400);
        assert_eq!(day_retry_after_secs(day_ms - 2_500), 3, "rounded up");
        assert_eq!(day_retry_after_secs(day_ms - 1), 1);
    }

    #[test]
    fn iso8601_formatting_matches_reference_dates() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(86_400_000), "1970-01-02T00:00:00Z");
        assert_eq!(
            iso8601_utc(951_782_400_000),
            "2000-02-29T00:00:00Z",
            "leap day"
        );
        assert_eq!(iso8601_utc(1_791_936_000_000), "2026-10-14T00:00:00Z");
        assert_eq!(iso8601_utc(1_791_936_000_001), "2026-10-14T00:00:00Z");
        assert_eq!(iso8601_utc(1_792_022_399_000), "2026-10-14T23:59:59Z");
        assert_eq!(iso8601_utc(1_792_022_400_000), "2026-10-15T00:00:00Z");
        // Century boundary (2100 is NOT a leap year).
        assert_eq!(iso8601_utc(4_102_444_800_000), "2100-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(4_102_444_799_000), "2099-12-31T23:59:59Z");
    }
}
