import { defineStore } from "pinia";
import { ref } from "vue";

/** localStorage slots (the `wowsp-*` convention, cf. utils/
 *  lastRunVersion.ts): the first-use timestamp is written once by the
 *  first desktop-shell boot that runs the schedule check (the toast
 *  component calls it 20 s after mount) — for installs predating this
 *  feature that is the upgrade boot, so their 7-day clock starts at the
 *  upgrade (the only sane rollout anchor). The last-due slot remembers
 *  which period's reminder was already raised, so a period never
 *  repeats and clock jumps can only skip periods, never re-raise them. */
const FIRST_USE_KEY = "wowsp-first-use-at";
const LAST_DUE_KEY = "wowsp-piggy-reminder-last-due";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reminders only exist for users who have been around at least three
 *  days (the first period ends even later, so in practice the gate only
 *  matters for a tampered/stored-forward first-use date). */
const MIN_TENURE_MS = 3 * DAY_MS;
/** The first period ends a week after first use; every later period
 *  adds one calendar month on top. */
const FIRST_PERIOD_MS = 7 * DAY_MS;
/** Max valid ECMAScript time value — anything beyond it would make the
 *  Date arithmetic produce NaN, so a tampered slot is discarded. */
const MAX_TIME_MS = 8.64e15;

function readMs(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 && value <= MAX_TIME_MS ? value : null;
  } catch {
    return null;
  }
}

function writeMs(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage unavailable — next boot re-evaluates from scratch.
  }
}

/** Due timestamp of period k: first use + 7 days + k calendar months.
 *  The Date constructor clamps the day-of-month (Jan 31 + 1 month lands
 *  on Mar 3), same as the playtime aggregation's month buckets. */
function dueAt(firstUse: number, period: number): number {
  const base = new Date(firstUse + FIRST_PERIOD_MS);
  return new Date(
    base.getFullYear(),
    base.getMonth() + period,
    base.getDate(),
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds(),
  ).getTime();
}

/**
 * The piggy's periodic "come find me" reminder schedule. Every period
 * (first use + 7 days, then monthly) raises ONE top-right toast card
 * inviting the user to the settings' About section — the toast component
 * (PiggyReminderToast) owns the timers and gates itself to the desktop
 * shell, so the store itself stays pure schedule math plus the
 * arrival hand-off below.
 */
export const usePiggyReminderStore = defineStore("piggyReminder", () => {
  /** Arrival hand-off: the toast ARMS, the About piggy CONSUMES. The ref
   *  drives reactivity; the non-reactive `armed` latch makes the consume
   *  single-shot even when several AboutContent instances watch the flag
   *  in one scheduler flush (desktop /settings page + settings modal can
   *  both be alive) — exactly one of them greets. */
  const arrivedFromToast = ref(false);
  let armed = false;

  /** Arm the greeting — called by the reminder toast right before it
   *  lands on the settings' About section. */
  function armArrival(): void {
    armed = true;
    arrivedFromToast.value = true;
  }

  /** Consume the greeting — true for exactly one caller per arm. */
  function consumeArrival(): boolean {
    if (!armed) return false;
    armed = false;
    arrivedFromToast.value = false;
    return true;
  }

  /** Latest period whose due time has already passed; null while the
   *  first period (first use + 7 days) is still pending. */
  function currentDue(firstUse: number, now: number): number | null {
    if (now < dueAt(firstUse, 0)) return null;
    let period = 0;
    // A clock set far forward walks many periods at once — the loop is
    // bounded by months of tenure and only ever runs once per check.
    while (dueAt(firstUse, period + 1) <= now) period += 1;
    return dueAt(firstUse, period);
  }

  /** A reminder is owed when the tenure gate has passed AND the current
   *  period's due time is later than the last one already raised.
   *  Returns the due timestamp to consume, or null. Also lazily writes
   *  the first-use slot on the check that finds it missing. */
  function checkDue(): number | null {
    const now = Date.now();
    let firstUse = readMs(FIRST_USE_KEY);
    if (firstUse === null) {
      firstUse = now;
      writeMs(FIRST_USE_KEY, firstUse);
    }
    if (now - firstUse < MIN_TENURE_MS) return null;
    const due = currentDue(firstUse, now);
    if (due === null || !Number.isFinite(due)) return null;
    const lastDue = readMs(LAST_DUE_KEY);
    if (lastDue !== null && lastDue >= due) return null;
    return due;
  }

  /** Consume a period — call when the toast is RAISED, not when it is
   *  clicked: a card the user misses must not nag again until the next
   *  period. */
  function markShown(due: number): void {
    writeMs(LAST_DUE_KEY, due);
  }

  return { arrivedFromToast, armArrival, consumeArrival, checkDue, markShown };
});
