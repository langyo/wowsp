//! Mod-integrity scanning — the ONE implementation of the static
//! "would this mod tree break the game UI?" checks, extracted so the
//! catalog installer (the install gate in `commands/mod_catalog/install.rs`),
//! the crash analyzer (`commands/game_crash.rs`'s proactive dangling pass)
//! and the on-demand pre-launch scan (the `mod_integrity_scan` command
//! below) share a single bounded scanner instead of three drifting ones.
//!
//! Born from crash report `gc-20261101232118338-22840`: a catalog package
//! shipped glue XML referencing SWF assets that existed neither in the
//! package nor in the client install, and the Scaleform loader hung the
//! game UI at boot instead of erroring. Every check here is static and
//! conservative — a finding requires positive evidence (a reference whose
//! target is provably absent, a .swf whose magic is provably wrong, one
//! load claim made by two different files); absence of evidence (no client
//! index, an unreadable file, a walk truncated by the budget) never
//! becomes an accusation.
//!
//! Windows is where a local client index (`bin/<ver>/idx`) exists, so the
//! dangling-reference pass only fires there; `invalid_swf` and `overlap`
//! are platform-free. Scans are hard-capped (file count, glue-file count,
//! glue size) — this runs on real mod trees with thousands of files.

use anyhow::anyhow;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use wowsp_tauri_shared::CommandResult;

// ── problem/report shapes (the webui types this JSON verbatim) ──────────────

/// `dangling_ref`: glue references an asset present in neither the scanned
/// trees nor the client index.
pub(crate) const KIND_DANGLING_REF: &str = "dangling_ref";
/// `invalid_swf`: a .swf file whose leading bytes are not a legal SWF
/// signature.
pub(crate) const KIND_INVALID_SWF: &str = "invalid_swf";
/// `overlap`: one load claim (element url= / swffile / url source=) made
/// by 2+ DIFFERENT files — advisory, never an install blocker.
pub(crate) const KIND_OVERLAP: &str = "overlap";

/// One integrity finding. Field names are the wire contract (the webui
/// types this JSON as-is) — do not rename or camelCase them.
#[derive(Debug, Clone, Serialize)]
pub struct ModIntegrityProblem {
    /// One of the `KIND_*` strings above.
    pub kind: String,
    /// The offending asset basename (`battle_stats.swf`) — dangling_ref
    /// and overlap.
    pub asset: Option<String>,
    /// The offending file, tree-relative (`gui/broken.swf`) — invalid_swf.
    pub path: Option<String>,
    /// The tree-relative paths of the files referencing/claiming the asset.
    pub files: Vec<String>,
    /// True when the finding's own files sit in the CALLER'S FIRST tree —
    /// the catalog install gate's staged package (single-tree scans mark
    /// everything). The install gate blocks only on staged findings: a
    /// dangling reference the EXISTING tree carries was there before this
    /// package arrived, and refusing the package neither cures it nor
    /// names the real culprit (live report 2026-11-03: six pre-existing
    /// CN-tree references pinned on the clean Radar Timer package).
    pub staged: bool,
}

/// The result of one bounded scan over a set of mod trees.
#[derive(Debug, Clone, Serialize)]
pub struct ModIntegrityReport {
    /// The game root the scan ran for (empty when the caller had none).
    pub game_root: String,
    /// Regular files the walk actually processed (toolchain stubs excluded).
    pub scanned_files: usize,
    /// Findings, ordered dangling_ref → invalid_swf → overlap.
    pub problems: Vec<ModIntegrityProblem>,
}

// ── bounded-walk budgets (the crash analyzer's reference-scan caps) ─────────

/// Entries (files + dirs) one walk may visit — the same 4000-entry budget
/// idea `game_crash.rs`'s reference scan uses on real mod trees.
const WALK_MAX_ENTRIES: usize = 4000;
/// Glue files past this size are skipped: real mod glue is small, and the
/// big text files are data dumps, not load directives.
const GLUE_MAX_BYTES: u64 = 512 * 1024;
/// Glue files deep-read per scan (the crash analyzer's budget): a package
/// with hundreds of configs still scans in one cheap pass.
const GLUE_MAX_FILES: usize = 400;
/// Reference tokens longer than this are template noise, not load paths
/// (same guard as the crash analyzer's dangling pass).
const MAX_REF_LEN: usize = 200;

/// Small text glue worth scanning for asset references. Binary and big
/// files are skipped; the loader directives that hang the UI live in
/// XML/Python/JSON configs.
///
/// `.unbound` is in the list because it is the ONE glue format that is
/// itself a load target: a mod's `gui/unbound2/**/*.unbound` fragment is
/// referenced from its own XML/config glue, and a client update that
/// retires an element makes the fragment's own references stale in exactly
/// the way this scan exists to prove (the crash analyzer's reference walk
/// already reads `.unbound`, see `game_crash.rs` — this list was the
/// asymmetric half).
fn is_glue_text_file(name: &str) -> bool {
    [".xml", ".py", ".json", ".txt", ".yaml", ".cfg", ".unbound"]
        .iter()
        .any(|ext| name.to_ascii_lowercase().ends_with(ext))
}

/// The ModForge toolchain builds packages from templates that reference
/// its own stub SWFs — pure scanner noise, same carve-out as the crash
/// analyzer's dangling pass (case-insensitive, tree-relative).
fn is_toolchain_subtree(rel: &str) -> bool {
    rel.to_ascii_lowercase().starts_with("pnfmods/modforge/")
}

// ── primitives ──────────────────────────────────────────────────────────────

/// True iff `bytes` opens with a legal SWF signature: `FWS` (uncompressed),
/// `CWS` (zlib) or `ZWS` (LZMA) — the three headers the Scaleform loader
/// accepts. Everything else (a text file renamed .swf, a truncated
/// download, an empty placeholder) fails, and the loader's reaction to
/// such payloads is the UI hang this module exists to prevent.
pub(crate) fn swf_magic_ok(bytes: &[u8]) -> bool {
    bytes.starts_with(b"FWS") || bytes.starts_with(b"CWS") || bytes.starts_with(b"ZWS")
}

/// Remove every COMPLETE XML comment span (`<!-- … -->`) from `text`;
/// an unterminated opener is kept verbatim together with everything after
/// it.
///
/// Glue files are XML in practice, and stock client templates use comments
/// to DOCUMENT example load directives: the live `gui/uss_settings.xml`
/// carries a commented-out
/// `<swffile>../unbound/flash/carousel_extended.swf</swffile>` example that
/// nothing loads. Tokenizing the raw text reported that example as a
/// dangling reference (the "发现 1 处潜在模组问题：carousel_extended.swf" card on
/// every boot), and a commented-out `element url=` could likewise read as a
/// competing load claim. Both scanners therefore consume the stripped text:
/// a commented-out directive is neither a load nor a claim.
///
/// Conservative by construction — this is a scanner, not an XML parser, and
/// absence of evidence must never become silence:
/// - only spans with BOTH `<!--` and the matching `-->` are removed (a bare
///   `-->` is plain text, and an opener inside a span is still span text,
///   exactly like XML itself);
/// - an UNTERMINATED `<!--` stays in the output with the remaining text, so
///   a malformed file can never silently lose real references behind it;
/// - the scan reads glue by extension list (xml/py/json/txt/yaml/cfg), so a
///   non-XML file that happens to carry a `<!-- … -->` pair loses whatever
///   sits between the markers. That is the direction this scanner is allowed
///   to err in — a missing finding never accuses anyone — and generated-XML
///   templates embedded in `.py` glue are exactly the case the strip serves;
/// - a single linear pass; the input is copied unchanged when it has no
///   opener (bounded: at most 400 glue files ≤ 512 KiB each per scan).
///
/// Delimiters are ASCII and the offsets land on str boundaries, so the result
/// never splits a multi-byte character.
pub(crate) fn strip_xml_comments(text: &str) -> String {
    const OPEN: &str = "<!--";
    const CLOSE: &str = "-->";
    if !text.contains(OPEN) {
        return text.to_string();
    }
    let mut stripped = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(at) = text[cursor..].find(OPEN) {
        let open = cursor + at;
        stripped.push_str(&text[cursor..open]);
        let body = open + OPEN.len();
        match text[body..].find(CLOSE) {
            Some(close) => {
                // Resume AFTER the closing delimiter; the span's text is
                // gone, whatever it held.
                cursor = body + close + CLOSE.len();
            },
            None => {
                // Unterminated: keep the opener and the rest of the file —
                // a scanner must not swallow references it failed to parse.
                stripped.push_str(&text[open..]);
                return stripped;
            },
        }
    }
    stripped.push_str(&text[cursor..]);
    stripped
}

