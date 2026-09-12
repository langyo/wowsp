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

    // 3. Flavor identity (lite/full + WebView2 bundling) shown by the UI.
    println!("cargo:rerun-if-env-changed=SHUN_FLAVOR");
    let flavor = std::env::var("SHUN_FLAVOR").unwrap_or_else(|_| "dev".into());
    std::fs::write(out_dir.join("shun-flavor.txt"), flavor).expect("write flavor");

    // 3. License: the SySL text plus official translations. The zh texts
    //    are vendored from celestia-island/sysl (licenses/); en comes from
    //    the repo-root LICENSE. When the network is reachable the fetch
    //    refreshes each file from upstream first; otherwise the vendored
    //    copies are used as-is.
    let license_sources = [
        ("en", manifest_dir.join("../../LICENSE")),
        ("zh-Hans", manifest_dir.join("licenses/zh-Hans.txt")),
        ("zh-Hant", manifest_dir.join("licenses/zh-Hant.txt")),
    ];
    for (locale, vendored) in license_sources {
        let mut text = std::fs::read_to_string(&vendored)
            .unwrap_or_else(|_| String::from("Licensed under the Synthetic Source License 1.0."));
        if let Ok(fresh) = shun::license_sysl::fetch_locale("celestia-island/sysl", "main", locale)
        {
            text = fresh;
        }
        std::fs::write(out_dir.join(format!("license-{locale}.txt")), text)
            .expect("write embedded license");
    }

    // The dist is embedded at compile time (generate_context!) — a proc
    // macro, which cargo does not track. Declare it explicitly so a rebuilt
    // frontend always triggers a re-embed.
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("web/dist").display()
    );

    // tauri-codegen caches compressed assets under OUT_DIR and misses
    // invalidation for DELETED dist files (old hashed names would keep
    // riding along, and the cached index.html keeps serving the old
    // assets). Wipe the cache every build — asset recompression is cheap.
    for entry in std::fs::read_dir(out_dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("__tauri_cache__") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }

    tauri_build::build()
}
