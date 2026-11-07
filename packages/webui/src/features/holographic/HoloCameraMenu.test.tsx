/**
 * Tests for the camera-mode dropdown's replay-camera additions:
 *
 *  - ordinary ship rows keep their identity: tier numeral + class + HP meta
 *    line, the player name, the WR stats readout and the follow callback;
 *  - carrier air-group rows (`kind: "plane"`) draw the plane glyph, the
 *    carrier label and the aircraft subtitle, put the group name on the
 *    right, show NO tier/class/HP/stats, and follow through the same
 *    onPickShip callback (selected state compared by the synthesized
 *    plane entity id);
 *  - the recorded-camera caption under the mode buttons localizes every
 *    decoder mode and degrades unknown ones to the generic "other view";
 *  - the jump-to-nearest-aircraft shortcut renders only when the replay
 *    carries a plane camera window and fires its callback on click.
 *
 * The popover/scroll chrome is hikari's — the stubs render the slots inline
 * (HkPopover only while open), the established pattern for menu components
 * whose real panel teleports to body.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h, type VNode } from "vue";

vi.mock("@celestia-island/hikari", () => ({
  HkPopover: {
    name: "HkPopover",
    props: ["modelValue", "title", "anchorRef", "placement", "sheetOnMobile"],
    setup(
      props: { modelValue: boolean },
      { slots }: { slots: { default?: () => VNode[] } },
    ) {
      return () =>
        props.modelValue ? h("div", { class: "pop-stub" }, slots.default?.()) : null;
    },
  },
  HkScrollContainer: {
    name: "HkScrollContainer",
    setup(_: unknown, { slots }: { slots: { default?: () => VNode[] } }) {
      return () => h("div", slots.default?.());
    },
  },
}));

import { initLocaleMessages, t as i18nT } from "@/i18n";
import { tierToRoman } from "@wowsp/holo";
import type { RecordedCameraMode } from "./cameraModes";
import HoloCameraMenu, { type CameraShipGroup } from "./HoloCameraMenu";
import type { ShipLabel } from "./shipLabel";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

/** A minimal follow-menu row — the menu reads identity/tier/type/HP/kind. */
const label = (over: Partial<ShipLabel>): ShipLabel => ({
  entityId: 1,
  role: "ally",
  name: "",
  shipName: "",
  tier: null,
  type: null,
  hp: null,
  maxHp: null,
  x: 0,
  y: 0,
  visible: true,
  dead: false,
  status: null,
  belowX: 0,
  belowY: 0,
  belowVisible: false,
  ...over,
});

const SHIP = label({
  entityId: 10,
  role: "ally",
  name: "alpha",
  shipName: "Izumo",
  tier: 8,
  type: "Cruiser",
  maxHp: 66_000,
});

/** Aircraft rows use a synthesized id above the ship id range (the parent
 *  builds `2e9 + carrierId`), which the selection comparison must match. */
const PLANE = label({
  entityId: 2_000_000_001,
  role: "enemy",
  name: "beta",
  shipName: "Hakuryū",
  kind: "plane",
  planeType: "torpedo",
});

function mountMenu(
  over: {
    mode?: "free" | "original" | "follow";
    groups?: CameraShipGroup[];
    followStats?: Map<number, string>;
    selectedId?: number | null;
    recordedMode?: RecordedCameraMode | null;
    hasPlaneCameraWindow?: boolean;
  } = {},
) {
  const onPickShip = vi.fn();
  const onJumpPlaneCamera = vi.fn();
  const onPickMode = vi.fn();
  const onToggleMenu = vi.fn();
  const wrapper = mount(HoloCameraMenu, {
    props: {
      mode: over.mode ?? "original",
      open: true,
      hasOriginalFrames: true,
      groups: over.groups ?? [{ key: "self", title: "Me", items: [SHIP] }],
      followStats: over.followStats ?? new Map<number, string>(),
      selectedId: over.selectedId ?? null,
      recordedMode: over.recordedMode ?? null,
      hasPlaneCameraWindow: over.hasPlaneCameraWindow ?? false,
      onToggleMenu,
      onPickMode,
      onPickShip,
      onJumpPlaneCamera,
    },
  });
  return { wrapper, onPickShip, onJumpPlaneCamera, onPickMode, onToggleMenu };
}

describe("HoloCameraMenu ship rows", () => {
  it("keeps the tier·class·HP meta, name, stats readout and follow callback", async () => {
    const { wrapper, onPickShip } = mountMenu({
      groups: [{ key: "ally", title: "Allies", items: [SHIP] }],
      followStats: new Map([[SHIP.entityId, "54% · 128"]]),
    });
    const row = wrapper.find(".holo-map__cam-item");
    expect(row.exists()).toBe(true);
    expect(row.classes()).not.toContain("holo-map__cam-item--plane");
    expect(row.find(".holo-map__cam-ship").text()).toBe("Izumo");
    const meta = row.find(".holo-map__cam-meta").text();
    expect(meta).toContain(tierToRoman(8));
    expect(meta).toContain(i18nT("replay.classes.cruiser"));
    expect(meta).toContain("66,000 HP");
    expect(row.find(".holo-map__cam-name").text()).toBe("alpha");
    expect(row.find(".holo-map__cam-stats").text()).toBe("54% · 128");
    expect(row.find(".holo-map__cam-ico img").attributes("src")).toContain(
      "icon_ally_cruiser.svg",
    );
    await row.trigger("click");
    expect(onPickShip).toHaveBeenCalledWith(SHIP.entityId);
  });
});

