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
///
/// `consumable_use_params_blob` records the ARGUMENT SHAPE of Vehicle
/// `onConsumableUsed`, which is NOT stable across the pinned eras: 15.2+
/// carry the def's length-prefixed `CONSUMABLE_USAGE_PARAMS` blob followed by
/// the f32 `workTimeLeft` (a usage variant 0..3 plus the raw consumable id
/// inside the blob), while the 14.5 def predates that blob — its wire is the
/// bare `u8 consumable id, f32 workTimeLeft` (5 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct E11Ids {
    pub avatar_update_minimap_vision_info: i32,
    pub vehicle_on_consumable_used: i32,
    /// True when the consumable-use args carry the `CONSUMABLE_USAGE_PARAMS`
    /// length-prefixed blob (15.2+); false for the 14.5 pre-blob shape.
    pub consumable_use_params_blob: bool,
}

pub(crate) const E11_METHOD_IDS: [(Era, E11Ids); 3] = [
    // 15.10.0 (build 13533378, the Bermuda Triangle event client): def-derived
    // from the authoritative entity defs (exposed_index.py). The whole exposed
    // table shifted +1 at and above id 87 with receiveShieldDamageInfo's
    // insertion (see method_tables' 15.10.0 row for the full accounting).
    (
        (15, 10, 0),
        E11Ids {
            avatar_update_minimap_vision_info: 156,
            vehicle_on_consumable_used: 73,
            consumable_use_params_blob: true,
        },
    ),
    (
        (15, 8, 0),
        E11Ids {
            avatar_update_minimap_vision_info: 155,
            vehicle_on_consumable_used: 72,
            consumable_use_params_blob: true,
        },
    ),
    // 14.5.0 (the Shokaku reference era) — WIRE-PROBED, not def-derived: the
    // 14.5 entity defs are no longer on the install, so a temporary probe test
    // walked EVERY EntityMethod (0x08) call of the 2025-07-08 "37_Ridge"
    // capture and classified by argument shape:
    //   - avatar id 141 decodes as updateMinimapVisionInfo's two MINIMAPINFO
    //     arrays (2,278 calls / 15,563 marker events — the allied always-visible
    //     opening set plus the hidden sentinel, exactly the stream the 15.8 pin
    //     carries);
    //   - vehicle id 27 carries 5-byte args whose trailing f32 clusters on the
    //     GameParams work times of the consumables those hulls actually pressed
    //     (28 s repair party, 5 s damage control, 71.5/100 s spotter, 600 s
    //     carrier patrol fighter) — 135 uses across 21 vehicles.
    // The neighbouring candidate ids are rejected by the parser's shape gate:
    // only 27 yields a plausible count/duration distribution on this capture.
    (
        (14, 5, 0),
        E11Ids {
            avatar_update_minimap_vision_info: 141,
            vehicle_on_consumable_used: 27,
            consumable_use_params_blob: false,
        },
    ),
];

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

/// The recorder's `receiveDamageStat` exposed method id, pinned per exact
/// minor for versions whose GENERATED method-table row suppresses it
/// (`DEF_ID_SUPPRESSED` in `scripts/gen_method_tables.py`: newer reference
/// defs ship the method, but those ids are not trusted until wire-probed).
/// The generated row keeps the id `None`; this override supplies it to the
/// decoder. 15.8/15.10 already carry their ids in `method_tables`, so they
/// need no row here.
///
/// 14.5.0 (the Shokaku reference era) — WIRE-PROBED, id 149. The 14.5 entity
/// defs are gone from the install, so a temporary probe walked EVERY
/// EntityMethod (0x08) call of the 2025-07-08 "37_Ridge" capture and ran the
/// decoder's shape gate on each args blob:
///   - only avatar id 149 parses as `receiveDamageStat`'s BLOB: a u8 length
///     prefix + pickle-proto-2 dict `{(weapon, category): [count, total]}`;
///   - 59 calls, all on the recorder's avatar entity 845627, 157.087..1159.054
///     (106 samples: 55 category-0 enemy, 46 category-2 spotting, 5
///     category-3 agro);
///   - the category-0 fold of the latest sample per (weapon, category) is
///     108,119.29 — the post-battle modal's 108,120 within its ±1 rounding —
///     and 21,601.17 at replay t=353.1 (the 04:33 strip playhead; the strip's
///     21,522 is its HP-delta fallback 79 low);
///   - every neighbouring avatar id fails the parser's shape gate.
///
/// The 14.5 call's args match the 15.8 wire byte-for-byte, so no era-shape
/// flag is needed (unlike E11's consumable blob split).
pub(crate) const DAMAGE_STAT_METHOD_IDS: [(Era, i32); 1] = [((14, 5, 0), 149)];

