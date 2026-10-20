//! afdian（爱发电）sponsor-list policy for the credits page's bottom
//! group. The worker's daily cron pulls the creator's sponsor and order
//! history through afdian's open API (query-sponsor + query-order, md5
//! signed), reduces it here to one small public document, and caches it
//! in KV; `GET /api/sponsors` then serves that document verbatim.
//!
//! What the document carries — and deliberately does NOT:
//!
//!   - sums come from PAID orders only (`status == 2`, by `show_amount`,
//!     the actually-charged figure), not from the profile's
//!     `all_sum_amount` (which counts virtual / redeem money too);
//!   - order remarks never leave this module: the only thing kept is a
//!     remark-shaped GAME ID (see [`parse_game_id`]) — the sponsor flow
//!     asks for it in the remark — while addresses and free text are
//!     dropped at the boundary;
//!   - ordering puts current-month paid amount first (当月赞助较多的更
//!     靠前), then all-time paid amount, then earliest first payment —
//!     active monthly sponsors stay on top, one-off big totals follow.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::HashSet;

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

/// KV key of the cached document (FEEDBACK_KV namespace — one namespace,
/// disjoint key domains shared with the feedback / qqbot / replay slots).
pub const KV_KEY: &str = "sponsors:afdian";

/// One row of the public document (served verbatim by `/api/sponsors`
/// and mirrored by the app's DTO — camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SponsorEntry {
    pub user_id: String,
    pub name: String,
    pub avatar: Option<String>,
    /// All-time actually-charged total, CNY (paid orders only).
    pub all_sum: f64,
    /// Actually-charged total inside the current calendar month (UTC+8).
    pub month_sum: f64,
    /// A monthly plan was live at poll time (`current_plan.expire_time`
    /// still in the future).
    pub active: bool,
    /// Unix seconds, straight from query-sponsor.
    pub first_pay: i64,
    pub last_pay: i64,
    /// Game ID recognized in one of the sponsor's order remarks.
    /// DORMANT: still parsed and served, but the UI's chip-to-lookup
    /// jump is parked (free-text remarks misparse too often); keep the
    /// field so re-enabling needs no wire change. None when no remark
    /// carried one.
    pub game_id: Option<String>,
}

/// The cached + served document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SponsorsDoc {
    /// Unix seconds of the poll that produced this document.
    pub updated_at: i64,
    pub sponsors: Vec<SponsorEntry>,
}

/// Light sanity gate on a stored document (the digests pattern): refuse
/// loudly on corruption or tampering instead of serving garbage.
pub fn doc_is_sane(doc: &SponsorsDoc) -> bool {
    doc.updated_at >= 0
        && doc.sponsors.len() <= 10_000
        && doc.sponsors.iter().all(|s| {
            !s.name.trim().is_empty()
                && !s.user_id.is_empty()
                && s.all_sum.is_finite()
                && s.all_sum >= 0.0
                && s.month_sum.is_finite()
                && s.month_sum >= 0.0
                && s.game_id.as_deref().is_none_or(game_id_plausible)
        })
}

