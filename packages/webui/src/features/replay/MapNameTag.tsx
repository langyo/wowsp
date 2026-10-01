/**
 * Map-name tag — the shared "which map am I on" chip. The live battle head
 * and the replay-review header both render their map through this one
 * component so the three affordances behave identically everywhere: the
 * name resolves through the shared catalog (utils/mapNames); hovering (or
 * focusing) the tag floats a card previewing the map's bundled minimap art
 * — the same resource pool the /tactics board paints; clicking jumps
 * straight to that map's tactical plan (/tactics?map=<spaceId>).
 *
 * Spaces the tactics board cannot host (no bundled art: scenario / PvE
 * spaces, harbor docks) render as a plain, muted tag — named but not
 * clickable — so the interactive look only promises a jump that can land.
 *
 * The preview card teleports to <body> and fixed-positions itself with a
 * viewport clamp (the global data-hint tooltip's approach): both host
 * headers sit beside scrolling columns whose ancestors clip or scroll, so
 * an in-flow absolute card would be amputated or stranded.
 */
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties, type PropType } from "vue";
import { Teleport } from "vue";
import { useRouter } from "vue-router";
import { ArrowUpRight, Map } from "@lucide/vue";
import { usePopupManager } from "@celestia-island/hikari";

import { resolveMapMinimapUrl } from "@/features/holographic/modelLoader";
import { t } from "@/i18n";
import { displayMapName } from "@/utils/mapNames";
import { isAnalysableSpace } from "@/utils/tacticsMaps";
import "./MapNameTag.scss";

/** Hover-show delay: parity with the global data-hint tooltip. */
const SHOW_DELAY_MS = 300;
/** Same anchor gap and viewport clamp margin the global tooltip keeps. */
const ANCHOR_GAP_PX = 8;
const EDGE_MARGIN_PX = 8;

export default defineComponent({
  name: "MapNameTag",
  /** The teleported preview card makes this a multi-root component — Vue
   *  would skip attr fallthrough (with a dev warning per re-render), so
   *  callers' class is merged by hand below. */
  inheritAttrs: false,
  props: {
    /** Space id as each surface carries it, with or without a leading
     *  `spaces/` prefix — the shared resolver strips it either way. */
    spaceId: {
      type: String as PropType<string | null | undefined>,
      default: null,
    },
    /** Game-asset language for the official map name (the dataLanguage —
     *  callers hold it as a nullable ref, hence the widened type). */
    lang: {
      type: String as PropType<string | null | undefined>,
      default: "",
    },
  },
  setup(props, { attrs }) {
    const router = useRouter();
    const tagEl = ref<HTMLElement | null>(null);
    const cardEl = ref<HTMLElement | null>(null);
    const open = ref(false);
    const cardPos = ref<CSSProperties>({});

    const cleanId = computed(() => props.spaceId?.replace(/^spaces\//, "") ?? null);
    /** The jump only promises what /tactics can board. */
    const analysable = computed(() => cleanId.value != null && isAnalysableSpace(cleanId.value));
    const name = computed(() => displayMapName(props.spaceId, props.lang ?? ""));
    const thumbUrl = computed(() => (cleanId.value != null ? resolveMapMinimapUrl(cleanId.value) : null));

    let showTimer: number | null = null;
    /** Last pointerdown timestamp — a click focuses the button, and the
     *  focus-show would flash the card for a frame on every jump (the
     *  global tooltip suppresses that the same way). */
    let pointerDownAt = -1e9;
    /** The card holds the tooltip z band (above rows/modals, below toasts)
     *  for its lifetime — same registration the global tooltip keeps. */
    let popupId: string | null = null;
    let popupZ = 0;

    function clearShowTimer(): void {
      if (showTimer !== null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
    }

    function hideNow(): void {
      clearShowTimer();
      open.value = false;
    }

    async function show(): Promise<void> {
      clearShowTimer();
      if (!analysable.value || open.value) return;
      open.value = true;
      // Measure only once mounted: the clamp needs the card's own box.
      await nextTick();
      const anchor = tagEl.value;
      const card = cardEl.value;
      if (!anchor || !card) return;
      const r = anchor.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        // The anchor vanished (a view swap under a stationary pointer): a
        // zero rect would clamp the card into the top-left corner.
        hideNow();
        return;
      }
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      // Below the tag, flipping above when the window's bottom edge is too
      // close; horizontally the card grows rightward from the tag's left
      // edge and the clamp pulls it back for right-flush anchors.
      let left = r.left;
      let top = r.bottom + ANCHOR_GAP_PX;
      if (top + h > window.innerHeight - EDGE_MARGIN_PX) top = r.top - ANCHOR_GAP_PX - h;
      left = Math.min(Math.max(left, EDGE_MARGIN_PX), Math.max(window.innerWidth - w - EDGE_MARGIN_PX, EDGE_MARGIN_PX));
      top = Math.max(top, EDGE_MARGIN_PX);
      cardPos.value = {
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        zIndex: popupZ,
      };
    }

    function scheduleShow(): void {
      clearShowTimer();
      showTimer = window.setTimeout(() => void show(), SHOW_DELAY_MS);
    }

    function openTactics(): void {
      if (cleanId.value == null || !analysable.value) return;
      hideNow();
      void router.push({ path: "/tactics", query: { map: cleanId.value } });
    }

    onMounted(() => {
      const handle = usePopupManager().register("tooltip", false);
      popupId = handle.id;
      popupZ = handle.zIndex;
      // Any scroll moves the fixed card off its anchor — hiding is cheaper
      // than tracking scroll offsets (the global tooltip's same call).
      document.addEventListener("scroll", hideNow, true);
      window.addEventListener("resize", hideNow);
      // Window focus loss hides too — parity with the global tooltip, so a
      // card is never the one thing left painted on a minimized app.
      window.addEventListener("blur", hideNow);
    });
    onBeforeUnmount(() => {
      hideNow();
      document.removeEventListener("scroll", hideNow, true);
      window.removeEventListener("resize", hideNow);
      window.removeEventListener("blur", hideNow);
      if (popupId != null) usePopupManager().unregister(popupId);
    });

    // Callers pass their layout hook as class (live-battle__map keeps the
    // tag in the head's left info group at the compact pill voice;
    // replay-view__map bumps its size) — but
    // the teleported card makes this a multi-root component, so Vue skips
    // fallthrough entirely and the class must be merged by hand (the
    // AssetImage pattern).
    return () => (
      <>
        {analysable.value ? (
          <button
            ref={tagEl}
            type="button"
            class={["map-tag", attrs.class]}
            onPointerenter={scheduleShow}
            onPointerdown={() => (pointerDownAt = performance.now())}
            onPointerleave={hideNow}
            onFocus={() => {
              if (performance.now() - pointerDownAt < 300) return;
              void show();
            }}
            onBlur={hideNow}
            onClick={openTactics}
          >
            <Map size={13} />
            {name.value}
          </button>
        ) : (
          <span class={["map-tag", "map-tag--plain", attrs.class]}>
            <Map size={13} />
            {name.value}
          </span>
        )}
        {analysable.value && open.value ? (
          <Teleport to="body">
            <div ref={cardEl} class="map-tag__card" style={cardPos.value} role="tooltip">
              {thumbUrl.value ? (
                <img class="map-tag__card-img" src={thumbUrl.value} alt="" draggable={false} />
              ) : null}
              <span class="map-tag__card-foot">
                {t("nav.tactics")}
                <ArrowUpRight size={12} />
              </span>
            </div>
          </Teleport>
        ) : null}
      </>
    );
  },
});
