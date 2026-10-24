//! Version-keyed LAYOUT tables (replay review M-5): every
//! version-dependent decoder input that is NOT an exposed method id
//! lives here as DATA — the same shape `method_tables.rs` proves for the
//! method ids. Pinning a new version era means appending a row to the
//! relevant table; the decode logic never changes.
//!
//! Row order is NEWEST-first everywhere; a lookup takes the first row
//! whose `since` is <= the replay's version. The two `None`-version
//! defaults are deliberate and historical:
//! - wire-shape gates (zone type / ward byte / ballistics byte) assume
//!   the MODERN shape when no version parsed (`row_newest`);
//! - the arena FixedDict rows assume the OLDEST pinned layout (`row_*`
//!   fall through to the bottom row), because `build_layout_profile`
//!   disables the arena decode entirely without a parsed version — the
//!   bottom row only ever feeds the Lesta family's no-version corner
//!   and the drift probe's baseline.

/// A pinned client-version era key (major, minor, patch — the same tuple
/// `parse_version_key` produces).
pub(crate) type Era = (u32, u32, u32);

/// InteractiveZone's entity-type index: `VehicleAppearance` joins
/// `entities.xml` in 14.5.0, pushing the zone from 13 to 14.
pub(crate) const ZONE_ENTITY_TYPE: [(Era, i16); 2] = [((14, 5, 0), 14), ((0, 0, 0), 13)];

/// `receive_wardAdded` carries a trailing `wardType` byte from 13.2.0 on.
pub(crate) const WARD_HAS_TYPE: [(Era, bool); 2] = [((13, 2, 0), true), ((0, 0, 0), false)];

/// SHOTKILL entries carry a nullable TERMINAL_BALLISTICS_INFO from 12.7.0
/// on (flag byte; 29 bytes when present).
pub(crate) const SHOTKILL_HAS_BALLISTICS: [(Era, bool); 2] =
    [((12, 7, 0), true), ((0, 0, 0), false)];

/// The oldest client version whose exposed method table the generated
/// `method_tables` cover: below it the exposed indices predate anything
/// pinned, so battle-effect decoding disables entirely.
pub(crate) const METHODS_TABLE_FLOOR: Era = (0, 11, 6);

/// The stream-format era switch: pre-12.6.0 replays carry the legacy
/// packet framing.
pub(crate) const LEGACY_STREAM_FLOOR: Era = (12, 6, 0);

/// The `onArenaStateReceived` player FixedDict indices, one row per
/// pinned layout era (see `method_tables.rs` for the id-table sibling).
/// The tail trio (`ship_entity_id`/`ship_params_id`/`team_id`) moves as
/// one rigid block across eras — the drift probe in `events.rs` shifts
/// exactly that trio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ArenaFieldRow {
    pub avatar_id: i64,
    /// The roster player id (joins the descriptor `vehicles[].id`).
    pub player_id: i64,
    pub max_health: i64,
    pub name: i64,
    /// The player's SHIP VEHICLE entity id (`shipId` in the FixedDict;
    /// NOT the GameParams id). Head of the rigid tail trio:
    /// `ship_params_id` = this + 1, `team_id` = this + 3 in every layout
    /// ever pinned (0.10.7 → 15.9.0, bots included).
    pub ship_entity_id: i64,
    pub ship_params_id: i64,
    pub team_id: i64,
}

