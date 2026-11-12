/**
 * The 战报 (AI report) modal's data host, extracted from ReplayView so the
 * bounded-fetch policy is unit-testable (the same seam useReplayPositions
 * occupies for the packet stream). One `decisionStaticReport` call per
 * perspective open. The IPC call cannot be aborted (Tauri has no per-invoke
 * cancel), so — the same rule the results pill's stream read got in #1863 —
 * a read watchdog settles the VISIBLE state on expiry: a stalled
 * `ipc.localhost` round trip (the wedge class utils/ipcGuard.ts probes for
 * at startup) surfaces an error instead of owning the modal's spinner
 * forever. The seq is deliberately NOT bumped on expiry: the backend caches
 * the scoring pass, so a late-but-current answer still lands and upgrades
 * the error state in place; closing the modal orphans the run.
 */
import { ref } from "vue";

import { api, type StaticReport } from "@/api";
import { STATIC_REPORT_READ_TIMEOUT_MS } from "@/api/modules/decision";

// Re-exported for the tests (the useReplayPositions precedent: the bound
// rides the module under test).
export { STATIC_REPORT_READ_TIMEOUT_MS };

export function useStaticReport() {
  /** The modal's open flag — the chrome stays in the host's template. */
  const showReport = ref(false);
  /** The focused perspective's report (`null` entity = the recorder, the
   *  always-fully-observable default the Rust side serves). */
  const report = ref<StaticReport | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** Stale-response guard: a perspective switch can overlap the previous
   *  fetch, and closing the modal must orphan an in-flight one — only the
   *  newest request may land in the state above. */
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = async (path: string | null | undefined, entityId?: number | null) => {
    if (!path) return;
    if (timer !== undefined) clearTimeout(timer);
    const run = ++seq;
    showReport.value = true;
    loading.value = true;
    error.value = null;
    timer = setTimeout(() => {
      if (run !== seq) return;
      loading.value = false;
      error.value = `AI report read timed out after ${STATIC_REPORT_READ_TIMEOUT_MS / 1000}s`;
    }, STATIC_REPORT_READ_TIMEOUT_MS);
    try {
      const next = await api.decisionStaticReport(path, entityId ?? null);
      // A stale reply must not patch a panel that moved on.
      if (run !== seq) return;
      report.value = next;
      // A late-but-current answer replaces the watchdog's error face.
      error.value = null;
    } catch (err) {
      if (run !== seq) return;
      error.value = String(err);
    } finally {
      if (run === seq) {
        if (timer !== undefined) clearTimeout(timer);
        loading.value = false;
      }
    }
  };

  /** Close the modal and orphan any in-flight fetch (its reply must not
   *  patch a panel the user already dismissed). */
  const close = () => {
    showReport.value = false;
    seq += 1;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    loading.value = false;
  };

  return { showReport, report, loading, error, open, close };
}
