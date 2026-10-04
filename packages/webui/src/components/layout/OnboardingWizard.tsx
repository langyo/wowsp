import { computed, defineComponent, onBeforeUnmount, ref, watch } from "vue";

import { HkButton, HkModal, HkSpinner, HkStepFlow, useToast, getThemeTokens, themePresets, useTheme } from "@celestia-island/hikari";
import { Check, ImagePlus, Moon, Sun, SunMoon } from "@lucide/vue";

import { t } from "@/i18n";
import { themePresetIds } from "@/theme";
import {
  setThemeModePreference,
  themeModePreference,
  type ThemeModePreference,
} from "@/theme/themeModePreference";
import { useWallpaper } from "@/theme/useWallpaper";
import { imageSourceUrl } from "@/theme/wallpaper";
import { isTauri } from "@/transport";
import { useStatsPrefsStore, STATS_PREFS_STORAGE_KEY } from "@/stores/statsPrefs";
import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { markPluginPromptDismissed } from "@/stores/pluginPrompt";
import { api, type GameInstall } from "@/api";
import { isMobileApp } from "@/utils/platform";
import { installLabelOf } from "@/utils/installLabel";
import { sameGamePath } from "@/utils/gamePath";
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
/** Blind-click guard on the plugin offer's 暂不安装 — declining the
 *  in-game plugin is the choice we want users to make deliberately, so it
 *  unlocks only after the offer has been on screen for this long. */
const PLUGIN_SKIP_COUNTDOWN_SECONDS = 5;

const STEP_KEYS = ["welcome", "game", "preferences", "appearance"] as const;
type StepKey = (typeof STEP_KEYS)[number];
/** The game step is desktop-only: the phone app build has no local game
 *  install to confirm and no res_mods to write the plugin into, so its
 *  wizard collapses back to the classic three steps. */
const FLOW_KEYS: readonly StepKey[] = isMobileApp()
  ? STEP_KEYS.filter((k) => k !== "game")
  : STEP_KEYS;

/** Shared driver for the blind-click countdown guards: counts down ONCE
 *  per lifetime (re-entering the step must not re-lock the button for
 *  another round), fires nothing at zero (callers read `count` for the
 *  disabled binding) and can be cleared on teardown. */