pub(crate) const ARENA_PLAYER_FIELDS: [(Era, ArenaFieldRow); 5] = [
    // 15.9.0 inserted one field between `name` and the tail trio
    // (verified on a real 15.9.0 capture; the dict spans 0..38).
    (
        (15, 9, 0),
        ArenaFieldRow {
            avatar_id: 2,
            player_id: 11,
            max_health: 24,
            name: 25,
            ship_entity_id: 34,
            ship_params_id: 35,
            team_id: 37,
        },
    ),
    // 0.11.11+ 38-field layout (verified upstream across 0.11.11–0.12.8).
    (
        (0, 11, 11),
        ArenaFieldRow {
            avatar_id: 2,
            player_id: 11,
            max_health: 24,
            name: 25,
            ship_entity_id: 33,
            ship_params_id: 34,
            team_id: 36,
        },
    ),
    (
        (0, 10, 9),
        ArenaFieldRow {
            avatar_id: 2,
            player_id: 11,
            max_health: 23,
            name: 24,
            ship_entity_id: 32,
            ship_params_id: 33,
            team_id: 35,
        },
    ),
    (
        (0, 10, 7),
        ArenaFieldRow {
            avatar_id: 1,
            player_id: 10,
            max_health: 22,
            name: 23,
            ship_entity_id: 30,
            ship_params_id: 31,
            team_id: 33,
        },
    ),
    // Pre-0.10.7 (34 fields, recovered upstream from a 0.9.10 replay).
    (
        (0, 0, 0),
        ArenaFieldRow {
            avatar_id: 1,
            player_id: 10,
            max_health: 21,
            name: 22,
            ship_entity_id: 29,
            ship_params_id: 30,
            team_id: 32,
        },
    ),
];

/// Bots dropped 10 human-only fields in 0.12.8, moving their tail indices
/// down — no 15.9.0 bot capture has been pinned yet, so this single row
/// serves every bot era >= 0.12.8 and the drift probe absorbs the 15.9
/// insertion the same way.
pub(crate) const ARENA_BOT_FIELDS: [(Era, ArenaFieldRow); 1] = [(
    (0, 12, 8),
    ArenaFieldRow {
        avatar_id: -1,
        player_id: 10,
        max_health: 18,
        name: 19,
        ship_entity_id: 23,
        ship_params_id: 24,
        team_id: 26,
    },
)];

/// The bot row's era floor — `ArenaFields::for_version` keys bots onto
/// the bot table only from this version on (earlier bots rode the human
/// rows).
pub(crate) const ARENA_BOT_FLOOR: Era = (0, 12, 8);

/// Experiment E11 method ids (minimap vision + consumable use): pinned
/// against the 15.8.0 exposed tables (E10: def build 13187581,
/// wire-validated on the reference capture). Other versions decode
/// nothing — pinning a new era appends a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct E11Ids {
    pub avatar_update_minimap_vision_info: i32,
    pub vehicle_on_consumable_used: i32,
}

pub(crate) const E11_METHOD_IDS: [(Era, E11Ids); 1] = [(
    (15, 8, 0),
    E11Ids {
        avatar_update_minimap_vision_info: 155,
        vehicle_on_consumable_used: 72,
    },
)];

/// E11 ids are pinned per EXACT minor release, not per era-floor: the
/// exposed indices re-shuffle every minor, so 15.9.0 must NOT ride the
/// 15.8 pin. A version resolves iff some row shares its (major, minor)
/// and the row's patch floor is <= the version's patch.
pub(crate) fn e11_for(v: Option<Era>) -> Option<E11Ids> {
    let (ma, mi, pa) = v?;
    E11_METHOD_IDS
        .iter()
        .find(|((ra, ri, rp), _)| *ra == ma && *ri == mi && *rp <= pa)
        .map(|(_, ids)| *ids)
}

// ── Lookups ─────────────────────────────────────────────────────────────────

/// First row whose `since` <= `v` (rows newest-first). `None` version →
/// the TOP row: the historical "no version parsed assumes the modern
/// shape" default of the wire-shape gates.
pub(crate) fn row_newest<T: Copy>(rows: &[(Era, T)], v: Option<Era>) -> T {
    match v {
        Some(v) => rows
            .iter()
            .find(|(since, _)| *since <= v)
            .map_or(rows[rows.len() - 1].1, |(_, t)| *t),
        None => rows[0].1,
    }
}

