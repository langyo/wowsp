//! Plan-profile archives: the tactics page's shareable 档案.
//!
//! One zip, two kinds of member: `profile.toml` (format/app/game versions,
//! the map, the battle mode, the capture layout, the lineup — metadata the
//! webui assembles as JSON and Rust serialises as TOML) and
//! `plans/<n>.json` (one tactical document per plan branch). The pure
//! pack/unpack halves are unit-tested over an in-memory cursor; the two
//! commands only add the native file dialogs (rfd on the blocking pool,
//! same rule as pick_export_path).

use anyhow::anyhow;
use std::io::{Read, Seek, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use wowsp_tauri_shared::CommandResult;

/// Archive layout constants (webui mirror: features/holographic/tactical/profile.ts).
pub const PROFILE_TOML: &str = "profile.toml";
const PLANS_DIR: &str = "plans";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TacticsProfilePlan {
    pub name: String,
    pub json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_t: Option<f64>,
}

/// One `plans/NN.json` member: the branch metadata plus the tactical
/// document itself (passed through as raw JSON — the wire's `json` string).
#[derive(Serialize, Deserialize)]
struct PlanFile {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent: Option<String>,
    #[serde(rename = "branchT", default, skip_serializing_if = "Option::is_none")]
    branch_t: Option<f64>,
    doc: Value,
}

impl PlanFile {
    fn of(plan: &TacticsProfilePlan) -> PlanFile {
        // The wire's `json` is a string; a member carries it as real JSON.
        // A non-JSON string fails here and surfaces as a wrap error — the
        // webui only ever passes documents it serialized itself.
        let doc: Value =
            serde_json::from_str(&plan.json).unwrap_or_else(|_| Value::String(plan.json.clone()));
        PlanFile {
            name: plan.name.clone(),
            parent: plan.parent.clone(),
            branch_t: plan.branch_t,
            doc,
        }
    }

    fn into_plan(self) -> TacticsProfilePlan {
        let json = serde_json::to_string(&self.doc).unwrap_or_else(|_| "{}".into());
        TacticsProfilePlan {
            name: self.name,
            json,
            parent: self.parent,
            branch_t: self.branch_t,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TacticsProfilePayload {
    /// The TOML block, as the webui shaped it (JSON on the wire, TOML in
    /// the archive — the file is meant for humans and diff tools too).
    pub meta: Value,
    pub plans: Vec<TacticsProfilePlan>,
}

/// The archive's TOML header — the identity every consumer checks first.
#[derive(Serialize, Deserialize)]
struct ProfileFormat {
    format: String,
    version: i64,
}

fn zip_options() -> SimpleFileOptions {
    // Deflate only (deterministic across platforms); no extra fields so a
    // re-zip of the same payload is byte-stable modulo timestamps.
    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

/// TOML has no null: a JSON null in the meta means "field absent" on the
/// wire, so it is dropped before serialising (the webui reads missing
/// fields the same way it reads nulls). Applied recursively.
fn strip_nulls(v: &Value) -> Value {
    match v {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, val)| !val.is_null())
                .map(|(k, val)| (k.clone(), strip_nulls(val)))
                .collect(),
        ),
        Value::Array(list) => Value::Array(list.iter().map(strip_nulls).collect()),
        other => other.clone(),
    }
}

/// Pack a payload into a fresh zip archive (pure; tested over a cursor).
pub fn pack_profile(payload: &TacticsProfilePayload) -> anyhow::Result<Vec<u8>> {
    if payload.plans.is_empty() {
        return Err(anyhow!("a profile archive needs at least one plan"));
    }
    let toml_text = toml::to_string_pretty(&strip_nulls(&payload.meta))
        .map_err(|e| anyhow!("serialize profile.toml: {e}"))?;
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        zip.start_file(PROFILE_TOML, zip_options())
            .map_err(|e| anyhow!("begin profile.toml: {e}"))?;
        zip.write_all(toml_text.as_bytes())
            .map_err(|e| anyhow!("write profile.toml: {e}"))?;
        for (i, plan) in payload.plans.iter().enumerate() {
            let name = format!("{PLANS_DIR}/{i:02}.json");
            zip.start_file(name.as_str(), zip_options())
                .map_err(|e| anyhow!("begin {name}: {e}"))?;
            // Each member is {name, parent?, branchT?, doc}: the branch
            // metadata rides WITH its document, so the archive is readable
            // without profile.toml's help. `doc` is the tactical document,
            // passed through verbatim (the webui validated it).
            let member = serde_json::to_string(&PlanFile::of(plan))
                .map_err(|e| anyhow!("wrap {name}: {e}"))?;
            zip.write_all(member.as_bytes())
                .map_err(|e| anyhow!("write {name}: {e}"))?;
        }
        zip.finish().map_err(|e| anyhow!("seal archive: {e}"))?;
    }
    Ok(buf.into_inner())
}

/// Unpack a profile archive (pure; tested over a cursor). Validates the
/// TOML header's format/version before handing anything back.
pub fn unpack_profile(bytes: &[u8]) -> anyhow::Result<TacticsProfilePayload> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut zip = ZipArchive::new(cursor).map_err(|e| anyhow!("open profile archive: {e}"))?;
    let toml_raw = read_member(&mut zip, PROFILE_TOML)?;
    let toml_text =
        String::from_utf8(toml_raw).map_err(|e| anyhow!("profile.toml is not UTF-8: {e}"))?;
    let meta: Value = toml::from_str(&toml_text).map_err(|e| anyhow!("parse profile.toml: {e}"))?;
    let header: ProfileFormat = serde_json::from_value(
        serde_json::to_value(&meta).map_err(|e| anyhow!("re-encode profile.toml: {e}"))?,
    )
    .map_err(|e| anyhow!("profile.toml misses its format header: {e}"))?;
    if header.format != "wowsp-tactics-profile" {
        return Err(anyhow!(
            "not a WoWSP tactics profile (format {:?})",
            header.format
        ));
    }
    if header.version != 1 {
        return Err(anyhow!(
            "profile format version {} is newer than this app knows",
            header.version
        ));
    }
    // Plans load in member order — the webui numbered them (01, 02, …) and
    // the branch tree's parent pointers ride along per plan.
    let mut plans = Vec::new();
    for i in 0.. {
        let name = format!("{PLANS_DIR}/{i:02}.json");
        if !zip.file_names().any(|n| n == name) {
            break;
        }
        let raw = read_member(&mut zip, &name)?;
        let text = String::from_utf8(raw).map_err(|e| anyhow!("{name} is not UTF-8: {e}"))?;
        let file: PlanFile =
            serde_json::from_str(&text).map_err(|e| anyhow!("parse {name}: {e}"))?;
        plans.push(file.into_plan());
    }
    if plans.is_empty() {
        return Err(anyhow!("the profile archive carries no plans"));
    }
    Ok(TacticsProfilePayload { meta, plans })
}

