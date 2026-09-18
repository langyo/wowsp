//! On-device row OCR through the Windows.Media.Ocr engine (PR 3b).
//!
//! [`super::row_recognize`] crops each Tab-table row's name strip; this
//! module reads the text out of those crops with the OS-bundled OCR engine
//! (`Windows.Media.Ocr`) — no model download and no third-party runtime:
//! the `windows` crate projections are already in the tree for the capture
//! path. Design points the overlay pipeline depends on:
//!
//! - the [`OcrEngine`] is created ONCE per process ([`OCR_ENGINE`], a
//!   `OnceLock` reached through [`WindowsOcrRecognizer::acquire`]) and only
//!   cloned per capture — engine construction costs tens of ms and must not
//!   land on every Tab press;
//! - every per-call failure degrades to `None` (logged at debug, never
//!   warn-ed per row) — a broken OCR stack must neither panic the watcher
//!   thread nor flood the log at one capture per rate-limit window;
//! - no COM apartment is initialized by hand: windows-core bootstraps the
//!   MTA itself (`CoIncrementMTAUsage` inside its factory loads) and the
//!   async recognize is awaited through a kernel event
//!   (`IAsyncOperation::get`), so plain std watcher threads work without a
//!   tokio runtime handle.

use std::sync::OnceLock;

use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapBufferAccessMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::{OcrEngine, OcrResult};
use windows::System::UserProfile::GlobalizationPreferences;
use windows::Win32::System::WinRT::IMemoryBufferByteAccess;
use windows::core::{HRESULT, Interface};

// The module is `#[path]`-included as a child of `row_recognize`, so the
// trait lives directly one scope up.
use super::RowRecognizer;

/// Process-wide OCR engine: `Some` once a language was picked and the
/// engine constructed, `None` (cached too — creation is not retried every
/// capture) when no recognizer language is available. Built by
/// [`create_engine`], consumed via [`WindowsOcrRecognizer::acquire`].
static OCR_ENGINE: OnceLock<Option<OcrEngine>> = OnceLock::new();

/// The Windows OCR row recognizer. Holds a clone of the shared engine; the
/// engine object is free-threaded (agile), so calling it from the std
/// watcher thread is safe.
pub(crate) struct WindowsOcrRecognizer {
    engine: OcrEngine,
}

impl WindowsOcrRecognizer {
    /// Select the shared engine, creating it on first use. `None` = the OS
    /// has no usable OCR language pack — the caller (engine selection in
    /// `row_recognize`) degrades to the null engine and warns once.
    pub(crate) fn acquire() -> Option<Self> {
        let engine = OCR_ENGINE.get_or_init(create_engine).clone()?;
        Some(Self { engine })
    }
}

impl RowRecognizer for WindowsOcrRecognizer {
    /// Read one row-name strip. Returns the raw line text (matched against
    /// the roster elsewhere); `None` on any failure or an empty read.
    ///
    /// The engine is measured (on the #372 dumps) to return ZERO lines for
    /// strips a human reads effortlessly, and the fix differs by cause, so
    /// empty reads walk a small retry ladder — successful reads are never
    /// re-read, and a hopeless row costs at most three engine calls:
    ///
    /// 1. native size — most rows read here;
    /// 2. 2x NEAREST-neighbour upscale — short or dim names ("YF1008",
    ///    "[W-C-E]hasnan_1") read at double size; nearest keeps glyph edges
    ///    sharp (no new gray levels to binarize) where a smoothing filter
    ///    blurs thin dimmed strokes further into nothing;
    /// 3. 4px border trim + 2x upscale — a sliver of the neighboring column
    ///    at the crop edge (the ship silhouette sits ~4px inside the ally
    ///    strip in some layouts) can break the engine's line segmentation
    ///    for the WHOLE strip; trimming it restores the read ("Titanic_959").
    fn recognize(&self, crop_rgba: &[u8], width: u32, height: u32) -> Option<String> {
        // Degenerate strips never reach the pixel copy below (the crop path
        // already rejects them, but stay defensive — WinRT rejects 0 dims
        // with an error, which would log noise on every pass).
        let needed = width as usize * height as usize * 4;
        if width == 0 || height == 0 || crop_rgba.len() < needed {
            return None;
        }
        if let Some(text) = self.read_some(crop_rgba, width, height) {
            return Some(text);
        }
        let (upscaled, uw, uh) = upscale_2x_nearest(crop_rgba, width, height)?;
        if let Some(text) = self.read_some(&upscaled, uw, uh) {
            return Some(text);
        }
        let (trimmed, tw, th) = trim_border(crop_rgba, width, height, RETRY_TRIM_PX)?;
        let (upscaled, uw, uh) = upscale_2x_nearest(&trimmed, tw, th)?;
        self.read_some(&upscaled, uw, uh)
    }
}

