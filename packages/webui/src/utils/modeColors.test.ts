/** Tests for the mode classifier: operation fingerprints (PCVO battle
 *  scripts, `_op_`/`_hl_` infixes, `IDS_OP_*` scenario rosters) must win
 *  over the co-op `pve` matchGroup they share, and `isOperationBattle` must
 *  agree with `modeKey` about which battles render as a single team. */
import { describe, expect, it } from "vitest";

import { isOperationBattle, modeColor, modeKey } from "./modeColors";

describe("modeKey", () => {
  it("classifies a PCVO battle script as operation", () => {
    // The vendored Narai golden replay carries exactly this eventType shape.
    expect(modeKey("pve", undefined, "PCVO009_OP_02_02_s06_Atoll_MEDIUM_LVL")).toBe("operation");
  });

  it("classifies an _op_ scenario as operation", () => {
    expect(modeKey("pve", "novorossiysk_op_01", null)).toBe("operation");
  });

  it("keeps plain co-op (pve matchGroup, no operation fingerprint) co-op", () => {
    expect(modeKey("pve", undefined, null)).toBe("cooperative");
    expect(modeKey("pve", "coop_1point", null)).toBe("cooperative");
    // A `:Name:`-only roster stays co-op — those bots fill official co-op.
    expect(modeKey("pve", "domination_3point", null, 9, 0)).toBe("cooperative");
  });

  it("classifies the low-level escort op as operation by its scenario id", () => {
    // Live ASIA escort-op shape: matchGroup pve + LOW_LVL_OPERATION_* — no
    // PCVO/_op_/IDS_OP_ fingerprint matches, only the scenario id (plus the
    // mixed IDS_OP_15_*/:Name: roster) identifies the operation.
    expect(modeKey("pve", "LOW_LVL_OPERATION_1_LVL_2", null)).toBe("operation");
    expect(modeKey("pve", "LOW_LVL_OPERATION_1_LVL_2", null, 9, 5)).toBe("operation");
    expect(modeKey("pve", null, "LOW_LVL_OPERATION_1_LVL_2")).toBe("operation");
  });

  it("classifies a scripted-unit roster inside the pve family as operation", () => {
    // Descriptor with NO operation fingerprint at all — the scripted units
    // (`IDS_*` text keys / `#Name` scenario style) never field in plain
    // co-op, so their count is the operation fingerprint.
    expect(modeKey("pve", null, null, 9, 5)).toBe("operation");
    expect(modeKey("pve", "", "", 0, 2)).toBe("operation");
    expect(modeKey("cooperative", null, null, 0, 1)).toBe("operation");
    // Outside the pve family the count never relabels the mode.
    expect(modeKey("pvp", "domination_3point", null, 0, 1)).toBe("pvp");
  });

  it("classifies asymmetric co-op by battle script and scenario", () => {
    expect(modeKey("pve", "asymm_3point_coop", "PCVE027")).toBe("asymmetric");
    expect(modeKey("pve", "asymm_3point_coop", null)).toBe("asymmetric");
  });

  it("keeps the random / ranked / clan buckets", () => {
    expect(modeKey("pvp", "domination_3point", null)).toBe("pvp");
    expect(modeKey("ranked_sprint", "ranked_sprint_3point", null)).toBe("ranked");
    expect(modeKey("clan", "domination_clan_3point", null)).toBe("clan");
  });

  it("resolves a colour triple for every classified key", () => {
    const c = modeColor("pve", undefined, "PCVO009_OP_02_02_s06_Atoll_MEDIUM_LVL");
    expect(c.background).toContain("rgb(");
    expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("isOperationBattle", () => {
  it("is true for a PCVO battle script alone", () => {
    expect(isOperationBattle("pve", null, "PCVO013_Halloween")).toBe(true);
  });

  it("is true for an _op_ scenario alone", () => {
    expect(isOperationBattle("pve", "x_op_02", null)).toBe(true);
  });

  it("falls back to the roster when scenario and script are missing", () => {
    expect(
      isOperationBattle("pve", null, null, ["langyo", "IDS_OP_50_DUMMY_01"]),
    ).toBe(true);
  });

  it("keeps the new-account scripted battles two-team", () => {
    // Low-level escort op: by scenario, and by its IDS_OP_15_* units when
    // the arena file carries no scenario (360-server live rosters). Their
    // mode LABEL is still "operation" (see modeKey above) — only the roster
    // layout stays two-team.
    expect(
      isOperationBattle("pve", "LOW_LVL_OPERATION_1_LVL_2", null, [
        "langyo",
        ":Buchan:",
        "IDS_OP_15_ALLY_FLAGSHIP",
        "IDS_OP_15_DUMMY_01",
      ]),
    ).toBe(false);
    expect(
      isOperationBattle("pve", null, null, ["langyo", "IDS_OP_15_DUMMY_01"]),
    ).toBe(false);
    // Tutorial first battle.
    expect(
      isOperationBattle("intro", "FIRST_BATTLE", null, ["langyo", "IDS_AL_01"]),
    ).toBe(false);
  });

  it("is false for co-op and random rosters", () => {
    expect(isOperationBattle("pve", "coop_1point", null, [":Yumashev:", "langyo"])).toBe(false);
    expect(isOperationBattle("pvp", "domination_3point", null, ["langyo", "WGR_bot"])).toBe(false);
    expect(isOperationBattle("pve", null, null, ["langyo", ":Yumashev:"])).toBe(false);
  });
});
