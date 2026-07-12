/**
 * WoWSP wallpaper composable. Adapted from shittim-chest's useWallpaper,
 * simplified to solid + image types. Manages the active wallpaper, resolves
 * mode restrictions (a light-only wallpaper falls back to solid in dark
 * mode), and exposes CSS-var-ready computed values for the renderer.
 */
import { computed, ref, watch } from "vue";

import { useTheme } from "./useTheme";
import {
  addCustomWallpaper as addCustom,
  DEFAULT_PRESETS,
  DEFAULT_WALLPAPER_ID,
  loadActiveWallpaperId,
  loadCustomWallpapers,
  removeCustomWallpaper as removeCustom,
  saveActiveWallpaperId,
  type CustomWallpaper,
  type WallpaperPreset,
  type WallpaperSource,
  type WallpaperType,
} from "./wallpaper";

const activeWallpaperId = ref(loadActiveWallpaperId());
const customWallpapers = ref<CustomWallpaper[]>(loadCustomWallpapers());

function findPreset(id: string): WallpaperPreset | undefined {
  return DEFAULT_PRESETS.find((p) => p.id === id);
}

/** If the active wallpaper has a mode restriction that conflicts with the
 *  current effective mode, fall back to solid-auto. */
function resolveForMode(wpId: string, mode: "dark" | "light"): string {
  const preset = findPreset(wpId);
  if (preset?.modeRestriction && preset.modeRestriction !== mode) {
    return DEFAULT_WALLPAPER_ID;
  }
  return wpId;
}

export function useWallpaper() {
  const { effectiveMode } = useTheme();

  const allWallpapers = computed<WallpaperPreset[]>(() => [
    ...DEFAULT_PRESETS,
    ...customWallpapers.value.map((cw) => ({
      id: cw.id,
      name: cw.name,
      source: cw.source,
      modeRestriction: null,
    })),
  ]);

  const activeWallpaper = computed(
    () =>
      allWallpapers.value.find((w) => w.id === activeWallpaperId.value) ??
      allWallpapers.value[0],
  );

  function setActiveWallpaper(id: string) {
    activeWallpaperId.value = id;
    saveActiveWallpaperId(id);
  }

  function addCustomFromSource(name: string, source: WallpaperSource) {
    const id = `custom-${Date.now()}`;
    addCustom({ id, name, source, addedAt: Date.now() });
    customWallpapers.value = loadCustomWallpapers();
  }

  function removeCustomById(id: string) {
    removeCustom(id);
    customWallpapers.value = loadCustomWallpapers();
    if (activeWallpaperId.value === id) setActiveWallpaper(DEFAULT_WALLPAPER_ID);
  }

  const currentSource = computed<WallpaperSource>(() => {
    return activeWallpaper.value?.source ?? { type: "solid", color: "auto" };
  });

  const wallpaperType = computed<WallpaperType>(() => currentSource.value.type);
  const isImage = computed(() => wallpaperType.value === "image");
  const isSolid = computed(() => wallpaperType.value === "solid");

  const mediaUrl = computed(() => {
    const src = currentSource.value;
    return src.type === "image" ? src.url : "";
  });

  const solidColor = computed<"black" | "white" | null>(() => {
    const src = currentSource.value;
    if (src.type !== "solid") return null;
    if (src.color === "auto") return effectiveMode.value === "light" ? "white" : "black";
    return src.color;
  });

  /** Overlay opacity — dims image backgrounds for readability. Solid has 0. */
  const overlayOpacity = computed(() => {
    if (isSolid.value) return 0;
    // Image: stronger overlay in dark mode, lighter in light mode.
    return effectiveMode.value === "dark" ? 0.7 : 0.55;
  });

  // Keep the active wallpaper valid when mode changes.
  watch(effectiveMode, (mode) => {
    const resolved = resolveForMode(activeWallpaperId.value, mode);
    if (resolved !== activeWallpaperId.value) {
      activeWallpaperId.value = resolved;
      saveActiveWallpaperId(resolved);
    }
  });

  return {
    activeWallpaperId,
    activeWallpaper,
    allWallpapers,
    customWallpapers,
    currentSource,
    wallpaperType,
    isImage,
    isSolid,
    mediaUrl,
    solidColor,
    overlayOpacity,
    setActiveWallpaper,
    addCustomFromSource,
    removeCustomById,
  };
}
