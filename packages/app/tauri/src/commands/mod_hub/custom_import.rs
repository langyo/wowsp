//! Custom import (自定义导入安装) — the wizard behind the Mod Hub's
//! "custom import" entry.
//!
//! The Mod Hub's local install has always accepted a folder that ALREADY
//! looks like a mod package. A custom import starts one step earlier: the
//! user points at whatever they made (a login clip, a voice bank, a
//! texture drop) and the command assembles the compliant `res_mods` shape
//! itself before handing the result to the ordinary local-install pipeline:
//!
//! 1. **Stage** — build a res_mods-shaped tree under
//!    `<data>/mods/import-staging/<uuid>/` (video tiers, bank wrapping,
//!    payload-root copy). Staging is always removed afterwards — the
//!    installer has already read it into the game tree.
//! 2. **Classify + validate** — the SAME classifier the preview and the
//!    catalog pipeline run (`classify_package`), so a custom import can
//!    never plant a tree the platform would refuse.
//! 3. **Install + adopt** — the existing local-install pipeline writes the
//!    plan (journal, snapshots, ledger record, manifest row) and the
//!    beautify layer stack adopts the payload.
//!
//! Three commands serve the wizard:
//!
//! - [`mod_hub_pick_custom_file`] — the native single-file picker for the
//!   video kind (rfd + the same source grant the folder picker mints); the
//!   other kinds reuse [`super::pick_source::mod_hub_pick_source`].
//! - [`mod_hub_probe_custom_import`] — the step-2 verdict: what the picked
//!   path is, its size, the shape the import would produce, and the
//!   language-neutral problem codes that keep "next" disabled.
//! - [`mod_hub_import_custom`] — the step-3 action; transcoding a video
//!   reports progress through `wowsp://custom-import-progress`.
//!
//! ## Per-kind compliance rules
//!
//! - **video** — `gui/video/login/main.webm` (1080p) plus the optional
//!   `main_low.webm` (720p). A `.webm` source is copied as-is (200 MB cap;
//!   a `*_low.webm` source lands as the 720p tier). `.mp4`/`.mov`/`.mkv`
//!   sources are transcoded with an EXTERNAL ffmpeg (the game only loads
//!   VP9 + Vorbis WebM); without ffmpeg the command fails with the exact
//!   commands to run.
//! - **voice** — `banks/mods/<bank>/mod.xml` (+ `.wem`) trees are copied
//!   as-is; a loose `mod.xml` + `.wem` payload is wrapped into
//!   `banks/mods/<display name>/`; anything else is refused with the
//!   expected layout.
//! - **texture** / **misc** — the source must carry at least one
//!   res_mods-shaped override root (`content/`, `gui/`, `spaces/`,
//!   `particles/`, `texts/`, `camouflage/`, `system/`); a bare pile of
//!   `.dds` files is refused with an example tree.
//!
//! ## Trust boundary
//!
//! Sources are whatever the picker handed out this session
//! ([`super::pick_source::ensure_source_granted`]); every copied entry is
//! inspected without following links ([`super::ensure_plain_source_entry`]),
//! exactly like the folder-install copy. The app's own data tree is never a
//! valid source (the grant refuses it), so a webview cannot stage a payload
//! it wrote itself.

use anyhow::{Context, anyhow};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::Emitter;

use wowsp_tauri_shared::{
    CommandResult, CustomImportKind, CustomImportProbe, CustomImportProblem, CustomImportProgress,
    CustomImportReport, PackagePlan,
};

// ── constants ───────────────────────────────────────────────────────────────

/// The login-clip directory, res_mods-relative.
const VIDEO_DIR_REL: &str = "gui/video/login";
/// 1080p tier (required).
const VIDEO_MAIN: &str = "main.webm";
/// 720p tier (optional, recommended).
const VIDEO_LOW: &str = "main_low.webm";
/// Source cap for a copied (already WebM) clip.
const VIDEO_MAX_BYTES: u64 = 200 * 1024 * 1024;
/// The override roots a texture/misc payload must live under (matched
/// case-insensitively, like the classifier's signature checks).
const OVERRIDE_ROOTS: &[&str] = &[
    "content",
    "gui",
    "spaces",
    "particles",
    "texts",
    "camouflage",
    "system",
];
/// Bounded directory walk behind the wizard's size figure — a probe must
/// never spend minutes on a huge tree.
const PROBE_FILE_CAP: u64 = 50_000;
/// Structure lists stay human-sized; more is noise in the wizard.
const STRUCTURE_CAP: usize = 20;
/// Record names become directory names (restore snapshots, layer store), so
/// a pasted paragraph must not reach the filesystem.
const NAME_MAX_CHARS: usize = 80;

/// The progress event the webui subscribes to.
pub(crate) const CUSTOM_IMPORT_PROGRESS_EVENT: &str = "wowsp://custom-import-progress";

// Stage codes (language-neutral — the webui localizes them).
pub(crate) const STAGE_PREPARING: &str = "preparing";
pub(crate) const STAGE_TRANSCODE_MAIN: &str = "transcodeMain";
pub(crate) const STAGE_TRANSCODE_LOW: &str = "transcodeLow";
pub(crate) const STAGE_COPYING: &str = "copying";
pub(crate) const STAGE_INSTALLING: &str = "installing";
pub(crate) const STAGE_DONE: &str = "done";

