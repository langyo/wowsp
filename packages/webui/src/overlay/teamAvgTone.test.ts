/** Unit contract of the team-averages line's comparative tone: hi on the
 *  higher settled figure, lo on the lower, and NO tone while any side is
 *  still loading, a figure is missing, or the two sides tie — a verdict
 *  needs both figures final (see the module doc). */
import { describe, expect, it } from "vitest";

import { teamAvgTone } from "./teamAvgTone";

describe("teamAvgTone", () => {
  it("grades the higher settled figure hi and the lower lo", () => {
    expect(teamAvgTone(54.2, 48.9, false)).toBe("overlay-intel-b--hi");
    expect(teamAvgTone(48.9, 54.2, false)).toBe("overlay-intel-b--lo");
  });

  it("keeps the warm accent on a tie, a missing figure, or a loading side", () => {
    expect(teamAvgTone(51.3, 51.3, false)).toBe("");
    expect(teamAvgTone(null, 51.3, false)).toBe("");
    expect(teamAvgTone(51.3, null, false)).toBe("");
    expect(teamAvgTone(null, null, false)).toBe("");
    // EITHER end still owing rows suppresses the verdict — the card's own
    // dots, and the opposing side's partial mean that would shift as its
    // remaining players land.
    expect(teamAvgTone(54.2, 48.9, true)).toBe("");
  });
});
