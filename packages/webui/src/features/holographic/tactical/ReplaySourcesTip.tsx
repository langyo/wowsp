/**
 * Hover provenance chip for a measured cap layout: shows the replay count,
 * and hovering reveals the full file list in a scrollable panel (hikari's
 * overlay root + tooltip band, so it layers above the wizard modal; the
 * pointer may travel INTO the panel to scroll it — a grace timer keeps it
 * open across the gap). Works for a single replay the same way.
 */
import {
  Teleport,
  defineComponent,
  onBeforeUnmount,
  ref,
  type CSSProperties,
  type PropType,
} from "vue";
import { HkScrollContainer, OVERLAY_Z, ensureOverlayRoot } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import type { LearnedReplaySource } from "@/api";
import "./ReplaySourcesTip.scss";

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
    const style = ref<CSSProperties | null>(null);
    let closeTimer = 0;

    function cancelClose(): void {
      if (closeTimer) window.clearTimeout(closeTimer);
      closeTimer = 0;
    }
    function show(): void {
      cancelClose();
      const el = anchorRef.value;
      if (!el || props.replays.length === 0) return;
      const r = el.getBoundingClientRect();
      // Open downward; flip above the chip when the viewport's bottom
      // cannot host the panel's max height.
      const below = r.bottom + 8;
      const flip = r.bottom + 244 > window.innerHeight;
      style.value = {
        left: `${Math.max(6, Math.min(r.left, window.innerWidth - 274))}px`,
        top: flip ? `${Math.max(6, r.top - 8)}px` : `${below}px`,
        ...(flip ? { transform: "translateY(-100%)" } : null),
      };
      open.value = true;
    }
    function hideSoon(): void {
      cancelClose();
      closeTimer = window.setTimeout(() => (open.value = false), 200);
    }
    onBeforeUnmount(cancelClose);

    return () => (
      <span
        ref={anchorRef}
        class="rs-tip"
        onPointerenter={show}
        onPointerleave={hideSoon}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <span class="rs-tip__chip">{props.label}</span>
        {open.value && props.replays.length > 0 ? (
          <Teleport to={ensureOverlayRoot()}>
            <div
              class="rs-tip__panel"
              style={{ ...style.value, zIndex: OVERLAY_Z.tooltip }}
              onPointerenter={cancelClose}
              onPointerleave={hideSoon}
            >
              <div class="rs-tip__head">
                {i18nT("tactics.setup.replaysTooltip", { n: props.replays.length })}
              </div>
              {/* Scroll region: hikari's HkScrollContainer owns the
                  scrollbar (auto-hiding overlay track). */}
              <HkScrollContainer class="rs-tip__list">
                {props.replays.map((r, i) => (
                  <div class="rs-tip__item" key={`${r.name}-${i}`}>
                    <span class="rs-tip__name" title={r.name}>
                      {r.name}
                    </span>
                    {r.time ? <span class="rs-tip__time">{r.time}</span> : null}
                  </div>
                ))}
              </HkScrollContainer>
            </div>
          </Teleport>
        ) : null}
      </span>
    );
  },
});
