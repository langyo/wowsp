//! Realm → (API host, application id) resolution shared by every WG-API
//! command module (wg_api / ranked / ship_stats / encyclopedia).
//!
//! The Lesta-run RU cluster (korabli.su) split from Wargaming: the legacy
//! `api.worldofwarships.ru` now 301-redirects to the EU API *root* (path and
//! query dropped), which answers `METHOD_NOT_FOUND` for every method. Realm
//! "ru" must target `api.korabli.su` with a Lesta-registered application id —
//! WG ids are rejected there with `INVALID_APPLICATION_ID` (407).
//!
//! The CN cluster (wowsgame.cn, operated by 360) never joined the WG
//! developer program: there is no `/wows/**` public API for it. Its stats are
//! served by the vortex endpoints backing profile.wowsgame.cn, so the WG-API
//! modules route realm "cn" through `wg_api_cn` instead; only the vortex and
//! clans hosts exist for it here.

/// Public WG application id (from ApeRadar's open source — rate-limited per
/// IP, not secret). Override with the `WOWSP_WG_APPLICATION_ID` env var.
pub const WG_APP_ID: &str = "447ec579e994976e39dec0e7d0bac644";

/// Lesta-registered application id for the RU cluster (the public id the
/// community clients document — client-side use, rate-limited per IP, not
/// secret). Also overridable via `WOWSP_WG_APPLICATION_ID`.
pub const LESTA_APP_ID: &str = "c984faa7dc529f4cb0139505d5e8043c";

/// Full API host for one realm. Callers build request URLs as
/// `https://{host}/wows/<method>/`.
pub fn api_host(realm: &str) -> Result<&'static str, String> {
    Ok(match realm {
        "ru" => "api.korabli.su",
        "eu" => "api.worldofwarships.eu",
        "na" => "api.worldofwarships.com",
        "asia" => "api.worldofwarships.asia",
        other => {
            return Err(format!(
                "unsupported realm '{other}' (cn has no WG public API and is served by the vortex endpoints; expected one of ru/eu/na/asia/cn)"
            ));
        },
    })
}

/// Vortex host for one realm. Lesta runs its own at
/// vortex.korabli.su; it answers a 308 to a trailing-slash path, which
/// reqwest follows by default. The CN cluster only exposes vortex (see the
/// module docs) — its host backs profile.wowsgame.cn and is consumed by
/// `wg_api_cn`.
pub fn vortex_host(realm: &str) -> Result<&'static str, String> {
    Ok(match realm {
        "ru" => "vortex.korabli.su",
        "eu" => "vortex.worldofwarships.eu",
        "na" => "vortex.worldofwarships.com",
        "asia" => "vortex.worldofwarships.asia",
        "cn" => "vortex.wowsgame.cn",
        other => {
            return Err(format!(
                "unsupported realm '{other}' (expected one of ru/eu/na/asia/cn)"
            ));
        },
    })
}

/// Clans host for the CN cluster (the clanbase/members endpoints backing
/// clans.wowsgame.cn). Only meaningful for realm "cn" — every other realm
/// resolves clan data through the WG public API instead.
pub fn cn_clans_host() -> &'static str {
    "clans.wowsgame.cn"
}

/// Host serving encyclopedia content for a realm. Ship IDs and encyclopedia
/// payloads are identical cluster-wide, but the CN cluster has no
/// `/wows/encyclopedia/**` endpoint, so its queries are served from the ASIA
/// API (same convention `get_game_version` already hardcodes).
pub fn encyclopedia_host(realm: &str) -> Result<&'static str, String> {
    api_host(if realm == "cn" { "asia" } else { realm })
}

/// Application id for one realm: the env override wins everywhere, otherwise
/// the Lesta id on "ru" and the WG id on the international realms.
///
/// These are WG public API application ids — client-side public identifiers
/// issued by Wargaming (resp. Lesta) for their open API, designed to be
/// embedded in client applications; NOT credentials/secrets (the open API
/// is rate-limited per IP instead of per-key auth). See
/// <https://developers.wargaming.net/> for registration.
///
/// [`WG_APP_ID`] is this repo's only Wargaming application id; the same value
/// is hardcoded twice in `scripts/extract/build_planner_data.py` (offline
/// planner bundle build) — keep the copies in sync. Registration & rotation:
/// the id originates from ApeRadar's open-source client (see the README
/// acknowledgement), not from a registration held by this project; an
/// application record for a self-registered replacement id is still pending
/// (申请记录待补). Rotation needs no release — `WOWSP_WG_APPLICATION_ID`
/// swaps either id at runtime.
pub fn application_id(realm: &str) -> String {
    std::env::var("WOWSP_WG_APPLICATION_ID").unwrap_or_else(|_| {
        if realm == "ru" {
            LESTA_APP_ID
        } else {
            WG_APP_ID
        }
        .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_host_maps_known_realms() {
        assert_eq!(api_host("ru").unwrap(), "api.korabli.su");
        assert_eq!(api_host("eu").unwrap(), "api.worldofwarships.eu");
        assert_eq!(api_host("na").unwrap(), "api.worldofwarships.com");
        assert_eq!(api_host("asia").unwrap(), "api.worldofwarships.asia");
        // The CN cluster has no /wows/** public API — only vortex serves it.
        assert!(api_host("cn").is_err());
        assert!(api_host("xx").is_err());
    }

    #[test]
    fn vortex_host_maps_known_realms() {
        assert_eq!(vortex_host("ru").unwrap(), "vortex.korabli.su");
        assert_eq!(vortex_host("na").unwrap(), "vortex.worldofwarships.com");
        assert_eq!(vortex_host("cn").unwrap(), "vortex.wowsgame.cn");
    }

    #[test]
    fn encyclopedia_host_serves_cn_from_asia() {
        assert_eq!(
            encyclopedia_host("cn").unwrap(),
            encyclopedia_host("asia").unwrap()
        );
        // Non-CN realms keep their own host.
        assert_eq!(encyclopedia_host("eu").unwrap(), api_host("eu").unwrap());
    }

    #[test]
    fn application_id_picks_lesta_on_ru() {
        // The fallback path is only asserted when the dev shell doesn't
        // export an override (the env var intentionally wins in that case).
        if std::env::var_os("WOWSP_WG_APPLICATION_ID").is_none() {
            assert_eq!(application_id("ru"), LESTA_APP_ID);
            assert_eq!(application_id("eu"), WG_APP_ID);
        }
    }
}