/// Extract every `.swf` reference token from a text blob: XML/Python mod
/// glue spells URLs and script paths bare, so the token charset is path-
/// safe. Placeholder-bearing tokens are ignored — they are format strings,
/// not real references. The ONE implementation: `commands/game_crash.rs`'s
/// proactive dangling-reference pass consumes this same fn. XML comments are
/// NOT stripped here — every caller passes text through
/// [`strip_xml_comments`] first, so a documented example never reads as a
/// load.
pub(crate) fn swf_refs_in_text(text: &str) -> Vec<String> {
    fn is_token_char(c: char) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '\\' | '~')
    }
    let mut refs: Vec<String> = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if is_token_char(c) {
            current.push(c);
        } else {
            push_swf_token(&mut refs, &current);
            current.clear();
        }
    }
    push_swf_token(&mut refs, &current);
    refs
}

/// The token as a reference: only `.swf` files count (the Scaleform crash
/// class), reduced to the basename — idx tables store names only, and a
/// basename match is the conservative presence test.
fn push_swf_token(refs: &mut Vec<String>, token: &str) {
    let lower = token.replace('\\', "/").to_ascii_lowercase();
    if !lower.ends_with(".swf") || lower.len() <= 4 {
        return;
    }
    let base = lower.rsplit('/').next().unwrap_or(lower.as_str());
    // Toolchain placeholders spell their stubs with a leading "__"
    // (ModForge's __forge_stub.swf) — never a real load target.
    if !base.is_empty() && !base.contains('%') && !base.starts_with("__") {
        refs.push(base.to_string());
    }
}

/// The asset extensions a LOAD DIRECTIVE can name. `.swf` is the Scaleform
/// class the original pass was built for; the rest are the sibling classes
/// the same glue files spell in the same directives, and they matter for
/// exactly one real-world shape:
///
/// the whole-file glue overrides (`gui/uss_settings.xml`,
/// `gui/fontconfig_scaleform.xml`, `gui/battle_elements.xml`) are copied
/// into `res_mods` by a modpack and SHADOW the client's own copy wholesale —
/// the engine never merges XML. After a client update retires or renames a
/// referenced asset, the stale override keeps loading a target that no
/// longer exists and parts of a UI scene (the port event pages among them)
/// silently stop rendering. `.swf`-only tokenization could not see that
/// class at all: `gui/uss_settings.xml`'s vanished loads are `<xmlfile>`
/// entries, and a font-family mismatch after an update is a `.ttf` path in
/// `gui/fontconfig_scaleform.xml`.
const REF_ASSET_EXTS: &[&str] = &["swf", "xml", "ttf", "unbound"];

/// The load directives an asset reference can appear in: the glue files
/// spell the same load as a `<swffile>`/`<xmlfile>` element body, as a
/// `<path>` inside a `<fontconfig>` document, as an `<element url="…">`
/// attribute or as a `<url source="…">` attribute. Deliberately NOT
/// every `.xml`/`.ttf` token in the file: a prose mention or an unrelated
/// data value must never become a finding, so only directive positions
/// are read — and `<path>` only inside a font config, because the tag name
/// is generic enough that other mod configs use it for their own values.
fn directive_refs(text: &str) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    for tag in ["swffile", "xmlfile"] {
        for value in element_text_values(text, tag) {
            push_directive_ref(&mut refs, &value);
        }
    }
    // `<path>` is a load directive ONLY in a font config; the element name
    // is generic enough that an unrelated mod config's own `<path>` value
    // must not be read as a load. The font list is the ONE place the
    // client's `gui/fontconfig_scaleform.xml` (and the mod overrides that
    // shadow it) spells its font files, and a client update that retires a
    // font family is exactly the mismatch this pass reports.
    if text.to_ascii_lowercase().contains("<fontconfig") {
        for value in element_text_values(text, "path") {
            push_directive_ref(&mut refs, &value);
        }
    }
    for value in quoted_attr_values(text, "element", "url") {
        push_directive_ref(&mut refs, &value);
    }
    for value in quoted_attr_values(text, "url", "source") {
        push_directive_ref(&mut refs, &value);
    }
    refs
}

/// One directive value as a reference: comma-separated multi-loads
/// (`<swffile>a.swf,b.swf</swffile>` — the stock `battle_elements.xml`
/// ships several) split into separate basenames, template/format strings
/// and absolute paths rejected, and only [`REF_ASSET_EXTS`] kept. The
/// basename is the conservative presence test the idx index supports (the
/// index stores names, never paths).
fn push_directive_ref(refs: &mut Vec<String>, value: &str) {
    for piece in value.split(',') {
        let piece = piece.trim();
        if piece.is_empty() || piece.contains('%') || piece.starts_with('$') {
            continue;
        }
        // An absolute or drive-qualified path is a client-internal
        // reference (or a URL), not a res_mods-relative load target.
        if piece.contains(':') || piece.starts_with('/') || piece.starts_with('\\') {
            continue;
        }
        let normalized = piece.replace('\\', "/");
        let base = normalized
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        let lower = base.to_ascii_lowercase();
        if lower.len() <= 4 || lower.starts_with("__") {
            continue;
        }
        let Some((_, ext)) = lower.rsplit_once('.') else {
            continue;
        };
        if !REF_ASSET_EXTS.contains(&ext) {
            continue;
        }
        if !refs.iter().any(|r| r == &lower) {
            refs.push(lower);
        }
    }
}

/// Every client asset basename the install index knows (all `bin/<ver>/idx`
/// tables, lowercased). Cached per game root: the parse is a few MB and
/// the scan may run repeatedly. Same `cfg(windows)` gating as the
/// game_crash.rs original it was ported from.
#[cfg(windows)]
pub(crate) fn client_asset_basenames(game_root: &str) -> Option<Arc<HashSet<String>>> {
    static CACHE: OnceLock<Mutex<std::collections::HashMap<String, Arc<HashSet<String>>>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Some(hit) = cache.lock().ok().and_then(|m| m.get(game_root).cloned()) {
        return Some(hit);
    }
    let (_, ver_dir) = super::game_context::latest_bin_dir(Path::new(game_root))?;
    let idx_dir = ver_dir.join("idx");
    let entries = fs::read_dir(&idx_dir).ok()?;
    let mut set: HashSet<String> = HashSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_idx = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("idx"));
        if !is_idx {
            continue;
        }
        let Ok(data) = fs::read(&path) else { continue };
        let Ok(parsed) = game_assets::data::idx::parse(&data) else {
            continue;
        };
        for resource in parsed.resources {
            set.insert(resource.filename.to_ascii_lowercase());
        }
    }
    let set = Arc::new(set);
    if let Ok(mut map) = cache.lock() {
        map.insert(game_root.to_string(), set.clone());
    }
    Some(set)
}

