/** Unit tests for the replay view's keyboard transport math and gates. */
import { describe, expect, it } from "vitest";
import {
  KBD_HOLD_DELAY_MS,
  KBD_MAX_STEP_SECONDS,
  KBD_RAMP_MAX_FACTOR,
  KBD_RAMP_MS,
  KBD_REPEAT_MS,
  clampSeekSeconds,
  isModalAboveSurface,
  kbdBaseStepSeconds,
  kbdRampFactor,
  kbdSeekDirection,
  kbdStepSeconds,
  shouldHandleTransportKey,
} from "./kbdTransport";

describe("kbdBaseStepSeconds", () => {
  it("uses the playback multiplier as the short-press step", () => {
    expect(kbdBaseStepSeconds(1)).toBe(1);
    expect(kbdBaseStepSeconds(2)).toBe(2);
    expect(kbdBaseStepSeconds(5)).toBe(5);
    expect(kbdBaseStepSeconds(10)).toBe(10);
  });

  it("caps the step at KBD_MAX_STEP_SECONDS (20x must not jump 20 s)", () => {
    expect(kbdBaseStepSeconds(20)).toBe(KBD_MAX_STEP_SECONDS);
    expect(kbdBaseStepSeconds(1000)).toBe(KBD_MAX_STEP_SECONDS);
  });

  it("keeps slow multipliers and non-finite input sane", () => {
    expect(kbdBaseStepSeconds(0.5)).toBe(0.5);
    expect(kbdBaseStepSeconds(0)).toBe(0);
    expect(kbdBaseStepSeconds(-2)).toBe(0);
    expect(kbdBaseStepSeconds(Number.NaN)).toBe(0);
    expect(kbdBaseStepSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("kbdRampFactor", () => {
  it("stays at 1x through the short-press window", () => {
    expect(kbdRampFactor(0)).toBe(1);
    expect(kbdRampFactor(1)).toBe(1);
    expect(kbdRampFactor(KBD_HOLD_DELAY_MS - 1)).toBe(1);
    expect(kbdRampFactor(KBD_HOLD_DELAY_MS)).toBe(1);
  });

  it("ramps linearly to the 10x cap over KBD_RAMP_MS", () => {
    const mid = KBD_HOLD_DELAY_MS + KBD_RAMP_MS / 2;
    expect(kbdRampFactor(mid)).toBeCloseTo((1 + KBD_RAMP_MAX_FACTOR) / 2, 10);
    expect(kbdRampFactor(KBD_HOLD_DELAY_MS + KBD_RAMP_MS)).toBe(KBD_RAMP_MAX_FACTOR);
  });

  it("reaches the 10x cap 2 s after keydown", () => {
    expect(kbdRampFactor(KBD_HOLD_DELAY_MS + KBD_RAMP_MS)).toBe(KBD_RAMP_MAX_FACTOR);
    expect(KBD_HOLD_DELAY_MS + KBD_RAMP_MS).toBe(2000);
    expect(kbdRampFactor(2000)).toBe(KBD_RAMP_MAX_FACTOR);
  });

  it("never exceeds the cap and never drops while held", () => {
    let prev = kbdRampFactor(0);
    for (let held = 0; held <= 4000; held += 10) {
      const factor = kbdRampFactor(held);
      expect(factor).toBeGreaterThanOrEqual(prev);
      expect(factor).toBeLessThanOrEqual(KBD_RAMP_MAX_FACTOR);
      prev = factor;
    }
    expect(kbdRampFactor(60_000)).toBe(KBD_RAMP_MAX_FACTOR);
  });
});

describe("kbdStepSeconds", () => {
  it("is exactly the base step for a short press, at every speed", () => {
    for (const speed of [0.5, 1, 2, 5, 10, 20]) {
      const base = kbdBaseStepSeconds(speed);
      expect(kbdStepSeconds(base, 0)).toBe(base);
      expect(kbdStepSeconds(base, KBD_HOLD_DELAY_MS)).toBe(base);
    }
  });

  it("scales the ramped step by the base step", () => {
    const mid = KBD_HOLD_DELAY_MS + KBD_RAMP_MS / 2;
    for (const base of [0.5, 1, 2, 5, 10]) {
      expect(kbdStepSeconds(base, mid)).toBeCloseTo(base * kbdRampFactor(mid), 10);
      expect(kbdStepSeconds(base, 60_000)).toBe(base * KBD_RAMP_MAX_FACTOR);
    }
  });

  it("is 0 for a non-positive or non-finite base", () => {
    expect(kbdStepSeconds(0, 1000)).toBe(0);
    expect(kbdStepSeconds(-1, 1000)).toBe(0);
    expect(kbdStepSeconds(Number.NaN, 1000)).toBe(0);
  });
});

describe("clampSeekSeconds", () => {
  it("clamps seeks into [0, duration]", () => {
    expect(clampSeekSeconds(5, 100)).toBe(5);
    expect(clampSeekSeconds(-5, 100)).toBe(0);
    expect(clampSeekSeconds(120, 100)).toBe(100);
    expect(clampSeekSeconds(0, 100)).toBe(0);
    expect(clampSeekSeconds(100, 100)).toBe(100);
  });

  it("collapses a zero/unknown duration and bad input to 0", () => {
    expect(clampSeekSeconds(10, 0)).toBe(0);
    expect(clampSeekSeconds(10, -1)).toBe(0);
    expect(clampSeekSeconds(Number.NaN, 100)).toBe(0);
    expect(clampSeekSeconds(10, Number.NaN)).toBe(0);
  });
});

describe("kbdSeekDirection", () => {
  it("maps only the two arrow keys", () => {
    expect(kbdSeekDirection("ArrowLeft")).toBe(-1);
    expect(kbdSeekDirection("ArrowRight")).toBe(1);
    expect(kbdSeekDirection(" ")).toBe(0);
    expect(kbdSeekDirection("ArrowUp")).toBe(0);
    expect(kbdSeekDirection("a")).toBe(0);
  });
});

describe("shouldHandleTransportKey", () => {
  const open = {
    typingTarget: false,
    modalOpen: false,
    exporting: false,
    active: true,
  };

  it("allows the keys when nothing blocks them", () => {
    expect(shouldHandleTransportKey(open)).toBe(true);
  });

  it("stands down for each blocker", () => {
    expect(shouldHandleTransportKey({ ...open, typingTarget: true })).toBe(false);
    expect(shouldHandleTransportKey({ ...open, modalOpen: true })).toBe(false);
    expect(shouldHandleTransportKey({ ...open, exporting: true })).toBe(false);
    expect(shouldHandleTransportKey({ ...open, active: false })).toBe(false);
  });
});

describe("isModalAboveSurface", () => {
  const el = (cls: string): HTMLElement => {
    const e = document.createElement("div");
    e.className = cls;
    return e;
  };

  it("reports a sibling modal as covering the replay surface", () => {
    const surface = el("holo-map");
    const modal = el("hk-modal-content");
    document.body.append(surface, modal);
    try {
      expect(isModalAboveSurface(surface, [modal])).toBe(true);
    } finally {
      surface.remove();
      modal.remove();
    }
  });

  it("does not count the phone detail sheet that CONTAINS the replay", () => {
    const sheet = el("hk-modal-content");
    const surface = el("holo-map");
    sheet.appendChild(surface);
    document.body.appendChild(sheet);
    try {
      expect(isModalAboveSurface(surface, [sheet])).toBe(false);
    } finally {
      sheet.remove();
    }
  });

  it("is false with no modal and when the surface is gone", () => {
    const surface = el("holo-map");
    expect(isModalAboveSurface(surface, [])).toBe(false);
    expect(isModalAboveSurface(null, [el("hk-modal-content")])).toBe(false);
  });
});

describe("documented constants", () => {
  it("keeps the transport contract the wiring relies on", () => {
    expect(KBD_HOLD_DELAY_MS).toBe(300);
    expect(KBD_RAMP_MS).toBe(1700);
    expect(KBD_RAMP_MAX_FACTOR).toBe(10);
    expect(KBD_REPEAT_MS).toBe(100);
    expect(KBD_MAX_STEP_SECONDS).toBe(10);
  });
});
