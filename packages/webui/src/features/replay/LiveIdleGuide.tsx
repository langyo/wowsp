/**
 * Idle state of the live-battle page — shown while the game is not running
 * and no roster lingers. Replaces the old bare "not started yet" line with
 * a two-step onboarding guide: (1) start a battle in game, (2) hold Tab to
 * begin detection. The step illustrations are the inline vector components
 * from `liveGuideArt.tsx`; copy lives under `replay.live.idle*`.
 *
 * Below the steps sits the in-game plugin card (owner request): absent →
 * a one-click install; installed → uninstall (for reinstalls). Both go
 * through the ingamePlugin store's gated backend commands, which refuse
 * while the game runs.
 *
 * The game-status store polls every 3s from the app shell, so launching the
 * game swaps this guide for the live panel without any action here.
 */
import { defineComponent } from "vue";
import { ChevronRight, Plug, RotateCcw } from "@lucide/vue";

import { HkSpinner, useToast } from "@celestia-island/hikari";
import { t } from "@/i18n";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { BattleStartArt, TabHoldArt } from "./liveGuideArt";
import "./LiveIdleGuide.scss";

export default defineComponent({
  name: "LiveIdleGuide",
  setup() {
    const plugin = useIngamePluginStore();
    const toast = useToast();

    async function togglePlugin() {
      const error = await (plugin.installed ? plugin.uninstall() : plugin.install());
      if (error) {
        toast.error(t(error));
      } else {
        toast.success(
          t(plugin.installed ? "replay.live.idlePluginInstalled" : "replay.live.idlePluginRemoved"),
        );
      }
    }

    return () => (
      <div class="live-idle-guide">
        <div class="live-idle-guide__inner">
          <span class="live-idle-guide__status">
            <span class="live-idle-guide__status-dot" />
            {t("common.game.offline")}
          </span>
          <h3 class="live-idle-guide__title">{t("replay.live.idleTitle")}</h3>
          <p class="live-idle-guide__subtitle">{t("replay.live.idleSubtitle")}</p>
          <ol class="live-idle-guide__steps">
            <li class="live-idle-guide__step">
              <BattleStartArt class="live-idle-guide__art" />
              <span class="live-idle-guide__step-no">1</span>
              <h4 class="live-idle-guide__step-title">
                {t("replay.live.idleStep1Title")}
              </h4>
              <p class="live-idle-guide__step-hint">{t("replay.live.idleStep1Hint")}</p>
            </li>
            <li class="live-idle-guide__arrow" aria-hidden="true">
              <ChevronRight />
            </li>
            <li class="live-idle-guide__step">
              <TabHoldArt class="live-idle-guide__art" />
              <span class="live-idle-guide__step-no">2</span>
              <h4 class="live-idle-guide__step-title">
                {t("replay.live.idleStep2Title")}
              </h4>
              <p class="live-idle-guide__step-hint">{t("replay.live.idleStep2Hint")}</p>
            </li>
          </ol>
          {/* In-game plugin lifecycle: install when absent, uninstall for a
              clean reinstall when present. The card hides while a command
              is in flight (busy spinner takes over the button). */}
          <div class={["live-idle-guide__plugin", `live-idle-guide__plugin--${plugin.state}`]}>
            <span class="live-idle-guide__plugin-icon">
              <Plug size={15} />
            </span>
            <span class="live-idle-guide__plugin-text">
              <strong>
                {t(plugin.installed ? "replay.live.idlePluginOnTitle" : "replay.live.idlePluginOffTitle")}
              </strong>
              <span>
                {t(plugin.installed ? "replay.live.idlePluginOnDesc" : "replay.live.idlePluginOffDesc")}
              </span>
            </span>
            <button
              class="live-idle-guide__plugin-btn"
              type="button"
              disabled={!!plugin.busy}
              onClick={() => void togglePlugin()}
            >
              {plugin.busy ? (
                <HkSpinner size="xs" tone="current" />
              ) : plugin.installed ? (
                <RotateCcw size={13} />
              ) : (
                <Plug size={13} />
              )}
              {t(plugin.installed ? "replay.live.idlePluginRemove" : "replay.live.idlePluginInstall")}
            </button>
          </div>
          <p class="live-idle-guide__footnote">{t("replay.live.idleFootnote")}</p>
        </div>
      </div>
    );
  },
});