/// Border width trimmed by retry stage 3 (see [`RowRecognizer::recognize`]).
const RETRY_TRIM_PX: u32 = 4;

impl WindowsOcrRecognizer {
    /// One engine attempt: read the strip, mapping failure and empty reads
    /// to `None` (failure logged at debug — never warn-ed per row).
    fn read_some(&self, crop_rgba: &[u8], width: u32, height: u32) -> Option<String> {
        match self.read(crop_rgba, width, height) {
            Ok(text) if !text.trim().is_empty() => Some(text),
            Ok(_) => None,
            Err(e) => {
                tracing::debug!(error = %e, "windows-ocr row strip read failed");
                None
            },
        }
    }

    /// The WinRT call chain: RGBA → BGRA8 SoftwareBitmap → RecognizeAsync →
    /// joined line texts. Any error bubbles to `read_some`'s silent degrade.
    fn read(&self, crop_rgba: &[u8], width: u32, height: u32) -> windows::core::Result<String> {
        let bitmap = software_bitmap_from_rgba(crop_rgba, width, height)?;
        // `.get()` blocks the calling (watcher) thread on a kernel event
        // until the engine's thread-pool work finishes — accepted for v1:
        // the anchor emit waits for the recognition (measured in the
        // fixture test), an async two-phase emit is a possible follow-up.
        let result: OcrResult = self.engine.RecognizeAsync(&bitmap)?.get()?;
        let lines = result.Lines()?;
        let mut text = String::new();
        for line in lines {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&line.Text()?.to_string_lossy());
        }
        Ok(text)
    }
}

/// Double a strip with nearest-neighbour sampling (each source pixel becomes
/// a 2x2 block). Pure index arithmetic over the tightly-packed RGBA buffer;
/// `None` on overflow or a buffer that does not back the given dimensions.
fn upscale_2x_nearest(rgba: &[u8], width: u32, height: u32) -> Option<(Vec<u8>, u32, u32)> {
    if rgba.len() < width as usize * height as usize * 4 {
        return None;
    }
    let uw = width.checked_mul(2)?;
    let uh = height.checked_mul(2)?;
    let mut out = vec![0u8; uw as usize * uh as usize * 4];
    for y in 0..uh as usize {
        let src_row = (y / 2 * width as usize) * 4;
        let dst_row = (y * uw as usize) * 4;
        for x in 0..width as usize {
            let px = &rgba[src_row + x * 4..src_row + x * 4 + 4];
            let dst = dst_row + x * 8;
            out[dst..dst + 4].copy_from_slice(px);
            out[dst + 4..dst + 8].copy_from_slice(px);
        }
    }
    Some((out, uw, uh))
}

/// Cut `border` pixels off every edge of a tightly-packed RGBA buffer.
/// `None` when the border would consume the whole strip.
fn trim_border(rgba: &[u8], width: u32, height: u32, border: u32) -> Option<(Vec<u8>, u32, u32)> {
    if rgba.len() < width as usize * height as usize * 4 {
        return None;
    }
    let bw = border.min(width / 2);
    let bh = border.min(height / 2);
    let nw = width - bw * 2;
    let nh = height - bh * 2;
    if nw == 0 || nh == 0 {
        return None;
    }
    let mut out = Vec::with_capacity((nw * nh * 4) as usize);
    for y in bh..bh + nh {
        let start = ((y * width) + bw) as usize * 4;
        out.extend_from_slice(&rgba[start..start + nw as usize * 4]);
    }
    Some((out, nw, nh))
}

