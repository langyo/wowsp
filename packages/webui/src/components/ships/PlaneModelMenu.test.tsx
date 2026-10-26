/**
 * Tests for the grouped airframe picker menu (PlaneModelMenu).
 *
 * The ship-detail stage's dropdown lists the hull first, then the carrier's
 * baked airframes grouped under their combat-role heading (torpedo / AP
 * bomber / rocket …), each row naming the aircraft model designation plus a
 * tiny base/variant tag. Pinned here:
 *
 *  - the hull option comes first and is the only pre-selected row of a
 *    fresh picker;
 *  - one role group per role, heading first and groups in row order;
 *  - every airframe row shows its designation and version tag, the tag
 *    class carrying the rank;
 *  - the ungrouped bucket (a role plane_types.json does not map) renders
 *    rows with no heading and no tag;
 *  - clicking a row emits `select` with that row's value;
 *  - the row title keeps the clipped designation readable (role · model ·
 *    tag).
 *
 * "@/i18n" is mocked to stable English literals so the assertions pin the
 * component structure without loading locale bundles.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import type { PlaneModelOption } from "./shipSquadrons";

import PlaneModelMenu from "./PlaneModelMenu";

vi.mock("@/i18n", () => {
  const messages: Record<string, string> = {
    "ships.detail.stage.hull": "Hull",
    "ships.detail.stage.modelPicker": "Choose model to view",
    "ships.plane.torpedo": "Torpedo bombers",
    "ships.plane.apBomber": "AP bombers",
    "ships.plane.rocket": "Rocket planes",
    "ships.plane.cfg.base": "Base",
    "ships.plane.cfg.variant": "Variant",
  };
  return {
    t: (key: string) => messages[key] ?? key,
    // The component probes with te() before translating a role heading.
    te: (key: string) => key in messages,
  };
});

enableAutoUnmount(afterEach);

function option(
  index: string,
  label: string,
  role: string,
  config: PlaneModelOption["config"],
): PlaneModelOption {
  return { index, label, role, config };
}

/** Hakuryu-shaped rows: one base + one variant airframe per role, already in
 *  the canonical order the labelling pipeline emits (role order, then
 *  version rank). */
const HAKURYU: PlaneModelOption[] = [
  option("PJAB110", "Nakajima C6N5 1b", "torpedo", "base"),
  option("PJAB111", "Nakajima C6N5 2b", "torpedo", "variant"),
  option("PJAB120", "Aichi B7A2 Ryusei", "apBomber", "base"),
  option("PJAB121", "Aichi B7A3 Ryusei Kai", "apBomber", "variant"),
  option("PJAB130", "Mitsubishi J8M Shusui", "rocket", "base"),
  option("PJAB131", "Mitsubishi J8M2 Shusui Kai", "rocket", "variant"),
];

function mountMenu(options: PlaneModelOption[], selected = "hull") {
  return mount(PlaneModelMenu, { props: { options, selected } });
}

