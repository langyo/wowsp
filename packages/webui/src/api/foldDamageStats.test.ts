/** Tests for the receiveDamageStat fold — the shared source of every
 *  displayed damage number (HUD 伤害/航空, post-battle fallback panel). The
 *  game stream carries fractional f64 totals; the fold rounds so no view can
 *  render "23,425.894". */
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

  it("ignores non-damage categories and future samples", () => {
    const out = foldDamageStats(
      [
        sample({ category: 1, total: 999 }),
        sample({ category: 2, total: 999 }),
        sample({ time: 20, total: 999 }),
      ],
      10,
    );
    expect(out.damage).toBe(0);
    expect(out.hits).toBe(0);
  });

  it("handles empty/missing streams", () => {
    expect(foldDamageStats([], 10).damage).toBe(0);
    expect(foldDamageStats(null, 10).planeDamage).toBe(0);
  });
});
