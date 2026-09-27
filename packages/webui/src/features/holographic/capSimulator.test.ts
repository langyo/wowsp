/** Tests for the scorebar's sunk-ship points attribution: the classic
 *  kill/death tables per class in team modes, the special-map flat rates,
 *  and the operation-scenario rule that NO attribution is made (the
 *  single-team roster cannot tell an enemy bot from an ally script ship,
 *  so crediting the enemy score from friendly sinks would be invention). */
import { describe, expect, it } from "vitest";

import { sunkShipPoints, type SunkShipMarker } from "./capSimulator";

const mk = (role: SunkShipMarker["role"], type: string, deathTime: number | null): SunkShipMarker => ({
  role,
  type,
  deathTime,
});

describe("sunkShipPoints", () => {
  it("credits the opposite side and penalizes the sinking side in team modes", () => {
    // A sunk allied cruiser: enemy +35, ally -50.
    const pts = sunkShipPoints([mk("ally", "Cruiser", 100)], 200, false);
    expect(pts).toEqual({ ally: -50, enemy: 35 });
    // A sunk enemy battleship: ally +40, enemy -60.
    expect(sunkShipPoints([mk("enemy", "Battleship", 100)], 200, false)).toEqual({
      ally: 40,
      enemy: -60,
    });
    // The recorder's own sinking counts on the ally side too.
    expect(sunkShipPoints([mk("self", "Destroyer", 100)], 200, false)).toEqual({
      ally: -45,
      enemy: 30,
    });
  });

  it("uses the flat special-map rates (+40/-25)", () => {
    expect(sunkShipPoints([mk("enemy", "AirCarrier", 100)], 200, true)).toEqual({
      ally: 40,
      enemy: -25,
    });
  });

  it("covers the remaining class rows and the short AirCar type name", () => {
    expect(sunkShipPoints([mk("enemy", "Submarine", 100)], 200, false)).toEqual({
      ally: 25,
      enemy: -40,
    });
    expect(sunkShipPoints([mk("ally", "AirCar", 100)], 200, false)).toEqual({
      ally: -65,
      enemy: 45,
    });
  });

  it("ignores ships still afloat at t (and never-sunk ones)", () => {
    expect(sunkShipPoints([mk("enemy", "Cruiser", 300)], 200, false)).toEqual({
      ally: 0,
      enemy: 0,
    });
    expect(sunkShipPoints([mk("enemy", "Cruiser", null)], 200, false)).toEqual({
      ally: 0,
      enemy: 0,
    });
  });

  it("makes no attribution in operation scenarios", () => {
    // Same sunk ships as the first test — the operation flag zeroes both
    // sides: the enemy column must not grow from friendly sinks.
    const markers = [
      mk("ally", "Cruiser", 100),
      mk("self", "Destroyer", 120),
      mk("ally", "Battleship", 140),
    ];
    expect(sunkShipPoints(markers, 200, false, true)).toEqual({ ally: 0, enemy: 0 });
    expect(sunkShipPoints(markers, 200, true, true)).toEqual({ ally: 0, enemy: 0 });
  });
});
