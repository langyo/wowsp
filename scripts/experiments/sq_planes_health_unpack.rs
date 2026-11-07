//! Unpack helper for the u64 carried by `receive_squadronPlanesHealth`
//! (PLANE_ID, UINT64) — the per-plane health of a WoWS squadron.
//!
//! Packing (solved empirically on the 14.5.0 reference capture
//! 20250708_192303_PJSA108-Shokaku — 815 synchronized packed/float samples
//! over 167 squadrons with 0 violations; see
//! scripts/experiments/sq_planes_health.md for the full evidence):
//!
//! * 3 bits (one octal digit) per **flying** plane, plane 0 = least
//!   significant digit; digit count = number of planes currently flying.
//! * digit `1` (2^0) = plane HP above 3/4 of its maximum (full),
//!   digit `2` (2^1) = HP in (1/4, 3/4] (damaged),
//!   digit `4` (2^2) = HP at or below 1/4 (critical).
//!   No other digit value occurs on the capture; dead slots are simply
//!   absent (the integer truncates trailing zero slots), and every observed
//!   `receive_planeDeath` index equals `digit_count - 1` at that moment,
//!   i.e. a death removes the top digit.
//! * The companion float `receive_squadronHealth` equals
//!   sum(plane HP) / numPlanes-at-spawn (`addSquadron` arg byte 18 — NOT
//!   totalNumPlanes: partial-hangar launches exist), which is what pinned
//!   the 3/4 and 1/4 band edges.
//! * `receive_addSquadron`'s trailing u64 planeHealth uses the same
//!   encoding.
//!
//! This file is deliberately dependency-free (no serde, no repo types) so it
//! can be dropped into place as-is; add derives at the destination. Run the
//! tests standalone with `rustc --edition 2021 --test <file> && ./sq_planes_health_unpack`.

/// Per-plane health band decoded from one 3-bit field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaneHealthBand {
    /// HP above 3/4 of the plane's maximum.
    Full,
    /// HP in (1/4, 3/4].
    Damaged,
    /// HP at or below 1/4.
    Critical,
}

/// Bits per plane field in the packed u64.
pub const PLANE_HEALTH_BITS: u32 = 3;
/// Largest squadron that still fits the u64 (21 × 3 = 63 bits).
pub const MAX_SQUADRON_PLANES: usize = 21;

/// Split the packed u64 into raw 3-bit fields, plane 0 first (least
/// significant). Trailing zero fields (non-flying slots) are dropped by the
/// wire format itself, so the returned length is the flying-plane count and
/// no `0` entries occur on well-formed captures.
pub fn squadron_planes_health_digits(packed: u64) -> Vec<u8> {
    let mut digits = Vec::new();
    let mut v = packed;
    while v != 0 {
        digits.push((v & 7) as u8);
        v >>= PLANE_HEALTH_BITS;
    }
    digits
}

/// Map one raw 3-bit field to its health band. Only {1, 2, 4} were ever
/// observed; anything else returns `None` so a future format change surfaces
/// as missing data instead of a plausible-but-wrong label.
pub fn plane_health_band(digit: u8) -> Option<PlaneHealthBand> {
    match digit {
        1 => Some(PlaneHealthBand::Full),
        2 => Some(PlaneHealthBand::Damaged),
        4 => Some(PlaneHealthBand::Critical),
        _ => None,
    }
}

/// Full unpack: per-plane health bands, plane 0 first. Index in the returned
/// Vec is the plane index (the same index space `receive_planeDeath`'s dead
/// array uses at the moment of death).
pub fn unpack_squadron_planes_health(packed: u64) -> Vec<Option<PlaneHealthBand>> {
    squadron_planes_health_digits(packed)
        .iter()
        .map(|&d| plane_health_band(d))
        .collect()
}

