//! Capture-zone geometry lifted off a decoded replay — the pure half of the
//! app's cap-layout learner (`wowsp_tauri::commands::replay::cap_layouts`).
//!
//! WG composes mode layouts server-side and ships them to the client as
//! InteractiveZone entities at battle start; the decoder already recovers
//! every zone's position, radius, point index and initial owner from the
//! EntityCreate packets. [`cap_points_of`] projects that geometry out of a
//! [`DecodedReplay`] as plain observations, so both the app's learner and
//! the replay-corpus aggregator consume one implementation.

use serde::Serialize;

use crate::packets::DecodedReplay;

/// One capture point as the replay recorded it (world units, x = east,
/// z = north — the same frame as positions).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapPointObs {
    /// 0-based point index (A = 0, B = 1, …) from the create packet.
    pub index: i32,
    pub x: f32,
    pub z: f32,
    /// Ring radius as scanned from the create state (world units); None
    /// when the scan found nothing — the consumer floors it.
    pub radius: Option<f32>,
    /// Initial owner (0/1 = team, -1 = neutral), None when unknown.
    pub team: Option<i8>,
    /// Battle second the point appeared at (operations with conditional
    /// objectives); None = present from the start.
    pub appear_t: Option<f32>,
}

/// Lift the capture points out of a decoded replay's entity table, sorted by
/// point index. `control_point_index` is the authoritative "is a capture
/// point" flag (interactive zones without it are not cap objectives) — but
/// the componentsState scan only recovers it on newer protocols; older
/// replays still carry the geometry, so a present radius qualifies a zone
/// too and its list position stands in for the letter index.
///
/// Review M-4: the zone filter rides `decode.zone_entity_type` — the
/// version-resolved index the decode stamped from its layout profile (14
/// from client 14.5.0, 13 before). The former local `= 14` constant
/// silently dropped every pre-14.5.0 replay's cap geometry.
pub fn cap_points_of(decode: &DecodedReplay) -> Vec<CapPointObs> {
    let mut caps: Vec<CapPointObs> = Vec::new();
    for kind in decode.kinds.values() {
        if kind.entity_type != decode.zone_entity_type {
            continue;
        }
        if kind.control_point_index.is_none() && kind.radius.is_none() {
            continue;
        }
        let appear_t = if kind.creation_time > 0.0 {
            Some(kind.creation_time)
        } else {
            None
        };
        caps.push(CapPointObs {
            index: kind.control_point_index.unwrap_or(caps.len() as i32),
            x: kind.initial_x,
            z: kind.initial_z,
            radius: kind.radius,
            team: kind.initial_team,
            appear_t,
        });
    }
    caps.sort_by_key(|c| c.index);
    caps
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// The zone entity for a synthetic decode — minimal fields
    /// `cap_points_of` reads (geometry + the radius qualifier).
    fn zone(entity_type: i16, index: i32) -> wowsp_tauri_shared::EntityKind {
        wowsp_tauri_shared::EntityKind {
            entity_type,
            initial_x: 100.0 + index as f32,
            initial_y: 0.0,
            initial_z: -50.0,
            creation_time: 0.0,
            ship_id: None,
            vehicle_id: 0,
            max_health: None,
            control_point_index: Some(index),
            initial_team: Some(-1),
            radius: Some(220.0),
        }
    }

    /// Review M-4 regression: a PRE-14.5.0 replay decodes with
    /// `zone_entity_type = 13`, and its InteractiveZone entities carry
    /// type 13 — the lift must find them through the stamped index, not
    /// through the old hardcoded 14 (which silently returned nothing).
    #[test]
    fn pre_14_5_layouts_keep_their_cap_geometry() {
        let mut decode = DecodedReplay {
            recorder_ship: None,
            zone_entity_type: 13,
            ..empty_decode()
        };
        decode.kinds.insert(9001, zone(13, 0));
        decode.kinds.insert(9002, zone(13, 1));
        // A type-14 entity on the SAME decode is a different layout's
        // zone — it must not leak into this one's caps.
        decode.kinds.insert(9003, zone(14, 7));
        let caps = cap_points_of(&decode);
        assert_eq!(caps.len(), 2, "both type-13 zones lift: {caps:?}");
        assert!(caps.iter().all(|c| c.index < 2));
    }

    /// The modern layout (14 from client 14.5.0) keeps working unchanged.
    #[test]
    fn modern_layouts_lift_type_14_zones() {
        let mut decode = DecodedReplay {
            recorder_ship: None,
            zone_entity_type: 14,
            ..empty_decode()
        };
        decode.kinds.insert(9001, zone(14, 0));
        assert_eq!(cap_points_of(&decode).len(), 1);
    }

    /// Minimal DecodedReplay skeleton for the two tests above — every
    /// unread field default/empty.
    fn empty_decode() -> DecodedReplay {
        DecodedReplay {
            recorder_ship: None,
            zone_entity_type: 14,
            positions: BTreeMap::new(),
            kinds: BTreeMap::new(),
            destroys: BTreeMap::new(),
            properties: BTreeMap::new(),
            shell_launches: Vec::new(),
            explosions: Vec::new(),
            torpedoes: Vec::new(),
            torpedo_steers: Vec::new(),
            cap_progress: BTreeMap::new(),
            weapon_locks: Vec::new(),
            battle_results: None,
            method_histogram: Vec::new(),
            method_arg_samples: BTreeMap::new(),
            version: None,
            map_name: None,
            camera: Vec::new(),
            net_stats: Vec::new(),
            leaves: BTreeMap::new(),
            camera_modes: Vec::new(),
            diagnostics: Default::default(),
            squadron_creates: Vec::new(),
            squadron_planes: Vec::new(),
            minimap_squadron_adds: Vec::new(),
            minimap_squadron_moves: Vec::new(),
            minimap_squadron_removes: Vec::new(),
            wards: Vec::new(),
            ward_removes: Vec::new(),
            shot_kills: Vec::new(),
            damage_stats: Vec::new(),
            chat_messages: Vec::new(),
            achievements: Vec::new(),
            arena_players: Vec::new(),
            weather_transitions: Vec::new(),
            weather_notifications: Vec::new(),
            cruise: Vec::new(),
            smoke_screens: Vec::new(),
            recorder_vehicle: None,
            vision_events: Vec::new(),
            consumable_uses: Vec::new(),
            engine_states: Vec::new(),
        }
    }
}
