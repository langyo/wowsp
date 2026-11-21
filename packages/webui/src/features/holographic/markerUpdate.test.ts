/**
 * Aircraft-card countdown + parent-hull consumable chip (items C/D).
 *
 * The floating aircraft card's fighter deployment shows ONLY a countdown at the
 * patrol circle ("arrives in 0:15" — the map's existing countdown wording), and
 * a catapult-launched scout reports its consumable under the PARENT HULL's
 * label instead of carrying a card of its own.
 */
import { describe, expect, it } from "vitest";
import { fmtCountdown, withScoutConsumable } from "./markerUpdate";
import type { MapInternals } from "./mapInternals";
import type { ConsumableUseEvent } from "@/api";
import type { ShipStatusSnapshot } from "./shipStatusModel";

const use = (
  time: number,
  entityId: number,
  consumableId: number,
  duration: number,
): ConsumableUseEvent => ({
  time,
  entityId,
  usageType: 0,
  consumableId,
  duration,
});

function ctxWith(uses: ConsumableUseEvent[]): Pick<MapInternals, "props"> {
  return { props: { consumableUses: uses } } as unknown as Pick<MapInternals, "props">;
}

describe("fmtCountdown", () => {
  it("prints the weather badge's MM:SS shape and never goes negative", () => {
    expect(fmtCountdown(15)).toBe("0:15");
    expect(fmtCountdown(75)).toBe("1:15");
    expect(fmtCountdown(0.4)).toBe("0:00");
    expect(fmtCountdown(-3)).toBe("0:00");
  });
});

describe("withScoutConsumable (scout → parent hull chip)", () => {
  const HULL = 845630;

  it("adds one active-consumable tile with the remaining seconds", () => {
    const ctx = ctxWith([use(194.5, HULL, 1, 71.5)]);
    const base: ShipStatusSnapshot = { actions: [], hits: [], dots: [] };
    const at = withScoutConsumable(base, ctx, HULL, 200) as ShipStatusSnapshot;
    expect(at.actions).toHaveLength(1);
    expect(at.actions[0].phase).toBe("active");
    expect(at.actions[0].secs).toBeCloseTo(66);
    expect(at.actions[0].frac).toBeCloseTo(66 / 71.5);
    // The other rows are untouched.
    expect(at.hits).toBe(base.hits);
  });

  it("creates the row when the hull had no status at all", () => {
    const ctx = ctxWith([use(194.5, HULL, 1, 71.5)]);
    const at = withScoutConsumable(null, ctx, HULL, 195) as ShipStatusSnapshot;
    expect(at.actions).toHaveLength(1);
    expect(at.hits).toEqual([]);
  });

  it("keeps the pre-existing chips and appends its own", () => {
    const ctx = ctxWith([use(194.5, HULL, 1, 71.5)]);
    const repair = { key: "repair" as const, phase: "active" as const, frac: 0.5, secs: 14 };
    const at = withScoutConsumable(
      { actions: [repair], hits: [], dots: [] },
      ctx,
      HULL,
      200,
    ) as ShipStatusSnapshot;
    expect(at.actions).toHaveLength(2);
    expect(at.actions[0]).toBe(repair);
  });

  it("shows nothing for another hull, another family, or after the window", () => {
    const ctx = ctxWith([
      use(194.5, HULL, 1, 71.5),
      use(400, HULL, 8, 28), // repair party — not a scout
    ]);
    expect(withScoutConsumable(null, ctx, 999, 200)).toBeNull();
    expect(withScoutConsumable(null, ctx, HULL, 410)).toBeNull();
    expect(withScoutConsumable(null, ctxWith([]), HULL, 200)).toBeNull();
  });
});