/// Off-Windows there is no local client install to index — the scan runs
/// without the dangling-reference pass (see [`scan_trees`]' conservative
/// skip), like the crash analyzer's `proactive` arm.
#[cfg(not(windows))]
pub(crate) fn client_asset_basenames(_game_root: &str) -> Option<Arc<HashSet<String>>> {
    None
}

/// Test seam: overrides the client index the scan consults so the install
/// gate's tests stay deterministic on machines without a game install
/// (the `TEST_RESTORE_ROOT` pattern).
#[cfg(test)]
pub(crate) static TEST_CLIENT_INDEX: Mutex<Option<Arc<HashSet<String>>>> = Mutex::new(None);

/// Test seam serialization: the seam above is process-global, and BOTH
/// suites whose verdicts depend on its value (this module's tests and the
/// catalog install-gate tests) hold this lock across every scan they
/// assert on — one suite's seam window must never leak into the other's.
#[cfg(test)]
pub(crate) static TEST_CLIENT_INDEX_LOCK: Mutex<()> = Mutex::new(());

/// The client index a scan uses: the test seam first (deterministic
/// fixtures), else the real `bin/<ver>/idx` parse. `None` means "no
/// evidence about the client" — the dangling pass stays silent.
fn client_index_for(game_root: Option<&str>) -> Option<Arc<HashSet<String>>> {
    #[cfg(test)]
    if let Some(idx) = TEST_CLIENT_INDEX
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return Some(idx);
    }
    client_asset_basenames(game_root?)
}

// ── the bounded walk ────────────────────────────────────────────────────────

/// What one walk over the trees gathered. `complete` is false when the
/// entry budget truncated the walk — callers must then treat the presence
/// set as UNRELIABLE (a missing name may simply not have been visited).
struct TreeWalk {
    /// Lowercased file basenames seen anywhere in the trees (the
    /// conservative presence test the dangling-reference scan reads).
    names: HashSet<String>,
    /// (absolute path, tree-relative slash path, BASE INDEX — the staged /
    /// existing attribution the install gate blocks on) of the glue files
    /// worth deep-reading, in walk order.
    glue: Vec<(PathBuf, String, usize)>,
    /// (absolute path, tree-relative slash path, BASE INDEX) of every
    /// .swf file.
    swfs: Vec<(PathBuf, String, usize)>,
    /// Regular files processed (the report's scanned_files).
    scanned_files: usize,
    /// False when the entry budget truncated the walk.
    complete: bool,
}

/// One bounded pass over all trees. The ModForge toolchain subtrees are
/// excluded entirely (their stub SWFs and template glue are scanner noise,
/// never runtime load targets).
fn walk_trees(bases: &[PathBuf]) -> TreeWalk {
    let mut walk = TreeWalk {
        names: HashSet::new(),
        glue: Vec::new(),
        swfs: Vec::new(),
        scanned_files: 0,
        complete: true,
    };
    let mut seen = 0usize;
    'outer: for (base_idx, base) in bases.iter().enumerate() {
        let mut stack = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                seen += 1;
                if seen > WALK_MAX_ENTRIES {
                    walk.complete = false;
                    break 'outer;
                }
                let path = entry.path();
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    stack.push(path);
                    continue;
                }
                let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                    continue;
                };
                // Tree-relative slash path (the wire shape); the walk never
                // escapes its base, so strip_prefix only fails for a base
                // root entry itself.
                let rel = path
                    .strip_prefix(base)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| name.clone());
                // The ModForge carve-out must recognize the STAGED shape
                // too: a catalog batch unpacks into a root that keeps the
                // archive's own `res_mods/` prefix, while the live tree IS
                // res_mods — the producer's operational code is scanner
                // noise under either shape (live report 2026-11-03: the
                // batch's Manifest.py constant hung the ASIA install).
                let rel_lower = rel.to_ascii_lowercase();
                let toolchain_rel = rel_lower
                    .strip_prefix("res_mods/")
                    .unwrap_or(rel_lower.as_str());
                if is_toolchain_subtree(toolchain_rel) {
                    continue;
                }
                walk.scanned_files += 1;
                let lower = name.to_ascii_lowercase();
                walk.names.insert(lower.clone());
                if is_glue_text_file(&name)
                    && meta.len() <= GLUE_MAX_BYTES
                    && walk.glue.len() < GLUE_MAX_FILES
                {
                    walk.glue.push((path, rel, base_idx));
                } else if lower.ends_with(".swf") {
                    walk.swfs.push((path, rel, base_idx));
                }
            }
        }
    }
    walk
}

// ── overlap claims: the load directives two files can fight over ───────────

/// One normalized claim from a load directive, or None when the token is
/// not a real .swf target. Same normalization family as the reference
/// tokenizer: lowercase basename, format-string placeholders and ModForge
/// `__`-stub tokens rejected.
fn normalize_asset_claim(token: &str) -> Option<String> {
    let token = token.trim();
    let lower = token.replace('\\', "/").to_ascii_lowercase();
    if !lower.ends_with(".swf") || lower.len() <= 4 {
        return None;
    }
    let base = lower.rsplit('/').next().unwrap_or(lower.as_str());
    if base.is_empty() || base.contains('%') || base.starts_with("__") {
        return None;
    }
    Some(base.to_string())
}

fn push_claim(claims: &mut Vec<String>, raw: &str) {
    if let Some(asset) = normalize_asset_claim(raw) {
        if !claims.contains(&asset) {
            claims.push(asset);
        }
    }
}

/// Lowercase copy of `text` with BYTE-IDENTICAL offsets (ASCII-only
/// lowering): searches run on the copy, values are sliced from it — the
/// claims are lowercased basenames anyway.
fn ascii_lower(text: &str) -> String {
    text.chars().map(|c| c.to_ascii_lowercase()).collect()
}

/// Values of `attr="…"` on `<tag …>` elements, by a bounded hand scan —
/// the crate keeps its glue parsers regex-free (see game_context.rs's
/// attribute readers). Attribute names only match OUTSIDE quoted spans,
/// so a URL value containing `source=` cannot self-claim.
fn quoted_attr_values(text: &str, tag: &str, attr: &str) -> Vec<String> {
    let lower = ascii_lower(text);
    let bytes = lower.as_bytes();
    let mut values = Vec::new();
    let mut cursor = 0usize;
    while let Some(at) = lower[cursor..].find('<') {
        let open = cursor + at;
        let name_start = open + 1;
        let name_end = bytes[name_start..]
            .iter()
            .position(|b| !b.is_ascii_alphanumeric())
            .map(|p| name_start + p)
            .unwrap_or(bytes.len());
        let tag_matches = name_end > name_start && &lower[name_start..name_end] == tag;
        let body_end = lower[name_end..]
            .find('>')
            .map(|p| name_end + p)
            .unwrap_or(bytes.len());
        if tag_matches {
            // Walk the tag body skipping quoted spans; attribute names are
            // matched at whitespace boundaries only.
            let mut j = name_end;
            let mut quote: Option<u8> = None;
            while j < body_end {
                let b = bytes[j];
                match quote {
                    Some(q) => {
                        if b == q {
                            quote = None;
                        }
                    },
                    None => {
                        if b == b'"' || b == b'\'' {
                            quote = Some(b);
                        } else if b.is_ascii_whitespace() {
                            if let Some(value) = attribute_value_at(&lower, j + 1, body_end, attr) {
                                values.push(value);
                            }
                        }
                    },
                }
                j += 1;
            }
        }
        // Continue AFTER the tag body (a '<' inside a quoted value is not
        // a tag opener worth re-scanning from).
        cursor = body_end.max(open + 1);
    }
    values
}

