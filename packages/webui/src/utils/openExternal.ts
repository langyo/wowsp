import { invoke } from "@tauri-apps/api/core";

/**
 * Opens a URL in the system default browser through the Tauri backend
 * (webview-internal navigation to remote hosts is deliberately not
 * allowed). Browser dev mode falls back to a plain new-tab open.
 */
export async function openExternal(url: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await invoke("open_external", { url });
  } else {
    window.open(url, "_blank", "noopener");
  }
}
