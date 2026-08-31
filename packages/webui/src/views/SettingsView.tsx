import { defineComponent, onMounted, ref } from "vue";
import { Sun, Moon, Monitor } from "lucide-vue-next";

import { HButton, HInput, HSelect, HTabs, getThemeTokens, getGeolocation, getTimePeriod, themePresets, useTheme } from "@celestia-island/hikari";

import { useWallpaper } from "@/theme/useWallpaper";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { api, type NetworkConfig } from "@/api";
import AboutModal from "@/components/layout/AboutModal";
import "./SettingsView.scss";

/** Hikari token → CSS rgb() color. */
function css(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

/**
 * Settings page: language, theme mode + color preset (hikari theme system),
 * wallpaper, geolocation info, network proxy, and About. The solar period
 * indicator shows the current sun-based classification so users understand
 * what "Auto (sun)" does.
 */
export default defineComponent({
  name: "SettingsView",
  setup() {
    const theme = useTheme();
    const wallpaper = useWallpaper();
    const lang = useLanguage();
    const showAbout = ref(false);

    // Brand default first, then hikari's built-ins (incl. the shared
    // nord/gruvbox/tokyonight presets and any user custom themes).
    const presetIds = Object.keys(themePresets).sort((a, b) =>
      a === "ocean" ? -1 : b === "ocean" ? 1 : 0,
    );

    // ── Solar clock indicator (informational) ──────────────────────────────
    const geo = ref<{ lat: number; lng: number } | null>(null);
    const period = ref<string>("night");
    onMounted(async () => {
      try {
        const g = await getGeolocation();
        geo.value = g;
        period.value = getTimePeriod(g.lat, g.lng);
      } catch {
        // Indicator only — leave defaults.
      }
    });

    function periodLabel(p: string): string {
      if (p === "day") return t("settings.periodDay");
      if (p === "dusk") return t("settings.periodDusk");
      return t("settings.periodNight");
    }

    // ── Network proxy (global for all outbound requests) ──────────────────
    const netCfg = ref<NetworkConfig>({ mode: "system", proxy: null });
    onMounted(async () => {
      try {
        netCfg.value = await api.getNetworkConfig();
      } catch {
        // mock backend / older shell without the command — keep defaults
      }
    });
    async function selectNetMode(mode: NetworkConfig["mode"]) {
      netCfg.value.mode = mode;
      await saveNet();
    }
    async function saveNet() {
      try {
        await api.setNetworkConfig({
          mode: netCfg.value.mode,
          proxy: netCfg.value.proxy?.trim() || null,
        });
      } catch {
        // best-effort — the desktop shell persists it; mock has no backend
      }
    }

    return () => (
      <div class="settings-view">
        <h1 class="settings-view__title">{t("settings.title")}</h1>

        {/* language — two independent dropdowns: UI (app interface) vs data
            (game-asset names: ships/captains/maps). The same language can have
            different official translations across regions, e.g. 国服 simplified
            (animal names for IJN) vs 亚服 Chinese. */ }
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.language")}</h2>
          <div class="settings-view__langs">
            <div class="settings-view__lang">
              <span class="settings-view__lang-label">{t("settings.uiLanguage")}</span>
              <HSelect
                modelValue={lang.uiLocale.value}
                onUpdate:modelValue={(v: string) => lang.setUiLocale(v as "en-US" | "zh-CN")}
                options={lang.uiLocaleOptions.map((o) => ({ value: o.value, label: o.label }))}
              />
            </div>
            <div class="settings-view__lang">
              <span class="settings-view__lang-label">{t("settings.dataLanguage")}</span>
              <HSelect
                modelValue={lang.dataLanguage.value}
                onUpdate:modelValue={(v: string) => lang.setDataLanguage(v)}
                options={lang.wgLanguageOptions.map((o) => ({ value: o.value, label: o.label }))}
              />
            </div>
          </div>
          <p class="settings-view__hint">{t("settings.dataLanguageHint")}</p>
        </section>

        {/* appearance — mode switcher as a segmented button group */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.themeMode")}</h2>
          <HTabs
            variant="segmented"
            modelValue={theme.currentMode.value}
            onUpdate:modelValue={(v: string) => theme.setMode(v as "system" | "dark" | "light")}
            tabs={[
              { key: "system", label: t("settings.themeModeSystem"), icon: <Monitor size={14} /> },
              { key: "dark", label: t("settings.themeModeDark"), icon: <Moon size={14} /> },
              { key: "light", label: t("settings.themeModeLight"), icon: <Sun size={14} /> },
            ]}
          />

          {/* color preset */}
          <h2 class="settings-view__section-title">{t("settings.themePreset")}</h2>
          <div class="settings-view__presets">
            {presetIds.map((id) => {
              // Use the effective mode so light-mode users see a light preview.
              const tokens = getThemeTokens(id, theme.effectiveMode.value);
              if (!tokens) return null;
              return (
                <button
                  class={[
                    "settings-view__preset",
                    theme.currentTheme.value === id ? "settings-view__preset--on" : "",
                  ]}
                  onClick={() => theme.setTheme(id)}
                  style={{
                    background: css(tokens.background),
                    color: css(tokens.text),
                    borderColor:
                      theme.currentTheme.value === id ? css(tokens.primary) : "transparent",
                  }}
                >
                  <span class="settings-view__preset-swatch" style={{ background: css(tokens.primary) }} />
                  <span class="settings-view__preset-swatch" style={{ background: css(tokens.accent) }} />
                  <span class="settings-view__preset-swatch" style={{ background: css(tokens.success) }} />
                  <span class="settings-view__preset-name">{themePresets[id].name}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* wallpaper / background */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.wallpaper")}</h2>
          <div class="settings-view__wallpapers">
            {wallpaper.allWallpapers.value.map((w) => (
              <button
                class={[
                  "settings-view__wallpaper",
                  wallpaper.activeWallpaperId.value === w.id ? "settings-view__wallpaper--on" : "",
                ]}
                onClick={() => wallpaper.setActiveWallpaper(w.id)}
              >
                <span class="settings-view__wallpaper-preview">
                  {w.source.type === "solid" ? (
                    <span
                      class="settings-view__wallpaper-swatch"
                      style={{
                        background:
                          w.source.color === "black"
                            ? "#0b1220"
                            : w.source.color === "white"
                              ? "#f8fafc"
                              : "linear-gradient(135deg, #0b1220 50%, #f8fafc 50%)",
                      }}
                    />
                  ) : (
                    <span
                      class="settings-view__wallpaper-swatch settings-view__wallpaper-swatch--image"
                      style={{ backgroundImage: `url(${w.source.url})` }}
                    />
                  )}
                </span>
                <span class="settings-view__wallpaper-name">{w.name}</span>
              </button>
            ))}
          </div>
        </section>

        {/* geolocation + solar period */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.geolocation")}</h2>
          <p class="settings-view__hint">{t("settings.geolocationHint")}</p>
          <div class="settings-view__geo">
            {geo.value ? (
              <span>
                {geo.value.lat.toFixed(2)}°, {geo.value.lng.toFixed(2)}°
              </span>
            ) : (
              <span>—</span>
            )}
            <span class="settings-view__period">
              {t("settings.currentPeriod")}: <strong>{periodLabel(period.value)}</strong>
            </span>
          </div>
        </section>

        {/* network proxy — applies to every outbound request (stats, model
            pack, updates); mode switcher as a segmented button group */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.network")}</h2>
          <p class="settings-view__hint">{t("settings.networkHint")}</p>
          <HTabs
            variant="segmented"
            modelValue={netCfg.value.mode}
            onUpdate:modelValue={(v: string) => void selectNetMode(v as NetworkConfig["mode"])}
            tabs={[
              { key: "system", label: t("settings.networkSystem") },
              { key: "none", label: t("settings.networkNone") },
              { key: "manual", label: t("settings.networkManual") },
            ]}
          />
          {netCfg.value.mode === "manual" ? (
            <div class="settings-view__netmanual">
              <HInput
                modelValue={netCfg.value.proxy ?? ""}
                onUpdate:modelValue={(v: string) => (netCfg.value.proxy = v)}
                placeholder={t("settings.networkProxyPlaceholder")}
              />
              <HButton size="sm" onClick={() => void saveNet()}>
                {t("settings.networkSave")}
              </HButton>
            </div>
          ) : null}
        </section>

        {/* about */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.about")}</h2>
          <HButton variant="secondary" onClick={() => (showAbout.value = true)}>
            WoWSP — World of WarShip Panel
          </HButton>
        </section>

        <AboutModal
          modelValue={showAbout.value}
          onUpdate:modelValue={(v: boolean) => (showAbout.value = v)}
        />
      </div>
    );
  },
});
