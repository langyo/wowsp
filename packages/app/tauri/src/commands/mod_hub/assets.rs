//! Asset surfacing for the installed-unit detail panes: list a unit's
//! files by previewable kind, and serve one file as a browser-ready
//! payload — images are decoded (png/jpg/bmp/tga/dds) and thumbnailed to
//! PNG data URLs, native audio formats (ogg/mp3/wav) stream as-is. Wwise
//! `.wem` (the game's actual voice format) cannot be played by a browser;
//! those list with `playable: false` so the UI can say so instead of
//! failing a click.

use serde::Serialize;

use super::*;

/// One previewable file under an installed unit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFileInfo {
    /// res_mods-relative path (forward slashes).
    pub rel: String,
    pub size: u64,
    /// `image | audio` — what the detail pane should do with it.
    pub kind: String,
    /// File extension, lowercased, no dot.
    pub ext: String,
    /// False for `.wem` — listed, but the browser cannot play it.
    pub playable: bool,
}

/// Browser-ready payload of one asset file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPayload {
    /// Data-URL ready (`data:image/png;base64,…`).
    pub data_url: String,
}

const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "bmp", "tga", "dds"];
const AUDIO_NATIVE: [&str; 3] = ["ogg", "mp3", "wav"];
const AUDIO_WEM: &str = "wem";
/// Preview thumbnails cap at this edge (the game's textures are 2K/4K;
/// a 320px tile keeps the payload small enough to lazy-load dozens).
const THUMB_EDGE: u32 = 320;

/// res_mods-relative path sanity: relative, no `..`, no drive letters, no
/// backslashes (the same rules the install plan paths follow).
fn safe_rel(rel: &str) -> Result<(), String> {
    if rel.is_empty() || rel.contains('\\') || rel.contains(':') || Path::new(rel).is_absolute() {
        return Err(format!("invalid asset path: {rel:?}"));
    }
    for comp in Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(_) => {},
            _ => return Err(format!("invalid asset path: {rel:?}")),
        }
    }
    Ok(())
}

fn classify_ext(ext: &str) -> Option<(&'static str, bool)> {
    let ext = ext.to_ascii_lowercase();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        Some(("image", true))
    } else if AUDIO_NATIVE.contains(&ext.as_str()) {
        Some(("audio", true))
    } else if ext == AUDIO_WEM {
        Some(("audio", false))
    } else {
        None
    }
}

