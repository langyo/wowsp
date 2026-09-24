import { computed, defineComponent, onBeforeUnmount, ref, watch } from "vue";

import { HButton, HModal, HStepFlow, useToast, getThemeTokens, themePresets, useTheme } from "@celestia-island/hikari";
import { Check, ImagePlus, Moon, Sun, SunMoon } from "@lucide/vue";

import { t } from "@/i18n";
import { themePresetIds } from "@/theme";
import {
  setThemeModePreference,
  themeModePreference,
  type ThemeModePreference,
} from "@/theme/themeModePreference";
import { useWallpaper } from "@/theme/useWallpaper";
import { isTauri } from "@/transport";
import { useStatsPrefsStore, STATS_PREFS_STORAGE_KEY } from "@/stores/statsPrefs";
import AnnouncementContent from "./AnnouncementContent";
import FontSizeControl from "@/components/layout/FontSizeControl";
import StatsPrefsControls from "@/components/stats/StatsPrefsControls";
import "./OnboardingWizard.scss";

/** Completion marker — its absence (first launch AND pre-wizard installs)
 *  re-runs the wizard so existing users pick up the new preference system. */
const COMPLETED_KEY = "wowsp-onboarding-completed";
/** Legacy notice ack, written alongside for version downgrades (an older
 *  build without the wizard would otherwise re-show the forced dialog). */
const LEGACY_ACK_KEY = "wowsp-oss-notice-acked";
/** Blind-click guard on the notice step, carried over from the old forced
 *  AnnouncementDialog unchanged. */
const ACK_COUNTDOWN_SECONDS = 5;

const STEP_KEYS = ["welcome", "preferences", "appearance"] as const;
type StepKey = (typeof STEP_KEYS)[number];

/** Appearance-step theme cards — click applies the preference immediately
 *  (live preview through the translucent overlay). The OS-follower option is
 *  gone: solar already covers "not always dark, not always light". */
const THEME_OPTIONS: {
  key: ThemeModePreference;
  labelKey: string;
  icon: typeof Moon;
}[] = [
  { key: "dark", labelKey: "onboarding.themeDark", icon: Moon },
  { key: "light", labelKey: "onboarding.themeLight", icon: Sun },
  { key: "solar", labelKey: "onboarding.themeSolar", icon: SunMoon },
];

/**
 * First-launch setup wizard (three steps: notice ack → water-table prefs →
 * appearance with theme + wallpaper merged), replacing the old forced
 * AnnouncementDialog — the notice content is now the wizard's first step
 * with the same 5-second blind-click guard on its confirm button.
 *
 * Rides the shared HModal window shell (surface-machine open/close motion,
 * delayed unmount, content hold) so the wizard folds in and out like every
 * other window in the app instead of snapping. Non-closable and without a
 * back guard: the only way forward is finishing it. The scrim stays light
 * (see OnboardingWizard.scss) so the appearance choices preview live
 * through it, and every choice applies immediately — re-changeable later
 * in Settings.
 */
