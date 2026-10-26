//! Battle-context assembly (M2 WB) — the [MatchContext] the translation
//! prompt is built from.
//!
//! One chat line is translated against a condensed picture of the battle the
//! players are in: which map/mode, which ships both teams sail, the local
//! player, and the recent chat lines. The prompt builder (`prompt.rs`) turns
//! this into a budgeted request blob; this module owns the SOURCING side and
//! nothing else — no network, no logging.
//!
//! ## Where each field comes from (contract §3)
//!
//! - `mode` / `map` / `scenario` / `started_at` / `teams` / `glossary`:
//!   the live-battle arena snapshot (`tempArenaInfo.json`, via
//!   [arena_info]'s existing reader). The arena does not carry a realm, so
//!   `realm` is the RUNNING client's realm off its own log (the same
//!   [game_detect] detector the session hub uses) — one log read per battle,
//!   not per chat line.
//! - `self_name` / `self_ship`: the arena roster's `relation == 0` row.
//! - `teams`: the arena `vehicles`, split by `relation` (`<= 1` ally,
//!   `>= 2` enemy), each side capped at [TEAM_CAP] rows; `bot` is the
//!   WG-family negative-id convention (`id < 0`).
//! - `glossary`: every distinct client-language ship name across both teams,
//!   then the map name, capped at [GLOSSARY_CAP] entries.
//! - `recent` / `targets`: passed through from the caller (the live source's
//!   recent lines and the target-language resolution) — this module never
//!   invents them.
//!
//! ## Caching
//!
//! `build` runs once per translated chat line, so the arena read, the realm
//! log scan and the roster derivation are memoized for the lifetime of ONE
//! battle: the cache is keyed by [arena_info::last_arena_stamp] and refreshed
//! only when a new battle starts (`名册变化不必刷新` — the arena file's
//! roster is written at battle load; late joins are rare and not worth a
//! per-line file read). A battle with no readable arena file (the
//! probe-synthesized / file-less client class) is memoized as "no context":
//! teams/glossary stay empty and the prompt simply omits them.
//!
//! ## Language policy
//!
//! [resolve_self_lang] answers "which language does the user READ": the
//! chat-translate settings' `languages.selfLang` when set, else the OS
//! locale narrowed onto [wowsp_tauri_shared::SUPPORTED_LANGS], else `"en"`.
//! The OS detection spawns one `reg` query on Windows, so it is resolved
//! once per process and cached.
//!
//! [add_observed_language] / [observed_languages] keep the set of languages
//! detected in the CURRENT battle (the future outgoing-target set). The set
//! is global, battle-keyed and cleared by a battle-key switch.
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::sync::{LazyLock, Mutex};

use wowsp_tauri_shared::{
    ArenaInfo, ChatTranslateConfig, MatchContext, PlayerBrief, SUPPORTED_LANGS, TeamBrief,
    VehicleEntry,
};

use super::lang::normalize_lang;
use crate::commands::{arena_info, game_context, game_detect};

/// The caller-facing name for one recent chat line carried into the prompt:
/// the shared wire shape ([wowsp_tauri_shared::RecentChatLine], `{from,text}`).
pub(crate) use wowsp_tauri_shared::RecentChatLine as RecentLine;

/// Rows kept per team in the prompt (the model needs the fleet's SHAPE, not
/// every nickname; a 12v12 plus divisions still reads completely).
const TEAM_CAP: usize = 15;

/// Prompt glossary cap: ship names (both teams) + the map, deduplicated.
const GLOSSARY_CAP: usize = 40;

/// The battle-context core, derived once per battle from the arena snapshot.
#[derive(Debug, Clone, Default, PartialEq)]
struct ArenaDerived {
    realm: Option<String>,
    mode: Option<String>,
    map: Option<String>,
    scenario: Option<String>,
    started_at: Option<i64>,
    self_name: Option<String>,
    self_ship: Option<String>,
    teams: TeamBrief,
    glossary: Vec<String>,
}

/// One memoized battle-context entry: `(arena stamp, derived)`.
type ArenaCacheEntry = (i64, Option<ArenaDerived>);

