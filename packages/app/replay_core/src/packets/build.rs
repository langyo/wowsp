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
//! `scripts/experiments/exposed_index.py` documents for client METHODS, with
//! the entity defs' Flags filter). The generated [`super::property_tables`] map
//! carries the 15.9 Vehicle list (54 entries: 43 fixed-width, 11 variable) and
//! this module reads the two payloads it needs BY NAME — `shipConfig`
//! (USER_TYPE, `u8 len + blob`) and `crewModifiersCompactParams`
//! (FIXED_DICT, inline) — so an entity-def reorder can never silently
//! mis-index them.
//!
//! Variable-width properties use the BigWorld compact encoding: unsized ARRAY =
//! `u8 count + elements`, STRING/BLOB = `u8 len + bytes`. A `0xff` length
//! escape was never observed on the reference corpus (the largest observed
//! shipConfig blob is 252 bytes), so the decoder REFUSES such an entity rather
//! than guess at the escape framing — the caller counts it as skipped.
//!
//! ## Exposed-property table (generated, not pinned constants)
//!
//! The index map drifts whenever the entity defs change, so it is NOT pinned as
//! constants here: [`super::property_tables`] is the generated per-version map
//! (script: `scripts/gen_property_tables.py`, validated offline against the
//! client's `entity_defs`), and this module resolves the two payloads BY NAME
//! plus every property's fixed/variable width from it. The era gate below still
//! pins which client versions may decode at all (15.9.x today); an unpinned
//! version/era skips build decoding and counts a diagnostic instead of guessing
//! indices.
//!
//! ## `shipConfig` binary version gates
//!
//! The binary itself is version-gated too: 13.2+ carries one extra u32 after the
//! unit slots, and 15.9 inserted one extra u32 between the color-scheme section
//! and the ability (consumable) section. The offsets are verified on 15.8.1 and
//! 15.9.0 captures; the >= 15.9 branch is the one the 30-replay reference corpus
//! exercises.
//!
//! ## `shipConfig` tail — OPEN ITEM (15.9.0, build 13357625)
//!
//! The bytes AFTER the ecoboost slot section are NOT decoded. Nothing shipped
//! consumes them yet, but a future consumer (battle-card slots? naval flag?)
//! must not guess at them. Offline calibration (2026-10-26) on this exact build
//! from two independent sources — the reference corpus' RPC create-property
//! blobs AND the in-game probe's `shipConfigDump` copies of the identical
//! serialization (byte-identical for the same ship_params_id, e.g. Pommern
//! 3761190704) — observed two u32-aligned tail shapes:
//!
//! - 16 bytes: `A, 0, 0, Z`;
//! - 48 bytes: `A, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, Z` (12 u32; the middle eight
//!   were zero in every sample).
//!
//! `A` was in 0..=30 and `Z` in 12..=62 across ~90 samples (the 48-byte shape is
//! the only one the reference replay corpus exercises, and every 48-byte sample
//! carried all 6 modernization slots; probe dumps from random battles produce
//! both). WHAT `A`/`Z`/the zero run mean (naval flag? isOwned? battle-card
//! slots? visual-customization slots?) is NOT confirmed — do not decode them
//! without a new capture experiment (a live probe dump of the parsed ShipConfig
//! object, or a client-converter decompile). The decoder stops after ecoboosts,
//! so the ambiguity cannot mis-parse any known section.

use super::property_tables::vehicle_property_table_for_version;

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

/// Raw `shipConfig` sections this module surfaces (the rest of the binary —
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

