/** Appearance settings section: theme mode/scheme picker, wallpapers,
 *  opacity, font size, the staged DPI slider and the solar indicator. */
import { computed, defineComponent, onUnmounted, ref, type PropType } from "vue";
import { Check, ImagePlus, Monitor, MoonStar, Palette, SquarePen, Sun, Trash2 } from "@lucide/vue";
import {
  HkButton,
  HkDivider,
  HkIconButton,
  HkScrollContainer,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkSlider,
  HkSolarLocationSetting,
  HkTabs,
  useTheme,
} from "@celestia-island/hikari";
// The auto-altitude strip chrome (the merged cell rendered below) —
// hikari's own component stylesheet, imported granularly so this
// settings group renders the SAME cell as the theme panel does,
// without pulling the popover around it.
import "@celestia-island/hikari/components/HkThemeToggle.scss";

import { solarAltitude } from "@/theme";
import { useWallpaper } from "@/theme/useWallpaper";
import {
  BUILTIN_WALLPAPER_IDS,
  imageSourceUrl,
  wallpaperNameKey,
} from "@/theme/wallpaper";
import { WALLPAPER_BLUR_MAX, WALLPAPER_BLUR_MIN } from "@/theme/wallpaperBlur";
import {
  UI_OPACITY_MAX,
  UI_OPACITY_MIN,
  setUiOpacityPercent,
  uiOpacityPercent,
} from "@/theme/uiOpacityPreference";
import {
  preferenceToTabKey,
  setThemeModePreference,
  tabKeyToPreference,
  themeModePreference,
} from "@/theme/themeModePreference";
import { DPI_MAX, DPI_MIN, DPI_STEP, isDpiRisky } from "@/theme/dpiPrefs";
import { t } from "@/i18n";
import { notifySettingsSaved } from "@/stores/settingsSavedFlash";
import { isNative } from "@/utils/platform";
import FontSizeControl from "@/components/layout/FontSizeControl";
import ThemeSchemeDialog from "@/components/settings/ThemeSchemeDialog";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

