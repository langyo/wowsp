import { describe, expect, it } from "vitest";
import { collapseCandidateBots } from "./candidates";

describe("collapseCandidateBots", () => {
  it("folds the bot faces into a count and keeps the human order", () => {
    expect(
      collapseCandidateBots([":Martinengo:", "神楽坂柚咲", ":Radford:", "用户_13755651660"]),
    ).toEqual({ humans: ["神楽坂柚咲", "用户_13755651660"], botCount: 2 });
  });

  it("recognizes every AI shape the shared regex covers", () => {
    expect(collapseCandidateBots([":Beatty:", "IDS_AL_01", "#scenario_bot", "玩家"])).toEqual({
      humans: ["玩家"],
      botCount: 3,
    });
  });

  it("keeps a pure-human range untouched", () => {
    expect(collapseCandidateBots(["a", "b"])).toEqual({ humans: ["a", "b"], botCount: 0 });
  });

  it("collapses a pure-bot range to zero humans", () => {
    expect(collapseCandidateBots([":A:", ":B:"])).toEqual({ humans: [], botCount: 2 });
  });
});