/// Inverse of [`unpack_squadron_planes_health`] for round-tripping fixtures.
pub fn pack_squadron_planes_health(bands: &[PlaneHealthBand]) -> u64 {
    let mut packed: u64 = 0;
    for (slot, band) in bands.iter().enumerate() {
        let digit = match band {
            PlaneHealthBand::Full => 1u64,
            PlaneHealthBand::Damaged => 2,
            PlaneHealthBand::Critical => 4,
        };
        packed |= digit << (PLANE_HEALTH_BITS * slot as u32);
    }
    packed
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: Option<PlaneHealthBand> = Some(PlaneHealthBand::Full);
    const DAMAGED: Option<PlaneHealthBand> = Some(PlaneHealthBand::Damaged);
    const CRITICAL: Option<PlaneHealthBand> = Some(PlaneHealthBand::Critical);

    /// 8590780220 t=30.78 — 10 healthy planes (paramsId 4076830416, hp 1.0):
    /// ten octal ones, the wire's repeating-0x249 signature.
    #[test]
    fn ten_full_planes() {
        assert_eq!(
            unpack_squadron_planes_health(0x0000_0000_0924_9249),
            vec![FULL; 10]
        );
    }

    /// 8590780220 melt: each death drops the top digit, damage re-appears on
    /// the new top plane (t=109.10 → 114.38, planeDeath[5] at 114.38).
    #[test]
    fn damage_walks_then_death_drops_top() {
        assert_eq!(
            unpack_squadron_planes_health(0x0000_0000_0001_1249), // t=109.10
            vec![FULL, FULL, FULL, FULL, FULL, DAMAGED]
        );
        assert_eq!(
            unpack_squadron_planes_health(0x0000_0000_0002_1249), // t=112.79
            vec![FULL, FULL, FULL, FULL, FULL, CRITICAL]
        );
        assert_eq!(
            unpack_squadron_planes_health(0x0000_0000_0000_1249), // t=114.38
            vec![FULL; 5]
        );
    }

    /// 8590780230 t=104.49 — the mystery post-planeDeath sample: 12 planes
    /// with plane 11 at HP 0.7456 (float 0.9788 × 12 − 11): a plain damaged
    /// band, no post-death anomaly (the 104.09 planeDeath was another
    /// squadron entirely).
    #[test]
    fn twelve_planes_one_damaged() {
        assert_eq!(
            unpack_squadron_planes_health(0x4_4924_9249),
            [vec![FULL; 11], vec![DAMAGED]].concat()
        );
    }

    /// 4410932258630 t=980.35 — three planes damaged at once (slots 0/2/4),
    /// slot 5 critical: multiple simultaneous non-full bands.
    #[test]
    fn multiple_damaged_planes() {
        assert_eq!(
            unpack_squadron_planes_health(0x2_228a),
            vec![DAMAGED, FULL, DAMAGED, FULL, DAMAGED, CRITICAL]
        );
    }

    /// Single-plane patrol fighter 214749210410 t=104.09: a healthy lone
    /// plane is [Full] — digit 1 is the FULL band, not "1 HP left".
    #[test]
    fn single_plane_full() {
        assert_eq!(unpack_squadron_planes_health(0x1), vec![FULL]);
    }

    /// 2-plane catapult fighter 42950518588 t=42.37 (hp 1.0): the lead's
    /// "single-plane" squadron is actually a pair.
    #[test]
    fn two_plane_catapult_fighter() {
        assert_eq!(unpack_squadron_planes_health(0x9), vec![FULL, FULL]);
    }

    /// Partial-hangar launch 1108102407996 (6 of 10 flying): mid-melt state
    /// t=372.96 = [critical, damaged, damaged] (hp 0.1868 × 6 = 1.12 =
    /// 0.2 + 0.46 + 0.46, band-consistent).
    #[test]
    fn partial_launch_melt() {
        assert_eq!(
            unpack_squadron_planes_health(0x94),
            vec![CRITICAL, DAMAGED, DAMAGED]
        );
    }

    /// Heal tug-of-war 2207614035772 t=683.92 vs 684.23: the same plane
    /// flips Damaged↔Full across the 3/4 threshold while its heal consumable
    /// fights continuous AA (float 0.7808 vs 0.7689 × 10).
    #[test]
    fn heal_flips_band_back() {
        assert_eq!(
            unpack_squadron_planes_health(0x44_9249), // t=683.92
            vec![FULL, FULL, FULL, FULL, FULL, FULL, FULL, DAMAGED]
        );
        assert_eq!(
            unpack_squadron_planes_health(0x24_9249), // t=684.23
            vec![FULL; 8]
        );
    }

    /// Unknown digits surface as None instead of a guessed band.
    #[test]
    fn unknown_digit_is_none() {
        assert_eq!(plane_health_band(0), None);
        assert_eq!(plane_health_band(3), None);
        assert_eq!(plane_health_band(7), None);
        assert_eq!(unpack_squadron_planes_health(0x3), vec![None]);
    }

    /// Empty squadron (0 = no flying planes, e.g. post-deactivation).
    #[test]
    fn empty_squadron() {
        assert!(unpack_squadron_planes_health(0).is_empty());
    }

    /// Round-trip over every corpus-shaped fixture.
    #[test]
    fn pack_round_trip() {
        let fixtures = [
            0x0u64,
            0x1,
            0x9,
            0x249,
            0x1249,
            0x11249,
            0x21249,
            0x4249,
            0x9249,
            0x249_249,
            0x0924_9249,
            0x449_2492_49,
            0x449_2492_89,
            0x94,
            0x2_228a,
            0x2492_4924_9, // 12 full planes
        ];
        for &f in &fixtures {
            let bands: Vec<PlaneHealthBand> = unpack_squadron_planes_health(f)
                .into_iter()
                .map(|b| b.expect("corpus fixture uses only known digits"))
                .collect();
            assert_eq!(pack_squadron_planes_health(&bands), f, "fixture {f:x}");
        }
        // 21 planes (63 bits) still pack; that is the capacity ceiling.
        let max_bands = vec![PlaneHealthBand::Full; MAX_SQUADRON_PLANES];
        assert_eq!(pack_squadron_planes_health(&max_bands).count_ones(), 21);
    }
}
