//! The resource registry — one declarative row per runtime-managed
//! resource, plus the aggregated status walk.
//!
//! WHAT THIS IS
//! ============
//! Every byte the app downloads or manages at runtime used to be described
//! only by its owning module's constants: the data pack's dataset names and
//! caps in `data_pack.rs`, the resource pack's archive/stamp names in
//! `model_pack.rs`, the mod catalog's channel in `mod_catalog`. This
//! module is the single table that names them all — channel, trigger,
//! progress bus, digest channel — so "what does the app download, when, and
//! where does it land" has ONE answer in the tree (mirrored as a doc page,
//! docs/en/designs/resources.md).
//!
//! WHAT THIS IS NOT
//! ================
//! No behavior lives here. The rows are documentation the compiler keeps
//! honest: `resources_status()` walks them and reports each resource's
//! on-disk state (version/sha stamp, size, present) in one IPC call, which
//! the Settings → resources inventory renders. The owning modules keep
//! their download/verify/install logic untouched — including the app
//! updater, whose channel is deliberately FROZEN for compatibility (old
//! clients must reach new versions through it; resources may reformat
//! freely because they only ever ship to current clients).
//!
//! ROW VOCABULARY
//! ==============
//! kind:      update | pack | dataset | index | cache | bundled
//! channel:   the pairing relay's signed digest channel ("" = none)
//! trigger:   user | boot | on-demand | passive | pairing | static | manual
//! progress:  the unified download-progress kind ("" = silent/no UI)
//! root:      cache (%LOCALAPPDATA%) | data (%APPDATA%) | bundled | ""
#![allow(dead_code)] // registry fields are documentation; readers may not use all

use anyhow::anyhow;
use serde::Serialize;
use std::fs;
use std::path::Path;

use wowsp_tauri_shared::CommandResult;

use super::model_pack::dir_size;

// ── the registry ─────────────────────────────────────────────────────────

/// One declarative row: WHAT the resource is and HOW it reaches the
/// machine. Static by design — the state (version, size) is read at
/// status-walk time, never stored here.
pub(crate) struct ResourceSpec {
    /// Stable id, also the webui row key ("res-pack", "data-ship-gameparams").
    pub id: &'static str,
    /// update | pack | dataset | index | cache | bundled.
    pub kind: &'static str,
    /// Signed digest channel on the pairing relay ("" when none).
    pub channel: &'static str,
    /// user | boot | on-demand | passive | pairing | static | manual.
    pub trigger: &'static str,
    /// Download-progress bus kind ("" = silent).
    pub progress: &'static str,
}

/// The registry, in display order. Keep in lock-step with
/// docs/en/designs/resources.md and the status walk below.
pub(crate) const REGISTRY: &[ResourceSpec] = &[
    // The updater's channel is frozen for old-client compatibility: this
    // row documents it; no manifest/stamp of it is ever reformatted here.
    ResourceSpec {
        id: "app-update",
        kind: "update",
        channel: "app",
        trigger: "user",
        progress: "update",
    },
    ResourceSpec {
        id: "res-pack",
        kind: "pack",
        channel: "res",
        trigger: "user",
        progress: "res-pack",
    },
    ResourceSpec {
        id: "data-kit",
        kind: "dataset",
        channel: "data",
        trigger: "boot",
        progress: "",
    },
    ResourceSpec {
        id: "data-ship-gameparams",
        kind: "dataset",
        channel: "data",
        trigger: "boot",
        progress: "",
    },
    ResourceSpec {
        id: "mod-catalog",
        kind: "index",
        channel: "mod-hub",
        trigger: "on-demand",
        progress: "",
    },
    ResourceSpec {
        id: "cache-image-cache",
        kind: "cache",
        channel: "",
        trigger: "passive",
        progress: "",
    },
    ResourceSpec {
        id: "cache-gameparams",
        kind: "cache",
        channel: "",
        trigger: "pairing",
        progress: "",
    },
    ResourceSpec {
        id: "cache-encyclopedia",
        kind: "cache",
        channel: "",
        trigger: "passive",
        progress: "",
    },
    ResourceSpec {
        id: "cache-community",
        kind: "cache",
        channel: "",
        trigger: "passive",
        progress: "",
    },
    ResourceSpec {
        id: "decisions-pack",
        kind: "pack",
        channel: "",
        trigger: "manual",
        progress: "",
    },
    ResourceSpec {
        id: "bundled-lesta",
        kind: "bundled",
        channel: "",
        trigger: "static",
        progress: "",
    },
];

// ── the status row (spec + on-disk state) ────────────────────────────────

