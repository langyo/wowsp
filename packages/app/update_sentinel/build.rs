//! Embed the WoWSP icon and the visual-styles / DPI manifest, the same way
//! tauri-build does for the main exe (same embedder, same icon source).

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "windows" {
        return;
    }
    let manifest_dir =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let icon = manifest_dir
        .join("..")
        .join("tauri")
        .join("icons")
        .join("icon.ico");
    let mut resource = tauri_winres::WindowsResource::new();
    resource.set_icon(icon.to_str().expect("icon path is UTF-8"));
    resource.set_manifest(MANIFEST);
    resource.compile().expect("embed sentinel resources");
}

/// Comctl32 v6 (themed marquee progress bar) + system-DPI awareness +
/// Win10/11 support declaration — everything a dialog-grade window needs.
const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="*"
      name="WoWSP.UpdateSentinel" type="win32"/>
  <description>WoWSP auto-update sentinel</description>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
          version="6.0.0.0" processorArchitecture="*"
          publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10 / 11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <asmv3:application xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
    <asmv3:windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>"#;