function createCountdown(seconds: number) {
  const count = ref(seconds);
  let timer: number | undefined;
  let started = false;
  function start() {
    if (started || timer !== undefined) return;
    started = true;
    count.value = seconds;
    timer = window.setInterval(() => {
      count.value -= 1;
      if (count.value <= 0) {
        window.clearInterval(timer);
        timer = undefined;
        count.value = 0;
      }
    }, 1000);
  }
  function stop() {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }
  return { count, start, stop };
}

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
 * First-launch setup wizard (four steps: notice ack → game detect + plugin
 * offer → water-table prefs → appearance with theme + wallpaper merged),
 * replacing the old forced AnnouncementDialog — the notice content is now
 * the wizard's first step with the same 5-second blind-click guard on its
 * confirm button.
 *
 * The game step folds the old first-launch game-path prompt INTO the flow:
 * it lists the installs AppShell's scan found (click to confirm one,
 * browse/redetect as fallbacks) and, once an active install exists while
 * the in-game plugin is absent, offers the plugin install — the 暂不安装
 * side of that offer carries its own 5-second blind-click guard, and a
 * decline also silences the boot-time second-chance prompt (see the
 * pluginPrompt store). The step (and its slot) drops out on the phone app
 * build, which has no local game install.
 *
 * Rides the shared HkModal window shell (surface-machine open/close motion,
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
    const ack = createCountdown(ACK_COUNTDOWN_SECONDS);
    const pluginSkip = createCountdown(PLUGIN_SKIP_COUNTDOWN_SECONDS);
    const theme = useTheme();
    const wallpaper = useWallpaper();
    const toast = useToast();
    const prefs = useStatsPrefsStore();
    const config = useConfigStore();
    const accounts = useAccountStore();
    const plugin = useIngamePluginStore();
    const importing = ref(false);

    // ── game step state ──
    /** Native folder-picker round-trip in flight (浏览文件夹…). */
    const picking = ref(false);
    /** Plugin offer answered — hides the section after 暂不安装. */
    const pluginDeclined = ref(false);
    /** The plugin was installed from THIS wizard run — flips the section
     *  into its success line instead of just vanishing. */
    const pluginInstalledHere = ref(false);
    /** Scan pass has started at least once — keeps the step on its
     *  spinner (not the none-found dead end) until AppShell's detect()
     *  round-trip actually begins. */
    const scanStarted = ref(false);

    const steps = computed(() =>
      FLOW_KEYS.map((key) => ({
        key,
        label: t(`onboarding.step${key.charAt(0).toUpperCase()}${key.slice(1)}`),
      })),
    );

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

    // The welcome step is where the wizard opens, so the blind-click
    // countdown runs from the moment the wizard becomes visible (the
    // component itself stays mounted at the shell level — gate on the
    // model value, not on component mount).
    watch(
      () => props.modelValue,
      (v) => {
        if (v) ack.start();
      },
      { immediate: true },
    );
    onBeforeUnmount(() => {
      ack.stop();
      pluginSkip.stop();
    });

    function go(delta: number) {
      const i = FLOW_KEYS.indexOf(step.value);
      const next = FLOW_KEYS[Math.min(FLOW_KEYS.length - 1, Math.max(0, i + delta))];
      step.value = next;
    }

    function finish() {
      ack.stop();
      pluginSkip.stop();
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
    const isLast = computed(() => step.value === FLOW_KEYS[FLOW_KEYS.length - 1]);
    const primaryDisabled = computed(() => isWelcome.value && ack.count.value > 0);
    const primaryLabel = computed(() => {
      if (isWelcome.value) {
        return ack.count.value > 0
          ? t("onboarding.ackCountdown", { n: ack.count.value })
          : t("onboarding.ack");
      }
      return isLast.value ? t("onboarding.start") : t("onboarding.next");
    });

    // ── game step: detection confirmation ──

    const activePath = computed(() => config.activeInstall?.path ?? "");
    // The detect pass in AppShell flips `detecting` once its IPC round-trip
    // starts; until then the step keeps its spinner so the none-found dead
    // end never flashes ahead of the real scan.
    watch(
      () => config.detecting,
      (v) => {
        if (v) scanStarted.value = true;
      },
      { immediate: true },
    );

    /** Follow a client switch to that realm's preferred account — same
     *  behavior as the game-path modal and the settings 游戏路径 table. */
    async function followRealm(realm?: string | null) {
      if (!realm) return;
      const switched = await accounts.autoSwitchRealm(realm);
      if (switched) {
        toast.info(t("account.autoSwitched", { name: switched.nickname }));
      }
    }

    /** Confirm a detected install as the active one — the wizard stays
     *  open (the step's 下一步 advances), only the choice applies. */
    async function pickInstall(i: GameInstall) {
      await config.selectInstall(i.path);
      await followRealm(i.realm);
      toast.info(t("common.gamePath.applied"));
    }

    async function applyManual(path: string) {
      try {
        const resolved = await config.setManualPath(path);
        await followRealm(resolved?.realm);
        toast.info(t("common.gamePath.applied"));
      } catch (e) {
        toast.error(`${t("common.gamePath.invalid")}\n${(e as Error).message || String(e)}`);
      }
    }

    async function browse() {
      if (picking.value) return;
      picking.value = true;
      try {
        // Null = the user closed the native dialog — not an error.
        const picked = await api.pickGameFolder();
        if (picked) await applyManual(picked.path);
      } catch (e) {
        toast.error((e as Error).message || String(e));
      } finally {
        picking.value = false;
      }
    }

    async function redetect() {
      await config.detect();
    }

    // ── game step: in-game plugin offer ──

    // The offer shows only once the probe settled on "absent" for the
    // confirmed install — an unprobed or already-installed plugin leaves
    // the step at the game confirmation alone. Answers (decline/install)
    // hide it for the rest of the run.
    const pluginOfferVisible = computed(
      () =>
        step.value === "game" &&
        !!config.activeInstall &&
        plugin.probed &&
        plugin.state === "absent" &&
        !pluginDeclined.value,
    );
    // Countdown runs from the moment the offer is actually on screen — the
    // guard exists so 暂不安装 cannot be blind-clicked past the copy.
    watch(
      pluginOfferVisible,
      (v) => {
        if (v) pluginSkip.start();
      },
      { immediate: true },
    );

    async function installPlugin() {
      if (plugin.busy) return;
      const done = await plugin.install();
      if (done) {
        // Same contract as PluginStatusCard: the store returns either a
        // localized key or a raw message — t() passes the latter through.
        toast.error(t(done));
        return;
      }
      pluginInstalledHere.value = true;
      toast.success(t("replay.live.idlePluginInstalled"));
    }

    function skipPlugin() {
      if (pluginSkip.count.value > 0) return;
      pluginDeclined.value = true;
      // A deliberate decline inside the wizard also silences the boot-time
      // second-chance prompt — asking again next boot would double-prompt
      // the same question (settings keeps the way back in).
      markPluginPromptDismissed();
    }

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
                  style={{
                    backgroundImage: `url(${imageSourceUrl(
                      w.source,
                      theme.effectiveMode.value === "dark" ? "dark" : "light",
                    )})`,
                  }}
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
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("onboarding.title")}
        width="md"
        closable={false}
        backGuard={false}
        contentClass="onboarding-wizard"
        v-slots={{
          default: () => (
            <HkStepFlow
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
                game: () => (
                  <div class="onboarding__body">
                    <p class="onboarding__desc">{t("onboarding.gameDesc")}</p>

                    {/* Detected installs — the AppShell scan feeds the
                        config store; click confirms one as active (stays
                        in-step, 下一步 advances). Spinner until the scan
                        pass actually starts, none-found + manual browse
                        as the fallbacks. */}
                    {config.detecting || !scanStarted.value ? (
                      <div class="onboarding__game-scan">
                        <HkSpinner size="xs" tone="current" />
                        <span>{t("onboarding.gameDetecting")}</span>
                      </div>
                    ) : config.installs.length > 0 ? (
                      <div class="onboarding__installs">
                        {config.installs.map((i) => {
                          const active = sameGamePath(i.path, activePath.value);
                          return (
                            <button
                              key={i.path}
                              type="button"
                              aria-pressed={active}
                              class={["onboarding__install", active ? "is-active" : ""]}
                              onClick={() => void pickInstall(i)}
                            >
                              <span class="onboarding__install-label">{installLabelOf(i)}</span>
                              <span class="onboarding__install-path">{i.path}</span>
                              {active ? (
                                <Check size={14} class="onboarding__install-check" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p class="onboarding__desc">{t("common.gamePath.noneFound")}</p>
                    )}

                    <div class="onboarding__game-actions">
                      <HkButton
                        size="sm"
                        variant="secondary"
                        loading={config.detecting}
                        onClick={() => void redetect()}
                      >
                        {t("common.gamePath.redetect")}
                      </HkButton>
                      <HkButton
                        size="sm"
                        variant="secondary"
                        loading={picking.value}
                        onClick={() => void browse()}
                      >
                        {t("common.gamePath.browse")}
                      </HkButton>
                    </div>

                    {/* In-game plugin offer — only when the confirmed
                        install is probed and plugin-absent. 暂不安装 rides
                        the 5s blind-click guard; either answer folds the
                        section away. */}
                    {pluginOfferVisible.value ? (
                      <div class="onboarding__plugin">
                        <h3 class="onboarding__subtitle">{t("onboarding.pluginSection")}</h3>
                        <p class="onboarding__desc">{t("onboarding.pluginDesc")}</p>
                        <div class="onboarding__plugin-actions">
                          <HkButton
                            size="sm"
                            variant="primary"
                            loading={plugin.busy === "install"}
                            onClick={() => void installPlugin()}
                          >
                            {t("onboarding.pluginInstall")}
                          </HkButton>
                          <HkButton
                            size="sm"
                            variant="secondary"
                            disabled={pluginSkip.count.value > 0}
                            onClick={skipPlugin}
                          >
                            {pluginSkip.count.value > 0
                              ? t("onboarding.pluginSkipCountdown", { n: pluginSkip.count.value })
                              : t("onboarding.pluginSkip")}
                          </HkButton>
                        </div>
                      </div>
                    ) : null}
                    {pluginInstalledHere.value ? (
                      <p class="onboarding__plugin-done">
                        <Check size={14} />
                        <span>{t("onboarding.pluginDone")}</span>
                      </p>
                    ) : null}
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
                    <div class="onboarding__options onboarding__options--auto">
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
                <HkButton variant="secondary" onClick={() => go(-1)}>
                  {t("onboarding.prev")}
                </HkButton>
              )}
              <HkButton
                variant="primary"
                disabled={primaryDisabled.value}
                onClick={() => (isLast.value ? finish() : go(1))}
              >
                {primaryLabel.value}
              </HkButton>
            </>
          ),
        }}
      />
    );
  },
});
