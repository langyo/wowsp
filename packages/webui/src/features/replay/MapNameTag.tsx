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
 * The chip FACE is AppTag's: soft accent while the jump can land, the quiet
 * outline voice when it cannot. The hand-rolled pill this component used to
 * press restated the HkTag-sm anatomy 2.2 CSS px taller than every AppTag in
 * the same head row (2026-11-16 review); the `.map-tag` host class stays as
 * this component's identity hook for tests (the HOSTS position the tag with
 * their own class — live-battle__map / replay-view__map), plus it is the
 * element the preview card measures.
 *
 * The preview card measures off the pressed tag BUTTON, so the anchor rides
 * the pointer/focus event's `currentTarget` — the face is a component now,
 * and a template ref must never reach into another component's internals
 * (the same reason the interactive element's class lands on AppTag's button).
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

import AppTag from "@/components/base/AppTag";
import { noteMapMinimapLoadError, resolveMapMinimapUrl } from "@/features/holographic/modelLoader";
import { t } from "@/i18n";
import { displayMapName } from "@/utils/mapNames";
import { isAnalysableSpace } from "@/utils/tacticsMaps";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
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
    const cardEl = ref<HTMLElement | null>(null);
    const open = ref(false);
    const cardPos = ref<CSSProperties>({});
    // The card teleports to <body> — inside the root DPI zoom's subtree —
    // so its written left/top paint in the zoomed local space while the
    // tag's gBCR and window.innerWidth/innerHeight answer in root-visual
    // px: every measured value is divided by the applied scale first, or
    // the card drifts scale× off its tag (the hint family's zoom notes;
    // offsetWidth/offsetHeight are already local).
    const dpiScale = useAppliedDpiScale();

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

    /** `anchor` is the pressed tag BUTTON, captured from the triggering
     *  event (see scheduleShow/onFocus): the chip face is AppTag's, so its
     *  wrapper is the only element this component owns. */
    async function show(anchor: HTMLElement): Promise<void> {
      clearShowTimer();
      if (!analysable.value || open.value) return;
      open.value = true;
      // Measure only once mounted: the clamp needs the card's own box.
      await nextTick();
      const card = cardEl.value;
      if (!card) return;
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
      // edge and the clamp pulls it back for right-flush anchors. The rect
      // and the viewport clamp divide into the card's zoomed local space
      // (see the dpiScale note above).
      const z = dpiScale.value;
      let left = r.left / z;
      let top = r.bottom / z + ANCHOR_GAP_PX;
      if (top + h > window.innerHeight / z - EDGE_MARGIN_PX) top = r.top / z - ANCHOR_GAP_PX - h;
      left = Math.min(
        Math.max(left, EDGE_MARGIN_PX),
        Math.max(window.innerWidth / z - w - EDGE_MARGIN_PX, EDGE_MARGIN_PX),
      );
      top = Math.max(top, EDGE_MARGIN_PX);
      cardPos.value = {
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        zIndex: popupZ,
      };
    }

    function scheduleShow(e: Event): void {
      clearShowTimer();
      // currentTarget is null after dispatch — capture the element inside
      // the handler and hand it to the delayed show.
      const anchor = e.currentTarget as HTMLElement | null;
      if (!anchor) return;
      showTimer = window.setTimeout(() => void show(anchor), SHOW_DELAY_MS);
    }

    function openTactics(): void {
      if (cleanId.value == null || !analysable.value) return;
      hideNow();
      void router.push({ path: "/tactics", query: { map: cleanId.value } });
    }

    // The hover/focus wiring rides ONE spread bag, not named JSX props:
    // AppTag's type table only declares the props it owns, while these are
    // native listeners Vue's attr fallthrough lands on the button it
    // renders — the element the caller's layout hook and the card
    // measuring both use.
    const interactWiring = {
      onPointerenter: scheduleShow,
      onPointerdown: () => (pointerDownAt = performance.now()),
      onPointerleave: hideNow,
      onFocus: (e: FocusEvent) => {
        if (performance.now() - pointerDownAt < 300) return;
        void show(e.currentTarget as HTMLElement);
      },
      onBlur: hideNow,
    };

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

    // Callers pass their layout hook as class (live-battle__map and
    // replay-view__map only position the tag inside their header rows —
    // the chip face itself is AppTag's) — but the teleported card makes
    // this a multi-root component, so Vue skips fallthrough entirely and
    // the class must be merged by hand (the AssetImage pattern). On the
    // interactive face AppTag moves the merged class onto its BUTTON (the
    // face span must not duplicate the host attrs), which is exactly the
    // element the layout hook and the card measuring both want.
    return () => (
      <>
        {analysable.value ? (
          <AppTag
            interactive
            face="soft"
            tone="accent"
            class={["map-tag", attrs.class]}
            {...interactWiring}
            onClick={openTactics}
          >
            <Map size={13} />
            {name.value}
          </AppTag>
        ) : (
          <AppTag face="outline" tone="default" class={["map-tag", "map-tag--plain", attrs.class]}>
            <Map size={13} />
            {name.value}
          </AppTag>
        )}
        {analysable.value && open.value ? (
          <Teleport to="body">
            <div ref={cardEl} class="map-tag__card" style={cardPos.value} role="tooltip">
              {thumbUrl.value ? (
                <img
                  class="map-tag__card-img"
                  src={thumbUrl.value}
                  alt=""
                  draggable={false}
                  onError={noteMapMinimapLoadError}
                />
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
