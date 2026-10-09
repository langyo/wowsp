import { computed, defineComponent, nextTick, onBeforeUnmount, ref, Teleport, watch } from "vue";
import type { PropType, Ref } from "vue";
import { AlertTriangle, ArrowUpCircle } from "@lucide/vue";

import { t } from "@/i18n";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import type { PendingInstall, PluginUpdateInfo } from "@/stores/pluginUpdates";
import { installFolderName, installLabel } from "@/utils/installLabel";
import "./PluginUpdateHint.scss";

/** Names shown per client group before the "+N" fold. */
const LIST_CAP = 6;
/** Hover-in delay before the hint opens (the global tooltip's rhythm). */
const OPEN_DELAY_MS = 250;
/** Grace between leaving the trigger/popup and actually closing. */
const CLOSE_GRACE_MS = 180;
/** Gap between the anchor card's right edge and the popup. */
const ANCHOR_GAP_PX = 10;
/** Viewport breathing room kept above/below the popup. */
const EDGE_PX = 8;

/**
 * PluginUpdateHint — the hover surface on the sidebar's client-version
 * selector. While ANY install has plugins awaiting updates the wrapped
 * button gains a count badge, and hovering it opens this card to the
 * RIGHT of the game-status card, vertically centered on it (the anchor
 * element arrives as the `anchor` ref prop), listing what is stale per
 * client — the built-in probe plugin plus outdated catalog mods — with
 * one 一键更新 action that starts the batch pass across every pending
 * install (progress lands in the ModUpdateToast card). hikari's HkTooltip
 * is text-only, so this is a purpose-built two-target hover popup:
 * entering either the trigger or the card keeps it open, leaving both
 * starts a short close grace.
 *
 * While the RUNNING client's probe plugin is stale the card is PINNED:
 * it opens on its own and stays put (no hover needed, no close grace) —
 * the user launched the game without updating, and the in-battle
 * hold-Tab stats may be off until they do. The pinned card carries the
 * warning line; the pin lifts when the game closes or the probe catches
 * up, and hover behavior takes over again.
 *
 * Renders just the slot when nothing is outdated — the plain path
 * tooltip stays whatever the slot's parent wraps it in.
 */
