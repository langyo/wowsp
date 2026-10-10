//! Consent-gated hardware & environment report for the feedback bundle.
//!
//! The settings' 问题反馈 section offers a "full" bundle export: next to the
//! rolling log files the zip then carries `hardware-info.txt`, an inventory
//! of the machine the incident happened on — CPU / board / BIOS / RAM
//! modules / GPUs with driver versions / physical disks with serial numbers
//! / every NIC's MAC address / OS build / VC++ runtimes / DirectX /
//! antivirus products, plus (when the user grants UAC) Secure Boot and TPM
//! state.
//!
//! Privacy flow — this data identifies a machine, so the order is fixed:
//!
//! 1. The webui raises an explicit consent dialog BEFORE any collection
//!    starts, listing the sensitive categories and the author-only analysis
//!    purpose; the plain log-only export stays one click away.
//! 2. Only after confirmation does [`collect_for_bundle`] run. Some rows
//!    (Secure Boot, TPM, and disk serials on locked-down storage stacks)
//!    need administrator rights, so the app relaunches ITSELF with the
//!    `runas` verb plus [`ELEVATED_FLAG`]; the elevated child re-collects
//!    the full snapshot, writes it as JSON to the handoff path it was
//!    given, and exits. The requesting process waits on the child, then
//!    adopts its snapshot. A declined / failed / timed-out elevation
//!    degrades to the user-level snapshot — never to a hard error.
//! 3. The child interception runs at the very top of `lib.rs::run`, BEFORE
//!    the single-instance plugin could mistake the helper launch for a
//!    duplicate app instance and exit it.
//!
//! The self-relaunch handoff only writes one JSON file to a path the parent
//! chose under the app's own cache dir; the child accepts no other verbs.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// argv flag the parent passes to the elevated helper relaunch:
/// `wowsp.exe --wowsp-collect-hardware <out.json>`.
pub const ELEVATED_FLAG: &str = "--wowsp-collect-hardware";

// ── data model ─────────────────────────────────────────────────────────
//
// Generic label/value sections keep the txt renderer, the manifest summary
// and the elevated-child JSON envelope one shape, and let a provider add
// rows without touching the model (registry rows merge into the same
// section the WMI sweep fills).

/// One report section (`[id] title` in the txt, plus its rows).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct HardwareSection {
    /// Stable id ("os", "cpu", …) — manifest summaries look rows up by it.
    pub id: String,
    /// Human heading (bilingual, like the manifest's notes).
    pub title: String,
    /// Ordered label → value rows.
    pub lines: Vec<(String, String)>,
}

/// How the snapshot was taken; drives both the txt header and the manifest
/// line, and documents what a missing row means.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ElevationStatus {
    /// Plain user-level snapshot (full export without elevation problems,
    /// or the "logs + hardware" flow after the user declined UAC).
    #[default]
    User,
    /// Administrator snapshot from the self-relaunched helper.
    Elevated,
    /// The UAC prompt was declined; admin-only rows are missing.
    UacDeclined,
    /// The helper never finished within the wait budget.
    Timeout,
    /// The runas relaunch itself failed.
    Failed,
    /// Non-Windows build (Android): nothing is collected.
    Unsupported,
}

impl ElevationStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Elevated => "elevated (UAC granted)",
            Self::UacDeclined => "user (UAC declined — admin-only rows missing)",
            Self::Timeout => "user (elevated helper timed out)",
            Self::Failed => "user (elevation launch failed)",
            Self::Unsupported => "unsupported platform",
        }
    }
}

/// A full hardware & environment snapshot (also the helper's JSON envelope).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct HardwareReport {
    /// RFC 3339 local time of the sweep.
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub elevation: ElevationStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<HardwareSection>,
    /// Per-source failures; a missing row usually means the provider
    /// refused or the field does not exist on this machine.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

impl HardwareReport {
    /// The txt rendering shipped as `hardware-info.txt`.
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str("WoWSP hardware & environment report\n");
        out.push_str("encoding: UTF-8\n");
        out.push_str(&format!("generated-at: {}\n", self.generated_at));
        out.push_str(&format!("elevation: {}\n", self.elevation.label()));
        out.push_str("consent: 在应用内弹窗确认后收集，仅用于作者分析问题，不用于其它用途。\n");
        out.push_str("consent: collected only after the in-app consent dialog; for issue analysis by the author only.\n");
        for section in &self.sections {
            out.push_str(&format!("\n[{}] {}\n", section.id, section.title));
            for (label, value) in &section.lines {
                out.push_str(&format!("  {label}: {value}\n"));
            }
        }
        if !self.errors.is_empty() {
            out.push_str("\n[errors] 收集失败项 / failed sources\n");
            for e in &self.errors {
                out.push_str(&format!("  - {e}\n"));
            }
        }
        out
    }

    /// UTF-8 BOM-prefixed bytes (same convention as `feedback-info.txt`, so
    /// GBK-default Windows editors auto-detect).
    pub fn render_bom(&self) -> Vec<u8> {
        let mut bytes: Vec<u8> = "\u{feff}".as_bytes().to_vec();
        bytes.extend_from_slice(self.render().as_bytes());
        bytes
    }

    pub fn section(&self, id: &str) -> Option<&HardwareSection> {
        self.sections.iter().find(|s| s.id == id)
    }

    /// First row with `key` inside section `id` (manifest summaries).
    pub fn line(&self, id: &str, key: &str) -> Option<&str> {
        self.section(id)?
            .lines
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Append rows to a section, creating it when missing (registry rows
    /// land before the WMI sweep's, fallbacks only fill absent sections).
    pub(crate) fn push_lines(&mut self, id: &str, title: &str, lines: Vec<(String, String)>) {
        if lines.is_empty() {
            return;
        }
        if let Some(section) = self.sections.iter_mut().find(|s| s.id == id) {
            section.lines.extend(lines);
        } else {
            self.sections.push(HardwareSection {
                id: id.to_string(),
                title: title.to_string(),
                lines,
            });
        }
    }

    pub(crate) fn note_error(&mut self, msg: impl Into<String>) {
        self.errors.push(msg.into());
    }
}

/// Parse the elevated-helper request out of an argv stream (the env version
/// delegates here; tests drive it with synthetic argv).
fn parse_elevated_request<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut args = args.into_iter();
    // argv[0] — the exe path.
    args.next()?;
    while let Some(arg) = args.next() {
        if arg.as_ref() == ELEVATED_FLAG {
            return args.next().map(|p| PathBuf::from(p.as_ref()));
        }
    }
    None
}

/// True when THIS process is the elevated helper (`run()` intercepts before
/// the Tauri builder / single-instance guard runs).
#[cfg(windows)]
pub fn elevated_request_from_args() -> Option<PathBuf> {
    parse_elevated_request(std::env::args_os())
}

#[cfg(not(windows))]
pub fn elevated_request_from_args() -> Option<PathBuf> {
    // Never dispatched outside Windows; the stub keeps `run()`'s
    // interception call site cfg-free.
    None
}

