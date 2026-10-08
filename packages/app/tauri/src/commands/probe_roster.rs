//! Lesta live-roster synthesis off the in-game probe's `roster_raw.json`.
//!
//! The Lesta (Мир кораблей) client's `tempArenaInfo.json` carries battle
//! METADATA only — no `vehicles` array (verified on a real 2026-10-08
//! capture: 1008 bytes, `playerName`/`matchGroup`/`mapId` and nothing
//! else; the roster lands only in the FINISHED replay's block 1, which
//! never exists mid-battle). Every WG-family client writes the full
//! roster into the arena file, so the app's whole live pipeline (battle
//! panel, Tab overlay chips, sink solver) keys on `vehicles` — and reads
//! zero on Lesta.
//!
//! The one component that sees the live roster inside a Lesta battle is
//! the WoWSPProbe mod (`ingame_plugin.rs` installs it into every
//! client): its per-tick `observe_raw` projects every
//! `battle.getPlayersInfo()` record into `roster_raw.json` next to the
//! mod's `Main.py`. This module turns that file into the `vehicles` the
//! arena pipeline expects, so a Lesta battle behaves like any other
//! client's the moment the probe warms up (a few seconds into the
//! battle).
//!
//! Parsing is deliberately defensive: the probe writes each record either
//! as a FULL JSON object (when the sandbox encoder accepts the record)
//! or as its guessed-field projection with every value STRINGIFIED
//! (`{"teamId": "1", "isBot": "False", …}` — see `project_record`). Both
//! shapes parse through the same accessors here, and any surprise
//! (missing file, stale file, unreadable fields, no way to split sides)
//! yields `None` — the caller keeps the empty roster rather than a
//! guessed one.

use std::path::Path;
use std::time::SystemTime;

use wowsp_tauri_shared::VehicleEntry;

/// The probe's runtime file, written a few seconds into every battle and
/// cleared when the probe's session ends (`players: {}` on quit — a stale
/// file reads empty, which this module naturally rejects).
const ROSTER_RAW_FILE: &str = "roster_raw.json";

/// The probe's mod directory inside an install's `res_mods` (mirrors
/// `ingame_plugin.rs`'s `MOD_DIR` layout).
const PROBE_MOD_DIR: &str = "PnFMods/WoWSPProbe";

/// Synthesize the battle's `vehicles` for an arena file that parsed with
/// ZERO vehicles (the Lesta shape). `arena_path` is the tempArenaInfo.json
/// that was just read — its mtime anchors the freshness gate (a probe file
/// older than the battle is a previous battle's and must not leak in) and
/// its install must be the one the probe dir resolved under (the running
/// client; an env-pinned replay dir answering for another install skips
/// synthesis rather than mixing clients). `player_name` is the arena
/// file's own `playerName` — the SELF anchor for the team split.
///
/// `None` = no usable roster right now (nothing installed, probe still
/// warming up, unreadable shape, or no side split derivable). The caller
/// retries on its next refresh; an empty roster never fabricates rows.
pub(crate) fn synthesize_for_arena(
    arena_path: &Path,
    player_name: Option<&str>,
) -> Option<Vec<VehicleEntry>> {
    // One resolve serves both the probe dir and the same-install guard
    // (resolve_root takes a process snapshot — not twice per read).
    let ctx =
        super::game_context::resolve_root(super::game_context::RootPreference::PreferRunning)?;
    // Same-install guard: the arena file must live under the resolved
    // root's replays dir (both sides resolve PreferRunning in production;
    // an env pin pointing elsewhere reads another install's battles).
    if !arena_path.starts_with(super::game_context::replays_dir(&ctx.root)) {
        return None;
    }
    let res_mods = super::game_context::res_mods_dir(&ctx.root).ok()?;
    let roster_path = res_mods.join(PROBE_MOD_DIR).join(ROSTER_RAW_FILE);
    let roster_mtime = roster_path.metadata().and_then(|m| m.modified()).ok()?;
    let arena_mtime = arena_path.metadata().and_then(|m| m.modified()).ok()?;
    if !roster_is_fresh(roster_mtime, arena_mtime) {
        return None;
    }
    let bytes = std::fs::read(&roster_path).ok()?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    parse_roster_raw(&raw, player_name)
}