/// Exact-minor lookup, same rule as [`e11_for`]: the exposed indices
/// re-shuffle every minor, so a version resolves iff a row shares its
/// (major, minor) and the row's patch floor is <= the version's patch.
pub(crate) fn damage_stat_for(v: Option<Era>) -> Option<i32> {
    let (ma, mi, pa) = v?;
    DAMAGE_STAT_METHOD_IDS
        .iter()
        .find(|((ra, ri, rp), _)| *ra == ma && *ri == mi && *rp <= pa)
        .map(|(_, id)| *id)
}

/// The 15.10.0 shield + gun-heat streams (the Bermuda Triangle event era's
/// two new mechanics), pinned as one exact-minor row like the E11 ids — the
/// same defs re-shuffle invalidates all of them together.
///
/// Three wire surfaces, def-derived from build 13533378's entity defs and
/// wire-validated on the same-day event capture (2026-11-05):
///
/// - Vehicle client methods `shieldRegen` (no args) / `shieldHit` (no args) —
///   the shield lifecycle markers, exposed ids 0/1 (wire counts on the
///   reference capture: 19 regen / 661 hit);
/// - Vehicle client method `setGunOverheated(weaponType UINT8, gunID UINT8,
///   isOverheated BOOL)` — the gun-heat mechanic's boolean transition, exposed
///   id 21 (zero calls on the reference capture — the heat LEVEL itself is
///   client-local and never replicates, only this broadcast does);
/// - the Vehicle `state` property's nested `SHIELD_STATE` fixed dict —
///   `VEHICLE_STATE` puts `shield` at key 3 of 6, and `SHIELD_STATE`
///   (`maxHp`/`remainingHP`, both UINT32) spans fields 0/1 of 2. The dict key
///   indices pin the nested-property bit path (BigWorld SetKey walk,
///   MSB-first bits, values byte-aligned); the enclosing `state` property's
///   exposed index is resolved BY NAME from the generated property table,
///   never pinned here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VehicleGunStateRow {
    pub shield_regen_method: i32,
    pub shield_hit_method: i32,
    pub set_gun_overheated_method: i32,
    /// `VEHICLE_STATE`'s total key count (drives bits_required for the
    /// level-2 key selector of the nested-property path).
    pub vehicle_state_key_count: usize,
    /// The `shield` key's index inside `VEHICLE_STATE`.
    pub shield_state_key: usize,
    /// `SHIELD_STATE`'s total key count (drives bits_required for the field
    /// selector).
    pub shield_field_count: usize,
    /// The `maxHp` field index inside `SHIELD_STATE`.
    pub max_hp_field: usize,
    /// The `remainingHP` field index inside `SHIELD_STATE`.
    pub remaining_hp_field: usize,
}

pub(crate) const VEHICLE_GUN_STATE_LAYOUT: [(Era, VehicleGunStateRow); 1] = [(
    (15, 10, 0),
    VehicleGunStateRow {
        shield_regen_method: 0,
        shield_hit_method: 1,
        set_gun_overheated_method: 21,
        vehicle_state_key_count: 6,
        shield_state_key: 3,
        shield_field_count: 2,
        max_hp_field: 0,
        remaining_hp_field: 1,
    },
)];