/// Elevated-helper body: sweep, serialize, publish; exit code 0 only when
/// the snapshot actually landed. An internally-timed-out sweep publishes
/// NOTHING and exits non-zero on purpose — the parent then falls back to
/// its own user-level sweep (registry + WMI), which beats a nearly-empty
/// "elevated" report.
#[cfg(windows)]
pub fn run_elevated_child(out_path: &std::path::Path) -> i32 {
    // Luring guard: a non-elevated process can launch this exe with the
    // runas verb and an arbitrary handoff path, banking on the user
    // approving the UAC prompt. The child only ever publishes into the
    // app's own cache handoff directory — anything else is refused.
    if !is_sanctioned_handoff_path(out_path) {
        tracing::error!(
            ?out_path,
            "hardware snapshot helper: refusing handoff path outside the app cache dir"
        );
        return 1;
    }
    tracing::info!(?out_path, "hardware snapshot helper: collecting (elevated)");
    let mut report = match win::with_timeout(win::CHILD_BUDGET_SECS, || win::collect_full(true)) {
        Some(report) => report,
        None => {
            tracing::error!(
                budget_secs = win::CHILD_BUDGET_SECS,
                "hardware snapshot helper: sweep timed out, not publishing"
            );
            return 1;
        },
    };
    report.generated_at = chrono::Local::now().to_rfc3339();
    let json = match serde_json::to_string_pretty(&report) {
        Ok(json) => json,
        Err(e) => {
            tracing::error!(error = %e, "hardware snapshot helper: serialize failed");
            return 1;
        },
    };
    match crate::atomic_file::write(out_path, &json) {
        Ok(()) => {
            tracing::info!(?out_path, "hardware snapshot helper: published");
            0
        },
        Err(e) => {
            tracing::error!(error = %e, ?out_path, "hardware snapshot helper: write failed");
            1
        },
    }
}

/// The helper's handoff file name component (`hw-<pid>-<stamp>.json`).
fn handoff_name_ok(name: &str) -> bool {
    name.starts_with("hw-") && name.ends_with(".json") && name.matches('-').count() == 2
}

/// True only for `<cache>/feedback-hw/hw-*.json` paths — see the luring
/// guard in [`run_elevated_child`].
#[cfg(windows)]
fn is_sanctioned_handoff_path(path: &std::path::Path) -> bool {
    use std::path::Path;

    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if !handoff_name_ok(name) {
        return false;
    }
    let Ok(cache_root) = crate::paths::cache_dir() else {
        return false;
    };
    // The parent pre-creates the directory (not the file), so canonicalize
    // the PARENT of both sides; `canonicalize` on Windows returns \\?\
    // -prefixed paths, consistent on both sides of the comparison.
    let (Ok(base), Some(parent)) = (
        cache_root.join("feedback-hw").canonicalize(),
        path.parent().and_then(|p| p.canonicalize().ok()),
    ) else {
        return false;
    };
    if base != parent {
        return false;
    }
    // Defense in depth: canonicalize() resolves junctions/symlinks, so a
    // reparse point planted at a user-writable level (the handoff dir, or
    // the WoWSP cache root itself) would have compared equal above. Every
    // directory from the handoff dir up to — but excluding — the cache
    // root must be a real directory, and the walk must actually reach the
    // root (a path that lexically escapes it is refused).
    for ancestor in path.parent().into_iter().flat_map(Path::ancestors) {
        if ancestor == cache_root {
            return true;
        }
        if !ancestor.starts_with(&cache_root) {
            return false;
        }
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) if !meta.file_type().is_symlink() => {},
            _ => return false,
        }
    }
    false
}

#[cfg(not(windows))]
pub fn run_elevated_child(_out_path: &std::path::Path) -> i32 {
    // Unreachable — elevated_request_from_args() is always None here.
    1
}

/// Collect the consented snapshot for the feedback bundle. `elevate` asks
/// for UAC via the self-relaunch helper; a declined / failed / timed-out
/// elevation degrades to the user-level snapshot (status recorded in the
/// report), and non-Windows builds return an explicit unsupported marker.
pub fn collect_for_bundle(elevate: bool) -> HardwareReport {
    #[cfg(windows)]
    return win::collect(elevate);
    #[cfg(not(windows))]
    {
        let _ = elevate;
        let mut report = HardwareReport::default();
        report.elevation = ElevationStatus::Unsupported;
        report.note_error("hardware collection is only implemented on Windows");
        report
    }
}

// ── pure helpers (shared by the collectors + unit tests) ───────────────

/// DMTF datetime → `(naive local wall clock, UTC offset minutes)`.
/// WMI emits `YYYYMMDDHHMMSS.ffffff±UUU`; the fractional part is dropped
/// (the seconds are already more precise than a diagnostics report needs).
fn dmtf_parts(s: &str) -> Option<(chrono::NaiveDateTime, i32)> {
    let s = s.trim();
    if s.len() < 14 || !s.is_ascii() {
        return None;
    }
    let naive = chrono::NaiveDateTime::parse_from_str(&s[..14], "%Y%m%d%H%M%S").ok()?;
    let offset = s
        .get(21..25)
        .and_then(|o| o.parse::<i32>().ok())
        .unwrap_or(0);
    Some((naive, offset))
}

/// DMTF datetime for display: `2024-05-01 12:34:56 +08:00` (raw value when
/// unparseable — better a weird string than a dropped row).
fn dmtf_display(s: &str) -> String {
    match dmtf_parts(s) {
        Some((naive, offset)) => {
            let (sign, minutes) = if offset < 0 {
                ('-', -offset)
            } else {
                ('+', offset)
            };
            format!(
                "{} {sign}{:02}:{:02}",
                naive.format("%Y-%m-%d %H:%M:%S"),
                minutes / 60,
                minutes % 60
            )
        },
        None => s.trim().to_string(),
    }
}

/// Uptime string from a DMTF `LastBootUpTime` (`7d 12:34:56`).
fn uptime_since(last_boot_dmtf: &str) -> Option<String> {
    use chrono::TimeZone;
    let (naive, offset_minutes) = dmtf_parts(last_boot_dmtf)?;
    let boot = chrono::FixedOffset::east_opt(offset_minutes * 60)?
        .from_local_datetime(&naive)
        .single()?
        .with_timezone(&chrono::Utc);
    let elapsed = chrono::Utc::now().signed_duration_since(boot);
    Some(format!(
        "{}d {:02}:{:02}:{:02}",
        elapsed.num_days(),
        elapsed.num_hours() % 24,
        elapsed.num_minutes() % 60,
        elapsed.num_seconds() % 60
    ))
}

/// Bytes → `931.5 GiB` (the unit Windows itself shows, mislabeled GB).
fn fmt_gib(bytes: u64) -> String {
    const GIB: f64 = 1_073_741_824.0;
    format!("{:.1} GiB", bytes as f64 / GIB)
}

/// NIC link speed (bps) → `1 Gbps` / `100 Mbps`.
fn fmt_bps(bps: u64) -> String {
    if bps >= 1_000_000_000 {
        format!("{} Gbps", (bps + 500_000_000) / 1_000_000_000)
    } else if bps >= 1_000_000 {
        format!("{} Mbps", (bps + 500_000) / 1_000_000)
    } else {
        format!("{bps} bps")
    }
}

/// Win32_PhysicalMemory.SMBIOSMemoryType → marketing name (SMBIOS spec's
/// Memory Device type byte).
fn memory_type_name(t: u64) -> &'static str {
    match t {
        18 => "DDR",
        19 => "DDR2",
        20 => "DDR2 FB-DIMM",
        24 => "DDR3",
        26 => "DDR4",
        27 => "LPDDR",
        28 => "LPDDR2",
        29 => "LPDDR3",
        30 => "LPDDR4",
        34 => "DDR5",
        35 => "LPDDR5",
        _ => "unknown",
    }
}

/// Win32_LogicalDisk.DriveType → label.
fn drive_type_name(t: u64) -> &'static str {
    match t {
        2 => "removable",
        3 => "local",
        4 => "network",
        5 => "cd-rom",
        6 => "ramdisk",
        _ => "unknown",
    }
}

