/**
 * Tests for the playback-speed menu.
 *
 * The menu must be ONE hikari surface: hikari's HkPopover owns the card
 * (and the phone sheet) and hikari's menu rows own the row grammar. The
 * 2026-11-12 user report was a doubled panel — a host-drawn card nested in
 * the popover's own card — so these tests assert both halves of the
 * contract:
 *
 *  - the popup CONTENT is hikari's menu list, with one row per playback
 *    multiplier, the current one carrying the row grammar's active face;
 *  - the host's popup content adds NO surface element of its own (no
 *    wrapper carrying a background/border/inset — that is the bug);
 *  - picking a row reports the multiplier, and a dismissed popover
 *    (backdrop, Escape, the phone sheet's ✕) only reports the close.
 *
 * The popover/panel chrome is hikari's, so it is stubbed the way the house
 * menu tests do it (the real panel teleports to body and cannot be reached
 * from the wrapper): HkPopover renders its slot inline while open, the menu
 * list and rows render as the real components.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h, type VNode } from "vue";

vi.mock("@celestia-island/hikari", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@celestia-island/hikari")>();
  return {
    ...actual,
    HkPopover: {
      name: "HkPopover",
      props: ["modelValue", "title", "anchorRef", "placement", "sheetOnMobile"],
      setup(
        props: { modelValue: boolean },
        { slots }: { slots: { default?: () => VNode[] } },
      ) {
        return () =>
          props.modelValue
            ? h("div", { class: "pop-stub hii-dropdown-content" }, slots.default?.())
            : null;
      },
    },
  };
});

import { initLocaleMessages, t as i18nT } from "@/i18n";
import HoloSpeedMenu, { PLAYBACK_SPEEDS } from "./HoloSpeedMenu";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

function mountMenu(over: { speed?: number; open?: boolean } = {}) {
  const onToggleMenu = vi.fn();
  const onPickSpeed = vi.fn();
  const wrapper = mount(HoloSpeedMenu, {
    props: {
      speed: over.speed ?? 2,
      open: over.open ?? true,
      onToggleMenu,
      onPickSpeed,
    },
  });
  return { wrapper, onToggleMenu, onPickSpeed };
}

describe("HoloSpeedMenu", () => {
  it("lists every playback multiplier as a hikari menu row", () => {
    const { wrapper } = mountMenu();
    const rows = wrapper.findAll(".hk-menu-action-item");
    expect(rows).toHaveLength(PLAYBACK_SPEEDS.length);
    expect(rows.map((r) => r.text())).toEqual(PLAYBACK_SPEEDS.map((sp) => sp + "×"));
  });

  it("marks the current multiplier with the row grammar's active face", () => {
    const { wrapper } = mountMenu({ speed: 3 });
    const rows = wrapper.findAll(".hk-menu-action-item");
    const active = rows.filter((r) => r.attributes("data-active") === "true");
    expect(active).toHaveLength(1);
    expect(active[0].text()).toBe("3×");
    // The list itself is hikari's menu surface (role=menu + label).
    expect(wrapper.find(".hk-menu-list").attributes("role")).toBe("menu");
    expect(wrapper.find(".hk-menu-list").attributes("aria-label")).toBe(
      i18nT("replay.playbackSpeed"),
    );
  });

  it("exposes the selection as a radio group, not paint only", () => {
    const { wrapper } = mountMenu({ speed: 1 });
    const rows = wrapper.findAll(".hk-menu-action-item");
    expect(rows.map((r) => r.attributes("role"))).toEqual(
      rows.map(() => "menuitemradio"),
    );
    const checked = rows.filter((r) => r.attributes("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0].text()).toBe("1×");
  });

  it("adds no host-drawn surface around the hikari rows", () => {
    const { wrapper } = mountMenu();
    const list = wrapper.find(".hk-menu-list").element;
    // Walking up to the popover's slot root, every element on the way is
    // hikari's own chrome or the stub host — never a host card.
    const hostClasses = [...wrapper.element.querySelectorAll("*")]
      .map((el) => el.className)
      .filter((c): c is string => typeof c === "string");
    expect(hostClasses.some((c) => c.includes("speed-menu"))).toBe(false);
    expect(hostClasses.some((c) => c.includes("speed-opt"))).toBe(false);
    expect(list).toBeTruthy();
  });

  it("reports the picked multiplier", async () => {
    const { wrapper, onPickSpeed } = mountMenu();
    const rows = wrapper.findAll(".hk-menu-action-item");
    await rows[4].trigger("click"); // 5×
    expect(onPickSpeed).toHaveBeenCalledWith(PLAYBACK_SPEEDS[4]);
  });

  it("toggles from the trigger and reports its open state", async () => {
    const { wrapper, onToggleMenu } = mountMenu({ open: false });
    const trigger = wrapper.find(".holo-map__speed-btn");
    expect(trigger.text()).toBe("2×");
    expect(trigger.attributes("aria-haspopup")).toBe("menu");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    await trigger.trigger("click");
    expect(onToggleMenu).toHaveBeenCalledTimes(1);
  });

  it("reports a dismissal without picking anything", async () => {
    const { wrapper, onToggleMenu, onPickSpeed } = mountMenu();
    // HkPopover reports its own closes (backdrop / Escape / sheet ✕)
    // through the same v-model edge; the stub exposes that handler.
    const popover = wrapper.findComponent({ name: "HkPopover" });
    popover.vm.$emit("update:modelValue", false);
    expect(onToggleMenu).toHaveBeenCalledTimes(1);
    expect(onPickSpeed).not.toHaveBeenCalled();
  });
});
