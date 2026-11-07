/**
 * Unit tests for the enlarged 2D minimap hover picker: projection/rotation
 * math must mirror the painter exactly, and the selection rules (nearest,
 * priority tie-break, ring bands) are the tooltip's whole contract.
 */
import { describe, expect, it } from "vitest";
import {
  minimapLogicalOf,
  minimapWorldOf,
  pickMinimapTarget,
  unrotateMinimapPoint,
  type MinimapPickCap,
  type MinimapPickInput,
  type MinimapPickPlane,
  type MinimapPickShip,
  type MinimapPickSmoke,
  type MinimapPickTorpedo,
  type MinimapPickView,
  type MinimapPickWard,
} from "./minimapPick";

/** Full-map 1000×1000 world view without rotation. */
const VIEW: MinimapPickView = {
  minX: 0,
  maxX: 1000,
  minZ: 0,
  maxZ: 1000,
  rotationDeg: 0,
};

/** View-space logical px → world for VIEW (760 px spans the full map). */
function worldAt(lx: number, ly: number): { x: number; z: number } {
  return {
    x: (lx / 760) * 1000,
    z: 1000 - (ly / 760) * 1000,
  };
}

function ship(overrides: Partial<MinimapPickShip> = {}): MinimapPickShip {
  return {
    entityId: 1,
    role: "enemy",
    x: 500,
    z: 500,
    label: "Player",
    shipName: "Yamato",
    shipType: "Battleship",
    hp: 50000,
    maxHp: 90000,
    dead: false,
    unspotted: false,
    ...overrides,
  };
}

function plane(overrides: Partial<MinimapPickPlane> = {}): MinimapPickPlane {
  return {
    planeId: 7,
    planeType: "torpedo",
    role: "enemy",
    count: 8,
    carrierLabel: "Carrier",
    x: 500,
    z: 500,
    ...overrides,
  };
}

function torpedo(overrides: Partial<MinimapPickTorpedo> = {}): MinimapPickTorpedo {
  return {
    x: 500,
    z: 500,
    ownerLabel: "Shooter",
    role: "enemy",
    ageS: 3,
    remainingS: 40,
    ...overrides,
  };
}

function smoke(overrides: Partial<MinimapPickSmoke> = {}): MinimapPickSmoke {
  return { x: 500, z: 500, remainingS: 25, ...overrides };
}

function cap(overrides: Partial<MinimapPickCap> = {}): MinimapPickCap {
  return {
    x: 500,
    z: 500,
    letter: "A",
    owner: 1,
    etaS: null,
    radiusWorld: 0,
    ...overrides,
  };
}

function ward(overrides: Partial<MinimapPickWard> = {}): MinimapPickWard {
  return {
    x: 500,
    z: 500,
    role: "ally",
    radiusWorld: 0,
    ownerLabel: "Carrier",
    ...overrides,
  };
}

function input(patch: Partial<MinimapPickInput> = {}): MinimapPickInput {
  return {
    view: VIEW,
    ships: [],
    planes: [],
    torpedoes: [],
    smokes: [],
    caps: [],
    wards: [],
    ...patch,
  };
}

describe("minimapLogicalOf", () => {
  it("projects world XZ through the view rect (z north-positive)", () => {
    const centre = minimapLogicalOf(VIEW, 500, 500);
    expect(centre.lx).toBeCloseTo(380, 6);
    expect(centre.ly).toBeCloseTo(380, 6);
    // North (+z) is up: the top edge is ly = 0.
    const north = minimapLogicalOf(VIEW, 0, 1000);
    expect(north.lx).toBeCloseTo(0, 6);
    expect(north.ly).toBeCloseTo(0, 6);
    const east = minimapLogicalOf(VIEW, 1000, 0);
    expect(east.lx).toBeCloseTo(760, 6);
    expect(east.ly).toBeCloseTo(760, 6);
  });

  it("scales x and z independently on a non-square view rect", () => {
    const wide: MinimapPickView = { minX: 0, maxX: 2000, minZ: 0, maxZ: 1000, rotationDeg: 0 };
    const p = minimapLogicalOf(wide, 1000, 500);
    expect(p.lx).toBeCloseTo(380, 6);
    expect(p.ly).toBeCloseTo(380, 6);
    // Full x span is twice the z span: x reaches 760 at world x=2000.
    expect(minimapLogicalOf(wide, 2000, 500).lx).toBeCloseTo(760, 6);
  });

  it("round-trips through minimapWorldOf", () => {
    const p = minimapLogicalOf(VIEW, 640, 275);
    const back = minimapWorldOf(VIEW, p.lx, p.ly);
    expect(back.x).toBeCloseTo(640, 6);
    expect(back.z).toBeCloseTo(275, 6);
  });

  it("answers NaN on a degenerate rect", () => {
    const empty: MinimapPickView = { minX: 5, maxX: 5, minZ: 0, maxZ: 0, rotationDeg: 0 };
    expect(Number.isNaN(minimapLogicalOf(empty, 0, 0).lx)).toBe(true);
    expect(Number.isNaN(minimapLogicalOf(empty, 0, 0).ly)).toBe(true);
  });
});

