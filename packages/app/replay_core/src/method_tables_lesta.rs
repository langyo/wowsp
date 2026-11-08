//! Lesta (Мир кораблей) Avatar client-method ids — the counterpart of the
//! auto-generated WG [`super::method_tables`], selected by replay container
//! family (`.korablireplay`) rather than by version range: Lesta's version
//! keys ("26,10,0") sit above every WG table, so version-keyed lookup would
//! keep resolving the newest WG row and cross-wire every method-gated stream
//! (a 26.10 capture decoded that way reads 2218 phantom achievements — the
//! WG achievement id collides with a Lesta method firing per shell).
//!
//! NOT auto-generated: the WG generator's reference checkout ships no Lesta
//! defs. This table was computed by running the game-assets entity-def
//! parser (`game_assets::rpc::entitydefs::parse_scripts` — the engine's own
//! exposed-index rule: client methods stable-sorted by arg wire size) over a
//! local 26.10 install's `scripts/entity_defs`, then cross-validated twice:
//!
//! 1. The same computation over a WG 15.8.1 install reproduced every pinned
//!    id of the empirical 15.8 row in [`super::method_tables`] (artillery
//!    126, torpedoes 127, shotKills 130, updateSquadron 145, damageStat 163,
//!    chat 151, achievements 58, arena 153) — the rule itself is proven.
//! 2. The Lesta ids line up with a real 26.10 capture's (entityType,
//!    methodId) histogram: artillery 124 (852 calls, ≤245B), shotKills 126
//!    (448), updateSquadron 144 (238), updateMinimapSquadron 94 (499 calls,
//!    exactly the 16 bytes of `PLANE_ID i64 + VECTOR2`), damageStat 166
//!    (57).
//!
//! Lesta recording reality (verified across two 26.10 captures): the packet
//! stream carries NO `onArenaStateReceived` and NO chat call at all — the
//! roster ships in the replay container's block[1] JSON instead (see the
//! `lesta_roster` synthesis in [`crate::meta`]). Consequences for this
//! table:
//!
//! - `on_chat_message: -1` (disabled): Lesta split chat into
//!   `onChatMessageRegular` (150 — a converter-encoded `CHAT_MESSAGE_BLOB`
//!   whose format lives in game scripts not shipped in the resource VFS) and
//!   `onChatMessageNotification` (151 — plain strings but a different shape
//!   than the WG decoder reads); no chat call appears in a recording anyway.
//! - `on_achievement_earned: 160`: Lesta appends three trailing args
//!   (`ARRAY<PLAYER_ID>`, `UINT32`, `BOOL`); the decoder reads the leading
//!   `(i32 playerId, u32 achievementId)` and ignores the rest — unchanged.
//! - `receive_damage_stat` carries TWO blobs on Lesta; only the first is
//!   read.
//! - `on_arena_state_received: 156`: informational — Lesta's signature grew
//!   to `i64, i8, BLOB×5, VECTOR3`, which the decoder already tolerates
//!   (it reads the leading blobs and ignores trailing bytes), but no call
//!   ever fires inside a recording.
//!
//! The E27 squadron-state fields (health / planesHealth / damage / throttle
//! / consumables / planeDeath / notify / deactivate) are pinned from the
//! local Korabli defs (E27c): def-authoritative, replay-unvalidated until a
//! carrier `.korablireplay` lands locally. NOTE for the frontend mapping:
//! Lesta's `battle.xml` ships a `CONSUMABLE_TYPES` enum the WG client
//! lacks (21=HEAL_FORSAGE, 22=CALL_FIGHTERS, 23=REGENERATE_HEALTH,
//! 42=PLANE_SMOKE_GENERATOR, 50=SHIELD, ...) whose numbering DIVERGES from
//! the WG wire ids fingerprinted in E27b (WG: 20=forsage, 21=tactical
//! fighters, 22=extinguisher, 42=smoke — only 42 coincides). Lesta-replay
//! consumable chips must therefore join against the LESTA table, not the WG
//! one, once a capture validates which space the wire byte uses (see E27c
//! in scripts/experiments/README.md).

use super::method_tables::MethodIds;

