/**
 * Session-scoped tracker for ship-portrait load failures.
 *
 * Drives the ShipsView banner that hints at a missing local resource
 * pack or an unreachable WG CDN. Failures accumulate across nations
 * and view modes within one app session; the tracker is intentionally
 * not persisted.
 */
import { computed, reactive } from "vue";

/** Distinct failed portraits before the failure counts as systemic. */
const BANNER_THRESHOLD = 3;

const state = reactive({ failed: new Set<number>() });

/** Record a failed portrait load for a ship id (idempotent). */
export function recordShipImageFailure(shipId: number): void {
  state.failed.add(shipId);
}

/** Distinct ships whose portraits failed this session. */
export const shipImageFailureCount = computed(() => state.failed.size);

/** True once enough distinct portraits failed to indicate a systemic cause. */
export const shouldShowImageBanner = computed(
  () => state.failed.size >= BANNER_THRESHOLD,
);