/// ffmpeg's binary name on this target.
#[cfg(windows)]
const FFMPEG_BIN: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_BIN: &str = "ffmpeg";

/// One WebM tier the transcoder produces (the encoder settings come from
/// the product spec: VP9 + Vorbis, 25 fps, lanczos scaling).
struct VideoTier {
    file: &'static str,
    /// `scale` filter geometry (1080p / 720p).
    scale: &'static str,
    crf: u32,
    stage: &'static str,
    /// Progress window of this tier inside the 5..95 % band.
    from: f64,
    to: f64,
}

const VIDEO_TIERS: [VideoTier; 2] = [
    VideoTier {
        file: VIDEO_MAIN,
        scale: "1920:1080",
        crf: 31,
        stage: STAGE_TRANSCODE_MAIN,
        from: 5.0,
        to: 50.0,
    },
    VideoTier {
        file: VIDEO_LOW,
        scale: "1280:720",
        crf: 38,
        stage: STAGE_TRANSCODE_LOW,
        from: 50.0,
        to: 95.0,
    },
];

// ── progress ────────────────────────────────────────────────────────────────

/// One import's progress sink. `app` is absent in unit tests (the pure
/// staging helpers run without an emitter); the throttle keeps a transcode
/// from flooding the event bus with every `-progress` line.
pub(crate) struct Progress<'a> {
    app: Option<&'a tauri::AppHandle>,
    last: std::cell::RefCell<(f64, &'static str)>,
}

impl<'a> Progress<'a> {
    pub(crate) fn new(app: Option<&'a tauri::AppHandle>) -> Self {
        Self {
            app,
            last: std::cell::RefCell::new((-1.0, "")),
        }
    }

    /// Emit one tick. Whole-point advancement is throttled (ffmpeg emits a
    /// progress block several times a second); a stage change always goes out
    /// so the UI's label moves even when the percentage has not.
    fn emit(&self, stage: &'static str, percent: f64) {
        let percent = percent.clamp(0.0, 100.0).round();
        {
            let mut last = self.last.borrow_mut();
            if stage == last.1 && percent <= last.0 {
                return;
            }
            *last = (percent, stage);
        }
        let Some(app) = self.app else { return };
        let payload = CustomImportProgress {
            stage: stage.to_string(),
            percent,
        };
        if let Err(e) = app.emit(CUSTOM_IMPORT_PROGRESS_EVENT, &payload) {
            tracing::warn!(error = %e, stage, "custom-import progress emit failed");
        }
    }
}

// ── commands ────────────────────────────────────────────────────────────────

/// Native SINGLE-FILE picker for the video kind. Mirrors
/// [`super::pick_source::mod_hub_pick_source`]: the picked path is the only
/// import source the backend accepts (it is registered as a session grant),
/// and the dialog filters to the video containers the importer understands.
#[tauri::command]
pub async fn mod_hub_pick_custom_file(window: tauri::Window) -> CommandResult<Option<String>> {
    crate::commands::ensure_main_window_label(window.label())?;
    // Mobile: no native file dialog — the custom import is a desktop flow
    // (same rule as pick_source).
    #[cfg(mobile)]
    {
        return Err(anyhow!(crate::mobile_unsupported::PICKER).into());
    }
    #[cfg(desktop)]
    {
        // rfd pumps its own message loop — a blocking thread, never the
        // async runtime workers or the UI thread.
        let picked = tokio::task::spawn_blocking(move || {
            rfd::FileDialog::new()
                .set_title("Choose the video file to import")
                .add_filter("Video", &["mp4", "webm", "mov", "mkv"])
                .pick_file()
        })
        .await
        .map_err(|e| anyhow!("custom source dialog task failed: {e}"))?;
        match picked.map(|p| p.to_string_lossy().into_owned()) {
            Some(path) => {
                super::pick_source::grant_source_path(&path)?;
                Ok(Some(path))
            },
            None => Ok(None),
        }
    }
}

/// Step-2 verdict of the wizard: what the picked path is, how big it is, the
/// res_mods shape the import would produce, and every reason it cannot be
/// imported right now. Read-only and idempotent.
#[tauri::command]
pub async fn mod_hub_probe_custom_import(
    window: tauri::Window,
    kind: CustomImportKind,
    source_path: String,
    display_name: Option<String>,
) -> CommandResult<CustomImportProbe> {
    crate::commands::ensure_main_window_label(window.label())?;
    // Same grant rule as classify/install: the picker is the trust anchor.
    super::pick_source::ensure_source_granted(&source_path)?;
    let probe = tauri::async_runtime::spawn_blocking(move || {
        probe_custom(kind, Path::new(&source_path), display_name.as_deref())
    })
    .await
    .map_err(|e| anyhow!("custom import probe task: {e}"))?;
    Ok(probe?)
}

/// Step-3 action: stage the picked source into the compliant res_mods shape,
/// classify it, install it through the local-install pipeline and adopt the
/// payload into the beautify layer stack.
#[tauri::command]
pub async fn mod_hub_import_custom(
    window: tauri::Window,
    app: tauri::AppHandle,
    game_root: String,
    kind: CustomImportKind,
    source_path: String,
    display_name: Option<String>,
) -> CommandResult<CustomImportReport> {
    crate::commands::ensure_main_window_label(window.label())?;
    // Same gate as every other install: custom imports write res_mods too.
    let _gate = super::mod_catalog::mod_hub_gate().await;
    super::ensure_game_closed(&game_root)?;
    super::ensure_res_mods_active(&game_root)?;
    super::pick_source::ensure_source_granted(&source_path)?;
    let staging_root = staging_root()?;
    let report = tauri::async_runtime::spawn_blocking(move || {
        import_custom_blocking(
            Some(&app),
            &game_root,
            kind,
            Path::new(&source_path),
            display_name.as_deref(),
            &staging_root,
        )
    })
    .await
    .map_err(|e| anyhow!("custom import task: {e}"))?;
    Ok(report?)
}

