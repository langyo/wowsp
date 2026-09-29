import { describe, expect, it } from "vitest";

import {
  activeKitSource,
  formatIntelCount,
  formatIntelKm,
  setRuntimeKit,
  teamIntelFor,
  teamIntelFrom,
  type TeamIntelCount,
} from "./teamIntel";

const count = (min: number, max: number): TeamIntelCount => ({ min, max });

describe("teamIntelFrom", () => {
  it("sums definite ships into min and definite+possible into max", () => {
    const intel = teamIntelFrom([1, 2, 3, 4], (id) =>
      id === 1
        ? { r: 2, radarM: 10000 }
        : id === 2
          ? { r: 1, radarM: 8500, s: 1 }
          : id === 3
            ? { h: 2, s: 2 }
            : { s: 2 },
    );
    expect(intel.radar).toEqual(count(1, 2));
    expect(intel.hydro).toEqual(count(1, 1));
    expect(intel.smoke).toEqual(count(2, 3));
    expect(intel.radarMaxM).toBe(10000);
  });

  it("counts ships, not slots — a possible radar counts once", () => {
    const intel = teamIntelFrom([9], () => ({ r: 1, h: 1, s: 1, radarM: 7500 }));
    expect(intel.radar).toEqual(count(0, 1));
    expect(intel.hydro).toEqual(count(0, 1));
    expect(intel.smoke).toEqual(count(0, 1));
  });

  it("keeps the longest radar range across duplicate hulls", () => {
    const intel = teamIntelFrom([7, 7, 8], (id) =>
      id === 7 ? { r: 2, radarM: 9000 } : { r: 2, radarM: 12000 },
    );
    expect(intel.radar).toEqual(count(3, 3));
    expect(intel.radarMaxM).toBe(12000);
  });

  it("skips unknown ids, nulls and entry-less ships without guessing", () => {
    const intel = teamIntelFrom([null, undefined, 404, 405], () => undefined);
    expect(intel.radar).toEqual(count(0, 0));
    expect(intel.hydro).toEqual(count(0, 0));
    expect(intel.radarMaxM).toBeNull();
  });

  it("ignores a zero radarM instead of reporting an impossible range", () => {
    const intel = teamIntelFrom([5], () => ({ r: 1 }));
    expect(intel.radar).toEqual(count(0, 1));
    expect(intel.radarMaxM).toBeNull();
  });
});

describe("formatting", () => {
  it("collapses equal bounds and joins differing ones with a tilde", () => {
    expect(formatIntelCount(count(3, 3))).toBe("3");
    expect(formatIntelCount(count(3, 5))).toBe("3~5");
    expect(formatIntelCount(count(0, 0))).toBe("0");
  });

  it("renders meters as one-decimal kilometers", () => {
    expect(formatIntelKm(10000)).toBe("10.0");
    expect(formatIntelKm(9500)).toBe("9.5");
  });
});

describe("runtime kit overlay (setRuntimeKit)", () => {
  // Ship ids far outside the baked asset so the assertions below can only
  // pass through the runtime copy.
  const RUNTIME = JSON.stringify({
    "990001": { r: 2, h: 2, radarM: 10000 },
    "990002": { r: 1, s: 1, radarM: 7500, junk: "dropped" },
  });

  it("serves a valid runtime copy over the bundled asset", () => {
    expect(setRuntimeKit(RUNTIME)).toBe(true);
    expect(activeKitSource()).toBe("runtime");
    const intel = teamIntelFor([990001, 990002]);
    expect(intel.radar).toEqual(count(1, 2));
    expect(intel.hydro).toEqual(count(1, 1));
    expect(intel.smoke).toEqual(count(0, 1));
    expect(intel.radarMaxM).toBe(10000);
  });

  it("keeps the previous copy on malformed downloads", () => {
    expect(setRuntimeKit("{not json")).toBe(false);
    expect(setRuntimeKit("[]")).toBe(false);
    expect(setRuntimeKit('{"not-a-numeric-id": {"r": 2}}')).toBe(false);
    expect(activeKitSource()).toBe("runtime");
    expect(teamIntelFor([990001]).radar).toEqual(count(1, 1));
  });

  it("clears back to the bundled asset on a null cache", () => {
    expect(setRuntimeKit(null)).toBe(false);
    expect(activeKitSource()).toBe("bundled");
    // Unknown to the baked asset again → all zeros.
    expect(teamIntelFor([990001]).radar).toEqual(count(0, 0));
  });
});
