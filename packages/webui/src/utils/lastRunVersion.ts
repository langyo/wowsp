/**
 * Cross-restart memory of the app version each run booted into. The
 * installer kills the app and relaunches the new build, so a fresh
 * process compares this slot against its own version to know an update
 * just landed (same pattern as the onboarding run-once flags).
 *
 * `peekLastRunVersion` must be read BEFORE any writer runs when the
 * pre-update value matters: the shell's setup reads it ahead of the
 * child toasts, whose mounted hooks record the current run.
 */
const LAST_RUN_KEY = "wowsp-last-run-version";

/** The version the previous run booted into (null on a first-ever boot). */
export function peekLastRunVersion(): string | null {
  return localStorage.getItem(LAST_RUN_KEY);
}

/** Record the version the CURRENT run booted into. */
export function recordRunVersion(version: string): void {
  localStorage.setItem(LAST_RUN_KEY, version);
}
