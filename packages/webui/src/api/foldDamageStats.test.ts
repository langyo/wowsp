/** Tests for the receiveDamageStat fold — the shared source of every
 *  displayed damage number (HUD 伤害/航空, post-battle fallback panel) plus
 *  the spotting / potential ("agro") figures the combined post-battle banner
 *  shows. The game stream carries fractional f64 totals; the fold rounds so
 *  no view can render "23,425.894". */
import { describe, expect, it } from "vitest";

import { foldDamageStats, type DamageStatSample } from "./client";

const sample = (over: Partial<DamageStatSample>): DamageStatSample => ({
  time: 10,
  weapon: 1, // small-caliber (not a plane weapon)
  category: 0,
  count: 3,
  total: 100,
  ...over,
});

describe("foldDamageStats", () => {
  it("keeps the latest sample per (weapon, category) pair", () => {
    const out = foldDamageStats(
      [
        sample({ time: 1, total: 100.4, count: 1 }),
        sample({ time: 5, total: 250.6, count: 3 }),
      ],
      10,
    );
    expect(out.damage).toBe(251); // latest running total, rounded
    expect(out.hits).toBe(3);
  });

  it("rounds fractional totals to integers (no decimal display)", () => {
    const out = foldDamageStats(
      [
        sample({ weapon: 1, total: 12345.894 }),
        sample({ weapon: 2, total: 11080.0 }),
      ],
      10,
    );
    expect(out.damage).toBe(23426);
    expect(Number.isInteger(out.damage)).toBe(true);
  });

  it("rounds plane damage and keeps it inside the total", () => {
    const out = foldDamageStats(
      [
        sample({ weapon: 1, total: 500.4 }),
        sample({ weapon: 11, total: 1000.5, count: 2 }), // plane weapon
      ],
      10,
    );
    expect(out.damage).toBe(1501);
    expect(out.planeDamage).toBe(1001); // 1000.5 → 1001 (round-half-up)
  });

  it("folds spotting (2) and potential (3) into their own rounded totals", () => {
    // The game's DamageStatsType: 2 = damage teammates dealt to targets I
    // spotted, 3 = incoming fire aimed at me ("agro"). Both are server
    // truth with no hit-level attribution source — the fold is their only
    // origin, so they must sum across weapons instead of being discarded.
    const out = foldDamageStats(
      [
        sample({ category: 2, total: 45600.4 }),
        sample({ category: 2, weapon: 16, total: 999.8 }), // spot weapon
        sample({ category: 3, total: 1234000.6 }),
      ],
      10,
    );
    expect(out.spotDamage).toBe(46600); // 45600.4 + 999.8 = 46600.2
    expect(out.potentialDamage).toBe(1234001);
    // Neither category leaks into the dealt family.
    expect(out.damage).toBe(0);
    expect(out.hits).toBe(0);
  });

  it("keeps only the latest spotting / potential sample per (weapon, category)", () => {
    const out = foldDamageStats(
      [
        sample({ category: 2, time: 1, total: 100 }),
        sample({ category: 2, time: 9, total: 500.5 }),
        sample({ category: 3, weapon: 7, time: 2, total: 300 }),
        sample({ category: 3, weapon: 7, time: 8, total: 999.4 }),
      ],
      10,
    );
    expect(out.spotDamage).toBe(501); // 500.5 rounded — the earlier 100 is replaced
    expect(out.potentialDamage).toBe(999);
  });

  it("reads null when the stream never carried the category", () => {
    const out = foldDamageStats([sample({ total: 100 })], 10);
    expect(out.spotDamage).toBeNull();
    expect(out.potentialDamage).toBeNull();
    const empty = foldDamageStats([], 10);
    expect(empty.spotDamage).toBeNull();
    expect(empty.potentialDamage).toBeNull();
  });

  it("leaves allied (category 1) damage out of every total", () => {
    const out = foldDamageStats([sample({ category: 1, total: 999 })], 10);
    expect(out.damage).toBe(0);
    expect(out.hits).toBe(0);
    expect(out.spotDamage).toBeNull();
    expect(out.potentialDamage).toBeNull();
  });

  it("ignores future samples in every category", () => {
    const out = foldDamageStats(
      [
        sample({ time: 20, total: 999 }),
        sample({ time: 20, category: 2, total: 888 }),
        sample({ time: 20, category: 3, total: 777 }),
      ],
      10,
    );
    expect(out.damage).toBe(0);
    expect(out.hits).toBe(0);
    expect(out.spotDamage).toBeNull();
    expect(out.potentialDamage).toBeNull();
  });

  it("handles empty/missing streams", () => {
    expect(foldDamageStats([], 10).damage).toBe(0);
    expect(foldDamageStats(null, 10).planeDamage).toBe(0);
    expect(foldDamageStats(undefined, 10).spotDamage).toBeNull();
    expect(foldDamageStats(undefined, 10).potentialDamage).toBeNull();
  });
});