describe("unrotateMinimapPoint", () => {
  it("is the identity without rotation", () => {
    expect(unrotateMinimapPoint(0, 456, 123)).toEqual({ lx: 456, ly: 123 });
  });

  it("keeps the canvas centre fixed at any rotation", () => {
    for (const deg of [0, 90, 180, 270, -90]) {
      const p = unrotateMinimapPoint(deg, 380, 380);
      expect(p.lx).toBeCloseTo(380, 6);
      expect(p.ly).toBeCloseTo(380, 6);
    }
  });

  it("spins a 90°-rotated point back into the view frame", () => {
    // View-space (456, 456) is drawn at (304, 456) by the painter's
    // rotate(90°) about the centre; the picker must undo exactly that.
    const p = unrotateMinimapPoint(90, 304, 456);
    expect(p.lx).toBeCloseTo(456, 6);
    expect(p.ly).toBeCloseTo(456, 6);
  });

  it("spins a 180°-rotated point back into the view frame", () => {
    const p = unrotateMinimapPoint(180, 304, 304);
    expect(p.lx).toBeCloseTo(456, 6);
    expect(p.ly).toBeCloseTo(456, 6);
  });
});

describe("pickMinimapTarget projection + rotation", () => {
  it("hits a ship at its projected centre", () => {
    const s = ship();
    expect(pickMinimapTarget(input({ ships: [s] }), 380, 380)?.kind).toBe("ship");
    expect(pickMinimapTarget(input({ ships: [s] }), 380, 380)).toMatchObject({
      entityId: 1,
      label: "Player",
      shipName: "Yamato",
      hp: 50000,
      maxHp: 90000,
      dead: false,
      unspotted: false,
    });
  });

  it("misses an empty spot on the map", () => {
    expect(pickMinimapTarget(input({ ships: [ship()] }), 300, 380)).toBeNull();
  });

  it("follows the world-frame rotation: 90° moves the hit point", () => {
    const s = ship({ x: 600, z: 400 }); // view-space logical (456, 456)
    const rotated: MinimapPickView = { ...VIEW, rotationDeg: 90 };
    // Rotated on-canvas position of that world point is (304, 456).
    expect(pickMinimapTarget(input({ view: rotated, ships: [s] }), 304, 456)?.kind).toBe("ship");
    // The un-rotated position must NOT hit anymore.
    expect(pickMinimapTarget(input({ view: rotated, ships: [s] }), 456, 456)).toBeNull();
  });

  it("is rotation-invariant at the centre", () => {
    const s = ship();
    for (const rotationDeg of [0, 90, 180, 270]) {
      const view = { ...VIEW, rotationDeg };
      expect(pickMinimapTarget(input({ view, ships: [s] }), 380, 380)?.kind).toBe("ship");
    }
  });

  it("answers null for an empty/entity-less input", () => {
    expect(pickMinimapTarget(input(), 380, 380)).toBeNull();
  });

  it("answers null for a degenerate view rect and non-finite input", () => {
    const degenerate: MinimapPickView = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, rotationDeg: 0 };
    expect(pickMinimapTarget(input({ view: degenerate, ships: [ship()] }), 380, 380)).toBeNull();
    expect(pickMinimapTarget(input({ ships: [ship()] }), Number.NaN, 380)).toBeNull();
  });
});