/// Pure core: map one `roster_raw.json` document onto `vehicles`.
///
/// Bots STAY in the roster (`:Name:` rows and `isBot` records alike):
/// the WG-family arena file carries them too — they hold table rows and
/// team sizes in co-op exactly like humans, and the consumers (grid hint,
/// row mapping, bot-fold labels) already key on the `:…:` convention.
pub(crate) fn parse_roster_raw(
    raw: &serde_json::Value,
    player_name: Option<&str>,
) -> Option<Vec<VehicleEntry>> {
    let players = raw.get("players")?.as_object()?;
    // Pass 1 — materialize every row we can name.
    struct Row {
        name: String,
        id: i64,
        ship_id: i64,
        team: Option<i64>,
        relation: Option<i64>,
    }
    let mut rows: Vec<Row> = Vec::new();
    for value in players.values() {
        // The probe's full-encode shape DOUBLE-ENCODES each record —
        // `project_record` stores `str(jsonEncode(record))[:1200]`, a
        // STRING — while its SafeClass fallback writes a plain object.
        // Accept both; one weird row (non-object, nameless, or a record
        // whose 1200-char cut broke the embedded JSON) skips that row,
        // never the whole roster.
        let record: serde_json::Map<String, serde_json::Value> = match value {
            serde_json::Value::String(s) => match serde_json::from_str::<serde_json::Value>(s) {
                Ok(serde_json::Value::Object(map)) => map,
                _ => continue,
            },
            other => match other.as_object() {
                Some(map) => map.clone(),
                None => continue,
            },
        };
        let Some(name) = record.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let name = name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let id = int_field(&record, &["accountDBID", "id"]).unwrap_or(0);
        rows.push(Row {
            name,
            // WG-family bots carry negative ids in the arena file; the
            // probe's bot records read 0 — give them a stable negative
            // placeholder off their position.
            id: if id == 0 && truthy(&record, "isBot") {
                -(rows.len() as i64 + 1)
            } else {
                id
            },
            ship_id: int_field(&record, &["shipParamsId", "shipId", "vehicleId"]).unwrap_or(0),
            team: int_field(&record, &["teamId"]),
            relation: int_field(&record, &["relation"]).filter(|r| (0..=2).contains(r)),
        });
    }
    if rows.len() < 2 {
        return None;
    }
    // Pass 2 — relation per row: an explicit probe relation wins; the rest
    // split around the SELF row (the arena file's playerName) by teamId.
    // A roster we cannot split at all yields None — the pipeline prefers
    // its empty-roster retry over a one-sided guess.
    let self_team: Option<i64> = player_name.and_then(|self_name| {
        rows.iter()
            .find(|r| player_name_is(r.name.as_str(), Some(self_name)))
            .and_then(|r| r.team)
    });
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let relation = match row.relation {
            Some(r) => r,
            None => {
                let team = row.team?;
                let self_team = self_team?;
                if player_name_is(row.name.as_str(), player_name) {
                    0
                } else if team == self_team {
                    1
                } else {
                    2
                }
            },
        };
        out.push(VehicleEntry {
            id: row.id,
            name: row.name,
            relation,
            ship_id: row.ship_id,
            ship_name: None,
        });
    }
    out.sort_by(|a, b| (&a.name, a.id).cmp(&(&b.name, b.id)));
    Some(out)
}

/// `player_name` equality with the probe's clan-tag tolerance: avatar
/// names may carry a `[TAG]` prefix the arena file's bare name lacks.
fn player_name_is(row_name: &str, player_name: Option<&str>) -> bool {
    let Some(player_name) = player_name else {
        return false;
    };
    let bare = row_name.split_once(']').map_or(row_name, |(_, rest)| rest);
    bare == player_name
}