/// One registry row joined with its current on-disk state. Serialized
/// camelCase for the webui.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceStatusRow {
    pub id: String,
    pub kind: String,
    pub channel: String,
    pub trigger: String,
    pub progress: String,
    /// Something is installed/cached for this row.
    pub present: bool,
    /// The resource's own version vocabulary: pack timestamps, dataset
    /// publish stamps, cache build numbers.
    pub version: Option<String>,
    /// Content hash when the resource is content-addressed.
    pub sha256: Option<String>,
    /// On-disk bytes when a size is meaningful (0 = not measured).
    pub size_bytes: u64,
    /// cache | data | bundled | "" — which root the resource lives under.
    pub root: String,
}

/// The aggregated status walk: one row per REGISTRY entry, state read from
/// disk on the blocking pool (dir walks can take seconds on big packs).
#[tauri::command]
pub async fn resources_status() -> CommandResult<Vec<ResourceStatusRow>> {
    let data = super::appdata::appdata_dir_path()?;
    let cache = crate::paths::ensure_cache_dir()?;
    let rows = tokio::task::spawn_blocking(move || status_in(&data, &cache))
        .await
        .map_err(|e| anyhow!("resource status task: {e}"))?;
    Ok(rows)
}

/// The walk against explicit roots (tests inject temp dirs). A row whose
/// state cannot be read still reports — present=false — because the
/// registry itself is the deliverable, not the fs probe.
fn status_in(data: &Path, cache: &Path) -> Vec<ResourceStatusRow> {
    REGISTRY
        .iter()
        .map(|spec| {
            let state = probe(spec.id, data, cache);
            ResourceStatusRow {
                id: spec.id.to_string(),
                kind: spec.kind.to_string(),
                channel: spec.channel.to_string(),
                trigger: spec.trigger.to_string(),
                progress: spec.progress.to_string(),
                present: state.present,
                version: state.version,
                sha256: state.sha256,
                size_bytes: state.size_bytes,
                root: state.root,
            }
        })
        .collect()
}

