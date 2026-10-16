/**
 * Tests for the AI-nickname helpers — the colon-wrapped co-op bot fills,
 * the scripted scenario units, and the operation sink-feed gate (only
 * human sink records reach the replay map's bottom-left ledger).
 */
import { describe, expect, it } from "vitest";

import { isAiName, isAiSinkVictim, isScriptedUnitName } from "./aiNames";

describe("isAiName", () => {
  it("recognizes co-op bot fills, scripted text keys and #names", () => {
    expect(isAiName(":Pohl:")).toBe(true);
    expect(isAiName("IDS_OP_10_EN_0101")).toBe(true);
    expect(isAiName("#158833")).toBe(true);
    expect(isAiName("langyo")).toBe(false);
    expect(isAiName("2473928807")).toBe(false);
  });
});

describe("isScriptedUnitName", () => {
  it("covers the scenario text keys and #names but not colon bots", () => {
    expect(isScriptedUnitName("IDS_OP_10_09_GAMBLE")).toBe(true);
    expect(isScriptedUnitName("#Name")).toBe(true);
    expect(isScriptedUnitName(":Sherman:")).toBe(false);
  });
});

describe("isAiSinkVictim", () => {
  it("sits scripted and bot victims out in operations, either side", () => {
    // The 2026-10-08 ASIA operation roster: enemy waves are
    // IDS_OP_10_EN_0101, the allied escorts IDS_OP_10_09/10 — both AI.
    expect(isAiSinkVictim(true, true, null)).toBe(true);
    expect(isAiSinkVictim(true, false, "IDS_OP_10_EN_0101")).toBe(true);
    expect(isAiSinkVictim(true, false, "IDS_OP_10_09_GAMBLE")).toBe(true);
    expect(isAiSinkVictim(true, false, ":Sherman:")).toBe(true);
    // The scripted label wins even over a human-looking roster name (a
    // mis-join pairing a human entity with a scripted entry).
    expect(isAiSinkVictim(true, true, "langyo")).toBe(true);
  });

  it("keeps human sinks visible in operations", () => {
    expect(isAiSinkVictim(true, false, "langyo")).toBe(false);
    expect(isAiSinkVictim(true, false, "2473928807")).toBe(false);
    // No roster identity at all — an unjoined ship is not provably AI.
    expect(isAiSinkVictim(true, false, null)).toBe(false);
    expect(isAiSinkVictim(true, undefined, undefined)).toBe(false);
  });

  it("never gates outside operations", () => {
    expect(isAiSinkVictim(false, true, "IDS_OP_10_EN_0101")).toBe(false);
    expect(isAiSinkVictim(false, false, ":Pohl:")).toBe(false);
  });
});