/// Memoized battle context: `None` inside the entry memoizes "this battle has
/// no readable arena" so a file-less battle does not re-walk the replay tree
/// per chat line.
static ARENA_CACHE: LazyLock<Mutex<Option<ArenaCacheEntry>>> = LazyLock::new(|| Mutex::new(None));

/// Assemble the translation-prompt context for one line.
///
/// `recent` is the live source's recent original lines (oldest first) and
/// `targets` the already-resolved target-language tags. Everything else is
/// taken from the current battle's arena snapshot, cached for that battle;
/// outside a known battle (or on a client that writes no arena file) the
/// context comes back empty and the prompt omits the battle picture.
pub(crate) fn build(recent: &[RecentLine], targets: &[String]) -> MatchContext {
    assemble(derived_for_current_battle(), recent, targets)
}

/// Pure assembly half of [build]: turn the (cached) arena derivation plus the
/// caller's slices into the shared DTO. Split out so the mapping is unit-
/// tested without touching the arena statics or the filesystem.
fn assemble(
    derived: Option<ArenaDerived>,
    recent: &[RecentLine],
    targets: &[String],
) -> MatchContext {
    let mut context = MatchContext {
        recent: recent.to_vec(),
        targets: targets.to_vec(),
        ..MatchContext::default()
    };
    if let Some(derived) = derived {
        context.realm = derived.realm;
        context.mode = derived.mode;
        context.map = derived.map;
        context.scenario = derived.scenario;
        context.started_at = derived.started_at;
        context.self_name = derived.self_name;
        context.self_ship = derived.self_ship;
        context.teams = Some(derived.teams);
        context.glossary = derived.glossary;
    }
    context
}

/// The current battle's derivation, memoized per arena stamp (see the module
/// docs). `stamp <= 0` means no battle has been seen yet: no context at all.
fn derived_for_current_battle() -> Option<ArenaDerived> {
    let stamp = arena_info::last_arena_stamp();
    if stamp <= 0 {
        return None;
    }
    {
        let cache = ARENA_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((cached_stamp, derived)) = cache.as_ref()
            && *cached_stamp == stamp
        {
            return derived.clone();
        }
    }
    let derived = read_arena_derived();
    let mut cache = ARENA_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cache = Some((stamp, derived.clone()));
    derived
}

/// One uncached arena read + derivation (the expensive half of
/// [derived_for_current_battle]: a replay-tree walk and the running client's
/// realm log scan).
fn read_arena_derived() -> Option<ArenaDerived> {
    let (arena, _raw) = arena_info::read_arena_snapshot()?;
    Some(derive(&arena, running_realm()))
}

/// The running client's realm tag ("asia", "ru", "eu", "na", "cn"), from the
/// game's own `Selected realm:` log line. Resolved through the same unified
/// install chain every live surface uses ([game_context::resolve_root] with
/// [game_context::RootPreference::PreferRunning]).
fn running_realm() -> Option<String> {
    let root = game_context::resolve_root(game_context::RootPreference::PreferRunning)?.root;
    game_detect::detect_realm(&root)
}

/// Pure arena → context mapping (contract §3's "从 arena 提取" half). The
/// caller supplies the realm (I/O-free), so this is fully unit-tested with
/// fabricated [ArenaInfo]s.
fn derive(arena: &ArenaInfo, realm: Option<String>) -> ArenaDerived {
    let mut ally: Vec<PlayerBrief> = Vec::new();
    let mut enemy: Vec<PlayerBrief> = Vec::new();
    let mut self_name: Option<String> = None;
    let mut self_ship: Option<String> = None;

    for vehicle in &arena.vehicles {
        let brief = player_brief(vehicle);
        if vehicle.relation == 0 {
            self_name = Some(vehicle.name.clone());
            self_ship = brief.ship.clone();
        }
        if vehicle.relation <= 1 {
            if ally.len() < TEAM_CAP {
                ally.push(brief);
            }
        } else if enemy.len() < TEAM_CAP {
            enemy.push(brief);
        }
    }

    let mut glossary: Vec<String> = Vec::new();
    for vehicle in &arena.vehicles {
        push_glossary(&mut glossary, vehicle.ship_name.as_deref());
    }
    push_glossary(&mut glossary, arena.map_name.as_deref());

    ArenaDerived {
        realm: non_empty(realm),
        mode: non_empty(arena.match_group.clone()),
        map: non_empty(arena.map_name.clone()),
        scenario: non_empty(arena.scenario.clone()),
        started_at: arena.date_time.as_deref().and_then(parse_started_at),
        self_name,
        self_ship,
        teams: TeamBrief { ally, enemy },
        glossary,
    }
}

