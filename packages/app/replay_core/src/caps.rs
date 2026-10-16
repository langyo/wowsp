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

/// InteractiveZone's entity-type index on current layouts (14 from 14.5.0;
/// 13 before — see the decoder's `LayoutProfile::zone_entity_type`).
const ZONE_ENTITY_TYPE: i16 = 14;

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
pub fn cap_points_of(decode: &DecodedReplay) -> Vec<CapPointObs> {
    let mut caps: Vec<CapPointObs> = Vec::new();
    for kind in decode.kinds.values() {
        if kind.entity_type != ZONE_ENTITY_TYPE {
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
