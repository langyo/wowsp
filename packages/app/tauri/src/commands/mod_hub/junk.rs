//! Preview/screenshot "junk" detection — the single source of truth for
//! which package files are non-functional payload (pack screenshots, promo
//! previews, Explorer thumbnails) rather than game assets.
//!
//! Every junk consumer routes through [`is_junk_rel`]: the installer skips
//! junk DESTINATIONS before creating their directories (a screenshot-only
//! folder never lands in `res_mods`), the plan preview drops them from the
//! file list the user sees first, and the installed scan/clean pair surfaces
//! and removes junk older installs left behind. Real override assets — a
//! `gui/ribbons/ribbon.png`, `spaces/PJSC001/tex.png`, any `.dds` — never
//! match: only preview-extension images whose basename OR ANY directory
//! segment names a screenshot/preview marker are junk.

/// Explorer/OS metadata files that are never game payload.
const JUNK_FILE_NAMES: &[&str] = &["desktop.ini", "thumbs.db", "ehthumbs.db", ".ds_store"];

/// Image extensions a preview/screenshot can carry. `.dds` (the game's own
/// texture format) is deliberately absent: a texture named `screenshot.dds`
/// is a real material reference, not a promo image.
const JUNK_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"];

/// Lowercase path-segment markers that brand an image as junk. Matched
/// against EVERY segment (directory or file), so `Screenshots/001.jpg` and
/// `001_preview.jpg` both count.
const JUNK_MARKERS: &[&str] = &[
    "screenshot",
    "screenshots",
    "screen_shot",
    "screen-shot",
    "preview",
    "previews",
    "showcase",
    "thumbnail",
    "预览",
    "截图",
    "宣传图",
];

/// Is this `res_mods`-relative path junk? Accepts either path separator and
/// an optional `.bak` toggle suffix (the disabled twin of a file is the same
/// file for this question — a disabled screenshot is still junk).
pub(crate) fn is_junk_rel(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/").to_ascii_lowercase();
    let bare = normalized.strip_suffix(".bak").unwrap_or(&normalized);
    let basename = bare.rsplit('/').next().unwrap_or(bare);
    if JUNK_FILE_NAMES.contains(&basename) {
        return true;
    }
    let Some((_, ext)) = basename.rsplit_once('.') else {
        return false;
    };
    if !JUNK_IMAGE_EXTS.contains(&ext) {
        return false;
    }
    bare.split('/').any(is_junk_dir_name)
}

/// Is a directory NAME branded as preview/screenshot junk? The directory
/// counterpart of the segment test in [`is_junk_rel`]: a top-level folder
/// named after a marker (`Screenshots/`, `预览/`, …) holds promo art, never
/// game payload — the classifier's unrecognized-root warning skips it.
pub(crate) fn is_junk_dir_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    JUNK_MARKERS.iter().any(|marker| lower.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Junk by name: preview/screenshot images under marker segments, in
    /// Chinese or English, under either path separator, plus the OS metadata
    /// files.
    #[test]
    fn recognizes_preview_and_metadata_junk() {
        for rel in [
            "screenshot.png",
            "Screenshot_2026.jpg",
            "gui/Screenshots/001.png",
            "gui/screenshots/convert/aaa.webp",
            "gui/preview_1.jpg",
            "gui/previews/scheme.webp",
            "showcase/a.gif",
            "thumbnail/a.bmp",
            "PnFMods/Showcase/preview.tiff",
            "预览/1.png",
            "截图加群.png",
            "宣传图/abc.jpeg",
            "screen_shot_1.png",
            "screen-shot.jpg",
            // Either separator spellings.
            "gui\\screenshots\\a.png",
            // The disabled twin of a junk file is still junk.
            "gui/screenshots/a.png.bak",
            "desktop.ini",
            "gui/desktop.ini",
            "sub/Thumbs.db",
            "sub/EHThumbs.db",
            ".DS_Store",
            // Markers in a parent segment brand a plain image name too.
            "content/screenshots/texture.png",
        ] {
            assert!(is_junk_rel(rel), "{rel:?} must be junk");
        }
    }

    /// Functional assets named normally keep installing: HUD art, scene and
    /// gameplay textures, PnF scripts, and `.dds` payloads — even when a
    /// preview-ish word appears in a NON-image file name.
    #[test]
    fn keeps_functional_assets_installable() {
        for rel in [
            "gui/ribbons/ribbon.png",
            "spaces/PJSC001/tex.png",
            "content/gameplay/japan/ship/battleship/JSB039_Yamato_1945_Hull_a.dds",
            "content/unlocks/japan/camo.png",
            "gui/BFGC/BattleWave/battle.xml",
            "PnFMods/Skin/Main.py",
            "PnFModsLoader.py",
            "ime_config.xml",
            "banks/mods/聖園ミカ/mod.xml",
            "screenshot.dds",
            "gui/ribbons/ribbon.png.bak",
            "preview/readme.txt",
            "screenshots/notes.txt",
        ] {
            assert!(!is_junk_rel(rel), "{rel:?} must stay installable");
        }
    }
}
