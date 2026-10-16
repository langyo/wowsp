/**
 * Zoom-compensation math for the manual-locate picker surface.
 *
 * The shell's manual interface-scale preference applies root CSS `zoom`,
 * which would double-scale the picker's screenshot canvas: the layout
 * factor `k` measured off a zoomed box inflates by Z, and the canvas laid
 * out from it renders at Z² — the "content abnormally enlarged" bug on
 * high-DPI / manual-scale setups. The fix neutralizes zoom on the picker
 * root with a compensating `zoom`, derived from the box's visual-vs-layout
 * width ratio (`measuredRatio` = getBoundingClientRect / offsetWidth).
 *
 * Kept as a pure function so the convergence contract is unit-testable —
 * the snapping must live on the RESULT (the new fix), never on the
 * measurement: after a compensation lands, the next measurement reads
 * ≈1 (effective zoom), and snapping on THAT would discard the working
 * compensation and oscillate the surface under ResizeObserver feedback.
 */

/** Result-snapping epsilon: a fix within this of 1 is clamped to exactly 1
 *  (residual error from offsetWidth integer rounding stays sub-pixel). */
const ZOOM_FIX_EPSILON = 0.005;

/** Next compensating zoom for the picker root.
 *
 *  - `currentFix` — the compensating zoom currently applied (1 = none).
 *  - `measuredRatio` — visual width ÷ layout width of the root box, i.e.
 *    the subtree's CURRENT effective zoom (root zoom × currentFix).
 *
 *  Returns the fix that brings the effective zoom to 1: `currentFix /
 *  measuredRatio`, snapped to exactly 1 when already within
 *  [`ZOOM_FIX_EPSILON`]. Converges in one step from any state and stays
 *  put once converged (`(0.8, 1) → 0.8`, never `→ 1`). */
export function nextZoomFix(currentFix: number, measuredRatio: number): number {
  if (!Number.isFinite(measuredRatio) || measuredRatio <= 0) return currentFix;
  let next = currentFix / measuredRatio;
  if (Math.abs(next - 1) <= ZOOM_FIX_EPSILON) next = 1;
  return next;
}
