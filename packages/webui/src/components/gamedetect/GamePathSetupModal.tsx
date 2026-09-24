import { computed, defineComponent, ref } from "vue";
import { MonitorPlay } from "@lucide/vue";

import { HkButton, HkModal, useToast } from "@celestia-island/hikari";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { api, type GameInstall } from "@/api";
import { t } from "@/i18n";
import { installLabelOf } from "@/utils/installLabel";
import "./GamePathSetupModal.scss";

/**
 * Game-path setup modal — the manual-location entry. Two surfaces open it:
 * the first-launch prompt (AppShell pops it whenever detection comes up
 * empty) and the ship-detail armor-error banner. The settings 游戏路径
 * section now manages installs itself as a table, so it no longer routes
 * through this modal.
 *
 * Body: current path status, the detected installs as a pick list, a
 * running-game shortcut (from the process watcher's synthesized install),
 * and a native folder picker. Picking or selecting applies immediately and
 * closes the modal.
 */
export default defineComponent({
  name: "GamePathSetupModal",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    const config = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const toast = useToast();

    const picking = ref(false);

    const activePath = computed(() => config.activeInstall?.path ?? "");
    const installs = computed(() => config.installs);
    const detecting = computed(() => config.detecting);

    // The process watcher synthesizes an install for a running exe that no
    // detected install claims — offer it as a one-click fallback when it
    // differs from the active path.
    const runningInstall = computed<GameInstall | null>(() => {
      const p = gameStatus.process;
      if (!p.running || !p.matchedInstall) return null;
      // Only when it's NOT already one of the detected installs (those are
      // listed above) and not already active.
      if (installs.value.some((i) => i.path === p.matchedInstall!.path)) return null;
      if (p.matchedInstall.path === activePath.value) return null;
      return p.matchedInstall;
    });

    function close() {
      emit("update:modelValue", false);
    }

    /** Follow a client switch to that realm's preferred account — same
     *  behavior as the settings 游戏路径 table. */
    async function followRealm(realm?: string | null) {
      if (!realm) return;
      const switched = await accounts.autoSwitchRealm(realm);
      if (switched) {
        toast.info(t("account.autoSwitched", { name: switched.nickname }));
      }
    }

    async function pickInstall(i: GameInstall) {
      await config.selectInstall(i.path);
      await followRealm(i.realm);
      toast.info(t("common.gamePath.applied"));
      close();
    }

    async function useRunning() {
      const i = runningInstall.value;
      if (!i) return;
      await applyManual(i.path);
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

    async function applyManual(path: string) {
      try {
        const resolved = await config.setManualPath(path);
        await followRealm(resolved?.realm);
        toast.info(t("common.gamePath.applied"));
        close();
      } catch (e) {
        toast.error(`${t("common.gamePath.invalid")}\n${(e as Error).message || String(e)}`);
      }
    }

    async function redetect() {
      await config.detect();
    }

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("common.gamePath.title")}
        width="36rem"
        footerActions={[
          {
            label: t("common.gamePath.redetect"),
            variant: "secondary",
            loading: detecting.value,
            onClick: () => void redetect(),
          },
          {
            label: t("common.gamePath.browse"),
            variant: "primary",
            loading: picking.value,
            onClick: () => void browse(),
          },
        ]}
      >
        <div class="game-path-modal">
          <p class="game-path-modal__desc">{t("common.gamePath.desc")}</p>

          {/* current status */}
          <div class="game-path-modal__current">
            <span class="game-path-modal__current-label">{t("common.gamePath.current")}</span>
            <span class={["game-path-modal__current-path", activePath.value ? "" : "is-unset"]}>
              {activePath.value || t("common.gamePath.unset")}
            </span>
          </div>

          {/* detected installs — click to activate */}
          {installs.value.length > 0 ? (
            <div class="game-path-modal__list">
              <span class="game-path-modal__list-title">{t("common.gamePath.detected")}</span>
              {installs.value.map((i) => (
                <button
                  key={i.path}
                  type="button"
                  class={[
                    "game-path-modal__install",
                    i.path === activePath.value ? "is-active" : "",
                  ]}
                  onClick={() => void pickInstall(i)}
                >
                  <span class="game-path-modal__install-label">{installLabelOf(i)}</span>
                  <span class="game-path-modal__install-path">{i.path}</span>
                </button>
              ))}
            </div>
          ) : (
            <p class="game-path-modal__hint">{t("common.gamePath.noneFound")}</p>
          )}

          {/* running-game shortcut */}
          {runningInstall.value ? (
            <div class="game-path-modal__running">
              <MonitorPlay size={14} />
              <span class="game-path-modal__running-text">
                {t("common.gamePath.runningHint", { path: runningInstall.value.path })}
              </span>
              <HkButton size="sm" onClick={() => void useRunning()}>
                {t("common.gamePath.useRunning")}
              </HkButton>
            </div>
          ) : null}
        </div>
      </HkModal>
    );
  },
});