/// Try to read `attr = "value"` starting at `from` (just past a whitespace
/// boundary inside a tag body ending at `end`).
fn attribute_value_at(lower: &str, from: usize, end: usize, attr: &str) -> Option<String> {
    let bytes = lower.as_bytes();
    let mut k = from;
    while k < end && bytes[k].is_ascii_whitespace() {
        k += 1;
    }
    if !lower[k..].starts_with(attr) {
        return None;
    }
    k += attr.len();
    while k < end && bytes[k].is_ascii_whitespace() {
        k += 1;
    }
    if k >= end || bytes[k] != b'=' {
        return None;
    }
    k += 1;
    while k < end && bytes[k].is_ascii_whitespace() {
        k += 1;
    }
    if k >= end || (bytes[k] != b'"' && bytes[k] != b'\'') {
        return None;
    }
    let q = bytes[k];
    let value_start = k + 1;
    let value_end = lower[value_start..end]
        .find(q as char)
        .map(|p| value_start + p)?;
    Some(lower[value_start..value_end].to_string())
}

/// Inner text of `<tag>…</tag>` elements (whitespace-trimmed). The open
/// tag may carry attributes (`<tag attr="…">`), matching the real glue.
fn element_text_values(text: &str, tag: &str) -> Vec<String> {
    let lower = ascii_lower(text);
    let close = format!("</{tag}>");
    let mut values = Vec::new();
    let mut cursor = 0usize;
    while let Some(at) = lower[cursor..].find('<') {
        let open = cursor + at;
        let name_start = open + 1;
        if !lower[name_start..].starts_with(tag) {
            // Not our tag at this '<' — hop past it (a tag named PREFIX of
            // ours, e.g. <swffiles>, must not match).
            cursor = open + 1;
            continue;
        }
        let name_end = name_start + tag.len();
        let after_name = &lower[name_end..];
        let body_open = match after_name.find('>') {
            Some(p)
                if after_name[..p]
                    .trim()
                    .chars()
                    .all(|c| c.is_ascii_whitespace()) =>
            {
                name_end + p
            },
            _ => {
                cursor = open + 1;
                continue;
            },
        };
        let Some(inner_end) = lower[body_open + 1..].find(&close) else {
            break;
        };
        values.push(
            lower[body_open + 1..body_open + 1 + inner_end]
                .trim()
                .to_string(),
        );
        cursor = body_open + 1 + inner_end + close.len();
    }
    values
}

/// The load-directive claims `overlap` compares: `<element url="…">`
/// attributes, `<swffile>…</swffile>` entries and gui_urls-style
/// `<url source="…">` targets, each normalized to a lowercase asset
/// basename. Deliberately NOT the generic [`swf_refs_in_text`] tokenizer:
/// overlap flags one asset ordered for load by two DIFFERENT files, and a
/// prose mention (README, comment) of the same name must not read as a
/// conflict.
fn overlap_claims(text: &str) -> Vec<String> {
    let mut claims = Vec::new();
    for value in quoted_attr_values(text, "element", "url") {
        push_claim(&mut claims, &value);
    }
    for value in element_text_values(text, "swffile") {
        push_claim(&mut claims, &value);
    }
    for value in quoted_attr_values(text, "url", "source") {
        push_claim(&mut claims, &value);
    }
    claims
}

// ── the scan ────────────────────────────────────────────────────────────────

/// The active mods tree of an install: the latest bin version's
/// `res_mods`, falling back to the safe-mode twin when everything is
/// quarantined — the same resolution `game_crash.rs`'s `res_mods_base`
/// performs. `None` when the install has no mods tree at all.
pub(crate) fn active_res_mods(game_root: &str) -> Option<PathBuf> {
    let (_, ver_dir) = super::mod_hub::latest_bin_version(game_root)?;
    let active = ver_dir.join("res_mods");
    if active.is_dir() {
        return Some(active);
    }
    let twin = super::mod_hub::disabled_res_mods(&ver_dir);
    twin.is_dir().then_some(twin)
}

/// Scan the given mod trees once (bounded) and report, conservatively:
///
/// - `dangling_ref`: an asset reference from small text glue (xml/py/json/
///   txt/yaml/cfg/unbound, ≤512 KiB) whose lowercase basename exists in
///   NEITHER any scanned tree NOR the client index. Two reference classes
///   feed it: the historical bare `.swf` token sweep ([`swf_refs_in_text`])
///   and the load-directive sweep ([`directive_refs`] — `<swffile>` /
///   `<xmlfile>` bodies, `<path>` inside a `<fontconfig>`, and the
///   `element url=` / `url source=` attributes, over [`REF_ASSET_EXTS`]).
///   The directive half is what makes
///   a STALE WHOLE-FILE glue override visible: `gui/uss_settings.xml`,
///   `gui/fontconfig_scaleform.xml` and `gui/battle_elements.xml` shadow
///   the client's own copies wholesale, so after a client update their
///   retired loads are exactly the "part of the page will not render"
///   class this scan exists to catch before it reaches the game. Skipped
///   entirely when the client index is unavailable or the walk was
///   budget-truncated — absence of evidence must not become an accusation
///   (this report REFUSES installs).
/// - `invalid_swf`: a `.swf` file whose content fails [`swf_magic_ok`].
/// - `overlap`: the same load claim (element url= / swffile / url source=)
///   extracted from 2+ DIFFERENT files — never from two claims inside one
///   file. Advisory; the installer must not block on it.
///
/// Both text passes read the glue through [`strip_xml_comments`]: the stock
/// client templates document example load directives inside XML comments, and
/// nothing the loader ignores may become a finding. The budgets and
/// conservatism above are unchanged — stripping only narrows what counts as
/// evidence.
pub(crate) fn scan_trees(game_root: Option<&str>, bases: &[PathBuf]) -> ModIntegrityReport {
    let walk = walk_trees(bases);
    let mut problems: Vec<ModIntegrityProblem> = Vec::new();

    // invalid_swf: the file's own leading bytes are the whole verdict — a
    // 3-byte read per .swf, no full-file load. Unreadable files stay
    // silent (cannot prove, do not accuse).
    for (path, rel, base_idx) in &walk.swfs {
        let invalid = match fs::File::open(path) {
            Ok(mut f) => {
                let mut magic = [0u8; 3];
                let n = f.read(&mut magic).unwrap_or(0);
                !swf_magic_ok(&magic[..n])
            },
            // Unreadable: cannot prove, do not accuse.
            Err(_) => false,
        };
        if invalid {
            problems.push(ModIntegrityProblem {
                kind: KIND_INVALID_SWF.to_string(),
                asset: None,
                path: Some(rel.clone()),
                files: Vec::new(),
                staged: *base_idx == 0,
            });
        }
    }

    // One deep-read per glue file feeds both the dangling pass (references
    // absent everywhere) and the overlap pass (claims made twice).
    let client = if walk.complete {
        client_index_for(game_root)
    } else {
        None
    };
    let mut dangling: BTreeMap<String, Vec<(String, usize)>> = BTreeMap::new();
    let mut claims: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (path, rel, base_idx) in &walk.glue {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        // One strip feeds BOTH passes below: a commented-out directive is
        // neither a dangling load nor a competing claim.
        let text = strip_xml_comments(&text);
        if client.is_some() {
            // Two reference classes, one verdict: the bare-token pass (the
            // crash analyzer's historical contract — `.swf` anywhere in the
            // text) and the directive pass (a load directive naming ANY of
            // REF_ASSET_EXTS, read only from directive positions so prose
            // never accuses). Both reduce to a lowercase basename and both
            // stay silent unless the tree AND the client index lack it.
            let token_refs = swf_refs_in_text(&text);
            let directive = directive_refs(&text);
            for asset in token_refs.into_iter().chain(directive) {
                if walk.names.contains(&asset)
                    || client.as_ref().is_some_and(|c| c.contains(&asset))
                    || asset.len() > MAX_REF_LEN
                {
                    continue;
                }
                let files = dangling.entry(asset).or_default();
                if !files.iter().any(|f| f.0 == rel.as_str()) {
                    files.push((rel.clone(), *base_idx));
                }
            }
        }
        for asset in overlap_claims(&text) {
            let files = claims.entry(asset).or_default();
            if !files.iter().any(|f| f == rel) {
                files.push(rel.clone());
            }
        }
    }
    for (asset, mut files) in dangling {
        files.sort();
        let staged = files.iter().any(|(_, base)| *base == 0);
        problems.push(ModIntegrityProblem {
            kind: KIND_DANGLING_REF.to_string(),
            asset: Some(asset),
            path: None,
            files: files.into_iter().map(|(rel, _)| rel).collect(),
            staged,
        });
    }
    // Overlap only fires across DIFFERENT files: the per-claimant list is
    // deduped, so two claims inside one file stay a single entry.
    for (asset, mut files) in claims {
        if files.len() >= 2 {
            files.sort();
            problems.push(ModIntegrityProblem {
                kind: KIND_OVERLAP.to_string(),
                asset: Some(asset),
                path: None,
                files,
                staged: true,
            });
        }
    }

    ModIntegrityReport {
        game_root: game_root.unwrap_or_default().to_string(),
        scanned_files: walk.scanned_files,
        problems,
    }
}