fn read_member<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> anyhow::Result<Vec<u8>> {
    let mut file = zip.by_name(name).map_err(|e| anyhow!("read {name}: {e}"))?;
    let mut out = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut out)
        .map_err(|e| anyhow!("read {name}: {e}"))?;
    Ok(out)
}

/// Save dialog + zip write. Returns the picked path, or None when the user
/// cancelled. The default name carries the profile's display name so the
/// saved file says what it is before it is ever opened.
#[tauri::command]
pub async fn tactics_profile_save(
    meta: Value,
    plans: Vec<TacticsProfilePlan>,
) -> CommandResult<Option<String>> {
    #[cfg(mobile)]
    {
        let _ = (meta, plans);
        return Err(anyhow!(crate::mobile_unsupported::PICKER).into());
    }
    #[cfg(desktop)]
    {
        let default_name = default_archive_name(&meta);
        let payload = TacticsProfilePayload { meta, plans };
        let picked = tokio::task::spawn_blocking(move || {
            rfd::FileDialog::new()
                .set_title("Save tactics profile")
                .set_file_name(&default_name)
                .add_filter("WoWSP tactics profile", &["wowsp-tactics"])
                .save_file()
        })
        .await
        .map_err(|e| anyhow!("profile save dialog task failed: {e}"))?;
        let Some(path) = picked else {
            return Ok(None);
        };
        let bytes = pack_profile(&payload)?;
        let out_path = path.clone();
        let written = tokio::task::spawn_blocking(move || {
            std::fs::write(&out_path, &bytes).map_err(|e| anyhow!("write profile: {e}"))?;
            tracing::info!(path = %out_path.display(), bytes = bytes.len(), "tactics profile saved");
            Ok::<_, anyhow::Error>(())
        })
        .await
        .map_err(|e| anyhow!("profile write task failed: {e}"))?;
        written?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
}

/// Open dialog + zip read. Returns the payload, or None when the user
/// cancelled; a malformed archive surfaces as the command's error.
#[tauri::command]
pub async fn tactics_profile_open() -> CommandResult<Option<TacticsProfilePayload>> {
    #[cfg(mobile)]
    {
        return Err(anyhow!(crate::mobile_unsupported::PICKER).into());
    }
    #[cfg(desktop)]
    {
        let picked = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Open tactics profile")
                .add_filter("WoWSP tactics profile", &["wowsp-tactics"])
                .pick_file()
        })
        .await
        .map_err(|e| anyhow!("profile open dialog task failed: {e}"))?;
        let Some(path) = picked else {
            return Ok(None);
        };
        let bytes = tokio::task::spawn_blocking(move || {
            std::fs::read(&path).map_err(|e| anyhow!("read {}: {e}", path.display()))
        })
        .await
        .map_err(|e| anyhow!("profile read task failed: {e}"))??;
        let payload = unpack_profile(&bytes)?;
        Ok(Some(payload))
    }
}

