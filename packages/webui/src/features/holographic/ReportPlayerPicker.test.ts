/**
 * ReportPlayerPicker tests — the report head's perspective dropdown: the
 * trigger shows only the selected player, the menu groups both teams with
 * coverage faces, unscoreable hulls stay listed but disabled, choosing a row
 * emits the perspective switch and closes, and Escape / capture mode close
 * the menu without selecting.
 */
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import ReportPlayerPicker from "./ReportPlayerPicker";
import type { StaticReport, StaticRosterEntry } from "@/api";

enableAutoUnmount(afterEach);

function rosterEntry(overrides: Partial<StaticRosterEntry>): StaticRosterEntry {
  return {
    entityId: 1,
    shipId: 1,
    name: "me",
    playerName: "me",
    teamId: 0,
    isRecorder: false,
    diedAt: null,
    coverage: {
      aliveFrom: 0,
      aliveTo: 600,
      samples: 40,
      gapSeconds: 0,
      completeness: 0.97,
      gapSegments: [],
    },
    whole: null,
    outcome: null,
    ...overrides,
  };
}

function report(): StaticReport {
  return {
    replayPath: "replays/r.wowsreplay",
    replayId: "r",
    mapName: "spaces/15_NE_north",
    gameMode: "Domination",
    durationS: 600,
    losLoaded: false,
    modelSources: { fire: "models/fire.onnx", moveModel: "models/move.onnx" },
    entityId: 1,
    roster: [
      rosterEntry({ entityId: 1, name: "me", isRecorder: true }),
      rosterEntry({ entityId: 2, name: "mate", playerName: "mate" }),
      rosterEntry({
        entityId: 9,
        name: "foe",
        playerName: "foe",
        teamId: 1,
        coverage: {
          aliveFrom: 0,
          aliveTo: 600,
          samples: 0,
          gapSeconds: 600,
          completeness: 0,
          gapSegments: [[0, 600]],
        },
      }),
    ],
    timeline: [],
    moments: [],
  };
}

function mountPicker(props: Record<string, unknown> = {}) {
  return mount(ReportPlayerPicker, {
    props: { report: report(), capturing: false, ...props },
    // Focus assertions need the tree to live in the document.
    attachTo: document.body,
  });
}

describe("ReportPlayerPicker", () => {
  it("shows only the selected player on the trigger", () => {
    const w = mountPicker();
    const trigger = w.find(".srp-picker__trigger");
    expect(trigger.exists()).toBe(true);
    expect(trigger.text()).toContain("me");
    expect(trigger.text()).not.toContain("mate");
    expect(trigger.text()).not.toContain("foe");
    expect(trigger.attributes("aria-expanded")).toBe("false");
  });

  it("groups both teams in the opened menu", async () => {
    const w = mountPicker();
    await w.find(".srp-picker__trigger").trigger("click");
    const menu = w.find(".srp-picker__menu");
    expect(menu.exists()).toBe(true);
    expect(w.find(".srp-picker__trigger").attributes("aria-expanded")).toBe("true");
    expect(menu.text()).toContain("replay.report.allies");
    expect(menu.text()).toContain("replay.report.enemies");
    expect(menu.text()).toContain("mate");
    expect(menu.text()).toContain("foe");
  });

  it("emits the picked perspective and closes", async () => {
    const w = mountPicker();
    await w.find(".srp-picker__trigger").trigger("click");
    const rows = w.findAll(".srp-picker__row");
    const mate = rows.find((row) => row.text().includes("mate"));
    expect(mate).toBeTruthy();
    await mate!.trigger("click");
    expect(w.emitted("pick")).toEqual([[2]]);
    expect(w.find(".srp-picker__menu").exists()).toBe(false);
  });

  it("keeps unscoreable hulls listed but disabled", async () => {
    const w = mountPicker();
    await w.find(".srp-picker__trigger").trigger("click");
    const rows = w.findAll(".srp-picker__row");
    const foe = rows.find((row) => row.text().includes("foe"));
    expect(foe).toBeTruthy();
    expect(foe!.attributes("disabled")).toBeDefined();
    await foe!.trigger("click");
    expect(w.emitted("pick")).toBeUndefined();
    expect(w.find(".srp-picker__menu").exists()).toBe(true);
  });

  it("closes on Escape without emitting", async () => {
    const w = mountPicker();
    await w.find(".srp-picker__trigger").trigger("click");
    expect(w.find(".srp-picker__menu").exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(w.find(".srp-picker__menu").exists()).toBe(false);
    expect(w.emitted("pick")).toBeUndefined();
  });

  it("returns focus to the trigger after a selection", async () => {
    const w = mountPicker();
    await w.find(".srp-picker__trigger").trigger("click");
    const mate = w.findAll(".srp-picker__row").find((row) => row.text().includes("mate"));
    await mate!.trigger("click");
    await nextTick();
    expect(document.activeElement).toBe(w.find(".srp-picker__trigger").element);
  });

  it("opens from the keyboard and walks the enabled rows", async () => {
    const w = mountPicker();
    await w.find(".srp-picker__trigger").trigger("keydown", { key: "ArrowDown" });
    await nextTick();
    expect(w.find(".srp-picker__menu").exists()).toBe(true);
    const rows = w.findAll(".srp-picker__row:not(:disabled)");
    expect(rows).toHaveLength(2);
    expect(document.activeElement).toBe(rows[0].element);
    await w.find(".srp-picker__menu").trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1].element);
  });

  it("is a static name plate while the long image is captured", async () => {
    const w = mountPicker({ capturing: true });
    const trigger = w.find(".srp-picker__trigger");
    expect(trigger.attributes("disabled")).toBeDefined();
    await trigger.trigger("click");
    expect(w.find(".srp-picker__menu").exists()).toBe(false);
  });
});
