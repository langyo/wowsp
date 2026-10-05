//! Asset surfacing for the installed-unit detail panes: list a unit's
//! files by previewable kind, and serve one file as a browser-ready
//! payload — images are decoded (png/jpg/bmp/tga/dds) and thumbnailed to
//! PNG data URLs, native audio formats (ogg/mp3/wav) stream as-is. Wwise
//! `.wem` transcodes on demand: PCM-flavoured files are WAVs underneath
//! and pass through as-is, Wwise Vorbis converts through the embedded-
//! codebook ww2ogg port, decode-validated per codebook set (the click
//! waits once, then plays clean audio or reports why it cannot).

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
        // Transcoded on read — playable, just slower than a native file.
        Some(("audio", true))
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
        // On-demand transcode, routed by what the file actually is:
        // PCM-flavoured .wem IS a WAV (RIFF/WAVE/fmt/data with a plain or
        // extensible PCM tag) — served as-is; Wwise Vorbis files go
        // through the embedded-codebook transcode, where each attempt is
        // decode-validated and the aoTuV set retries when the standard
        // one garbles. A single voice line converts in well under a
        // second, so the click that asked for it waits once and plays.
        if wem_is_pcm(&bytes) {
            return Ok(AssetPayload {
                data_url: format!(
                    "data:audio/wav;base64,{}",
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
                ),
            });
        }
        let ogg = transcode_wem(&bytes).map_err(|e| format!("{rel_path}: {e}"))?;
        return Ok(AssetPayload {
            data_url: format!(
                "data:audio/ogg;base64,{}",
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, ogg)
            ),
        });
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

/// Whether a .wem is really a PCM WAV in disguise: RIFF/WAVE with an
/// 0x0001 (PCM) or 0xFFFE (WAVE_FORMAT_EXTENSIBLE) tag — the browser
/// plays those bytes untouched.
fn wem_is_pcm(bytes: &[u8]) -> bool {
    if bytes.len() < 40 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return false;
    }
    // First chunk must be "fmt "; its payload starts with the format tag.
    if &bytes[12..16] != b"fmt " {
        return false;
    }
    let tag = u16::from_le_bytes([bytes[20], bytes[21]]);
    tag == 0x0001 || tag == 0xFFFE
}

/// Wwise Vorbis → standard Ogg Vorbis. A wrong codebook library still
/// converts "successfully" into structurally valid Ogg that a player can
/// only render as garbled noise, so every conversion is checked before it
/// is served and the aoTuV set retries when the standard one garbles:
///
/// * strong pass — `ww2ogg::validate`: decodes the leading packets and
///   rejects clipped-to-death output (wrong-codebook garbage);
/// * fallback — [`ogg_decodes_cleanly`]: the validator's clipping
///   heuristic also flags legitimately loud voice lines (real packs hit
///   both cases), so a candidate that fails validation but decodes
///   end-to-end is kept and served only when no candidate strongly
///   passes.
///
/// When nothing converts and decodes the caller gets the last error,
/// never noise.
fn transcode_wem(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut last_err = String::new();
    let mut fallback: Option<Vec<u8>> = None;
    for codebooks in [
        ww2ogg::CodebookLibrary::default_codebooks(),
        ww2ogg::CodebookLibrary::aotuv_codebooks(),
    ] {
        let codebooks = match codebooks {
            Ok(c) => c,
            Err(e) => {
                last_err = format!("codebook load: {e}");
                continue;
            },
        };
        let mut out = std::io::Cursor::new(Vec::new());
        let read = std::io::Cursor::new(bytes.to_vec());
        match ww2ogg::WwiseRiffVorbis::new(read, codebooks)
            .and_then(|mut conv| conv.generate_ogg(&mut out))
        {
            Ok(()) => {
                let ogg = out.into_inner();
                match ww2ogg::validate(&ogg) {
                    Ok(()) => return Ok(ogg),
                    Err(e) => {
                        last_err = format!("validation: {e}");
                        if fallback.is_none() && ogg_decodes_cleanly(&ogg) {
                            fallback = Some(ogg);
                        }
                    },
                }
            },
            Err(e) => last_err = e.to_string(),
        }
    }
    if let Some(ogg) = fallback {
        return Ok(ogg);
    }
    Err(format!("Wwise transcode failed: {last_err}"))
}