export default defineComponent({
  name: "PluginUpdateHint",
  props: {
    /** The element the popup anchors to — the sidebar's game-status
     *  card, so the popup floats beside it, vertically centered on it
     *  instead of hanging off the selector row's top-right corner. */
    anchor: {
      type: Object as PropType<Ref<HTMLElement | null | undefined>>,
      default: undefined,
    },
  },
  setup(props, { slots }) {
    const updates = usePluginUpdatesStore();
    const gameStatus = useGameStatusStore();

    const open = ref(false);
    const popStyle = ref<{ left: string; top: string; transform: string } | null>(null);
    const wrapEl = ref<HTMLElement | null>(null);
    const popEl = ref<HTMLElement | null>(null);
    /** Where the pointer currently rests — the pin lifting must not yank
     *  the card away from under a reading pointer (the warning's own
     *  follow-up is "close the game, then update"). */
    const hoverSpan = ref(false);
    const hoverPop = ref(false);
    let openTimer: number | undefined;
    let closeTimer: number | undefined;
    /** Anchor snapshot behind the current popStyle: the popup's left
     *  edge and the vertical center its translateY(-50%) hangs on. */
    let anchorLeft = 0;
    let anchorCenterY = 0;

    /** Pinned while the RUNNING client's probe plugin is stale — the
     *  card stays up as a standing reminder. Only the probe counts: it
     *  is what feeds the hold-Tab battle stats the warning is about
     *  (cosmetic catalog mods do not make the stats untrustworthy). */
    const pinned = computed(() => {
      const proc = gameStatus.process;
      if (!proc.running) return false;
      return !!updates.infoFor(proc.matchedInstall?.path)?.probeOutdated;
    });

    function clearTimers(): void {
      if (openTimer !== undefined) window.clearTimeout(openTimer);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      openTimer = closeTimer = undefined;
    }

    /** Rewrite the popup style off the anchor snapshot, clamping the
     *  centered top into the viewport once the popup's own rendered
     *  height is known (jsdom and the pre-mount pass both measure 0). */
    function applyStyle(): void {
      const half = (popEl.value?.offsetHeight ?? 0) / 2;
      const top = Math.max(
        EDGE_PX + half,
        Math.min(anchorCenterY, window.innerHeight - EDGE_PX - half),
      );
      popStyle.value = {
        left: `${anchorLeft}px`,
        top: `${top}px`,
        transform: "translateY(-50%)",
      };
    }

    /** Snapshot the anchor card's rect. Returns false when neither the
     *  anchor nor the wrapper is mounted yet (pre-mount pin flip). */
    function place(): boolean {
      const rect = (props.anchor?.value ?? wrapEl.value)?.getBoundingClientRect();
      if (!rect) return false;
      anchorLeft = Math.min(rect.right + ANCHOR_GAP_PX, window.innerWidth - 340);
      anchorCenterY = rect.top + rect.height / 2;
      applyStyle();
      return true;
    }

    async function show(): Promise<void> {
      if (!place()) {
        // An immediate pin at setup can fire before the anchor sibling's
        // ref is wired (or before this component's own wrapper mounts)
        // — retry once after the current patch settles.
        await nextTick();
        if (!place()) return;
      }
      open.value = true;
      // The popup's height settles after it renders — one post-mount
      // pass re-clamps the centered top against the viewport bottom.
      await nextTick();
      if (open.value) applyStyle();
    }

    function close(): void {
      open.value = false;
      popStyle.value = null;
    }

    function onEnter(): void {
      hoverSpan.value = true;
      if (updates.totalCount === 0) return;
      clearTimers();
      openTimer = window.setTimeout(() => void show(), OPEN_DELAY_MS);
    }

    function onLeave(): void {
      hoverSpan.value = false;
      if (openTimer !== undefined) {
        window.clearTimeout(openTimer);
        openTimer = undefined;
      }
      closeTimer = window.setTimeout(() => {
        // A pinned card outlives the pointer — the reminder stays.
        if (!pinned.value) close();
      }, CLOSE_GRACE_MS);
    }

    // The pin flip opens the card by itself; the pin lifting closes it
    // unless the pointer is holding it open (the hover handlers take
    // over from there). show() carries its own mount-timing retry.
    watch(pinned, (p) => {
      if (p) void show();
      else if (!hoverSpan.value && !hoverPop.value) close();
    }, { immediate: true, flush: "post" });

    // A pinned card can outlive a viewport resize — re-anchor while up.
    function onResize(): void {
      if (open.value) place();
    }
    window.addEventListener("resize", onResize);
    onBeforeUnmount(() => {
      clearTimers();
      window.removeEventListener("resize", onResize);
    });

    function itemNames(info: PluginUpdateInfo): string[] {
      return [
        ...(info.probeOutdated ? [t("resources.pluginProbeName")] : []),
        ...info.mods.map((m) => m.name),
      ];
    }

    function groupLabel(g: PendingInstall): string {
      return installLabel(g.install?.kind, g.install?.realm) || installFolderName(g.path);
    }

    return () => {
      const count = updates.totalCount;
      const groups = updates.pendingInstalls;
      const multi = groups.length > 1;
      // The single-client case renders the flat list the card always
      // had — no group chrome until a second client is actually pending.
      const singleNames = multi ? [] : (groups[0] ? itemNames(groups[0].info) : []);
      const singleShown = singleNames.slice(0, LIST_CAP);
      const singleFolded = singleNames.length - singleShown.length;
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
                ref={popEl}
                style={popStyle.value ?? undefined}
                role={pinned.value ? "status" : "tooltip"}
                onMouseenter={() => {
                  hoverPop.value = true;
                  clearTimers();
                }}
                onMouseleave={() => {
                  hoverPop.value = false;
                  onLeave();
                }}
              >
                <p class="plugin-update-hint__title">
                  {multi
                    ? t("resources.pluginUpdateCountMulti", { count, clients: groups.length })
                    : t("resources.pluginUpdateCount", { count })}
                </p>
                {pinned.value ? (
                  <p class="plugin-update-hint__warn">
                    <AlertTriangle size={13} class="plugin-update-hint__warn-icon" />
                    {t("resources.pluginUpdateStaleWarning")}
                  </p>
                ) : null}
                {multi ? (
                  <ul class="plugin-update-hint__list">
                    {groups.map((g) => {
                      const names = itemNames(g.info);
                      const shown = names.slice(0, LIST_CAP);
                      const folded = names.length - shown.length;
                      return (
                        <li class="plugin-update-hint__group" key={g.path}>
                          <span class="plugin-update-hint__group-label">{groupLabel(g)}</span>
                          <ul class="plugin-update-hint__group-items">
                            {shown.map((name) => (
                              <li key={name}>{name}</li>
                            ))}
                            {folded > 0 ? (
                              <li class="plugin-update-hint__more">+{folded}</li>
                            ) : null}
                          </ul>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <ul class="plugin-update-hint__list">
                    {singleShown.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                    {singleFolded > 0 ? (
                      <li class="plugin-update-hint__more">+{singleFolded}</li>
                    ) : null}
                  </ul>
                )}
                <button
                  type="button"
                  class="plugin-update-hint__go"
                  disabled={updates.running}
                  onClick={(e) => {
                    e.stopPropagation();
                    void updates.updateAll();
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
