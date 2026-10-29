/**
 * Shared in-game plugin status card — one look across the live-battle
 * surfaces. Three shapes:
 *
 * - safe mode (mod hub quarantine): the install's res_mods is renamed
 *   away, so the probe reads the plugin as absent even though nothing is
 *   broken. The card states the quarantine and, where mutations are
 *   allowed, offers the shared "turn mods back on and repair" recovery —
 *   never an install/update button the backend would have to refuse.
 * - actions=true (the idle guide, game closed): the full card with its
 *   lifecycle button — install when absent, UPDATE when the installed
 *   bytes predate this build (warning accent), uninstall/reinstall when
 *   current.
 * - actions=false (the live panel's waiting state, game running): the
 *   same card as a pure status readout — the backend refuses res_mods
 *   mutations while the game runs, so no buttons are offered there (safe
 *   mode included: the recovery rename is a mutation too).
 */
import { defineComponent, ref } from "vue";
import { AlertTriangle, Plug, RotateCcw } from "@lucide/vue";

import { HkSpinner, useToast } from "@celestia-island/hikari";
import { t, tError } from "@/i18n";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import "./PluginStatusCard.scss";

export default defineComponent({
  name: "PluginStatusCard",
  props: {
    /** Lifecycle buttons only on surfaces where mutations are allowed. */
    actions: { type: Boolean, default: true },
  },
  setup(props) {
    const plugin = useIngamePluginStore();
    const toast = useToast();
    /** Local single-flight for the recovery click: the shared busy table
     *  only fills once the embedded install starts, so a double-click would
     *  otherwise fire the restore rename twice. */
    const repairing = ref(false);

    async function run(action: "install" | "update" | "uninstall") {
      const done =
        action === "uninstall"
          ? await plugin.uninstall()
          : action === "update"
            ? await plugin.update()
            : await plugin.install();
      if (done) {
        // Key-or-raw contract (see tError): a backend guard refusal is an
        // English sentence and must surface verbatim, never via t().
        toast.error(tError(done));
        return;
      }
      toast.success(
        t(
          action === "uninstall"
            ? "replay.live.idlePluginRemoved"
            : action === "update"
              ? "replay.live.idlePluginUpdated"
              : "replay.live.idlePluginInstalled",
        ),
      );
    }

    /** Safe-mode recovery through the shared store flow — the same one
     *  click the boot prompt's safe-mode variant offers. */
    async function repair() {
      if (repairing.value) return;
      repairing.value = true;
      try {
        const done = await plugin.repairSafeMode();
        if (done) {
          // Key-or-raw contract (see tError): the store returns a localized
          // key for its own guards and the raw sentence for setter errors.
          toast.error(tError(done));
          return;
        }
        toast.success(t("replay.live.pluginSafeModeRepaired"));
      } finally {
        repairing.value = false;
      }
    }

    return () => {
      const safeMode = plugin.safeMode;
      const state = plugin.state;
      const busy = plugin.busy;
      if (safeMode) {
        return (
          <div class="plugin-status-card plugin-status-card--safe-mode">
            <span class="plugin-status-card__icon">
              <AlertTriangle size={15} />
            </span>
            <span class="plugin-status-card__text">
              <strong>{t("replay.live.pluginSafeModeTitle")}</strong>
              <span>{t("replay.live.pluginSafeModeDesc")}</span>
            </span>
            {props.actions ? (
              <button
                class="plugin-status-card__btn"
                type="button"
                disabled={!!busy || repairing.value}
                onClick={() => void repair()}
              >
                {busy || repairing.value ? (
                  <HkSpinner size="xs" tone="current" />
                ) : (
                  <RotateCcw size={13} />
                )}
                {t("replay.live.pluginSafeModeRepair")}
              </button>
            ) : null}
          </div>
        );
      }
      const titleKey =
        state === "outdated"
          ? "replay.live.idlePluginOutdatedTitle"
          : state === "installed"
            ? "replay.live.idlePluginOnTitle"
            : "replay.live.idlePluginOffTitle";
      const descKey =
        state === "outdated"
          ? "replay.live.idlePluginOutdatedDesc"
          : state === "installed"
            ? "replay.live.idlePluginOnDesc"
            : "replay.live.idlePluginOffDesc";
      const action: "install" | "update" | "uninstall" | null =
        state === "outdated" ? "update" : state === "installed" ? "uninstall" : "install";
      const labelKey =
        action === "update"
          ? "replay.live.idlePluginUpdate"
          : action === "uninstall"
            ? "replay.live.idlePluginRemove"
            : "replay.live.idlePluginInstall";
      return (
        <div class={["plugin-status-card", `plugin-status-card--${state}`]}>
          <span class="plugin-status-card__icon">
            {state === "outdated" ? <AlertTriangle size={15} /> : <Plug size={15} />}
          </span>
          <span class="plugin-status-card__text">
            <strong>{t(titleKey)}</strong>
            <span>{t(descKey)}</span>
          </span>
          {props.actions && action ? (
            <button
              class="plugin-status-card__btn"
              type="button"
              disabled={!!busy}
              onClick={() => void run(action)}
            >
              {busy ? (
                <HkSpinner size="xs" tone="current" />
              ) : action === "uninstall" ? (
                <RotateCcw size={13} />
              ) : action === "update" ? (
                <RotateCcw size={13} />
              ) : (
                <Plug size={13} />
              )}
              {t(labelKey)}
            </button>
          ) : null}
        </div>
      );
    };
  },
});
