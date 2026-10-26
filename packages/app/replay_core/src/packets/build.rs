//! Vehicle build decoder: the EntityCreate (0x05) state property walk plus the
//! two per-ship loadout payloads it carries — `shipConfig` (modules, upgrades,
//! camouflages/signals, consumables, economic bonuses) and the captain's
//! `crewModifiersCompactParams` (commander id + learned skills).
//!
//! ## Wire format (verified offline on real 15.9.0 / build 13357625 replays)
//!
//! The create state is a BigWorld property stream:
//!
//! ```text
//! u32 total_len | u8 property_count | { [u8 property_index][value] } × count
//! ```
//!
//! The entries appear in ASCENDING exposed-property-index order, and the index
//! map is the client-visible property list sorted by wire size (the exact rule
//! `scripts/experiments/exposed_index.py` documents for client METHODS). For
//! the 15.9 Vehicle entity that list has 54 entries; the first 43 are
//! fixed-width (1/2/4/8 bytes) and the last 11 are variable-width. The two
//! properties this module needs are:
//!
//! - index 47 = `shipConfig` (USER_TYPE, serialized as `u8 len + blob`),
//! - index 48 = `crewModifiersCompactParams` (FIXED_DICT, inline).
//!
//! Variable-width properties use the BigWorld compact encoding: unsized ARRAY =
//! `u8 count + elements`, STRING/BLOB = `u8 len + bytes`. A `0xff` length
//! escape was never observed on the reference corpus (the largest observed
//! shipConfig blob is 252 bytes), so the decoder REFUSES such an entity rather
//! than guess at the escape framing — the caller counts it as skipped.
//!
//! ## Version pin (deliberate, expandable by generator)
//!
//! The property index map drifts whenever the entity defs change, so this
//! decoder is pinned to client 15.9.x only: other versions skip build decoding
//! (and count a diagnostic) until a generated
//! `packets/property_tables.rs` replaces the constants below — the planned
//! counterpart of `method_tables` (see `scripts/gen_method_tables.py` and the
//! property-index probe in `scripts/experiments/exposed_index.py`).
//!
//! The `shipConfig` binary itself is version-gated too: 13.2+ carries one extra
//! u32 after the unit slots, and 15.9 inserted one extra u32 between the
//! color-scheme section and the ability (consumable) section. The offsets are
//! verified on 15.8.1 and 15.9.0 captures; the >= 15.9 branch is the one the
//! 30-replay reference corpus exercises.

/// Number of client-visible Vehicle properties inside the EntityCreate state
/// (15.9 entity defs; verified against real captures: state[4] == 54).
pub(super) const VEHICLE_CREATE_PROPERTY_COUNT: u8 = 54;

/// `shipConfig` exposed-property index (15.9 Vehicle defs).
pub(super) const PROP_SHIP_CONFIG: u8 = 47;
/// `crewModifiersCompactParams` exposed-property index (15.9 Vehicle defs).
pub(super) const PROP_CREW_MODIFIERS: u8 = 48;

/// The only client version era whose Vehicle property map + shipConfig binary
/// layout is pinned (see the module docs; other versions skip).
pub(crate) const BUILD_SUPPORTED_ERA: (u32, u32) = (15, 9);

/// Whether the build decoder should run for this parsed client version.
pub(crate) fn builds_supported(version: Option<(u32, u32, u32)>) -> bool {
    matches!(version, Some((major, minor, _)) if (major, minor) == BUILD_SUPPORTED_ERA)
}

/// One vehicle's decoded build — the DECODE layer keeps both teams' builds
/// (completeness + tests); the IPC exit filters to allies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VehicleBuildRaw {
    pub entity_id: i32,
    pub ship_params_id: u32,
    pub units: Vec<u32>,
    pub modernization: Vec<u32>,
    pub exteriors: Vec<u32>,
    pub abilities: Vec<u32>,
    pub ensigns: Vec<u32>,
    pub ecoboosts: Vec<u32>,
    pub crew_params_id: u32,
    pub is_in_adaptation: bool,
    pub learned_skills: Vec<Vec<u8>>,
}

