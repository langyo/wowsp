/**
 * WoWSP bootstrap — global hooks wired before the app mounts. Mirrors
 * shittim-chest's composables/bootstrapApp.ts: everything here must run
 * before first paint so theme/fonts/viewport never flash.
 *
 * Serves the main shell and the lazily-created tray panel; the game
 * overlay window keeps its own non-Vue bootstrap (see the DPI note in
 * the body).
 */
import { watch } from "vue";

import {
  applyViewportPolicy,
  initFontContext,
  initTheme,
  installHkImageFallback,
  setLocale as setHikariLocale,
  useTheme,
} from "@celestia-island/hikari";

import { removeBuiltinShadowingCustomThemes, startModeTokenBridge } from "./theme";
import { migrateSolarLocationBasis } from "./theme/solarStrategyMigration";
import { installNativeMenuBlock } from "./utils/nativeMenu";
import { applyDefaultSchemeBrand } from "./theme/defaultSchemeBrand";
import { installGlobalTooltip } from "./composables/globalTooltip";
import { api } from "./api";
import { initDpiPrefs } from "./theme/dpiPrefs";
import { initFontScalePreference } from "./theme/fontScalePreference";
import { initThemeModePreference } from "./theme/themeModePreference";
import { initUiOpacityPreference } from "./theme/uiOpacityPreference";
import { initWallpaperBlurPreferences } from "./theme/wallpaperBlur";
import { i18n } from "./i18n";
import { hikariLocaleOf } from "./i18n/hikariMessages";

/** Which surface [`bootstrap`] is initializing. The tray panel — a small
 *  FIXED-SIZE popup created lazily, long after the main window booted —
 *  must skip the DPI interface-scale preference (its 320px window width
 *  would trip the scale's risky-rollback wipe and erase the preference the
 *  main window shares) and must not cancel a manual-locate pick the MAIN
 *  window may legitimately have in flight at that arbitrary moment. */
export type BootstrapSurface = "main" | "tray";

export interface BootstrapOptions {
  surface?: BootstrapSurface;
}

