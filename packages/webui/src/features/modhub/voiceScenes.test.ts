/** voiceScenes: the scene registry resolver (locale fallback chain),
 *  event/state humanizers and the scene-first row ordering. */
import { describe, expect, it } from "vitest";

import { compareByScene, humanizeEvent, humanizeState, sceneLabel } from "./voiceScenes";

describe("sceneLabel", () => {
  it("resolves the exact locale, then the zh/en pair", () => {
    expect(sceneLabel("Play_VO_Fire_Alarm", "zh-CN")).toBe("火灾警报!");
    expect(sceneLabel("Play_VO_Fire_Alarm", "zh-SG")).toBe("火灾警报!");
    expect(sceneLabel("Play_VO_Fire_Alarm", "en-US")).toBe("Fire alarm");
    expect(sceneLabel("Play_VO_Fire_Alarm", "ja-JP")).toBe("火災警報!");
    // A locale the registry does not carry falls back en-first (zh
    // locales would take zh-CN first).
    expect(sceneLabel("Play_VO_Fire_Alarm", "pt-BR")).toBe("Fire alarm");
  });

  it("returns null for unknown events (caller humanizes)", () => {
    expect(sceneLabel("Play_VO_Something_New", "zh-CN")).toBeNull();
  });
});

describe("humanizeEvent", () => {
  it("strips the verb prefixes into readable words", () => {
    expect(humanizeEvent("Play_VO_Detection_Enemy")).toBe("Detection Enemy");
    expect(humanizeEvent("Play_UI_Tutorial_Task_3")).toBe("Tutorial Task 3");
    expect(humanizeEvent("Play_Start")).toBe("Start");
  });
});

describe("humanizeState", () => {
  it("drops the mirrored event core, keeping the distinguishing tail", () => {
    expect(humanizeState("Play_VO_Autopilot", "VO_Autopilot_Checkpoint")).toBe("Checkpoint");
    expect(humanizeState("Play_VO_Autopilot", "VO_Autopilot_End")).toBe("End");
  });

  it("keeps quick-chat command words", () => {
    expect(humanizeState("Play_VO_Quick_Commands", "CMD_QUICK_NEED_SMOKE")).toBe("NEED SMOKE");
  });

  it("falls back to the raw state when nothing strips", () => {
    expect(humanizeState("Play_VO_X", "WEIRD")).toBe("WEIRD");
  });
});

describe("compareByScene", () => {
  const row = (rel: string, sceneEvent?: string, sceneIndex?: number) => ({
    rel,
    sceneEvent,
    sceneIndex,
  });

  it("groups scene rows by event, variations in slot order, orphans last", () => {
    const rows = [
      row("zzz.wem"), // orphan
      row("b.wem", "Play_VO_Fire_Alarm", 2),
      row("a.wem", "Play_VO_Fire_Alarm", 1),
      row("c.wem", "Play_VO_Autopilot", 1),
    ];
    const sorted = [...rows].sort(compareByScene);
    expect(sorted.map((r) => r.rel)).toEqual(["c.wem", "a.wem", "b.wem", "zzz.wem"]);
  });
});