/// Fixed wire width of the first 43 client-visible Vehicle properties, sorted
/// by type size (19 × 1-byte, 8 × 2-byte, 15 × 4-byte, 1 × 8-byte); 43..=53
/// are variable and handled separately. Derived from the 15.9 entity defs with
/// the `exposed_index.py` sort rule (see the module docs).
fn fixed_width(property_index: u8) -> Option<usize> {
    match property_index {
        0..=18 => Some(1),
        19..=26 => Some(2),
        27..=41 => Some(4),
        42 => Some(8),
        _ => None,
    }
}

/// A bounds-checked little-endian cursor over a byte slice; every read returns
/// `None` on truncation so the walk is total on malformed input.
struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(len)?;
        let slice = self.data.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }

    fn skip(&mut self, len: usize) -> Option<()> {
        self.take(len).map(|_| ())
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|s| s[0])
    }

    fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
}

/// Read one 15.9 `shipConfig` property value (the u8 length prefix, then the
/// ShipConfig binary) and decode it.
fn read_ship_config(cursor: &mut Cursor<'_>, version: (u32, u32, u32)) -> Option<ShipConfigRaw> {
    let len = cursor.u8()? as usize;
    // A 0xff length escape was never observed and its framing is unverified:
    // refuse the entity instead of mis-slicing the rest of the property stream.
    if len == 0xff {
        return None;
    }
    let blob = cursor.take(len)?;
    decode_ship_config_blob(blob, version)
}

/// The `shipConfig` sections this module surfaces (the rest of the binary —
/// supplies, color schemes, flags/tail — is walked but not exposed).
///
/// Public so non-replay producers of the SAME SHIP_CONFIG blob can reuse the
/// parser: the in-game probe's `builds.json` bridges the game's own
/// `shipConfigDump` verbatim (see `commands::ingame_plugin`), and its layout is
/// exactly this binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShipConfigRaw {
    pub ship_params_id: u32,
    pub units: Vec<u32>,
    pub modernization: Vec<u32>,
    pub exteriors: Vec<u32>,
    pub abilities: Vec<u32>,
    pub ensigns: Vec<u32>,
    pub ecoboosts: Vec<u32>,
}

/// One u32-count-prefixed id section (`count` then `count` × u32). The count
/// is capped so a corrupt length can never drive a huge allocation.
fn read_section(cursor: &mut Cursor<'_>, cap: usize) -> Option<Vec<u32>> {
    let count = cursor.u32()? as usize;
    if count > cap {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(cursor.u32()?);
    }
    Some(out)
}

