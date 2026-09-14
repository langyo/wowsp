//! Build-time inputs for the app shell:
//!
//! - the shun update-watch table (`[package.metadata.shun.update]`) is
//!   parsed out of this crate's manifest and written to
//!   `OUT_DIR/shun-update.json`, embedded at runtime by
//!   `src/commands/update.rs` via `include_str!`; and
//! - the crate version lands in `OUT_DIR/app-version.txt` so the update
//!   check can compare the `latest` marker against the running build.

use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    let manifest_dir = Path::new(&manifest_dir);
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let manifest_path = manifest_dir.join("Cargo.toml");

    // 1. Resolve the update-watch config from the manifest metadata.
    //    `ShunConfig::from_cargo_manifest` tolerates a manifest without
    //    `[package.metadata.shun]` (everything defaults) and inherits
    //    `version.workspace = true` from the workspace root — only the
    //    `update` table matters here.
    let config = shun::config::ShunConfig::from_cargo_manifest(&manifest_path)
        .expect("shun update metadata in Cargo.toml parses");
    let update = config
        .update
        .expect("[package.metadata.shun.update] declares the update-watch sources");
    let update_json = serde_json::to_vec_pretty(&update).expect("update-watch config serializes");
    std::fs::write(out_dir.join("shun-update.json"), update_json)
        .expect("write embedded update-watch config");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    // 2. App version for the update check (workspace version 0.1.0).
    let version = std::env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by cargo");
    std::fs::write(out_dir.join("app-version.txt"), version).expect("write embedded app version");

    tauri_build::build()
}
