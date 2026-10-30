//! The single source of truth for the WebView2 (Chromium) browser
//! argument policy every WoWSP webview is created with.
//!
//! ## Policy
//!
//! No window declares `additionalBrowserArgs` any more — a parity test at
//! the bottom of this file guards that. Wry's own default argument set
//! therefore applies to every webview:
//! `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` plus —
//! deliberately restored — `--autoplay-policy=no-user-gesture-required`
//! (wry's out-of-box default; the former static override suppressed it,
//! which only ever mattered as a permission, not an autoplay trigger). The
//! only per-machine argument is the high-performance-GPU switch, applied
//! ONCE per process through the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
//! environment variable ([apply_gpu_switch]) when — and only when — the
//! machine reports switchable graphics (two or more hardware display
//! adapters, [has_switchable_graphics]). The env var is process-wide, so
//! the identical-args rule for webviews sharing one user-data folder
//! (tauri-utils) holds no matter which windows exist or when they are
//! created.
//!
//! ## Why conditional at all: the 156 incident, and what the switch is
//!
//! PR #1461 shipped `--force-high-performance-gpu` statically to every
//! window. On WebView2 runtime 156 on machines whose only hardware GPU is
//! the integrated adapter plus VIRTUAL display adapters (remote-desktop /
//! indirect-display drivers — Todesk, Honor virtual display, ...), the
//! browser process froze ALL CSS animations and collapsed every transition
//! to an instant snap while the UI itself stayed interactive (loading
//! spinners stuck mid-rotation; modal open/close lost their motion). An
//! A/B on the affected machine — same app, same switch, runtime pinned
//! back to 155 — restored animation, pinning the regression on the
//! runtime + switch combination rather than the app.
//!
//! The switch is also near end-of-life upstream and officially
//! debug-class: Chromium's dual-GPU voting was Mac-only and never
//! self-classified on Windows (the switch merely biases ANGLE's EGL
//! adapter choice at GPU-process startup), the whole switching apparatus
//! is being retired (chromium bug 570641499, removals landing M157-M159),
//! and Microsoft's WebView2 docs say production apps should not use
//! browser flags because they "might be removed or altered at any time"
//! (<https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags>).
//! Keeping it strictly gated is the compromise: true hybrids keep the
//! startup hint; the broken class (fewer than two hardware adapters)
//! never sees it.
//!
//! ## Detection and why it looks like this
//!
//! In-process DXGI enumeration ([enumerate_adapters] —
//! `CreateDXGIFactory1` + `EnumAdapters1`): what Chromium, OBS and ONNX
//! Runtime themselves do. Deliberately NOT WMI (MITRE ATT&CK T1047, a
//! top-tier EDR heuristic; this binary ships unsigned) and never a
//! helper process. An adapter counts as hardware when its DXGI vendor id
//! is a real GPU vendor (NVIDIA 0x10DE, AMD 0x1002/0x1022, Intel 0x8086;
//! Microsoft/WARP and virtual stacks report 0x1414 or 0x0000) and its
//! description passes the virtual/Basic-Render filter — the SOFTWARE
//! flag alone is not trusted (ONNX Runtime had to filter Basic Render
//! drivers that don't set it). No dedicated-VRAM floor: iGPU
//! `DedicatedVideoMemory` is driver-dependent (128 MB carve-outs to
//! multi-GB shared budgets) and would miscount genuine hybrids; the
//! vendor + name filter already excludes ghost render entries.
//!
//! ## Known, accepted degradations
//!
//! - **Elevated runs ignore the switch.** WebView2 docs: flags set via the
//!   local device environment are ignored by elevated host apps. The
//!   elevated session simply falls back to the default adapter; nothing
//!   breaks.
//! - **Single-adapter machines get no switch even when that adapter is a
//!   discrete card** (a desktop with one dGPU and no iGPU). With one
//!   adapter there is nothing to switch between — the switch is a no-op
//!   classification-wise — so omitting it is behavior-neutral.
//! - If a future WebView2 runtime freezes animations on a *genuine hybrid*
//!   with this switch, the kill switch is this file: the parity test only
//!   guards the absence of static args, so reverting
//!   [apply_gpu_switch]'s call in `run()` is a one-line hotfix.

/// The environment variable WebView2 reads for extra browser arguments.
/// Documented end-user/debug channel; the app only ever SETS it when the
/// machine qualifies for the GPU switch, and leaves user-set values alone.
const GPU_SWITCH_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

const GPU_SWITCH_FLAG: &str = "--force-high-performance-gpu";

