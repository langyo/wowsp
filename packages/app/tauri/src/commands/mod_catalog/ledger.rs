//! Install-ledger load/save + the records command (split from mod_catalog.rs).

use anyhow::anyhow;

use super::*;

// ── Install ledger ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Ledger {
    #[serde(default)]
    pub(crate) installs: Vec<ModInstallRecord>,
}

pub(crate) fn load_ledger() -> Ledger {
    fs::read_to_string(data_file(LEDGER_FILE).unwrap_or_default())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_ledger(ledger: &Ledger) -> anyhow::Result<()> {
    let path = data_file(LEDGER_FILE)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| anyhow!("create ledger dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json =
        serde_json::to_string_pretty(ledger).map_err(|e| anyhow!("serialize ledger: {e}"))?;
    fs::write(&tmp, json).map_err(|e| anyhow!("write ledger: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| anyhow!("rename ledger: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn mod_hub_records() -> CommandResult<Vec<ModInstallRecord>> {
    Ok(load_ledger().installs)
}
