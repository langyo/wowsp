/**
 * Idle state of the live-battle page — shown while the game is not running
 * and no roster lingers. Replaces the old bare "not started yet" line with
 * a two-step onboarding guide: (1) start a battle in game, (2) hold Tab to
 * begin detection. The step illustrations are the inline vector components
 * from `liveGuideArt.tsx`; copy lives under `replay.live.idle*`.
 *
 * The game-status store polls every 3s from the app shell, so launching the
 * game swaps this guide for the live panel without any action here.
 */
import { defineComponent } from "vue";
import { ChevronRight } from "@lucide/vue";

import { t } from "@/i18n";
import { BattleStartArt, TabHoldArt } from "./liveGuideArt";
import "./LiveIdleGuide.scss";

export default defineComponent({
  name: "LiveIdleGuide",
  setup() {
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
          <p class="live-idle-guide__footnote">{t("replay.live.idleFootnote")}</p>
        </div>
      </div>
    );
  },
});