// ── command bodies (test seams) ─────────────────────────────────────────────

/// `<data>/mods/import-staging` — the assembly area for staged payloads.
fn staging_root() -> anyhow::Result<PathBuf> {
    let dir = crate::paths::ensure_data_dir()?
        .join("mods")
        .join("import-staging");
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir)
}

/// One staged payload: the plan its tree classifies as, ready for the
/// installer.
#[derive(Debug)]
pub(crate) struct StagedImport {
    pub plan: PackagePlan,
}

/// The whole step-3 body minus IPC: stage, classify, install, adopt.
pub(crate) fn import_custom_blocking(
    app: Option<&tauri::AppHandle>,
    game_root: &str,
    kind: CustomImportKind,
    source: &Path,
    display_name: Option<&str>,
    staging_root: &Path,
) -> anyhow::Result<CustomImportReport> {
    let progress = Progress::new(app);
    progress.emit(STAGE_PREPARING, 0.0);
    // Always removed afterwards — success and failure alike: the installer
    // has already copied the payload into the game tree.
    let staging = StagingGuard(staging_root.join(uuid::Uuid::new_v4().simple().to_string()));
    let ffmpeg = find_ffmpeg();
    let staged = stage_custom_import(
        &progress,
        kind,
        source,
        display_name,
        ffmpeg.as_deref(),
        &staging.0,
    )?;
    progress.emit(STAGE_INSTALLING, 98.0);
    let done =
        super::install_local_package(&staging.0, game_root, &staged.plan, kind_category(kind))?;
    let layer_id = super::layer::adopted_layer_id(game_root, &done.record);
    progress.emit(STAGE_DONE, 100.0);
    Ok(CustomImportReport {
        report: done.applied.report,
        layer_id,
    })
}

/// Stage one custom import and classify the result: the pure-filesystem half
/// of [`import_custom_blocking`], split out so the compliance rules are
/// testable without a ledger.
pub(crate) fn stage_custom_import(
    progress: &Progress<'_>,
    kind: CustomImportKind,
    source: &Path,
    display_name: Option<&str>,
    ffmpeg: Option<&Path>,
    staging: &Path,
) -> anyhow::Result<StagedImport> {
    let inspection = inspect_custom(kind, source, display_name, ffmpeg)?;
    if let Some(problem) = inspection.problems.first() {
        return Err(problem_error(kind, problem, &inspection, source));
    }
    let payload = inspection
        .payload
        .as_ref()
        .ok_or_else(|| anyhow!("no importable payload behind {}", source.display()))?;
    fs::create_dir_all(staging).with_context(|| format!("create {}", staging.display()))?;

    match payload {
        Payload::File { from, tier } => {
            progress.emit(STAGE_COPYING, 60.0);
            let dest = staging.join(VIDEO_DIR_REL).join(tier);
            copy_file_plain(from, &dest)?;
        },
        Payload::Transcode { from } => {
            let exe = ffmpeg.ok_or_else(|| missing_ffmpeg_error(from, kind))?;
            for tier in &VIDEO_TIERS {
                let dest = staging.join(VIDEO_DIR_REL).join(tier.file);
                transcode_tier(progress, exe, from, &dest, tier)?;
            }
        },
        Payload::Tree { from, wrap } => {
            progress.emit(STAGE_COPYING, 60.0);
            // A loose voice pack is wrapped into its bank folder; every other
            // tree lands at the staging root unchanged.
            let dest = if *wrap {
                staging
                    .join("banks")
                    .join("mods")
                    .join(sanitize_bank(&inspection.name))
            } else {
                staging.to_path_buf()
            };
            copy_tree_plain(from, &dest)?;
        },
    }

    let mut plan = super::classify_package(staging).map_err(|e| {
        anyhow!(
            "the assembled {} payload has no installable structure: {e}",
            kind_label(kind)
        )
    })?;
    if plan.entries.is_empty() {
        return Err(anyhow!(
            "the assembled {} payload has no installable structure",
            kind_label(kind)
        ));
    }
    // The staging directory is a uuid — the user-facing name is the one the
    // wizard resolved (typed name, then the format's own label).
    plan.name = inspection.name.clone();
    plan.warnings.extend(inspection.warnings.clone());
    Ok(StagedImport { plan })
}

/// Step-2 body: inspect the source and answer the wizard's questions.
pub(crate) fn probe_custom(
    kind: CustomImportKind,
    source: &Path,
    display_name: Option<&str>,
) -> anyhow::Result<CustomImportProbe> {
    let ffmpeg = find_ffmpeg();
    let inspection = inspect_custom(kind, source, display_name, ffmpeg.as_deref())?;
    Ok(CustomImportProbe {
        path: source.to_string_lossy().into_owned(),
        file_name: leaf_name(source),
        is_file: inspection.is_file,
        size_bytes: inspection.size_bytes,
        structure: inspection.structure,
        problems: inspection.problems,
    })
}

