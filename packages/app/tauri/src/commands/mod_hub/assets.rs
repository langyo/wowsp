//! Asset surfacing for the installed-unit detail panes: list a unit's
//! files by previewable kind, and serve one file as a browser-ready
//! payload — images are decoded (png/jpg/bmp/tga/dds) and thumbnailed to
//! PNG data URLs, native audio formats (ogg/mp3/wav) stream as-is. Wwise
//! `.wem` transcodes on demand: PCM-flavoured files are WAVs underneath
//! and pass through as-is, Wwise Vorbis files are fully decoded to PCM
//! in-process (codebook set chosen by decode quality) and re-emitted as
//! WAV — the browser never has to decode rebuilt Vorbis.

use serde::Serialize;

use super::*;

/// One previewable file under an installed unit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFileInfo {
    /// res_mods-relative path (forward slashes).
    pub rel: String,
    pub size: u64,
    /// `image | audio | model` — what the detail pane should do with it.
    pub kind: String,
    /// File extension, lowercased, no dot.
    pub ext: String,
    /// False for `.wem` — listed, but the browser cannot play it.
    pub playable: bool,
    /// Wwise event this voice line answers to (from the pack's
    /// `mod.xml`), e.g. `Play_VO_Autopilot` — the UI's localized
    /// scenario-title key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_event: Option<String>,
    /// State qualifier when the event assigns files per state (e.g.
    /// `VO_Autopilot_Checkpoint`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_state: Option<String>,
    /// 1-based variation index when an event slot lists several files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_index: Option<u32>,
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
pub(crate) fn safe_rel(rel: &str) -> Result<(), String> {
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
    } else if ext == "geometry" {
        // BigWorld mesh — the 3D stage's input (see model_preview.rs).
        Some(("model", true))
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
        // A sound-mod's mod.xml (sibling of its .wem files) names the
        // Wwise event each file answers to — the voice list's scenario
        // titles. Parsed once per directory; absent/unparsable just
        // leaves the files untitled.
        let scenes = fs::read_to_string(dir.join("mod.xml"))
            .map(|xml| parse_mod_xml_scenes(&xml))
            .unwrap_or_default();
        for ent in entries.flatten() {
            let path = ent.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let file_name = ent.file_name().to_string_lossy().into_owned();
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let Some((kind, playable)) = classify_ext(&ext) else {
                continue;
            };
            // Side-geometry variants (destroyed states, distance LODs,
            // hardpoint markers, wireframes) stay out of the model rows —
            // clicking any family member previews the assembled ship.
            if ext == "geometry"
                && path
                    .file_stem()
                    .is_some_and(|s| super::model_preview::is_aux_stem(&s.to_string_lossy()))
            {
                continue;
            }
            let Ok(rel) = path.strip_prefix(&res_mods) else {
                continue;
            };
            let scene = if ext == AUDIO_WEM {
                scenes.get(&file_name)
            } else {
                None
            };
            out.push(AssetFileInfo {
                rel: rel.to_string_lossy().replace('\\', "/"),
                size: ent.metadata().map(|m| m.len()).unwrap_or(0),
                kind: kind.into(),
                ext,
                playable,
                scene_event: scene.map(|(e, _, _)| e.clone()),
                scene_state: scene.and_then(|(_, st, _)| st.clone()),
                scene_index: scene.map(|(_, _, i)| *i),
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

    if classify_ext(&ext).is_none() {
        return Err(format!("{rel_path}: not a previewable asset"));
    }
    if ext == "geometry" {
        // Listed for the 3D stage, but its payload is GLB parts from a
        // different command — bail before reading a multi-MB mesh nobody
        // will serve from here.
        return Err(format!(
            "{rel_path}: .geometry previews use mod_hub_read_model"
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("read {rel_path}: {e}"))?;

    if ext == AUDIO_WEM {
        // On-demand transcode, routed by what the file actually is:
        // PCM-flavoured .wem IS a WAV (RIFF/WAVE/fmt/data with a plain or
        // extensible PCM tag) — served as-is; Wwise Vorbis files are
        // fully decoded to PCM in Rust and re-emitted as WAV (the aoTuV
        // codebook set retries when the standard one garbles). A single
        // voice line converts in well under a second, so the click that
        // asked for it waits once and plays.
        if wem_is_pcm(&bytes) {
            return Ok(AssetPayload {
                data_url: format!(
                    "data:audio/wav;base64,{}",
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
                ),
            });
        }
        let wav = transcode_wem(&bytes).map_err(|e| format!("{rel_path}: {e}"))?;
        return Ok(AssetPayload {
            data_url: format!(
                "data:audio/wav;base64,{}",
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, wav)
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

/// File name → (event, state, 1-based variation index) parsed from a
/// sound-mod's `mod.xml` (the AudioModification.xml the game also
/// ships): each ExternalEvent maps a Wwise event name to the pack's
/// `.wem` files — optionally one list per state (e.g. autopilot
/// checkpoint vs. end) and several random-variation files per slot. A
/// file referenced by several events keeps its first mapping, so the
/// assignment is deterministic regardless of XML order.
fn parse_mod_xml_scenes(
    xml: &str,
) -> std::collections::HashMap<String, (String, Option<String>, u32)> {
    let mut map = std::collections::HashMap::new();
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return map;
    };
    for event in doc
        .descendants()
        .filter(|n| n.has_tag_name("ExternalEvent"))
    {
        let Some(name) = event
            .children()
            .find(|n| n.has_tag_name("Name"))
            .and_then(|n| n.text())
        else {
            continue;
        };
        for path in event.descendants().filter(|n| n.has_tag_name("Path")) {
            let state = path
                .descendants()
                .find(|n| n.has_tag_name("Value"))
                .and_then(|n| n.text())
                .map(str::to_string);
            for (i, file) in path
                .descendants()
                .filter(|n| n.has_tag_name("File"))
                .enumerate()
            {
                let Some(file_name) = file
                    .children()
                    .find(|n| n.has_tag_name("Name"))
                    .and_then(|n| n.text())
                else {
                    continue;
                };
                if file_name.ends_with(".wem") {
                    map.entry(file_name.to_string())
                        .or_insert_with(|| (name.to_string(), state.clone(), i as u32 + 1));
                }
            }
        }
    }
    map
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

/// Wwise Vorbis → PCM WAV. A wrong codebook library still converts
/// "successfully" into structurally valid Ogg that a player can only
/// render as garbled noise — and even a "valid" rebuilt stream leaves
/// the audio at the mercy of a second (browser) Vorbis decoder. So the
/// rebuilt Ogg never leaves this process: every candidate is fully
/// decoded right here and re-emitted as plain 16-bit WAV, leaving the
/// browser nothing but raw samples to play.
///
/// Candidate choice, per codebook set (default first, aoTuV retry):
/// convert → full decode → sane clipping (< [`HOT_CLIP_RATIO`], wrong-
/// codebook garbage decodes to clipped-to-death static) → WAV. A decoded
/// but hot candidate is kept as a best effort; when nothing decodes the
/// caller gets the last error, never noise.
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
            Ok(()) => match decode_ogg_pcm(out.get_ref()) {
                Ok((samples, channels, rate)) => {
                    let hot = clipped_ratio(&samples) >= HOT_CLIP_RATIO;
                    last_err = "decoded but clipped-to-death output".into();
                    if !hot {
                        return Ok(wav_bytes(&samples, channels, rate));
                    }
                    if fallback.is_none() {
                        fallback = Some(wav_bytes(&samples, channels, rate));
                    }
                },
                Err(e) => last_err = format!("decode: {e}"),
            },
            Err(e) => last_err = e.to_string(),
        }
    }
    if let Some(wav) = fallback {
        return Ok(wav);
    }
    Err(format!("Wwise transcode failed: {last_err}"))
}

/// Above this fraction of samples pinned at i16::MIN/MAX a decode is
/// treated as wrong-codebook static rather than loud-but-real audio
/// (clean voice lines from real packs measure under ~12%, garbage is
/// multiples of that).
const HOT_CLIP_RATIO: f64 = 0.25;

/// Fully decode an Ogg Vorbis stream to interleaved 16-bit PCM plus its
/// channel count and sample rate — the one decoder whose verdict the
/// served audio depends on.
fn decode_ogg_pcm(ogg: &[u8]) -> Result<(Vec<i16>, u16, u32), String> {
    let mut reader = lewton::inside_ogg::OggStreamReader::new(std::io::Cursor::new(ogg))
        .map_err(|e| format!("vorbis stream: {e}"))?;
    // Vorbis identification header carries channels as u8; WAV wants u16.
    let channels = u16::from(reader.ident_hdr.audio_channels);
    let rate = reader.ident_hdr.audio_sample_rate;
    let mut samples = Vec::new();
    loop {
        match reader.read_dec_packet_itl() {
            Ok(Some(packet)) => samples.extend_from_slice(&packet),
            Ok(None) => break,
            Err(e) => return Err(format!("vorbis decode: {e}")),
        }
    }
    if samples.is_empty() {
        return Err("no audio samples decoded".into());
    }
    Ok((samples, channels, rate))
}

/// Fraction of samples pinned at the i16 extremes — wrong-codebook
/// garbage decodes to clipped-to-death static, real (even loud) voice
/// lines stay well below it.
fn clipped_ratio(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 1.0;
    }
    let clipped = samples
        .iter()
        .filter(|&&s| s == i16::MIN || s == i16::MAX)
        .count();
    clipped as f64 / samples.len() as f64
}

/// Wrap interleaved 16-bit PCM in a canonical 44-byte-header WAV.
fn wav_bytes(samples: &[i16], channels: u16, rate: u32) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let block_align = channels * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * block_align as u32).to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
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

    /// The PCM decoder rejects anything a Vorbis decoder cannot open,
    /// and the clipping meter separates loud-but-real audio from
    /// pinned-to-the-rails static.
    #[test]
    fn decode_gate_and_clip_meter() {
        assert!(decode_ogg_pcm(&[]).is_err());
        assert!(decode_ogg_pcm(b"OggS and nothing else").is_err());
        assert!(decode_ogg_pcm(&[0u8; 1024]).is_err());
        // A calm signal is nowhere near hot; rails-pinned static is.
        let calm: Vec<i16> = (-1000..1000).cycle().take(8000).collect();
        assert!(clipped_ratio(&calm) < 0.01);
        let rails = vec![i16::MIN; 100];
        assert!(clipped_ratio(&rails) > 0.99);
    }

    /// The WAV wrapper emits a canonical 44-byte PCM header around the
    /// samples — the exact bytes the browser's <audio> consumes.
    #[test]
    fn wav_wrapper_shapes_header() {
        let samples = [0i16, 1, -1, 0x7FFF];
        let wav = wav_bytes(&samples, 2, 44_100);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1); // PCM
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 2); // stereo
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            44_100
        );
        assert_eq!(u16::from_le_bytes([wav[32], wav[33]]), 4); // block align
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16); // bits
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 8);
        assert_eq!(wav.len(), 44 + 8);
        // First sample lands little-endian right after the header.
        assert_eq!(wav[46], 1);
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
    /// (verified against local voice packs: PCM WAV output). The served
    /// payload is fully-decoded PCM, so passing means the exact bytes the
    /// browser will render. CI has no fixture, so the test ignores
    /// itself.
    #[test]
    #[ignore = "set WOWSP_WEM_VORBIS_FIXTURE to a local Vorbis .wem to run"]
    fn transcodes_real_vorbis_wem() {
        let path = std::env::var("WOWSP_WEM_VORBIS_FIXTURE").expect("fixture path");
        let raw = fs::read(&path).unwrap();
        let wav = transcode_wem(&raw).expect("transcode succeeds");
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1);
    }

    /// A synthetic sound-mod: mod.xml mapping one event with per-state
    /// paths and a multi-file variation slot, plus an orphan the XML
    /// never mentions. Escaped bytes only — source stays text.
    #[test]
    fn parses_mod_xml_scenes_for_voice_titles() {
        let xml = concat!(
            "<?xml version=\"1.0\"?><AudioModification.xml>",
            "<ExternalEvent><Name>Play_VO_Autopilot</Name>",
            "<Container><Name>Voice</Name>",
            "<Path><StateList><State><Name>VO_Autopilot</Name>",
            "<Value>VO_Autopilot_Checkpoint</Value></State></StateList>",
            "<FilesList><File><Name>111.wem</Name></File></FilesList></Path>",
            "<Path><StateList><State><Name>VO_Autopilot</Name>",
            "<Value>VO_Autopilot_End</Value></State></StateList>",
            "<FilesList><File><Name>222.wem</Name></File></FilesList></Path>",
            "</Container></ExternalEvent>",
            "<ExternalEvent><Name>Play_VO_Fire_Alarm</Name>",
            "<Container><Path><StateList/>",
            "<FilesList><File><Name>333.wem</Name></File>",
            "<File><Name>444.wem</Name></File></FilesList></Path>",
            "</Container></ExternalEvent>",
            "</AudioModification.xml>",
        );
        let scenes = parse_mod_xml_scenes(xml);
        let (ev, st, i) = scenes.get("111.wem").unwrap();
        assert_eq!(ev, "Play_VO_Autopilot");
        assert_eq!(st.as_deref(), Some("VO_Autopilot_Checkpoint"));
        assert_eq!(*i, 1);
        let (ev, st, _) = scenes.get("222.wem").unwrap();
        assert_eq!(st.as_deref(), Some("VO_Autopilot_End"));
        assert_eq!(ev, "Play_VO_Autopilot");
        let (ev, st, i) = scenes.get("444.wem").unwrap();
        assert_eq!(ev, "Play_VO_Fire_Alarm");
        assert!(st.is_none());
        assert_eq!(*i, 2, "variation index is the slot position");
        assert!(!scenes.contains_key("orphan.wem"));

        // Garbage XML and non-wem entries stay quiet.
        assert!(parse_mod_xml_scenes("not xml <").is_empty());
        let noise = concat!(
            "<ExternalEvent><Name>Play_X</Name><Container><Path>",
            "<FilesList><File><Name>readme.txt</Name></File></FilesList>",
            "</Path></Container></ExternalEvent>"
        );
        assert!(parse_mod_xml_scenes(noise).is_empty());
    }

    /// The full list command carries the scene fields through for wems
    /// under a mod.xml directory, and leaves them absent for orphans.
    #[test]
    fn list_assets_carries_voice_scenes() {
        let tmp = std::env::temp_dir().join("wowsp_assets_scenes");
        let _ = fs::remove_dir_all(&tmp);
        let res_mods = tmp.join("bin/1/res_mods");
        let bank = res_mods.join("banks/mods/Bank");
        fs::create_dir_all(&bank).unwrap();
        fs::write(
            bank.join("mod.xml"),
            concat!(
                "<AudioModification.xml><ExternalEvent>",
                "<Name>Play_VO_Fire_Alarm</Name><Container><Path>",
                "<FilesList><File><Name>a.wem</Name></File>",
                "<File><Name>b.wem</Name></File></FilesList></Path>",
                "</Container></ExternalEvent></AudioModification.xml>",
            ),
        )
        .unwrap();
        fs::write(bank.join("a.wem"), b"wem").unwrap();
        fs::write(bank.join("b.wem"), b"wem").unwrap();
        fs::write(bank.join("orphan.wem"), b"wem").unwrap();

        let list = mod_hub_list_assets(tmp.to_string_lossy().into_owned(), "banks".into()).unwrap();
        let a = list.iter().find(|x| x.rel.ends_with("a.wem")).unwrap();
        assert_eq!(a.scene_event.as_deref(), Some("Play_VO_Fire_Alarm"));
        assert_eq!(a.scene_index, Some(1));
        let b = list.iter().find(|x| x.rel.ends_with("b.wem")).unwrap();
        assert_eq!(b.scene_index, Some(2));
        let orphan = list.iter().find(|x| x.rel.ends_with("orphan.wem")).unwrap();
        assert!(orphan.scene_event.is_none());
        fs::remove_dir_all(&tmp).ok();
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

        // Custom-model meshes: the hull base lists as a model row, its
        // destroyed-state variant stays hidden, and read_asset redirects
        // .geometry to the model command instead of a data URL.
        fs::create_dir_all(res_mods.join("PnFMods/Pack/ship")).unwrap();
        fs::write(res_mods.join("PnFMods/Pack/ship/Hull.geometry"), b"geo").unwrap();
        fs::write(
            res_mods.join("PnFMods/Pack/ship/Hull_dead.geometry"),
            b"geo",
        )
        .unwrap();
        fs::write(
            res_mods.join("PnFMods/Pack/ship/Hull_lod1.geometry"),
            b"geo",
        )
        .unwrap();
        let models = mod_hub_list_assets(root.clone(), "PnFMods/Pack".into()).unwrap();
        assert_eq!(models.len(), 1, "aux variants hidden: {models:?}");
        assert_eq!(models[0].kind, "model");
        assert!(models[0].playable);
        let err =
            mod_hub_read_asset(root.clone(), "PnFMods/Pack/ship/Hull.geometry".into()).unwrap_err();
        assert!(err.contains("mod_hub_read_model"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }
}