/// The 26.10 Lesta Avatar method ids (see the module docs for provenance).
pub static LESTA_METHOD_IDS: MethodIds = MethodIds {
    avatar_receive_artillery_shots: 124,
    avatar_receive_torpedoes: 125,
    avatar_receive_explosions: 127,
    avatar_receive_torpedo_direction: 113,
    avatar_receive_add_squadron: 116,
    avatar_receive_update_squadron: 144,
    avatar_receive_add_minimap_squadron: 103,
    avatar_receive_update_minimap_squadron: 94,
    avatar_receive_remove_minimap_squadron: 53,
    avatar_receive_ward_added: 114,
    avatar_receive_ward_removed: 55,
    avatar_receive_shot_kills: 126,
    avatar_receive_shield_damage_info: None,
    avatar_receive_damage_stat: Some(166),
    avatar_on_chat_message: -1,
    avatar_on_achievement_earned: 160,
    avatar_on_arena_state_received: 156,
    // E27 squadron-state ids (E27c, 2026-11-08): computed by running the
    // exposed-index rule (scripts/experiments/exposed_index.py) over the
    // LOCAL Korabli install's entity defs (25.8-era build 8871067) — the
    // same computation reproduces every pinned anchor above exactly
    // (updateSquadron 144, addSquadron 116, artillery 124, shotKills 126,
    // damageStat 166, achievements 160), so these nine are def-authoritative
    // for the Lesta branch. Still replay-unvalidated: no local
    // .korablireplay carries carrier play, so the first such capture should
    // re-run dump_squadron_state_methods (with these ids) to confirm before
    // trusting the streams downstream.
    avatar_receive_squadron_health: Some(85),
    avatar_receive_squadron_planes_health: Some(95),
    avatar_receive_squadron_damage: Some(87),
    avatar_receive_change_throttle_mode: Some(66),
    avatar_squadron_consumable_used: Some(69),
    avatar_squadron_consumable_stop_working: Some(71),
    avatar_receive_plane_death: Some(146),
    avatar_receive_squadron_notify: Some(65),
    avatar_receive_deactivate_squadron: Some(63),
};

#[cfg(test)]
mod tests {
    use super::*;

    /// The Lesta table never silently degrades: every id the decoder gates a
    /// stream on is populated (chat is the deliberate exception — Lesta chat
    /// never fires in a recording, see the module docs).
    #[test]
    fn lesta_ids_are_the_validated_set() {
        let t = &LESTA_METHOD_IDS;
        assert_eq!(t.avatar_receive_artillery_shots, 124);
        assert_eq!(t.avatar_receive_torpedoes, 125);
        assert_eq!(t.avatar_receive_explosions, 127);
        assert_eq!(t.avatar_receive_torpedo_direction, 113);
        assert_eq!(t.avatar_receive_add_squadron, 116);
        assert_eq!(t.avatar_receive_update_squadron, 144);
        assert_eq!(t.avatar_receive_add_minimap_squadron, 103);
        assert_eq!(t.avatar_receive_update_minimap_squadron, 94);
        assert_eq!(t.avatar_receive_remove_minimap_squadron, 53);
        assert_eq!(t.avatar_receive_ward_added, 114);
        assert_eq!(t.avatar_receive_ward_removed, 55);
        assert_eq!(t.avatar_receive_shot_kills, 126);
        assert_eq!(t.avatar_receive_damage_stat, Some(166));
        assert_eq!(t.avatar_on_achievement_earned, 160);
        assert_eq!(t.avatar_on_arena_state_received, 156);
        // Chat is disabled on Lesta (-1 matches no wire id).
        assert_eq!(t.avatar_on_chat_message, -1);
        // E27c: the nine squadron-state ids, def-derived from the local
        // Korabli install (exposed_index.py reproduces every anchor above
        // exactly). Replay-unvalidated until a carrier .korablireplay lands
        // — these asserts pin the def computation so any regeneration drift
        // is caught, NOT a wire validation.
        assert_eq!(t.avatar_receive_squadron_health, Some(85));
        assert_eq!(t.avatar_receive_squadron_planes_health, Some(95));
        assert_eq!(t.avatar_receive_squadron_damage, Some(87));
        assert_eq!(t.avatar_receive_change_throttle_mode, Some(66));
        assert_eq!(t.avatar_squadron_consumable_used, Some(69));
        assert_eq!(t.avatar_squadron_consumable_stop_working, Some(71));
        assert_eq!(t.avatar_receive_plane_death, Some(146));
        assert_eq!(t.avatar_receive_squadron_notify, Some(65));
        assert_eq!(t.avatar_receive_deactivate_squadron, Some(63));
    }
}
