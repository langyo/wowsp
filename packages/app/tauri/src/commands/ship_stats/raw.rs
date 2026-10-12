//! The raw per-ship counters (`RawShipStats`): vortex and WG-dialect node
//! parsing, mode combination, the enriched `PlayerShipStats` projection and
//! the encyclopedia ship-name map. Split from the former single-file
//! `commands/ship_stats.rs`.

use std::fs;

use wowsp_tauri_shared::{PlayerShipStats, ShipModeBreakdown, ShipModeStats};

use super::appdata::appdata_dir_path;

/// Intermediate struct — raw WG fields before we compute winrate/avg_damage
/// and back-fill the ship name.
#[derive(Clone, Debug)]
pub(super) struct RawShipStats {
    pub(super) ship_id: i64,
    pub(super) battles: i64,
    pub(super) wins: i64,
    pub(super) damage_caused: i64,
    pub(super) frags: i64,
    pub(super) survived_battles: i64,
    pub(super) last_battle_time: i64,
    /// Total XP in randoms (WG name `xp`); 0 when not served.
    pub(super) xp: i64,
    /// Per-mode breakdown. None when no battle-type node is served at all.
    pub(super) modes: Option<ShipModeBreakdown>,
}

/// How a battle-type node spells its counter fields.
#[derive(Clone, Copy)]
enum ModeDialect {
    /// WG `/wows/ships/stats/`: `battles` / `survived_battles`.
    Wg,
    /// Vortex: `battles_count` / `survived`.
    Vortex,
}

/// Parse one battle-type node in the given dialect. None when the node is
/// absent/null or carries no battles.
fn mode_from_node(node: Option<&serde_json::Value>, dialect: ModeDialect) -> Option<ShipModeStats> {
    let v = node.filter(|v| !v.is_null())?;
    let (battles_key, survived_key) = match dialect {
        ModeDialect::Wg => ("battles", "survived_battles"),
        ModeDialect::Vortex => ("battles_count", "survived"),
    };
    let battles = v.get(battles_key).and_then(|x| x.as_i64())?;
    if battles <= 0 {
        return None;
    }
    let field = |key: &str| v.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
    let wins = field("wins");
    let damage = field("damage_dealt");
    Some(ShipModeStats {
        battles,
        wins,
        damage_caused: damage,
        frags: field("frags"),
        survived_battles: field(survived_key),
        winrate: 100.0 * wins as f32 / battles as f32,
        avg_damage: damage as f32 / battles as f32,
    })
}

/// Combine the three ranked division nodes (rank_solo/div2/div3) into one
/// ranked bucket. None when the ship has no ranked battles on any node.
fn combine_modes(parts: [Option<ShipModeStats>; 3]) -> Option<ShipModeStats> {
    let present: Vec<ShipModeStats> = parts.into_iter().flatten().collect();
    if present.is_empty() {
        return None;
    }
    let battles = present.iter().map(|m| m.battles).sum::<i64>();
    if battles <= 0 {
        return None;
    }
    let wins = present.iter().map(|m| m.wins).sum::<i64>();
    let damage = present.iter().map(|m| m.damage_caused).sum::<i64>();
    Some(ShipModeStats {
        battles,
        wins,
        damage_caused: damage,
        frags: present.iter().map(|m| m.frags).sum(),
        survived_battles: present.iter().map(|m| m.survived_battles).sum(),
        winrate: 100.0 * wins as f32 / battles as f32,
        avg_damage: damage as f32 / battles as f32,
    })
}

