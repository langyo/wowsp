//! Account-list online probes (左下角账号列表的「疑似在线」标记): one
//! batched `wows/account/info` sweep over the bound accounts, grouped per
//! realm, plus the CN vortex lean probe. Read-only — no persistence, no
//! cache; the frontend store owns the ~90s pacing and only polls while its
//! window is visible, so a poll costs at most one small request per realm.
//!
//! Semantics: the WG public API has NO per-player presence (the whole
//! method family was enumerated while speccing this — the port-idle online
//! state produces no API-visible event). The only session-level signals
//! are `last_battle_time` (bumped when a battle FINISHES) and `logout_at`
//! (bumped on logout). The badge the webui derives from this poll ("battle
//! finished within the recent window") is therefore "probably still
//! around", never a guarantee — hence the UI copy 疑似在线.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::CommandResult;

use crate::commands::network::HttpPair;
use crate::commands::wg_api::account_last_battle_times;
use crate::commands::wg_api_cn;
use crate::commands::wg_realm::{api_host, application_id};

/// One bound account to probe — the webui sends its account store verbatim.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOnlineProbe {
    pub account_id: i64,
    pub nickname: String,
    pub realm: String,
}

/// One probe answer: the freshest battle-finish timestamp the API serves
/// for the account. `None` = nothing usable this round (unknown account,
/// upstream hiccup, CN search without an exact hit) — the badge hides for
/// that account, it never means "definitely offline". The webui derives
/// the badge itself so the recency threshold stays a UI constant.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOnlineStatus {
    pub account_id: i64,
    pub realm: String,
    pub last_battle_time: Option<i64>,
    pub checked_at: i64,
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Group probes by realm, first-seen order preserved, nicknames carried so
/// the CN branch can resolve by name. Pure; unit-tested.
fn group_by_realm(probes: &[AccountOnlineProbe]) -> Vec<(String, Vec<(i64, String)>)> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: BTreeMap<String, Vec<(i64, String)>> = BTreeMap::new();
    for p in probes {
        let group = groups.entry(p.realm.clone()).or_insert_with(|| {
            order.push(p.realm.clone());
            Vec::new()
        });
        group.push((p.account_id, p.nickname.clone()));
    }
    order
        .into_iter()
        .map(|realm| {
            let rows = groups.remove(&realm).unwrap_or_default();
            (realm, rows)
        })
        .collect()
}

/// The account list's poll: read paths stay open to every window (like
/// cloud_ban_check) — it is a read-only WG poll, never a settings write.
///
/// Per-realm failures degrade that realm's rows to `last_battle_time: None`
/// instead of failing the whole poll: a transient upstream hiccup must
/// hide the badge for one round, not error-card the account list.
#[tauri::command]
pub async fn account_online_check(
    probes: Vec<AccountOnlineProbe>,
) -> CommandResult<Vec<AccountOnlineStatus>> {
    let checked_at = unix_now();
    let clients = HttpPair::build(|b| b)?;
    let mut out: Vec<AccountOnlineStatus> = Vec::with_capacity(probes.len());
    for (realm, rows) in group_by_realm(&probes) {
        // Global realms: ONE batched account/info sweep per realm. CN has
        // no WG public API (wowsgame.cn) — its accounts ride the vortex
        // lean probe, one search+info per account (bound CN accounts are a
        // handful at most). Unknown realms degrade to None like failures.
        let times: Vec<Option<i64>> = match api_host(&realm) {
            Ok(host) => {
                let app_id = application_id(&realm);
                let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
                account_last_battle_times(&clients, &app_id, host, &ids)
                    .await
                    .unwrap_or_else(|_| vec![None; ids.len()])
            },
            Err(_) if realm == "cn" => match wg_api_cn::vortex_pair() {
                Ok(pair) => {
                    let mut times = Vec::with_capacity(rows.len());
                    for (_, nickname) in &rows {
                        times.push(
                            wg_api_cn::probe_last_battle_time(&pair, nickname)
                                .await
                                .unwrap_or(None),
                        );
                    }
                    times
                },
                Err(_) => vec![None; rows.len()],
            },
            Err(_) => vec![None; rows.len()],
        };
        for ((account_id, _), last_battle_time) in rows.into_iter().zip(times) {
            out.push(AccountOnlineStatus {
                account_id,
                realm: realm.clone(),
                last_battle_time,
                checked_at,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(id: i64, name: &str, realm: &str) -> AccountOnlineProbe {
        AccountOnlineProbe {
            account_id: id,
            nickname: name.to_string(),
            realm: realm.to_string(),
        }
    }

    #[test]
    fn groups_by_realm_in_first_seen_order() {
        let g = group_by_realm(&[
            probe(1, "a", "asia"),
            probe(2, "b", "eu"),
            probe(3, "c", "asia"),
        ]);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].0, "asia");
        assert_eq!(g[0].1, vec![(1, "a".to_string()), (3, "c".to_string())]);
        assert_eq!(g[1].0, "eu");
        assert_eq!(g[1].1, vec![(2, "b".to_string())]);
    }

    #[test]
    fn probes_deserialize_camel_case() {
        let raw = r#"[{"accountId":1001,"nickname":"Someone","realm":"asia"}]"#;
        let probes: Vec<AccountOnlineProbe> = serde_json::from_str(raw).expect("parse");
        assert_eq!(probes[0].account_id, 1001);
        assert_eq!(probes[0].nickname, "Someone");
        assert_eq!(probes[0].realm, "asia");
    }

    #[test]
    fn status_serializes_camel_case() {
        let s = AccountOnlineStatus {
            account_id: 7,
            realm: "eu".to_string(),
            last_battle_time: Some(1_700_000_000),
            checked_at: 2,
        };
        let v = serde_json::to_value(&s).expect("serialize");
        assert_eq!(v["accountId"], 7);
        assert_eq!(v["realm"], "eu");
        assert_eq!(v["lastBattleTime"], 1_700_000_000);
        assert_eq!(v["checkedAt"], 2);
    }
}