/// Numeric field read that tolerates BOTH probe shapes: a JSON number, or
/// the guessed projection's stringified number (`"123"`). First key that
/// parses wins.
fn int_field(record: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        let value = record.get(*key)?;
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

/// Boolean-ish field read across both shapes: JSON booleans, or the
/// stringified `"True"`/`"true"`/`"1"` (Python 2's `str(True)`).
fn truthy(record: &serde_json::Map<String, serde_json::Value>, key: &str) -> bool {
    match record.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64().is_some_and(|v| v != 0),
        Some(serde_json::Value::String(s)) => {
            matches!(s.trim(), "True" | "true" | "1" | "TRUE")
        },
        _ => false,
    }
}

/// `roster_mtime + 5s < arena_mtime` freshness gate as a pure function
/// (unit-tested; the file paths share the same clock). The probe writes
/// only DURING a battle, so its file is never meaningfully older than the
/// battle's own arena file (the 5 s slack absorbs coarse filesystem
/// stamps); a previous battle's leftover fails this — and reads empty
/// anyway, because the probe clears its file on quit.
pub(crate) fn roster_is_fresh(roster_mtime: SystemTime, arena_mtime: SystemTime) -> bool {
    !(roster_mtime + std::time::Duration::from_secs(5) < arena_mtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_full(name: &str, id: i64, team: i64, ship: i64) -> serde_json::Value {
        serde_json::json!({
            "name": name, "accountDBID": id, "teamId": team,
            "shipParamsId": ship, "isBot": false, "realm": "RU",
        })
    }

    fn record_guess(name: &str, id: i64, team: i64, ship: i64, bot: &str) -> serde_json::Value {
        // The SafeClass fallback projection: every value stringified.
        serde_json::json!({
            "name": name, "accountDBID": id.to_string(), "teamId": team.to_string(),
            "shipParamsId": ship.to_string(), "isBot": bot,
        })
    }

    /// The probe's FULL-ENCODE shape: `project_record` stores each record
    /// as `str(jsonEncode(record))[:1200]` — a DOUBLE-ENCODED string.
    fn record_encoded(name: &str, id: i64, team: i64, ship: i64) -> serde_json::Value {
        serde_json::Value::String(
            serde_json::to_string(&record_full(name, id, team, ship)).unwrap(),
        )
    }

    fn doc(players: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "t": 1_791_434_798i64, "players": players, "states": {} })
    }

    #[test]
    fn parses_full_encode_shape_with_team_split() {
        let raw = doc(serde_json::json!({
            "1": record_full("langyo", 310271049, 1, 418_000_001),
            "2": record_full("AllyOne", 111, 1, 418_000_002),
            "3": record_full("EnemyOne", 222, 2, 418_000_003),
            "4": record_full(":FS1:", 0, 2, 418_000_004),
        }));
        let vehicles = parse_roster_raw(&raw, Some("langyo")).expect("roster synthesizes");
        // Bots STAY — they hold table rows and team sizes exactly like the
        // WG-family arena file's `:Name:` entries.
        assert_eq!(vehicles.len(), 4);
        let by_name = |n: &str| vehicles.iter().find(|v| v.name == n).unwrap();
        assert_eq!(by_name("langyo").relation, 0);
        assert_eq!(by_name("langyo").id, 310271049);
        assert_eq!(by_name("AllyOne").relation, 1);
        assert_eq!(by_name("EnemyOne").relation, 2);
        assert_eq!(by_name("EnemyOne").ship_id, 418_000_003);
        assert_eq!(by_name(":FS1:").relation, 2);
    }

    #[test]
    fn parses_stringified_guess_projection() {
        let raw = doc(serde_json::json!({
            "7": record_guess("[TAG]Someone", 42, 1, 5, "False"),
            "8": record_guess("Foe", 43, 2, 6, "False"),
            "9": record_guess("Bot", 0, 2, 7, "True"),
        }));
        // The arena file's playerName is the BARE nickname; the probe's
        // avatar names may carry a clan tag the self match must strip.
        let vehicles = parse_roster_raw(&raw, Some("Someone")).expect("guess shape synthesizes");
        assert_eq!(vehicles.len(), 3);
        let tagged = vehicles.iter().find(|v| v.id == 42).unwrap();
        assert_eq!(
            tagged.relation, 0,
            "clan-tagged row name matches the bare self"
        );
        assert_eq!(tagged.ship_id, 5);
        assert_eq!(
            vehicles.iter().find(|v| v.name == "Foe").unwrap().relation,
            2
        );
        // A zero-DBID bot record gets a stable NEGATIVE placeholder id —
        // the WG-family arena convention for bots.
        let bot = vehicles.iter().find(|v| v.name == "Bot").unwrap();
        assert_eq!(bot.relation, 2);
        assert!(bot.id < 0, "bot placeholder id is negative: {}", bot.id);
    }

    #[test]
    fn parses_double_encoded_full_encode_shape() {
        let raw = doc(serde_json::json!({
            "1": record_encoded("langyo", 310271049, 1, 418_000_001),
            "2": record_encoded("AllyOne", 111, 1, 418_000_002),
            "3": record_encoded("EnemyOne", 222, 2, 418_000_003),
        }));
        let vehicles =
            parse_roster_raw(&raw, Some("langyo")).expect("encoded-string records synthesize");
        assert_eq!(vehicles.len(), 3);
        assert_eq!(
            vehicles
                .iter()
                .find(|v| v.name == "langyo")
                .unwrap()
                .relation,
            0
        );
        assert_eq!(
            vehicles
                .iter()
                .find(|v| v.name == "EnemyOne")
                .unwrap()
                .relation,
            2
        );
    }

    #[test]
    fn truncated_encoded_record_skips_instead_of_failing_the_roster() {
        // The 1200-char cut can break the embedded JSON mid-string: that
        // ONE record skips, the roster still synthesizes.
        let mut truncated = match record_encoded("Huge", 5, 1, 9) {
            serde_json::Value::String(s) => s,
            _ => unreachable!(),
        };
        truncated.truncate(truncated.len().saturating_sub(20));
        let raw = doc(serde_json::json!({
            "1": record_encoded("langyo", 310271049, 1, 418_000_001),
            "2": record_encoded("AllyOne", 111, 1, 418_000_002),
            "3": serde_json::Value::String(truncated),
        }));
        let vehicles =
            parse_roster_raw(&raw, Some("langyo")).expect("roster survives one broken record");
        assert_eq!(vehicles.len(), 2);
        assert!(vehicles.iter().all(|v| v.name != "Huge"));
    }

    #[test]
    fn explicit_relation_field_wins_without_a_self() {
        let raw = doc(serde_json::json!({
            "1": serde_json::json!({
                "name": "A", "accountDBID": 1, "shipParamsId": 9, "relation": 1,
            }),
            "2": serde_json::json!({
                "name": "B", "accountDBID": 2, "shipParamsId": 9, "relation": 2,
            }),
        }));
        let vehicles =
            parse_roster_raw(&raw, None).expect("explicit relations need no self anchor");
        assert_eq!(vehicles.iter().find(|v| v.name == "A").unwrap().relation, 1);
        assert_eq!(vehicles.iter().find(|v| v.name == "B").unwrap().relation, 2);
    }

    #[test]
    fn unresolvable_split_yields_none() {
        // No teamId, no relation, no way to split sides: refuse rather
        // than guess (the caller keeps its empty-roster retry).
        let raw = doc(serde_json::json!({
            "1": serde_json::json!({ "name": "A", "accountDBID": 1 }),
            "2": serde_json::json!({ "name": "B", "accountDBID": 2 }),
        }));
        assert!(parse_roster_raw(&raw, Some("A")).is_none());
    }

    #[test]
    fn empty_or_tiny_rosters_yield_none() {
        assert!(parse_roster_raw(&doc(serde_json::json!({})), Some("x")).is_none());
        let one = doc(serde_json::json!({ "1": record_full("Solo", 1, 1, 1) }));
        assert!(parse_roster_raw(&one, Some("Solo")).is_none());
    }

    #[test]
    fn freshness_gate_rejects_previous_battle_files() {
        let now = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let prev = now - std::time::Duration::from_secs(600);
        assert!(!roster_is_fresh(prev, now), "10 min old roster is stale");
        assert!(roster_is_fresh(
            now,
            now - std::time::Duration::from_secs(3)
        ));
        // Small negative skew (coarse stamps) still passes.
        assert!(roster_is_fresh(
            now - std::time::Duration::from_secs(4),
            now
        ));
    }
}