// ── the command ─────────────────────────────────────────────────────────────

/// The on-demand mod-integrity scan (the mod-hub section's health probe):
/// resolves the install's active res_mods tree (or the safe-mode twin when
/// everything is quarantined) and runs the shared bounded scanner over it.
/// A missing mods tree answers an EMPTY report rather than an error — "no
/// mods installed" is a clean bill, not a failure — and so does a root
/// with no bin version yet; only a present, scannable tree can accuse.
#[tauri::command]
pub async fn mod_integrity_scan(game_root: String) -> CommandResult<ModIntegrityReport> {
    // Bounded fs work (≤4000 entries, ≤400 small reads) — still kept off
    // the async runtime threads, like every other scanning command.
    let report = tauri::async_runtime::spawn_blocking(move || match active_res_mods(&game_root) {
        Some(base) => scan_trees(Some(&game_root), &[base]),
        None => ModIntegrityReport {
            game_root,
            scanned_files: 0,
            problems: Vec::new(),
        },
    })
    .await
    .map_err(|e| anyhow!("mod integrity scan task failed: {e}"))?;
    Ok(report)
}

// ── pre-launch conflict notify (the watchdog's launch signal) ───────────────

/// Tauri event broadcast when a pre-launch mod-integrity scan finds
/// problems. The payload is the serialized [`ModIntegrityReport`]; the
/// webui owns the toast (and its re-toast policy) off this one event.
pub const MOD_CONFLICT_EVENT: &str = "wowsp://mod-conflict";

/// Game roots this boot already notified about — the once-per-boot dedupe:
/// a client relaunching several times in one session must not re-toast the
/// same tree (the webui's re-toast policy handles redisplay).
static NOTIFIED_ROOTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// The once-per-boot dedupe core: true the FIRST time a root is seen this
/// boot, false afterwards. Kept separate from the spawn so the contract is
/// testable without an AppHandle.
fn should_notify_root(game_root: &str) -> bool {
    let set = NOTIFIED_ROOTS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut guard = set.lock().unwrap_or_else(|p| p.into_inner());
    guard.insert(game_root.to_string())
}

