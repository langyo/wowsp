/** Convergence contract of the picker's zoom compensation — most
 *  importantly the no-oscillation property: once a compensation is applied
 *  and the next measurement reads effective zoom ≈ 1, the fix must STAY
 *  (snapping on the measurement instead of the result would discard it and
 *  ping-pong the surface under ResizeObserver feedback). */
import { describe, expect, it } from "vitest";

import { nextZoomFix } from "./manualLocateZoom";

describe("nextZoomFix", () => {
  it("compensates a manual root zoom from an uncompensated start", () => {
    expect(nextZoomFix(1, 1.25)).toBeCloseTo(0.8);
    expect(nextZoomFix(1, 1.5)).toBeCloseTo(1 / 1.5);
    expect(nextZoomFix(1, 3)).toBeCloseTo(1 / 3);
  });

  it("stays put once converged (measured effective ≈ 1)", () => {
    // The oscillation regression: 0.8 applied, next measurement reads 1.
    expect(nextZoomFix(0.8, 1)).toBe(0.8);
    expect(nextZoomFix(1 / 3, 1)).toBeCloseTo(1 / 3);
  });

  it("snaps to exactly 1 when the compensated fix lands within epsilon", () => {
    // Pref reverted to Auto while 0.8 was applied: measured ratio 0.8,
    // the correction lands exactly on 1.
    expect(nextZoomFix(0.8, 0.8)).toBe(1);
    // Residual within epsilon (offsetWidth rounding) snaps to exactly 1;
    // a real residual outside it must survive untouched.
    expect(nextZoomFix(1, 1.004)).toBe(1);
    expect(nextZoomFix(1.02, 1)).toBe(1.02);
  });

  it("re-converges after a mid-pick scale change (fix_old / ratio)", () => {
    // 0.8 applied (for Z=1.25), the root zoom moves to 1.5:
    // measured ratio = 1.5 × 0.8 = 1.2 → new fix = 0.8 / 1.2 = 2/3.
    expect(nextZoomFix(0.8, 1.2)).toBeCloseTo(2 / 3);
  });

  it("is a no-op on garbage measurements", () => {
    expect(nextZoomFix(0.8, 0)).toBe(0.8);
    expect(nextZoomFix(0.8, -2)).toBe(0.8);
    expect(nextZoomFix(0.8, Number.NaN)).toBe(0.8);
  });

  it("keeps Auto (no zoom) at exactly 1", () => {
    expect(nextZoomFix(1, 1)).toBe(1);
    expect(nextZoomFix(1, 1.003)).toBe(1);
  });
});
