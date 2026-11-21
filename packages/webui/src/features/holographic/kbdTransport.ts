/**
 * Keyboard transport arithmetic for the replay view (HolographicMap).
 *
 * The map wires three keys onto the existing transport:
 *   - Space          toggles pause/play (HolographicMap.togglePlay);
 *   - ArrowLeft/Right seek backwards/forwards.
 *
 * A SHORT arrow tap moves `playbackSpeed` battle-seconds (2x -> 2 s, 10x ->
 * 10 s). A HOLD starts at that same rate and accelerates to 10x of it over
 * KBD_RAMP_MS, re-seeking on the KBD_REPEAT_MS cadence; releasing the key
 * stops immediately. The curve, the step math and the clamp live here as
 * pure functions so they can be tested without a DOM — HolographicMap owns
 * only the listener and the seek call.
 *
 * Why the constants are what they are:
 *   - KBD_MAX_STEP_SECONDS caps a single step at 10 s. The transport's own
 *     speed list tops out at 10x (HoloSpeedMenu.PLAYBACK_SPEEDS), so the cap
 *     only bites for a hypothetical faster multiplier: 20x must not teleport
 *     the playhead 20 s on one press.
 *   - KBD_HOLD_DELAY_MS keeps a tap a single step: no repeat fires before the
 *     key has been down this long, so "short press = one playbackSpeed step"
 *     is literal.
 *   - KBD_RAMP_MS is the 1.7 s acceleration window that starts when the
 *     repeat window opens (not at keydown — that window is the short press).
 *     With the 0.3 s delay the multiplier reaches 10x exactly 2.0 s after
 *     keydown, inside the requested ~1.5-2 s window; the curve is linear,
 *     hence monotonic, and easy to reason about at the 100 ms cadence.
 *
 * The hold repeats the FULL ramped step every KBD_REPEAT_MS, so the sweep
 * rate at the cap is 10 x the short-press step per 100 ms. That is intended
 * for long seeks across a 20-minute replay; the ramp starts at the gentler
 * tap rate.
 */

/** Longest battle-seconds a single step may move (short press base). */
export const KBD_MAX_STEP_SECONDS = 10;

/** How long the key must be down before the hold repeat starts. */
export const KBD_HOLD_DELAY_MS = 300;

/** Ramp window after KBD_HOLD_DELAY_MS: multiplier 1x -> KBD_RAMP_MAX_FACTOR. */
export const KBD_RAMP_MS = 1700;

/** Multiplier at the end of the ramp (10x the short-press step). */
export const KBD_RAMP_MAX_FACTOR = 10;

/** Hold re-seek cadence in milliseconds. */
export const KBD_REPEAT_MS = 100;

/** Short-press step for the current playback multiplier (clamped to the cap). */
export function kbdBaseStepSeconds(playbackSpeed: number): number {
  if (!Number.isFinite(playbackSpeed)) return 0;
  return Math.min(Math.max(playbackSpeed, 0), KBD_MAX_STEP_SECONDS);
}

/**
 * Multiplier for a key that has been held `heldMs` milliseconds (measured
 * from keydown). Stays 1x through the short-press window, then rises linearly
 * to KBD_RAMP_MAX_FACTOR at KBD_HOLD_DELAY_MS + KBD_RAMP_MS and stays there.
 */
export function kbdRampFactor(heldMs: number): number {
  if (!Number.isFinite(heldMs)) return 1;
  const progress = Math.min(
    Math.max((heldMs - KBD_HOLD_DELAY_MS) / KBD_RAMP_MS, 0),
    1,
  );
  return 1 + (KBD_RAMP_MAX_FACTOR - 1) * progress;
}

/**
 * Battle-seconds one step moves after holding for `heldMs` milliseconds.
 * At `heldMs = 0` (a tap) this is exactly `baseSeconds`; the value only
 * grows, and never exceeds `baseSeconds * KBD_RAMP_MAX_FACTOR`.
 */
export function kbdStepSeconds(baseSeconds: number, heldMs: number): number {
  if (!Number.isFinite(baseSeconds) || baseSeconds <= 0) return 0;
  return baseSeconds * kbdRampFactor(heldMs);
}

/** Seek direction of a transport key: -1 left, +1 right, 0 for any other. */
export function kbdSeekDirection(key: string): -1 | 1 | 0 {
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  return 0;
}

/** Clamp an absolute seek target to [0, duration]. A non-finite input lands
 *  at 0 (before the replay), a non-finite duration collapses to 0. */
export function clampSeekSeconds(seconds: number, duration: number): number {
  const max = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(Math.max(seconds, 0), max);
}

/** Guard inputs for shouldHandleTransportKey — the wiring resolves each one
 *  from the DOM / component state so this decision stays unit-testable. */
export interface TransportKeyGate {
  /** The event target is a typing surface (input/textarea/contenteditable). */
  typingTarget: boolean;
  /** A window is stacked above the replay view (HoloExportModal or another
   *  HkModal), so the map must not act on an invisible surface. */
  modalOpen: boolean;
  /** The replay-clip export owns the playhead right now. */
  exporting: boolean;
  /** The replay surface is mounted, laid out and not the tactical editor. */
  active: boolean;
}

/** True when a transport key may act on the map: nothing above it owns the
 *  keyboard and the replay surface is the active one. */
export function shouldHandleTransportKey(gate: TransportKeyGate): boolean {
  return !gate.typingTarget && !gate.modalOpen && !gate.exporting && gate.active;
}

/**
 * True when one of `modals` is stacked ABOVE `surface` (the replay root).
 * A modal that CONTAINS the surface is the surface's own frame — the phone
 * replay-detail sheet renders the whole replay view inside an HkModal — and
 * must not count as covering it. Modals teleport to the overlay root, so a
 * sibling that does not contain the replay root is the real overlay case.
 */
export function isModalAboveSurface(
  surface: Element | null,
  modals: Iterable<Element>,
): boolean {
  if (!surface) return false;
  for (const modal of modals) {
    if (!modal.contains(surface)) return true;
  }
  return false;
}