/** Hikari token → CSS rgb() color. */
function css(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

/** The auto-mode merged run, hoisted (the panel's own AUTO_MERGE_KEYS
 *  rationale): a fresh array literal per render would re-fire HkTabs'
 *  mergeKeys watcher — one redundant geometry refresh per altitude
 *  tick — on every render in solar mode. */
const AUTO_MERGE_KEYS = ["light", "dark"];

export default defineComponent({
  name: "SettingsAppearanceSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const theme = useTheme();
    const wallpaper = useWallpaper();
    const { appearance, dpi } = props.ctx;
    const { geo, period } = theme;

    // ── Auto-mode altitude readout (the merged cell) ──────────────────
    // The shittim-chest pattern (hikari's HkThemePanelContent): while the
    // solar (auto) preference is active the light/dark cells collapse
    // (HkTabs mergeKeys) into one strip showing the live sun altitude;
    // pressing it resolves auto back to manual on the side it currently
    // renders. The minute tick keeps the readout current only while this
    // section is mounted — the same policy as the panel's own timer.
    const altTick = ref(0);
    const altTimer = setInterval(() => {
      altTick.value += 1;
    }, 60_000);
    onUnmounted(() => {
      clearInterval(altTimer);
    });
    /** Sun altitude formatted like "+49.6°" (the panel's grammar).
        theme.geo is hikari's own clock location — never null (it boots
        on the timezone fallback and upgrades to the real fix), so the
        readout and the engine share one resolution, exactly like the
        panel's own altitudeText. */
    const altitudeText = computed(() => {
      void altTick.value;
      const alt = solarAltitude(geo.value.lat, geo.value.lng, new Date());
      return `${alt >= 0 ? "+" : ""}${alt.toFixed(1)}°`;
    });
    /** Glyph hints which side a press will land on (sun by day, moon at night). */
    const altitudeNight = computed(() => {
      void altTick.value;
      return theme.effectiveMode.value === "dark";
    });
    /** Pressing the altitude strip drops OUT of auto onto the side auto
        currently resolves to (day → light, night → dark). Debounced:
        input synthesis may deliver both a pointer sequence and a click
        for one physical press (hikari's own guard). */
    let lastManualSwitchAt = 0;
    function resolveAutoToManual() {
      const now = Date.now();
      if (now - lastManualSwitchAt < 700) return;
      lastManualSwitchAt = now;
      setThemeModePreference(theme.effectiveMode.value);
    }

    return () => {
      // Staged-or-persisted notch for the DPI slider/readout (null = Auto)
      // and its risk flag — same locals as the reference DpiControl window.
      const pending = dpi.pendingDpi.value;
      const staged = pending ?? dpi.dpiScale.value;
      const warningVisible = pending != null && isDpiRisky(pending, window.innerWidth);
      return (
          <>
          {/* appearance — mode, color preset, wallpaper, solar indicator */}
          <HkSettingsGroup title={t("settings.themeMode")}>
            {/* Theme-mode group in the shittim-chest pattern (hikari's
                HkThemePanelContent grammar): 自动 first, then the manual
                light/dark cells. While the solar (auto) preference is
                active the two manual cells merge into ONE altitude strip
                (HkTabs mergeKeys + #merged) showing the live sun
                altitude; pressing it drops back to manual. Underneath,
                the wowsp preference layer is unchanged — solar ≡ hikari
                "system" (see theme/themeModePreference; the retired
                OS-follower mode migrates onto solar). Selection applies
                immediately. */}
            <HkTabs
              block
              variant="segmented"
              modelValue={preferenceToTabKey(themeModePreference.value)}
              onUpdate:modelValue={(v: string) => {
                setThemeModePreference(tabKeyToPreference(v));
              }}
              mergeKeys={themeModePreference.value === "solar" ? AUTO_MERGE_KEYS : undefined}
              tabs={[
                { key: "system", label: t("settings.themeModeAuto"), icon: <Monitor size={16} /> },
                { key: "light", label: t("settings.themeModeLight"), icon: <Sun size={16} /> },
                { key: "dark", label: t("settings.themeModeDark"), icon: <MoonStar size={16} /> },
              ]}
            >
              {{
                merged: () => (
                  <button
                    type="button"
                    class="s-theme-mode-autoalt"
                    data-hint={t("settings.themeAutoAltitudeTip")}
                    aria-label={t("settings.themeAutoAltitudeTip")}
                    onClick={resolveAutoToManual}
                  >
                    {altitudeNight.value ? <MoonStar size={16} /> : <Sun size={16} />}
                    <span class="s-theme-mode-autoalt-value">{altitudeText.value}</span>
                  </button>
                ),
              }}
            </HkTabs>

            {/* color scheme — the live theme list in hikari's picker
                grammar (what shittim-chest shows): builtin presets plus the
                user's custom schemes, one tile per id (a custom shadowing a
                builtin id dedupes to one tile flagged custom — its delete
                doubles as "restore the factory preset"). A tile click
                applies the theme live; the pencil raises the full scheme
                editor window (ThemeSchemeDialog — host of the ship-type
                pie palette too) prefilled with that tile; the dashed tile
                at the end starts a blank custom scheme. Unlike the old
                preset-card grid this list can never go stale against the
                installed hikari: it reads the theme engine's own merged
                view (allThemeList), not a local whitelist. */}
            <HkSettingsSub title={t("settings.themePreset")}>
              <div class="settings-modal__themes">
                {theme.allThemeList.value.map((th) => {
                  const on = theme.currentTheme.value === th.id;
                  const colors = appearance.schemeSwatchColors(th.id);
                  return (
                    <div
                      key={th.id}
                      class={["settings-modal__theme", on ? "settings-modal__theme--on" : ""]}
                    >
                      <button
                        type="button"
                        aria-pressed={on}
                        class="settings-modal__theme-pick"
                        onClick={() => {
                          // The scheme pick persists through hikari's own
                          // storage (useTheme.setTheme), so the flash is
                          // raised here at the user-action call site.
                          theme.setTheme(th.id);
                          notifySettingsSaved();
                        }}
                      >
                        {colors ? (
                          <span
                            class="settings-modal__theme-swatch"
                            style={{
                              background:
                                `linear-gradient(135deg, ${css(colors[0])} 0 50%, ${css(colors[1])} 50% 100%)`,
                            }}
                          />
                        ) : null}
                        <span class="settings-modal__theme-name">
                          {th.id === "default" ? t("settings.schemeDefaultName") : th.name}
                        </span>
                        {on ? <Check size={12} class="settings-modal__theme-check" /> : null}
                      </button>
                      <span class="settings-modal__theme-actions">
                        {/* The factory default is view-only — no edit
                            affordance (its name is fixed, and a save would
                            only shadow it with a same-id custom). */}
                        {th.id !== "default" ? (
                          <HkIconButton
                            size={24}
                            variant="ghost"
                            aria-label={t("settings.themeEdit")}
                            onClick={() => appearance.openSchemeEditor(th.id)}
                          >
                            <SquarePen size={14} />
                          </HkIconButton>
                        ) : null}
                        {th.isCustom ? (
                          <HkIconButton
                            size={24}
                            variant="ghost"
                            aria-label={t("settings.themeDelete")}
                            onClick={() => appearance.removeScheme(th.id)}
                          >
                            <Trash2 size={14} />
                          </HkIconButton>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
                <button
                  type="button"
                  class="settings-modal__theme-add"
                  onClick={() => appearance.openSchemeEditor(null)}
                >
                  <Palette size={14} />
                  {t("settings.themeNew")}
                </button>
              </div>
              <HkSettingsHint>{t("settings.themeSchemeHint")}</HkSettingsHint>
            </HkSettingsSub>

            <HkDivider />

            {/* wallpaper / background — the built-in illustration pair
                follows the theme mode (its card is named after the
                character each side depicts); the pure-color preset paints
                the theme's own base color; custom entries are files in the
                AppData wallpapers folder and can be deleted (two-step
                confirm per card). */}
            <HkSettingsSub title={t("settings.wallpaper")}>
              {/* Horizontal strip scroller: hikari's scroll container owns
                  the scrollbar (auto-hiding overlay track); the cards
                  scroll inside its viewport. The ref drives the
                  scroll-to-far-end after an import (useSettingsAppearance). */}
              <HkScrollContainer
                class="settings-modal__wallpapers"
                axis="horizontal"
                ref={appearance.wallpaperRow}
              >
                <div class="settings-modal__wallpapers-inner">
                {wallpaper.allWallpapers.value.map((w) => {
                  const on = wallpaper.activeWallpaperId.value === w.id;
                  // Builtin-ness decides the delete affordance, not the
                  // presence of a name key (the art pair's label is
                  // mode-keyed now, but it is still not deletable).
                  const custom = !BUILTIN_WALLPAPER_IDS.has(w.id);
                  // Mode-aware label: the art pair is named after the
                  // character the CURRENT side depicts.
                  const labelKey = wallpaperNameKey(
                    w,
                    theme.effectiveMode.value === "dark" ? "dark" : "light",
                  );
                  return (
                    <div
                      key={w.id}
                      class={[
                        "settings-modal__wallpaper",
                        on ? "settings-modal__wallpaper--on" : "",
                      ]}
                    >
                      <button
                        type="button"
                        aria-pressed={on}
                        class="settings-modal__wallpaper-pick"
                        onClick={() => wallpaper.setActiveWallpaper(w.id)}
                      >
                        <span class="settings-modal__wallpaper-preview">
                          {w.source.type === "solid" ? (
                            // Live swatch: the theme's own background.
                            <span
                              class="settings-modal__wallpaper-swatch"
                              style={{ background: "rgb(var(--color-background))" }}
                            />
                          ) : (
                            <span
                              class="settings-modal__wallpaper-swatch settings-modal__wallpaper-swatch--image"
                              style={{
                                backgroundImage: `url(${imageSourceUrl(
                                  w.source,
                                  theme.effectiveMode.value === "dark" ? "dark" : "light",
                                )})`,
                              }}
                            />
                          )}
                        </span>
                        <span class="settings-modal__wallpaper-name">
                          {labelKey ? t(labelKey) : w.name}
                        </span>
                        {on ? <Check size={12} class="settings-modal__wallpaper-check" /> : null}
                      </button>
                      {custom ? (
                        appearance.wallpaperArmed.value === w.id ? (
                          <button
                            type="button"
                            class="settings-modal__wallpaper-delete settings-modal__wallpaper-delete--confirm"
                            onClick={() => void appearance.removeWallpaper(w.id)}
                          >
                            {t("settings.wallpaperDeleteConfirm")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            class="settings-modal__wallpaper-delete"
                            data-hint={t("settings.wallpaperDelete")}
                            aria-label={t("settings.wallpaperDelete")}
                            onClick={() => (appearance.wallpaperArmed.value = w.id)}
                          >
                            <Trash2 size={12} />
                          </button>
                        )
                      ) : null}
                    </div>
                  );
                })}
                {/* dashed add tile — the row's last item; opens the native
                    import picker (Tauri only). Matches the dashed add-row
                    pattern used by the account / game-path sections. */}
                {isNative() ? (
                  <button
                    type="button"
                    class={["settings-modal__wallpaper-add", appearance.importingWallpaper.value ? "settings-modal__wallpaper-add--busy" : ""]}
                    disabled={appearance.importingWallpaper.value}
                    aria-label={t("settings.wallpaperImport")}
                    onClick={() => void appearance.importWallpaper()}
                  >
                    <span class="settings-modal__wallpaper-add-frame">
                      <ImagePlus size={16} />
                    </span>
                    <span class="settings-modal__wallpaper-add-label">{t("settings.wallpaperImport")}</span>
                  </button>
                ) : null}
                </div>
              </HkScrollContainer>
              {/* Overlay strength over image wallpapers — the transparency
                  dial (wallpaperOverlay.ts); meaningless for solid, which
                  never draws a scrim, so it only renders while an image is
                  active. Applies live for instant preview. */}
              {wallpaper.isImage.value ? (
                <div class="settings-modal__dpi-row">
                  <span class="settings-modal__overlay-label">
                    {t("settings.wallpaperOverlay")}
                  </span>
                  <HkSlider
                    class="settings-modal__dpi-slider"
                    min={0}
                    max={100}
                    step={5}
                    modelValue={wallpaper.overlayPercent.value}
                    onUpdate:modelValue={wallpaper.setOverlayPercent}
                    ariaLabel={t("settings.wallpaperOverlay")}
                    formatValue={(v: number) => `${v}%`}
                  />
                  <span class="settings-modal__dpi-value">
                    {wallpaper.overlayPercent.value}%
                  </span>
                </div>
              ) : null}
              {/* Background blur — how strongly the wallpaper is diffused
                  behind each shell region, set SEPARATELY for the sidebar
                  rail and the main content column (wallpaperBlur.ts,
                  0–8px, 0 the default). Same image-wallpaper gate as the
                  overlay dial: a solid background has nothing to blur.
                  Applies live for instant preview. */}
              {wallpaper.isImage.value ? (
                <>
                  <div class="settings-modal__dpi-row">
                    <span class="settings-modal__overlay-label">
                      {t("settings.wallpaperBlurSidebar")}
                    </span>
                    <HkSlider
                      class="settings-modal__dpi-slider"
                      min={WALLPAPER_BLUR_MIN}
                      max={WALLPAPER_BLUR_MAX}
                      step={1}
                      modelValue={wallpaper.sidebarBlurPx.value}
                      onUpdate:modelValue={wallpaper.setSidebarBlurPx}
                      ariaLabel={t("settings.wallpaperBlurSidebar")}
                      formatValue={(v: number) => `${v}px`}
                    />
                    <span class="settings-modal__dpi-value">
                      {wallpaper.sidebarBlurPx.value}px
                    </span>
                  </div>
                  <div class="settings-modal__dpi-row">
                    <span class="settings-modal__overlay-label">
                      {t("settings.wallpaperBlurMain")}
                    </span>
                    <HkSlider
                      class="settings-modal__dpi-slider"
                      min={WALLPAPER_BLUR_MIN}
                      max={WALLPAPER_BLUR_MAX}
                      step={1}
                      modelValue={wallpaper.mainBlurPx.value}
                      onUpdate:modelValue={wallpaper.setMainBlurPx}
                      ariaLabel={t("settings.wallpaperBlurMain")}
                      formatValue={(v: number) => `${v}px`}
                    />
                    <span class="settings-modal__dpi-value">
                      {wallpaper.mainBlurPx.value}px
                    </span>
                  </div>
                </>
              ) : null}
              <HkSettingsHint>{t("settings.wallpaperHint")}</HkSettingsHint>
            </HkSettingsSub>

            <HkDivider />

            {/* UI surface opacity — the chrome-side twin of the wallpaper
                overlay dial above: one solidity dial over every
                translucent surface in the app (theme/uiOpacityPreference).
                100% is the default (every glass surface fully opaque);
                lower it to bring hikari's glass back, down to 0% = the
                surfaces' own glass floor. Applies live — the settings
                window itself responds while dragging. */}
            <HkSettingsSub title={t("settings.uiOpacity")}>
              <div class="settings-modal__dpi-row">
                <HkSlider
                  class="settings-modal__dpi-slider"
                  min={UI_OPACITY_MIN}
                  max={UI_OPACITY_MAX}
                  step={5}
                  modelValue={uiOpacityPercent.value}
                  onUpdate:modelValue={setUiOpacityPercent}
                  ariaLabel={t("settings.uiOpacity")}
                  formatValue={(v: number) => `${v}%`}
                />
                <span class="settings-modal__dpi-value">
                  {uiOpacityPercent.value}%
                </span>
              </div>
              <HkSettingsHint>{t("settings.uiOpacityHint")}</HkSettingsHint>
            </HkSettingsSub>

            <HkDivider />

            {/* font size — global --text-* token scaling (see
                theme/fontScalePreference): the whole UI rescales except the
                title bar and the sidebar's app title, which are pinned. */}
            <HkSettingsSub title={t("settings.fontSize")}>
              <FontSizeControl ns="settings" />
              <HkSettingsHint>{t("settings.fontSizeHint")}</HkSettingsHint>
            </HkSettingsSub>

            <HkDivider />

            {/* interface scale (DPI) — root CSS `zoom` over everything (see
                theme/dpiPrefs): dragging stages a notch, Apply previews it
                under the app-level countdown; the confirm dialog lives at
                the bottom of SettingsBody as a sibling modal. The risk
                warning flags scales that squeeze the viewport under the
                usable layout-width floor. */}
            <HkSettingsSub title={t("settings.dpiTitle")}>
              <div class="settings-modal__dpi-row">
                <HkSlider
                  class="settings-modal__dpi-slider"
                  min={DPI_MIN}
                  max={DPI_MAX}
                  step={DPI_STEP}
                  showTicks
                  modelValue={staged ?? DPI_MIN}
                  onUpdate:modelValue={dpi.onDpiScaleChange}
                  ariaLabel={t("settings.dpiTitle")}
                  formatValue={(v: number) => `${v}%`}
                />
                <span class="settings-modal__dpi-value">
                  {staged == null ? t("settings.dpiAuto") : `${staged}%`}
                </span>
              </div>
              {warningVisible ? (
                <p class="settings-modal__dpi-warning">
                  {t("settings.dpiRiskyWarning", { scale: pending })}
                </p>
              ) : null}
              <div class="settings-modal__dpi-actions">
                <HkButton
                  variant="secondary"
                  size="sm"
                  disabled={dpi.dpiAuto.value}
                  onClick={dpi.onDpiAuto}
                >
                  {t("settings.dpiAuto")}
                </HkButton>
                {dpi.pendingDpi.value != null ? (
                  <HkButton variant="primary" size="sm" onClick={dpi.onDpiApply}>
                    {t("settings.dpiApply")}
                  </HkButton>
                ) : null}
              </div>
              <HkSettingsHint>{t("settings.dpiHint")}</HkSettingsHint>
              {/* The guaranteed way back, readable even at a scale that
                  breaks the modal itself: the keyboard hatch works anywhere
                  (capture-phase, dpiPrefs), so the reset never depends on
                  this UI being reachable. */}
              <HkSettingsHint>{t("settings.dpiResetHint")}</HkSettingsHint>
            </HkSettingsSub>

            <HkDivider />

            {/* Solar-location strategy — hikari's OWN shared row
                (HkSolarLocationSetting, the generic business part every
                celestia host drops at the bottom of its settings page):
                summary + edit button, and the second-level editor picks
                时区 (default, offline) / IP (the real-fix cascade) / 手动
                (a translated 24-sector globe — HkTimeZoneGlobe, async-loaded
                only when the manual pane opens — plus hemisphere). The
                engine, storage and last-write-wins refreshes all live in
                hikari; the readout underneath stays ours — what the
                resolved strategy currently paints. */}
            <HkSettingsSub title={t("settings.geolocation")}>
              <HkSolarLocationSetting onApplied={() => notifySettingsSaved()} />
              <p class="settings-modal__geoline">
                <span>
                  {t("settings.currentPeriod")}: <strong>{appearance.periodLabel(period.value)}</strong>
                </span>
                {geo.value ? (
                  <span class="settings-modal__geo-coords">
                    {geo.value.lat.toFixed(2)}°, {geo.value.lng.toFixed(2)}°
                  </span>
                ) : null}
              </p>
              <HkSettingsHint>{t("settings.geolocationHint")}</HkSettingsHint>
            </HkSettingsSub>

            {/* The scheme editor window — hosted at the appearance section's
                root so any scheme row (and the new-scheme row) can raise it.
                HkModal teleports to the overlay layer; placement in the tree
                only decides that it lives and dies with this section. */}
            <ThemeSchemeDialog
              modelValue={appearance.schemeDialogOpen.value}
              onUpdate:modelValue={(v: boolean) => (appearance.schemeDialogOpen.value = v)}
              schemeId={appearance.editSchemeId.value}
            />
          </HkSettingsGroup>

          </>
      );
    };
  },
});