/// Decode the `shipConfig` binary (port of the vendored wows-toolkit layout in
/// `packages/tools/game-assets/src/data/ship_config.rs`, extended with the
/// 15.9 section shift).
///
/// Verified layout (GameParams id prefixes used as the tell):
/// ```text
/// u32 version, u32 ship_params_id, u32 element_count, u32 unit_count,
/// u32[unit_count] units, [>=13.2] u32 unknown,
/// modernization[PCM*], exteriors[PCEP/PCEM/PCED cammo + PCEF signals],
/// u32 supply_state, color_schemes: u32 count + (slot, scheme) u32 pairs,
/// [>=15.9] u32 unknown (0 on every reference capture),
/// abilities[PCY*], ensigns, ecoboosts[PCEA*], ...tail (not read)
/// ```
/// Decode one raw `SHIP_CONFIG` blob (no property-stream length prefix).
///
/// `version` selects the layout era: 13.2+ carries the extra unknown u32 after
/// the unit slots and 15.9+ the extra unknown u32 before the ability slots. A
/// caller that only knows the current layout (the in-game probe bridges a bare
/// dump with no version stamp) passes a fixed era — a drifted future layout
/// fails the section sanity caps and answers `None` instead of mis-reading ids.
pub fn decode_ship_config_blob(blob: &[u8], version: (u32, u32, u32)) -> Option<ShipConfigRaw> {
    let mut cursor = Cursor::new(blob);
    let _blob_version = cursor.u32()?;
    let ship_params_id = cursor.u32()?;
    let _element_count = cursor.u32()?;
    let unit_count = cursor.u32()? as usize;
    if unit_count > 64 {
        return None;
    }
    let mut units = Vec::with_capacity(unit_count);
    for _ in 0..unit_count {
        units.push(cursor.u32()?);
    }
    // 13.2.0 appended one unknown u32 after the unit slots.
    if version >= (13, 2, 0) {
        cursor.u32()?;
    }
    let modernization = read_section(&mut cursor, 32)?;
    let exteriors = read_section(&mut cursor, 32)?;
    let _supply_state = cursor.u32()?;
    let color_scheme_count = cursor.u32()? as usize;
    if color_scheme_count > 64 {
        return None;
    }
    cursor.skip(color_scheme_count.checked_mul(8)?)?;
    // 15.9.0 inserted one unknown u32 between the color schemes and the
    // ability (consumable) slots — verified by decoding the same replay with
    // both layouts and matching the GameParams id prefixes.
    if version >= (15, 9, 0) {
        cursor.u32()?;
    }
    let abilities = read_section(&mut cursor, 32)?;
    let ensigns = read_section(&mut cursor, 16)?;
    let ecoboosts = read_section(&mut cursor, 16)?;
    Some(ShipConfigRaw {
        ship_params_id,
        units,
        modernization,
        exteriors,
        abilities,
        ensigns,
        ecoboosts,
    })
}

/// Read one 15.9 `crewModifiersCompactParams` FIXED_DICT:
/// `u32 paramsId | u8 isInAdaptation | u8 outer | { u8 len, u8 skill ids } × outer`.
fn read_crew_modifiers(cursor: &mut Cursor<'_>) -> Option<CrewModifiersRaw> {
    let params_id = cursor.u32()?;
    let is_in_adaptation = cursor.u8()? != 0;
    let outer = cursor.u8()? as usize;
    // The reference captures carry 6 species rows; cap generously but bounded.
    if outer > 16 {
        return None;
    }
    let mut learned_skills = Vec::with_capacity(outer);
    for _ in 0..outer {
        let len = cursor.u8()? as usize;
        let ids = cursor.take(len)?.to_vec();
        learned_skills.push(ids);
    }
    Some(CrewModifiersRaw {
        params_id,
        is_in_adaptation,
        learned_skills,
    })
}

struct CrewModifiersRaw {
    params_id: u32,
    is_in_adaptation: bool,
    learned_skills: Vec<Vec<u8>>,
}

/// Skip one BigWorld compact STRING/BLOB value. The 0xff length escape is
/// unverified for the property stream (same reasoning as `read_ship_config`),
/// so an escaped string aborts the whole build for this entity.
fn skip_string(cursor: &mut Cursor<'_>) -> Option<()> {
    let len = cursor.u8()? as usize;
    if len == 0xff {
        return None;
    }
    cursor.skip(len)
}

/// Skip the variable-width property at `index` (43..=46 on 15.9; 47/48 are read
/// by the caller). Returns `None` when the value shape is unsupported.
fn skip_variable_property(cursor: &mut Cursor<'_>, index: u8) -> Option<()> {
    match index {
        // airDefenseTargetIds: ARRAY<of>ARRAY<of>PLANE_ID(INT64)</of></of>
        43 => {
            let outer = cursor.u8()? as usize;
            for _ in 0..outer {
                let inner = cursor.u8()? as usize;
                cursor.skip(inner.checked_mul(8)?)?;
            }
            Some(())
        },
        // antiAirAuras: ARRAY<of>AIR_DEFENCE_AURA{INT8 id, BOOL enabled}>
        44 => {
            let count = cursor.u8()? as usize;
            cursor.skip(count.checked_mul(2)?)
        },
        // effects / sounds: ARRAY<of>ENTITY_CLIENT_ACTION_STATE{INT16 id, STRING
        // name, STRING node}>
        45 | 46 => {
            let count = cursor.u8()? as usize;
            for _ in 0..count {
                cursor.skip(2)?;
                skip_string(cursor)?;
                skip_string(cursor)?;
            }
            Some(())
        },
        _ => None,
    }
}

