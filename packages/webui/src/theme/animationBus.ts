/**
 * Shared requestAnimationFrame loop for the whole WoWSP webui. Every CSS-driven
 * motion and per-frame sampling registers here instead of calling rAF directly,
 * so an idle tab burns zero frames. Adapted from shittim-chest's animationBus.
 *
 * Public API:
 *   onFrame(cb, priority?)        — continuous per-frame callback
 *   onceFrame(cb)                 — fire-and-forget next-frame one-shot
 *   scheduleFrame(cb)             — cancelable one-shot (coalesce-many)
 *   reportTransition(durationMs)  — declare a CSS transition in-flight (no cb)
 *   scheduleEvery(cb, intervalMs) — rAF-driven repeating timer
 *   scheduleAfter(cb, delayMs)    — rAF-driven one-shot delay
 *   notifyScrollStart()           — suppress normal-priority during scroll
 *   setReducedMotion(flag)        — pause the animation loop (not one-shots)
 */

import { uuid } from "@/utils/uuid";

export interface FrameContext {
  delta: number;
  elapsed: number;
  now: number;
}

export interface AnimationHandle {
  disconnect(): void;
}

type Priority = "sync" | "normal" | "idle";
type Callback = (ctx: FrameContext) => void;

const syncCallbacks = new Map<string, Callback>();
const normalCallbacks = new Map<string, Callback>();
const idleCallbacks = new Map<string, Callback>();
const onceShot = new Map<string, Callback>();
const intervals = new Map<string, { cb: () => void; interval: number; last: number }>();
const activeTransitions = new Map<string, number>();

let rafId = 0;
let onceRaf = 0;
let startTime = 0;
let lastFrame = 0;
let lastNormalFrame = 0;
let lastIdleFrame = 0;
let scrollUntil = 0;
let reducedMotion = false;

function priorityMap(p: Priority): Map<string, Callback> {
  return p === "sync" ? syncCallbacks : p === "idle" ? idleCallbacks : normalCallbacks;
}

function ensure(): void {
  if (rafId !== 0) return;
  startTime = performance.now();
  lastFrame = startTime;
  lastNormalFrame = startTime;
  lastIdleFrame = startTime;
  const tick = (now: number) => {
    rafId = 0;
    loop(now);
  };
  rafId = requestAnimationFrame(tick);
}

function halt(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function loop(now: number): void {
  const delta = now - lastFrame;
  lastFrame = now;
  const ctx: FrameContext = { delta, elapsed: now - startTime, now };

  // sync: always
  for (const cb of syncCallbacks.values()) cb(ctx);

  // normal: throttle to ~30fps budget, skip during scroll
  if (now - lastNormalFrame >= 33 && now > scrollUntil) {
    lastNormalFrame = now;
    for (const cb of normalCallbacks.values()) cb(ctx);
  }

  // idle: throttle to ~0.5Hz
  if (now - lastIdleFrame >= 2000) {
    lastIdleFrame = now;
    for (const cb of idleCallbacks.values()) cb(ctx);
  }

  // intervals
  for (const entry of intervals.values()) {
    if (now - entry.last >= entry.interval) {
      entry.last = now;
      entry.cb();
    }
  }

  const hasWork =
    syncCallbacks.size > 0 ||
    normalCallbacks.size > 0 ||
    idleCallbacks.size > 0 ||
    intervals.size > 0 ||
    activeTransitions.size > 0;
  if (hasWork && !reducedMotion) {
    ensure();
  }
}

// Separate drainer for one-shots (runs even under reduced-motion).
function drainOnce(): void {
  onceRaf = 0;
  if (onceShot.size === 0) return;
  const items = Array.from(onceShot.entries());
  onceShot.clear();
  for (const [, cb] of items) cb({ delta: 0, elapsed: 0, now: performance.now() });
  if (onceShot.size > 0) {
    onceRaf = requestAnimationFrame(drainOnce);
  }
}

function scheduleOnceDrain(): void {
  if (onceRaf !== 0) return;
  onceRaf = requestAnimationFrame(drainOnce);
}

export function onFrame(cb: Callback, priority: Priority = "normal"): AnimationHandle {
  const id = uuid();
  priorityMap(priority).set(id, cb);
  ensure();
  return { disconnect: () => { syncCallbacks.delete(id); normalCallbacks.delete(id); idleCallbacks.delete(id); } };
}

export function onceFrame(cb: Callback): void {
  onceShot.set(uuid(), cb);
  scheduleOnceDrain();
}

export function scheduleFrame(cb: Callback): AnimationHandle {
  const id = uuid();
  onceShot.set(id, cb);
  scheduleOnceDrain();
  return { disconnect: () => { onceShot.delete(id); } };
}

export function reportTransition(durationMs: number): AnimationHandle {
  const id = uuid();
  const expiry = performance.now() + durationMs;
  activeTransitions.set(id, expiry);
  ensure();
  // self-cleanup
  setTimeout(() => {
    activeTransitions.delete(id);
  }, durationMs + 50);
  return { disconnect: () => { activeTransitions.delete(id); } };
}

export function scheduleEvery(cb: () => void, intervalMs: number): AnimationHandle {
  const id = uuid();
  intervals.set(id, { cb, interval: intervalMs, last: performance.now() });
  ensure();
  return { disconnect: () => { intervals.delete(id); } };
}

export function scheduleAfter(cb: () => void, delayMs: number): AnimationHandle {
  const id = uuid();
  intervals.set(id, { cb: () => { intervals.delete(id); cb(); }, interval: delayMs, last: performance.now() });
  ensure();
  return { disconnect: () => { intervals.delete(id); } };
}

export function notifyScrollStart(): void {
  scrollUntil = performance.now() + 150;
}

export function setReducedMotion(flag: boolean): void {
  reducedMotion = flag;
  if (flag) halt();
  else ensure();
}
