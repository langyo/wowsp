/**
 * playhead — a tiny shared battle-time cursor.
 *
 * The app and the site both advance a battle clock in their RAF loops; this
 * is that one timing model, packaged so no feature code reaches for ad-hoc
 * `setInterval` / local counters. Pause/resume are first-class (hover-pause
 * for auto-cycling UIs, scrubber pauses, reduced-motion freezes).
 */
export interface Playhead {
  /** Current battle time, seconds. */
  readonly time: number;
  readonly paused: boolean;
  pause(): void;
  resume(): void;
  /** Advance by dt seconds (no-op while paused). Returns the new time. */
  advance(dt: number): number;
  seek(t: number): void;
  reset(t?: number): void;
}

export function createPlayhead(initial = 0): Playhead {
  let t = Math.max(0, initial);
  let isPaused = false;
  return {
    get time() { return t; },
    get paused() { return isPaused; },
    pause() { isPaused = true; },
    resume() { isPaused = false; },
    advance(dt: number) {
      if (!isPaused && dt > 0) t += dt;
      return t;
    },
    seek(v: number) { t = Math.max(0, v); },
    reset(v = 0) { t = Math.max(0, v); isPaused = false; },
  };
}

export type CycleTimer = ReturnType<typeof createCycleTimer>;

/**
 * A pausable auto-cycle timer (the ship stage's holo ↔ armor alternation,
 * carousel rotations, …). Hovering a widget pauses the cycle; leaving
 * resumes it. No ad-hoc setInterval in feature code.
 */
export function createCycleTimer(
  intervalMs: number,
  onCycle: () => void,
  immediate = false,
) {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function schedule() {
    if (stopped || handle) return;
    if (immediate) {
      immediate = false;
      onCycle();
    }
    handle = setTimeout(() => {
      handle = null;
      onCycle();
      schedule();
    }, intervalMs);
  }
  function clear() {
    if (handle) { clearTimeout(handle); handle = null; }
  }

  return {
    start() { stopped = false; schedule(); },
    pause() { clear(); },
    resume() { if (!stopped && !handle) schedule(); },
    stop() { stopped = true; clear(); },
    get running() { return !stopped && !!handle; },
  };
}