export function bootstrap(options: BootstrapOptions = {}): void {
  const isMain = (options.surface ?? "main") === "main";
  // Desktop surface: the WebView's own context menu (Reload / Inspect /
  // Save as) must never appear — see utils/nativeMenu. The app's own
  // context menus still work (they preventDefault the same event and
  // render through hikari's provider).
  installNativeMenuBlock();
  // Mobile UX contract (hikari #325): normalize the viewport meta before
  // first paint. No-op for the desktop webview's standard meta, but keeps
  // the browser window honest on phones.
  applyViewportPolicy();

  // Brand the factory default scheme BEFORE initTheme resolves it: the
  // collapsed preset's light secondary is hikari's inherited violet, and
  // the pink swap must be on the table before the first palette application
  // (see theme/defaultSchemeBrand — the swatch, the mode-token bridge and
  // every secondary-driven surface read the table live).
  applyDefaultSchemeBrand();
  // Solar-location strategy now lives IN hikari (0.55.241+): the engine
  // hydrates its storage inside initTheme(), resolves timezone-first and
  // fully offline by default, and its refreshThemeClock is last-write-wins.
  // WoWSP only maps the retired local basis key onto the engine's storage
  // once, BEFORE the clock starts (theme/solarStrategyMigration).
  migrateSolarLocationBasis();
  initTheme();
  // One-time repair: drop custom schemes that shadow builtin preset ids
  // (see removeBuiltinShadowingCustomThemes — the dark-mode-shows-light
  // report). Before the mode preference applies, so the re-apply lands on
  // the repaired table.
  removeBuiltinShadowingCustomThemes();
  // Mode token bridge: write the resolved palette as INLINE styles on
  // <html> (hikari's documented consumer contract) and follow theme/mode
  // changes — hikari's own deltas block has been observed losing the
  // cascade in dark mode (static light table shows through).
  startModeTokenBridge();
  // WoWSP's own three-way mode preference (dark/light/solar) sits on top of
  // hikari's mode and must run AFTER initTheme so the authoritative
  // `wowsp-theme-mode` key wins over whatever hikari restored.
  // The ?theme= deep link below still overrides both for this load only.
  initThemeModePreference();
  // WoWSP's font-size preference (five levels over the --text-* scale)
  // writes inline :root overrides after the stylesheets load — same
  // authoritative-key-wins contract as the mode preference above.
  initFontScalePreference();
  // WoWSP's UI-surface-opacity preference writes the inline `--ui-opacity`
  // SOLIDITY value the surface layer interpolates every fill with (theme/
  // surfaces.scss: 1 = fully opaque, the shipped default) — same
  // authoritative-key-wins contract as above. The game-overlay window never
  // calls bootstrap() (see initDpiPrefs), so its transparent roster cannot
  // pick up a dial meant for the main shell.
  initUiOpacityPreference();
  // WoWSP's wallpaper blur preference writes the inline
  // `--wallpaper-blur-sidebar` / `--wallpaper-blur-main` values consumed
  // by the nav rail and the content-column blur band — same
  // authoritative-key-wins contract as above, and equally inert in the
  // game-overlay window (no bootstrap → stylesheet defaults, no blur).
  initWallpaperBlurPreferences();
  // WoWSP's interface-scale (DPI) preference writes a root CSS `zoom` over
  // the whole shell — same authoritative-key-wins contract as above. Only
  // a MAIN-window bootstrap runs it: the game overlay has its own separate
  // non-Vue bootstrap, and the tray panel is a fixed-size popup whose
  // 320px width would trip the scale's risky-rollback wipe (erasing the
  // shared preference) and whose card must not zoom at all.
  if (isMain) {
    initDpiPrefs();
  }
  initFontContext();

  // Delegated tooltip hook: everything that used to lean on native
  // `title` popups opts in via data-hint and renders hikari-style.
  installGlobalTooltip();

  // hikari's document-level image safety net (user direction 2026-10-19):
  // any raw <img> whose load fails gets hikari's designed broken-image
  // placeholder in place (class + bundled SVG swap, one-shot, self-healing)
  // instead of the WebView's default torn-file glyph. Map surfaces pair
  // this with the pack-era URL fallback in modelLoader; everything else —
  // icon-ish art, remote thumbnails — is covered right here.
  installHkImageFallback();

  // Backend flag hygiene: a webview reload (Vite HMR, WebView2 crash
  // recovery) wipes this window's manual-locate picker-layer state while
  // the Rust-side open flag would stay set — at boot the layer is closed
  // by definition, so clearing is always safe. Rejected off the desktop
  // shell (browser dev), ignored. MAIN window only: the tray panel loads
  // lazily at an arbitrary moment, and its boot must never stand down a
  // pick the main window has in flight.
  if (isMain) {
    void api.cancelManualLocate().catch(() => {});
  }

  // One-shot deep link (?theme=light|dark): force the mode for this load
  // WITHOUT persisting it — same semantics as the pre-hikari theme manager.
  // Mutate the mode ref directly, then re-apply via setTheme (persists only
  // the unchanged theme id); setMode() would write localStorage.
  const forced = new URLSearchParams(window.location.search).get("theme");
  if (forced === "light" || forced === "dark") {
    const theme = useTheme();
    if (theme.currentMode.value !== forced) {
      theme.currentMode.value = forced;
      theme.setTheme(theme.currentTheme.value);
    }
  }

  // Seed hikari's own i18n context (upstreamed components render their own
  // copy: confirm dialog buttons, empty states, …) from the detected app
  // locale, and keep it in sync when the user switches languages.
  const appLocale = i18n.global.locale.value;
  document.documentElement.lang = appLocale;
  void setHikariLocale(hikariLocaleOf(appLocale));
  watch(
    () => i18n.global.locale.value,
    (locale) => {
      document.documentElement.lang = locale;
      void setHikariLocale(hikariLocaleOf(locale));
    },
  );
}