describe("PlaneModelMenu", () => {
  it("lists the hull first, then every airframe in the shipped order", () => {
    const wrapper = mountMenu(HAKURYU);
    expect(wrapper.find('[role="listbox"]').attributes("aria-label")).toBe(
      "Choose model to view",
    );
    const rows = wrapper.findAll('[role="option"]');
    expect(rows).toHaveLength(HAKURYU.length + 1);
    expect(rows[0].text()).toBe("Hull");
    expect(rows[0].attributes("aria-selected")).toBe("true");
    expect(rows[0].classes()).toContain("is-active");
    expect(
      rows.slice(1).map((row) => row.find(".ship-stage__model-pick-item-label").text()),
    ).toEqual(HAKURYU.map((o) => o.label));
  });

  it("heads each role group with its localized role name, in row order", () => {
    const wrapper = mountMenu(HAKURYU);
    const groups = wrapper.findAll(".ship-stage__model-pick-group");
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.attributes("role"))).toEqual([
      "group",
      "group",
      "group",
    ]);
    expect(groups.map((group) => group.attributes("aria-label"))).toEqual([
      "Torpedo bombers",
      "AP bombers",
      "Rocket planes",
    ]);
    expect(
      wrapper.findAll(".ship-stage__model-pick-group-label").map((label) => label.text()),
    ).toEqual(["Torpedo bombers", "AP bombers", "Rocket planes"]);
    // Two airframes per role, heading before its rows.
    expect(groups.map((group) => group.findAll('[role="option"]').length)).toEqual([2, 2, 2]);
  });

  it("tags every airframe row with its base / variant rank", () => {
    const wrapper = mountMenu(HAKURYU);
    const airframeRows = wrapper.findAll('[role="option"]').slice(1);
    expect(
      airframeRows.map((row) => row.find(".ship-stage__model-pick-tag").text()),
    ).toEqual(["Base", "Variant", "Base", "Variant", "Base", "Variant"]);
    expect(airframeRows[0].find(".ship-stage__model-pick-tag").classes()).toContain("is-base");
    expect(airframeRows[1].find(".ship-stage__model-pick-tag").classes()).toContain(
      "is-variant",
    );
  });

  it("drops the tags in a section mixing ranked and unranked airframes", () => {
    // Older "1942/1944" carrier configs field a stock patrol plane beside
    // aircraft-named squadrons; tagging half the section would read broken.
    const wrapper = mountMenu([
      option("PAAF108", "Grumman F6F", "rocket", "base"),
      option("PAAF029", "F8F Bearcat", "rocket", null),
    ]);
    expect(wrapper.findAll(".ship-stage__model-pick-tag")).toHaveLength(0);
    expect(
      wrapper.findAll('[role="option"]').slice(1).map((row) => row.attributes("title")),
    ).toEqual(["Rocket planes · Grumman F6F", "Rocket planes · F8F Bearcat"]);
  });

  it("keeps one tag when a mixed section's labels collide", () => {
    // Lesta "…_ALT" squadrons reuse one model for two entities: without the
    // tag the two rows would be indistinguishable, so the ranked twin keeps
    // it (and only that one).
    const wrapper = mountMenu([
      option("PJAF818", "Mitsubishi 1MF3", "rocket", null),
      option("PJAF828", "Mitsubishi 1MF3", "rocket", "variant"),
    ]);
    const rows = wrapper.findAll('[role="option"]').slice(1);
    expect(rows[0].find(".ship-stage__model-pick-tag").exists()).toBe(false);
    expect(rows[0].attributes("title")).toBe("Rocket planes · Mitsubishi 1MF3");
    expect(rows[1].find(".ship-stage__model-pick-tag").text()).toBe("Variant");
    expect(rows[1].find(".ship-stage__model-pick-tag").classes()).toContain("is-variant");
    expect(rows[1].attributes("title")).toBe(
      "Rocket planes · Mitsubishi 1MF3 · Variant",
    );
  });

  it("leaves a single-airframe section untagged", () => {
    // No counterpart to be the base / variant OF.
    const wrapper = mountMenu([
      option("PAAF801", "Grumman F8F Bearcat TinyTim", "rocket", "base"),
    ]);
    expect(wrapper.findAll(".ship-stage__model-pick-tag")).toHaveLength(0);
    expect(wrapper.findAll(".ship-stage__model-pick-group-label").map((l) => l.text())).toEqual([
      "Rocket planes",
    ]);
  });

  it("marks the staged airframe active and leaves the hull idle", () => {
    const wrapper = mountMenu(HAKURYU, "PJAB121");
    const rows = wrapper.findAll('[role="option"]');
    expect(rows[0].attributes("aria-selected")).toBe("false");
    expect(rows[0].classes()).not.toContain("is-active");
    const active = rows.filter((row) => row.classes().includes("is-active"));
    expect(active).toHaveLength(1);
    expect(active[0].attributes("aria-selected")).toBe("true");
    expect(active[0].find(".ship-stage__model-pick-item-label").text()).toBe(
      "Aichi B7A3 Ryusei Kai",
    );
  });

  it("emits select with the clicked row's value", async () => {
    const wrapper = mountMenu(HAKURYU);
    const rows = wrapper.findAll('[role="option"]');
    await rows[0].trigger("click");
    expect(wrapper.emitted("select")).toEqual([["hull"]]);
    await rows[2].trigger("click");
    expect(wrapper.emitted("select")).toEqual([["hull"], ["PJAB111"]]);
  });

  it("keeps the clipped designation readable through the row title", () => {
    const wrapper = mountMenu(HAKURYU);
    const rows = wrapper.findAll('[role="option"]');
    expect(rows[1].attributes("title")).toBe("Torpedo bombers · Nakajima C6N5 1b · Base");
    expect(rows[6].attributes("title")).toBe(
      "Rocket planes · Mitsubishi J8M2 Shusui Kai · Variant",
    );
  });

  it("renders the ungrouped role bucket without a heading or tags", () => {
    const wrapper = mountMenu([
      option("PJAB110", "Nakajima C6N5 1b", "torpedo", "base"),
      option("PZZ999", "Unknown airframe", "", null),
    ]);
    const groups = wrapper.findAll(".ship-stage__model-pick-group");
    expect(groups).toHaveLength(2);
    expect(wrapper.findAll(".ship-stage__model-pick-group-label")).toHaveLength(1);
    const ungrouped = groups[1];
    expect(ungrouped.attributes("aria-label")).toBeUndefined();
    expect(ungrouped.findAll(".ship-stage__model-pick-tag")).toHaveLength(0);
    const row = ungrouped.find('[role="option"]');
    expect(row.find(".ship-stage__model-pick-item-label").text()).toBe("Unknown airframe");
    expect(row.attributes("title")).toBe("Unknown airframe");
  });

  it("drops the heading for a role the locale does not translate", () => {
    // The mock t() echoes an unresolved key; the menu must treat that as
    // "no heading" instead of printing the raw ships.plane.<role> path.
    const wrapper = mountMenu([
      option("PJAB110", "Nakajima C6N5 1b", "torpedo", "base"),
      option("PZZ001", "Mystery airframe", "unmappedRole", null),
    ]);
    expect(
      wrapper.findAll(".ship-stage__model-pick-group-label").map((label) => label.text()),
    ).toEqual(["Torpedo bombers"]);
    const groups = wrapper.findAll(".ship-stage__model-pick-group");
    expect(groups).toHaveLength(2);
    expect(groups[1].attributes("aria-label")).toBeUndefined();
    expect(groups[1].find(".ship-stage__model-pick-item-label").text()).toBe(
      "Mystery airframe",
    );
    // No phantom heading segment in the fallback row's title either.
    expect(groups[1].find('[role="option"]').attributes("title")).toBe("Mystery airframe");
  });
});
