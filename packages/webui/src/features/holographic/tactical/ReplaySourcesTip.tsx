/**
 * Hover provenance chip for a measured cap layout: shows the replay count,
 * and hovering reveals the full file list in a scrollable panel. HkPopover
 * owns the anchored placement (viewport flip, clamping and the root DPI
 * zoom's local space), the popup-registry layer that clears the wizard
 * modal, and the panel's whole-surface hover intent — the chip keeps only
 * the small anchor-side grace timer so the pointer may travel INTO the
 * panel to scroll it across the gap. Works for a single replay the same
 * way.
 */
import { defineComponent, onBeforeUnmount, ref, type PropType } from "vue";
import { HkPopover, HkScrollContainer } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import type { LearnedReplaySource } from "@/api";
import "./ReplaySourcesTip.scss";

/** Hover grace across the anchor↔panel gap (kept from the hand-rolled tip). */
export const GRACE_MS = 200;

export default defineComponent({
  name: "ReplaySourcesTip",
  props: {
    /** Chip label (already localized, includes the count). */
    label: { type: String, required: true },
    replays: { type: Array as PropType<LearnedReplaySource[]>, default: () => [] },
  },
  setup(props) {
    const anchorRef = ref<HTMLElement | null>(null);
    const open = ref(false);
    let graceTimer = 0;

    function cancelClose(): void {
      if (graceTimer) window.clearTimeout(graceTimer);
      graceTimer = 0;
    }
    function enter(): void {
      cancelClose();
      if (props.replays.length > 0) open.value = true;
    }
    function leave(): void {
      cancelClose();
      graceTimer = window.setTimeout(() => {
        graceTimer = 0;
        open.value = false;
      }, GRACE_MS);
    }
    // HkPopover's own closes (Esc — a hover tip runs without a backdrop)
    // land here; a hover re-entry simply re-opens.
    function sync(v: boolean): void {
      if (v) enter();
      else {
        cancelClose();
        open.value = false;
      }
    }
    onBeforeUnmount(cancelClose);

    return () => (
      <span
        ref={anchorRef}
        class="rs-tip"
        onPointerenter={enter}
        onPointerleave={leave}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <span class="rs-tip__chip">{props.label}</span>
        <HkPopover
          modelValue={open.value}
          onUpdate:modelValue={sync}
          anchorRef={anchorRef.value}
          placement="bottom-start"
          offset={8}
          backdrop={false}
          sheetOnMobile
          title={i18nT("tactics.setup.replaysTooltip", { n: props.replays.length })}
          onMouseenter={cancelClose}
          onMouseleave={leave}
        >
          <div class="rs-tip__head">
            {i18nT("tactics.setup.replaysTooltip", { n: props.replays.length })}
          </div>
          {/* Scroll region: hikari's HkScrollContainer owns the
              scrollbar (auto-hiding overlay track). */}
          <HkScrollContainer class="rs-tip__list">
            {props.replays.map((r, i) => (
              <div class="rs-tip__item" key={`${r.name}-${i}`}>
                <span class="rs-tip__name" data-hint={r.name}>
                  {r.name}
                </span>
                {r.time ? <span class="rs-tip__time">{r.time}</span> : null}
              </div>
            ))}
          </HkScrollContainer>
        </HkPopover>
      </span>
    );
  },
});
