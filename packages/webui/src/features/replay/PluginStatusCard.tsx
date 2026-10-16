/**
 * Shared in-game plugin status card — one look across the live-battle
 * surfaces. Two shapes:
 *
 * - actions=true (the idle guide, game closed): the full card with its
 *   lifecycle button — install when absent, UPDATE when the installed
 *   bytes predate this build (warning accent), uninstall/reinstall when
 *   current.
 * - actions=false (the live panel's waiting state, game running): the
 *   same card as a pure status readout — the backend refuses res_mods
 *   mutations while the game runs, so no buttons are offered there.
 */
import { defineComponent } from "vue";
import { AlertTriangle, Plug, RotateCcw } from "@lucide/vue";

import { HkSpinner, useToast } from "@celestia-island/hikari";
import { t } from "@/i18n";
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

    async function run(action: "install" | "update" | "uninstall") {
      const done =
        action === "uninstall"
          ? await plugin.uninstall()
          : action === "update"
            ? await plugin.update()
            : await plugin.install();
      if (done) {
        toast.error(t(done));
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

    return () => {
      const state = plugin.state;
      const busy = plugin.busy;
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
