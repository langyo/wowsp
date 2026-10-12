/** Appearance-section state for SettingsBody: the color-scheme editor
 *  window, wallpaper import/two-step-delete and the solar-period label. */
import { nextTick, ref } from "vue";

import { getThemeTokens, useTheme, useToast } from "@celestia-island/hikari";

import { useWallpaper } from "@/theme/useWallpaper";
import { t } from "@/i18n";

export function useSettingsAppearance() {
  const theme = useTheme();
  const wallpaper = useWallpaper();
  const toast = useToast();

  // ── color scheme editor window ────────────────────────────────────────
  // The scheme list's row affordances raise one shared editor window
  // (ThemeSchemeDialog): the pencil prefills it with that row's scheme
  // (customs AND builtin presets — a preset save lands as a same-id
  // override), the dashed "new scheme" row opens a blank canvas.
  const schemeDialogOpen = ref(false);
  /** Row being edited (null = the new-scheme row opened a blank canvas). */
  const editSchemeId = ref<string | null>(null);
  function openSchemeEditor(id: string | null) {
    // The factory default scheme is view-only: it has no editable
    // identity of its own (a save would shadow it with a same-id
    // custom), so its tile carries no edit affordance and the editor
    // refuses it here too — belt for any future caller.
    if (id === "default") return;
    editSchemeId.value = id;
    schemeDialogOpen.value = true;
  }
  /** Row swatch: the scheme's primary/secondary halves under the current
   *  effective mode — customs first (an override shadows its builtin),
   *  then the preset table (the same precedence hikari applies). */
  function schemeSwatchColors(id: string): [{ r: number; g: number; b: number }, { r: number; g: number; b: number }] | null {
    const custom = theme.customThemes.value.find((c) => c.id === id);
    if (custom) {
      const s = theme.effectiveMode.value === "dark" ? custom.dark : custom.light;
      return [s.primary, s.secondary];
    }
    const tokens = getThemeTokens(id, theme.effectiveMode.value);
    return tokens ? [tokens.primary, tokens.secondary] : null;
  }
  /** Row delete — offered only on custom-flagged rows (a custom shadowing
   *  a builtin id stays flagged custom, so this covers both a plain
   *  delete and "restore the factory preset"). hikari re-points the
   *  selection itself when the deleted id was active — back to the
   *  factory preset when the id resolves as a builtin, otherwise to the
   *  default theme. */
  function removeScheme(id: string) {
    theme.removeCustomTheme(id);
  }

  // ── wallpaper management (import + two-step delete) ───────────────────
  const importingWallpaper = ref(false);
  /** The wallpaper strip element — after a successful import it scrolls
   *  to the far end so the newly added card is visible. */
  const wallpaperRow = ref<HTMLDivElement | null>(null);
  /** Two-step delete confirm per custom wallpaper (id of the armed row). */
  const wallpaperArmed = ref<string | null>(null);

  async function importWallpaper() {
    if (importingWallpaper.value) return;
    importingWallpaper.value = true;
    try {
      // Null = the user dismissed the native picker — not an error;
      // only reveal the new card when one actually landed.
      const imported = await wallpaper.importCustom();
      if (imported) {
        await nextTick();
        const row = wallpaperRow.value;
        if (row) row.scrollTo({ left: row.scrollWidth, behavior: "smooth" });
      }
    } catch (e) {
      toast.error(`${t("settings.wallpaperImportFailed")}\n${(e as Error).message || e}`);
    } finally {
      importingWallpaper.value = false;
    }
  }

  async function removeWallpaper(id: string) {
    wallpaperArmed.value = null;
    try {
      await wallpaper.removeCustomById(id);
    } catch (e) {
      toast.error(`${t("settings.wallpaperRemoveFailed")}\n${(e as Error).message || e}`);
    }
  }

  function periodLabel(p: string): string {
    if (p === "day") return t("settings.periodDay");
    if (p === "dusk") return t("settings.periodDusk");
    return t("settings.periodNight");
  }

  return {
    wallpaper,
    schemeDialogOpen,
    editSchemeId,
    openSchemeEditor,
    schemeSwatchColors,
    removeScheme,
    importingWallpaper,
    wallpaperRow,
    wallpaperArmed,
    importWallpaper,
    removeWallpaper,
    periodLabel,
  };
}
