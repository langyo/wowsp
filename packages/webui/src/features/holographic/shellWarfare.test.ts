import { describe, expect, it } from "vitest";
import {
  SHELL_TRAIL_BASE_ALPHA,
  SHELL_TRAIL_HEAD_ALPHA,
  SHELL_TRAIL_HEAD_SPAN,
  SHELL_TRACE_SAMPLES,
  shellTrailAlpha,
} from "./shellWarfare";

describe("shellTrailAlpha", () => {
  it("pins the agreed constants: 10% base, 50% head, 5% span", () => {
    expect(SHELL_TRAIL_BASE_ALPHA).toBe(0.1);
    expect(SHELL_TRAIL_HEAD_ALPHA).toBe(0.5);
    expect(SHELL_TRAIL_HEAD_SPAN).toBe(0.05);
    // The head gradient must cross several sample gaps, or it renders as one
    // hard step: the 5% window has to span more than 2 sample intervals
    // (i.e. land on at least 3 vertices).
    expect(SHELL_TRACE_SAMPLES * SHELL_TRAIL_HEAD_SPAN).toBeGreaterThan(2);
  });

  it("peaks at the shell's current position and decays back to the base", () => {
    const p = 0.5;
    expect(shellTrailAlpha(p, p)).toBeCloseTo(SHELL_TRAIL_HEAD_ALPHA, 10);
    // Exactly the span behind the head: already the base ghost.
    expect(shellTrailAlpha(p - SHELL_TRAIL_HEAD_SPAN, p)).toBeCloseTo(
      SHELL_TRAIL_BASE_ALPHA,
      10,
    );
    // Halfway through the gradient window: halfway between the two alphas.
    expect(shellTrailAlpha(p - SHELL_TRAIL_HEAD_SPAN / 2, p)).toBeCloseTo(
      (SHELL_TRAIL_HEAD_ALPHA + SHELL_TRAIL_BASE_ALPHA) / 2,
      10,
    );
  });

  it("keeps the base alpha outside the head window — including ahead of the shell", () => {
    const p = 0.4;
    expect(shellTrailAlpha(0, p)).toBe(SHELL_TRAIL_BASE_ALPHA);
    expect(shellTrailAlpha(p - 0.2, p)).toBe(SHELL_TRAIL_BASE_ALPHA);
    // The not-yet-flown stretch stays a faint ghost of where the shell goes.
    expect(shellTrailAlpha(p + 1e-6, p)).toBe(SHELL_TRAIL_BASE_ALPHA);
    expect(shellTrailAlpha(1, p)).toBe(SHELL_TRAIL_BASE_ALPHA);
  });

  it("is monotonic across the window and bounded by the two alphas", () => {
    const p = 0.7;
    let prev = shellTrailAlpha(p - SHELL_TRAIL_HEAD_SPAN, p);
    for (let i = 1; i <= 20; i++) {
      const k = p - SHELL_TRAIL_HEAD_SPAN + (SHELL_TRAIL_HEAD_SPAN * i) / 20;
      const a = shellTrailAlpha(k, p);
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(a).toBeLessThanOrEqual(SHELL_TRAIL_HEAD_ALPHA);
      prev = a;
    }
    // Sweep the whole (k, p) space: never below the base, never above the head.
    for (let pi = 0; pi <= 10; pi++) {
      const pp = pi / 10;
      for (let ki = 0; ki <= 10; ki++) {
        const a = shellTrailAlpha(ki / 10, pp);
        expect(a).toBeGreaterThanOrEqual(SHELL_TRAIL_BASE_ALPHA);
        expect(a).toBeLessThanOrEqual(SHELL_TRAIL_HEAD_ALPHA);
      }
    }
  });

  it("handles the flight edges: launch (p=0) and impact (p=1)", () => {
    // The instant the shell leaves the barrel the only gradient sample is
    // the launch point itself — full head alpha at the muzzle.
    expect(shellTrailAlpha(0, 0)).toBeCloseTo(SHELL_TRAIL_HEAD_ALPHA, 10);
    expect(shellTrailAlpha(0.05, 0)).toBe(SHELL_TRAIL_BASE_ALPHA);
    // At impact the trail behind the head is a normal gradient run.
    expect(shellTrailAlpha(1, 1)).toBeCloseTo(SHELL_TRAIL_HEAD_ALPHA, 10);
    expect(shellTrailAlpha(0.96, 1)).toBeCloseTo(
      SHELL_TRAIL_HEAD_ALPHA -
        (SHELL_TRAIL_HEAD_ALPHA - SHELL_TRAIL_BASE_ALPHA) * 0.8,
      10,
    );
  });
});