/// First row whose `since` <= `v`; versions older than every row (and the
/// `None` version) get the BOTTOM row — the arena rows' historical
/// "oldest pinned layout" default.
pub(crate) fn row_oldest<T: Copy>(rows: &[(Era, T)], v: Option<Era>) -> T {
    match v {
        Some(v) => rows
            .iter()
            .find(|(since, _)| *since <= v)
            .map_or(rows[rows.len() - 1].1, |(_, t)| *t),
        None => rows[rows.len() - 1].1,
    }
}

impl ArenaFieldRow {
    /// The rigid tail trio shifted as one block (`by` slots up/down the
    /// index axis) — the drift probe's candidate moves.
    pub(crate) fn shifted(self, by: i64) -> Self {
        Self {
            avatar_id: self.avatar_id,
            player_id: self.player_id,
            max_health: self.max_health,
            name: self.name,
            ship_entity_id: self.ship_entity_id + by,
            ship_params_id: self.ship_params_id + by,
            team_id: self.team_id + by,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Era boundaries of every wire-shape gate: the row flips exactly at
    /// its pinned version, on both sides, and a parsed None keeps the
    /// modern shape.
    #[test]
    fn wire_gates_flip_at_their_pinned_eras() {
        assert_eq!(row_newest(&ZONE_ENTITY_TYPE, Some((14, 5, 0))), 14);
        assert_eq!(row_newest(&ZONE_ENTITY_TYPE, Some((14, 4, 99))), 13);
        assert_eq!(row_newest(&ZONE_ENTITY_TYPE, Some((0, 0, 1))), 13);
        assert_eq!(row_newest(&ZONE_ENTITY_TYPE, None), 14);

        assert!(row_newest(&WARD_HAS_TYPE, Some((13, 2, 0))));
        assert!(!row_newest(&WARD_HAS_TYPE, Some((13, 1, 99))));
        assert!(row_newest(&WARD_HAS_TYPE, None));

        assert!(row_newest(&SHOTKILL_HAS_BALLISTICS, Some((12, 7, 0))));
        assert!(!row_newest(&SHOTKILL_HAS_BALLISTICS, Some((12, 6, 99))));
        assert!(row_newest(&SHOTKILL_HAS_BALLISTICS, None));
    }

    /// The arena rows resolve per pinned era; bots key onto the bot table
    /// only from 0.12.8; a `None` version lands on the OLDEST row (the
    /// decode is disabled without a version — the default only feeds the
    /// drift-probe baseline).
    #[test]
    fn arena_rows_resolve_per_era_with_oldest_default() {
        let human = |v: Option<Era>| row_oldest(&ARENA_PLAYER_FIELDS, v);
        assert_eq!(human(Some((15, 9, 0))).team_id, 37);
        assert_eq!(human(Some((15, 8, 9))).team_id, 36);
        assert_eq!(human(Some((0, 11, 11))).team_id, 36);
        assert_eq!(human(Some((0, 11, 10))).team_id, 35);
        assert_eq!(human(Some((0, 10, 9))).team_id, 35);
        assert_eq!(human(Some((0, 10, 8))).team_id, 33);
        assert_eq!(human(Some((0, 9, 10))).team_id, 32);
        assert_eq!(human(None).team_id, 32, "None → oldest pinned row");

        let bot = row_oldest(&ARENA_BOT_FIELDS, Some((0, 12, 8)));
        assert_eq!(bot.avatar_id, -1);
        assert_eq!(bot.team_id, 26);
    }

    /// The E11 ids ride their exact pinned minor: 15.8.x carries the pin,
    /// 15.9.0 and 15.7.9 do not.
    #[test]
    fn e11_ids_are_minor_exact() {
        assert_eq!(
            e11_for(Some((15, 8, 0))).map(|i| i.avatar_update_minimap_vision_info),
            Some(155)
        );
        assert_eq!(
            e11_for(Some((15, 8, 9))).map(|i| i.vehicle_on_consumable_used),
            Some(72)
        );
        assert_eq!(e11_for(Some((15, 9, 0))), None);
        assert_eq!(e11_for(Some((15, 7, 9))), None);
        assert_eq!(e11_for(None), None);
    }
}