/// Antivirus `productState` decode. The field is undocumented by Microsoft;
/// this matches the value pairs observed in the wild (byte 2 ∈ {0x10, 0x11}
/// → enabled; the low 0x10 bit → definitions stale). The raw hex always
/// ships next to the verdict, so a misread stays diagnosable.
fn av_state_label(state: u32) -> &'static str {
    // Observed in the wild: 0x061100 (Defender on), 0x041000 (3rd-party on)
    // vs 0x061200 (snoozed), 0x040000 (off) — so byte 2 ∈ {0x10, 0x11}
    // means on and 0x12 already reads off. The low 0x10 bit marks stale
    // definitions.
    let enabled = matches!((state >> 8) & 0xFF, 0x10 | 0x11);
    let up_to_date = state & 0x10 == 0;
    match (enabled, up_to_date) {
        (true, true) => "enabled, definitions up to date",
        (true, false) => "enabled, definitions out of date",
        (false, true) => "disabled/snoozed",
        (false, false) => "disabled, definitions out of date",
    }
}

// ── Windows collectors ─────────────────────────────────────────────────

#[cfg(windows)]
mod win {
    use super::{
        ELEVATED_FLAG, ElevationStatus, HardwareReport, HardwareSection, av_state_label,
        dmtf_display, drive_type_name, fmt_bps, fmt_gib, memory_type_name, uptime_since,
    };
    use std::collections::HashMap;
    use std::path::Path;
    use wmi::{Variant, WMIConnection};

    /// WMI sweep budget as the logged-in user — a healthy sweep takes one
    /// or two seconds; the budget only bites when the WMI service itself
    /// is wedged, where waiting longer never helps.
    const WMI_BUDGET_SECS: u64 = 25;
    /// Elevated-helper budget: the sweep runs behind a UAC prompt the user
    /// may stare at for a while (the prompt itself does not consume this —
    /// the child only starts after consent), so this guards the sweep.
    pub(super) const CHILD_BUDGET_SECS: u64 = 90;
    /// How long the parent waits on the helper PROCESS (UAC prompt +
    /// sweep). The prompt can sit unanswered while the user is away; past
    /// this the export degrades to the user-level snapshot.
    const ELEVATION_WAIT_MS: u32 = 120_000;

    type Row = HashMap<String, Variant>;

