/**
 * Fire-and-forget app event broadcasts — the one channel from the main
 * window to the shell's auxiliary windows that consume its state (the
 * bare-DOM Tab overlay): they share the WebView's event bus but no Pinia
 * state, so a store write that must re-shape another window announces
 * itself here (see stores/statsPrefs.ts and stores/stampOverrides.ts for
 * the senders, overlay/main.ts for the receiver).
 */
import { isTauri } from "./platform";

/** Broadcast an app event to every window. No-op outside the Tauri shell
 *  (plain browser tab, tests); a failed emit degrades silently — senders
 *  pair this with a documented fallback contract, never a crash. */
export function emitTauriEvent(event: string): void {
  if (!isTauri()) return;
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(event))
    .catch(() => {
      // no event bus in this shell — receivers apply on their next refresh
    });
}