/// Skip one variable-width property the decoder does not read, keyed by its
/// entity-def NAME (the generated table supplies the index and width; the
/// payload shape still comes from the defs' type):
/// - `airDefenseTargetIds`: ARRAY<of>ARRAY<of>PLANE_ID(INT64)</of></of>
/// - `antiAirAuras`: ARRAY<of>AIR_DEFENCE_AURA{INT8 id, BOOL enabled}>
/// - `effects` / `sounds`: ARRAY<of>ENTITY_CLIENT_ACTION_STATE{INT16 id, STRING
///   name, STRING node}>
///
/// `None` = an unsupported/unpinned shape, so the caller skips the entity.
fn skip_variable_property(cursor: &mut Cursor<'_>, name: &str) -> Option<()> {
    match name {
        // airDefenseTargetIds: ARRAY<of>ARRAY<of>PLANE_ID(INT64)</of></of>
        "airDefenseTargetIds" => {
            let outer = cursor.u8()? as usize;
            for _ in 0..outer {
                let inner = cursor.u8()? as usize;
                cursor.skip(inner.checked_mul(8)?)?;
            }
            Some(())
        },
        // antiAirAuras: ARRAY<of>AIR_DEFENCE_AURA{INT8 id, BOOL enabled}>
        "antiAirAuras" => {
            let count = cursor.u8()? as usize;
            cursor.skip(count.checked_mul(2)?)
        },
        // effects / sounds: ARRAY<of>ENTITY_CLIENT_ACTION_STATE{INT16 id, STRING
        // name, STRING node}>
        "effects" | "sounds" => {
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

///
/// `state` is everything after the 38-byte EntityCreate fixed header and
/// `version` is the replay's parsed client version. Every property index and
/// width comes from the generated [`super::property_tables`] map (never magic
/// constants); the two payloads are matched BY NAME. `None` means "skip this
/// entity" (unsupported shape/version/era escape — the caller counts it); it is
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
    let table = vehicle_property_table_for_version(version)?;
    if usize::from(*state.get(4)?) != usize::from(table.count)
        || table.properties.len() != usize::from(table.count)
    {
        return None;
    }
    let mut cursor = Cursor::new(state);
    cursor.skip(5)?;
    let mut ship_config: Option<ShipConfigRaw> = None;
    let mut crew: Option<CrewModifiersRaw> = None;
    // The state lists every exposed property in ascending index order. Walk the
    // generated table: fixed-width values are skipped by their pinned width and
    // variable-width ones by NAME until both payloads are read — the trailing
    // variable properties are not needed, so the walk stops at the crew payload.
    // The two payload INDICES are used explicitly (not just their names) so the
    // table's own pins drive the walk: a regeneration that moves them trips the
    // name guard below instead of silently reading a different property.
    let ship_config_index = usize::from(table.ship_config);
    let crew_index = usize::from(table.crew_modifiers_compact_params);
    for (index, entry) in table.properties.iter().enumerate() {
        if usize::from(cursor.u8()?) != index {
            return None;
        }
        if entry.fixed_width.is_none() {
            if index == ship_config_index {
                if entry.name != "shipConfig" {
                    return None;
                }
                ship_config = Some(read_ship_config(&mut cursor, version)?);
                continue;
            }
            if index == crew_index {
                if entry.name != "crewModifiersCompactParams" {
                    return None;
                }
                crew = Some(read_crew_modifiers(&mut cursor)?);
                break;
            }
            skip_variable_property(&mut cursor, entry.name)?;
            continue;
        }
        cursor.skip(usize::from(entry.fixed_width?))?;
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

    /// Regression lock: the generated 15.9 table must keep resolving the two
    /// build payloads at the indices the wire format was captured on (47/48).
    /// An entity-def regeneration that moves them fails loudly here instead of
    /// silently decoding a different property as shipConfig.
    #[test]
    fn property_table_pins_the_15_9_build_payload_indices() {
        let table = super::super::property_tables::vehicle_property_table_for_version((15, 9, 0))
            .expect("15.9 Vehicle property table is pinned");
        assert_eq!(table.count, 54, "15.9 Vehicle exposed-property count");
        assert_eq!(table.properties.len(), usize::from(table.count));
        assert_eq!(table.ship_config, 47, "shipConfig exposed index");
        assert_eq!(
            table.crew_modifiers_compact_params, 48,
            "crewModifiersCompactParams exposed index"
        );
        assert_eq!(table.properties[47].name, "shipConfig");
        assert_eq!(table.properties[48].name, "crewModifiersCompactParams");
        // The fixed/variable split the create-state walk relies on: the 43
        // fixed-width properties precede every variable-width one (the stable
        // sort by wire size keeps XML order among equal-size entries).
        assert_eq!(
            table
                .properties
                .iter()
                .position(|entry| entry.fixed_width.is_none()),
            Some(43)
        );
        assert!(
            table.properties[..43]
                .iter()
                .all(|entry| entry.fixed_width.is_some())
        );
        assert!(
            table.properties[43..]
                .iter()
                .all(|entry| entry.fixed_width.is_none())
        );
    }

    /// The selector resolves patches within the pinned era and refuses another
    /// era — the caller then skips build decoding entirely (counts a skip).
    #[test]
    fn property_table_selector_is_era_scoped() {
        assert!(
            super::super::property_tables::vehicle_property_table_for_version((15, 9, 0)).is_some()
        );
        assert!(
            super::super::property_tables::vehicle_property_table_for_version((15, 9, 7)).is_some()
        );
        assert!(
            super::super::property_tables::vehicle_property_table_for_version((15, 8, 1)).is_none()
        );
        assert!(
            super::super::property_tables::vehicle_property_table_for_version((16, 0, 0)).is_none()
        );
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