    /// WmiMonitorID strings arrive as NUL-padded uint16 arrays.
    fn wide_array(row: &Row, key: &str) -> Option<String> {
        let Variant::Array(items) = row.get(key)? else {
            return None;
        };
        let mut text = String::new();
        for item in items {
            let code = match item {
                Variant::UI2(n) => u32::from(*n),
                Variant::I2(n) => u32::from(*n as u16),
                _ => continue,
            };
            if code == 0 {
                break; // SMBIOS strings are NUL-padded
            }
            text.push(char::from_u32(code).unwrap_or('\u{fffd}'));
        }
        let text = text.trim();
        if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        }
    }

    /// String-ish field; trims the NUL/space padding some providers emit.
    fn v_str(row: &Row, key: &str) -> Option<String> {
        let raw = match row.get(key)? {
            Variant::String(s) => s.clone(),
            Variant::Bool(v) => v.to_string(),
            Variant::UI1(v) => v.to_string(),
            Variant::UI2(v) => v.to_string(),
            Variant::UI4(v) => v.to_string(),
            Variant::UI8(v) => v.to_string(),
            Variant::I1(v) => v.to_string(),
            Variant::I2(v) => v.to_string(),
            Variant::I4(v) => v.to_string(),
            Variant::I8(v) => v.to_string(),
            Variant::R4(v) => v.to_string(),
            Variant::R8(v) => v.to_string(),
            Variant::Array(items) => {
                let joined = items
                    .iter()
                    .filter_map(|item| match item {
                        Variant::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                if joined.is_empty() {
                    return None;
                }
                joined
            },
            Variant::Empty | Variant::Null | Variant::Unknown(_) | Variant::Object(_) => {
                return None;
            },
        };
        let raw = raw.trim().trim_end_matches('\0').trim();
        if raw.is_empty() {
            None
        } else {
            Some(raw.to_string())
        }
    }

    /// Numeric field — WMI ships CIM_UINT64 as a STRING (disk sizes,
    /// TotalPhysicalMemory), so strings parse here too.
    fn v_u64(row: &Row, key: &str) -> Option<u64> {
        Some(match row.get(key)? {
            Variant::String(s) => s.trim().parse().ok()?,
            Variant::UI1(v) => u64::from(*v),
            Variant::UI2(v) => u64::from(*v),
            Variant::UI4(v) => u64::from(*v),
            Variant::UI8(v) => *v,
            Variant::I1(v) => u64::try_from(*v).ok()?,
            Variant::I2(v) => u64::try_from(*v).ok()?,
            Variant::I4(v) => u64::try_from(*v).ok()?,
            Variant::I8(v) => u64::try_from(*v).ok()?,
            _ => return None,
        })
    }

    fn v_bool(row: &Row, key: &str) -> Option<bool> {
        match row.get(key)? {
            Variant::Bool(v) => Some(*v),
            _ => None,
        }
    }

    fn rows(con: &WMIConnection, sql: &str) -> Result<Vec<Row>, String> {
        con.raw_query::<Row>(sql)
            .map_err(|e| format!("WMI `{sql}`: {e}"))
    }

    fn section_title(id: &str) -> &'static str {
        match id {
            "os" => "Operating system 操作系统",
            "cpu" => "CPU 处理器",
            "memory" => "Memory 内存",
            "motherboard" => "Motherboard & BIOS 主板与固件",
            "gpu" => "Display adapters 显卡",
            "disks" => "Physical disks 物理硬盘",
            "volumes" => "Volumes 卷",
            "network" => "Network adapters 网卡",
            "monitors" => "Monitors 显示器",
            "sound" => "Sound devices 声卡",
            "runtimes" => "VC++ runtimes VC++ 运行库",
            "directx" => "DirectX",
            "antivirus" => "Antivirus 杀毒软件",
            "security" => "Secure Boot & TPM 安全启动与TPM",
            _ => "Other 其它",
        }
    }

    /// One WMI sweep's output: merged sections plus per-query failures.
    #[derive(Default)]
    struct Sweep {
        sections: Vec<HardwareSection>,
        errors: Vec<String>,
    }

    impl Sweep {
        fn push(&mut self, id: &str, lines: Vec<(String, String)>) {
            if lines.is_empty() {
                return;
            }
            self.sections.push(HardwareSection {
                id: id.to_string(),
                title: section_title(id).to_string(),
                lines,
            });
        }

        fn err(&mut self, msg: impl Into<String>) {
            self.errors.push(msg.into());
        }
    }

    /// Parent-side entry: elevated helper first (its snapshot is a strict
    /// superset), user-level sweep as the degradation path.
    pub(super) fn collect(elevate: bool) -> HardwareReport {
        if elevate {
            match run_elevated_helper() {
                Ok(report) => return report,
                Err(ElevateErr::Declined) => {
                    let mut report = collect_full(false);
                    report.elevation = ElevationStatus::UacDeclined;
                    report.note_error(
                        "elevation declined: admin-only rows are missing (Secure Boot, TPM, \
                         some disk serials)",
                    );
                    return report;
                },
                Err(ElevateErr::Timeout) => {
                    let mut report = collect_full(false);
                    report.elevation = ElevationStatus::Timeout;
                    report.note_error("elevated helper timed out; admin-only rows are missing");
                    return report;
                },
                Err(ElevateErr::Failed(e)) => {
                    let mut report = collect_full(false);
                    report.elevation = ElevationStatus::Failed;
                    report.note_error(format!("elevated helper failed: {e}"));
                    return report;
                },
            }
        }
        let mut report = collect_full(false);
        report.elevation = ElevationStatus::User;
        report
    }

    /// One full sweep (shared by the parent fallback and the helper child).
    /// `elevated` adds the admin-only security section.
    pub(super) fn collect_full(elevated: bool) -> HardwareReport {
        let mut report = HardwareReport {
            elevation: if elevated {
                ElevationStatus::Elevated
            } else {
                ElevationStatus::User
            },
            ..HardwareReport::default()
        };
        registry_sections(&mut report);
        match with_timeout(WMI_BUDGET_SECS, move || wmi_sections(elevated)) {
            Some(sweep) => {
                for section in sweep.sections {
                    report.push_lines(&section.id, &section.title, section.lines);
                }
                for e in sweep.errors {
                    report.note_error(e);
                }
            },
            None => report.note_error(format!(
                "WMI sweep exceeded the {WMI_BUDGET_SECS}s budget; WMI-backed sections are \
                 missing (registry fallbacks applied where possible)"
            )),
        }
        registry_fallbacks(&mut report);
        report.generated_at = chrono::Local::now().to_rfc3339();
        report
    }

    /// Run `f` on a side thread with a hard deadline. WMIConnection is
    /// !Send (COM lives per-thread), so the sweep must own its thread; on
    /// timeout the stuck thread is abandoned (one leaked thread per hung
    /// sweep — acceptable for a diagnostics path, and the alternative is a
    /// wedged export).
    pub(super) fn with_timeout<T: Send + 'static>(
        secs: u64,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("wowsp-hardware".into())
            .spawn(move || {
                let _ = tx.send(f());
            })
            .ok()?;
        rx.recv_timeout(std::time::Duration::from_secs(secs)).ok()
    }

    // ── registry-backed sections ───────────────────────────────────────

    fn registry_sections(report: &mut HardwareReport) {
        use winreg::RegKey;
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

        // OS identity: the registry is authoritative for build+UBR and the
        // 24H2-style display version — WMI only knows the 10.0 kernel
        // triple, and bug reports live on build numbers.
        let mut os: Vec<(String, String)> = Vec::new();
        if let Ok(key) = hklm.open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            KEY_READ | KEY_WOW64_64KEY,
        ) {
            if let Ok(product) = key.get_value::<String, _>("ProductName") {
                os.push(("edition".into(), product));
            }
            if let Ok(v) = key.get_value::<String, _>("DisplayVersion") {
                os.push(("display-version".into(), v));
            } else if let Ok(v) = key.get_value::<String, _>("ReleaseId") {
                os.push(("release-id".into(), v));
            }
            if let Ok(build) = key.get_value::<String, _>("CurrentBuildNumber") {
                match key.get_value::<u32, _>("UBR") {
                    Ok(ubr) => os.push(("build".into(), format!("{build}.{ubr}"))),
                    Err(_) => os.push(("build".into(), build)),
                }
            }
            if let Ok(installed) = key.get_value::<u32, _>("InstallDate") {
                if let Some(date) = chrono::DateTime::from_timestamp(i64::from(installed), 0) {
                    os.push((
                        "installed-at".into(),
                        date.with_timezone(&chrono::Local)
                            .format("%Y-%m-%d")
                            .to_string(),
                    ));
                }
            }
        }
        report.push_lines("os", section_title("os"), os);

        report.push_lines("runtimes", section_title("runtimes"), runtime_rows());
        report.push_lines("directx", section_title("directx"), directx_rows());
    }

    /// VC++ redistributables from the VisualStudio `<ver>\VC\Runtimes\<arch>`
    /// registry tree (both registry views — the x86 redist registers under
    /// the 32-bit view), plus the vcruntime140 DLL presence check.
    fn runtime_rows() -> Vec<(String, String)> {
        use winreg::RegKey;
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};

        fn family(vs: &str) -> String {
            match vs {
                "14.0" => "VC++ 2015-2022".into(),
                "12.0" => "VC++ 2013".into(),
                "11.0" => "VC++ 2012".into(),
                "10.0" => "VC++ 2010".into(),
                "9.0" => "VC++ 2008".into(),
                "8.0" => "VC++ 2005".into(),
                other => other.into(),
            }
        }

        let mut rows: Vec<(String, String)> = Vec::new();
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let root = match hklm
                .open_subkey_with_flags(r"SOFTWARE\Microsoft\VisualStudio", KEY_READ | view)
            {
                Ok(root) => root,
                Err(_) => continue,
            };
            for vs in root.enum_keys().flatten() {
                let runtimes =
                    match root.open_subkey_with_flags(format!(r"{vs}\VC\Runtimes"), KEY_READ) {
                        Ok(key) => key,
                        Err(_) => continue, // that VS generation has no redist installed
                    };
                for arch in runtimes.enum_keys().flatten() {
                    let Ok(key) = runtimes.open_subkey(&arch) else {
                        continue;
                    };
                    // Version is "v14.40.33810.00"; fall back to the parts.
                    let version = key
                        .get_value::<String, _>("Version")
                        .ok()
                        .map(|v| v.trim_start_matches('v').to_string())
                        .unwrap_or_else(|| {
                            let part = |name: &str| key.get_value::<u32, _>(name).unwrap_or(0);
                            format!("{}.{}.{}", part("Major"), part("Minor"), part("Bld"))
                        });
                    // Keys with neither shape (e.g. a bare `debug` key with
                    // no values) carry no information — skip instead of
                    // shipping a "0.0.0" row.
                    if version != "0.0.0" {
                        rows.push((format!("{} {arch}", family(&vs)), version));
                    }
                }
            }
        }
        rows.sort();
        rows.dedup();

        // Runtime DLL presence — the load-bearing check for "does the game
        // launch" questions, independent of what the installer registered.
        if let Ok(system_root) = std::env::var("SystemRoot") {
            for (dir_label, dir) in [("System32", "System32"), ("SysWOW64 (32-bit)", "SysWOW64")] {
                let base = Path::new(&system_root).join(dir);
                let present: Vec<&str> = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]
                    .iter()
                    .copied()
                    .filter(|dll| base.join(dll).exists())
                    .collect();
                let value = if present.is_empty() {
                    "none found".to_string()
                } else {
                    present.join(", ")
                };
                rows.push((format!("{dir_label} runtimes"), value));
            }
        }
        rows
    }

    /// DirectX: the registry runtime marker (a DX9-era version string that
    /// Windows 10/11 still carries) + the D3D API layer DLLs' presence —
    /// that pair is what a "which DirectX do I have" question needs.
    fn directx_rows() -> Vec<(String, String)> {
        let mut rows: Vec<(String, String)> = Vec::new();
        if let Some(key) = hklm_open(r"SOFTWARE\Microsoft\DirectX") {
            if let Ok(v) = key.get_value::<String, _>("Version") {
                rows.push(("runtime-marker".into(), v));
            }
        }
        if let Ok(system_root) = std::env::var("SystemRoot") {
            let system32 = Path::new(&system_root).join("System32");
            for dll in ["d3d9.dll", "d3d11.dll", "d3d12.dll", "dxgi.dll"] {
                let state = if system32.join(dll).exists() {
                    "present"
                } else {
                    "missing"
                };
                rows.push((format!("System32/{dll}"), state.into()));
            }
        }
        rows
    }

    /// HKLM helper with the 64-bit view (dedupes the call sites).
    fn hklm_open(path: &str) -> Option<winreg::RegKey> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
        winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
            .ok()
    }

    /// Registry rows for sections whose WMI provider did not answer
    /// (wedged WMI service): CPU from the hardware description tree,
    /// board/BIOS from the SMBIOS-provided BIOS key.
    fn registry_fallbacks(report: &mut HardwareReport) {
        use winreg::RegKey;
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if report.section("cpu").is_none() {
            let mut rows: Vec<(String, String)> = Vec::new();
            if let Ok(tree) = hklm.open_subkey_with_flags(
                r"HARDWARE\DESCRIPTION\System\CentralProcessor",
                KEY_READ | KEY_WOW64_64KEY,
            ) {
                let logical = tree.enum_keys().count();
                if let Ok(core0) = tree.open_subkey("0") {
                    if let Ok(name) = core0.get_value::<String, _>("ProcessorNameString") {
                        rows.push(("model".into(), name));
                    }
                    if let Ok(mhz) = core0.get_value::<u32, _>("~MHz") {
                        rows.push(("clock".into(), format!("{mhz} MHz")));
                    }
                }
                if logical > 0 {
                    rows.push(("logical-processors".into(), logical.to_string()));
                }
            }
            report.push_lines("cpu", section_title("cpu"), rows);
        }
        if report.section("motherboard").is_none() {
            let mut rows: Vec<(String, String)> = Vec::new();
            if let Some(bios) = hklm_open(r"HARDWARE\DESCRIPTION\System\BIOS") {
                let get = |name: &str| bios.get_value::<String, _>(name).ok();
                if let Some(v) = get("SystemManufacturer") {
                    let model = get("SystemProductName").unwrap_or_default();
                    rows.push(("system".into(), format!("{v} {model}").trim().to_string()));
                }
                if let Some(v) = get("BaseBoardProduct") {
                    let version = get("BaseBoardVersion").unwrap_or_default();
                    rows.push(("board".into(), format!("{v} {version}").trim().to_string()));
                }
                if let Some(v) = get("BIOSVendor") {
                    rows.push(("bios".into(), v));
                }
                if let Some(v) = get("BIOSVersion") {
                    rows.push(("bios-version".into(), v));
                }
                if let Some(v) = get("BIOSReleaseDate") {
                    rows.push(("bios-date".into(), v));
                }
            }
            report.push_lines("motherboard", section_title("motherboard"), rows);
        }
    }

    // ── WMI sweep ──────────────────────────────────────────────────────

    fn wmi_sections(elevated: bool) -> Sweep {
        let mut sweep = Sweep::default();
        let cimv2 = match WMIConnection::new() {
            Ok(con) => Some(con),
            Err(e) => {
                sweep.err(format!("connect root\\cimv2: {e}"));
                None
            },
        };

        if let Some(con) = &cimv2 {
            // OS caption/arch/locale + uptime ride along with the registry
            // rows already in the section.
            match rows(
                con,
                "SELECT Caption, OSArchitecture, MUILanguages, LastBootUpTime \
                 FROM Win32_OperatingSystem",
            ) {
                Ok(list) if !list.is_empty() => {
                    let row = &list[0];
                    let mut lines = Vec::new();
                    if let Some(v) = v_str(row, "Caption") {
                        lines.push(("caption".into(), v));
                    }
                    if let Some(v) = v_str(row, "OSArchitecture") {
                        lines.push(("arch".into(), v));
                    }
                    if let Some(v) = v_str(row, "MUILanguages") {
                        lines.push(("ui-languages".into(), v));
                    }
                    if let Some(v) = v_str(row, "LastBootUpTime") {
                        if let Some(uptime) = uptime_since(&v) {
                            lines.push(("uptime".into(), uptime));
                        }
                    }
                    sweep.push("os", lines);
                },
                Ok(_) => sweep.err("Win32_OperatingSystem returned no rows"),
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, \
                 SocketDesignation FROM Win32_Processor",
            ) {
                Ok(list) => {
                    let mut lines = Vec::new();
                    for (i, row) in list.iter().enumerate() {
                        let model = v_str(row, "Name").unwrap_or_else(|| "unknown".into());
                        let mut value = model;
                        if let (Some(cores), Some(logical)) = (
                            v_u64(row, "NumberOfCores"),
                            v_u64(row, "NumberOfLogicalProcessors"),
                        ) {
                            value.push_str(&format!(" ({cores}C/{logical}T)"));
                        }
                        if let Some(mhz) = v_u64(row, "MaxClockSpeed") {
                            value.push_str(&format!(", {mhz} MHz"));
                        }
                        if let Some(socket) = v_str(row, "SocketDesignation") {
                            value.push_str(&format!(", socket {socket}"));
                        }
                        let label = if list.len() > 1 {
                            format!("cpu {i}")
                        } else {
                            "model".into()
                        };
                        lines.push((label, value));
                    }
                    sweep.push("cpu", lines);
                },
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT DeviceLocator, BankLabel, Capacity, Speed, ConfiguredClockSpeed, \
                 Manufacturer, PartNumber, SerialNumber, FormFactor, SMBIOSMemoryType \
                 FROM Win32_PhysicalMemory",
            ) {
                Ok(list) => {
                    let mut lines = Vec::new();
                    let total: u64 = list.iter().filter_map(|r| v_u64(r, "Capacity")).sum();
                    if total > 0 {
                        lines.push(("total".into(), fmt_gib(total)));
                    }
                    for (i, row) in list.iter().enumerate() {
                        let locator =
                            v_str(row, "DeviceLocator").unwrap_or_else(|| format!("module {i}"));
                        let mut value = match v_u64(row, "Capacity") {
                            Some(bytes) => fmt_gib(bytes),
                            None => continue,
                        };
                        if let Some(kind) = v_u64(row, "SMBIOSMemoryType") {
                            value.push_str(&format!(", {}", memory_type_name(kind)));
                        }
                        if let Some(speed) = v_u64(row, "Speed") {
                            value.push_str(&format!(", {speed} MT/s"));
                        }
                        if let Some(configured) = v_u64(row, "ConfiguredClockSpeed") {
                            if Some(configured) != v_u64(row, "Speed") {
                                value.push_str(&format!(" (running {configured} MT/s)"));
                            }
                        }
                        let maker = v_str(row, "Manufacturer").unwrap_or_default();
                        let part = v_str(row, "PartNumber").unwrap_or_default();
                        let tagged = format!("{maker} {part}").trim().to_string();
                        if !tagged.is_empty() {
                            value.push_str(&format!(", {tagged}"));
                        }
                        if let Some(serial) = v_str(row, "SerialNumber") {
                            value.push_str(&format!(", serial {serial}"));
                        }
                        lines.push((locator, value));
                    }
                    sweep.push("memory", lines);
                },
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT Manufacturer, Product, Version, SerialNumber FROM Win32_BaseBoard",
            ) {
                Ok(list) if !list.is_empty() => {
                    let row = &list[0];
                    let mut lines = Vec::new();
                    let board = format!(
                        "{} {} {}",
                        v_str(row, "Manufacturer").unwrap_or_default(),
                        v_str(row, "Product").unwrap_or_default(),
                        v_str(row, "Version").unwrap_or_default()
                    )
                    .trim()
                    .to_string();
                    if !board.is_empty() {
                        if let Some(serial) = v_str(row, "SerialNumber") {
                            lines.push(("board".into(), format!("{board}, serial {serial}")));
                        } else {
                            lines.push(("board".into(), board));
                        }
                    }
                    sweep.push("motherboard", lines);
                },
                Ok(_) => sweep.err("Win32_BaseBoard returned no rows"),
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT Manufacturer, Model, SystemFamily FROM Win32_ComputerSystem",
            ) {
                Ok(list) if !list.is_empty() => {
                    let row = &list[0];
                    let system = format!(
                        "{} {} {}",
                        v_str(row, "Manufacturer").unwrap_or_default(),
                        v_str(row, "Model").unwrap_or_default(),
                        v_str(row, "SystemFamily").unwrap_or_default()
                    )
                    .trim()
                    .to_string();
                    if !system.is_empty() {
                        sweep.push("motherboard", vec![("system".into(), system)]);
                    }
                },
                Ok(_) => sweep.err("Win32_ComputerSystem returned no rows"),
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT Manufacturer, SMBIOSBIOSVersion, ReleaseDate, SMBIOSMajorVersion, \
                 SMBIOSMinorVersion FROM Win32_BIOS",
            ) {
                Ok(list) if !list.is_empty() => {
                    let row = &list[0];
                    let mut lines = Vec::new();
                    let vendor = v_str(row, "Manufacturer").unwrap_or_default();
                    let version = v_str(row, "SMBIOSBIOSVersion").unwrap_or_default();
                    let bios = format!("{vendor} {version}").trim().to_string();
                    if !bios.is_empty() {
                        lines.push(("bios".into(), bios));
                    }
                    if let Some(date) = v_str(row, "ReleaseDate") {
                        lines.push(("bios-date".into(), dmtf_display(&date)));
                    }
                    if let (Some(major), Some(minor)) = (
                        v_u64(row, "SMBIOSMajorVersion"),
                        v_u64(row, "SMBIOSMinorVersion"),
                    ) {
                        lines.push(("smbios".into(), format!("{major}.{minor}")));
                    }
                    sweep.push("motherboard", lines);
                },
                Ok(_) => sweep.err("Win32_BIOS returned no rows"),
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT Name, DriverVersion, DriverDate, PNPDeviceID, Status \
                 FROM Win32_VideoController",
            ) {
                Ok(list) => {
                    let mut lines = Vec::new();
                    for (i, row) in list.iter().enumerate() {
                        let name = v_str(row, "Name").unwrap_or_else(|| "unknown".into());
                        let mut value = name;
                        if let Some(driver) = v_str(row, "DriverVersion") {
                            value.push_str(&format!(" — driver {driver}"));
                        }
                        if let Some(date) = v_str(row, "DriverDate") {
                            value.push_str(&format!(" ({})", dmtf_display(&date)));
                        }
                        if let Some(status) = v_str(row, "Status") {
                            if status != "OK" {
                                value.push_str(&format!(", status {status}"));
                            }
                        }
                        let label = if list.len() > 1 {
                            format!("adapter {i}")
                        } else {
                            "adapter".into()
                        };
                        lines.push((label, value));
                        if let Some(pnp) = v_str(row, "PNPDeviceID") {
                            lines.push((format!("adapter-{i}-pnp"), pnp));
                        }
                    }
                    sweep.push("gpu", lines);
                },
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT Index, Model, SerialNumber, Size, InterfaceType, MediaType, \
                 Partitions, FirmwareRevision FROM Win32_DiskDrive",
            ) {
                Ok(mut list) => {
                    // WMI's row order is not the disk index order; sort so
                    // `disk 0` reads first regardless of enumeration order.
                    list.sort_by_key(|row| v_u64(row, "Index").unwrap_or(u64::MAX));
                    let mut lines = Vec::new();
                    for row in &list {
                        let index = v_u64(row, "Index").unwrap_or_default();
                        let model = v_str(row, "Model").unwrap_or_else(|| "unknown".into());
                        let mut value = model;
                        if let Some(media) = v_str(row, "MediaType") {
                            let interface = v_str(row, "InterfaceType").unwrap_or_default();
                            let bus = format!("{media} / {interface}")
                                .trim_end_matches(" /")
                                .to_string();
                            if !bus.is_empty() {
                                value.push_str(&format!(" [{bus}]"));
                            }
                        }
                        if let Some(size) = v_u64(row, "Size") {
                            value.push_str(&format!(", {size}", size = fmt_gib(size)));
                        }
                        if let Some(serial) = v_str(row, "SerialNumber") {
                            value.push_str(&format!(", serial {serial}"));
                        }
                        if let Some(firmware) = v_str(row, "FirmwareRevision") {
                            value.push_str(&format!(", fw {firmware}"));
                        }
                        if let Some(parts) = v_u64(row, "Partitions") {
                            value.push_str(&format!(", {parts} partition(s)"));
                        }
                        lines.push((format!("disk {index}"), value));
                    }
                    sweep.push("disks", lines);
                },
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT DeviceID, VolumeName, FileSystem, Size, FreeSpace, DriveType, \
                 VolumeSerialNumber FROM Win32_LogicalDisk",
            ) {
                Ok(list) => {
                    let mut lines = Vec::new();
                    for row in &list {
                        let device = v_str(row, "DeviceID").unwrap_or_else(|| "?:".into());
                        let mut value = String::new();
                        if let Some(label) = v_str(row, "VolumeName") {
                            value.push_str(&format!("({label}) "));
                        }
                        if let Some(fs) = v_str(row, "FileSystem") {
                            value.push_str(&format!("{fs}, "));
                        }
                        match (v_u64(row, "Size"), v_u64(row, "FreeSpace")) {
                            (Some(total), Some(free)) => {
                                value.push_str(&format!(
                                    "{total} total / {free} free",
                                    total = fmt_gib(total),
                                    free = fmt_gib(free)
                                ));
                            },
                            (Some(total), None) => value.push_str(&fmt_gib(total)),
                            _ => {},
                        }
                        if let Some(kind) = v_u64(row, "DriveType") {
                            value.push_str(&format!(", {}", drive_type_name(kind)));
                        }
                        if let Some(serial) = v_str(row, "VolumeSerialNumber") {
                            value.push_str(&format!(", volume-serial {serial}"));
                        }
                        lines.push((
                            device.trim_end_matches(':').into(),
                            value.trim().to_string(),
                        ));
                    }
                    sweep.push("volumes", lines);
                },
                Err(e) => sweep.err(e),
            }

            match rows(
                con,
                "SELECT Name, MACAddress, AdapterType, PhysicalAdapter, NetEnabled, Speed \
                 FROM Win32_NetworkAdapter WHERE MACAddress IS NOT NULL",
            ) {
                Ok(list) => {
                    let mut lines = Vec::new();
                    for row in &list {
                        let name = v_str(row, "Name").unwrap_or_else(|| "unknown".into());
                        let mac =
                            v_str(row, "MACAddress").unwrap_or_else(|| "??:??:??:??:??:??".into());
                        let mut value = format!("mac {mac}");
                        if let Some(kind) = v_str(row, "AdapterType") {
                            value.push_str(&format!(", {kind}"));
                        }
                        let physical = v_bool(row, "PhysicalAdapter");
                        value.push_str(if physical == Some(true) {
                            ", physical"
                        } else {
                            ", virtual"
                        });
                        if v_bool(row, "NetEnabled") == Some(false) {
                            value.push_str(", disabled");
                        }
                        // WAN miniports report the link speed as -1 (u64
                        // max) — anything past 400 Gbps is that sentinel,
                        // not a real link.
                        if let Some(speed) = v_u64(row, "Speed") {
                            if speed > 0 && speed < 400_000_000_000 {
                                value.push_str(&format!(", {}", fmt_bps(speed)));
                            }
                        }
                        lines.push((name, value));
                    }
                    sweep.push("network", lines);
                },
                Err(e) => sweep.err(e),
            }

            match rows(con, "SELECT Name, Manufacturer FROM Win32_SoundDevice") {
                Ok(list) => {
                    let mut lines = Vec::new();
                    for (i, row) in list.iter().enumerate() {
                        let name = v_str(row, "Name").unwrap_or_else(|| "unknown".into());
                        let maker = v_str(row, "Manufacturer").unwrap_or_default();
                        let label = if list.len() > 1 {
                            format!("device {i}")
                        } else {
                            "device".into()
                        };
                        let value = if maker.is_empty() {
                            name
                        } else {
                            format!("{name} ({maker})")
                        };
                        lines.push((label, value));
                    }
                    sweep.push("sound", lines);
                },
                Err(e) => sweep.err(e),
            }
        }

        // Monitors live in root\wmi (EDID-derived WmiMonitorID).
        match WMIConnection::with_namespace_path("ROOT\\wmi") {
            Ok(con) => match rows(
                &con,
                "SELECT InstanceName, UserFriendlyName, ManufacturerName, ProductCodeID, \
                 YearOfManufacture FROM WmiMonitorID",
            ) {
                Ok(list) => {
                    let mut lines = Vec::new();
                    for (i, row) in list.iter().enumerate() {
                        let maker = wide_array(row, "ManufacturerName").unwrap_or_default();
                        let product = wide_array(row, "ProductCodeID").unwrap_or_default();
                        let name = wide_array(row, "UserFriendlyName").unwrap_or_default();
                        let mut value = format!("{maker} {name}").trim().to_string();
                        if !product.is_empty() {
                            value.push_str(&format!(" (product {product})"));
                        }
                        if let Some(year) = v_u64(row, "YearOfManufacture") {
                            if year > 0 {
                                value.push_str(&format!(", {year}"));
                            }
                        }
                        if value.is_empty() {
                            if let Some(instance) = v_str(row, "InstanceName") {
                                value = instance;
                            }
                        }
                        if !value.is_empty() {
                            lines.push((format!("monitor {i}"), value));
                        }
                    }
                    sweep.push("monitors", lines);
                },
                Err(e) => sweep.err(e),
            },
            Err(e) => sweep.err(format!("connect root\\wmi: {e}")),
        }

        // Antivirus products from the Security Center (workstation SKUs;
        // server SKUs have no SecurityCenter2 namespace — recorded, not an
        // error worth failing the sweep over).
        match WMIConnection::with_namespace_path("ROOT\\SecurityCenter2") {
            Ok(con) => match rows(
                &con,
                "SELECT displayName, productState FROM AntiVirusProduct",
            ) {
                Ok(list) => {
                    let mut lines = Vec::new();
                    for row in &list {
                        let name = v_str(row, "displayName").unwrap_or_else(|| "unknown".into());
                        let value = match v_u64(row, "productState") {
                            Some(state) => format!(
                                "{name} — {} (productState 0x{state:06X})",
                                av_state_label(state as u32)
                            ),
                            None => name,
                        };
                        lines.push(("product".into(), value));
                    }
                    sweep.push("antivirus", lines);
                },
                Err(e) => sweep.err(e),
            },
            Err(e) => sweep.err(format!(
                "connect root\\SecurityCenter2 (server SKU or WSC off): {e}"
            )),
        }

        // Admin-only rows — the reason the elevated helper exists.
        if elevated {
            if let Some(con) = &cimv2 {
                match rows(con, "SELECT SecureBootEnabled FROM Win32_SecureBoot") {
                    Ok(list) if !list.is_empty() => {
                        let enabled = v_bool(&list[0], "SecureBootEnabled");
                        sweep.push(
                            "security",
                            vec![(
                                "secure-boot".into(),
                                if enabled == Some(true) {
                                    "enabled"
                                } else {
                                    "disabled"
                                }
                                .into(),
                            )],
                        );
                    },
                    // Legacy BIOS machines have no class at all — expected.
                    Ok(_) => sweep.push(
                        "security",
                        vec![("secure-boot".into(), "not available (legacy BIOS?)".into())],
                    ),
                    Err(e) => sweep.err(format!("Win32_SecureBoot: {e}")),
                }
            }
            match WMIConnection::with_namespace_path(r"root\cimv2\Security\MicrosoftTpm") {
                Ok(con) => match rows(
                    &con,
                    "SELECT SpecVersion, IsEnabled_InitialValue, IsActivated_InitialValue \
                     FROM Win32_Tpm",
                ) {
                    Ok(list) if !list.is_empty() => {
                        let row = &list[0];
                        let spec = v_str(row, "SpecVersion").unwrap_or_else(|| "present".into());
                        let enabled = v_bool(row, "IsEnabled_InitialValue");
                        let activated = v_bool(row, "IsActivated_InitialValue");
                        sweep.push(
                            "security",
                            vec![(
                                "tpm".into(),
                                format!(
                                    "{spec}, {}",
                                    match (enabled, activated) {
                                        (Some(true), Some(true)) => "enabled and activated",
                                        (Some(true), _) => "enabled",
                                        _ => "present",
                                    }
                                ),
                            )],
                        );
                    },
                    Ok(_) => sweep.push("security", vec![("tpm".into(), "not present".into())]),
                    Err(e) => sweep.err(format!("Win32_Tpm: {e}")),
                },
                Err(e) => sweep.err(format!("connect MicrosoftTpm namespace: {e}")),
            }
        }

        sweep
    }

    // ── elevation self-relaunch ────────────────────────────────────────

    enum ElevateErr {
        Declined,
        Timeout,
        Failed(String),
    }

    /// Relaunch our own exe under UAC (`runas`), wait for the helper to
    /// publish its JSON, and adopt the snapshot. The handoff file lives
    /// under the app cache dir and is unique per attempt; stale files from
    /// crashed helpers are swept on every run.
    fn run_elevated_helper() -> Result<HardwareReport, ElevateErr> {
        use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        use windows::Win32::UI::Shell::{
            SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
        };
        use windows::core::{PCWSTR, w};

        let dir = crate::paths::ensure_cache_dir()
            .map_err(ElevateErr::Failed)?
            .join("feedback-hw");
        std::fs::create_dir_all(&dir)
            .map_err(|e| ElevateErr::Failed(format!("create {}: {e}", dir.display())))?;
        cleanup_stale(&dir);
        let stamp = chrono::Local::now().format("%Y%m%d%H%M%S%3f");
        let out_path = dir.join(format!("hw-{}-{stamp}.json", std::process::id()));
        // The parent may retry after a failed helper run.
        let _ = std::fs::remove_file(&out_path);

        let exe = std::env::current_exe()
            .map_err(|e| ElevateErr::Failed(format!("resolve own exe: {e}")))?;
        let file = windows::core::HSTRING::from(exe.as_os_str());
        let params =
            windows::core::HSTRING::from(format!("{ELEVATED_FLAG} \"{}\"", out_path.display()));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: 0, // SW_HIDE — the helper never shows UI
            ..Default::default()
        };
        // A refused UAC prompt surfaces as ERROR_CANCELLED (1223) — the
        // Win32 code rides in the HRESULT's low word.
        unsafe { ShellExecuteExW(&mut info) }.map_err(|e| {
            if (e.code().0 as u32) & 0xFFFF == ERROR_CANCELLED.0 {
                ElevateErr::Declined
            } else {
                ElevateErr::Failed(format!("runas relaunch: {e}"))
            }
        })?;

        let waited = unsafe { WaitForSingleObject(info.hProcess, ELEVATION_WAIT_MS) };
        let exit_code = if waited == WAIT_OBJECT_0 {
            let mut code: u32 = 0;
            let _ = unsafe { GetExitCodeProcess(info.hProcess, &mut code) };
            Some(code)
        } else {
            None
        };
        let _ = unsafe { CloseHandle(info.hProcess) };
        if waited != WAIT_OBJECT_0 {
            // The helper keeps running (its own file lands whenever it
            // finishes; the stale sweep collects it tomorrow).
            return Err(ElevateErr::Timeout);
        }
        // A non-zero exit means the helper refused the handoff path or its
        // sweep timed out without publishing — the fallback user-level
        // sweep beats whatever did (not) land.
        if exit_code != Some(0) {
            return Err(ElevateErr::Failed(format!(
                "helper exited with code {}",
                exit_code.unwrap_or(0xFFFF_FFFF)
            )));
        }
        let text = std::fs::read_to_string(&out_path)
            .map_err(|e| ElevateErr::Failed(format!("read {}: {e}", out_path.display())))?;
        let _ = std::fs::remove_file(&out_path);
        serde_json::from_str(&text)
            .map_err(|e| ElevateErr::Failed(format!("parse helper output: {e}")))
    }

    /// Drop helper handoff files older than a day (crashed/killed helpers).
    fn cleanup_stale(dir: &Path) {
        const DAY_SECS: u64 = 24 * 60 * 60;
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(DAY_SECS);
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let is_ours = path.extension().is_some_and(|e| e == "json")
                && path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("hw-"));
            if !is_ours {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|modified| modified < cutoff);
            if stale {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real-machine smoke sweep (WMI + registry): catches query typos the
    /// hermetic tests cannot. Manual only — it reads the host's hardware
    /// inventory: `cargo test -p wowsp_tauri hardware_info -- --ignored
    /// --nocapture`.
    #[test]
    #[cfg(windows)]
    #[ignore = "sweeps the real machine's WMI/registry (manual smoke)"]
    fn user_level_sweep_smoke() {
        let report = win::collect_full(false);
        println!("{}", report.render());
        println!("errors: {:?}", report.errors);
        assert!(
            report.section("os").is_some(),
            "os section expected from a healthy sweep"
        );
        assert!(
            report.section("network").is_some(),
            "NIC section (MAC addresses) expected from a healthy sweep"
        );
    }

    fn report_fixture() -> HardwareReport {
        let mut report = HardwareReport::default();
        report.generated_at = "2026-10-10T12:00:00+08:00".into();
        report.elevation = ElevationStatus::Elevated;
        report.push_lines(
            "os",
            "Operating system 操作系统",
            vec![
                ("edition".into(), "Windows 11 专业版".into()),
                ("build".into(), "26100.1742".into()),
            ],
        );
        report.push_lines(
            "disks",
            "Physical disks 物理硬盘",
            vec![(
                "disk 0".into(),
                "Samsung SSD 990 PRO — serial S6Z1NJ0R123456".into(),
            )],
        );
        report
    }

    #[test]
    fn render_carries_consent_and_sections() {
        let text = report_fixture().render();
        assert!(text.contains("elevation: elevated (UAC granted)"));
        assert!(text.contains("consent: 在应用内弹窗确认后收集"));
        assert!(text.contains("[os] Operating system 操作系统"));
        assert!(text.contains("edition: Windows 11 专业版"));
        assert!(text.contains("serial S6Z1NJ0R123456"));
    }

    #[test]
    fn render_is_bom_prefixed_utf8() {
        let bytes = report_fixture().render_bom();
        assert_eq!(&bytes[..3], "\u{feff}".as_bytes());
        let text = String::from_utf8(bytes).expect("report is UTF-8");
        assert!(text.contains("[disks]"));
    }

    #[test]
    fn json_round_trip_with_envelope_fields() {
        let report = report_fixture();
        let json = serde_json::to_string(&report).unwrap();
        let back: HardwareReport = serde_json::from_str(&json).unwrap();
        assert_eq!(back, report);
        assert_eq!(back.elevation, ElevationStatus::Elevated);
        assert_eq!(back.line("os", "build"), Some("26100.1742"));
    }

    #[test]
    fn json_envelope_tolerates_missing_optional_fields() {
        // The elevated helper of an older build may lack fields — the
        // parent must still parse what lands.
        let back: HardwareReport = serde_json::from_str(r#"{"generated_at":"x"}"#).unwrap();
        assert_eq!(back.elevation, ElevationStatus::User);
        assert!(back.sections.is_empty());
    }

    #[test]
    fn elevated_request_parses_flag_and_path() {
        // The real handoff layout: <LOCALAPPDATA>\WoWSP\feedback-hw (the
        // app cache root itself — its `cache` subdir is for model packs).
        let args = [
            r"C:\app\wowsp.exe",
            ELEVATED_FLAG,
            r"C:\Users\a\AppData\Local\WoWSP\feedback-hw\hw-1-20261010235959123.json",
        ];
        assert_eq!(
            parse_elevated_request(args),
            Some(PathBuf::from(
                r"C:\Users\a\AppData\Local\WoWSP\feedback-hw\hw-1-20261010235959123.json"
            ))
        );
        // Normal launch: no flag, extra args.
        assert_eq!(
            parse_elevated_request(["wowsp.exe", "--flag", "value"]),
            None
        );
        // Flag with no path: not a valid helper invocation.
        assert_eq!(parse_elevated_request(["wowsp.exe", ELEVATED_FLAG]), None);
    }

    #[test]
    fn handoff_name_guard_rejects_foreign_names() {
        // Only the helper's own hw-<pid>-<stamp>.json shape passes — the
        // luring guard in run_elevated_child builds on this predicate.
        assert!(handoff_name_ok("hw-1234-20261010235959123.json"));
        assert!(!handoff_name_ok("hw-.json"), "no stem");
        assert!(!handoff_name_ok("hw-1234.json"), "wrong shape");
        assert!(!handoff_name_ok("payload.json"));
        assert!(!handoff_name_ok("hw-1.exe"));
        assert!(!handoff_name_ok("../escape.json"));
    }

    #[test]
    fn dmtf_display_formats_offset() {
        assert_eq!(
            dmtf_display("20240501123456.123456+480"),
            "2024-05-01 12:34:56 +08:00"
        );
        assert_eq!(
            dmtf_display("20260102030405.000000-300"),
            "2026-01-02 03:04:05 -05:00"
        );
        // Garbage passes through instead of vanishing.
        assert_eq!(dmtf_display("not-a-date"), "not-a-date");
    }

    #[test]
    fn uptime_since_computes_duration() {
        // A boot far in the past yields a positive multi-day uptime with
        // the `Nd HH:MM:SS` shape; the exact value depends on now, so pin
        // the format, not the number.
        let uptime = uptime_since("20200101000000.000000+000").expect("parses");
        let days: u64 = uptime
            .split('d')
            .next()
            .and_then(|d| d.parse().ok())
            .expect("day count");
        assert!(days > 1000, "a 2020 boot must be thousands of days ago");
        assert!(uptime.contains('d'), "shape: `7d 12:34:56`");
    }

    #[test]
    fn size_and_speed_formatters() {
        assert_eq!(fmt_gib(1_073_741_824), "1.0 GiB");
        assert_eq!(fmt_gib(1_000_203_579_904), "931.5 GiB");
        assert_eq!(fmt_bps(1_000_000_000), "1 Gbps");
        assert_eq!(fmt_bps(1_000_000), "1 Mbps");
        assert_eq!(fmt_bps(123), "123 bps");
    }

    #[test]
    fn av_state_label_matches_known_states() {
        // Defender on + up to date (the classic 0x061100).
        assert_eq!(av_state_label(0x061100), "enabled, definitions up to date");
        // Definitions stale flips only the second clause.
        assert_eq!(av_state_label(0x061110), "enabled, definitions out of date");
        // Disabled shape keeps a readable verdict; the raw hex ships in
        // the report line so a misread stays diagnosable.
        assert_eq!(av_state_label(0x061200), "disabled/snoozed");
    }

    #[test]
    fn memory_and_drive_type_names() {
        assert_eq!(memory_type_name(26), "DDR4");
        assert_eq!(memory_type_name(34), "DDR5");
        assert_eq!(memory_type_name(35), "LPDDR5");
        assert_eq!(memory_type_name(30), "LPDDR4");
        assert_eq!(memory_type_name(9999), "unknown");
        assert_eq!(drive_type_name(3), "local");
        assert_eq!(drive_type_name(4), "network");
    }
}