/// Copy RGBA crop pixels into a fresh BGRA8 [`SoftwareBitmap`] — the OCR
/// engine's native format. R and B are swapped per pixel during the copy
/// (a straight memcpy would hand the engine red/blue-swapped text); the
/// capture's alpha is opaque, so the straight-alpha copy is exact.
fn software_bitmap_from_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
) -> windows::core::Result<SoftwareBitmap> {
    let bitmap = SoftwareBitmap::Create(BitmapPixelFormat::Bgra8, width as i32, height as i32)?;
    let buffer = bitmap.LockBuffer(BitmapBufferAccessMode::Write)?;
    let reference = buffer.CreateReference()?;
    let access: IMemoryBufferByteAccess = reference.cast()?;
    let row = width as usize * 4;
    let needed = row * height as usize;
    unsafe {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut capacity: u32 = 0;
        access.GetBuffer(&mut data, &mut capacity)?;
        if data.is_null() || (capacity as usize) < needed {
            return Err(windows::core::Error::new(
                HRESULT(0x8000_4003u32 as i32), // E_POINTER
                "SoftwareBitmap backing buffer smaller than the crop",
            ));
        }
        for y in 0..height as usize {
            let src = &rgba[y * row..(y + 1) * row];
            let dst = std::slice::from_raw_parts_mut(data.add(y * row), row);
            for (px, out) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
                out[0] = px[2]; // B
                out[1] = px[1]; // G
                out[2] = px[0]; // R
                out[3] = px[3]; // A
            }
        }
    }
    // Release the write references before the engine reads the pixels.
    drop(reference);
    drop(buffer);
    Ok(bitmap)
}

/// Create the shared engine, picking a recognizer language: Simplified
/// Chinese first (the client language these panels ship in — its engine
/// reads the Latin nicknames just as well), then US English, then whatever
/// the user's own language list has in common with the installed OCR
/// packs. `None` (cached by the caller's `OnceLock`) when nothing is
/// usable: the pipeline degrades, the overlay keeps its fallback mapping.
fn create_engine() -> Option<OcrEngine> {
    let available: Vec<String> = OcrEngine::AvailableRecognizerLanguages()
        .ok()?
        .into_iter()
        .filter_map(|lang| lang.LanguageTag().ok().map(|tag| tag.to_string_lossy()))
        .collect();
    let user_languages: Vec<String> = GlobalizationPreferences::Languages()
        .map(|langs| langs.into_iter().map(|tag| tag.to_string_lossy()).collect())
        .unwrap_or_default();
    let tag = pick_language(&available, &user_languages)?;
    let language = Language::CreateLanguage(&windows::core::HSTRING::from(&tag)).ok()?;
    let engine = OcrEngine::TryCreateFromLanguage(&language).ok()?;
    tracing::info!(language = %tag, "windows-ocr engine created");
    Some(engine)
}

