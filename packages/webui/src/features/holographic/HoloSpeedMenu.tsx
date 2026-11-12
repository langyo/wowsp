/**
 * Playback-speed menu of the replay HUD (bottom playback bar).
 *
 * Extracted from HolographicMap.tsx the same way HoloCameraMenu was: pure
 * rendering over an explicit props snapshot, the open flag and the current
 * multiplier owned by the parent.
 *
 * STRICTLY hikari components, one surface:
 *   HkPopover  — the anchored card above the trigger (glass, border,
 *                radius, shadow, pop motion) and the phone bottom sheet
 *                (scrim, grabber, title, ~44px touch rows).
 *   HkMenuPanel / HkMenuActionItem — the menu row grammar (role=menu list,
 *                metric/states/checked-face per hikari's _menu-item spec).
 * The host contributes ONLY the hud palette, through the popover's own
 * class hook (.holo-map__speed-pop in HolographicMap.scss) — a host-drawn
 * card inside the popover panel reads as a panel-in-a-panel, which is the
 * 2026-11-12 user report this replaced.
 */
import { defineComponent, ref, type PropType } from "vue";
import { HkMenuActionItem, HkMenuPanel, HkPopover } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";

/** The playback multipliers the transport offers, slow → fast. */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 3, 5, 10] as const;

export default defineComponent({
  name: "HoloSpeedMenu",
  props: {
    /** Current multiplier. */
    speed: { type: Number, required: true },
    /** Menu open state (v-model:open from the parent). */
    open: { type: Boolean, required: true },
    onToggleMenu: { type: Function as PropType<() => void>, required: true },
    onPickSpeed: { type: Function as PropType<(speed: number) => void>, required: true },
  },
  setup(props) {
    /** Anchor for the popover: the wrapper around the trigger button. */
    const triggerWrap = ref<HTMLSpanElement | null>(null);

    return () => (
      <div class="holo-map__speed">
        <span ref={triggerWrap} class="holo-map__speed-wrap">
          <button
            class="holo-map__speed-btn"
            aria-haspopup="menu"
            aria-expanded={props.open}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              props.onToggleMenu();
            }}
            data-hint={i18nT("replay.playbackSpeed")}
            aria-label={i18nT("replay.playbackSpeed")}
          >
            {props.speed}×
          </button>
        </span>
        <HkPopover
          class="holo-map__speed-pop"
          modelValue={props.open}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) props.onToggleMenu();
          }}
          anchorRef={triggerWrap.value}
          placement="top-start"
          sheetOnMobile
          title={i18nT("replay.playbackSpeed")}
        >
          <HkMenuPanel label={i18nT("replay.playbackSpeed")}>
            {PLAYBACK_SPEEDS.map((sp) => {
              const on = sp === props.speed;
              return (
                <HkMenuActionItem
                  key={sp}
                  label={sp + "×"}
                  active={on}
                  /* A single-select list is a radio group, and hikari's row
                     only maps `active` onto the visual [data-active] face:
                     the selection would be paint-only for assistive tech.
                     The attrs land on the row's own <button> (Vue merges
                     them last), so the row keeps hikari's grammar and gains
                     the menuitemradio role + checked state. */
                  {...{ role: "menuitemradio", "aria-checked": on ? "true" : "false" }}
                  onClick={() => props.onPickSpeed(sp)}
                />
              );
            })}
          </HkMenuPanel>
        </HkPopover>
      </div>
    );
  },
});