impl RawShipStats {
    /// Vortex per-ship node: a battle-type map whose `pvp` entry carries
    /// vortex field names and the ship id comes from the enclosing map key
    /// (the vortex transport rebuilds this shape by merging the per-mode
    /// bulk endpoints — see [`fetch_ship_stats_vortex`]). Counters absent
    /// from a node degrade to 0; XP is the base-XP total `original_exp`
    /// (see the xp read below for why the vortex `exp` is never divided by
    /// battles). No last_battle_time is served at all. Zero-pvp rows with
    /// other-mode battles keep their row — the top-level pvp counters stay
    /// 0 so the randoms view reads "never played" while the ranked/co-op
    /// buckets still answer their scopes (dropping them wholesale used to
    /// empty the ship-scoped view for every ranked-only ship and, on co-op
    /// rosters, for entire teams).
    pub(super) fn from_vortex(ship_id: i64, node: &serde_json::Value) -> Option<Self> {
        let pvp = node.get("pvp").filter(|v| !v.is_null());
        let battles = pvp
            .and_then(|p| p.get("battles_count"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let field = |node: &serde_json::Value, key: &str| {
            node.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
        };
        let solo = mode_from_node(node.get("pvp_solo"), ModeDialect::Vortex);
        let div2 = mode_from_node(node.get("pvp_div2"), ModeDialect::Vortex);
        let div3 = mode_from_node(node.get("pvp_div3"), ModeDialect::Vortex);
        let coop = mode_from_node(node.get("pve"), ModeDialect::Vortex);
        let ranked = combine_modes([
            mode_from_node(node.get("rank_solo"), ModeDialect::Vortex),
            mode_from_node(node.get("rank_div2"), ModeDialect::Vortex),
            mode_from_node(node.get("rank_div3"), ModeDialect::Vortex),
        ]);
        let any_mode = [
            solo.is_some(),
            div2.is_some(),
            div3.is_some(),
            coop.is_some(),
            ranked.is_some(),
        ]
        .iter()
        .any(|&b| b);
        if battles == 0 && !any_mode {
            return None;
        }
        // Base XP only. The vortex `exp` is the boost-multiplied total
        // (premium account + economic bonuses): measured live on the 360
        // cluster, exp/battles exceeded the node's own `max_exp` on 384
        // of 397 ships — a per-battle average above the per-battle max,
        // impossible — and rendered absurd average-XP figures for boost-heavy CN
        // players. `original_exp` is the base-XP total matching what the
        // WG realms serve as `xp`; the legacy list-endpoint spelling
        // `xp` (pre-2026 shape) was base-XP too and stays the fallback.
        let xp = pvp
            .and_then(|p| {
                p.get("original_exp")
                    .and_then(|v| v.as_i64())
                    .or_else(|| p.get("xp").and_then(|v| v.as_i64()))
            })
            .unwrap_or(0);
        Some(Self {
            ship_id,
            battles,
            wins: pvp.map(|p| field(p, "wins")).unwrap_or(0),
            damage_caused: pvp.map(|p| field(p, "damage_dealt")).unwrap_or(0),
            frags: pvp.map(|p| field(p, "frags")).unwrap_or(0),
            survived_battles: pvp.map(|p| field(p, "survived")).unwrap_or(0),
            last_battle_time: 0,
            xp,
            modes: if any_mode {
                Some(ShipModeBreakdown {
                    solo,
                    div2,
                    div3,
                    coop,
                    ranked,
                })
            } else {
                None
            },
        })
    }

    /// A `/wows/ships/stats/` array element: `ship_id` plus WG-dialect
    /// battle nodes. The endpoint stopped serving the mode-split fields
    /// live 2026-10, so the splits are usually absent — the career pvp
    /// counters and `last_battle_time` it still serves are what the racer
    /// arm lives for. Retention mirrors [`Self::from_vortex`]: zero-pvp
    /// rows with other-mode battles keep their row for the ranked/co-op
    /// scopes.
    pub(super) fn from_wg(entry: &serde_json::Value) -> Option<Self> {
        let ship_id = entry.get("ship_id").and_then(|v| v.as_i64())?;
        let pvp = entry.get("pvp").filter(|v| !v.is_null());
        let battles = pvp
            .and_then(|p| p.get("battles"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let solo = mode_from_node(entry.get("pvp_solo"), ModeDialect::Wg);
        let div2 = mode_from_node(entry.get("pvp_div2"), ModeDialect::Wg);
        let div3 = mode_from_node(entry.get("pvp_div3"), ModeDialect::Wg);
        let coop = mode_from_node(entry.get("pve"), ModeDialect::Wg);
        let ranked = combine_modes([
            mode_from_node(entry.get("rank_solo"), ModeDialect::Wg),
            mode_from_node(entry.get("rank_div2"), ModeDialect::Wg),
            mode_from_node(entry.get("rank_div3"), ModeDialect::Wg),
        ]);
        let any_mode = [
            solo.is_some(),
            div2.is_some(),
            div3.is_some(),
            coop.is_some(),
            ranked.is_some(),
        ]
        .iter()
        .any(|&b| b);
        if battles == 0 && !any_mode {
            return None;
        }
        let field = |key: &str| {
            pvp.and_then(|p| p.get(key))
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
        };
        Some(Self {
            ship_id,
            battles,
            wins: field("wins"),
            damage_caused: pvp
                .and_then(|p| p.get("damage_dealt").or_else(|| p.get("damage_caused")))
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            frags: field("frags"),
            survived_battles: field("survived_battles"),
            last_battle_time: entry
                .get("last_battle_time")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            xp: field("xp"),
            modes: if any_mode {
                Some(ShipModeBreakdown {
                    solo,
                    div2,
                    div3,
                    coop,
                    ranked,
                })
            } else {
                None
            },
        })
    }
}

impl From<&RawShipStats> for PlayerShipStats {
    fn from(r: &RawShipStats) -> Self {
        let winrate = if r.battles > 0 {
            100.0 * r.wins as f32 / r.battles as f32
        } else {
            0.0
        };
        let avg_damage = if r.battles > 0 {
            r.damage_caused as f32 / r.battles as f32
        } else {
            0.0
        };
        PlayerShipStats {
            ship_id: r.ship_id,
            name: String::new(), // back-filled by caller
            battles: r.battles,
            wins: r.wins,
            damage_caused: r.damage_caused,
            frags: r.frags,
            survived_battles: r.survived_battles,
            winrate,
            avg_damage,
            last_battle_time: r.last_battle_time,
            // Same winrate→PR anchors as the account-level card, applied to
            // this ship's randoms winrate.
            pr: Some(super::wg_api::rating_from_winrate(winrate)),
            avg_xp: if r.xp > 0 && r.battles > 0 {
                Some(r.xp as f32 / r.battles as f32)
            } else {
                None
            },
            modes: r.modes.clone(),
        }
    }
}

/// Build a { ship_id → name } map from the encyclopedia cache (best-effort:
/// returns empty map if no version cache exists yet).
pub(super) fn load_ship_name_map() -> std::collections::HashMap<i64, String> {
    let mut map = std::collections::HashMap::new();
    // Scan all versioned encyclopedia cache files.
    let dir = match appdata_dir_path() {
        Ok(d) => d.join("encyclopedia"),
        Err(_) => return map,
    };
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return map,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Skip info.json (it's the version metadata, not a ships list).
        if path.file_name().and_then(|n| n.to_str()) == Some("info.json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // CachedShips shape (we don't import the struct to avoid coupling;
        // just grab the ships array).
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(ships) = v.get("ships").and_then(|s| s.as_array()) {
                for ship in ships {
                    if let (Some(id), Some(name)) = (
                        ship.get("ship_id").and_then(|v| v.as_i64()),
                        ship.get("name").and_then(|v| v.as_str()),
                    ) {
                        map.insert(id, name.to_string());
                    }
                }
            }
        }
    }
    map
}
