/**
 * Unit tests for the post-battle head mode rule (postBattleMode.ts): the
 * descriptor classifier + the single-team roster shape + the parent's
 * one-way operation promotion must resolve exactly like every other mode
 * surface (replay cards / viewer header), so the results-modal pill and the
 * share shot never disagree with the battle's real label.
 */
import { describe, expect, it } from "vitest";

import { postBattleModeKey } from "./postBattleMode";

/** The reported 2026-10-26 WW2 operation replay: matchGroup "pve", scenario
 *  "WW2_OPERATION_1_1011LVL", empty eventType, seven players all on the
 *  recorder's side. */
const WW2_HEAD = {
  matchGroup: "pve",
  scenario: "WW2_OPERATION_1_1011LVL",
  eventType: "",
  botCount: 0,
  scriptedUnitCount: 0,
};

describe("postBattleModeKey", () => {
  it("labels the WW2 story operation as operation", () => {
    expect(postBattleModeKey(WW2_HEAD, true, true)).toBe("operation");
    // The scenario fingerprint alone decides even without the roster flag /
    // promotion — the WW2 case never depends on the weak heuristic.
    expect(postBattleModeKey(WW2_HEAD, false, false)).toBe("operation");
    expect(postBattleModeKey(WW2_HEAD, null, false)).toBe("operation");
  });

  it("uses the single-team roster shape when the descriptor has no fingerprint", () => {
    const bare = { matchGroup: "pve", scenario: null, eventType: null };
    // Players listed, no enemy side: a story operation (the roster rule).
    expect(postBattleModeKey(bare, true, false)).toBe("operation");
    expect(postBattleModeKey(bare, true, true)).toBe("operation");
    // Real co-op lists its enemy bot team — friendly/descriptor-blind path
    // keeps the historical label.
    expect(postBattleModeKey(bare, false, false)).toBe("cooperative");
    expect(postBattleModeKey(bare, null, false)).toBe("cooperative");
  });

  it("takes the parent operation verdict as a ONE-WAY promotion", () => {
    // The decode-time spawn probe promoted a plain-co-op descriptor: the
    // descriptor still reads cooperative, the verdict says operation.
    const bare = { matchGroup: "pve", scenario: null, eventType: null };
    expect(postBattleModeKey(bare, false, true)).toBe("operation");
    // Never the reverse: an operation descriptor with operation=false keeps
    // its own label (the verdict cannot demote what the descriptor knows).
    expect(postBattleModeKey(WW2_HEAD, true, false)).toBe("operation");
    // The verdict only fixes a plain-co-op key — it never relabels another
    // mode family.
    for (const [head, expected] of [
      [{ matchGroup: "pvp", scenario: "domination_3point" }, "pvp"],
      [{ matchGroup: "ranked", scenario: null }, "ranked"],
      [{ matchGroup: "clan", scenario: null }, "clan"],
      [{ matchGroup: "pve", scenario: "asymm_3point_coop" }, "asymmetric"],
      [{ matchGroup: "event", scenario: "convoy_escort" }, "convoy"],
      // Custom-room subdivision: a pvp-family tournament room is a training
      // room (bots + tournament scenario) and never takes the verdict.
      [{ matchGroup: "pvp", scenario: "domination_tournament_3point" }, "training"],
    ] as const) {
      expect(postBattleModeKey(head, false, true)).toBe(expected);
      expect(postBattleModeKey(head, true, true)).toBe(expected);
    }
  });

  it("returns the empty key when there is no battle identity", () => {
    expect(postBattleModeKey(null, false, false)).toBe("");
    expect(postBattleModeKey(undefined, true, true)).toBe("");
    expect(postBattleModeKey({ matchGroup: null }, false, false)).toBe("");
    expect(postBattleModeKey({ matchGroup: "" }, true, true)).toBe("");
  });
});
