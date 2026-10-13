/** Mode-preset unit tests: templates, instantiation and mirroring (pure). */
import { describe, expect, it } from "vitest";
import { instantiateCaps, mirrorCaps, modePresetOf, MODE_PRESETS } from "./modes";

const BOUNDS = { minX: -700, maxX: 700, minZ: -700, maxZ: 700 };

describe("MODE_PRESETS", () => {
  it("every preset id resolves back to itself", () => {
    for (const m of MODE_PRESETS) {
      expect(modePresetOf(m.id)?.id).toBe(m.id);
    }
    expect(modePresetOf("nope")).toBeNull();
    expect(modePresetOf(null)).toBeNull();
  });

  it("cap counts step 0..4 across the random family", () => {
    const counts = MODE_PRESETS.filter((m) => m.family === "random").map((m) => m.caps.length);
    expect(counts).toEqual([4, 3, 2, 1, 0]);
  });

  it("operation caps may be station-gated with an appearance time", () => {
    const op = modePresetOf("pve-op");
    expect(op).not.toBeNull();
    expect(op!.caps.some((c) => c.station && (c.appearT ?? 0) > 0)).toBe(true);
  });
});

describe("instantiateCaps", () => {
  it("maps template fractions onto the playable rect", () => {
    const preset = modePresetOf("random-3")!;
    const caps = instantiateCaps(preset, BOUNDS);
    expect(caps).toHaveLength(3);
    // Template x=0.5 lands on the rect's centre.
    const centre = caps.find((c) => c.letter === "B")!;
    expect(centre.at.x).toBeCloseTo(0, 6);
    expect(centre.at.z).toBeCloseTo(0, 6);
    // The ally home cap keeps ITS side — the south half, where the ally
    // fleet spawns (spawnPoses puts allies at the z-fraction 0.09 edge).
    const a = caps.find((c) => c.letter === "A")!;
    expect(a.team).toBe("ally");
    expect(a.at.z).toBeLessThan(0);
    const cCap = caps.find((c) => c.letter === "C")!;
    expect(cCap.team).toBe("enemy");
    expect(cCap.at.z).toBeGreaterThan(0);
  });
});

describe("mirrorCaps", () => {
  it("flips positions across the midline and swaps ownership", () => {
    const preset = modePresetOf("random-3")!;
    const caps = instantiateCaps(preset, BOUNDS);
    const mirrored = mirrorCaps(caps, BOUNDS);
    const a = caps.find((c) => c.letter === "A")!;
    const ma = mirrored.find((c) => c.letter === "A")!;
    expect(ma.at.x).toBeCloseTo(-a.at.x, 6);
    expect(ma.at.z).toBeCloseTo(-a.at.z, 6);
    expect(ma.team).toBe("enemy");
  });
});
