import { computed, defineComponent, nextTick, onBeforeUnmount, ref, Teleport, watch } from "vue";
import type { PropType, Ref } from "vue";
import { MonitorX } from "@lucide/vue";

import { t } from "@/i18n";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import "./FullscreenModeHint.scss";

/** Gap between the status card's top edge and the hint above it. */
const ANCHOR_GAP_PX = 10;
/** Viewport breathing room kept above the hint. */
const EDGE_PX = 8;

/**
 * FullscreenModeHint — the standing bottom-left warning that the RUNNING
 * client is in exclusive fullscreen (the legacy resolution-owning display
 * mode, the game's 显示模式 set to 全屏). In that mode the game owns the
 * whole screen and WoWSP's overlay windows cannot draw over it, so the
 * hold-Tab overlay stays invisible no matter what else is right — the card
 * tells the player to switch the in-game display mode to fullscreen
 * windowed (or windowed) and restart the game.
 *
 * Same visual grammar as PluginUpdateHint's pinned card, but purely
 * passive: it appears by itself while the running client reports the
 * exclusive mode (the backend reads the game's user_preferences.xml on
 * every process poll, so a mode change lifts the card), and it passes
 * pointer events through — there is nothing to click. Anchored ABOVE the
 * sidebar's game-status card so it never covers the footer rows; when
 * PluginUpdateHint's popup is up at the same time (stale probe AND
 * exclusive fullscreen) the two can overlap at this card's corner (same
 * z-band, paint order follows mount order) — the card stays readable to
 * its left and never blocks the popup's clicks.
 */
export default defineComponent({
  name: "FullscreenModeHint",
  props: {
    /** The element the hint anchors to — the sidebar's game-status card,
     *  so the hint floats above it, left-aligned with the sidebar. */
    anchor: {
      type: Object as PropType<Ref<HTMLElement | null | undefined>>,
      default: undefined,
    },
  },
  setup(props) {
    const gameStatus = useGameStatusStore();
    // The root DPI zoom the hint's coordinate math runs against — see
    // place (the scale the document root is drawn at, `1` while the
    // interface-scale preference is Auto).
    const dpiScale = useAppliedDpiScale();

    const open = ref(false);
    const popStyle = ref<{ left: string; top: string } | null>(null);
    const popEl = ref<HTMLElement | null>(null);

    const active = computed(() => {
      const proc = gameStatus.process;
      return proc.running && proc.displayMode === "exclusiveFullscreen";
    });

    /** Rewrite the hint style off the anchor card, clamping the top once
     *  the hint's own rendered height is known (happy-dom and the
     *  pre-mount pass both measure 0). The hint teleports to <body> —
     *  inside the root DPI zoom's subtree — so its left/top live in the
     *  zoomed local space and paint scale× larger: the visual-space rect
     *  is divided by the applied scale first, or the card drifts scale×
     *  off its anchor (PluginUpdateHint's zoom notes). */
    function place(): boolean {
      const rect = props.anchor?.value?.getBoundingClientRect();
      if (!rect) return false;
      const height = popEl.value?.offsetHeight ?? 0;
      const z = dpiScale.value;
      popStyle.value = {
        left: `${rect.left / z}px`,
        top: `${Math.max(EDGE_PX, rect.top / z - ANCHOR_GAP_PX - height)}px`,
      };
      return true;
    }

    // The flip opens the card by itself; the flip back closes it. The card
    // opens only once place() has a position for it — an anchor ref that is
    // not wired yet must not render an unpositioned card for a frame. The
    // place retry carries its own mount-timing escape, and one post-mount
    // pass re-clamps the top against the viewport edge.
    watch(active, (on) => {
      if (!on) {
        open.value = false;
        popStyle.value = null;
        return;
      }
      void (async () => {
        if (!place()) {
          await nextTick();
          // The mode can flip back off inside that tick (a poll landed
          // non-exclusive) — the close branch already ran; never re-open.
          if (!active.value) return;
          if (!place()) return;
        }
        open.value = true;
        await nextTick();
        if (open.value && active.value) place();
      })();
    }, { immediate: true, flush: "post" });

    // An open card can outlive a viewport resize — re-anchor while up.
    function onResize(): void {
      if (open.value) place();
    }
    window.addEventListener("resize", onResize);
    // A scale change never fires a resize event: while the card is up,
    // re-anchor it in the new space (PluginUpdateHint's zoom watch).
    watch(dpiScale, () => {
      if (open.value) place();
    });
    onBeforeUnmount(() => window.removeEventListener("resize", onResize));

    return () =>
      open.value ? (
        <Teleport to="body">
          <div
            class="fullscreen-mode-hint"
            ref={popEl}
            style={popStyle.value ?? undefined}
            role="status"
          >
            <p class="fullscreen-mode-hint__title">
              <MonitorX size={13} class="fullscreen-mode-hint__title-icon" />
              {t("resources.exclusiveFullscreenTitle")}
            </p>
            <p class="fullscreen-mode-hint__body">{t("resources.exclusiveFullscreenBody")}</p>
          </div>
        </Teleport>
      ) : null;
  },
});