/// One arena row as the prompt needs it. `ship_en`/`tier`/`class` stay
/// `None`: the arena file carries only the numeric `shipId` (no DB lookup
/// in this wave) and the probe's `shipName` is already the client-language
/// display string the model should keep verbatim.
fn player_brief(vehicle: &VehicleEntry) -> PlayerBrief {
    PlayerBrief {
        name: vehicle.name.clone(),
        ship: non_empty(vehicle.ship_name.clone()),
        ship_en: None,
        tier: None,
        class: None,
        // WG-family bots carry negative arena ids (the probe synthesis
        // preserves that convention); account ids are positive otherwise.
        bot: vehicle.id < 0,
    }
}

/// Push a non-empty proper noun into the glossary, deduplicated, capped.
fn push_glossary(glossary: &mut Vec<String>, candidate: Option<&str>) {
    let Some(term) = candidate.map(str::trim).filter(|term| !term.is_empty()) else {
        return;
    };
    if glossary.len() >= GLOSSARY_CAP || glossary.iter().any(|existing| existing == term) {
        return;
    }
    glossary.push(term.to_string());
}

/// Drop empty/whitespace-only optional strings (the arena file's empty
/// fields mean "unknown", not "an empty name").
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

/// Parse the arena file's battle-start stamp — "DD.MM.YYYY HH:MM:SS" game-
/// local time (the webui's battle clock parses the same layout; seconds are
/// optional for hand-edited captures).
fn parse_started_at(raw: &str) -> Option<i64> {
    use chrono::TimeZone;
    let naive = chrono::NaiveDateTime::parse_from_str(raw.trim(), "%d.%m.%Y %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw.trim(), "%d.%m.%Y %H:%M"))
        .ok()?;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|at| at.timestamp())
}

// ── Own-language resolution ─────────────────────────────────────────────

/// The language the user READS, as one of the canonical support tags.
///
/// Preference order: the settings' `languages.selfLang` (already canonical
/// after the config sanitize pass, normalized again so a hand-edited file
/// still lands on a supported tag), else the OS locale narrowed onto
/// [SUPPORTED_LANGS], else `"en"`. No empty result is possible: the live
/// detection (`lang.rs`) and the prompt both need a concrete own language.
pub(crate) fn resolve_self_lang(config: &ChatTranslateConfig) -> &'static str {
    if let Some(tag) = normalize_lang(&config.languages.self_lang) {
        return tag;
    }
    os_locale_lang()
}

/// The OS locale resolved once per process: [crate::os_prefs::detect] spawns
/// a `reg` query on Windows, so resolving it per chat line would be waste.
static OS_LOCALE_LANG: LazyLock<&'static str> =
    LazyLock::new(|| normalize_lang(&crate::os_prefs::detect().locale).unwrap_or("en"));

fn os_locale_lang() -> &'static str {
    *OS_LOCALE_LANG
}

// ── Observed languages per battle ───────────────────────────────────────

/// The languages the local detector has seen in the CURRENT battle — the
/// seed of a future "translate into what the battle speaks" target set.
#[derive(Debug, Default)]
pub(crate) struct ObservedLanguages {
    battle_key: String,
    langs: BTreeSet<&'static str>,
}

impl ObservedLanguages {
    /// A battle-key switch clears the set: languages from a finished battle
    /// must never leak into the next one.
    fn sync_battle(&mut self, battle_key: &str) {
        if self.battle_key != battle_key {
            self.battle_key = battle_key.to_string();
            self.langs.clear();
        }
    }

