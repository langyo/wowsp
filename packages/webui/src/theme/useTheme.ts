/**
 * WoWSP theme manager. Adapted from shittim-chest's useTheme + useWallpaper.
 *
 * Modes: "system" (auto dark/light by solar altitude), "dark", "light".
 * The solar resolution fetches geolocation once per day (cached), then
 * re-evaluates every 5 minutes so the theme follows the sun. Explicit
 * dark/light overrides persist to localStorage.
 */
import { computed, ref } from "vue";

import { getThemeTokens, tokensToCSSVars, type EffectiveMode, type ThemeMode } from "./presets";
import { getGeolocation, getTimePeriod, type TimePeriod } from "@/composables/useSolarTime";

const currentMode = ref<ThemeMode>(
  (localStorage.getItem("wowsp-theme-mode") as ThemeMode) || "system",
);
const currentPreset = ref(localStorage.getItem("wowsp-theme-preset") || "ocean");
const effectiveMode = ref<EffectiveMode>("dark");
const currentPeriod = ref<TimePeriod>("night");
const geo = ref<{ lat: number; lng: number } | null>(null);
let periodPollHandle: number | null = null;

/** Resolve "system" → "dark"/"light" via solar altitude. */
function resolveEffectiveMode(mode: ThemeMode): EffectiveMode {
  if (mode === "system") {
    return currentPeriod.value === "day" ? "light" : "dark";
  }
  return mode;
}

function applyTheme() {
  effectiveMode.value = resolveEffectiveMode(currentMode.value);
  const tokens = getThemeTokens(currentPreset.value, effectiveMode.value);
  const vars = tokensToCSSVars(tokens);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
  root.setAttribute("data-mode", effectiveMode.value);
  root.setAttribute("data-theme", currentPreset.value);
}

/** Re-evaluate the time period from geolocation + now(). */
function updatePeriod() {
  if (!geo.value) return;
  currentPeriod.value = getTimePeriod(geo.value.lat, geo.value.lng, new Date());
}

/** Initialize the theme system on app mount. Fetches geolocation (cached),
 *  resolves the initial period, applies the theme, and starts a 5-min poll
 *  so "system" mode tracks the sun. */
export async function initTheme() {
  // Apply immediately with last-known state (avoids flash of wrong theme).
  applyTheme();

  // Resolve geolocation + period for "system" mode.
  try {
    geo.value = await getGeolocation();
    updatePeriod();
    applyTheme();
  } catch {
    // geo failed — currentPeriod stays at default; system mode → dark.
  }

  // Poll period every 5 minutes so system mode follows the sun.
  if (periodPollHandle === null) {
    periodPollHandle = window.setInterval(() => {
      if (currentMode.value === "system") {
        updatePeriod();
        applyTheme();
      }
    }, 5 * 60 * 1000);
  }
}

export function useTheme() {
  return {
    mode: currentMode,
    effectiveMode: computed(() => effectiveMode.value),
    preset: currentPreset,
    period: computed(() => currentPeriod.value),
    geo: computed(() => geo.value),
    setMode(mode: ThemeMode) {
      currentMode.value = mode;
      localStorage.setItem("wowsp-theme-mode", mode);
      applyTheme();
    },
    setPreset(id: string) {
      currentPreset.value = id;
      localStorage.setItem("wowsp-theme-preset", id);
      applyTheme();
    },
    /** Cycle system → dark → light → system. */
    cycleMode() {
      const order: ThemeMode[] = ["system", "dark", "light"];
      const idx = order.indexOf(currentMode.value);
      this.setMode(order[(idx + 1) % order.length]);
    },
  };
}