describe("HoloCameraMenu aircraft rows", () => {
  it("draws the plane glyph, carrier label and aircraft subtitle, group name on the right, no stats", async () => {
    const { wrapper, onPickShip } = mountMenu({
      groups: [{ key: "enemy", title: "Enemies", items: [PLANE] }],
      // A plane id never has a WR readout — even if one leaks in, the row
      // must not render the stats column.
      followStats: new Map([[PLANE.entityId, "99% · 1"]]),
    });
    const row = wrapper.find(".holo-map__cam-item--plane");
    expect(row.exists()).toBe(true);
    expect(row.find(".holo-map__cam-ship").text()).toBe("Hakuryū");
    expect(row.find(".holo-map__cam-meta").text()).toBe(i18nT("replay.camera.aircraft"));
    expect(row.find(".holo-map__cam-name").text()).toBe("beta");
    // No ship-only readouts on an air group.
    expect(row.find(".holo-map__cam-stats").exists()).toBe(false);
    expect(row.text()).not.toContain("HP");
    const icon = row.find(".holo-map__cam-ico img");
    expect(icon.attributes("width")).toBe("13");
    expect(icon.attributes("height")).toBe("13");
    expect(icon.attributes("src")).toContain("torpedo_regular_ally.webp");
    await row.trigger("click");
    expect(onPickShip).toHaveBeenCalledWith(PLANE.entityId);
  });

  it("matches the selected state by the synthesized plane entity id", () => {
    const selected = mountMenu({
      groups: [{ key: "enemy", title: "Enemies", items: [PLANE] }],
      selectedId: PLANE.entityId,
    });
    expect(
      selected.wrapper.find(".holo-map__cam-item--plane").classes(),
    ).toContain("holo-map__cam-item--on");

    const other = mountMenu({
      groups: [{ key: "enemy", title: "Enemies", items: [PLANE] }],
      selectedId: SHIP.entityId,
    });
    expect(
      other.wrapper.find(".holo-map__cam-item--plane").classes(),
    ).not.toContain("holo-map__cam-item--on");
  });

  it("falls back to the attack glyph for a plane without a type", () => {
    const untyped = label({ ...PLANE, planeType: null });
    const { wrapper } = mountMenu({
      groups: [{ key: "enemy", title: "Enemies", items: [untyped] }],
    });
    expect(wrapper.find(".holo-map__cam-item--plane .holo-map__cam-ico img").attributes("src")).toContain(
      "auxiliary_ally.webp",
    );
  });
});

describe("HoloCameraMenu recorded camera caption", () => {
  it("renders the localized recorder mode under the mode buttons", () => {
    const { wrapper } = mountMenu({ recordedMode: "followingPlanes" });
    const caption = wrapper.find(".holo-map__cam-recorded");
    expect(caption.exists()).toBe(true);
    expect(caption.text()).toBe(
      i18nT("replay.camera.recorded", {
        mode: i18nT("replay.camera.mode.followingPlanes"),
      }),
    );
    // Under the buttons, above the roster rows.
    const inner = wrapper.find(".holo-map__cam-menu-inner").element;
    const kids = Array.from(inner.children);
    expect(kids.indexOf(wrapper.find(".holo-map__cam-modes").element)).toBeLessThan(
      kids.indexOf(caption.element),
    );
  });

  it("localizes every decoded recorder mode", () => {
    const modes = [
      "airplanes",
      "followingPlanes",
      "followingShip",
      "followingShells",
      "freeFlying",
      "overheadMap",
    ] as const;
    for (const mode of modes) {
      const { wrapper } = mountMenu({ recordedMode: mode });
      expect(wrapper.find(".holo-map__cam-recorded").text()).toBe(
        i18nT("replay.camera.recorded", { mode: i18nT(`replay.camera.mode.${mode}`) }),
      );
    }
  });

  it("degrades an unknown recorder mode to the other-view label", () => {
    const { wrapper } = mountMenu({
      recordedMode: "cinematic" as RecordedCameraMode,
    });
    expect(wrapper.find(".holo-map__cam-recorded").text()).toBe(
      i18nT("replay.camera.recorded", { mode: i18nT("replay.camera.mode.other") }),
    );
  });

  it("renders no caption when the replay carries no recorder-camera mode", () => {
    const { wrapper } = mountMenu({ recordedMode: null });
    expect(wrapper.find(".holo-map__cam-recorded").exists()).toBe(false);
  });
});

describe("HoloCameraMenu jump-to-aircraft shortcut", () => {
  it("renders the button only with a plane camera window and fires its callback", async () => {
    const { wrapper, onJumpPlaneCamera } = mountMenu({ hasPlaneCameraWindow: true });
    const button = wrapper.find(".holo-map__cam-planejump");
    expect(button.exists()).toBe(true);
    expect(button.text()).toBe(i18nT("replay.camera.jumpPlaneCamera"));
    expect(button.find("svg").exists()).toBe(true);
    await button.trigger("click");
    expect(onJumpPlaneCamera).toHaveBeenCalledTimes(1);

    const none = mountMenu({ hasPlaneCameraWindow: false });
    expect(none.wrapper.find(".holo-map__cam-planejump").exists()).toBe(false);
  });
});
