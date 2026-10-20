import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePiggyReminderStore } from "./piggyReminder";

/** The piggy reminder's pure schedule math, pinned to fixed dates: the
 *  period anchors (first use + 7 days, then calendar months), the
 *  raise-once-per-period suppression, clock-rollback/forward edges, and
 *  the arm/consume arrival latch. */

const FIRST_USE_KEY = "wowsp-first-use-at";
const LAST_DUE_KEY = "wowsp-piggy-reminder-last-due";

/** Noon anchors keep month-end clamping out of the arithmetic. */
const FIRST_USE = new Date(2026, 0, 1, 12).getTime();
const AT = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTime();

beforeEach(() => {
  vi.setSystemTime(AT(2026, 0, 1));
  localStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("piggy reminder schedule", () => {
  it("records first use on the first check and stays quiet while young", () => {
    const piggy = usePiggyReminderStore();
    expect(piggy.checkDue()).toBeNull();
    expect(Number(localStorage.getItem(FIRST_USE_KEY))).toBe(FIRST_USE);
  });

  it("treats an existing first-use slot as the anchor", () => {
    localStorage.setItem(FIRST_USE_KEY, String(FIRST_USE));
    const piggy = usePiggyReminderStore();
    // Day 3 of tenure — the gate is open but the first period is not.
    vi.setSystemTime(AT(2026, 0, 4));
    expect(piggy.checkDue()).toBeNull();
    expect(localStorage.getItem(FIRST_USE_KEY)).toBe(String(FIRST_USE));
  });

  it("raises once at first use + 7 days and not again in the same period", () => {
    localStorage.setItem(FIRST_USE_KEY, String(FIRST_USE));
    vi.setSystemTime(AT(2026, 0, 9));
    const piggy = usePiggyReminderStore();
    const due = piggy.checkDue();
    expect(due).toBe(AT(2026, 0, 8));
    piggy.markShown(due as number);
    expect(piggy.checkDue()).toBeNull();
  });

  it("raises again on the next monthly period", () => {
    localStorage.setItem(FIRST_USE_KEY, String(FIRST_USE));
    localStorage.setItem(LAST_DUE_KEY, String(AT(2026, 0, 8)));
    vi.setSystemTime(AT(2026, 1, 10));
    const piggy = usePiggyReminderStore();
    expect(piggy.checkDue()).toBe(AT(2026, 1, 8));
  });

  it("collapses several skipped periods into the latest one", () => {
    localStorage.setItem(FIRST_USE_KEY, String(FIRST_USE));
    localStorage.setItem(LAST_DUE_KEY, String(AT(2026, 0, 8)));
    vi.setSystemTime(AT(2026, 4, 20));
    const piggy = usePiggyReminderStore();
    expect(piggy.checkDue()).toBe(AT(2026, 4, 8));
  });

  it("never re-raises an already-consumed later period (clock rolled back)", () => {
    localStorage.setItem(FIRST_USE_KEY, String(FIRST_USE));
    localStorage.setItem(LAST_DUE_KEY, String(AT(2026, 2, 8)));
    vi.setSystemTime(AT(2026, 1, 20));
    const piggy = usePiggyReminderStore();
    expect(piggy.checkDue()).toBeNull();
  });

  it("rejects a tampered out-of-range first-use slot and re-anchors", () => {
    localStorage.setItem(FIRST_USE_KEY, String(9e15));
    const piggy = usePiggyReminderStore();
    expect(piggy.checkDue()).toBeNull();
    expect(Number(localStorage.getItem(FIRST_USE_KEY))).toBe(FIRST_USE);
  });
});

describe("piggy reminder arrival hand-off", () => {
  it("arms once and lets exactly one consumer greet", () => {
    const piggy = usePiggyReminderStore();
    expect(piggy.arrivedFromToast).toBe(false);
    piggy.armArrival();
    expect(piggy.arrivedFromToast).toBe(true);
    expect(piggy.consumeArrival()).toBe(true);
    expect(piggy.arrivedFromToast).toBe(false);
    expect(piggy.consumeArrival()).toBe(false);
  });
});
