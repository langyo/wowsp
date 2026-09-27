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
      isOperationBattle("pve", null, null, ["langyo", "IDS_OP_15_DUMMY_01"]),
    ).toBe(true);
  });

  it("is false for co-op and random rosters", () => {
    expect(isOperationBattle("pve", "coop_1point", null, [":Yumashev:", "langyo"])).toBe(false);
    expect(isOperationBattle("pvp", "domination_3point", null, ["langyo", "WGR_bot"])).toBe(false);
    expect(isOperationBattle("pve", null, null, ["langyo", ":Yumashev:"])).toBe(false);
  });
});
