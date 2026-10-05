import { defineComponent, onBeforeUnmount, ref, Teleport } from "vue";
import { ArrowUpCircle } from "@lucide/vue";

import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import "./PluginUpdateHint.scss";

/** Names shown in the hint card before the "+N" fold. */
const LIST_CAP = 6;
/** Hover-in delay before the hint opens (the global tooltip's rhythm). */
const OPEN_DELAY_MS = 250;
/** Grace between leaving the trigger/popup and actually closing. */
const CLOSE_GRACE_MS = 180;

/**
 * PluginUpdateHint — the hover surface on the sidebar's client-version
 * selector. While the active install has plugins awaiting updates the
 * wrapped button gains a count badge, and hovering it opens this card
 * (to the selector's right, hikari's popup z-band) listing what is
 * stale — the built-in probe plugin plus outdated catalog mods — with
 * one 一键更新 action that starts the batch pass (progress lands in the
 * ModUpdateToast card). hikari's HkTooltip is text-only, so this is a
 * purpose-built two-target hover popup: entering either the trigger or
 * the card keeps it open, leaving both starts a short close grace.
 *
 * Renders just the slot when nothing is outdated — the plain path
 * tooltip stays whatever the slot's parent wraps it in.
 */
export default defineComponent({
  name: "PluginUpdateHint",
  setup(_, { slots }) {
    const updates = usePluginUpdatesStore();
    const config = useConfigStore();

    const open = ref(false);
    const popStyle = ref<{ left: string; top: string } | null>(null);
    const wrapEl = ref<HTMLElement | null>(null);
    let openTimer: number | undefined;
    let closeTimer: number | undefined;

    function clearTimers(): void {
      if (openTimer !== undefined) window.clearTimeout(openTimer);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      openTimer = closeTimer = undefined;
    }

    function onEnter(): void {
      if (updates.activeCount === 0) return;
      clearTimers();
      openTimer = window.setTimeout(() => {
        const rect = wrapEl.value?.getBoundingClientRect();
        if (rect) {
          popStyle.value = {
            left: `${Math.min(rect.right + 10, window.innerWidth - 340)}px`,
            top: `${Math.max(8, Math.min(rect.top, window.innerHeight - 240))}px`,
          };
        }
        open.value = true;
      }, OPEN_DELAY_MS);
    }

    function onLeave(): void {
      if (openTimer !== undefined) {
        window.clearTimeout(openTimer);
        openTimer = undefined;
      }
      closeTimer = window.setTimeout(() => (open.value = false), CLOSE_GRACE_MS);
    }

    onBeforeUnmount(clearTimers);

    return () => {
      const count = updates.activeCount;
      const info = updates.infoFor(config.activeInstall?.path);
      const names = [
        ...(info?.probeOutdated ? [t("resources.pluginProbeName")] : []),
        ...(info?.mods.map((m) => m.name) ?? []),
      ];
      const shown = names.slice(0, LIST_CAP);
      const folded = names.length - shown.length;
      return (
        <span
          class="plugin-update-hint"
          ref={wrapEl}
          onMouseenter={onEnter}
          onMouseleave={onLeave}
        >
          {slots.default?.()}
          {count > 0 ? <span class="plugin-update-hint__badge">{count}</span> : null}
          {open.value && count > 0 ? (
            <Teleport to="body">
              <div
                class="plugin-update-hint__pop"
                style={popStyle.value ?? undefined}
                role="tooltip"
                onMouseenter={clearTimers}
                onMouseleave={onLeave}
              >
                <p class="plugin-update-hint__title">
                  {t("resources.pluginUpdateCount", { count })}
                </p>
                <ul class="plugin-update-hint__list">
                  {shown.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                  {folded > 0 ? <li class="plugin-update-hint__more">+{folded}</li> : null}
                </ul>
                <button
                  type="button"
                  class="plugin-update-hint__go"
                  disabled={updates.running}
                  onClick={(e) => {
                    e.stopPropagation();
                    void updates.updateAll(config.activeInstall?.path ?? "");
                  }}
                >
                  <ArrowUpCircle size={13} />
                  {t("resources.pluginUpdateOne")}
                </button>
              </div>
            </Teleport>
          ) : null}
        </span>
      );
    };
  },
});