/// Decode one vehicle's build out of its EntityCreate state stream.
///
/// `state` is everything after the 38-byte EntityCreate fixed header and
/// `version` is the replay's parsed client version. `None` means "skip this
/// entity" (unsupported shape/version escape — the caller counts it); it is
/// never a partial build.
pub(crate) fn decode_vehicle_build(
    entity_id: i32,
    state: &[u8],
    version: (u32, u32, u32),
) -> Option<VehicleBuildRaw> {
    // Frame: u32 total_len (payload AFTER the length field) | u8 count.
    let declared_len = u32::from_le_bytes(state.get(0..4)?.try_into().ok()?) as usize;
    if declared_len != state.len().checked_sub(4)? {
        return None;
    }
    if *state.get(4)? != VEHICLE_CREATE_PROPERTY_COUNT {
        return None;
    }
    let mut cursor = Cursor::new(state);
    cursor.skip(5)?;
    // Fixed-width prefix: every index 0..=42 is present, in ascending order.
    for index in 0..=42u8 {
        if cursor.u8()? != index {
            return None;
        }
        cursor.skip(fixed_width(index)?)?;
    }
    // Variable-width size: shipConfig + crew modifiers are the only values we
    // keep; everything before 47 must be skipped to reach them.
    let mut ship_config: Option<ShipConfigRaw> = None;
    let mut crew: Option<CrewModifiersRaw> = None;
    for index in 43..=53u8 {
        if cursor.u8()? != index {
            return None;
        }
        match index {
            PROP_SHIP_CONFIG => ship_config = Some(read_ship_config(&mut cursor, version)?),
            PROP_CREW_MODIFIERS => {
                crew = Some(read_crew_modifiers(&mut cursor)?);
                // Both build payloads decoded — the trailing variable
                // properties (debug text, triggers, death settings, vehicle
                // state) are not needed.
                break;
            },
            _ => skip_variable_property(&mut cursor, index)?,
        }
    }
    let config = ship_config?;
    let crew = crew?;
    Some(VehicleBuildRaw {
        entity_id,
        ship_params_id: config.ship_params_id,
        units: config.units,
        modernization: config.modernization,
        exteriors: config.exteriors,
        abilities: config.abilities,
        ensigns: config.ensigns,
        ecoboosts: config.ecoboosts,
        crew_params_id: crew.params_id,
        is_in_adaptation: crew.is_in_adaptation,
        learned_skills: crew.learned_skills,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixed-width table must cover exactly the pinned prefix (0..=42) and
    /// its total is what a create-state walk advances over.
    #[test]
    fn fixed_widths_cover_the_43_property_prefix() {
        let mut total = 0usize;
        for index in 0..=42u8 {
            total += fixed_width(index).expect("pinned prefix covered") + 1;
        }
        assert_eq!(total, 43 + 19 + 8 * 2 + 15 * 4 + 8);
        assert_eq!(fixed_width(43), None, "variable suffix is not fixed-width");
    }

    /// A truncated / desynced state is refused (skip), never partially decoded.
    #[test]
    fn truncated_state_is_refused() {
        assert!(decode_vehicle_build(7, &[], (15, 9, 0)).is_none());
        assert!(decode_vehicle_build(7, &[0; 5], (15, 9, 0)).is_none());
        // A well-formed length prefix whose declared payload is empty is not a
        // 54-property state.
        let mut state = Vec::new();
        state.extend_from_slice(&0u32.to_le_bytes());
        state.push(0);
        assert!(decode_vehicle_build(7, &state, (15, 9, 0)).is_none());
    }
}
