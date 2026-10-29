import { computed, defineComponent, nextTick, onBeforeUnmount, ref, Teleport, watch } from "vue";
import type { PropType, Ref } from "vue";
import { useRouter } from "vue-router";
import { AlertTriangle, ArrowUpCircle, ChevronRight, Crosshair, Minus, Puzzle } from "@lucide/vue";
import {
  HkMenuActionItem,
  HkMenuPanel,
  HkScrollContainer,
  HkSpinner,
  scheduleCronAfter,
  type CronHandle,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import { INGAME_PLUGIN_MOD_ID } from "@/components/settings/useSettingsGamePaths";
import { useGameStatusStore } from "@/stores/gameStatus";
import { usePluginUpdatesStore, PROBE_ITEM } from "@/stores/pluginUpdates";
import type { PendingInstall } from "@/stores/pluginUpdates";
import { sameGamePath } from "@/utils/gamePath";
import { installFolderName, installLabel } from "@/utils/installLabel";
import "./PluginUpdateHint.scss";

/** Hover-in delay before the hint opens (the global tooltip's rhythm). */
const OPEN_DELAY_MS = 250;
/** Grace between leaving the trigger/popup and actually closing. */
const CLOSE_GRACE_MS = 180;
/** A parked (minimized) card returns only on a SETTLED hover on the
 *  trigger — deliberately much longer than the tooltip rhythm, so a
 *  drive-by pass across the selector does not yank the card the user
 *  just put away straight back up. Exported for the tests. */
export const REOPEN_DELAY_MS = 600;
/** Gap between the anchor card's right edge and the popup. */
const ANCHOR_GAP_PX = 10;
/** Viewport breathing room kept above/below the popup. */
const EDGE_PX = 8;

/** One clickable row of the hint list: a stale catalog mod or the
 *  built-in probe plugin, deep-linking its mod-hub page. */
interface HintEntry {
  /** Stable row key: the catalog mod id, or the probe's busy-table key. */
  key: string;
  label: string;
  /** Catalog id the row deep-links (/resources?mod=<id>). */
  modId: string;
  /** The probe row rides the plugin's own mod-hub page (the settings
   *  overlay section deep-links the same id). */
  probe: boolean;
}

/**
 * PluginUpdateHint — the hover surface on the sidebar's client-version
 * selector. While ANY install has plugins awaiting updates the wrapped
 * button gains a count badge, and hovering it opens this card to the
 * RIGHT of the game-status card, vertically centered on it (the anchor
 * element arrives as the `anchor` ref prop). The stale items render as
 * hikari's menu rows inside a capped HkScrollContainer — every row
 * clickable, deep-linking the mod hub's page for that plugin — with one
 * 一键更新 action that starts the batch pass across every pending
 * install (progress lands in the ModUpdateToast card; while it runs the
 * action becomes a spinner + the updating label). hikari's HkTooltip is
 * text-only, so this is a purpose-built two-target hover popup: entering
 * either the trigger or the card keeps it open, leaving both starts a
 * short close grace.
 *
 * While the RUNNING client's probe plugin is stale the card is PINNED:
 * it opens on its own and stays put (no hover needed, no close grace) —
 * the user launched the game without updating, and the in-battle
 * hold-Tab stats may be off until they do. The pinned card carries the
 * warning line; the pin lifts when the game closes or the probe catches
 * up, and hover behavior takes over again.
 *
 * A minimize button in the card's top-right corner PARKS it: the card
 * drops — even when pinned, a deliberate dismissal wins — until a
 * settled hover (REOPEN_DELAY_MS debounce, hikari's cron bus) on the
 * client-version selector brings it back; the count badge stays on the
 * selector as the cue that pulls the pointer there. The parked state is
 * per-mount and cleared when a fresh stale episode begins from an empty
 * card, so a brand-new reminder is never silently pre-dismissed.
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
    const router = useRouter();

    const open = ref(false);
    const popStyle = ref<{ left: string; top: string; transform: string } | null>(null);
    const wrapEl = ref<HTMLElement | null>(null);
    const popEl = ref<HTMLElement | null>(null);
    /** Where the pointer currently rests — the pin lifting must not yank
     *  the card away from under a reading pointer (the warning's own
     *  follow-up is "close the game, then update"). */
    const hoverSpan = ref(false);
    const hoverPop = ref(false);
    // Hover/debounce timers ride hikari's cron bus (a setTimeout
    // passthrough with a disconnect handle) instead of bare window
    // timers — same rhythm, inspectable handle, one cleanup path.
    let openTimer: CronHandle | undefined;
    let closeTimer: CronHandle | undefined;
    /** The parked card's settled-hover reopen debounce. */
    let reopenTimer: CronHandle | undefined;
    /** Parked by the minimize button: the card stays down — the pin's
     *  auto-open included (a deliberate dismissal wins over the
     *  reminder) — until a settled hover on the trigger unparks it.
     *  Per-mount state, deliberately not persisted: a stale episode
     *  that begins after the card fully emptied must announce itself
     *  again (watch below clears the park when the count returns). */
    const minimized = ref(false);
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

    /** EVERY pending install belongs to a running client — the one-click
     *  pass would skip 100% of the work (Rust refuses writes into a live
     *  game tree) and the click was a guaranteed silent no-op exactly in
     *  the state that pins this card: no backend command, no log line,
     *  only a transient toast far from where the user is looking (user
     *  report 2026-10-17). The action then says so itself; a mixed
     *  machine (some installs live, others not) keeps the normal CTA —
     *  the pass does real work there and the skip toast covers the rest. */
    const allRunning = computed(() => {
      const groups = updates.pendingInstalls;
      if (groups.length === 0) return false;
      const runningPaths = gameStatus.processes
        .filter((p) => p.running)
        .map((p) => p.matchedInstall?.path ?? null)
        .filter((p): p is string => p != null);
      return groups.every((g) => runningPaths.some((path) => sameGamePath(g.path, path)));
    });

    function clearTimers(): void {
      openTimer?.disconnect();
      closeTimer?.disconnect();
      reopenTimer?.disconnect();
      openTimer = closeTimer = reopenTimer = undefined;
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
      // Parked: every auto-open yields to the dismissal — only the
      // trigger's settled hover (onEnter's reopen branch) unparks.
      if (minimized.value) return;
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

    /** The corner button: park the card for now. Clears any pending
     *  open/close/reopen timer with it — a half-elapsed open debounce
     *  must not resurrect the card the user just dismissed. */
    function minimize(): void {
      minimized.value = true;
      clearTimers();
      close();
    }

    // A stale episode that begins after the card fully emptied must
    // not inherit an old park — the badge counts up again and the card
    // has to be able to answer it (pinned or hover-open alike).
    watch(() => updates.totalCount, (n, was) => {
      if (n > 0 && (was ?? 0) === 0) minimized.value = false;
    });

    function onEnter(): void {
      hoverSpan.value = true;
      if (updates.totalCount === 0) return;
      clearTimers();
      if (minimized.value) {
        // Parked card: a settled hover on the trigger unparks it —
        // REOPEN_DELAY_MS is the debounce that keeps a fleeting pass
        // across the selector from undoing the dismissal.
        reopenTimer = scheduleCronAfter(() => {
          minimized.value = false;
          // The episode can fully empty during the debounce — reopening
          // would only strand the hidden popup on open=true.
          if (updates.totalCount > 0) void show();
        }, REOPEN_DELAY_MS);
        return;
      }
      openTimer = scheduleCronAfter(() => void show(), OPEN_DELAY_MS);
    }

    function onLeave(): void {
      hoverSpan.value = false;
      openTimer?.disconnect();
      openTimer = undefined;
      reopenTimer?.disconnect();
      reopenTimer = undefined;
      closeTimer?.disconnect();
      closeTimer = scheduleCronAfter(() => {
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

    /** The card's rows for one pending install: the probe first (it is
     *  what the batch pass runs first too), then the stale mods. */
    function entriesOf(g: PendingInstall): HintEntry[] {
      return [
        ...(g.info.probeOutdated
          ? [{
              key: PROBE_ITEM,
              label: t("resources.pluginProbeName"),
              modId: INGAME_PLUGIN_MOD_ID,
              probe: true,
            }]
          : []),
        ...g.info.mods.map((m) => ({
          key: m.id,
          label: m.name,
          modId: m.id,
          probe: false,
        })),
      ];
    }

    function groupLabel(g: PendingInstall): string {
      return installLabel(g.install?.kind, g.install?.realm) || installFolderName(g.path);
    }

    /** A row click lands on the plugin's mod-hub page (ResourcesView's
     *  ?mod= deep link selects the entry — update lives there too).
     *  The card closes first: acting on an item ends the reminder,
     *  pinned or not. */
    function openEntry(modId: string): void {
      close();
      void router.push({ path: "/resources", query: { mod: modId } });
    }

    return () => {
      const count = updates.totalCount;
      const groups = updates.pendingInstalls;
      const multi = groups.length > 1;
      const renderItem = (entry: HintEntry) => (
        <HkMenuActionItem
          key={entry.key}
          label={entry.label}
          icon={entry.probe ? <Crosshair size={13} /> : <Puzzle size={13} />}
          onClick={() => openEntry(entry.modId)}
          v-slots={{
            suffix: () => <ChevronRight size={12} class="plugin-update-hint__item-go" />,
          }}
        />
      );
      const renderGroup = (g: PendingInstall) => {
        const entries = entriesOf(g);
        return (
          <div class="plugin-update-hint__group" key={g.path}>
            {/* The client header only earns its place when a second
                client is actually pending ("Steam · ASIA" over that
                client's rows); a single client stays a flat list. */}
            {multi ? (
              <span class="plugin-update-hint__group-label">{groupLabel(g)}</span>
            ) : null}
            {entries.map(renderItem)}
          </div>
        );
      };
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
                {/* Park-for-now: drops the card; a settled hover on the
                    selector brings it back (the badge stays as the cue). */}
                <button
                  type="button"
                  class="plugin-update-hint__min"
                  aria-label={t("resources.pluginUpdateMinimize")}
                  title={t("resources.pluginUpdateMinimize")}
                  onClick={minimize}
                >
                  <Minus size={12} />
                </button>
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
                {/* The stale list scrolls when tall (hikari's scroll
                    container owns the overlay scrollbar — this card keeps
                    its rail standing so the cap never reads as a clip)
                    and renders rows with the menu grammar: every row a
                    button deep-linking its mod-hub page. */}
                <HkScrollContainer class="plugin-update-hint__list">
                  <HkMenuPanel
                    class="plugin-update-hint__menu"
                    label={t("resources.pluginUpdateBadge")}
                  >
                    {groups.map(renderGroup)}
                  </HkMenuPanel>
                </HkScrollContainer>
                <button
                  type="button"
                  class="plugin-update-hint__go"
                  disabled={updates.running || allRunning.value}
                  onClick={(e) => {
                    e.stopPropagation();
                    void updates.updateAll();
                  }}
                >
                  {updates.running ? (
                    <HkSpinner size="xs" tone="current" />
                  ) : (
                    <ArrowUpCircle size={13} />
                  )}
                  {updates.running
                    ? t("resources.pluginUpdateRunning")
                    : allRunning.value
                      ? t("resources.pluginUpdateBlockedRunning")
                      : t("resources.pluginUpdateOne")}
                </button>
              </div>
            </Teleport>
          ) : null}
        </span>
      );
    };
  },
});
