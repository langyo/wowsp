//! Realm → (API host, application id) resolution shared by every WG-API
//! command module (wg_api / ranked / ship_stats / encyclopedia).
//!
//! The Lesta-run RU cluster (korabli.su) split from Wargaming: the legacy
//! `api.worldofwarships.ru` now 301-redirects to the EU API *root* (path and
//! query dropped), which answers `METHOD_NOT_FOUND` for every method. Realm
//! "ru" must target `api.korabli.su` with a Lesta-registered application id —
//! WG ids are rejected there with `INVALID_APPLICATION_ID` (407).

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
                "unsupported realm '{other}' (cn not supported by WG public API)"
            ));
        },
    })
}

/// Vortex (dog-tag) host for one realm. Lesta runs its own at
/// vortex.korabli.su; it answers a 308 to a trailing-slash path, which
/// reqwest follows by default.
pub fn vortex_host(realm: &str) -> Result<&'static str, String> {
    Ok(match realm {
        "ru" => "vortex.korabli.su",
        "eu" => "vortex.worldofwarships.eu",
        "na" => "vortex.worldofwarships.com",
        "asia" => "vortex.worldofwarships.asia",
        other => {
            return Err(format!(
                "unsupported realm '{other}' (cn not supported by WG public API)"
            ));
        },
    })
}

/// Application id for one realm: the env override wins everywhere, otherwise
/// the Lesta id on "ru" and the WG id on the international realms.
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
        assert!(api_host("cn").is_err());
        assert!(api_host("xx").is_err());
    }

    #[test]
    fn vortex_host_maps_known_realms() {
        assert_eq!(vortex_host("ru").unwrap(), "vortex.korabli.su");
        assert_eq!(vortex_host("na").unwrap(), "vortex.worldofwarships.com");
        assert!(vortex_host("cn").is_err());
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
