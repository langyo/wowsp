/**
 * DateRangeTabs — the shared "presets + 自定义" date-range strip. These tests
 * pin the contract its hosts rely on:
 *  - one radio per option in display order, and a preset click emits the mode
 *    WITHOUT opening the picker popover;
 *  - the 自定义 segment opens the day-pair popover; Escape / an outside press
 *    closes it while the mode stays custom;
 *  - re-clicking the already-active 自定义 segment reopens the popover —
 *    HkTabs suppresses the update emit for the active key, so the wrapper
 *    click test is the only path (regression guard for the dead-press bug);
 *  - update:window stays null until BOTH ends are picked, then carries the
 *    inclusive local-day window `isoDayWindowSec` resolves (the exact window
 *    the hosts filter their data by);
 *  - leaving 自定义 closes the popover and keeps the picked pair for the next
 *    reopen.
 *
 * hikari's own primitives are stubbed the way the host suites do it: HkTabs
 * mirrors the real active-key guard and ARIA shape, HkPopover renders its
 * slot and exposes modelValue, HkDatePicker renders nothing but emits its
 * model. That keeps these assertions on THIS component's state machine rather
 * than on hikari's animation timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { h, type VNode } from "vue";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

vi.mock("@celestia-island/hikari", () => ({
  HkTabs: {
    name: "HkTabs",
    props: ["modelValue", "tabs", "variant"],
    emits: ["update:modelValue"],
    setup(
      props: { modelValue: string; tabs: { key: string; label: string }[] },
      { emit }: { emit: (ev: string, v: string) => void },
    ) {
      return () =>
        h(
          "div",
          (props.tabs ?? []).map((tb) =>
            h(
              "button",
              {
                key: tb.key,
                type: "button",
                role: "radio",
                "aria-checked": tb.key === props.modelValue ? "true" : "false",
                onClick: () => {
                  if (tb.key !== props.modelValue) emit("update:modelValue", tb.key);
                },
              },
              tb.label,
            ),
          ),
        );
    },
  },
  HkPopover: {
    name: "HkPopover",
    props: ["modelValue", "anchorRef", "placement", "title"],
    emits: ["update:modelValue"],
    setup(_: unknown, { slots }: { slots: { default?: () => VNode[] } }) {
      return () => h("div", { class: "hk-popover-panel" }, slots.default?.() ?? []);
    },
  },
  HkDatePicker: {
    name: "HkDatePicker",
    props: ["modelValue", "min", "max", "placeholder", "size"],
    emits: ["update:modelValue"],
    render: () => null,
  },
  useBreakpoint: () => ({ isMobile: { value: false } }),
}));

import DateRangeTabs from "./DateRangeTabs";
import { isoDayWindowSec } from "@/utils/shipAggregation";

enableAutoUnmount(afterEach);

const OPTIONS = [
  { key: "1d", label: "1D" },
  { key: "7d", label: "7D" },
  { key: "all", label: "All" },
  { key: "custom", label: "Custom" },
];

function mountTabs(modelValue = "all") {
  return mount(DateRangeTabs, {
    props: { modelValue, options: OPTIONS },
  });
}

const popover = (view: ReturnType<typeof mountTabs>) =>
  view.findComponent({ name: "HkPopover" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DateRangeTabs", () => {
  it("renders one radio per option and emits the mode on a preset click", async () => {
    const view = mountTabs();
    const radios = view.findAll('[role="radio"]');
    expect(radios.map((r) => r.text())).toEqual(["1D", "7D", "All", "Custom"]);

    await view.findAll('[role="radio"]')[1].trigger("click");
    expect(view.emitted("update:modelValue")?.[0]).toEqual(["7d"]);
    expect(popover(view).props("modelValue")).toBe(false);
  });

  it("opens the picker on the custom segment and closes it on an outside press", async () => {
    const view = mountTabs();
    expect(popover(view).props("modelValue")).toBe(false);

    await view.findAll('[role="radio"]')[3].trigger("click");
    expect(view.emitted("update:modelValue")?.[0]).toEqual(["custom"]);
    expect(popover(view).props("modelValue")).toBe(true);

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(popover(view).props("modelValue")).toBe(false);
  });

  it("reopens on a re-click of the already-active custom segment", async () => {
    const view = mountTabs("custom");
    // The active segment emits nothing (HkTabs guard) — the wrapper click is
    // the only way back in.
    const active = view.find('[role="radio"][aria-checked="true"]');
    expect(active.text()).toBe("Custom");
    expect(popover(view).props("modelValue")).toBe(false);
    await active.trigger("click");
    expect(view.emitted("update:modelValue")).toBeUndefined();
    expect(popover(view).props("modelValue")).toBe(true);
  });

  it("emits the window only once both ends are picked", async () => {
    const view = mountTabs("custom");
    const pickers = view.findAllComponents({ name: "HkDatePicker" });
    expect(pickers).toHaveLength(2);

    await pickers[0].vm.$emit("update:modelValue", "2026-10-01");
    await flushPromises();
    // Half a pair is not a window — the host must stay unfiltered.
    expect(view.emitted("update:window")?.every(([w]) => w === null)).toBe(true);

    await pickers[1].vm.$emit("update:modelValue", "2026-10-20");
    await flushPromises();
    const emitted = view.emitted("update:window")!;
    expect(emitted[emitted.length - 1][0]).toEqual(
      isoDayWindowSec("2026-10-01", "2026-10-20"),
    );
  });

  it("closes the picker when the host flips the mode away and keeps the picked pair", async () => {
    const view = mountTabs();
    await view.findAll('[role="radio"]')[3].trigger("click");
    const pickers = view.findAllComponents({ name: "HkDatePicker" });
    await pickers[0].vm.$emit("update:modelValue", "2026-10-01");
    await pickers[1].vm.$emit("update:modelValue", "2026-10-20");
    await flushPromises();
    expect(popover(view).props("modelValue")).toBe(true);

    // A host-side mode flip (a route restore, a programmatic reset) closes the
    // picker but never clears what was picked.
    await view.setProps({ modelValue: "7d" });
    await flushPromises();
    expect(popover(view).props("modelValue")).toBe(false);
    expect(view.findAllComponents({ name: "HkDatePicker" })[0].props("modelValue")).toBe("2026-10-01");
    expect(view.findAllComponents({ name: "HkDatePicker" })[1].props("modelValue")).toBe("2026-10-20");
  });

  it("renders the host-provided hint in the picker panel", () => {
    const view = mount(DateRangeTabs, {
      props: { modelValue: "custom", options: OPTIONS, hint: "picked-hint" },
    });
    expect(view.find(".date-range-pop-hint").text()).toBe("picked-hint");
  });
});