/// The same nickname alphabet [`parse_game_id`] whitelists — a stored
/// game id must still read as one, or the document was tampered with.
fn game_id_plausible(id: &str) -> bool {
    (2..=24).contains(&id.chars().count())
        && id
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

// ── open-API request signing ─────────────────────────────────────────────

/// md5 hex digest of one string (the sign primitive, exposed for the
/// unit test's known vector).
fn md5_hex(input: &str) -> String {
    format!("{:x}", Md5::digest(input.as_bytes()))
}

/// The open-API signature: `md5(token + "params" + params + "ts" + ts +
/// "user_id" + user_id)`, hex — per the afdian developer doc. The token
/// itself is only ever concatenated here, never serialized into any
/// request field.
pub fn sign(token: &str, params_json: &str, ts: i64, user_id: &str) -> String {
    let payload = format!("{token}params{params_json}ts{ts}user_id{user_id}");
    md5_hex(&payload)
}

/// Page params (the JSON *string* the API expects in `params`).
/// `per_page` 100 is the documented maximum for both paginated calls.
pub fn page_params(page: u32, per_page: u32) -> String {
    serde_json::json!({ "page": page, "per_page": per_page }).to_string()
}

/// The full request body for one open-API call:
/// `{"user_id","params":"<json>","ts","sign"}`.
pub fn call_body(token: &str, user_id: &str, ts: i64, params_json: &str) -> String {
    serde_json::json!({
        "user_id": user_id,
        "params": params_json,
        "ts": ts,
        "sign": sign(token, params_json, ts, user_id),
    })
    .to_string()
}

// ── raw API rows (only the fields used; unknown fields ignored) ─────────

/// One query-sponsor row.
#[derive(Debug, Clone, Deserialize)]
pub struct SponsorRecord {
    pub user: SponsorUser,
    pub current_plan: Option<SponsorPlan>,
    #[serde(default)]
    pub first_pay_time: i64,
    #[serde(default)]
    pub last_pay_time: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SponsorUser {
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SponsorPlan {
    #[serde(default)]
    pub expire_time: i64,
}

/// One query-order row.
#[derive(Debug, Clone, Deserialize)]
pub struct OrderRecord {
    /// Order id — the dedup key: a page drift while paginating (a new
    /// order landing mid-poll shifts rows across page boundaries) can
    /// serve the same order twice.
    #[serde(default)]
    pub out_trade_no: String,
    #[serde(default)]
    pub user_id: String,
    /// Decimal string, CNY ("10.00").
    #[serde(default)]
    pub show_amount: String,
    /// 2 = paid. Unpaid rows never appear in query-order results, but
    /// refunds / chargebacks flip the status away from 2 — the guard is
    /// what keeps refunded money out of both sums.
    #[serde(default)]
    pub status: i64,
    #[serde(default)]
    pub create_time: i64,
    #[serde(default)]
    pub remark: String,
}

// ── calendar-month bucketing on Beijing time ────────────────────────────

const DAY_SECS: i64 = 86_400;
/// afdian is a CNY platform: the "current month" of the ranking buckets
/// on Beijing time.
const CST_OFFSET_SECS: i64 = 8 * 3_600;

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's
/// `civil_from_days` — the ~10 lines chrono would otherwise be pulled
/// in for. Valid for the whole unix-second range the API can return.
fn civil_from_days(days: i64) -> (i64, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + i64::from(m <= 2), m as u32)
}

/// (year, month) of a unix timestamp on Beijing time. Pure.
fn cst_month(secs: i64) -> (i64, u32) {
    civil_from_days((secs + CST_OFFSET_SECS).div_euclid(DAY_SECS))
}

// ── remark → game ID ────────────────────────────────────────────────────

/// Recognize a game ID in an order remark. The sponsor flow asks for
/// the in-game ID in the remark, in practice as "游戏ID：xxx", "id xxx"
/// or the bare name; anything with leftover whitespace or other loose
/// text (a sentence, an address) is NOT an ID and answers None. Pure
/// and unit-tested.
pub fn parse_game_id(remark: &str) -> Option<String> {
    let trimmed = remark.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Prefix matching runs on the ascii-lowercased copy (byte length is
    // preserved), so the byte offset transfers back to the original.
    let lower = trimmed.to_ascii_lowercase();
    const PREFIXES: &[&str] = &[
        "游戏昵称", "游戏名字", "游戏id", "游戏名", "昵称", "名字", "id",
    ];
    const SEPARATORS: [char; 8] = [':', '：', ',', '，', '-', '—', ' ', '\t'];
    let after_prefix = PREFIXES.iter().find_map(|p| lower.strip_prefix(p));
    let rest = match after_prefix {
        // A prefix only counts when a separator follows it ("id: xxx",
        // "游戏ID xxx") — a remark that merely starts with those letters
        // ("Ideas") is taken as a bare name instead of being fragmented.
        Some(tail) if tail.starts_with(SEPARATORS) => {
            trimmed[trimmed.len() - tail.len()..].trim_start_matches(SEPARATORS)
        },
        _ => trimmed,
    };
    let chars = rest.chars().count();
    if !(2..=24).contains(&chars) {
        return None;
    }
    // Whitelist of a WoWS nickname's alphabet: unicode letters/digits
    // plus `_ - .`. Anything looser (whitespace, CJK punctuation, emoji,
    // symbols) means the remark was free text, not a name.
    if !rest
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return None;
    }
    Some(rest.to_string())
}

// ── the reduction ───────────────────────────────────────────────────────

/// Order-accumulator while folding the order list.
#[derive(Default)]
struct OrderAcc {
    all_sum: f64,
    month_sum: f64,
    game_id: Option<String>,
    game_id_time: i64,
}

/// Round to the cent so repeated polling never produces float-noise
/// diffs (which would defeat the worker's write-only-on-change check).
fn cents(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Reduce the raw sponsor + order rows into the public document, sorted
/// by (current-month paid desc, all-time paid desc, first payment asc).
/// Pure and unit-tested.
pub fn build_doc(now_sec: i64, sponsors: &[SponsorRecord], orders: &[OrderRecord]) -> SponsorsDoc {
    let month = cst_month(now_sec);
    let mut acc: HashMap<&str, OrderAcc> = HashMap::new();
    let mut seen_orders: HashSet<&str> = HashSet::new();
    for order in orders {
        if order.status != 2 || order.user_id.is_empty() {
            continue;
        }
        // A page drift while paginating can serve one order twice —
        // rows without an id (never seen from the real API) stay
        // individually counted rather than collapsing into one.
        if !order.out_trade_no.is_empty()
            && !seen_orders.insert(order.out_trade_no.as_str())
        {
            continue;
        }
        let amount = order
            .show_amount
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0);
        let entry = acc.entry(order.user_id.as_str()).or_default();
        entry.all_sum += amount;
        if cst_month(order.create_time) == month {
            entry.month_sum += amount;
        }
        // Latest parseable remark wins — a corrected ID in a newer order
        // must override an older one.
        if let Some(id) = parse_game_id(&order.remark) {
            if order.create_time >= entry.game_id_time {
                entry.game_id = Some(id);
                entry.game_id_time = order.create_time;
            }
        }
    }

    let mut entries: Vec<SponsorEntry> = sponsors
        .iter()
        .filter_map(|s| {
            let name = s.user.name.trim();
            if name.is_empty() || s.user.user_id.is_empty() {
                return None;
            }
            let acc = acc.get(s.user.user_id.as_str());
            Some(SponsorEntry {
                user_id: s.user.user_id.clone(),
                name: name.to_string(),
                avatar: s
                    .user
                    .avatar
                    .clone()
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty()),
                all_sum: cents(acc.map(|a| a.all_sum).unwrap_or(0.0)),
                month_sum: cents(acc.map(|a| a.month_sum).unwrap_or(0.0)),
                active: s
                    .current_plan
                    .as_ref()
                    .is_some_and(|p| p.expire_time > now_sec),
                first_pay: s.first_pay_time,
                last_pay: s.last_pay_time,
                game_id: acc.and_then(|a| a.game_id.clone()),
            })
        })
        .collect();

    entries.sort_by(|x, y| {
        y.month_sum
            .partial_cmp(&x.month_sum)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                y.all_sum
                    .partial_cmp(&x.all_sum)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| x.first_pay.cmp(&y.first_pay))
            .then_with(|| x.user_id.cmp(&y.user_id))
    });

    SponsorsDoc {
        updated_at: now_sec,
        sponsors: entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-01 00:00:00 CST == 2026-09-30T16:00:00Z.
    const CST_OCT_1_2026: i64 = 1_790_784_000;
    /// Comfortably inside October 2026 (Beijing) for "now".
    const NOW: i64 = CST_OCT_1_2026 + 20 * 86_400;

    #[test]
    fn md5_matches_the_known_vector() {
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
        let s = sign("token", "{\"page\":1}", 60, "user");
        assert_eq!(s.len(), 32);
        assert!(s.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn call_body_carries_the_signed_envelope() {
        let body = call_body("t", "u", 60, "{\"page\":1}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["user_id"], "u");
        assert_eq!(v["params"], "{\"page\":1}");
        assert_eq!(v["ts"], 60);
        assert_eq!(v["sign"], sign("t", "{\"page\":1}", 60, "u"));
    }

    #[test]
    fn cst_month_buckets_on_beijing_time() {
        assert_eq!(cst_month(0), (1970, 1));
        // 1970-02-01T00:00:00 CST == 1970-01-31T16:00:00Z.
        let feb_1_cst = 31 * 86_400 - 8 * 3_600;
        assert_eq!(cst_month(feb_1_cst - 1), (1970, 1));
        assert_eq!(cst_month(feb_1_cst), (1970, 2));
        // The API sample's create_time landed in October 2026 Beijing.
        assert_eq!(cst_month(NOW), (2026, 10));
    }

    #[test]
    fn game_id_prefixes_and_noise_are_classified() {
        assert_eq!(parse_game_id("游戏ID：猪肉咖喱"), Some("猪肉咖喱".into()));
        assert_eq!(parse_game_id("id: SomePlayer_01"), Some("SomePlayer_01".into()));
        assert_eq!(parse_game_id("游戏名 拿破仑蟹"), Some("拿破仑蟹".into()));
        assert_eq!(parse_game_id("PlainName42"), Some("PlainName42".into()));
        // A prefix only counts when a separator follows: "Ideas" is a
        // bare name, not the prefix "id" plus "eas".
        assert_eq!(parse_game_id("Ideas"), Some("Ideas".into()));
        assert_eq!(parse_game_id(""), None);
        assert_eq!(parse_game_id("x"), None, "single char is not an ID");
        assert_eq!(
            parse_game_id("祝项目越做越好，加油！"),
            None,
            "free-text blessings are not IDs"
        );
        assert_eq!(
            parse_game_id("Some Player 01"),
            None,
            "leftover whitespace means loose text"
        );
        let long = "a".repeat(25);
        assert_eq!(parse_game_id(&long), None, "over 24 chars is not a name");
        let addr = "北京市朝阳区某某街道 1 号 13800000000";
        assert_eq!(parse_game_id(addr), None);
    }

    fn sponsor(uid: &str, name: &str, expire: i64, first: i64) -> SponsorRecord {
        SponsorRecord {
            user: SponsorUser {
                user_id: uid.into(),
                name: name.into(),
                avatar: Some("https://pic1.afdiancdn.com/a.png".into()),
            },
            current_plan: (expire > 0).then(|| SponsorPlan { expire_time: expire }),
            first_pay_time: first,
            last_pay_time: first,
        }
    }

    fn order(id: &str, uid: &str, amount: &str, at: i64, remark: &str) -> OrderRecord {
        OrderRecord {
            out_trade_no: id.into(),
            user_id: uid.into(),
            show_amount: amount.into(),
            status: 2,
            create_time: at,
            remark: remark.into(),
        }
    }

    #[test]
    fn build_doc_orders_by_month_then_all_time() {
        let sponsors = [
            sponsor("big", "BigTotal", 0, 100),
            sponsor("monthly", "MonthlyActive", NOW + 100, 200),
            sponsor("anon", "", 0, 50), // empty name dropped
        ];
        let sept = CST_OCT_1_2026 - 86_400; // still September 2026 CST
        let orders = [
            order("o1", "big", "500.00", 1_000, ""),
            order("o2", "monthly", "50.00", CST_OCT_1_2026 + 100, "游戏ID：月票猪"),
            // refunded row: counted by neither sum
            OrderRecord {
                out_trade_no: "o3".into(),
                user_id: "big".into(),
                show_amount: "99.00".into(),
                status: 4,
                create_time: NOW,
                remark: String::new(),
            },
            // September payment only lifts all_sum, not month_sum
            order("o4", "monthly", "10.00", sept, ""),
        ];
        let doc = build_doc(NOW, &sponsors, &orders);
        assert_eq!(doc.sponsors.len(), 2);
        // The active monthly sponsor leads despite the smaller total.
        assert_eq!(doc.sponsors[0].name, "MonthlyActive");
        assert_eq!(doc.sponsors[0].month_sum, 50.0);
        assert_eq!(doc.sponsors[0].all_sum, 60.0);
        assert!(doc.sponsors[0].active);
        assert_eq!(doc.sponsors[0].game_id.as_deref(), Some("月票猪"));
        assert_eq!(doc.sponsors[1].name, "BigTotal");
        assert_eq!(doc.sponsors[1].all_sum, 500.0);
        assert_eq!(doc.sponsors[1].month_sum, 0.0);
        assert!(!doc.sponsors[1].active);
        assert_eq!(doc.sponsors[1].game_id, None);
    }

    #[test]
    fn build_doc_latest_remark_wins_and_avatar_blank_drops() {
        let sponsors = [
            sponsor("u1", "老观众", 0, 10),
            sponsor("u2", "  ", 0, 10), // whitespace-only name dropped
        ];
        let orders = [
            order("o1", "u1", "5.00", 100, "游戏ID：旧名字"),
            order("o2", "u1", "5.00", 200, "游戏ID：新名字"),
        ];
        let doc = build_doc(NOW, &sponsors, &orders);
        assert_eq!(doc.sponsors.len(), 1);
        assert_eq!(doc.sponsors[0].game_id.as_deref(), Some("新名字"));
    }

    #[test]
    fn duplicate_order_ids_count_once() {
        // Page drift while paginating can serve one order twice — the
        // row must enter the sums exactly once.
        let sponsors = [sponsor("u1", "重复受害者", 0, 1)];
        let orders = [
            order("same-id", "u1", "50.00", NOW, ""),
            order("same-id", "u1", "50.00", NOW, ""),
        ];
        let doc = build_doc(NOW, &sponsors, &orders);
        assert_eq!(doc.sponsors[0].all_sum, 50.0);
        // Rows without an id never collapse (the real API always sends
        // one, but an empty id must not dedup unrelated rows).
        let no_ids = [
            order("", "u1", "5.00", NOW, ""),
            order("", "u1", "5.00", NOW, ""),
        ];
        let doc = build_doc(NOW, &sponsors, &no_ids);
        assert_eq!(doc.sponsors[0].all_sum, 10.0);
    }

    #[test]
    fn doc_sanity_gate_refuses_garbage() {
        let good = build_doc(NOW, &[sponsor("u", "n", 0, 1)], &[]);
        assert!(doc_is_sane(&good));
        let mut bad = good.clone();
        bad.sponsors[0].all_sum = -1.0;
        assert!(!doc_is_sane(&bad));
        let mut empty_name = good.clone();
        empty_name.sponsors[0].name = " ".into();
        assert!(!doc_is_sane(&empty_name));
        let mut junk_id = good.clone();
        junk_id.sponsors[0].game_id = Some("not an id!".into());
        assert!(!doc_is_sane(&junk_id));
        let mut neg_time = good;
        neg_time.updated_at = -1;
        assert!(!doc_is_sane(&neg_time));
    }
}