// ── inspection ──────────────────────────────────────────────────────────────

/// What the staged tree is built from.
enum Payload {
    /// Copy one file verbatim to `gui/video/login/<tier>`.
    File { from: PathBuf, tier: &'static str },
    /// External ffmpeg converts the source into both WebM tiers.
    Transcode { from: PathBuf },
    /// Copy a folder tree; `wrap` puts it under `banks/mods/<name>`.
    Tree { from: PathBuf, wrap: bool },
}

/// One source's step-2 verdict plus the recipe the staging step runs.
pub(crate) struct Inspection {
    pub name: String,
    pub is_file: bool,
    pub size_bytes: u64,
    pub structure: Vec<String>,
    pub problems: Vec<CustomImportProblem>,
    pub warnings: Vec<String>,
    payload: Option<Payload>,
}

fn problem(code: &str, detail: Option<String>) -> CustomImportProblem {
    CustomImportProblem {
        code: code.to_string(),
        detail,
    }
}

/// Inspect one source against its kind's compliance rules. Read-only.
pub(crate) fn inspect_custom(
    kind: CustomImportKind,
    source: &Path,
    display_name: Option<&str>,
    ffmpeg: Option<&Path>,
) -> anyhow::Result<Inspection> {
    let mut inspection = match kind {
        CustomImportKind::Video => inspect_video(source, ffmpeg)?,
        CustomImportKind::Voice => inspect_voice(source)?,
        CustomImportKind::Texture | CustomImportKind::Misc => inspect_override_tree(source)?,
    };
    inspection.name = resolve_name(display_name, &inspection, source);
    // A bare voice pack's wrap path depends on the resolved name, so the
    // structure line is rebuilt once the name is known.
    if let Some(Payload::Tree { wrap: true, .. }) = inspection.payload {
        inspection.structure = vec![format!("banks/mods/{}", sanitize_bank(&inspection.name))];
    }
    Ok(inspection)
}

/// Display name resolution: the typed name wins, then the format's own label,
/// then the source leaf name. Capped so a pasted paragraph never becomes a
/// directory name.
fn resolve_name(display_name: Option<&str>, inspection: &Inspection, source: &Path) -> String {
    let typed = display_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let suggested = Some(inspection.name.clone())
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.trim().to_string());
    truncate_chars(
        typed
            .or(suggested)
            .unwrap_or_else(|| leaf_name(source))
            .trim(),
        NAME_MAX_CHARS,
    )
}

fn truncate_chars(text: &str, max: usize) -> String {
    let trimmed: String = text.chars().take(max).collect();
    trimmed.trim().to_string()
}

