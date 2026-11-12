/**
 * PinnedAnchorCard — the sidebar family's anchored hint card on hikari's
 * HkPopover (issue #1736's pinned-card family: GatewayCaptchaHint and
 * PluginUpdateHint previously carried two verbatim copies of the same
 * hand-rolled fixed card — Teleport-to-body, snapshot-the-anchor-then-
 * applyStyle math, resize + DPI-scale re-anchor watches — which this
 * primitive retires).
 *
 * HkPopover owns everything the copies hand-rolled: the teleport into the
 * overlay root, measure-then-place (flip, clamp, the root DPI zoom's local
 * space — see its ancestorZoom notes), the popup-registry z slot, resize /
 * anchor-swap re-anchoring and the enter/leave pop motion (the surface
 * machine runs useSurfaceTransition underneath). The card keeps the app's
 * pinned-hint look (20rem app-surface card, the `.pinned-anchor-card` skin)
 * and the family's interaction contract: no backdrop, no outside-click or
 * Escape dismissal — pinned cards close through their own minimize/pin
 * logic, and hover intent is the HOST's business (the mouseenter/mouseleave
 * re-exports are the anchor↔card travel bridge the hints schedule around).
 */
import { defineComponent, type PropType, type Ref } from "vue";
import { HkPopover, type PopupPlacement } from "@celestia-island/hikari";

import "./PinnedAnchorCard.scss";

export default defineComponent({
  name: "PinnedAnchorCard",
  props: {
    modelValue: { type: Boolean, required: true },
    /** The element the card anchors to (the sidebar's game-status card).
     *  A Ref, not a bare element: the anchor's IDENTITY can swap while the
     *  card is up (the status card's running/offline branches), and
     *  HkPopover re-observes + re-places on every swap it sees. */
    anchor: {
      type: Object as PropType<Ref<HTMLElement | null | undefined>>,
      default: undefined,
    },
    placement: { type: String as PropType<PopupPlacement>, default: "right" },
    /** Gap between the anchor's edge and the card. */
    offset: { type: Number, default: 10 },
    /** Panel aria-label / popup-registry surface name. */
    title: { type: String, default: "" },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    /** Card-side hover intent (the anchor↔card travel bridge). */
    mouseenter: (_event: MouseEvent) => true,
    mouseleave: (_event: MouseEvent) => true,
  },
  setup(props, { emit, slots }) {
    return () => (
      <HkPopover
        class="pinned-anchor-card"
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        anchorRef={props.anchor?.value ?? null}
        placement={props.placement}
        offset={props.offset}
        backdrop={false}
        closeOnBackdrop={false}
        closeOnEscape={false}
        glass={false}
        title={props.title}
        onMouseenter={(event: MouseEvent) => emit("mouseenter", event)}
        onMouseleave={(event: MouseEvent) => emit("mouseleave", event)}
      >
        {slots.default?.()}
      </HkPopover>
    );
  },
});
