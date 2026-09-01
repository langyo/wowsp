import { computed, defineComponent, onMounted, ref } from "vue";
import { Check, Monitor, Moon, Sun } from "lucide-vue-next";

import { HButton, HInput, HModal, HSelect, HTabs, getThemeTokens, themePresets, useTheme } from "@celestia-island/hikari";

import { useWallpaper } from "@/theme/useWallpaper";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { api, type NetworkConfig } from "@/api";
import AboutModal from "@/components/layout/AboutModal";
import "./SettingsModal.scss";

/** Hikari token → CSS rgb() color. */
function css(rgb: { r: number; g: number; b: number }): string {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
}

/**
 * Settings modal (opened from the sidebar gear): language, appearance
 * (theme mode + color preset + wallpaper + solar indicator), network proxy,
 * and About. Sections live in titled cards stacked in the scrolling modal
 * body; every control rows up with its card so nothing floats mid-air.
 *
 * The solar line under Appearance shows the current sun-based classification
 * so users understand what "Auto (sun)" does.
 */
export default defineComponent({
  name: "SettingsModal",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
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
    // Shares the theme clock's resolution — no extra geo lookup here.
    const { geo, period } = theme;

    function periodLabel(p: string): string {
      if (p === "day") return t("settings.periodDay");
      if (p === "dusk") return t("settings.periodDusk");
      return t("settings.periodNight");
    }

    // ── Network proxy (global for all outbound requests) ──────────────────
    // Mode changes apply immediately; the URL row commits via 保存 / Enter.
    // `netLastSaved` mirrors what the backend holds so the save button only
    // lights up on a real change, and the saved URL stays visible (greyed
    // out) even while system/none mode is active.
    const netCfg = ref<NetworkConfig>({ mode: "system", proxy: null });
    const netLastSaved = ref<NetworkConfig>({ mode: "system", proxy: null });
    const netSavedFlash = ref(false);
    let netFlashTimer: number | undefined;

    const netDirty = computed(() => {
      const cur = netCfg.value;
      const last = netLastSaved.value;
      return cur.mode !== last.mode || (cur.proxy?.trim() || null) !== last.proxy;
    });

    onMounted(async () => {
      try {
        const cfg = await api.getNetworkConfig();
        netCfg.value = { ...cfg };
        netLastSaved.value = { ...cfg };
      } catch {
        // mock backend / older shell without the command — keep defaults
      }
    });

    async function selectNetMode(mode: NetworkConfig["mode"]) {
      if (netCfg.value.mode === mode) return;
      netCfg.value.mode = mode;
      await saveNet();
    }

    async function saveNet() {
      const payload: NetworkConfig = {
        mode: netCfg.value.mode,
        proxy: netCfg.value.proxy?.trim() || null,
      };
      try {
        await api.setNetworkConfig(payload);
        netCfg.value = { ...payload };
        netLastSaved.value = { ...payload };
        netSavedFlash.value = true;
        window.clearTimeout(netFlashTimer);
        netFlashTimer = window.setTimeout(() => (netSavedFlash.value = false), 1600);
      } catch {
        // best-effort — the desktop shell persists it; mock has no backend
      }
    }

    return () => (
      <HModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("settings.title")}
        width="40rem"
      >
        <div class="settings-modal">
          {/* language — two independent dropdowns: UI (app interface) vs data
              (game-asset names: ships/captains/maps). The same language can have
              different official translations across regions, e.g. 国服 simplified
              (animal names for IJN) vs 亚服 Chinese. */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.language")}</h2>
            <div class="settings-modal__langs">
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">{t("settings.uiLanguage")}</span>
                <HSelect
                  modelValue={lang.uiLocale.value}
                  onUpdate:modelValue={(v: string) => lang.setUiLocale(v as "en-US" | "zh-CN")}
                  options={lang.uiLocaleOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div class="settings-modal__lang">
                <span class="settings-modal__lang-label">{t("settings.dataLanguage")}</span>
                <HSelect
                  modelValue={lang.dataLanguage.value}
                  onUpdate:modelValue={(v: string) => lang.setDataLanguage(v)}
                  options={lang.wgLanguageOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>
            <p class="settings-modal__hint">{t("settings.dataLanguageHint")}</p>
          </section>

          {/* appearance — mode, color preset, wallpaper, solar indicator */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.themeMode")}</h2>
            <HTabs
              block
              variant="segmented"
              modelValue={theme.currentMode.value}
              onUpdate:modelValue={(v: string) => theme.setMode(v as "system" | "dark" | "light")}
              tabs={[
                { key: "system", label: t("settings.themeModeSystem"), icon: <Monitor size={14} /> },
                { key: "dark", label: t("settings.themeModeDark"), icon: <Moon size={14} /> },
                { key: "light", label: t("settings.themeModeLight"), icon: <Sun size={14} /> },
              ]}
            />

            {/* color preset — uniform card chrome; the theme only peeks
                through the preview chip so the row reads as one control */}
            <div class="settings-modal__sub">
              <h3 class="settings-modal__sub-title">{t("settings.themePreset")}</h3>
              <div class="settings-modal__presets">
                {presetIds.map((id) => {
                  // Use the effective mode so light-mode users see a light preview.
                  const tokens = getThemeTokens(id, theme.effectiveMode.value);
                  if (!tokens) return null;
                  const on = theme.currentTheme.value === id;
                  return (
                    <button
                      type="button"
                      aria-pressed={on}
                      class={["settings-modal__preset", on ? "settings-modal__preset--on" : ""]}
                      onClick={() => theme.setTheme(id)}
                    >
                      <span class="settings-modal__preset-preview" style={{ background: css(tokens.background) }}>
                        <span class="settings-modal__preset-dot" style={{ background: css(tokens.primary) }} />
                        <span class="settings-modal__preset-dot" style={{ background: css(tokens.accent) }} />
                        <span class="settings-modal__preset-dot" style={{ background: css(tokens.success) }} />
                      </span>
                      <span class="settings-modal__preset-name">{themePresets[id].name}</span>
                      {on ? <Check size={14} class="settings-modal__preset-check" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* wallpaper / background */}
            <div class="settings-modal__sub">
              <h3 class="settings-modal__sub-title">{t("settings.wallpaper")}</h3>
              <div class="settings-modal__wallpapers">
                {wallpaper.allWallpapers.value.map((w) => {
                  const on = wallpaper.activeWallpaperId.value === w.id;
                  return (
                    <button
                      type="button"
                      aria-pressed={on}
                      class={["settings-modal__wallpaper", on ? "settings-modal__wallpaper--on" : ""]}
                      onClick={() => wallpaper.setActiveWallpaper(w.id)}
                    >
                      <span class="settings-modal__wallpaper-preview">
                        {w.source.type === "solid" ? (
                          <span
                            class="settings-modal__wallpaper-swatch"
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
                            class="settings-modal__wallpaper-swatch settings-modal__wallpaper-swatch--image"
                            style={{ backgroundImage: `url(${w.source.url})` }}
                          />
                        )}
                      </span>
                      <span class="settings-modal__wallpaper-name">{w.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* solar status — what "Auto (sun)" currently resolves to */}
            <p class="settings-modal__geoline">
              <span>
                {t("settings.currentPeriod")}: <strong>{periodLabel(period.value)}</strong>
              </span>
              {geo.value ? (
                <span class="settings-modal__geo-coords">
                  {geo.value.lat.toFixed(2)}°, {geo.value.lng.toFixed(2)}°
                </span>
              ) : null}
            </p>
            <p class="settings-modal__hint">{t("settings.geolocationHint")}</p>
          </section>

          {/* network proxy — applies to every outbound request (stats, model
              pack, updates) */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.network")}</h2>
            <p class="settings-modal__hint">{t("settings.networkHint")}</p>
            <HTabs
              block
              variant="segmented"
              modelValue={netCfg.value.mode}
              onUpdate:modelValue={(v: string) => void selectNetMode(v as NetworkConfig["mode"])}
              tabs={[
                { key: "system", label: t("settings.networkSystem") },
                { key: "none", label: t("settings.networkNone") },
                { key: "manual", label: t("settings.networkManual") },
              ]}
            />
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HInput
                  modelValue={netCfg.value.proxy ?? ""}
                  onUpdate:modelValue={(v: string) => (netCfg.value.proxy = v)}
                  placeholder={t("settings.networkProxyPlaceholder")}
                  disabled={netCfg.value.mode !== "manual"}
                  submitOnEnter={() => void saveNet()}
                />
              </div>
              <HButton size="sm" disabled={!netDirty.value} onClick={() => void saveNet()}>
                {netSavedFlash.value ? t("settings.networkSaved") : t("settings.networkSave")}
              </HButton>
            </div>
          </section>

          {/* about */}
          <section class="settings-modal__group">
            <h2 class="settings-modal__group-title">{t("settings.about")}</h2>
            <div class="settings-modal__about">
              <HButton variant="secondary" onClick={() => (showAbout.value = true)}>
                WoWSP — World of WarShip Panel
              </HButton>
            </div>
          </section>
        </div>

        <AboutModal
          modelValue={showAbout.value}
          onUpdate:modelValue={(v: boolean) => (showAbout.value = v)}
        />
      </HModal>
    );
  },
});