/// Leaf name: a file's stem, a folder's name (empty for a root-less path).
fn leaf_name(path: &Path) -> String {
    path.file_stem()
        .or_else(|| path.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A folder's own name — never extension-stripped (a folder whose name
/// carries a dot keeps it).
fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn sanitize_bank(name: &str) -> String {
    let cleaned = super::classify::sanitize_dir_name(name);
    if cleaned.is_empty() {
        "custom-import".to_string()
    } else {
        cleaned
    }
}

/// Video: copy a WebM as-is (1080p, or the 720p tier for a `*_low` source) or
/// transcode a container the client cannot load.
fn inspect_video(source: &Path, ffmpeg: Option<&Path>) -> anyhow::Result<Inspection> {
    let mut inspection = Inspection {
        name: String::new(),
        is_file: source.is_file(),
        size_bytes: file_len(source).unwrap_or(0),
        structure: Vec::new(),
        problems: Vec::new(),
        warnings: Vec::new(),
        payload: None,
    };
    if !source.exists() {
        inspection.problems.push(problem("missing", None));
        return Ok(inspection);
    }
    if !inspection.is_file {
        inspection.problems.push(problem("notFile", None));
        return Ok(inspection);
    }
    let ext = extension_of(source);
    inspection.name = leaf_name(source);
    match ext.as_str() {
        "webm" => {
            let low = inspection.name.to_ascii_lowercase().ends_with("_low");
            if low {
                // The tier suffix is the format's, not the user's name.
                inspection.name = inspection.name[..inspection.name.len() - "_low".len()]
                    .trim()
                    .to_string();
            }
            let tier = if low { VIDEO_LOW } else { VIDEO_MAIN };
            inspection.structure = vec![format!("{VIDEO_DIR_REL}/{tier}")];
            if inspection.size_bytes > VIDEO_MAX_BYTES {
                inspection.problems.push(problem(
                    "videoTooLarge",
                    Some(inspection.size_bytes.to_string()),
                ));
            }
            inspection.warnings.push(if low {
                format!("{VIDEO_LOW} staged as the 720p tier — the 1080p {VIDEO_MAIN} is still missing")
            } else {
                format!("{VIDEO_MAIN} staged as the 1080p tier — import a *_low.webm clip as {VIDEO_LOW} for the 720p tier")
            });
            inspection.payload = Some(Payload::File {
                from: source.to_path_buf(),
                tier,
            });
        },
        "mp4" | "mov" | "mkv" => {
            inspection.structure = vec![
                format!("{VIDEO_DIR_REL}/{VIDEO_MAIN}"),
                format!("{VIDEO_DIR_REL}/{VIDEO_LOW}"),
            ];
            if ffmpeg.is_none() {
                inspection
                    .problems
                    .push(problem("missingFfmpeg", Some(ext.clone())));
            }
            inspection.payload = Some(Payload::Transcode {
                from: source.to_path_buf(),
            });
        },
        _ => {
            inspection.problems.push(problem(
                "unsupportedVideo",
                Some(if ext.is_empty() {
                    "?".to_string()
                } else {
                    ext.clone()
                }),
            ));
        },
    }
    Ok(inspection)
}

/// Voice: passthrough a `banks/mods/<bank>` tree, wrap a loose
/// `mod.xml` + `.wem` payload, refuse anything else.
fn inspect_voice(source: &Path) -> anyhow::Result<Inspection> {
    let mut inspection = Inspection {
        name: String::new(),
        is_file: source.is_file(),
        size_bytes: 0,
        structure: Vec::new(),
        problems: Vec::new(),
        warnings: Vec::new(),
        payload: None,
    };
    if !source.exists() {
        inspection.problems.push(problem("missing", None));
        return Ok(inspection);
    }
    if !source.is_dir() {
        inspection.problems.push(problem("notDirectory", None));
        return Ok(inspection);
    }
    let root = payload_root(source, |dir| Ok(voice_layout(dir)?.is_some()))?;
    inspection.size_bytes = dir_size(&root).unwrap_or(0);
    // A peeled wrapper folder names the payload, not the extraction folder.
    inspection.name = folder_name(&root);
    match voice_layout(&root)? {
        Some(VoiceLayout::Banks(banks)) => {
            inspection.structure = banks;
            inspection.payload = Some(Payload::Tree {
                from: root,
                wrap: false,
            });
        },
        Some(VoiceLayout::Bare) => {
            // The in-game voice-selector label doubles as the fallback name.
            inspection.name = bare_voice_name(&root);
            inspection.structure = vec![format!("banks/mods/{}", sanitize_bank(&inspection.name))];
            inspection.payload = Some(Payload::Tree {
                from: root,
                wrap: true,
            });
        },
        None => {
            inspection.structure = top_level_names(&root);
            inspection.problems.push(problem("voiceLayout", None));
        },
    }
    Ok(inspection)
}

/// Texture / misc: the source must carry a res_mods-shaped override root.
fn inspect_override_tree(source: &Path) -> anyhow::Result<Inspection> {
    let mut inspection = Inspection {
        name: String::new(),
        is_file: source.is_file(),
        size_bytes: 0,
        structure: Vec::new(),
        problems: Vec::new(),
        warnings: Vec::new(),
        payload: None,
    };
    if !source.exists() {
        inspection.problems.push(problem("missing", None));
        return Ok(inspection);
    }
    if !source.is_dir() {
        inspection.problems.push(problem("notDirectory", None));
        return Ok(inspection);
    }
    let root = payload_root(source, |dir| Ok(!override_roots(dir)?.is_empty()))?;
    inspection.size_bytes = dir_size(&root).unwrap_or(0);
    inspection.name = folder_name(&root);
    let roots = override_roots(&root)?;
    if roots.is_empty() {
        // Show what IS there, so the reason is concrete ("a.dds, b.png").
        inspection.structure = top_level_names(&root);
        inspection.problems.push(problem("textureRoots", None));
        return Ok(inspection);
    }
    inspection.structure = roots;
    inspection.payload = Some(Payload::Tree {
        from: root,
        wrap: false,
    });
    Ok(inspection)
}

/// Translate one problem into the actionable English error the IPC returns.
fn problem_error(
    kind: CustomImportKind,
    problem: &CustomImportProblem,
    inspection: &Inspection,
    path: &Path,
) -> anyhow::Error {
    let found = inspection
        .structure
        .iter()
        .take(6)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    match problem.code.as_str() {
        "missing" => anyhow!("the picked path does not exist: {}", path.display()),
        "notFile" => anyhow!("a {} import needs a single video file", kind_label(kind)),
        "notDirectory" => anyhow!("a {} import needs a folder", kind_label(kind)),
        "unsupportedVideo" => anyhow!(
            "unsupported video container \".{}\": import a .webm clip, or .mp4/.mov/.mkv with ffmpeg installed",
            problem.detail.as_deref().unwrap_or("?")
        ),
        "videoTooLarge" => anyhow!(
            "the clip is too large to copy as-is ({} MB, the cap is {} MB) — re-encode it as VP9 WebM under the cap",
            inspection.size_bytes / (1024 * 1024),
            VIDEO_MAX_BYTES / (1024 * 1024)
        ),
        "missingFfmpeg" => anyhow!(
            "ffmpeg is required to convert .{} videos: install ffmpeg and retry, or convert the clip to .webm yourself — the importer looks beside the app executable, in %LOCALAPPDATA%\\WoWSP\\tools\\ffmpeg.exe, then on PATH.\nThe exact commands:\n  {}",
            problem.detail.as_deref().unwrap_or("?"),
            ffmpeg_display_commands()
        ),
        "voiceLayout" => anyhow!(
            "no voice-bank layout found in {}: a voice pack must contain banks/mods/<bank>/mod.xml (+ .wem files), or a loose mod.xml with .wem files at the top level{}",
            path.display(),
            if found.is_empty() {
                String::new()
            } else {
                format!(" (found: {found})")
            }
        ),
        "textureRoots" => anyhow!(
            "a {} source needs a res_mods-shaped folder tree in {} — one of content/, gui/, spaces/, particles/, texts/, camouflage/ or system/ at the top, e.g. content/gameplay/japan/battleship/textures/x.dds{}",
            kind_label(kind),
            path.display(),
            if found.is_empty() {
                String::new()
            } else {
                format!(" (found: {found})")
            }
        ),
        other => anyhow!("cannot import this source: {other}"),
    }
}

/// The exact commands the missing-ffmpeg error quotes (copyable, no progress
/// plumbing, binary name unprefixed so a fresh PATH install works).
pub(crate) fn ffmpeg_display_commands() -> String {
    let source = "input.mp4";
    let mut lines = Vec::new();
    for tier in &VIDEO_TIERS {
        let out = format!("{VIDEO_DIR_REL}/{}", tier.file);
        lines.push(display_command(
            "ffmpeg",
            &ffmpeg_args(Path::new(source), Path::new(&out), tier),
        ));
    }
    lines.join("\n  ")
}

fn kind_label(kind: CustomImportKind) -> &'static str {
    match kind {
        CustomImportKind::Video => "video",
        CustomImportKind::Voice => "voice",
        CustomImportKind::Texture => "texture",
        CustomImportKind::Misc => "misc",
    }
}

fn kind_category(kind: CustomImportKind) -> &'static str {
    match kind {
        CustomImportKind::Video => "video",
        CustomImportKind::Voice => "voice",
        CustomImportKind::Texture => "texture",
        // "other assets" stay the plain local category.
        CustomImportKind::Misc => "local",
    }
}

