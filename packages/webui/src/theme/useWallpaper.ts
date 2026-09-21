/**
 * WoWSP wallpaper composable. The choice is solid (follows the theme mode)
 * or a custom image from the fixed AppData `wallpapers/` folder. Manages the
 * active wallpaper, keeps the custom list in sync with that folder via
 * `commands::wallpaper`, and exposes CSS-var-ready computed values for the
 * renderer.
 */
import { computed, ref } from "vue";

import { useTheme } from "@/theme";
import { SOLID_WALLPAPER, DEFAULT_WALLPAPER_ID, loadActiveWallpaperId, saveActiveWallpaperId, type WallpaperPreset } from "./wallpaper";
import {
  setWallpaperOverlayPercent,
  wallpaperOverlayPercent,
} from "./wallpaperOverlay";
import { api } from "@/api";
import { isTauri } from "@/transport";

const activeWallpaperId = ref(loadActiveWallpaperId());

/** Custom wallpapers = image files in the AppData wallpapers folder. Empty
 *  in the browser (mock backend has no filesystem) and until the first
 *  refresh lands. */
const customWallpapers = ref<WallpaperPreset[]>([]);

let _convertFileSrc: ((path: string) => string) | false | null = null;

/** Asset-protocol URL for a wallpaper file (identity in non-Tauri contexts,
 *  where custom wallpapers don't exist anyway). */
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

function setActiveWallpaper(id: string) {
  activeWallpaperId.value = id;
  saveActiveWallpaperId(id);
}

async function refreshCustom(): Promise<void> {
  if (!isTauri()) return;
  try {
    const files = await api.wallpaperList();
    customWallpapers.value = await Promise.all(
      files.map(async (f) => ({
        id: f.id,
        name: f.name,
        source: { type: "image" as const, url: await toAssetUrl(f.path) },
        author: null,
      })),
    );
  } catch {
    // Shell without the wallpaper commands — keep whatever we have (the
    // solid default stays available regardless).
  }
  // Self-heal: a persisted id whose file is gone falls back to solid.
  if (
    activeWallpaperId.value !== DEFAULT_WALLPAPER_ID &&
    !customWallpapers.value.some((w) => w.id === activeWallpaperId.value)
  ) {
    setActiveWallpaper(DEFAULT_WALLPAPER_ID);
  }
}

export function useWallpaper() {
  const { effectiveMode } = useTheme();

  const allWallpapers = computed<WallpaperPreset[]>(() => [
    SOLID_WALLPAPER,
    ...customWallpapers.value,
  ]);

  const activeWallpaper = computed(
    () =>
      allWallpapers.value.find((w) => w.id === activeWallpaperId.value) ??
      allWallpapers.value[0],
  );

  // setActiveWallpaper lives at module level (refreshCustom's self-heal
  // shares it); the composable just re-exposes it.

  /** Native image picker → the file lands in the wallpapers folder → it
   *  becomes the active background right away (live preview everywhere).
   *  Returns null when the user cancelled the dialog. */
  async function importCustom(): Promise<string | null> {
    const imported = await api.wallpaperImport();
    await refreshCustom();
    if (imported) setActiveWallpaper(imported.id);
    return imported?.id ?? null;
  }

  async function removeCustomById(id: string) {
    try {
      await api.wallpaperRemove(id);
    } finally {
      await refreshCustom();
      if (activeWallpaperId.value === id) setActiveWallpaper(DEFAULT_WALLPAPER_ID);
    }
  }

  const currentSource = computed(() => {
    return activeWallpaper.value?.source ?? { type: "solid" as const };
  });

  /** Art credit of the active wallpaper (null for solid backgrounds). */
  const activeAuthor = computed(() => activeWallpaper.value?.author ?? null);

  const wallpaperType = computed(() => currentSource.value.type);
  const isImage = computed(() => wallpaperType.value === "image");
  const isSolid = computed(() => wallpaperType.value === "solid");

  const mediaUrl = computed(() => {
    const src = currentSource.value;
    return src.type === "image" ? src.url : "";
  });

  /** Solid always mirrors the theme mode — a light theme never sits on a
   *  black background. */
  const solidColor = computed<"black" | "white" | null>(() => {
    if (currentSource.value.type !== "solid") return null;
    return effectiveMode.value === "light" ? "white" : "black";
  });

  /** Scrim strength over image wallpapers — the user's transparency
   *  preference (see wallpaperOverlay.ts). Solid never draws a scrim. */
  const overlayOpacity = computed(() => {
    if (isSolid.value) return 0;
    return wallpaperOverlayPercent.value / 100;
  });

  return {
    activeWallpaperId,
    activeWallpaper,
    activeAuthor,
    allWallpapers,
    customWallpapers,
    currentSource,
    wallpaperType,
    isImage,
    isSolid,
    mediaUrl,
    solidColor,
    overlayOpacity,
    overlayPercent: wallpaperOverlayPercent,
    setOverlayPercent: setWallpaperOverlayPercent,
    setActiveWallpaper,
    importCustom,
    removeCustomById,
    refreshCustom,
  };
}

// Boot: pick up the wallpapers folder once per session (the composable's
// first use — WallpaperRenderer mounts at startup).
if (isTauri()) {
  void refreshCustom();
}
