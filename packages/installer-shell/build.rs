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

    // 3. Flavor identity (payload contents + WebView2 bundling) shown by the UI.
    println!("cargo:rerun-if-env-changed=SHUN_FLAVOR");
    let flavor = std::env::var("SHUN_FLAVOR").unwrap_or_else(|_| "dev".into());
    std::fs::write(out_dir.join("shun-flavor.txt"), flavor).expect("write flavor");

    // 4. Resource-pack stamp: the content-tree hash + published-at the
    //    staged resources were packed from (read from the res-latest
    //    manifest at build time). The installer writes them next to the
    //    relocated pack so the app treats the shipped resources as
    //    current instead of re-downloading them on first launch.
    let res_tree = std::env::var("SHUN_RES_TREE_SHA256").unwrap_or_default();
    std::fs::write(out_dir.join("shun-res-tree.txt"), res_tree).expect("write res tree hash");
    println!("cargo:rerun-if-env-changed=SHUN_RES_TREE_SHA256");
    let res_version = std::env::var("SHUN_RES_VERSION").unwrap_or_default();
    std::fs::write(out_dir.join("shun-res-version.txt"), res_version).expect("write res version");
    println!("cargo:rerun-if-env-changed=SHUN_RES_VERSION");

    // 5. License documents per wizard locale, assembled into ONE embedded
    //    JSON map (`license-docs.json`): a localized copyright notice,
    //    the SySL agreement, and the usage-telemetry notice. Every locale
    //    vendors its copyright notice (licenses/copyright-*.txt); the
    //    agreement is fetched fresh from celestia-island/sysl when the
    //    network is reachable (shun's locale mapping covers all eight
    //    tags below), falling back to the vendored copies (licenses/*.txt)
    //    and finally to a one-line stub — a build must never fail over a
    //    missing translation. The telemetry notice is the canonical
    //    docs/{lang}/license/usage-telemetry.md document, embedded
    //    verbatim so the installer and the website always present the
    //    same wording. English stays the universal fallback for the
    //    runtime's unknown-locale path.
    let license_locales = [
        (
            "en",
            "WoWSP Copyright Notice",
            "Synthetic Source License 1.0",
            "Usage Telemetry Notice",
        ),
        (
            "zh-Hans",
            "WoWSP 版权声明",
            "合成源码协议 1.0",
            "使用量遥测告知",
        ),
        (
            "zh-Hant",
            "WoWSP 版權聲明",
            "合成原始碼協議 1.0",
            "使用量遙測告知",
        ),
        (
            "ja",
            "WoWSP 著作権表示",
            "合成ソースライセンス 1.0",
            "利用統計（テレメトリー）に関する通知",
        ),
        (
            "ko",
            "WoWSP 저작권 고지",
            "합성 소스 라이선스 1.0",
            "사용량 원격 측정(텔레메트리) 안내",
        ),
        (
            "ru",
            "Уведомление об авторских правах WoWSP",
            "Лицензия на синтетический исходный код 1.0",
            "Уведомление о телеметрии использования",
        ),
        (
            "fr",
            "Avis de droit d'auteur WoWSP",
            "Licence de Source Synthétique 1.0",
            "Avis de télémétrie d'utilisation",
        ),
        (
            "es",
            "Aviso de derechos de autor de WoWSP",
            "Licencia de Código Sintético 1.0",
            "Aviso de telemetría de uso",
        ),
    ];
    let mut docs = serde_json::Map::new();
    for (locale, notice_title, license_title, telemetry_title) in license_locales {
        // docs/ locale directory backing this installer locale.
        let doc_lang = match locale {
            "zh-Hans" => "zh-CN",
            "zh-Hant" => "zh-TW",
            other => other,
        };
        let notice_path = manifest_dir.join(format!("licenses/copyright-{locale}.txt"));
        println!("cargo:rerun-if-changed={}", notice_path.display());
        let notice = std::fs::read_to_string(&notice_path)
            .unwrap_or_else(|_| String::from("WoWSP — Copyright (c) 2026 langyo."));
        // Fresh-from-upstream first, vendored file second, stub last. The
        // vendored file is a build input regardless of whether the fetch
        // succeeds, so its rerun-if-changed is declared up front.
        let vendored = manifest_dir.join(format!("licenses/{locale}.txt"));
        println!("cargo:rerun-if-changed={}", vendored.display());
        let agreement = shun::license_sysl::fetch_locale("celestia-island/sysl", "main", locale)
            .unwrap_or_else(|_| {
                std::fs::read_to_string(&vendored).unwrap_or_else(|_| {
                    String::from("Licensed under the Synthetic Source License 1.0.")
                })
            });
        let telemetry_path = manifest_dir.join(format!(
            "../../docs/{doc_lang}/license/usage-telemetry.md"
        ));
        println!("cargo:rerun-if-changed={}", telemetry_path.display());
        let telemetry = std::fs::read_to_string(&telemetry_path)
            .unwrap_or_else(|_| String::from("Usage telemetry notice unavailable."));
        docs.insert(
            locale.to_string(),
            serde_json::json!([
                { "title": notice_title, "body": notice },
                { "title": license_title, "body": agreement },
                { "title": telemetry_title, "body": telemetry },
            ]),
        );
    }
    let docs_json = serde_json::to_string_pretty(&docs).expect("license docs serialize");
    std::fs::write(out_dir.join("license-docs.json"), docs_json)
        .expect("write embedded license docs");

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