describe("pickMinimapTarget nearest selection", () => {
  it("takes the nearest of two same-kind entities", () => {
    const a = ship({ entityId: 1, ...worldAt(300, 380) });
    const b = ship({ entityId: 2, ...worldAt(340, 380) });
    const hit = pickMinimapTarget(input({ ships: [a, b] }), 335, 380);
    expect(hit?.kind).toBe("ship");
    expect(hit && hit.kind === "ship" ? hit.entityId : null).toBe(2);
  });

  it("keeps the tolerance tight per kind", () => {
    const s = ship({ ...worldAt(380, 380) });
    const atEdge = pickMinimapTarget(input({ ships: [s] }), 380 + 13, 380);
    expect(atEdge?.kind).toBe("ship");
    expect(pickMinimapTarget(input({ ships: [s] }), 380 + 13.5, 380)).toBeNull();

    const p = plane({ ...worldAt(380, 380) });
    expect(pickMinimapTarget(input({ planes: [p] }), 380 + 14, 380)?.kind).toBe("plane");
    expect(pickMinimapTarget(input({ planes: [p] }), 380 + 14.5, 380)).toBeNull();

    const t = torpedo({ ...worldAt(380, 380) });
    expect(pickMinimapTarget(input({ torpedoes: [t] }), 380 + 8, 380)?.kind).toBe("torpedo");
    expect(pickMinimapTarget(input({ torpedoes: [t] }), 380 + 8.5, 380)).toBeNull();

    const m = smoke({ ...worldAt(380, 380) });
    expect(pickMinimapTarget(input({ smokes: [m] }), 380 + 9, 380)?.kind).toBe("smoke");
    expect(pickMinimapTarget(input({ smokes: [m] }), 380 + 9.5, 380)).toBeNull();
  });
});

describe("pickMinimapTarget priority tie-breaks", () => {
  it("prefers a ship whose centre is up to 3 px farther than a plane's", () => {
    const s = ship({ entityId: 1, ...worldAt(396, 380) });
    const p = plane({ ...worldAt(404, 380) });
    // Click at 401: missile=5 px, plane=3 px (2 px closer) → ship wins.
    const hit = pickMinimapTarget(input({ ships: [s], planes: [p] }), 401, 380);
    expect(hit?.kind).toBe("ship");
  });

  it("takes the plane when it is clearly nearer than the ship", () => {
    const s = ship({ entityId: 1, ...worldAt(390, 380) });
    const p = plane({ ...worldAt(404, 380) });
    // Ship is 11 px away, plane 3 px — more than 3 px apart.
    const hit = pickMinimapTarget(input({ ships: [s], planes: [p] }), 401, 380);
    expect(hit?.kind).toBe("plane");
  });

  it("orders torpedo above smoke", () => {
    const t = torpedo({ ...worldAt(383, 380) });
    const m = smoke({ ...worldAt(379, 380) });
    const hit = pickMinimapTarget(input({ torpedoes: [t], smokes: [m] }), 380, 380);
    expect(hit?.kind).toBe("torpedo");
  });

  it("keeps a ship on top of the ward fill it sails through", () => {
    const s = ship({ ...worldAt(380, 380) });
    const w = ward({ radiusWorld: (40 / 760) * 1000 });
    const hit = pickMinimapTarget(input({ ships: [s], wards: [w] }), 380, 380);
    expect(hit?.kind).toBe("ship");
  });
});

describe("pickMinimapTarget capture-point ring band", () => {
  // 50 logical px ring on the full-map view.
  const radiusWorld = (50 / 760) * 1000;
  const ring = cap({ radiusWorld, letter: "B", owner: 2, etaS: 12 });

  it("hits anywhere on the drawn rim band", () => {
    const onRim = pickMinimapTarget(input({ caps: [ring] }), 430, 380);
    expect(onRim).toMatchObject({ kind: "cap", letter: "B", owner: 2, etaS: 12 });
    const nearRim = pickMinimapTarget(input({ caps: [ring] }), 424, 380);
    expect(nearRim?.kind).toBe("cap");
  });

  it("hits the letter disc at the centre", () => {
    expect(pickMinimapTarget(input({ caps: [ring] }), 388, 380)?.kind).toBe("cap");
  });

  it("misses the empty space between the letter and the rim", () => {
    expect(pickMinimapTarget(input({ caps: [ring] }), 410, 380)).toBeNull();
    expect(pickMinimapTarget(input({ caps: [ring] }), 470, 380)).toBeNull();
  });
});

describe("pickMinimapTarget ward ring band", () => {
  // 40 logical px rim; radius in world units for the full-map view.
  const radiusWorld = (40 / 760) * 1000;
  const w = ward({ radiusWorld });

  it("hits on the rim", () => {
    const hit = pickMinimapTarget(input({ wards: [w] }), 420, 380);
    expect(hit).toMatchObject({ kind: "ward", role: "ally", ownerLabel: "Carrier" });
    // Band tolerance is 7 px: 47 px from centre still hits.
    expect(pickMinimapTarget(input({ wards: [w] }), 427, 380)?.kind).toBe("ward");
    expect(pickMinimapTarget(input({ wards: [w] }), 428, 380)).toBeNull();
  });

  it("never captures the translucent fill itself", () => {
    expect(pickMinimapTarget(input({ wards: [w] }), 380, 380)).toBeNull();
    expect(pickMinimapTarget(input({ wards: [w] }), 400, 380)).toBeNull();
  });
});