/// List an installed unit's previewable files (images and audio under one
/// res_mods-relative path — a directory or a single file). Depth-limited
/// walk; capped so a pathological tree cannot flood the UI.
#[tauri::command]
pub fn mod_hub_list_assets(
    game_root: String,
    rel_path: String,
) -> Result<Vec<AssetFileInfo>, String> {
    let res_mods = super::scan_installed::scan_root(&game_root)?;
    safe_rel(&rel_path)?;
    let root = res_mods.join(&rel_path);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    let mut depth_left = 8usize;
    while let Some(dir) = stack.pop() {
        depth_left = depth_left.saturating_sub(1);
        if depth_left == 0 || out.len() >= 400 {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for ent in entries.flatten() {
            let path = ent.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let Some((kind, playable)) = classify_ext(&ext) else {
                continue;
            };
            let Ok(rel) = path.strip_prefix(&res_mods) else {
                continue;
            };
            out.push(AssetFileInfo {
                rel: rel.to_string_lossy().replace('\\', "/"),
                size: ent.metadata().map(|m| m.len()).unwrap_or(0),
                kind: kind.into(),
                ext,
                playable,
            });
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

/// Serve one asset: images decode + thumbnail to a PNG data URL; native
/// audio streams as a data URL in its own mime. `.wem` and decode failures
/// are errors the UI renders in place.
#[tauri::command]
pub fn mod_hub_read_asset(game_root: String, rel_path: String) -> Result<AssetPayload, String> {
    let res_mods = super::scan_installed::scan_root(&game_root)?;
    safe_rel(&rel_path)?;
    let path = res_mods.join(&rel_path);
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let bytes = fs::read(&path).map_err(|e| format!("read {rel_path}: {e}"))?;

    if classify_ext(&ext).is_none() {
        return Err(format!("{rel_path}: not a previewable asset"));
    }
    if ext == AUDIO_WEM {
        return Err(format!(
            "{rel_path}: .wem is the game's Wwise format — the browser cannot play it"
        ));
    }
    if let Some(mime) = audio_mime(&ext) {
        return Ok(AssetPayload {
            data_url: format!(
                "data:{mime};base64,{}",
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
            ),
        });
    }

    // Image: decode (format hinted by extension — dds/tga readers need it),
    // thumbnail, re-encode as PNG.
    let format = match ext.as_str() {
        "png" => image::ImageFormat::Png,
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "bmp" => image::ImageFormat::Bmp,
        "tga" => image::ImageFormat::Tga,
        "dds" => image::ImageFormat::Dds,
        _ => return Err(format!("{rel_path}: unsupported image format .{ext}")),
    };
    let decoded = image::load_from_memory_with_format(&bytes, format)
        .map_err(|e| format!("{rel_path}: decode failed: {e}"))?;
    let thumb = decoded.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut png = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("{rel_path}: re-encode failed: {e}"))?;
    Ok(AssetPayload {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png.get_ref())
        ),
    })
}

fn audio_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "ogg" => Some("audio/ogg"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_and_serves_images_and_flags_wem() {
        let tmp = std::env::temp_dir().join("wowsp_assets");
        let _ = fs::remove_dir_all(&tmp);
        let res_mods = tmp.join("bin/1/res_mods");
        fs::create_dir_all(res_mods.join("spaces/PJSC001")).unwrap();
        // A real 4x2 PNG stands in for a texture.
        let img = image::RgbaImage::from_fn(4, 2, |x, _| {
            image::Rgba([if x < 2 { 255 } else { 0 }, 0, 0, 255])
        });
        image::DynamicImage::ImageRgba8(img)
            .save(res_mods.join("spaces/PJSC001/tex.png"))
            .unwrap();
        fs::create_dir_all(res_mods.join("banks/mods/Bank")).unwrap();
        fs::write(res_mods.join("banks/mods/Bank/sfx.wem"), b"wem").unwrap();
        fs::write(res_mods.join("banks/mods/Bank/line.ogg"), b"ogg").unwrap();
        fs::write(res_mods.join("spaces/readme.txt"), b"noise").unwrap();
        // scan_root resolves <root>/bin/<latest-numeric>/res_mods — the
        // tmp layout above already built bin/1/res_mods, so the game root
        // IS the tmp dir.
        let root = tmp.to_string_lossy().into_owned();

        let list = mod_hub_list_assets(root.clone(), "spaces".into()).unwrap();
        assert_eq!(list.len(), 1, "txt noise excluded: {list:?}");
        assert_eq!(list[0].kind, "image");
        assert_eq!(list[0].rel, "spaces/PJSC001/tex.png");

        let payload = mod_hub_read_asset(root.clone(), "spaces/PJSC001/tex.png".into()).unwrap();
        assert!(payload.data_url.starts_with("data:image/png;base64,"));

        let bank = mod_hub_list_assets(root.clone(), "banks".into()).unwrap();
        assert_eq!(bank.len(), 2);
        let wem = bank.iter().find(|a| a.ext == "wem").unwrap();
        assert!(!wem.playable);
        let ogg = bank.iter().find(|a| a.ext == "ogg").unwrap();
        assert!(ogg.playable);

        let ogg_payload = mod_hub_read_asset(root.clone(), "banks/mods/Bank/line.ogg".into());
        assert!(
            ogg_payload
                .unwrap()
                .data_url
                .starts_with("data:audio/ogg;base64,")
        );
        let err = mod_hub_read_asset(root.clone(), "banks/mods/Bank/sfx.wem".into()).unwrap_err();
        assert!(err.contains("wem"), "{err}");
        assert!(mod_hub_read_asset(root.clone(), "../escape".into()).is_err());
        fs::remove_dir_all(&tmp).ok();
    }
}