/// DXGI vendor ids of real GPU hardware. Microsoft's 0x1414 (WARP / Basic
/// Render) and the 0x0000 that virtual stacks report are excluded by not
/// being listed.
const HARDWARE_GPU_VENDORS: [u32; 4] = [0x10DE, 0x1002, 0x1022, 0x8086];

/// Description substrings that mark a software / virtual adapter even when
/// it carries a plausible vendor id. Lowercase; checked with contains().
const VIRTUAL_ADAPTER_MARKERS: [&str; 9] = [
    "virtual",
    "indirect",
    "basic render",
    "basic display",
    "iddcx",
    "parsec",
    "spacedesk",
    "todesk",
    "honor",
];

/// One display adapter as DXGI reports it — just the fields the
/// switchable-graphics gate needs. The feedback bundle's richer hardware
/// report lives in `commands::hardware_info`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuAdapter {
    pub name: String,
    pub vendor_id: u32,
}

/// Whether the machine reports switchable graphics: at least two UNIQUE
/// hardware GPU models (the classic iGPU + dGPU pair). Pure — the DXGI
/// fetch lives in [enumerate_adapters], so the gate is unit-testable with
/// synthetic adapter lists.
///
/// Uniqueness is keyed on the adapter DESCRIPTION, and that is deliberate:
/// Intel drivers expose ONE DXGI adapter instance PER display output,
/// virtual outputs included — an iGPU-only machine with virtual displays
/// enumerates the same Arc chip four times under the identical name, and a
/// naive instance count would misread one GPU as "switchable". Distinct
/// GPU models always carry distinct names (marketing names are how they
/// are sold); a dual-identical-card rig degrades to "not switchable",
/// which for this switch is the safe side. Single-GPU machines fail this
/// by design: with one GPU the switch has nothing to select between.
///
/// Residual, accepted tradeoff: a virtual render adapter that reports a
/// whitelisted vendor id AND a marker-free name would be counted. Display
/// adapters of that shape are unknown in the wild (IddCx/virtual stacks
/// report vendor 0x0000/0x1414 and marker names); the failure mode is only
/// ever the 156 freeze class re-appearing on one machine, not a crash.
pub fn has_switchable_graphics(adapters: &[GpuAdapter]) -> bool {
    let mut models: Vec<String> = Vec::new();
    for a in adapters {
        if !is_hardware_gpu(a.vendor_id, &a.name) {
            continue;
        }
        let name = a.name.to_ascii_lowercase();
        if !models.contains(&name) {
            models.push(name);
        }
    }
    models.len() >= 2
}

