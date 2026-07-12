/**
 * Background-capable timers wrapping native setInterval/setTimeout with the
 * same `disconnect()` contract as the animation bus. Used by useReportedTransition
 * and useTheme for work that must run in background tabs (where rAF pauses).
 * Adapted from shittim-chest's theme/cronBus.ts.
 */

export interface CronHandle {
  disconnect(): void;
}

export function scheduleCron(cb: () => void, intervalMs: number): CronHandle {
  const id = setInterval(cb, intervalMs);
  return { disconnect: () => clearInterval(id) };
}

export function scheduleCronAfter(cb: () => void, delayMs: number): CronHandle {
  const id = setTimeout(cb, delayMs);
  return { disconnect: () => clearTimeout(id) };
}
