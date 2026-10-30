//! E24 ship weapon attributes — the routing input the fire MoE gate reads.
//!
//! The table is derived from the gameparams pack by
//! `scripts/experiments/build_ship_attributes.py` and tracked in the repo as
//! `scripts/experiments/ship_attributes.json`. Training featurizes rows into
//! a 10-wide vector ([`row_attr_vector`]); this module mirrors that
//! featurization EXACTLY — a drift between the two sides silently degrades
//! the gate instead of failing, so the scales are kept in one place here
//! (and asserted by the unit tests against known ships).
//!
//! Layout (must match the Python `row_attr_vector`):
//!     [0] own concealment km / 20
//!     [1] own smoke-firing detect km / 5
//!     [2] own main-battery range m / 30000
//!     [3] own torpedo range m / 20000
//!     [4] own radar flag
//!     [5] own hydro flag
//!     [6] friends mean main-battery range m / 30000
//!     [7] friends mean concealment km / 20
//!     [8] enemies mean main-battery range m / 30000
//!     [9] enemies mean concealment km / 20
//!
//! Unknown ship ids get the neutral mid profile `[0.5, 0.0, 0.5, 0.0, 0.0,
//! 0.0]` — NOT zeros, which would read as "minimum concealment, no guns".

use anyhow::{anyhow, bail};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Width of the routing input (the training script's `ATTR_DIM`).
pub const ATTR_DIM: usize = 10;

/// Per-ship weapon attributes in the raw table's units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShipAttrs {
    /// Surface detect range, km.
    pub vis_km: f32,
    /// Detect range while firing from smoke, km.
    pub vis_smoke_km: f32,
    /// Main-battery range, m.
    pub mb_range_m: f32,
    /// Torpedo range, m.
    pub torp_range_m: f32,
    /// Surveillance radar consumable present.
    pub has_radar: bool,
    /// Hydrophone / sonar consumable present.
    pub has_hydro: bool,
}

impl ShipAttrs {
    /// The neutral profile for an unidentified hull.
    pub const NEUTRAL: ShipAttrs = ShipAttrs {
        vis_km: 10.0,
        vis_smoke_km: 0.0,
        mb_range_m: 15000.0,
        torp_range_m: 0.0,
        has_radar: false,
        has_hydro: false,
    };

    /// The normalized 6-wide own-ship block.
    pub fn normalized(self) -> [f32; 6] {
        [
            self.vis_km / 20.0,
            self.vis_smoke_km / 5.0,
            self.mb_range_m / 30000.0,
            self.torp_range_m / 20000.0,
            if self.has_radar { 1.0 } else { 0.0 },
            if self.has_hydro { 1.0 } else { 0.0 },
        ]
    }
}

/// shipId → attributes. Loaded from the packed `ship_attributes.json`.
#[derive(Debug, Clone, Default)]
pub struct ShipAttrTable {
    ships: HashMap<i64, ShipAttrs>,
}

impl ShipAttrTable {
    /// Parse the training-side JSON (`{"<shipId>": {"vis": ..., ...}}`).
    /// Malformed entries are a hard error: a partially-loaded table would
    /// silently route a slice of the lobby through the neutral profile.
    pub fn from_json(text: &str) -> anyhow::Result<Self> {
        let raw: serde_json::Value =
            serde_json::from_str(text).map_err(|e| anyhow!("ship attributes JSON: {e}"))?;
        let obj = raw
            .as_object()
            .ok_or_else(|| anyhow!("ship attributes JSON: expected an object of shipId → attrs"))?;
        let mut ships = HashMap::with_capacity(obj.len());
        for (key, v) in obj {
            let ship_id: i64 = key
                .parse()
                .map_err(|_| anyhow!("ship attributes: '{key}' is not a numeric shipId"))?;
            let o = v
                .as_object()
                .ok_or_else(|| anyhow!("ship attributes: ship {ship_id} is not an object"))?;
            let num = |name: &str| -> anyhow::Result<f32> {
                o.get(name)
                    .and_then(|x| x.as_f64())
                    .map(|x| x as f32)
                    .ok_or_else(|| {
                        anyhow!("ship attributes: ship {ship_id} lacks numeric '{name}'")
                    })
            };
            let flag = |name: &str| -> anyhow::Result<bool> {
                match o.get(name).and_then(|x| x.as_f64()) {
                    Some(x) => Ok(x > 0.5),
                    None => bail!("ship attributes: ship {ship_id} lacks numeric '{name}'"),
                }
            };
            ships.insert(
                ship_id,
                ShipAttrs {
                    vis_km: num("vis")?,
                    vis_smoke_km: num("visSmoke")?,
                    mb_range_m: num("mbRange")?,
                    torp_range_m: num("torpRange")?,
                    has_radar: flag("hasRadar")?,
                    has_hydro: flag("hasHydro")?,
                },
            );
        }
        if ships.is_empty() {
            bail!("ship attributes table is empty");
        }
        Ok(Self { ships })
    }

    /// The attributes for one hull, or the neutral profile when unknown.
    pub fn of(&self, ship_id: Option<i64>) -> ShipAttrs {
        ship_id
            .and_then(|id| self.ships.get(&id).copied())
            .unwrap_or(ShipAttrs::NEUTRAL)
    }

