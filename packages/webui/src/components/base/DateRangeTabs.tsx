/**
 * DateRangeTabs — the shared "date-range presets + 自定义" segmented strip.
 *
 * Renders hikari's segmented HkTabs and, for the trailing 自定义 segment, the
 * paired HkDatePicker popover that turns a [from, to] day pair into the
 * concrete second-based window a view filters by. Three water-meter surfaces
 * had grown their own copy of this block — the dashboard, the lookup page and
 * the playtime PR trend section — so this is the ONE implementation.
 *
 * Contract: the host owns the mode (`modelValue` + `update:modelValue`) and
 * receives the picker window through `update:window` (null until both ends
 * are picked, so a half-picked pair never filters anything). Everything else
 * — the popover's open/close, the re-click-to-reopen gesture (HkTabs
 * suppresses the update emit for the already-active segment), the outside-
 * close that lets the pickers' body-level calendars through, and the
 * desktop panel / phone sheet geometry — lives here.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType } from "vue";
import { HkDatePicker, HkPopover, HkTabs, useBreakpoint } from "@celestia-island/hikari";

import { isoDayWindowSec } from "@/utils/shipAggregation";
import { t } from "@/i18n";
import "./DateRangeTabs.scss";

export interface DateRangeOption {
  key: string;
  label: string;
}

/** Inclusive Unix-second window a picked day pair resolves to. */
export interface DateRangeWindow {
  fromSec: number;
  toSec: number;
}

export default defineComponent({
  name: "DateRangeTabs",
  props: {
    /** Active segment key. */
    modelValue: { type: String, required: true },
    /** Segment list in display order — the 自定义 one must be last. */
    options: { type: Array as PropType<DateRangeOption[]>, required: true },
    /** Segment that opens the picker popover. */
    customKey: { type: String, default: "custom" },
    /** Bottom hint line of the popover. Host-provided on purpose: the
     *  water-meter copy and the PR trend's differ. Left unresolved so the
     *  built-in fallback still follows a live locale switch (the render
     *  below reads `t` reactively). */
    hint: { type: String, default: undefined },
  },
  emits: {
    "update:modelValue": (_v: string) => true,
    "update:window": (_w: DateRangeWindow | null) => true,
  },
  setup(props, { emit }) {
    const { isMobile } = useBreakpoint();
    /** Picker state (ISO YYYY-MM-DD) — session-only, reset when the host
     *  remounts the strip. The pickers cross-link min/max so an inverted
     *  pair can never form. */
    const customFrom = ref<string | null>(null);
    const customTo = ref<string | null>(null);
    const customOpen = ref(false);

    const windowValue = computed<DateRangeWindow | null>(() =>
      customFrom.value && customTo.value
        ? isoDayWindowSec(customFrom.value, customTo.value)
        : null,
    );
    watch(windowValue, (w) => emit("update:window", w), { immediate: true });

    const tabsRef = ref<HTMLElement | null>(null);
    const panelRef = ref<HTMLElement | null>(null);

    function onTabUpdate(v: string) {
      emit("update:modelValue", v);
      customOpen.value = v === props.customKey;
    }

    /** HkTabs suppresses the update emit when the clicked segment is already
     *  active, so after the popover closed while 自定义 stayed selected,
     *  re-clicking that segment would be a dead press — yet it's the natural
     *  "reopen" gesture. Catch it on the wrapper: while custom is the active
     *  radio, a click on the checked segment is exactly that re-click (a
     *  differing segment first flips the mode via the emit, so the early
     *  return skips it). */
    function onTabsClick(e: MouseEvent) {
      if (props.modelValue !== props.customKey) return;
      const seg = (e.target as HTMLElement).closest?.("[role='radio']");
      if (seg instanceof HTMLElement && seg.getAttribute("aria-checked") === "true") {
        customOpen.value = true;
      }
    }

    // The mode can also move from the host (a route flip restoring an earlier
    // selection): leaving 自定义 closes the picker.
    watch(
      () => props.modelValue,
      (v) => {
        if (v !== props.customKey) customOpen.value = false;
      },
    );

    /** Outside-close (desktop: the sheet branch carries its own scrim): the
     *  teleported panel and the pickers' own body-level calendar popups count
     *  as inside presses. */
    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (tabsRef.value?.contains(target)) return;
      if (panelRef.value?.contains(target)) return;
      for (const panel of document.querySelectorAll<HTMLElement>(".hk-popover-panel")) {
        if (panel.contains(target)) return;
      }
      customOpen.value = false;
    }

    watch(customOpen, (open) => {
      if (open) document.addEventListener("pointerdown", onDocPointerDown, true);
      else document.removeEventListener("pointerdown", onDocPointerDown, true);
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
    });

    return () => (
      <div class="date-range-tabs" ref={tabsRef} onClick={onTabsClick}>
        <HkTabs
          variant="segmented"
          modelValue={props.modelValue}
          onUpdate:modelValue={onTabUpdate}
          tabs={props.options.map((o) => ({ key: o.key, label: o.label }))}
        />
        {/* Desktop keeps closeOnBackdrop off — the document-level pointerdown
            test above is the outside-close and Escape rides closeOnEscape;
            phones dock as a bottom sheet whose scrim then closes. */}
        <HkPopover
          modelValue={customOpen.value}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) customOpen.value = false;
          }}
          anchorRef={tabsRef.value}
          placement="bottom-end"
          closeOnBackdrop={isMobile.value}
          sheetOnMobile
          padding="lg"
          title={t("dashboard.rangeCustom")}
        >
          <div ref={panelRef} class="date-range-pop">
            <div class="date-range-pop-head">
              <span>{t("dashboard.rangeCustom")}</span>
            </div>
            <div class="date-range-pop-dates">
              <HkDatePicker
                size="sm"
                modelValue={customFrom.value}
                onUpdate:modelValue={(v: string | null) => (customFrom.value = v)}
                placeholder={t("dashboard.rangeFrom")}
                max={customTo.value ?? undefined}
              />
              <HkDatePicker
                size="sm"
                modelValue={customTo.value}
                onUpdate:modelValue={(v: string | null) => (customTo.value = v)}
                placeholder={t("dashboard.rangeTo")}
                min={customFrom.value ?? undefined}
              />
            </div>
            <div class="date-range-pop-hint">
              {props.hint ?? t("dashboard.rangeCustomHint")}
            </div>
          </div>
        </HkPopover>
      </div>
    );
  },
});