/// The pre-launch conflict check the crash watchdog fires the moment a NEW
/// client pid is FIRST tracked — wowsp never launches the game itself
/// (Steam does), so first-sight is the one reliable "game is starting"
/// signal. Fire-and-forget: the bounded scan runs on the blocking pool, a
/// missing mods tree skips silently, a clean scan logs one info line (the
/// app log is a support surface), and only a report WITH problems emits
/// [`MOD_CONFLICT_EVENT`] to all windows — once per boot per game root.
/// Never blocks or fails the caller: every error path is swallowed into
/// the log.
pub fn scan_and_notify_async(app: tauri::AppHandle, game_root: String) {
    tauri::async_runtime::spawn(async move {
        let report = match tauri::async_runtime::spawn_blocking({
            let game_root = game_root.clone();
            move || match active_res_mods(&game_root) {
                Some(base) => scan_trees(Some(&game_root), &[base]),
                None => ModIntegrityReport {
                    game_root,
                    scanned_files: 0,
                    problems: Vec::new(),
                },
            }
        })
        .await
        {
            Ok(report) => report,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    game_root = %game_root,
                    "pre-launch mod integrity scan task failed"
                );
                return;
            },
        };
        // No mods tree (or nothing scanned): nothing to accuse — silence,
        // same contract as mod_integrity_scan.
        if report.problems.is_empty() {
            if report.scanned_files > 0 {
                tracing::info!(
                    game_root = %game_root,
                    scanned = report.scanned_files,
                    "pre-launch mod integrity scan clean"
                );
            }
            return;
        }
        if !should_notify_root(&game_root) {
            return;
        }
        let problems = report.problems.len();
        use tauri::Emitter;
        if let Err(e) = app.emit(MOD_CONFLICT_EVENT, &report) {
            tracing::warn!(error = %e, "emit mod-conflict event failed");
            // The emit never happened — let the next launch retry instead
            // of losing this boot's notification to a dead window.
            if let Some(set) = NOTIFIED_ROOTS.get() {
                set.lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&game_root);
            }
            return;
        }
        tracing::warn!(
            game_root = %game_root,
            problems,
            "mod conflicts detected before game launch"
        );
    });
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp root cleaned before + after each use (the repo's mod_hub /
    /// game_crash test pattern).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("wowsp-modintegrity-{tag}"));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp root");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn touch(&self, rel: &str, content: &[u8]) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdirs");
            fs::write(&path, content).expect("write");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A minimal legal SWF payload (signature + version + length bytes).
    fn swf_bytes() -> Vec<u8> {
        let mut v = b"CWS".to_vec();
        v.extend([4, 1, 0, 0, 0]);
        v
    }

    fn seam_guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_CLIENT_INDEX_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn swf_magic_accepts_the_three_headers_and_rejects_the_rest() {
        assert!(swf_magic_ok(b"FWS"));
        assert!(swf_magic_ok(b"CWS"));
        assert!(swf_magic_ok(b"ZWS"));
        assert!(swf_magic_ok(b"FWS\x06\x00"));
        assert!(swf_magic_ok(b"ZWS-rest"));
        // Lowercase is not a signature; renamed text and empty payloads
        // are exactly the corruption class this check exists for.
        assert!(!swf_magic_ok(b"fws"));
        assert!(!swf_magic_ok(b"not a swf"));
        assert!(!swf_magic_ok(b""));
        assert!(!swf_magic_ok(b"FW"));
    }

    /// Lockstep evidence with game_crash.rs: the same fixture its
    /// swf_references_extract_from_mod_glue test uses must extract the
    /// same references here.
    #[test]
    fn swf_references_extract_from_mod_glue() {
        let text = r#"<element url="battle_stats.swf">
        <swffile>../unbound/mods/SecondaryArmament.swf</swffile>
        <path> gui/fonts/WoWsSymbol.ttf </path>
        <format>%s.swf</format>
        <notaref>icon_default.png</notaref>
    "#;
        let refs = swf_refs_in_text(text);
        assert!(refs.contains(&"battle_stats.swf".to_string()), "{refs:?}");
        assert!(
            refs.contains(&"secondaryarmament.swf".to_string()),
            "{refs:?}"
        );
        assert!(!refs.iter().any(|r| r.contains('%')), "{refs:?}");
        assert!(!refs.iter().any(|r| r.ends_with(".png")), "{refs:?}");
    }

    #[test]
    fn walk_trees_lowercases_and_skips_toolchain() {
        let dir = TempDir::new("basenames");
        dir.touch("gui/Battle_stats.SWF", b"CWS0000");
        dir.touch("PnFMods/ModForge/Validate.py", b"stub.swf");
        dir.touch("PnFMods/ModForge/stubs/__forge_stub.swf", b"garbage");
        dir.touch("config.json", b"{}");
        let names = walk_trees(&[dir.path().to_path_buf()]).names;
        assert!(names.contains("battle_stats.swf"), "{names:?}");
        assert!(names.contains("config.json"), "{names:?}");
        // The toolchain subtree contributes nothing — neither its glue nor
        // its stub swfs.
        assert!(!names.contains("validate.py"), "{names:?}");
        assert!(!names.contains("__forge_stub.swf"), "{names:?}");
    }

    #[test]
    fn scan_trees_flags_dangling_invalid_and_overlap() {
        let _seam = seam_guard();
        let dir = TempDir::new("scan");
        // glue: one dangling reference + one swffile claim …
        dir.touch(
            "gui/battle.xml",
            b"<element url=\"ghost.swf\"><swffile>shared.swf</swffile></element>",
        );
        // … a second file claiming the SAME asset via the gui_urls shape …
        dir.touch("gui/other.xml", b"<url source=\"shared.swf\"/>");
        // … a corrupt and a healthy .swf …
        dir.touch("gui/broken.swf", b"this is text, not a swf");
        dir.touch("gui/healthy.swf", &swf_bytes());
        // … and a prose mention: the generic reference tokenizer (the
        // crash analyzer's contract) DOES flag it as a dangling
        // reference, while the overlap extractors (load directives only)
        // must not read it as a claim.
        dir.touch("readme.txt", b"this mod replaces shared.swf visuals");

        // Client index knows neither ghost nor shared → both classes fire.
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(HashSet::new()));
        let report = scan_trees(Some("D:/game"), &[dir.path().to_path_buf()]);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;

        assert!(report.scanned_files >= 5, "{}", report.scanned_files);
        let dangling: Vec<_> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_DANGLING_REF)
            .collect();
        assert_eq!(dangling.len(), 2, "{:?}", report.problems);
        let ghost = dangling
            .iter()
            .find(|p| p.asset.as_deref() == Some("ghost.swf"))
            .expect("ghost.swf dangling");
        assert_eq!(ghost.files, vec!["gui/battle.xml".to_string()]);
        // The prose mention lands on the generic reference list (and only
        // there — see the overlap assertions below).
        let shared = dangling
            .iter()
            .find(|p| p.asset.as_deref() == Some("shared.swf"))
            .expect("shared.swf dangling");
        assert_eq!(
            shared.files,
            vec![
                "gui/battle.xml".to_string(),
                "gui/other.xml".to_string(),
                "readme.txt".to_string(),
            ]
        );

        let invalid: Vec<_> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_INVALID_SWF)
            .collect();
        assert_eq!(invalid.len(), 1, "{:?}", report.problems);
        assert_eq!(invalid[0].path.as_deref(), Some("gui/broken.swf"));

        let overlap: Vec<_> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_OVERLAP)
            .collect();
        assert_eq!(overlap.len(), 1, "{:?}", report.problems);
        assert_eq!(overlap[0].asset.as_deref(), Some("shared.swf"));
        assert_eq!(
            overlap[0].files,
            vec!["gui/battle.xml".to_string(), "gui/other.xml".to_string()]
        );
        // The healthy swf produced nothing.
        assert!(
            !report
                .problems
                .iter()
                .any(|p| p.path.as_deref() == Some("gui/healthy.swf")),
            "{:?}",
            report.problems
        );
    }

    /// Conservatism: without a client index the dangling pass stays silent
    /// (same reference, same tree), and a client-indexed asset is never
    /// dangling even when the trees lack it. invalid_swf is index-free
    /// and still fires.
    #[test]
    fn scan_trees_needs_client_index_for_dangling_refs() {
        let _seam = seam_guard();
        let dir = TempDir::new("scan-noclient");
        dir.touch("gui/battle.xml", b"<element url=\"ghost.swf\">");
        dir.touch("gui/broken.swf", b"garbage");
        let bases = [dir.path().to_path_buf()];

        // No index at all (None game_root, seam cleared): no dangling.
        let report = scan_trees(None, &bases);
        assert!(
            !report.problems.iter().any(|p| p.kind == KIND_DANGLING_REF),
            "{:?}",
            report.problems
        );
        // The magic check never depended on the index.
        assert_eq!(
            report
                .problems
                .iter()
                .filter(|p| p.kind == KIND_INVALID_SWF)
                .count(),
            1
        );

        // Index knows the asset: still no dangling finding.
        *TEST_CLIENT_INDEX.lock().unwrap() =
            Some(Arc::new(HashSet::from(["ghost.swf".to_string()])));
        let report = scan_trees(Some("D:/game"), &bases);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;
        assert!(
            !report.problems.iter().any(|p| p.kind == KIND_DANGLING_REF),
            "{:?}",
            report.problems
        );
    }

    /// The comment strip is conservative: complete spans go, and an
    /// unterminated opener keeps itself and everything after it (a malformed
    /// file must never silently lose real references).
    #[test]
    fn strip_xml_comments_removes_complete_spans_only() {
        assert_eq!(strip_xml_comments("plain text"), "plain text");
        assert_eq!(
            strip_xml_comments("before<!-- <swffile>gone.swf</swffile> -->after"),
            "beforeafter"
        );
        assert_eq!(strip_xml_comments("a<!-- one -->b<!-- two -->c"), "abc");
        // A bare closer without an opener is plain text, not a span end.
        assert_eq!(strip_xml_comments("a --> b <!-- c --> d"), "a --> b  d");
        // An opener inside a span is span text, exactly like XML itself.
        assert_eq!(
            strip_xml_comments("a<!-- x <!-- y --> b <swffile>keep.swf</swffile>"),
            "a b <swffile>keep.swf</swffile>"
        );
        // Unterminated: the opener and the rest of the file survive verbatim.
        let malformed = "a<!-- b <swffile>keep.swf</swffile>";
        assert_eq!(strip_xml_comments(malformed), malformed);
        // Multi-byte characters on either side of a span stay intact.
        assert_eq!(strip_xml_comments("发现<!-- 隐藏 -->问题"), "发现问题");
    }

    /// A commented-out load directive is neither a load nor a claim, while a
    /// real directive outside the comment still produces both findings (live
    /// false positive: the stock uss_settings.xml template documents a
    /// carousel_extended.swf example in an XML comment).
    #[test]
    fn scan_trees_ignores_commented_out_references_and_claims() {
        let _seam = seam_guard();
        let dir = TempDir::new("commented");
        dir.touch(
            "gui/commented.xml",
            br#"<!-- documented example, not a load:
                <swffile>../unbound/flash/carousel_extended.swf</swffile>
                <element url="present_only.swf"/>
                <url source="present_only.swf"/>
            -->
            <element url="real_ghost.swf"/>"#,
        );
        // The REAL claim is made twice, by two different files — overlap fires.
        // present_only.swf is claimed for real here AND inside the comment
        // above: an unstripped claim pass would read a second claimant and
        // this test's overlap list would grow beyond real_ghost.swf.
        dir.touch(
            "gui/other.xml",
            b"<element url=\"real_ghost.swf\"/><element url=\"present_only.swf\"/>",
        );
        // A real file of that name keeps its claim from reading as dangling.
        dir.touch("gui/present_only.swf", &swf_bytes());
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(HashSet::new()));
        let report = scan_trees(Some("D:/game"), &[dir.path().to_path_buf()]);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;

        let dangling: Vec<&str> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_DANGLING_REF)
            .filter_map(|p| p.asset.as_deref())
            .collect();
        assert_eq!(dangling, vec!["real_ghost.swf"], "{:?}", report.problems);
        let overlap: Vec<&str> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_OVERLAP)
            .filter_map(|p| p.asset.as_deref())
            .collect();
        assert_eq!(overlap, vec!["real_ghost.swf"], "{:?}", report.problems);
    }

    /// The real-world fixture: the stock client gui/uss_settings.xml template
    /// documents its example load with a commented-out carousel_extended.swf
    /// entry. Exactly the one genuinely missing reference may be reported —
    /// the example that produced the false pre-launch card every boot stays
    /// silent.
    #[test]
    fn stock_uss_settings_example_comment_yields_only_the_genuine_finding() {
        let _seam = seam_guard();
        let dir = TempDir::new("uss-settings");
        dir.touch(
            "gui/uss_settings.xml",
            br#"<?xml version="1.0" encoding="utf-8"?>
<gui_settings>
    <!-- Template example:
        <element class="lesta.libs.unbound.UnboundElement" url="../unbound/flash/carousel_extended.swf">
            <swffile>../unbound/flash/carousel_extended.swf</swffile>
        </element>
    -->
    <group name="USS_Settings">
        <element url="gui/unbound/flash/really_missing.swf"/>
    </group>
</gui_settings>"#,
        );
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(HashSet::new()));
        let report = scan_trees(Some("D:/game"), &[dir.path().to_path_buf()]);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;
        assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
        assert_eq!(report.problems[0].kind, KIND_DANGLING_REF);
        assert_eq!(
            report.problems[0].asset.as_deref(),
            Some("really_missing.swf")
        );
    }

    /// A malformed file whose comment opener never closes keeps its
    /// references visible: swallowing them would hide a real dangling load.
    #[test]
    fn scan_trees_keeps_references_after_an_unterminated_comment() {
        let _seam = seam_guard();
        let dir = TempDir::new("unterminated");
        dir.touch(
            "gui/malformed.xml",
            b"<element url=\"before.swf\"/><!-- malformed, no close\n<element url=\"kept_ghost.swf\"/>",
        );
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(HashSet::new()));
        let report = scan_trees(Some("D:/game"), &[dir.path().to_path_buf()]);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;
        let dangling: Vec<&str> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_DANGLING_REF)
            .filter_map(|p| p.asset.as_deref())
            .collect();
        assert_eq!(
            dangling,
            vec!["before.swf", "kept_ghost.swf"],
            "{:?}",
            report.problems
        );
    }

    #[test]
    fn overlap_never_fires_within_one_file() {
        let _seam = seam_guard();
        let dir = TempDir::new("overlap-samefile");
        // One file claims the same asset three different ways — the
        // per-claimant list stays a single entry and overlap stays silent.
        dir.touch(
            "gui/one.xml",
            b"<element url=\"dupe.swf\"><swffile>dupe.swf</swffile></element>
              <url source=\"dupe.swf\"/>",
        );
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(HashSet::new()));
        let report = scan_trees(Some("D:/game"), &[dir.path().to_path_buf()]);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;
        assert!(
            !report.problems.iter().any(|p| p.kind == KIND_OVERLAP),
            "{:?}",
            report.problems
        );
        // And with a second claimant it does fire.
        dir.touch("gui/two.py", b"# <url source=\"dupe.swf\">");
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(HashSet::new()));
        let report = scan_trees(Some("D:/game"), &[dir.path().to_path_buf()]);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;
        let overlap: Vec<_> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_OVERLAP)
            .collect();
        assert_eq!(overlap.len(), 1, "{:?}", report.problems);
        assert_eq!(overlap[0].asset.as_deref(), Some("dupe.swf"));
        assert_eq!(overlap[0].files.len(), 2, "{:?}", overlap[0].files);
    }

    /// The wire shape the webui will type: exact field names, no
    /// camelCase, absent optionals serialized as null (never skipped).
    #[test]
    fn report_serializes_with_the_contract_field_names() {
        let report = ModIntegrityReport {
            game_root: "D:/game".into(),
            scanned_files: 3,
            problems: vec![ModIntegrityProblem {
                kind: KIND_INVALID_SWF.into(),
                asset: None,
                path: Some("gui/broken.swf".into()),
                files: Vec::new(),
                staged: true,
            }],
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["game_root"], "D:/game", "{json}");
        assert_eq!(json["scanned_files"], 3, "{json}");
        assert_eq!(json["problems"][0]["kind"], "invalid_swf", "{json}");
        assert_eq!(json["problems"][0]["path"], "gui/broken.swf", "{json}");
        assert!(json["problems"][0]["asset"].is_null(), "{json}");
        assert!(json["problems"][0]["files"].is_array(), "{json}");
    }

    /// The wire event name the webui listens for — a rename would silently
    /// disconnect every pre-launch toast.
    #[test]
    fn mod_conflict_event_has_the_wire_name() {
        assert_eq!(MOD_CONFLICT_EVENT, "wowsp://mod-conflict");
    }

    /// The once-per-boot dedupe: the first sight of a root notifies, every
    /// repeat in the same boot stays silent (the webui's re-toast policy
    /// owns redisplay, so the backend must not re-emit).
    #[test]
    fn once_per_boot_dedupe_marks_each_root_once() {
        let root = "D:/game-dedupe-probe";
        assert!(should_notify_root(root), "first sight notifies");
        assert!(!should_notify_root(root), "repeat sight is silent");
        // A DIFFERENT root still notifies (per-root, not global).
        assert!(should_notify_root("D:/game-dedupe-probe-other"));
        assert!(!should_notify_root("D:/game-dedupe-probe-other"));
    }

    /// The toolchain carve-out must recognize the STAGED extraction shape:
    /// a catalog batch unpacks into a root that keeps the archive's own
    /// `res_mods/` prefix, and ModForge's manifest builder names its own
    /// boot-time output (ForgeDefinitions.swf) — a producer reference,
    /// not a dangling load (live report 2026-11-03: the ASIA sync refused
    /// Radar Timer + ModForge on exactly this file).
    #[test]
    fn toolchain_carveout_tolerates_the_staged_res_mods_prefix() {
        let dir = TempDir::new("toolchain-staged");
        dir.touch(
            "res_mods/PnFMods/ModForge/Manifest.py",
            b"DEFINITIONS_SWF = PAYLOAD_DIR + 'ForgeDefinitions.swf'",
        );
        // A sibling view package's ForgeBlueprints manifest stays in scope:
        // xml IS glue — only the producer's own subtree is exempt.
        dir.touch(
            "res_mods/ForgeBlueprints/RadarTimer.xml",
            b"<element url=\"ghost.swf\"/>",
        );
        let _seam = seam_guard();
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(HashSet::new()));
        let report = scan_trees(Some("D:/game"), &[dir.path().to_path_buf()]);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;
        let dangling: Vec<_> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_DANGLING_REF)
            .collect();
        assert_eq!(dangling.len(), 1, "{:?}", report.problems);
        assert_eq!(dangling[0].asset.as_deref(), Some("ghost.swf"));
        assert!(
            !dangling[0].files.iter().any(|f| f.contains("ModForge")),
            "the producer's own code must not be accused: {:?}",
            dangling[0].files
        );
    }

    /// The staged/existing attribution: a finding whose referencing files
    /// sit in the FIRST base (the gate's staged package) tags staged=true;
    /// a finding only the SECOND base (the existing tree) carries tags
    /// staged=false — the install gate blocks on the former and logs the
    /// latter.
    #[test]
    fn scan_trees_tags_findings_with_staged_attribution() {
        let _seam = seam_guard();
        let staged = TempDir::new("attrib-staged");
        let existing = TempDir::new("attrib-existing");
        staged.touch(
            "gui/staged_view.xml",
            b"<element url=\"staged_ghost.swf\"/>",
        );
        existing.touch("gui/old_overlay.xml", b"<element url=\"old_ghost.swf\"/>");
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(HashSet::new()));
        let report = scan_trees(
            Some("D:/game"),
            &[staged.path().to_path_buf(), existing.path().to_path_buf()],
        );
        *TEST_CLIENT_INDEX.lock().unwrap() = None;
        let staged_finding = report
            .problems
            .iter()
            .find(|p| p.asset.as_deref() == Some("staged_ghost.swf"))
            .expect("staged dangle");
        assert!(staged_finding.staged, "{:?}", staged_finding);
        let existing_finding = report
            .problems
            .iter()
            .find(|p| p.asset.as_deref() == Some("old_ghost.swf"))
            .expect("existing dangle");
        assert!(!existing_finding.staged, "{:?}", existing_finding);
    }

    /// The stale whole-file glue override (field report: the port's
    /// Arsenal/Black-Friday event page renders only partially). A modpack
    /// copies `gui/uss_settings.xml` + `gui/fontconfig_scaleform.xml` into
    /// res_mods, where they shadow the client's own copies WHOLESALE — the
    /// engine never merges XML. Once a client update retires the assets
    /// those overrides load, the stale copy keeps asking for them. This is
    /// the exact real-world fixture from the maintainer's CN install
    /// (bin/13357822): the four missing `<xmlfile>`/`<swffile>` loads and
    /// the font paths. `.swf`-only tokenization missed every `.xml` load,
    /// which is why the directive pass exists — pin all of them.
    #[test]
    fn stale_glue_overrides_report_their_retired_loads() {
        let _seam = seam_guard();
        let dir = TempDir::new("stale-glue");
        dir.touch(
            "gui/uss_settings.xml",
            br#"<?xml version="1.0" ?>
<uss_settings.xml>
    <default>
        <xmlfile>../unbound/styles.xml</xmlfile>
    </default>
    <mods>
        <swffile>../unbound/mods/PortInterface/Expressions.swf</swffile>
        <xmlfile>../unbound/mods/PortInterface/GoodNews.xml</xmlfile>
        <swffile>../unbound/mods/InfoPanelSelf.swf</swffile>
        <xmlfile>../unbound/mods/InfoPanelSelf.xml</xmlfile>
        <swffile>../unbound/mods/SmokeIndicator.swf</swffile>
        <xmlfile>../unbound/mods/SmokeIndicator.xml</xmlfile>
    </mods>
</uss_settings.xml>"#,
        );
        dir.touch(
            "gui/fontconfig_scaleform.xml",
            br#"<fontconfig>
<family>
<embedded> $WWSDefaultFont </embedded>
<path> gui/fonts/WoWsSymbol.ttf </path>
<path> gui/fonts/Exo2-Bold.ttf </path>
</family>
</fontconfig>"#,
        );
        // The client index knows styles.xml + expressions.swf + a stock
        // font — everything the CURRENT client still ships. The
        // retired targets stay unknown, which is what makes them findings.
        let mut index: HashSet<String> = HashSet::new();
        for name in [
            "styles.xml",
            "expressions.swf",
            "source_han_sans_cn_medium_wh.ttf",
        ] {
            index.insert(name.to_string());
        }
        *TEST_CLIENT_INDEX.lock().unwrap() = Some(Arc::new(index));
        let report = scan_trees(Some("D:/game"), &[dir.path().to_path_buf()]);
        *TEST_CLIENT_INDEX.lock().unwrap() = None;
        let dangling: Vec<&str> = report
            .problems
            .iter()
            .filter(|p| p.kind == KIND_DANGLING_REF)
            .filter_map(|p| p.asset.as_deref())
            .collect();
        // The four retired unbound loads and the two retired fonts. The
        // surviving `styles.xml` / `expressions.swf` must stay silent — a
        // current client asset is never an accusation.
        for expected in [
            "goodnews.xml",
            "infopanelself.swf",
            "infopanelself.xml",
            "smokeindicator.swf",
            "smokeindicator.xml",
            "wowssymbol.ttf",
            "exo2-bold.ttf",
        ] {
            assert!(
                dangling.contains(&expected),
                "{expected} must be reported: {dangling:?}"
            );
        }
        for quiet in ["styles.xml", "expressions.swf"] {
            assert!(
                !dangling.contains(&quiet),
                "a client-shipped asset must never be accused: {dangling:?}"
            );
        }
    }

    /// Prose and non-directive values must stay silent: the directive pass
    /// reads only load positions, so a README or an unrelated data value
    /// naming a missing `.xml`/`.ttf` never accuses anyone.
    #[test]
    fn directive_refs_ignore_prose_and_non_load_values() {
        let text = r#"<root>
            <format>%s.xml</format>
            <comment>see missing_font.ttf in the readme</comment>
            <value>/abs/path/other.xml</value>
            <swffile>../unbound/mods/real_load.swf</swffile>"#;
        let refs = directive_refs(text);
        assert_eq!(refs, vec!["real_load.swf"], "{refs:?}");
    }

    /// `<path>` is a load directive ONLY inside a `<fontconfig>` document:
    /// the tag name is generic, and an unrelated config spelling its own
    /// `<path>` value must never be read as a load (that would accuse a
    /// clean mod of a dangling reference the engine never looks for).
    #[test]
    fn path_directives_only_count_inside_a_font_config() {
        let fontconfig = r#"<fontconfig><family>
            <path> gui/fonts/Missing.ttf </path>
        </family></fontconfig>"#;
        assert!(directive_refs(fontconfig).contains(&"missing.ttf".to_string()));
        let other = r#"<config><path> ../data/some.xml </path></config>"#;
        assert!(
            directive_refs(other).is_empty(),
            "a non-fontconfig <path> is not a load: {:?}",
            directive_refs(other)
        );
    }

    /// Comma-separated multi-loads (the stock `battle_elements.xml` shape:
    /// `url="gui_slots.swf,scenario_markers.swf"`) split into separate
    /// references, and template/absolute spellings are rejected.
    #[test]
    fn directive_refs_split_multi_loads_and_reject_templates() {
        let text = r#"<element url="gui_slots.swf,scenario_markers.swf"/>
<url source="https://cdn.example/thing.swf"/>
<element url="ok.xml"/>"#;
        let refs = directive_refs(text);
        assert!(refs.contains(&"gui_slots.swf".to_string()), "{refs:?}");
        assert!(
            refs.contains(&"scenario_markers.swf".to_string()),
            "{refs:?}"
        );
        assert!(refs.contains(&"ok.xml".to_string()), "{refs:?}");
        assert!(
            !refs.iter().any(|r| r.contains(":")),
            "URL/absolute values are not load targets: {refs:?}"
        );
    }

    /// `.unbound` fragments are glue AND load targets: a stale fragment's
    /// own retired references must be readable (the crash analyzer already
    /// walks the format; the integrity list was the asymmetric half).
    #[test]
    fn unbound_fragments_are_scanned_as_glue() {
        assert!(is_glue_text_file("gui/unbound2/mods/Probe.unbound"));
        assert!(is_glue_text_file("gui/unbound2/mod/Battle.UNBOUND"));
    }
}
