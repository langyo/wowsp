import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/utils/platform";

/**
 * Opens a URL in the system default handler through the Tauri backend's
 * `open_external` command (webview-internal navigation to remote hosts is
 * deliberately not allowed). This covers the PHONE app too: the Rust side
 * routes through tauri-plugin-opener, which hands the URL to Android's
 * system chooser — wry's WebView ignores `window.open(url, "_blank")`
 * (no multi-window support), so the browser fallback is only for plain
 * browser/dev mode. The http(s)-only guard lives in the command itself.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_external", { url });
  } else {
    window.open(url, "_blank", "noopener");
  }
}