/// Recognizer-language selection over the available tags (case-insensitive
/// exact matches): `zh-CN` / `zh-Hans`, then `en-US`, then the user's
/// preferred languages in their own order. `None` = no usable pack. Pure
/// (both lists injected) so the priority order is unit-testable.
fn pick_language(available: &[String], user_languages: &[String]) -> Option<String> {
    let find = |tag: &str| {
        available
            .iter()
            .find(|a| a.eq_ignore_ascii_case(tag))
            .cloned()
    };
    if let Some(tag) = find("zh-CN").or_else(|| find("zh-Hans")) {
        return Some(tag);
    }
    if let Some(tag) = find("en-US") {
        return Some(tag);
    }
    user_languages.iter().find_map(|user| find(user))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|s| s.to_string()).collect()
    }

    /// The BGRA conversion is the only pixel-touching code without a real
    /// OS round trip in the fixture test — verify the channel swap here.
    #[test]
    fn software_bitmap_carries_swapped_bgra_pixels() {
        let w = 3u32;
        let h = 2u32;
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
            px[0] = (i as u8) | 0x10; // R
            px[1] = (i as u8) | 0x40; // G
            px[2] = (i as u8) | 0x80; // B
            px[3] = 255; // A
        }
        let bitmap = software_bitmap_from_rgba(&rgba, w, h).expect("bitmap builds");
        assert_eq!(bitmap.PixelWidth().unwrap(), w as i32);
        assert_eq!(bitmap.PixelHeight().unwrap(), h as i32);
        // Read the pixels back through the engine's own API (BGRA8).
        let buffer = bitmap.LockBuffer(BitmapBufferAccessMode::Read).unwrap();
        let reference = buffer.CreateReference().unwrap();
        let access: IMemoryBufferByteAccess = reference.cast().unwrap();
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut capacity: u32 = 0;
        unsafe { access.GetBuffer(&mut data, &mut capacity).unwrap() };
        assert!((capacity as usize) >= (w * h * 4) as usize);
        let back = unsafe { std::slice::from_raw_parts(data, capacity as usize) };
        for (i, out) in back.chunks_exact(4).enumerate().take((w * h) as usize) {
            assert_eq!(out[0], (i as u8) | 0x80, "B carries the source R swap");
            assert_eq!(out[1], (i as u8) | 0x40);
            assert_eq!(out[2], (i as u8) | 0x10, "R carries the source B swap");
            assert_eq!(out[3], 255);
        }
    }

    #[test]
    fn pick_language_follows_the_priority_order() {
        let available = tags(&["en-US", "zh-CN"]);
        assert_eq!(
            pick_language(&available, &tags(&["en-US"])).as_deref(),
            Some("zh-CN"),
            "Simplified Chinese wins even when listed after English"
        );
        assert_eq!(
            pick_language(&tags(&["zh-Hans", "zh-CN"]), &[]).as_deref(),
            Some("zh-CN"),
            "exact zh-CN beats zh-Hans even when zh-Hans is listed first"
        );
        assert_eq!(
            pick_language(&tags(&["zh-Hans"]), &[]).as_deref(),
            Some("zh-Hans"),
            "zh-Hans is accepted when zh-CN is absent"
        );
        assert_eq!(
            pick_language(&tags(&["fr-FR", "en-US"]), &[]).as_deref(),
            Some("en-US"),
            "US English is the second choice"
        );
        // Case-insensitive: OCR packs report BCP-47 tags in their own case.
        assert_eq!(
            pick_language(&tags(&["en-us"]), &[]).as_deref(),
            Some("en-us")
        );
    }

    #[test]
    fn pick_language_falls_back_to_the_user_list_then_gives_up() {
        // Neither zh nor en installed: the user's own languages (in their
        // preference order) decide, but only among the AVAILABLE packs.
        let available = tags(&["de-DE", "pt-BR"]);
        assert_eq!(
            pick_language(&available, &tags(&["ja-JP", "pt-BR"])).as_deref(),
            Some("pt-BR"),
            "first user language with an installed OCR pack wins"
        );
        assert_eq!(
            pick_language(&available, &tags(&["ja-JP", "ko-KR"])).as_deref(),
            None,
            "user languages without OCR packs → no engine"
        );
        assert!(
            pick_language(&tags(&[]), &tags(&["en-US"])).is_none(),
            "no available tags at all → no language"
        );
    }

    #[test]
    fn upscale_and_trim_are_exact_pixel_arithmetic() {
        // 2x2 RGBA (A B / C D): the upscale doubles every pixel into a 2x2
        // block. The retry ladder depends on both helpers being exact — a
        // channel swap or shifted row here would feed the engine garbage
        // only on the retry path (hard to see).
        let rgba = vec![
            10, 20, 30, 255, 40, 50, 60, 255, //
            70, 80, 90, 255, 100, 110, 120, 255,
        ];
        let (up, w, h) = upscale_2x_nearest(&rgba, 2, 2).unwrap();
        assert_eq!((w, h), (4, 4));
        let px = |x: u32, y: u32| &up[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize];
        assert_eq!(px(0, 0), &rgba[0..4], "A top-left");
        assert_eq!(px(3, 3), &rgba[12..16], "D bottom-right");
        assert_eq!(px(1, 2), &rgba[8..12], "C block bottom row");

        // 6x4 strip, each pixel's first byte = its linear index: trim 1 must
        // keep exactly x in 1..5, y in 1..3.
        let mut wide = Vec::new();
        for i in 0..24u32 {
            wide.extend_from_slice(&[i as u8, 0, 0, 255]);
        }
        let (tr, tw, th) = trim_border(&wide, 6, 4, 1).unwrap();
        assert_eq!((tw, th), (4, 2));
        let at = |x: u32, y: u32| tr[((y * tw + x) * 4) as usize];
        assert_eq!(at(0, 0), 7, "source (1,1)");
        assert_eq!(at(3, 1), 16, "source (4,2)");
        // A border that would consume the strip gives up instead.
        assert!(trim_border(&rgba, 2, 2, 1).is_none());
    }
}