// ── source layout helpers ───────────────────────────────────────────────────

/// One recognized voice-bank layout.
enum VoiceLayout {
    /// `banks/<mods>/<bank>/mod.xml` trees, as res_mods-relative paths.
    Banks(Vec<String>),
    /// A loose `mod.xml` + `.wem` payload that needs wrapping.
    Bare,
}

/// Read one untrusted directory, refusing link-shaped entries before they can
/// impersonate a layout signature (the classifier's own rule).
fn read_plain(dir: &Path) -> anyhow::Result<Vec<fs::DirEntry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)
        .map_err(|e| anyhow!("read {}: {e}", dir.display()))?
        .flatten()
    {
        super::ensure_plain_source_entry(&entry.path())?;
        entries.push(entry);
    }
    Ok(entries)
}

fn child_ci(dir: &Path, name: &str) -> anyhow::Result<Option<PathBuf>> {
    Ok(read_plain(dir)?
        .into_iter()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
        .map(|e| e.path()))
}

/// One subdirectory (ignoring Explorer noise) — the re-derive-one-layer-down
/// rule real-world packs need.
fn single_child_dir(dir: &Path) -> anyhow::Result<Option<PathBuf>> {
    let mut dirs = Vec::new();
    for entry in read_plain(dir)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if lower == "desktop.ini" || lower == "thumbs.db" || lower.ends_with(".txt") {
            continue;
        }
        if !entry.path().is_dir() {
            return Ok(None);
        }
        dirs.push(entry.path());
    }
    Ok(if dirs.len() == 1 { dirs.pop() } else { None })
}

/// The folder that actually carries the payload: the source itself, or its
/// single wrapper folder (an extracted archive's naming layer).
fn payload_root(
    dir: &Path,
    has_signature: impl Fn(&Path) -> anyhow::Result<bool>,
) -> anyhow::Result<PathBuf> {
    if has_signature(dir)? {
        return Ok(dir.to_path_buf());
    }
    if let Some(inner) = single_child_dir(dir)? {
        if has_signature(&inner)? {
            return Ok(inner);
        }
    }
    Ok(dir.to_path_buf())
}

/// The voice-bank layout under `dir`, if any.
fn voice_layout(dir: &Path) -> anyhow::Result<Option<VoiceLayout>> {
    if let Some(banks) = child_ci(dir, "banks")? {
        let mut found = Vec::new();
        for mods in read_plain(&banks)? {
            let mods_path = mods.path();
            if !mods_path.is_dir()
                || !mods
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("mods")
            {
                continue;
            }
            for bank in read_plain(&mods_path)? {
                let bank_path = bank.path();
                if !bank_path.is_dir() {
                    continue;
                }
                let has_xml = read_plain(&bank_path)?.iter().any(|e| {
                    e.path().is_file()
                        && e.file_name()
                            .to_string_lossy()
                            .eq_ignore_ascii_case("mod.xml")
                });
                if has_xml {
                    found.push(format!(
                        "banks/{}/{}",
                        mods.file_name().to_string_lossy(),
                        bank.file_name().to_string_lossy()
                    ));
                }
            }
        }
        if !found.is_empty() {
            found.sort();
            found.truncate(STRUCTURE_CAP);
            return Ok(Some(VoiceLayout::Banks(found)));
        }
    }
    let has_xml = child_ci(dir, "mod.xml")?.is_some_and(|p| p.is_file());
    let has_wem = read_plain(dir)?
        .iter()
        .any(|e| e.path().is_file() && extension_of(&e.path()) == "wem");
    if has_xml && has_wem {
        return Ok(Some(VoiceLayout::Bare));
    }
    Ok(None)
}

/// The in-game selector label of a loose voice pack (`mod.xml` `<Name>`),
/// falling back to the folder name.
fn bare_voice_name(dir: &Path) -> String {
    let label = child_ci(dir, "mod.xml")
        .ok()
        .flatten()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|body| super::first_xml_tag(&body, "Name"));
    label
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| leaf_name(dir))
}