/// A hardware GPU: a real vendor id and a description that does not name a
/// software / virtual adapter. (The DXGI SOFTWARE flag is additionally
/// checked at enumeration time — ONNX Runtime found Basic Render drivers
/// that do not set it, hence the belt-and-braces name filter.)
fn is_hardware_gpu(vendor_id: u32, name: &str) -> bool {
    if !HARDWARE_GPU_VENDORS.contains(&vendor_id) {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    !VIRTUAL_ADAPTER_MARKERS.iter().any(|m| lower.contains(m))
}

/// Set [GPU_SWITCH_ENV] when this machine reports switchable graphics.
/// Called once from [crate::run] before any webview (and therefore any
/// WebView2 environment) exists. A user-set value is respected and left
/// untouched — the env var is the documented end-user override channel.
/// Detection runs on a side thread with a hard deadline (DXGI needs a COM
/// apartment on the calling thread and can be slow right after boot); on
/// timeout the switch is simply not applied — the default-adapter fallback
/// is always safe.
pub fn apply_gpu_switch() {
    if std::env::var_os(GPU_SWITCH_ENV).is_some() {
        tracing::info!("webview args: {GPU_SWITCH_ENV} already set by the user, leaving as-is");
        return;
    }
    if !detect_switchable_graphics() {
        tracing::debug!("webview args: no switchable graphics, high-performance switch off");
        return;
    }
    // SAFETY: single environment mutation during early startup, before the
    // tauri runtime spawns its thread pools and before any webview exists;
    // nothing else in the process reads the env concurrently at this point.
    // WebView2's own loader reads the variable natively when it later
    // creates the browser process.
    unsafe { std::env::set_var(GPU_SWITCH_ENV, GPU_SWITCH_FLAG) };
    tracing::info!(
        "webview args: switchable graphics detected, {GPU_SWITCH_ENV}={GPU_SWITCH_FLAG}"
    );
}

#[cfg(windows)]
fn detect_switchable_graphics() -> bool {
    const BUDGET: std::time::Duration = std::time::Duration::from_millis(1500);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("wowsp-gpu-detect".into())
        .spawn(move || {
            let _ = tx.send(enumerate_adapters());
        })
        .ok()
        .and_then(|_| rx.recv_timeout(BUDGET).ok())
        .map(|adapters| has_switchable_graphics(&adapters))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn detect_switchable_graphics() -> bool {
    false
}

/// Enumerate DXGI display adapters (in-process COM — the same API surface
/// Chromium, OBS and ONNX Runtime use for GPU discovery; no WMI, no child
/// processes). Enumeration failures read as "no switchable graphics" — the
/// safe default, never a hard error this early in startup.
#[cfg(windows)]
fn enumerate_adapters() -> Vec<GpuAdapter> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1,
    };
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

    // COM apartment for this detection thread. RPC_E_CHANGED_MODE (the
    // thread already has an apartment) is fine for DXGI — ignore it.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let factory = match unsafe { CreateDXGIFactory1::<IDXGIFactory1>() } {
        Ok(factory) => factory,
        Err(e) => {
            tracing::debug!("webview args: DXGI factory creation failed ({e}); switch off");
            return Vec::new();
        },
    };
    let mut adapters = Vec::new();
    let mut index = 0u32;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            // DXGI_ERROR_NOT_FOUND — the normal end of the adapter list.
            Err(_) => break,
        };
        let desc = match unsafe { adapter.GetDesc1() } {
            Ok(desc) => desc,
            Err(_) => {
                index += 1;
                continue;
            },
        };
        if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            index += 1;
            continue;
        }
        let len = desc
            .Description
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(desc.Description.len());
        let name = String::from_utf16_lossy(&desc.Description[..len]);
        tracing::debug!(
            "webview args: adapter {index}: name={name:?} vendor=0x{:04X} device=0x{:04X} \
             dedicated={}MB flags=0x{:X}",
            desc.VendorId,
            desc.DeviceId,
            desc.DedicatedVideoMemory / (1024 * 1024),
            desc.Flags
        );
        adapters.push(GpuAdapter {
            name,
            vendor_id: desc.VendorId,
        });
        index += 1;
    }
    adapters
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(name: &str, vendor_id: u32) -> GpuAdapter {
        GpuAdapter {
            name: name.into(),
            vendor_id,
        }
    }

    #[test]
    fn igpu_plus_discrete_qualifies() {
        let hybrid = vec![
            adapter("Intel(R) Iris(R) Xe Graphics", 0x8086),
            adapter("NVIDIA GeForce RTX 4060 Laptop GPU", 0x10DE),
        ];
        assert!(has_switchable_graphics(&hybrid));
    }

    #[test]
    fn igpu_plus_amd_discrete_qualifies() {
        let hybrid = vec![
            adapter("AMD Radeon 780M", 0x1002),
            adapter("AMD Radeon RX 7600M XT", 0x1002),
        ];
        assert!(has_switchable_graphics(&hybrid));
    }

    #[test]
    fn igpu_plus_virtual_adapters_do_not_qualify() {
        // The affected machine's inventory. Todesk/Honor virtual displays
        // are display-class devices and normally never appear as DXGI render
        // adapters at all; even if a virtual stack registered one with a
        // Microsoft/zero vendor id and a telltale name, the gate holds.
        let machine = vec![
            adapter("Intel(R) Arc(TM) 130T GPU (16GB)", 0x8086),
            adapter("Todesk Virtual Display Adapter", 0x0000),
            adapter("Honor Virtual Display Device", 0x1414),
        ];
        assert!(!has_switchable_graphics(&machine));
        assert!(!has_switchable_graphics(&[machine[0].clone()]));
    }

    #[test]
    fn basic_render_driver_without_software_flag_is_rejected() {
        // ONNX Runtime precedent: Basic Render drivers that do not set the
        // DXGI SOFTWARE flag. Vendor 0x1414 is already off-list; the name
        // filter is the belt-and-braces second line.
        let warpish = vec![
            adapter("Intel(R) Arc(TM) 130T GPU (16GB)", 0x8086),
            adapter("Microsoft Basic Render Driver", 0x1414),
        ];
        assert!(!has_switchable_graphics(&warpish));
    }

    #[test]
    fn virtual_named_adapter_with_hardware_vendor_is_rejected() {
        let impostor = vec![
            adapter("Intel(R) Iris(R) Xe Graphics", 0x8086),
            adapter("Todesk Virtual NVIDIA Bridge", 0x10DE),
        ];
        assert!(!has_switchable_graphics(&impostor));
    }

    #[test]
    fn single_discrete_gpu_machine_is_a_no() {
        // Nothing to switch between — the switch would be a no-op.
        let desktop = vec![adapter("NVIDIA GeForce RTX 4070", 0x10DE)];
        assert!(!has_switchable_graphics(&desktop));
    }

    #[test]
    fn duplicate_dxgi_instances_of_one_gpu_are_not_switchable() {
        // Regression for the acceptance run on the affected machine: the
        // Intel driver exposes the SAME Arc chip as four DXGI adapters (one
        // per display output, virtual outputs included), all under the
        // identical description. Four instances of one physical GPU must
        // not read as "switchable" — uniqueness is keyed on the name.
        let inflated = (0..4)
            .map(|_| adapter("Intel(R) Arc(TM) 130T GPU (16GB)", 0x8086))
            .collect::<Vec<_>>();
        assert!(!has_switchable_graphics(&inflated));

        // Case variants of the same model name are one model too.
        let cased = vec![
            adapter("Intel(R) Arc(TM) 130T GPU (16GB)", 0x8086),
            adapter("INTEL(R) ARC(TM) 130T GPU (16GB)", 0x8086),
        ];
        assert!(!has_switchable_graphics(&cased));
    }

    #[test]
    fn three_gpu_machine_qualifies() {
        // AMD iGPU + AMD dGPU + Intel iGPU: three unique hardware models is
        // still switchable graphics — the switch biases ANGLE toward the
        // fastest adapter, which is exactly what the owner configured.
        let triple = vec![
            adapter("AMD Radeon 780M", 0x1002),
            adapter("AMD Radeon RX 7600M XT", 0x1002),
            adapter("Intel(R) Arc(TM) 130T GPU (16GB)", 0x8086),
        ];
        assert!(has_switchable_graphics(&triple));
    }

    #[test]
    fn marker_free_virtual_adapter_is_a_conscious_false_positive() {
        // The accepted residual tradeoff (see [has_switchable_graphics]): a
        // hypothetical virtual render adapter reporting a whitelisted
        // vendor id under a marker-free name WOULD be counted. Display
        // adapters of that shape are unknown in the wild; if one ever
        // triggers the 156 freeze class on a machine, tighten the name
        // filter here rather than reverting the gate.
        let impostor = vec![
            adapter("Intel(R) Iris(R) Xe Graphics", 0x8086),
            adapter("AMD Radeon USB Display", 0x1002),
        ];
        assert!(has_switchable_graphics(&impostor));
    }

    #[test]
    fn empty_adapter_list_is_a_no() {
        assert!(!has_switchable_graphics(&[]));
    }

    /// The other half of the parity invariant: no Rust call site may pass
    /// static browser arguments again — wry's defaults plus the env var are
    /// the only channels (a static arg on ANY window desyncs the shared
    /// user-data-folder argument set and fails webview creation).
    #[test]
    fn no_call_site_passes_static_browser_args() {
        fn collect_rs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect_rs(&path, out);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    out.push(path);
                }
            }
        }
        let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut files = Vec::new();
        collect_rs(std::path::Path::new(src), &mut files);
        assert!(files.len() > 50, "sanity: the crate has sources");
        for file in files {
            // The guard's own source quotes the marker; skip it.
            if file.file_name().is_some_and(|n| n == "webview_args.rs") {
                continue;
            }
            let body = std::fs::read_to_string(&file).expect("source readable");
            assert!(
                !body.contains(".additional_browser_args("),
                "static browser args are forbidden: {}",
                file.display()
            );
        }
    }

    /// The identical-args invariant flipped sides: instead of asserting
    /// every conf window carries the shared string, assert NO conf window
    /// declares static browser args at all — wry's defaults apply to every
    /// window, and the GPU switch rides the process-wide env var
    /// ([apply_gpu_switch]), so all webviews over one user-data folder stay
    /// byte-identical.
    #[test]
    fn config_windows_declare_no_static_browser_args() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
        let raw = std::fs::read_to_string(path).expect("tauri.conf.json readable");
        let conf: serde_json::Value = serde_json::from_str(&raw).expect("tauri.conf.json parses");
        let windows = conf["app"]["windows"]
            .as_array()
            .expect("app.windows is an array");
        assert!(
            !windows.is_empty(),
            "app.windows must exist for the parity check"
        );
        for win in windows {
            let label = win["label"].as_str().unwrap_or("<unnamed>");
            assert!(
                win.get("additionalBrowserArgs").is_none(),
                "window {label} must not declare additionalBrowserArgs; the GPU switch is \
                 conditional per machine (webview_args::apply_gpu_switch)"
            );
        }
    }
}
