/**
 * WoWSP theme manager. Simplified from shittim-chest's useTheme (no circadian/
 * wallpaper coupling — just explicit dark/light). Persists to localStorage.
 */
import { ref } from "vue";
import { getThemeTokens, tokensToCSSVars, type ThemeMode } from "./presets";

const currentMode = ref<ThemeMode>(
  (localStorage.getItem("wowsp-theme-mode") as ThemeMode) || "dark",
);
const currentPreset = ref(localStorage.getItem("wowsp-theme-preset") || "ocean");

function applyTheme() {
  const tokens = getThemeTokens(currentPreset.value, currentMode.value);
  const vars = tokensToCSSVars(tokens);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
  root.setAttribute("data-mode", currentMode.value);
  root.setAttribute("data-theme", currentPreset.value);
}

export function initTheme() {
  applyTheme();
}

export function useTheme() {
  return {
    mode: currentMode,
    preset: currentPreset,
    setMode(mode: ThemeMode) {
      currentMode.value = mode;
      localStorage.setItem("wowsp-theme-mode", mode);
      applyTheme();
    },
    toggleMode() {
      this.setMode(currentMode.value === "dark" ? "light" : "dark");
    },
  };
}