/// Read one row's on-disk state by id. Every read is best-effort: missing
/// files mean "not installed yet", never an error.
fn probe(id: &str, data: &Path, cache: &Path) -> Probe {
    match id {
        "app-update" => Probe {
            present: true,
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            ..Probe::default()
        },
        "res-pack" => {
            // The pack's stamp ({treeSha256, version}); size over its three
            // sub-directories (an insights-only tree is not a pack).
            let stamp: Option<serde_json::Value> = read_json(&cache.join(".res-version.json"));
            let size: u64 = ["models", "dogtags", "insights"]
                .iter()
                .map(|d| dir_size(&cache.join(d)))
                .sum();
            Probe {
                present: size > 0,
                version: stamp
                    .as_ref()
                    .and_then(|v| v["version"].as_str().map(String::from)),
                sha256: stamp
                    .as_ref()
                    .and_then(|v| v["treeSha256"].as_str().map(String::from)),
                size_bytes: size,
                root: "cache".into(),
            }
        },
        "data-kit" => dataset_probe(data, "ship-consumable-kit.json"),
        "data-ship-gameparams" => dataset_probe(data, "ship-gameparams.zip"),
        "mod-catalog" => Probe {
            // The catalog is a TTL-cached index refreshed on view load; the
            // panel's own card shows its fetch stamp. Registry row only.
            present: true,
            ..Probe::default()
        },
        "cache-image-cache" => cache_probe(&cache.join("image-cache")).root("cache"),
        "cache-gameparams" => {
            let dir = data.join("gameparams");
            let build = fs::read_to_string(dir.join("source-build.txt"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Probe {
                present: dir.is_dir(),
                version: build,
                size_bytes: dir_size(&dir),
                root: "data".into(),
                ..Probe::default()
            }
        },
        "cache-encyclopedia" => cache_probe(&data.join("encyclopedia")).root("data"),
        "cache-community" => cache_probe(&data.join("community")).root("data"),
        "decisions-pack" => {
            let dir = cache.join("decisions");
            let size = dir_size(&dir);
            Probe {
                present: size > 0,
                size_bytes: size,
                root: "cache".into(),
                ..Probe::default()
            }
        },
        "bundled-lesta" => Probe {
            // Compiled into the binary (include_bytes!): always present.
            present: true,
            root: "bundled".into(),
            ..Probe::default()
        },
        other => {
            tracing::warn!("resource registry row {other:?} has no probe");
            Probe::default()
        },
    }
}

/// Partial state; `..`-spread into the row.
#[derive(Default)]
struct Probe {
    present: bool,
    version: Option<String>,
    sha256: Option<String>,
    size_bytes: u64,
    root: String,
}

impl Probe {
    fn root(self, root: &str) -> Self {
        Self {
            root: root.into(),
            ..self
        }
    }
}

/// A data-pack dataset's state from its sidecar + body file. The sidecar
/// name is the body's stem + ".meta.json" (data_pack.rs's KIT_META /
/// SHIPDATA_META convention).
fn dataset_probe(data: &Path, body_name: &str) -> Probe {
    let pack_dir = data.join("data-pack");
    let stem = body_name
        .strip_suffix(".zip")
        .or_else(|| body_name.strip_suffix(".json"))
        .unwrap_or(body_name);
    let meta = read_json(&pack_dir.join(format!("{stem}.meta.json")));
    let body = pack_dir.join(body_name);
    let size = fs::metadata(&body).map(|m| m.len()).unwrap_or(0);
    Probe {
        present: meta.is_some() && size > 0,
        version: meta
            .as_ref()
            .and_then(|m| m["version"].as_str().map(String::from)),
        sha256: meta
            .as_ref()
            .and_then(|m| m["sha256"].as_str().map(String::from)),
        size_bytes: size,
        root: "data".into(),
    }
}

/// A plain cache directory's state (present = non-empty).
fn cache_probe(dir: &Path) -> Probe {
    let size = dir_size(dir);
    Probe {
        present: size > 0,
        size_bytes: size,
        ..Probe::default()
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

// ── tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut nonce = [0u8; 8];
            getrandom::fill(&mut nonce).unwrap();
            let dir =
                std::env::temp_dir().join(format!("wowsp-resreg-{tag}-{}", hex::encode(nonce)));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// The walk covers every registry row exactly once and keeps spec
    /// fields intact (state may vary with the temp fs).
    #[test]
    fn walk_covers_every_registry_row() {
        let data = TempDir::new("data");
        let cache = TempDir::new("cache");
        let rows = status_in(&data.0, &cache.0);
        assert_eq!(rows.len(), REGISTRY.len(), "one row per registry entry");
        for (spec, row) in REGISTRY.iter().zip(&rows) {
            assert_eq!(row.id, spec.id);
            assert_eq!(row.kind, spec.kind);
            assert_eq!(row.channel, spec.channel);
            assert_eq!(row.trigger, spec.trigger);
            assert_eq!(row.progress, spec.progress);
        }
    }

    /// Dataset rows read their sidecar and body: present only when BOTH
    /// exist, version/sha from the sidecar, size from the body.
    #[test]
    fn dataset_rows_report_sidecar_and_body() {
        let data = TempDir::new("data");
        let cache = TempDir::new("cache");
        let pack = data.0.join("data-pack");
        fs::create_dir_all(&pack).unwrap();

        // Absent: not present.
        let rows = status_in(&data.0, &cache.0);
        let kit = rows.iter().find(|r| r.id == "data-kit").unwrap();
        assert!(!kit.present);

        // Sidecar without a body: still absent.
        fs::write(
            pack.join("ship-consumable-kit.meta.json"),
            r#"{"sha256":"abc","version":"2026-10-30T00:00:00Z"}"#,
        )
        .unwrap();
        let rows = status_in(&data.0, &cache.0);
        assert!(!rows.iter().find(|r| r.id == "data-kit").unwrap().present);

        // Body lands: present, both fields surfaced.
        fs::write(pack.join("ship-consumable-kit.json"), br#"{"kit":1}"#).unwrap();
        let rows = status_in(&data.0, &cache.0);
        let kit = rows.iter().find(|r| r.id == "data-kit").unwrap();
        assert!(kit.present);
        assert_eq!(kit.version.as_deref(), Some("2026-10-30T00:00:00Z"));
        assert_eq!(kit.sha256.as_deref(), Some("abc"));
        assert_eq!(kit.size_bytes, 9);
    }

    /// The res-pack row reads the hash stamp and sizes the tree.
    #[test]
    fn res_pack_row_reads_stamp_and_sizes_the_tree() {
        let data = TempDir::new("data");
        let cache = TempDir::new("cache");
        fs::write(
            cache.0.join(".res-version.json"),
            r#"{"treeSha256":"deadbeef","version":"2026-10-01T00:00:00Z"}"#,
        )
        .unwrap();
        fs::create_dir_all(cache.0.join("models/ship")).unwrap();
        fs::write(cache.0.join("models/ship/a.glb"), [0u8; 64]).unwrap();
        fs::create_dir_all(cache.0.join("dogtags")).unwrap();
        fs::write(cache.0.join("dogtags/x.png"), [0u8; 16]).unwrap();

        let rows = status_in(&data.0, &cache.0);
        let pack = rows.iter().find(|r| r.id == "res-pack").unwrap();
        assert!(pack.present);
        assert_eq!(pack.sha256.as_deref(), Some("deadbeef"));
        assert_eq!(pack.size_bytes, 80);
        assert_eq!(pack.root, "cache");
    }

    /// Frozen-channel discipline: the app-update row is informational only
    /// (kind "update", channel "app") and the walk never invents a stamp
    /// file for it.
    #[test]
    fn app_update_row_is_informational() {
        let data = TempDir::new("data");
        let cache = TempDir::new("cache");
        let rows = status_in(&data.0, &cache.0);
        let upd = rows.iter().find(|r| r.id == "app-update").unwrap();
        assert_eq!(upd.kind, "update");
        assert_eq!(upd.channel, "app");
        assert_eq!(upd.version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
    }
}
