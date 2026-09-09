//! Build-time inputs for the installer shell, resolved from this crate's
//! `[package.metadata.shun]` delivery manifest:
//!
//! - the shun configuration is written to `OUT_DIR/shun-config.json` and
//!   embedded by the runtime (`include_str!`); and
//! - the payload directory declared there is packed into
//!   `OUT_DIR/wowsp-payload.shun` and embedded via `include_bytes!` —
//!   the single-file installer pattern. `SHUN_PAYLOAD` overrides the
//!   payload directory so release staging can point at the real
//!   application build output; plain `cargo build` packs the committed
//!   smoke payload so CI stays green without the app binaries.

use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    let manifest_dir = Path::new(&manifest_dir);
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));

    // 1. Resolve the shun configuration from the manifest metadata.
    let manifest_path = manifest_dir.join("Cargo.toml");
    let config = shun::config::ShunConfig::from_cargo_manifest(&manifest_path)
        .expect("shun metadata in Cargo.toml parses");
    let config_json = serde_json::to_vec_pretty(&config).expect("config serializes");
    std::fs::write(out_dir.join("shun-config.json"), config_json).expect("write embedded config");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    // 2. Pack the payload directory (SHUN_PAYLOAD > metadata declaration).
    println!("cargo:rerun-if-env-changed=SHUN_PAYLOAD");
    let payload_dir = std::env::var_os("SHUN_PAYLOAD")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            manifest_dir.join(
                config
                    .payload
                    .clone()
                    .expect("metadata.shun.payload declares the default payload directory"),
            )
        });
    let archive = shun::payload::pack_directory(&payload_dir).expect("payload packs cleanly");
    std::fs::write(out_dir.join("wowsp-payload.shun"), &archive).expect("write embedded payload");
    println!("cargo:rerun-if-changed={}", payload_dir.display());

    tauri_build::build()
}
