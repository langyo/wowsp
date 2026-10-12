/** Appearance settings section: theme mode/scheme picker, wallpapers,
 *  opacity, font size, the staged DPI slider and the solar indicator. */
import { defineComponent, type PropType } from "vue";
import { Check, ImagePlus, Moon, Palette, SquarePen, Sun, SunMoon, Trash2 } from "@lucide/vue";
import {
  HkButton,
  HkDivider,
  HkIconButton,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkSlider,
  HkTabs,
  useTheme,
} from "@celestia-island/hikari";

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
  setThemeModePreference,
  themeModePreference,
  type ThemeModePreference,
} from "@/theme/themeModePreference";
import { DPI_MAX, DPI_MIN, DPI_STEP, isDpiRisky } from "@/theme/dpiPrefs";
import { t } from "@/i18n";
import { isTauri } from "@/utils/platform";
import FontSizeControl from "@/components/layout/FontSizeControl";
import ThemeSchemeDialog from "@/components/settings/ThemeSchemeDialog";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

/** Hikari token → CSS rgb() color. */
function css(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

export default defineComponent({
  name: "SettingsAppearanceSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const theme = useTheme();
    const wallpaper = useWallpaper();
    const { appearance, dpi } = props.ctx;
    return () => {
      // Staged-or-persisted notch for the DPI slider/readout (null = Auto)
      // and its risk flag — same locals as the reference DpiControl window.
      const pending = dpi.pendingDpi.value;
      const staged = pending ?? dpi.dpiScale.value;
      const warningVisible = pending != null && isDpiRisky(pending, window.innerWidth);
      const { geo, period } = theme;
      return (
          <>
          {/* appearance — mode, color preset, wallpaper, solar indicator */}
          <HkSettingsGroup title={t("settings.themeMode")}>
            {/* Three-way mode preference (wowsp's own key — see
                theme/themeModePreference): dark/light verbatim, solar =
                daylight-following (hikari "system"). The retired OS-follower
                mode migrates onto solar. Selection applies immediately. */}
            <HkTabs
              block
              variant="segmented"
              modelValue={themeModePreference.value}
              onUpdate:modelValue={(v: string) =>
                setThemeModePreference(v as ThemeModePreference)
              }
              tabs={[
                { key: "dark", label: t("settings.themeModeDark"), icon: <Moon size={14} /> },
                { key: "light", label: t("settings.themeModeLight"), icon: <Sun size={14} /> },
                { key: "solar", label: t("settings.themeModeSolar"), icon: <SunMoon size={14} /> },
              ]}
            />

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
                        onClick={() => theme.setTheme(th.id)}
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
              <div class="settings-modal__wallpapers" ref={appearance.wallpaperRow}>
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
                            title={t("settings.wallpaperDelete")}
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
                {isTauri() ? (
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
                overlay dial above: one multiplier over every translucent
                surface in the app (theme/uiOpacityPreference). 95% is the
                default (a hair clearer than fully solid); below it the
                glass clears further, above it panels solidify over busy
                ones (alpha caps at fully opaque). Applies live — the
                settings window itself responds while dragging. */}
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

            {/* solar status — what "Auto (sun)" currently resolves to */}
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
