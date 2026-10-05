/**
 * Custom seal-image overrides — one user-imported picture per StampKind,
 * stored as `<data_dir>/stamps/<kind>.<ext>` (see commands::stamps; the
 * kind-keyed file name IS the state, so there is no metadata blob).
 *
 * Module-level ref like statsPrefsState: RatingStamp (any surface) and the
 * settings seal customizer read the same reactive map, refreshed in place
 * on every import/reset. The bare-DOM Tab overlay keeps its own copy (no
 * Pinia there) and re-reads the folder when the write is broadcast — see
 * the `wowsp://stamps-changed` emits below and overlay/main.ts's listener.
 * Absent kind = the bundled default glyph shows.
 */
import { ref } from "vue";

import type { StampKind } from "@/utils/winrate";
import { emitTauriEvent } from "@/utils/appEvents";
import { api } from "@/api";
import { isTauri } from "@/transport";

/** Announced after every successful stamps-folder write so the overlay
 *  window re-runs its own `stamp_list` read (it cannot see this module's
 *  reactive map). */
const STAMPS_CHANGED_EVENT = "wowsp://stamps-changed";

/** kind → asset-protocol URL of the user's custom image. */
const overrides = ref<Partial<Record<StampKind, string>>>({});

let _convertFileSrc: ((path: string) => string) | false | null = null;

/** Asset-protocol URL for a stamp file (identity in non-Tauri contexts,
 *  where custom stamps don't exist anyway). */
async function toAssetUrl(path: string): Promise<string> {
  if (_convertFileSrc === null) {
    // Lazy-load convertFileSrc — only available in the Tauri context.
    try {
      const mod = await import("@tauri-apps/api/core");
      _convertFileSrc = mod.convertFileSrc;
    } catch {
      _convertFileSrc = false;
    }
  }
  return typeof _convertFileSrc === "function" ? _convertFileSrc(path) : path;
}

/** Re-read the stamps folder (boot + after every import/reset). */
export async function refreshStampOverrides(): Promise<void> {
  if (!isTauri()) return;
  try {
    const files = await api.stampList();
    const next: Partial<Record<StampKind, string>> = {};
    await Promise.all(
      files.map(async (f) => {
        next[f.kind as StampKind] = await toAssetUrl(f.path);
      }),
    );
    overrides.value = next;
  } catch {
    // Shell without the stamp commands — keep the defaults showing.
  }
}

/** The effective display image for a seal: the user's custom picture when
 *  one is set, null = the bundled default glyph. */
export function stampOverrideUrl(kind: StampKind): string | null {
  return overrides.value[kind] ?? null;
}

/** Native image picker → the file lands as `<kind>.<ext>` in the stamps
 *  folder and shows up everywhere immediately. Null = the dialog was
 *  cancelled. */
export async function importStampImage(kind: StampKind): Promise<boolean> {
  const imported = await api.stampImport(kind);
  await refreshStampOverrides();
  // Only a landed import announces itself — a cancelled dialog must not
  // send the overlay re-reading an unchanged folder.
  if (imported != null) emitTauriEvent(STAMPS_CHANGED_EVENT);
  return imported != null;
}

/** Delete the custom picture — the seal falls back to the default glyph. */
export async function resetStampImage(kind: StampKind): Promise<void> {
  try {
    await api.stampReset(kind);
    emitTauriEvent(STAMPS_CHANGED_EVENT);
  } finally {
    await refreshStampOverrides();
  }
}

// Boot: pick up the stamps folder once per session (RatingStamp is mounted
// on every stats surface, so the first mount covers the app).
if (isTauri()) {
  void refreshStampOverrides();
}