/// The override roots present in `dir` (their on-disk spelling).
fn override_roots(dir: &Path) -> anyhow::Result<Vec<String>> {
    let mut roots = Vec::new();
    for entry in read_plain(dir)? {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if OVERRIDE_ROOTS
            .iter()
            .any(|root| name.eq_ignore_ascii_case(root))
        {
            roots.push(name);
        }
    }
    roots.sort();
    Ok(roots)
}

/// Top-level entry names (files and folders), capped — the "found:" detail a
/// refused source reports.
fn top_level_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = read_plain(dir)
        .map(|entries| {
            entries
                .into_iter()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.truncate(8);
    names
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| m.len())
}

/// Bounded total size of a directory (the wizard's "size" line).
fn dir_size(dir: &Path) -> Option<u64> {
    let mut total = 0u64;
    let mut seen = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = read_plain(&current).ok()?;
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                total += fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                seen += 1;
                if seen >= PROBE_FILE_CAP {
                    return Some(total);
                }
            }
        }
    }
    Some(total)
}

// ── staging: copying ────────────────────────────────────────────────────────

fn copy_file_plain(from: &Path, to: &Path) -> anyhow::Result<()> {
    super::ensure_plain_source_entry(from)?;
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::copy(from, to).map_err(|e| anyhow!("copy {} -> {}: {e}", from.display(), to.display()))?;
    Ok(())
}

/// Copy a source tree into staging, refusing link-shaped entries on the way
/// (the install copy's guard, applied one step earlier).
fn copy_tree_plain(from: &Path, to: &Path) -> anyhow::Result<()> {
    super::ensure_plain_source_entry(from)?;
    fs::create_dir_all(to).with_context(|| format!("create {}", to.display()))?;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        for entry in fs::read_dir(&src)
            .map_err(|e| anyhow!("read {}: {e}", src.display()))?
            .flatten()
        {
            let source = entry.path();
            super::ensure_plain_source_entry(&source)?;
            let dest = dst.join(entry.file_name());
            if source.is_dir() {
                fs::create_dir_all(&dest).with_context(|| format!("create {}", dest.display()))?;
                stack.push((source, dest));
            } else {
                fs::copy(&source, &dest)
                    .map_err(|e| anyhow!("copy {} -> {}: {e}", source.display(), dest.display()))?;
            }
        }
    }
    Ok(())
}

/// Staging tree of one import; removed on drop (success or failure).
struct StagingGuard(PathBuf);

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.0) {
            if self.0.exists() {
                tracing::warn!(
                    error = %e,
                    dir = %self.0.display(),
                    "custom-import staging cleanup failed"
                );
            }
        }
    }
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────

/// Locate ffmpeg in the documented probe order: beside the app executable,
/// `%LOCALAPPDATA%/WoWSP/tools/ffmpeg.exe`, then `PATH`.
pub(crate) fn find_ffmpeg() -> Option<PathBuf> {
    if let Some(dir) = crate::paths::exe_dir() {
        let candidate = dir.join(FFMPEG_BIN);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local)
            .join("WoWSP")
            .join("tools")
            .join(FFMPEG_BIN);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(FFMPEG_BIN))
        .find(|candidate| candidate.is_file())
}

/// The ffmpeg argument list for one tier (progress lines on stdout, so the
/// wizard's bar can move; the visible command in error messages drops those
/// plumbing flags).
fn ffmpeg_args(source: &Path, out: &Path, tier: &VideoTier) -> Vec<String> {
    vec![
        "-y".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-vf".into(),
        format!("fps=25,scale={}:flags=lanczos", tier.scale),
        "-c:v".into(),
        "libvpx-vp9".into(),
        "-row-mt".into(),
        "1".into(),
        "-cpu-used".into(),
        "4".into(),
        "-crf".into(),
        tier.crf.to_string(),
        "-b:v".into(),
        "0".into(),
        "-c:a".into(),
        "libvorbis".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        out.to_string_lossy().into_owned(),
    ]
}

/// The copyable form of [`ffmpeg_args`]: the progress plumbing stripped, and
/// arguments carrying spaces or filter commas quoted.
fn display_command(exe: &str, args: &[String]) -> String {
    let mut parts = vec![exe.to_string()];
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        // Drop the machine-readable progress pair.
        if arg == "-progress" || arg == "-nostats" {
            index += if arg == "-progress" { 2 } else { 1 };
            continue;
        }
        parts.push(quote_arg(arg));
        index += 1;
    }
    parts.join(" ")
}

fn quote_arg(arg: &str) -> String {
    if arg.contains(' ') || arg.contains(',') {
        format!("\"{arg}\"")
    } else {
        arg.to_string()
    }
}

/// The error for a transcoding source with no ffmpeg available.
fn missing_ffmpeg_error(source: &Path, kind: CustomImportKind) -> anyhow::Error {
    let ext = extension_of(source);
    anyhow!(
        "ffmpeg is required to convert .{} {} sources: install ffmpeg and retry, or convert the clip to .webm yourself — the importer looks beside the app executable, in %LOCALAPPDATA%\\WoWSP\\tools\\ffmpeg.exe, then on PATH.\nThe exact commands:\n  {}",
        if ext.is_empty() { "?" } else { ext.as_str() },
        kind_label(kind),
        ffmpeg_display_commands()
    )
}

