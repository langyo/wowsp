import { computed, defineComponent, onBeforeUnmount, onMounted, ref } from "vue";

import { HButton, HStepFlow } from "@celestia-island/hikari";
import { Check, Monitor, Moon, Sun, SunMoon } from "@lucide/vue";

import { t } from "@/i18n";
import {
  setThemeModePreference,
  themeModePreference,
  type ThemeModePreference,
} from "@/theme/themeModePreference";
import { useWallpaper } from "@/theme/useWallpaper";
import AnnouncementContent from "./AnnouncementContent";
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

const STEP_KEYS = ["welcome", "preferences", "theme", "wallpaper"] as const;
type StepKey = (typeof STEP_KEYS)[number];

/** Theme step cards — click applies the preference immediately (live
 *  preview through the translucent overlay). */
const THEME_OPTIONS: {
  key: ThemeModePreference;
  labelKey: string;
  icon: typeof Moon;
}[] = [
  { key: "dark", labelKey: "onboarding.themeDark", icon: Moon },
  { key: "light", labelKey: "onboarding.themeLight", icon: Sun },
  { key: "solar", labelKey: "onboarding.themeSolar", icon: SunMoon },
  { key: "system", labelKey: "onboarding.themeSystem", icon: Monitor },
];

/**
 * First-launch setup wizard (four steps: notice ack → water-table prefs →
 * theme mode → wallpaper), replacing the old forced AnnouncementDialog —
 * the notice content is now the wizard's first step with the same 5-second
 * blind-click guard on its confirm button.
 *
 * The overlay sits ABOVE the sidebar/main chrome but BELOW hikari's popup
 * bands (modals/toasts), and uses a light scrim + backdrop blur instead of
 * an opaque fill so the theme/wallpaper choices preview live through it.
 * Every choice applies immediately and can be re-changed later in Settings.
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
    const wallpaper = useWallpaper();

    const steps = computed(() => [
      { key: "welcome", label: t("onboarding.stepWelcome") },
      { key: "preferences", label: t("onboarding.stepPreferences") },
      { key: "theme", label: t("onboarding.stepTheme") },
      { key: "wallpaper", label: t("onboarding.stepWallpaper") },
    ]);

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

    onMounted(() => {
      // The welcome step is where the wizard opens, so the blind-click
      // countdown runs from mount — exactly the old dialog's behavior.
      startCountdown();
    });
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
    const isLast = computed(() => step.value === "wallpaper");
    const primaryDisabled = computed(() => isWelcome.value && countdown.value > 0);
    const primaryLabel = computed(() => {
      if (isWelcome.value) {
        return countdown.value > 0
          ? t("onboarding.ackCountdown", { n: countdown.value })
          : t("onboarding.ack");
      }
      return isLast.value ? t("onboarding.start") : t("onboarding.next");
    });

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
                <span
                  class="onboarding__option-swatch-fill"
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
                  class="onboarding__option-swatch-fill"
                  style={{ backgroundImage: `url(${w.source.url})` }}
                />
              )}
            </span>
            <span class="onboarding__option-label">{w.name}</span>
            {on ? <Check size={14} class="onboarding__option-check" /> : null}
          </button>
        );
      }),
    );

    return () => {
      if (!props.modelValue) return null;
      return (
        <div class="onboarding" role="dialog" aria-modal="true" aria-label={t("onboarding.title")}>
          <div class="onboarding__panel">
            <header class="onboarding__head">
              <h2 class="onboarding__title">{t("onboarding.title")}</h2>
            </header>

            <HStepFlow
              steps={steps.value}
              modelValue={step.value}
              onUpdate:modelValue={(v: string) => (step.value = v as StepKey)}
              v-slots={{
                welcome: () => (
                  <div class="onboarding__body onboarding__body--welcome">
                    {/* Scroll region of last resort: four language blocks
                        can exceed short viewports (same contract as the
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
                theme: () => (
                  <div class="onboarding__body">
                    <p class="onboarding__desc">{t("onboarding.themeDesc")}</p>
                    <div class="onboarding__options">{themeCards.value}</div>
                  </div>
                ),
                wallpaper: () => (
                  <div class="onboarding__body">
                    <p class="onboarding__desc">{t("onboarding.wallpaperDesc")}</p>
                    <div class="onboarding__options">{wallpaperCards.value}</div>
                  </div>
                ),
              }}
            />

            <footer class="onboarding__nav">
              {/* Prev is hidden (not disabled) on the first step so the
                  welcome confirm reads as the only way forward. */}
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
            </footer>
          </div>
        </div>
      );
    };
  },
});