/// Hard decode gate: the whole Ogg Vorbis stream must open and decode
/// packet by packet with lewton. Wrong-codebook output typically dies
/// here (its rebuilt codebooks do not decode), while the validator's
/// clipping heuristic — the strong pass — additionally flags
/// loud-but-valid audio, which is exactly the case this gate exists to
/// rescue.
fn ogg_decodes_cleanly(ogg: &[u8]) -> bool {
    let Ok(mut reader) = lewton::inside_ogg::OggStreamReader::new(std::io::Cursor::new(ogg)) else {
        return false;
    };
    let mut packets = 0usize;
    loop {
        match reader.read_dec_packet_itl() {
            Ok(Some(packet)) => {
                if !packet.is_empty() {
                    packets += 1;
                }
            },
            Ok(None) => return packets > 0,
            Err(_) => return false,
        }
    }
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

    /// A synthetic PCM .wem (which IS a WAV: RIFF/WAVE, 0x0001 tag) routes
    /// to the as-is path; garbage input is not mistaken for one.
    #[test]
    fn routes_pcm_wem_as_wav() {
        assert!(wem_is_pcm(&synthetic_pcm_wem(0x0001)));
        assert!(!wem_is_pcm(b"not a wem at all"));
        // The extensible variant (0xFFFE, what modern Wwise PCM uses).
        assert!(wem_is_pcm(&synthetic_pcm_wem(0xFFFE)));
        // A Wwise Vorbis header (0xFFFF tag riding a 0x42-size fmt chunk)
        // never takes the PCM branch.
        let mut vorbis = synthetic_pcm_wem(0xFFFF);
        vorbis[16..20].copy_from_slice(&0x42u32.to_le_bytes());
        assert!(!wem_is_pcm(&vorbis));
    }

    /// The decode gate rejects anything a Vorbis decoder cannot open —
    /// empty and arbitrary bytes (even with an OggS magic) never reach
    /// the fallback path.
    #[test]
    fn ogg_decode_gate_rejects_non_vorbis() {
        assert!(!ogg_decodes_cleanly(&[]));
        assert!(!ogg_decodes_cleanly(b"OggS and nothing else"));
        assert!(!ogg_decodes_cleanly(&[0u8; 1024]));
    }

    /// Minimal RIFF/WAVE/PCM bytes with the given format tag: fmt chunk
    /// first (16-byte payload), then an empty data chunk -- the exact
    /// shape `wem_is_pcm` reads. Escaped bytes only: source stays text.
    fn synthetic_pcm_wem(tag: u16) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&24u32.to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&[0u8; 18]); // channels..bits + data header
        out.extend_from_slice(b"data");
        out.extend_from_slice(&0u32.to_le_bytes());
        out
    }

    /// Real-file verification for the Vorbis transcode path: point
    /// WOWSP_WEM_VORBIS_FIXTURE at any .wem with a 0x42 fmt chunk
    /// (verified once against a 9 MB public sample: OggS + vorbis header
    /// output). Success here also means the output decode-validated —
    /// transcode_wem rejects garbled conversions internally. CI has no
    /// fixture, so the test ignores itself.
    #[test]
    #[ignore = "set WOWSP_WEM_VORBIS_FIXTURE to a local Vorbis .wem to run"]
    fn transcodes_real_vorbis_wem() {
        let path = std::env::var("WOWSP_WEM_VORBIS_FIXTURE").expect("fixture path");
        let raw = fs::read(&path).unwrap();
        let ogg = transcode_wem(&raw).expect("transcode succeeds");
        assert_eq!(&ogg[..4], b"OggS");
        assert!(ogg.windows(6).take(4096).any(|w| w == b"vorbis"));
    }

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
        // .wem is playable through the on-read transcode now.
        assert!(wem.playable);
        let ogg = bank.iter().find(|a| a.ext == "ogg").unwrap();
        assert!(ogg.playable);

        let ogg_payload = mod_hub_read_asset(root.clone(), "banks/mods/Bank/line.ogg".into());
        assert!(
            ogg_payload
                .unwrap()
                .data_url
                .starts_with("data:audio/ogg;base64,")
        );
        // Garbage bytes named .wem fail INSIDE the transcode path (no
        // valid Wwise RIFF); real files convert and play.
        let err = mod_hub_read_asset(root.clone(), "banks/mods/Bank/sfx.wem".into()).unwrap_err();
        assert!(err.contains("transcode"), "{err}");
        assert!(mod_hub_read_asset(root.clone(), "../escape".into()).is_err());
        fs::remove_dir_all(&tmp).ok();
    }
}