export default defineComponent({
  name: "OnboardingWizard",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    const step = ref<StepKey>("welcome");
    const countdown = ref(ACK_COUNTDOWN_SECONDS);
    let timer: number | undefined;
    const theme = useTheme();
    const wallpaper = useWallpaper();
    const toast = useToast();
    const prefs = useStatsPrefsStore();
    const importing = ref(false);

    const steps = computed(() => [
      { key: "welcome", label: t("onboarding.stepWelcome") },
      { key: "preferences", label: t("onboarding.stepPreferences") },
      { key: "appearance", label: t("onboarding.stepAppearance") },
    ]);

    // First-run default: the preferences step presents the PR rating as ON —
    // users who leave it untouched keep the enabled state; flipping the
    // switch off here persists OFF like any explicit choice. Gated on the
    // wizard actually running this session: users who already completed the
    // old (pre-stats-prefs) wizard must NOT get the rating silently flipped
    // on at boot, and users with stored prefs keep their earlier decisions.
    try {
      if (localStorage.getItem(COMPLETED_KEY) == null && localStorage.getItem(STATS_PREFS_STORAGE_KEY) == null) {
        prefs.setPrEnabled(true);
      }
    } catch {
      // storage unavailable — skip the default, the switch stays as stored
    }

    function startCountdown() {
      countdown.value = ACK_COUNTDOWN_SECONDS;
      timer = window.setInterval(() => {
        countdown.value -= 1;
        if (countdown.value <= 0) {
          window.clearInterval(timer);
          timer = undefined;
          countdown.value = 0;
        }
      }, 1000);
    }

    // The welcome step is where the wizard opens, so the blind-click
    // countdown runs from the moment the wizard becomes visible (the
    // component itself stays mounted at the shell level — gate on the
    // model value, not on component mount).
    watch(
      () => props.modelValue,
      (v) => {
        if (v && timer === undefined) startCountdown();
      },
      { immediate: true },
    );
    onBeforeUnmount(() => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    });

    function go(delta: number) {
      const i = STEP_KEYS.indexOf(step.value);
      const next = STEP_KEYS[Math.min(STEP_KEYS.length - 1, Math.max(0, i + delta))];
      step.value = next;
    }

    function finish() {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
      try {
        localStorage.setItem(COMPLETED_KEY, "1");
        localStorage.setItem(LEGACY_ACK_KEY, "1");
      } catch {
        // storage unavailable — wizard would re-show next launch, which is
        // the safe failure mode for an ack we could not persist
      }
      emit("update:modelValue", false);
    }

    /** Footer primary action: the welcome step's countdown-gated confirm,
     *  plain 下一步 mid-flow, 开始使用 at the end. */
    const isWelcome = computed(() => step.value === "welcome");
    const isLast = computed(() => step.value === "appearance");
    const primaryDisabled = computed(() => isWelcome.value && countdown.value > 0);
    const primaryLabel = computed(() => {
      if (isWelcome.value) {
        return countdown.value > 0
          ? t("onboarding.ackCountdown", { n: countdown.value })
          : t("onboarding.ack");
      }
      return isLast.value ? t("onboarding.start") : t("onboarding.next");
    });

    async function importWallpaper() {
      if (importing.value) return;
      importing.value = true;
      try {
        await wallpaper.importCustom();
      } catch (e) {
        toast.error(`${t("settings.wallpaperImportFailed")}\n${(e as Error).message || e}`);
      } finally {
        importing.value = false;
      }
    }

    // Card clusters are computed (not built once) so the selected-state
    // highlight tracks the live preference / wallpaper id through the
    // preview clicks.
    const themeCards = computed(() =>
      THEME_OPTIONS.map(({ key, labelKey, icon: Icon }) => (
        <button
          key={key}
          type="button"
          aria-pressed={themeModePreference.value === key}
          class={[
            "onboarding__option",
            themeModePreference.value === key ? "onboarding__option--on" : "",
          ]}
          onClick={() => setThemeModePreference(key)}
        >
          <span class="onboarding__option-icon">
            <Icon size={18} />
          </span>
          <span class="onboarding__option-label">{t(labelKey)}</span>
          {themeModePreference.value === key ? (
            <Check size={14} class="onboarding__option-check" />
          ) : null}
        </button>
      )),
    );

    // Color-preset cards (the settings appearance row, mirrored): swatch =
    // the preset's own background at the effective mode, click applies the
    // theme immediately for a live preview. The ids come from hikari's live
    // preset table (themePresetIds), so a retired-id whitelist cannot empty
    // the row.
    const presetCards = computed(() =>
      themePresetIds().map((id) => {
        const tokens = getThemeTokens(id, theme.effectiveMode.value);
        if (!tokens) return null;
        const on = theme.currentTheme.value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            class={["onboarding__option", on ? "onboarding__option--on" : ""]}
            onClick={() => theme.setTheme(id)}
          >
            <span class="onboarding__option-swatch">
              <span
                class="onboarding__option-swatch-fill"
                style={{ background: `rgb(${tokens.background.r} ${tokens.background.g} ${tokens.background.b})` }}
              />
            </span>
            <span class="onboarding__option-label">{themePresets[id].name}</span>
            {on ? <Check size={14} class="onboarding__option-check" /> : null}
          </button>
        );
      }),
    );

    const wallpaperCards = computed(() =>
      wallpaper.allWallpapers.value.map((w) => {
        const on = wallpaper.activeWallpaperId.value === w.id;
        return (
          <button
            key={w.id}
            type="button"
            aria-pressed={on}
            class={["onboarding__option", on ? "onboarding__option--on" : ""]}
            onClick={() => wallpaper.setActiveWallpaper(w.id)}
          >
            <span class="onboarding__option-swatch">
              {w.source.type === "solid" ? (
                // Solid mirrors the theme background — a live swatch.
                <span
                  class="onboarding__option-swatch-fill"
                  style={{ background: "rgb(var(--color-background))" }}
                />
              ) : (
                <span
                  class="onboarding__option-swatch-fill"
                  style={{ backgroundImage: `url(${w.source.url})` }}
                />
              )}
            </span>
            <span class="onboarding__option-label">
              {w.nameKey ? t(w.nameKey) : w.name}
            </span>
            {on ? <Check size={14} class="onboarding__option-check" /> : null}
          </button>
        );
      }),
    );

    return () => (
      <HModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("onboarding.title")}
        width="md"
        closable={false}
        backGuard={false}
        contentClass="onboarding-wizard"
        v-slots={{
          default: () => (
            <HStepFlow
              steps={steps.value}
              modelValue={step.value}
              onUpdate:modelValue={(v: string) => (step.value = v as StepKey)}
              v-slots={{
                welcome: () => (
                  <div class="onboarding__body onboarding__body--welcome">
                    {/* Scroll region of last resort: the notice block can
                        exceed very short viewports (same contract as the
                        retired AnnouncementDialog). */}
                    <div class="onboarding__announce">
                      <AnnouncementContent />
                    </div>
                  </div>
                ),
                preferences: () => (
                  <div class="onboarding__body">
                    <p class="onboarding__desc">{t("onboarding.preferencesDesc")}</p>
                    <StatsPrefsControls ns="onboarding" />
                  </div>
                ),
                appearance: () => (
                  <div class="onboarding__body">
                    <p class="onboarding__desc">{t("onboarding.appearanceDesc")}</p>

                    <div class="onboarding__options onboarding__options--three">
                      {themeCards.value}
                    </div>

                    {/* Color scheme — every preset hikari's live table
                        carries, in the shared display order (themePresetIds:
                        Synthwave '84 last), same cards as the settings
                        appearance row. */}
                    <h3 class="onboarding__subtitle">{t("settings.themePreset")}</h3>
                    <div class="onboarding__options onboarding__options--four">
                      {presetCards.value}
                    </div>

                    <h3 class="onboarding__subtitle">{t("onboarding.wallpaperSection")}</h3>
                    <div class="onboarding__options onboarding__options--three">
                      {wallpaperCards.value}
                      {isTauri() ? (
                        <button
                          key="import"
                          type="button"
                          class="onboarding__option"
                          disabled={importing.value}
                          onClick={() => void importWallpaper()}
                        >
                          <span class="onboarding__option-icon">
                            <ImagePlus size={18} />
                          </span>
                          <span class="onboarding__option-label">
                            {t("settings.wallpaperImport")}
                          </span>
                        </button>
                      ) : null}
                    </div>
                    <p class="onboarding__desc">{t("settings.wallpaperHint")}</p>

                    {/* Font size — the same five-way control as the settings
                        appearance section (FontSizeControl), writing the
                        shared fontScalePreference module. */}
                    <h3 class="onboarding__subtitle">{t("onboarding.fontSize")}</h3>
                    <FontSizeControl ns="onboarding" />
                  </div>
                ),
              }}
            />
          ),
          footer: () => (
            <>
              {/* Prev is hidden (not disabled) on the first step so the
                  welcome confirm reads as the only way forward. The
                  .hk-modal-footer strip supplies the nav chrome (border,
                  padding, right alignment) the old __nav block painted. */}
              {isWelcome.value ? null : (
                <HButton variant="secondary" onClick={() => go(-1)}>
                  {t("onboarding.prev")}
                </HButton>
              )}
              <HButton
                variant="primary"
                disabled={primaryDisabled.value}
                onClick={() => (isLast.value ? finish() : go(1))}
              >
                {primaryLabel.value}
              </HButton>
            </>
          ),
        }}
      />
    );
  },
});
