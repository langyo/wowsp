import { defineComponent, ref } from "vue";

import { useTheme } from "@/theme/useTheme";
import { themePresets, type ThemeMode } from "@/theme/presets";
import { t } from "@/i18n";
import AboutModal from "@/components/layout/AboutModal";
import "./SettingsView.scss";

/**
 * Settings page: theme mode (system/dark/light), color preset, geolocation
 * info, and an About button. The solar period indicator shows the current
 * sun-based classification so users understand what "Auto (sun)" does.
 */
export default defineComponent({
  name: "SettingsView",
  setup() {
    const theme = useTheme();
    const showAbout = ref(false);

    const modes: { value: ThemeMode; labelKey: string; icon: string }[] = [
      { value: "system", labelKey: "settings.themeModeSystem", icon: "☀" },
      { value: "dark", labelKey: "settings.themeModeDark", icon: "🌙" },
      { value: "light", labelKey: "settings.themeModeLight", icon: "☀️" },
    ];

    const presets = Object.values(themePresets);

    function periodLabel(period: string): string {
      if (period === "day") return t("settings.periodDay");
      if (period === "dusk") return t("settings.periodDusk");
      return t("settings.periodNight");
    }

    return () => (
      <div class="settings-view">
        <h1 class="settings-view__title">{t("settings.title")}</h1>

        {/* appearance */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.themeMode")}</h2>
          <div class="settings-view__modes">
            {modes.map((m) => (
              <button
                class={[
                  "settings-view__mode",
                  theme.mode.value === m.value ? "settings-view__mode--on" : "",
                ]}
                onClick={() => theme.setMode(m.value)}
              >
                <span class="settings-view__mode-icon">{m.icon}</span>
                <span>{t(m.labelKey)}</span>
              </button>
            ))}
          </div>
        </section>

        {/* color preset */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.themePreset")}</h2>
          <div class="settings-view__presets">
            {presets.map((p) => {
              // Use the effective mode so light-mode users see a light preview.
              const tokens = p[theme.effectiveMode.value];
              return (
                <button
                  class={[
                    "settings-view__preset",
                    theme.preset.value === p.id ? "settings-view__preset--on" : "",
                  ]}
                  onClick={() => theme.setPreset(p.id)}
                  style={{
                    background: `rgb(${tokens.background})`,
                    color: `rgb(${tokens.text})`,
                    borderColor:
                      theme.preset.value === p.id ? `rgb(${tokens.primary})` : "transparent",
                  }}
                >
                  <span
                    class="settings-view__preset-swatch"
                    style={{ background: `rgb(${tokens.primary})` }}
                  />
                  <span
                    class="settings-view__preset-swatch"
                    style={{ background: `rgb(${tokens.accent})` }}
                  />
                  <span
                    class="settings-view__preset-swatch"
                    style={{ background: `rgb(${tokens.success})` }}
                  />
                  <span class="settings-view__preset-name">{p.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* geolocation + solar period */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.geolocation")}</h2>
          <p class="settings-view__hint">{t("settings.geolocationHint")}</p>
          <div class="settings-view__geo">
            {theme.geo.value ? (
              <span>
                {theme.geo.value.lat.toFixed(2)}°, {theme.geo.value.lng.toFixed(2)}°
              </span>
            ) : (
              <span>—</span>
            )}
            <span class="settings-view__period">
              {t("settings.currentPeriod")}: <strong>{periodLabel(theme.period.value)}</strong>
            </span>
          </div>
        </section>

        {/* about */}
        <section class="settings-view__section">
          <h2 class="settings-view__section-title">{t("settings.about")}</h2>
          <button class="settings-view__about-btn" onClick={() => (showAbout.value = true)}>
            WoWSP — World of WarShip Panel
          </button>
        </section>

        <AboutModal
          modelValue={showAbout.value}
          onUpdate:modelValue={(v: boolean) => (showAbout.value = v)}
        />
      </div>
    );
  },
});
