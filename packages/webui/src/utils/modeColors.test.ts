/** Tests for the mode classifier: operation fingerprints (PCVO battle
 *  scripts, `_op_`/`_hl_` infixes, `IDS_OP_*` scenario rosters) must win
 *  over the co-op `pve` matchGroup they share, and `isOperationBattle` must
 *  agree with `modeKey` about which battles render as a single team. */
import { describe, expect, it } from "vitest";

import {
  hasSingleTeamRoster,
  isCoopBattle,
  isOperationBattle,
  isSingleTeamTabLayout,
  modeColor,
  modeColorOfKey,
  modeKey,
  singleTeamRosterFromCounts,
} from "./modeColors";

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

  it("classifies the Lesta intro tutorial into the co-op family", () => {
    // Lesta new-account tutorial: matchGroup "intro" + FIRST_BATTLE
    // scenario (WG's equivalent arrives as low_lvl_operation). Its
    // all-scripted roster keeps the operation label per the
    // scriptedUnitCount rule; without scripted units it reads as co-op.
    expect(modeKey("intro", "FIRST_BATTLE", null, 14, 14)).toBe("operation");
    expect(modeKey("intro", null, null)).toBe("cooperative");
    expect(modeKey("INTRO", undefined, undefined, 0, 0)).toBe("cooperative");
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

  it("classifies the WW2 story operation family as operation by scenario / script", () => {
    // The user's 2026-10-26 WW2 operation replay: matchGroup "pve", the
    // operation scenario id, empty eventType. The scenario alone decides.
    expect(modeKey("pve", "WW2_OPERATION_1_1011LVL", "")).toBe("operation");
    expect(modeKey("pve", "ww2_operation_1_1011lvl", null)).toBe("operation");
    // Some clients echo the script into eventType instead.
    expect(modeKey("pve", null, "WW2_OPERATION_1_1011LVL")).toBe("operation");
  });

  it("classifies the single-team roster shape inside the pve family as operation", () => {
    // No descriptor fingerprint at all — only the roster shape (6th arg)
    // distinguishes the story operation from plain co-op. The 2026-10-26
    // WW2 replay is this shape: listed players, no enemy-side entry.
    expect(modeKey("pve", null, null, 0, 0, true)).toBe("operation");
    expect(modeKey("cooperative", null, null, 0, 0, true)).toBe("operation");
    expect(modeKey("pve", "domination_3point", null, 0, 0, true)).toBe("operation");
  });

  it("keeps the historical labels when the roster is unknown or two-team", () => {
    // The default null (roster-blind callers) and an explicit false (a
    // normal two-side co-op roster) both keep pve => cooperative.
    expect(modeKey("pve", null, null)).toBe("cooperative");
    expect(modeKey("pve", null, null, 0, 0, null)).toBe("cooperative");
    expect(modeKey("pve", null, null, 0, 0, false)).toBe("cooperative");
    // Outside the pve family the shape flag never relabels the mode.
    expect(modeKey("pvp", "domination_3point", null, 0, 0, true)).toBe("pvp");
    expect(modeKey("ranked", null, null, 0, 0, true)).toBe("ranked");
  });

  it("does not let the new fingerprints override the earlier branches", () => {
    expect(modeKey("pve", "asymm_3point_coop", null, 0, 0, true)).toBe("asymmetric");
    expect(modeKey("pve", "convoy_escort", null, 0, 0, true)).toBe("convoy");
    expect(modeKey("pve", null, "PVP222ASYM", 0, 0, true)).toBe("asymmetric");
    expect(modeKey("pve", null, "HALLOWEEN_2025", 0, 0, true)).toBe("halloween");
    // The custom-room fingerprint also keeps precedence over the late
    // matchGroup-level roster rule.
    expect(modeKey("pvp", "domination_tournament_3point", null, 0, 0, true)).toBe("training");
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

  it("forwards the single-team roster flag into the colour resolution", () => {
    expect(modeColor("pve", null, null, 0, 0, true).color).toBe(modeColorOfKey("operation").color);
    expect(modeColor("pve", null, null, 0, 0, false).color).toBe(
      modeColorOfKey("cooperative").color,
    );
    // Roster-blind default keeps the plain co-op colour.
    expect(modeColor("pve", null, null).color).toBe(modeColorOfKey("cooperative").color);
  });
});

describe("hasSingleTeamRoster", () => {
  it("is true only for a non-empty all-recorder-side roster", () => {
    // The user's WW2 replay roster: seven entries, all relation 0/1.
    expect(hasSingleTeamRoster([{ relation: 0 }, { relation: 1 }])).toBe(true);
    expect(hasSingleTeamRoster([{ relation: 1 }])).toBe(true);
    expect(hasSingleTeamRoster([])).toBe(false);
    expect(hasSingleTeamRoster(null)).toBe(false);
    expect(hasSingleTeamRoster(undefined)).toBe(false);
    // A real co-op roster carries the enemy bot side (relation >= 2).
    expect(hasSingleTeamRoster([{ relation: 0 }, { relation: 2 }])).toBe(false);
  });
});

describe("singleTeamRosterFromCounts", () => {
  it("is true only when players are listed and the enemy side is literally empty", () => {
    expect(singleTeamRosterFromCounts(7, 0)).toBe(true);
    // An ABSENT count is unknown, not zero: an older host release serves
    // lite rows without the enemy count, and those must keep their
    // historical label (a pve co-op row must never flip to 行动).
    expect(singleTeamRosterFromCounts(7, undefined)).toBe(false);
    expect(singleTeamRosterFromCounts(7, null)).toBe(false);
    // Real co-op always lists its enemy bot team.
    expect(singleTeamRosterFromCounts(7, 6)).toBe(false);
    // No listed players at all is not the story-operation shape.
    expect(singleTeamRosterFromCounts(0, 0)).toBe(false);
    expect(singleTeamRosterFromCounts(null, 0)).toBe(false);
    expect(singleTeamRosterFromCounts(null, null)).toBe(false);
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

  it("recognizes the WW2 operation scenario / script fingerprint", () => {
    // The 2026-10-26 WW2 operation replay — scenario only, empty eventType.
    expect(isOperationBattle("pve", "WW2_OPERATION_1_1011LVL", "")).toBe(true);
    expect(isOperationBattle("pve", null, "WW2_OPERATION_1_1011LVL")).toBe(true);
  });

  it("treats a single-team pve roster as an operation", () => {
    // The 5th arg is the roster shape every arena caller computes
    // (hasSingleTeamRoster): players listed, no enemy side.
    expect(isOperationBattle("pve", null, null, ["langyo", ":Yumashev:"], true)).toBe(true);
    expect(isOperationBattle("cooperative", null, null, [], true)).toBe(true);
    // A normal co-op roster (enemy side present) is NOT an operation, and
    // the roster-blind default keeps the historical answer.
    expect(isOperationBattle("pve", null, null, [":Yumashev:"], false)).toBe(false);
    expect(isOperationBattle("pve", null, null, [":Yumashev:"])).toBe(false);
    expect(isOperationBattle("pve", null, null, [":Yumashev:"], null)).toBe(false);
    // pvp-family and intro (tutorial family) battles never take the rule.
    expect(isOperationBattle("pvp", "domination_3point", null, ["langyo"], true)).toBe(false);
    expect(isOperationBattle("ranked", null, null, ["langyo"], true)).toBe(false);
    expect(isOperationBattle("intro", null, null, ["langyo"], true)).toBe(false);
  });

  it("keeps the tutorial-family exclusions first even with a single-team flag", () => {
    // The escort op / tutorial rosters are two-team LAYOUTS — their mode
    // label is operation, but they must never flip to the single-team
    // visual rules.
    expect(isOperationBattle("pve", "LOW_LVL_OPERATION_1_LVL_2", null, [], true)).toBe(false);
    expect(isOperationBattle("pve", null, "LOW_LVL_OPERATION_1_LVL_2", [], true)).toBe(false);
    expect(isOperationBattle("intro", "FIRST_BATTLE", null, [], true)).toBe(false);
    expect(isOperationBattle("pve", null, null, ["IDS_OP_15_DUMMY_01"], true)).toBe(false);
  });
});

describe("isCoopBattle", () => {
  it("accepts plain co-op descriptors with a :Name:-only roster", () => {
    expect(isCoopBattle("pve", "coop_1point", null, ["langyo", ":Yumashev:"])).toBe(true);
    // Bare pve with no fingerprints at all — the regular co-op bucket.
    expect(isCoopBattle("pve", null, null, ["langyo", ":Yumashev:", ":Tachibana:"])).toBe(true);
    expect(isCoopBattle("cooperative", "domination_3point", null, ["langyo"])).toBe(true);
  });

  it("accepts asymmetric co-op by its scenario / PCVE script", () => {
    // Live asym co-op shape (verified against recorded replays): the
    // scenario's `asymm` makes modeKey say "asymmetric", but the roster is
    // still co-op-style — `:Name:` fills only.
    expect(
      isCoopBattle("event", "asymm_3point_coop", "PCVE027", [
        "langyo",
        ":Buchan:",
        ":Kongo:",
      ]),
    ).toBe(true);
    expect(isCoopBattle("pve", "asymm_2point_coop", null, ["langyo", ":Yumashev:"])).toBe(true);
  });

  it("rejects script-driven rosters inside the pve family", () => {
    // One IDS_* or #Name unit = an operation-style battle, whatever the
    // descriptor says (the same discriminator modeKey applies to the
    // scripted-unit count).
    expect(isCoopBattle("pve", null, null, ["langyo", "IDS_OP_50_DUMMY_01"])).toBe(false);
    expect(isCoopBattle("pve", "asymm_3point_coop", "PCVE027", ["langyo", "#Yamato"])).toBe(
      false,
    );
    // The escort op / tutorial fleets are scripted, not co-op.
    expect(
      isCoopBattle("pve", "LOW_LVL_OPERATION_1_LVL_2", null, [
        "langyo",
        ":Buchan:",
        "IDS_OP_15_DUMMY_01",
      ]),
    ).toBe(false);
    expect(isCoopBattle("intro", "FIRST_BATTLE", null, ["langyo", "IDS_AL_01"])).toBe(false);
  });

  it("rejects everything outside the co-op family", () => {
    expect(isCoopBattle("pvp", "domination_3point", null, ["langyo", "WGR_bot"])).toBe(false);
    // PCVO operations are excluded even though the script prefix shares the
    // PCV* shape with the co-op PCVE one.
    expect(isCoopBattle("pve", null, "PCVO009_OP_02_02_s06_Atoll_MEDIUM_LVL")).toBe(false);
    expect(isCoopBattle(null, null, null)).toBe(false);
  });

  it("rejects the WW2 operation descriptor and the single-team roster", () => {
    // The descriptor fingerprint alone already excludes it...
    expect(isCoopBattle("pve", "WW2_OPERATION_1_1011LVL", "")).toBe(false);
    // ...and the roster shape (5th arg) excludes a fingerprint-less
    // single-team pve battle: it is a story operation, not plain co-op.
    expect(isCoopBattle("pve", null, null, [":Yumashev:"], true)).toBe(false);
    // A two-side co-op roster stays co-op — with the flag present or absent.
    expect(isCoopBattle("pve", null, null, [":Yumashev:"], false)).toBe(true);
    expect(isCoopBattle("pve", null, null, [":Yumashev:"])).toBe(true);
  });
});

describe("isSingleTeamTabLayout", () => {
  it("accepts operations and plain co-op (the one-column table)", () => {
    // The vendored Narai golden replay's descriptor — operation scripts
    // render the human team only.
    expect(
      isSingleTeamTabLayout("pve", null, "PCVO009_OP_02_02_s06_Atoll_MEDIUM_LVL", [
        "langyo",
        "WGR_bot",
      ]),
    ).toBe(true);
    // Plain co-op: pve matchGroup, no fingerprints, :Name: bot fill.
    expect(isSingleTeamTabLayout("pve", null, null, ["langyo", ":Yumashev:"])).toBe(true);
    expect(isSingleTeamTabLayout("cooperative", "domination_3point", null, ["langyo"])).toBe(true);
  });

  it("rejects the asymmetric co-op family (two-team table)", () => {
    // Issue #1360's companion rule: the ASYMMETRIC co-op family fields a
    // two-team table (the 2026-10-22 anchoring note keys its anchor as
    // the PvP class), so it splits back out of the co-op bucket.
    expect(
      isSingleTeamTabLayout("event", "asymm_3point_coop", "PCVE027", [
        "langyo",
        ":Buchan:",
        ":Kongo:",
      ]),
    ).toBe(false);
    expect(isSingleTeamTabLayout("pve", "asymm_2point_coop", null, ["langyo", ":Yumashev:"])).toBe(
      false,
    );
  });

  it("rejects the pvp family and the scripted tutorial layouts", () => {
    expect(isSingleTeamTabLayout("pvp", "domination_3point", null, ["langyo", "WGR_bot"])).toBe(
      false,
    );
    // The escort op / tutorial fleets field their scripted units as REAL
    // team rows — a two-team layout isCoopBattle correctly refuses.
    expect(
      isSingleTeamTabLayout("pve", "LOW_LVL_OPERATION_1_LVL_2", null, [
        "langyo",
        "IDS_OP_15_DUMMY_01",
      ]),
    ).toBe(false);
    expect(isSingleTeamTabLayout("intro", "FIRST_BATTLE", null, ["langyo", "IDS_AL_01"])).toBe(
      false,
    );
  });

  it("takes the single-team table for a single-team pve roster", () => {
    // The WW2 operation shape: one human team, no enemy side. The roster
    // argument is the only signal when the descriptor carries no
    // operation fingerprint.
    expect(isSingleTeamTabLayout("pve", null, null, [":Yumashev:"], true)).toBe(true);
    expect(isSingleTeamTabLayout("pve", "WW2_OPERATION_1_1011LVL", null, [], true)).toBe(true);
    // The pvp family and the tutorial-family layouts keep two-team tables.
    expect(isSingleTeamTabLayout("pvp", "domination_3point", null, ["langyo"], true)).toBe(false);
    // The escort op's scripted roster fails the roster scan first.
    expect(
      isSingleTeamTabLayout("pve", "LOW_LVL_OPERATION_1_LVL_2", null, [
        "langyo",
        "IDS_OP_15_DUMMY_01",
      ], true),
    ).toBe(false);
    // Roster-blind callers keep the historical answer.
    expect(isSingleTeamTabLayout("pve", null, null, [":Yumashev:"])).toBe(true);
  });
});
