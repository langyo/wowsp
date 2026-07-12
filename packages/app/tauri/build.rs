fn main() {
    // On Windows, inject our custom app manifest (which declares PerMonitorV2
    // DPI awareness) into tauri-build's resource generation. Without this,
    // Windows treats the exe as DPI-unaware and bitmap-scales the taskbar icon,
    // which is the root cause of the "fuzzy taskbar icon" symptom — the .ico
    // already embeds up to 256×256 but Windows picks a low-res sub-image and
    // stretches it. PerMonitorV2 makes Windows select the correctly-sized
    // sub-image for each monitor's DPI.
    let mut attrs = tauri_build::Attributes::new();
    let manifest_path = std::path::Path::new("wowsp.exe.manifest");
    if manifest_path.exists() {
        let manifest = std::fs::read_to_string(manifest_path)
            .expect("read wowsp.exe.manifest");
        attrs = attrs.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(manifest),
        );
    }
    tauri_build::try_build(attrs)
        .expect("error while running WoWSP tauri build");
}