    /// Own 6 dims + 4 team-composition dims, mirroring the Python
    /// `row_attr_vector`. `friends`/`enemies` are the row's slots; only
    /// their `ship_id` matters.
    pub fn row_attr_vector(
        &self,
        own_ship_id: Option<i64>,
        friends: impl IntoIterator<Item = Option<i64>>,
        enemies: impl IntoIterator<Item = Option<i64>>,
    ) -> [f32; ATTR_DIM] {
        let own = self.of(own_ship_id);
        let mut fr_r = 0.0f32;
        let mut fr_v = 0.0f32;
        let mut fr_n = 0u32;
        for sid in friends {
            let a = self.of(sid);
            fr_r += a.mb_range_m / 30000.0;
            fr_v += a.vis_km / 20.0;
            fr_n += 1;
        }
        let mut en_r = 0.0f32;
        let mut en_v = 0.0f32;
        let mut en_n = 0u32;
        for sid in enemies {
            let a = self.of(sid);
            en_r += a.mb_range_m / 30000.0;
            en_v += a.vis_km / 20.0;
            en_n += 1;
        }
        if fr_n > 0 {
            fr_r /= fr_n as f32;
            fr_v /= fr_n as f32;
        }
        if en_n > 0 {
            en_r /= en_n as f32;
            en_v /= en_n as f32;
        }
        let own6 = own.normalized();
        [
            own6[0], own6[1], own6[2], own6[3], own6[4], own6[5], fr_r, fr_v, en_r, en_v,
        ]
    }
}

/// The tracked table, embedded at compile time. Kept in sync by the build
/// script (`scripts/experiments/build_ship_attributes.py`); the pack file
/// overrides it when the decisions pack carries a newer one.
pub const EMBEDDED_SHIP_ATTRIBUTES: &str =
    include_str!("../../../../../scripts/experiments/ship_attributes.json");

static EMBEDDED_TABLE: OnceLock<anyhow::Result<ShipAttrTable>> = OnceLock::new();

/// The repo-tracked table, parsed once per process. A parse failure is
/// sticky (and impossible short of the tracked file regressing — the unit
/// tests parse the same bytes).
pub fn embedded_table() -> anyhow::Result<&'static ShipAttrTable> {
    EMBEDDED_TABLE
        .get_or_init(|| ShipAttrTable::from_json(EMBEDDED_SHIP_ATTRIBUTES))
        .as_ref()
        .map_err(|e| anyhow!("{e}"))
}

/// Build the routing vector for one decision row out of the EMBEDDED
/// table: own ship + the row's friend/enemy slots, slot-for-slot what the
/// training featurization saw. This is the single wiring point every
/// attrs-capable inference path uses.
pub fn embedded_row_vector(
    own_ship_id: Option<i64>,
    friends: &[super::fire_dataset::FireDatasetSlot],
    enemies: &[super::fire_dataset::FireDatasetSlot],
) -> anyhow::Result<[f32; ATTR_DIM]> {
    let t = embedded_table()?;
    Ok(t.row_attr_vector(
        own_ship_id,
        friends.iter().map(|s| s.ship_id),
        enemies.iter().map(|s| s.ship_id),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> ShipAttrTable {
        ShipAttrTable::from_json(EMBEDDED_SHIP_ATTRIBUTES).expect("embedded table parses")
    }

    #[test]
    fn embedded_table_covers_the_roster() {
        let t = table();
        assert!(
            t.ships.len() > 1000,
            "expected the full roster, got {}",
            t.ships.len()
        );
        // The E24 liveness property: torpedo and smoke-firing columns are
        // populated (the first table shipped them all-zero).
        assert!(t.ships.values().any(|a| a.torp_range_m > 0.0));
        assert!(t.ships.values().any(|a| a.vis_smoke_km > 0.0));
        assert!(t.ships.values().any(|a| a.has_radar));
        assert!(t.ships.values().any(|a| a.has_hydro));
    }

    #[test]
    fn known_ship_normalizes_as_trained() {
        // PUSC997_Gambra — 11.8 km detect, 15.3 km guns, 10.0 km torpedoes.
        let t = table();
        let a = t.of(Some(3_249_452_400));
        assert!((a.vis_km - 11.8).abs() < 0.01, "vis {}", a.vis_km);
        assert!((a.mb_range_m - 15_300.0).abs() < 1.0, "mb {}", a.mb_range_m);
        assert!(
            (a.torp_range_m - 9999.9).abs() < 1.0,
            "torp {}",
            a.torp_range_m
        );
        let n = a.normalized();
        assert!((n[0] - 11.8 / 20.0).abs() < 1e-5);
        assert!((n[2] - 15_300.0 / 30000.0).abs() < 1e-5);
        assert!((n[3] - 9999.9 / 20000.0).abs() < 1e-5);
    }

    #[test]
    fn unknown_ship_uses_the_neutral_profile() {
        let t = table();
        let v = t.row_attr_vector(Some(-1), [], []);
        assert_eq!(&v[..6], &[0.5, 0.0, 0.5, 0.0, 0.0, 0.0]);
        // No friends/enemies → the composition dims stay zero.
        assert_eq!(&v[6..], &[0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn composition_dims_average_the_slots() {
        let t = table();
        let gambra = Some(3_249_452_400i64);
        let v = t.row_attr_vector(gambra, [gambra, gambra], [gambra]);
        let a = t.of(gambra);
        let want_r = a.mb_range_m / 30000.0;
        let want_v = a.vis_km / 20.0;
        assert!((v[6] - want_r).abs() < 1e-6);
        assert!((v[7] - want_v).abs() < 1e-6);
        assert!((v[8] - want_r).abs() < 1e-6);
        assert!((v[9] - want_v).abs() < 1e-6);
    }

    #[test]
    fn malformed_tables_are_rejected() {
        assert!(ShipAttrTable::from_json("{}").is_err());
        assert!(ShipAttrTable::from_json("[]").is_err());
        assert!(ShipAttrTable::from_json(r#"{"abc": {"vis": 1}}"#).is_err());
        assert!(
            ShipAttrTable::from_json(
                r#"{"123": {"vis": 1, "visSmoke": 0, "mbRange": 2, "torpRange": 0}}"#
            )
            .is_err(),
            "missing flags must fail"
        );
    }
}