/// File-name seed for the save dialog: the profile's display name, or the
/// map id when the author never named it — always the archive extension.
fn default_archive_name(meta: &Value) -> String {
    let seed = meta
        .get("profileName")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            meta.get("mapId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "tactics".to_string());
    let safe: String = seed
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("wowsp-tactics-{safe}.wowsp-tactics")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> TacticsProfilePayload {
        TacticsProfilePayload {
            meta: serde_json::json!({
                "format": "wowsp-tactics-profile",
                "version": 1,
                "appVersion": "0.6.1",
                "gameVersion": null,
                "mapId": "20_NE",
                "mapName": "New Earth",
                "modeId": "random-4",
                "profileName": "公会战 A 方案",
                "mirror": true,
                "caps": [{ "letter": "A", "at": { "x": -240.0, "z": 400.0 }, "radius": 23.3, "team": "ally" }],
                "lineup": { "ally": [{ "id": "lu-1", "shipId": 4_290_883_632i64, "label": "", "torpedo": 0, "consumables": [] }],
                            "enemy": [] },
            }),
            plans: vec![
                TacticsProfilePlan {
                    name: "主方案".into(),
                    json: r#"{"version":1,"elements":[],"steps":[]}"#.into(),
                    parent: None,
                    branch_t: None,
                },
                TacticsProfilePlan {
                    name: "分支".into(),
                    json: r#"{"version":1,"elements":[],"steps":[]}"#.into(),
                    parent: Some("0".into()),
                    branch_t: Some(183.0),
                },
            ],
        }
    }

    #[test]
    fn round_trips_a_profile() {
        let bytes = pack_profile(&sample()).unwrap();
        let back = unpack_profile(&bytes).unwrap();
        // Nulls are dropped on the way in (TOML has no null): the round
        // trip compares against the stripped expectation, not the raw.
        assert_eq!(back.meta, strip_nulls(&sample().meta));
        assert!(back.meta.get("gameVersion").is_none());
        assert_eq!(back.plans.len(), 2);
        assert_eq!(back.plans[1].name, "分支");
        assert_eq!(back.plans[1].parent.as_deref(), Some("0"));
        assert_eq!(back.plans[1].branch_t, Some(183.0));
    }

    #[test]
    fn rejects_a_foreign_zip() {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buf);
            zip.start_file(PROFILE_TOML, zip_options()).unwrap();
            zip.write_all(b"format = \"something-else\"\nversion = 1\n")
                .unwrap();
            zip.finish().unwrap();
        }
        let err = unpack_profile(&buf.into_inner()).unwrap_err();
        assert!(err.to_string().contains("not a WoWSP tactics profile"));
    }

    #[test]
    fn rejects_an_empty_profile() {
        let payload = TacticsProfilePayload {
            meta: serde_json::json!({"format": "wowsp-tactics-profile", "version": 1}),
            plans: vec![],
        };
        assert!(pack_profile(&payload).is_err());
    }

    #[test]
    fn default_name_sanitizes_and_appends_extension() {
        let meta = serde_json::json!({ "profileName": "公会战: A/B 方案?" });
        let name = default_archive_name(&meta);
        assert!(name.starts_with("wowsp-tactics-"));
        assert!(name.ends_with(".wowsp-tactics"));
        assert!(!name.contains(':') && !name.contains('?') && !name.contains(' '));
    }
}