/// Run one transcode tier, streaming its progress into the event bus.
fn transcode_tier(
    progress: &Progress<'_>,
    exe: &Path,
    source: &Path,
    out: &Path,
    tier: &VideoTier,
) -> anyhow::Result<()> {
    super::ensure_plain_source_entry(source)?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    progress.emit(tier.stage, tier.from);
    let duration = probe_duration(exe, source);
    let mut command = Command::new(exe);
    command
        .args(ffmpeg_args(source, out, tier))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // ffmpeg is a console program: never flash a console window at the user.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("start {}", exe.display()))?;
    // Drain stderr on its own thread: a failure message must never fill the
    // pipe while this thread reads ffmpeg's progress stream.
    let stderr = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
    });
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(micros) = parse_progress_us(&line) else {
                continue;
            };
            let Some(seconds) = duration else { continue };
            if seconds <= 0.0 {
                continue;
            }
            let fraction = (micros as f64 / 1_000_000.0 / seconds).clamp(0.0, 1.0);
            progress.emit(tier.stage, tier.from + (tier.to - tier.from) * fraction);
        }
    }
    let status = child
        .wait()
        .with_context(|| format!("wait for {}", exe.display()))?;
    let stderr_text = stderr
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if !status.success() {
        let detail = tail(&stderr_text, 600);
        return Err(anyhow!(
            "ffmpeg failed ({}): {detail}\nThe command was:\n  {}",
            status
                .code()
                .map(|c| format!("exit code {c}"))
                .unwrap_or_else(|| "terminated".to_string()),
            display_command(&exe.to_string_lossy(), &ffmpeg_args(source, out, tier))
        ));
    }
    progress.emit(tier.stage, tier.to);
    Ok(())
}

fn tail(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    let mut chars: Vec<char> = trimmed.chars().collect();
    if chars.len() > max {
        chars = chars[chars.len() - max..].to_vec();
    }
    chars.into_iter().collect()
}

/// The source clip's duration in seconds, read from ffmpeg's own stream
/// table. `ffmpeg -i <file>` exits non-zero by design ("At least one output
/// file must be specified") — only the metadata line matters.
fn probe_duration(exe: &Path, source: &Path) -> Option<f64> {
    let mut command = Command::new(exe);
    command
        .arg("-hide_banner")
        .arg("-i")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    parse_duration(&String::from_utf8_lossy(&output.stderr))
}

/// `Duration: HH:MM:SS.ss` out of ffmpeg's stream table (the first one; input
/// files carry exactly one).
pub(crate) fn parse_duration(text: &str) -> Option<f64> {
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("Duration:") else {
            continue;
        };
        let stamp = rest.split(',').next()?.trim();
        return parse_hms(stamp);
    }
    None
}

fn parse_hms(stamp: &str) -> Option<f64> {
    let mut parts = stamp.split(':');
    let hours: f64 = parts.next()?.trim().parse().ok()?;
    let minutes: f64 = parts.next()?.trim().parse().ok()?;
    let seconds: f64 = parts.next()?.trim().parse().ok()?;
    if !(hours.is_finite() && minutes.is_finite() && seconds.is_finite()) {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// One ffmpeg `-progress` line's output timestamp in microseconds.
///
/// `out_time_ms` is micro-seconds as well (ffmpeg's long-standing naming
/// quirk), so both keys carry the same unit; older builds only emit ms.
pub(crate) fn parse_progress_us(line: &str) -> Option<u64> {
    let (key, value) = line.split_once('=')?;
    match key.trim() {
        "out_time_us" | "out_time_ms" => value.trim().parse().ok(),
        _ => None,
    }
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_progress_lines_parse_in_microseconds() {
        // Both keys are emitted by modern ffmpeg and both are microseconds.
        assert_eq!(parse_progress_us("out_time_us=1500000\n"), Some(1_500_000));
        assert_eq!(parse_progress_us("out_time_ms=1500000"), Some(1_500_000));
        assert_eq!(parse_progress_us("frame=25"), None);
        assert_eq!(parse_progress_us("speed=1.5x"), None);
    }

    #[test]
    fn duration_lines_parse_from_the_stream_table() {
        let table = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n  \
                     Duration: 00:01:23.45, start: 0.000000, bitrate: 812 kb/s\n";
        let seconds = parse_duration(table).expect("duration");
        assert!((seconds - 83.45).abs() < 1e-6, "{seconds}");
        // N/A durations (streams with no timestamp) must not parse.
        assert_eq!(parse_duration("  Duration: N/A, start: 0.000000"), None);
    }

    #[test]
    fn display_commands_quote_filters_and_drop_progress_plumbing() {
        let main = &VIDEO_TIERS[0];
        let args = ffmpeg_args(
            Path::new("C:/clips/my clip.mp4"),
            Path::new("out.webm"),
            main,
        );
        let line = display_command("ffmpeg", &args);
        assert!(
            line.starts_with("ffmpeg -y -i \"C:/clips/my clip.mp4\""),
            "{line}"
        );
        assert!(
            line.contains("-vf \"fps=25,scale=1920:1080:flags=lanczos\""),
            "{line}"
        );
        assert!(line.contains("-c:v libvpx-vp9"), "{line}");
        assert!(line.contains("-crf 31"), "{line}");
        assert!(line.ends_with(" out.webm"), "{line}");
        assert!(!line.contains("-progress"), "{line}");
        assert!(!line.contains("pipe:1"), "{line}");
    }
}
