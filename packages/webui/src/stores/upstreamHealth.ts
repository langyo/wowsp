import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type UpstreamHostReport } from "@/api";

/** Verdict knobs for the title bar's upstream-fault chip.
 *
 *  The Rust side reports raw per-host transport outcomes (see
 *  `commands::upstream_health`); this store renders the verdict:
 *    - a host is "failing" after FAULT_STREAK_MIN consecutive failures
 *      with no success since — a single transient timeout must not flip
 *      the whole chrome into alarm mode,
 *    - and only while the episode is fresh: FAULT_STALE_SECS after the
 *      last failure the chip stands down on its own (the user may be
 *      idle; nobody re-probes the upstream to "confirm recovery" — the
 *      next real lookup refreshes the table instead).
 */
export const FAULT_STREAK_MIN = 2;
export const FAULT_STALE_SECS = 15 * 60;

/** Verdict for one host row at a point in time. Pure — the chip and the
 *  tests share this exact rule. */
export function hostIsFailing(entry: UpstreamHostReport, nowSec: number): boolean {
  if (!entry.recorded) return false;
  if (entry.consecutiveFailures < FAULT_STREAK_MIN) return false;
  const lastFailure = entry.lastFailureTs ?? 0;
  if (lastFailure <= 0) return false;
  if ((entry.lastSuccessTs ?? 0) >= lastFailure) return false;
  return nowSec - lastFailure < FAULT_STALE_SECS;
}

/** Stable key of one fault episode — the sorted failing-host id list.
 *  Dismissing an episode silences exactly these hosts until the cast
 *  changes (a new host fails, or a dismissed one heals and breaks
 *  again). */
export function faultKey(failing: UpstreamHostReport[]): string {
  return failing
    .map((e) => e.id)
    .sort()
    .join(",");
}

/** Upstream host health — feeds the title-bar fault chip. Stateless on
 *  the Rust side; refreshes ride the app's own lookup traffic (never a
 *  probe of a struggling service): stats lookups ping `scheduleRefresh`
 *  on success AND failure, the chip polls slowly while visible, and the
 *  staleness rule retires stale episodes without any request. */
export const useUpstreamHealthStore = defineStore("upstreamHealth", () => {
  /** Last `upstream_health` table. Empty until the first refresh. */
  const entries = ref<UpstreamHostReport[]>([]);
  /** Episode the user dismissed; empty string when nothing is silenced. */
  const dismissedKey = ref<string>("");
  let inFlight: Promise<void> | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /** Refresh once, coalescing concurrent callers. Failures keep the last
   *  table — a flaky command round-trip must not blank the chip's data. */
  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        entries.value = await api.upstreamHealth();
        const now = Math.floor(Date.now() / 1000);
        const anyFailing = entries.value.some((e) => hostIsFailing(e, now));
        if (!anyFailing && dismissedKey.value) {
          // Everything healed — retire the dismissal so the NEXT episode
          // (even the exact same hosts breaking again) re-rings the chip.
          dismissedKey.value = "";
        }
      } catch {
        // best-effort: keep the previous table
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** Trailing debounce — a failed roster batch fires many rejects at
   *  once; one refresh answers them all. */
  function scheduleRefresh(): void {
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void refresh();
    }, 2_500);
  }

  /** Silence the current episode. */
  function dismiss(failing: UpstreamHostReport[]): void {
    dismissedKey.value = faultKey(failing);
  }

  return { entries, dismissedKey, refresh, scheduleRefresh, dismiss };
});