    /// Record one detected language for `battle_key`. Tags outside
    /// [SUPPORTED_LANGS] are ignored — the set exists to seed REQUEST
    /// targets, and a tag the config/API cannot carry is not one.
    pub(crate) fn add(&mut self, battle_key: &str, lang: &'static str) {
        self.sync_battle(battle_key);
        if SUPPORTED_LANGS.contains(&lang) {
            self.langs.insert(lang);
        }
    }

    /// The current battle's languages, deduplicated and sorted (deterministic
    /// target ordering for the prompt).
    pub(crate) fn get(&mut self, battle_key: &str) -> Vec<&'static str> {
        self.sync_battle(battle_key);
        self.langs.iter().copied().collect()
    }

    /// Drop the whole set (battle end).
    pub(crate) fn clear(&mut self) {
        self.battle_key.clear();
        self.langs.clear();
    }
}

/// The process-wide observed-language set (one battle at a time).
static OBSERVED_LANGUAGES: LazyLock<Mutex<ObservedLanguages>> =
    LazyLock::new(|| Mutex::new(ObservedLanguages::default()));

/// Record one detected language for the current battle.
pub(crate) fn add_observed_language(battle_key: &str, lang: &'static str) {
    OBSERVED_LANGUAGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .add(battle_key, lang);
}

