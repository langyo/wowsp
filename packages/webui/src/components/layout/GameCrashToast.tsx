import { defineComponent, Teleport } from "vue";

import { HkButton, useToast } from "@celestia-island/hikari";
import { TriangleAlert } from "@lucide/vue";

import { t } from "@/i18n";
import { useCrashStore } from "@/stores/crash";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { isMobileApp } from "@/utils/platform";
import "./GameCrashToast.scss";

/** The phone app build has no local game install (nothing to crash, no
 *  watchdog); the card renders nothing even if state leaked in. */
const QUIET_BUILD = isMobileApp();

/**
 * GameCrashToast — the crash watchdog's prompt card. When the backend
 * detects a game-client crash (commands/game_crash.rs) the record lands
 * in the crash store and this danger-tinted card rises in the shared
 * top-right toast column with the four ways forward: 安全模式重启 flips
 * the mod hub's safe mode on for the crashed install and relaunches (a
 * plain relaunch with a hint when the install root is unknown), 重启游戏
 * relaunches as-is, 查看分析 opens the settings' crash section, and 忽略
 * dismisses the record.
 *
 * PERSISTENT on purpose: a crash the user has not acted on must not
 * vanish on a timer — the card never auto-hides and only the user's
 * action (or another client's dismissal of the same record) removes it.
 * Renders nothing while the store has no undismissed record, so it
 * mounts unconditionally in the shell's toast column like its sibling
 * cards.
 */
export default defineComponent({
  name: "GameCrashToast",
  setup() {
    const crash = useCrashStore();
    const settingsUi = useSettingsUiStore();
    const toast = useToast();

    /** The primary move: safe mode + relaunch for the record's install;
     *  without a known root the safe-mode half has nothing to flip, so it
     *  degrades to a plain relaunch plus a hint toast (the fallback reads
     *  as a choice, not a bug). */
    function safeRestart() {
      const record = crash.activeRecord;
      if (record?.gameRoot) {
        void crash.safeModeAndRestart(record.gameRoot);
        return;
      }
      void crash.restart();
      toast.info(t("crash.toast.safeRestartFallback"));
    }

    function dismiss() {
      const record = crash.activeRecord;
      if (!record) return;
      crash.dismiss(record.id).catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : String(e));
      });
    }

    return () => {
      if (QUIET_BUILD) return null;
      const record = crash.activeRecord;
      if (!record) return null;
      return (
        <Teleport to="body">
          <div class="crash-toast" role="alert">
            <div class="crash-toast__row">
              <span class="crash-toast__icon">
                <TriangleAlert size={16} />
              </span>
              <p class="crash-toast__title">{t("crash.toast.title")}</p>
            </div>
            <p class="crash-toast__body">
              {t("crash.toast.body", { image: record.imageName, pid: record.pid })}
            </p>
            {record.exceptionCode && (
              <p class="crash-toast__code">
                {t("crash.toast.code", { code: record.exceptionCode })}
              </p>
            )}
            <div class="crash-toast__actions">
              <HkButton size="sm" loading={crash.restarting} onClick={safeRestart}>
                {t("crash.toast.safeRestart")}
              </HkButton>
              <HkButton
                size="sm"
                variant="secondary"
                disabled={crash.restarting}
                onClick={() => void crash.restart()}
              >
                {t("crash.toast.restart")}
              </HkButton>
              <HkButton
                size="sm"
                variant="outline"
                onClick={() => settingsUi.show("crash")}
              >
                {t("crash.toast.analysis")}
              </HkButton>
              <HkButton size="sm" variant="ghost" onClick={dismiss}>
                {t("crash.toast.dismiss")}
              </HkButton>
            </div>
          </div>
        </Teleport>
      );
    };
  },
});