/// Exact-minor lookup, same rule as [`e11_for`]: the exposed indices and dict
/// key orders re-shuffle every minor, so a version resolves iff a row shares
/// its (major, minor) and the row's patch floor is <= the version's patch.
pub(crate) fn vehicle_gun_state_for(v: Option<Era>) -> Option<VehicleGunStateRow> {
    let (ma, mi, pa) = v?;
    VEHICLE_GUN_STATE_LAYOUT
        .iter()
        .find(|((ra, ri, rp), _)| *ra == ma && *ri == mi && *rp <= pa)
        .map(|(_, row)| *row)
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
    /// 15.9.0 and 15.7.9 do not, and 14.5.x carries the wire-probed row.
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

    /// The 14.5.0 row: the wire-probed ids AND the pre-blob argument shape.
    /// This is the row that turns the grey recoverable HP bar back on for
    /// 14.5 replays — without it the consumable stream decodes zero events
    /// and repairPool has nothing to fail over to.
    #[test]
    fn e11_145_row_pins_wire_probed_ids() {
        let row = e11_for(Some((14, 5, 0))).expect("14.5.0 E11 row pinned");
        assert_eq!(row.vehicle_on_consumable_used, 27);
        assert_eq!(row.avatar_update_minimap_vision_info, 141);
        assert!(
            !row.consumable_use_params_blob,
            "14.5 predates the CONSUMABLE_USAGE_PARAMS blob"
        );
        // Same-minor patches ride the row; the neighbouring minors do not.
        assert_eq!(
            e11_for(Some((14, 5, 7))).map(|i| i.vehicle_on_consumable_used),
            Some(27)
        );
        assert_eq!(e11_for(Some((14, 4, 9))), None);
        assert_eq!(e11_for(Some((14, 6, 0))), None);
        // The 15.x rows keep the blob shape.
        assert!(
            e11_for(Some((15, 8, 0))).is_some_and(|i| i.consumable_use_params_blob),
            "15.8 carries the params blob"
        );
    }

    /// The 14.5 damage-stat pin rides its exact minor; the 15.8/15.10 rows
    /// keep their generated ids and must NOT be shadowed by this table.
    #[test]
    fn damage_stat_145_is_minor_exact() {
        assert_eq!(damage_stat_for(Some((14, 5, 0))), Some(149));
        assert_eq!(
            damage_stat_for(Some((14, 5, 9))),
            Some(149),
            "same-minor patches ride the row"
        );
        assert_eq!(damage_stat_for(Some((14, 4, 9))), None);
        assert_eq!(damage_stat_for(Some((14, 6, 0))), None);
        assert_eq!(
            damage_stat_for(Some((15, 8, 0))),
            None,
            "15.8 carries its own generated method-table id"
        );
        assert_eq!(damage_stat_for(None), None);
    }

    /// The shield/gun-heat layout rides its exact pinned minor like the E11
    /// ids: 15.10.x carries the row, 15.9.x (whose defs predate all three
    /// streams' exposed ids) and older resolve nothing.
    #[test]
    fn vehicle_gun_state_is_minor_exact() {
        let row = vehicle_gun_state_for(Some((15, 10, 0))).expect("15.10 row pinned");
        assert_eq!(row.shield_regen_method, 0);
        assert_eq!(row.shield_hit_method, 1);
        assert_eq!(row.set_gun_overheated_method, 21);
        assert_eq!(row.shield_state_key, 3);
        assert_eq!(row.remaining_hp_field, 1);
        assert_eq!(
            vehicle_gun_state_for(Some((15, 10, 9))).map(|r| r.set_gun_overheated_method),
            Some(21),
            "same-minor patches ride the row"
        );
        assert_eq!(vehicle_gun_state_for(Some((15, 9, 0))), None);
        assert_eq!(vehicle_gun_state_for(Some((15, 11, 0))), None);
        assert_eq!(vehicle_gun_state_for(None), None);
    }
}