/// The current battle's detected languages (empty outside a battle).
pub(crate) fn observed_languages(battle_key: &str) -> Vec<&'static str> {
    OBSERVED_LANGUAGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(battle_key)
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn vehicle(id: i64, name: &str, relation: i64, ship: Option<&str>) -> VehicleEntry {
        VehicleEntry {
            id,
            name: name.to_string(),
            relation,
            ship_id: 0,
            ship_name: ship.map(str::to_string),
        }
    }

    fn arena(vehicles: Vec<VehicleEntry>, map: Option<&str>) -> ArenaInfo {
        ArenaInfo {
            match_group: Some("pvp".to_string()),
            date_time: Some("26.10.2026 13:31:42".to_string()),
            map_name: map.map(str::to_string),
            scenario: Some("domination_3point".to_string()),
            event_type: None,
            bot_count: 0,
            scripted_unit_count: 0,
            vehicles,
            raw: serde_json::json!({}),
        }
    }

    fn recent(from: &str, text: &str) -> RecentLine {
        RecentLine {
            from: from.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn derive_splits_teams_maps_ships_and_self() {
        let info = arena(
            vec![
                vehicle(11, "langyo", 0, Some("Bismarck")),
                vehicle(12, "AllyTwo", 1, Some("Gearing")),
                vehicle(-3, ":Bot_3:", 2, Some("Shimakaze")),
                vehicle(14, "FoeFour", 3, Some("Petropavlovsk")),
            ],
            Some("15_NE_north"),
        );
        let derived = derive(&info, Some("asia".to_string()));

        assert_eq!(derived.realm.as_deref(), Some("asia"));
        assert_eq!(derived.mode.as_deref(), Some("pvp"));
        assert_eq!(derived.map.as_deref(), Some("15_NE_north"));
        assert_eq!(derived.scenario.as_deref(), Some("domination_3point"));
        assert!(derived.started_at.is_some(), "arena date_time parses");
        assert_eq!(derived.self_name.as_deref(), Some("langyo"));
        assert_eq!(derived.self_ship.as_deref(), Some("Bismarck"));

        let names = |side: &[PlayerBrief]| side.iter().map(|p| p.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&derived.teams.ally), vec!["langyo", "AllyTwo"]);
        assert_eq!(names(&derived.teams.enemy), vec![":Bot_3:", "FoeFour"]);
        assert_eq!(derived.teams.ally[0].ship.as_deref(), Some("Bismarck"));
        assert_eq!(derived.teams.ally[1].ship.as_deref(), Some("Gearing"));
        // Bot convention: the negative arena id marks the AI row.
        assert!(!derived.teams.ally[0].bot);
        assert!(derived.teams.enemy[0].bot);
        assert!(!derived.teams.enemy[1].bot);
        // The arena carries no DB-derived columns in this wave.
        assert!(derived.teams.ally[0].tier.is_none());
        assert!(derived.teams.ally[0].class.is_none());
        assert!(derived.teams.ally[0].ship_en.is_none());
        // Glossary: both teams' ship names first, then the map, deduplicated.
        assert_eq!(
            derived.glossary,
            vec![
                "Bismarck",
                "Gearing",
                "Shimakaze",
                "Petropavlovsk",
                "15_NE_north"
            ]
        );
    }

    #[test]
    fn derive_caps_each_side_at_fifteen() {
        let mut vehicles = Vec::new();
        for i in 0..20 {
            vehicles.push(vehicle(i, &format!("Ally{i}"), 1, Some("Gearing")));
        }
        for i in 0..20 {
            vehicles.push(vehicle(100 + i, &format!("Foe{i}"), 2, Some("Shimakaze")));
        }
        let derived = derive(&arena(vehicles, None), None);
        assert_eq!(derived.teams.ally.len(), TEAM_CAP);
        assert_eq!(derived.teams.enemy.len(), TEAM_CAP);
        assert_eq!(derived.teams.ally[0].name, "Ally0");
        assert_eq!(derived.teams.ally[14].name, "Ally14");
        assert_eq!(derived.teams.enemy[0].name, "Foe0");
    }

    #[test]
    fn derive_dedupes_glossary_and_caps_it() {
        // Same hull on every row: one glossary entry.
        let mut vehicles = Vec::new();
        for i in 0..24 {
            vehicles.push(vehicle(
                i,
                &format!("P{i}"),
                if i < 12 { 1 } else { 2 },
                Some("Yamato"),
            ));
        }
        let derived = derive(&arena(vehicles, Some("Okinawa")), None);
        assert_eq!(derived.glossary, vec!["Yamato", "Okinawa"]);

        // Many distinct hulls: the cap holds, the map only joins while room.
        let mut vehicles = Vec::new();
        for i in 0..45 {
            vehicles.push(vehicle(
                i,
                &format!("P{i}"),
                if i < 12 { 1 } else { 2 },
                Some(&format!("Ship{i}")),
            ));
        }
        let derived = derive(&arena(vehicles, Some("Okinawa")), None);
        assert_eq!(derived.glossary.len(), GLOSSARY_CAP);
        assert_eq!(derived.glossary[0], "Ship0");
        assert!(!derived.glossary.iter().any(|term| term == "Okinawa"));
    }

    #[test]
    fn derive_handles_missing_and_empty_fields() {
        let info = ArenaInfo {
            match_group: None,
            date_time: None,
            map_name: Some(String::new()),
            scenario: None,
            event_type: None,
            bot_count: 0,
            scripted_unit_count: 0,
            vehicles: vec![vehicle(1, "OnlyOne", 0, Some("  "))],
            raw: serde_json::json!({}),
        };
        let derived = derive(&info, Some(String::new()));
        assert!(derived.realm.is_none(), "empty realm is unknown");
        assert!(derived.mode.is_none());
        assert!(derived.map.is_none(), "empty map name is unknown");
        assert!(derived.scenario.is_none());
        assert!(derived.started_at.is_none());
        assert_eq!(derived.self_name.as_deref(), Some("OnlyOne"));
        assert!(derived.self_ship.is_none(), "blank ship name is unknown");
        assert!(derived.glossary.is_empty());
        assert_eq!(derived.teams.ally.len(), 1);
        assert!(derived.teams.enemy.is_empty());
    }

    #[test]
    fn parse_started_at_accepts_the_arena_layout() {
        let full = parse_started_at("26.10.2026 13:31:42").expect("full stamp parses");
        assert!(full > 0);
        let minute = parse_started_at("26.10.2026 13:31").expect("second-less stamp parses");
        assert_eq!(minute, full - 42);
        assert!(parse_started_at("not a timestamp").is_none());
        assert!(parse_started_at("").is_none());
    }

    #[test]
    fn assemble_without_arena_leaves_the_battle_picture_empty() {
        let recent_lines = [recent("Foe", "hello")];
        let targets = vec!["zh-CN".to_string()];
        let context = assemble(None, &recent_lines, &targets);
        assert!(context.teams.is_none());
        assert!(context.glossary.is_empty());
        assert!(context.realm.is_none());
        assert!(context.mode.is_none());
        assert!(context.map.is_none());
        assert!(context.scenario.is_none());
        assert!(context.started_at.is_none());
        assert!(context.self_name.is_none());
        // The caller's slices always ride through untouched.
        assert_eq!(context.recent, vec![recent("Foe", "hello")]);
        assert_eq!(context.targets, vec!["zh-CN".to_string()]);
    }

    #[test]
    fn assemble_with_arena_fills_the_battle_picture() {
        let derived = ArenaDerived {
            realm: Some("eu".to_string()),
            mode: Some("ranked".to_string()),
            map: Some("North".to_string()),
            scenario: Some("domination".to_string()),
            started_at: Some(1_792_496_000),
            self_name: Some("Me".to_string()),
            self_ship: Some("Gearing".to_string()),
            teams: TeamBrief {
                ally: vec![PlayerBrief {
                    name: "Me".to_string(),
                    ship: Some("Gearing".to_string()),
                    ..PlayerBrief::default()
                }],
                enemy: Vec::new(),
            },
            glossary: vec!["Gearing".to_string(), "North".to_string()],
        };
        let context = assemble(Some(derived), &[], &["ja".to_string()]);
        assert_eq!(context.realm.as_deref(), Some("eu"));
        assert_eq!(context.mode.as_deref(), Some("ranked"));
        assert_eq!(context.map.as_deref(), Some("North"));
        assert_eq!(context.self_name.as_deref(), Some("Me"));
        assert_eq!(context.self_ship.as_deref(), Some("Gearing"));
        let teams = context.teams.expect("arena teams ride the context");
        assert_eq!(teams.ally.len(), 1);
        assert!(teams.enemy.is_empty());
        assert_eq!(context.glossary, vec!["Gearing", "North"]);
        assert_eq!(context.targets, vec!["ja".to_string()]);
    }

    #[test]
    fn resolve_self_lang_prefers_config_then_os_locale() {
        let mut config = ChatTranslateConfig::default();
        // Settings value wins when present (canonical or tolerant spelling).
        config.languages.self_lang = "ja".to_string();
        assert_eq!(resolve_self_lang(&config), "ja");
        config.languages.self_lang = "zh-TW".to_string();
        assert_eq!(resolve_self_lang(&config), "zh-TW");
        config.languages.self_lang = "ja-JP".to_string();
        assert_eq!(resolve_self_lang(&config), "ja");
        // Empty settings fall back to the OS locale, narrowed to a support tag
        // (the concrete tag depends on the test machine, the CONTRACT is that
        // it is always one of the supported languages).
        config.languages.self_lang = String::new();
        let from_os = resolve_self_lang(&config);
        assert!(
            SUPPORTED_LANGS.contains(&from_os),
            "OS fallback lands on a support tag, got {from_os:?}"
        );
        // An unknown hand-edited value heals through the same OS fallback.
        config.languages.self_lang = "xx".to_string();
        assert_eq!(resolve_self_lang(&config), from_os);
    }

    #[test]
    fn observed_languages_are_battle_scoped() {
        // The public wrappers read/write ONE process-wide battle key, so this
        // test pins the whole policy on a LOCAL instance (deterministic under
        // the parallel test runner — another test switching the global key
        // would otherwise clear the set mid-assertion).
        let mut observed = ObservedLanguages::default();
        observed.add("b1", "ru");
        observed.add("b1", "th");
        assert_eq!(observed.get("b1"), vec!["ru", "th"]);
        observed.add("b2", "en");
        assert_eq!(observed.get("b2"), vec!["en"]);
        // Switching back to b1 clears b2's set — one battle at a time.
        assert!(observed.get("b1").is_empty());
        assert!(observed.get("b2").is_empty());
        observed.clear();
        assert!(observed.get("b2").is_empty());

        // Production wrappers are the global instance of that same struct;
        // their smoke check makes no ordering assumption (other tests run in
        // parallel and may switch the global battle key between the calls).
        add_observed_language("wb-test-global", "ja");
        let seen = observed_languages("wb-test-global");
        assert!(
            seen.iter().all(|lang| SUPPORTED_LANGS.contains(lang)),
            "observed tags stay inside the support table: {seen:?}"
        );
    }
}
