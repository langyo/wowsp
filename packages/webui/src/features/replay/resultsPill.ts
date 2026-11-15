/**
 * The 战后统计 (post-battle results) entry point's faces — the meta-row pill
 * and the window body it opens.
 *
 * WHY THE PILL HAS NO LOADING FACE. The pill is the post-battle window's
 * ONLY entry point, so any state that blocks it blocks the entire results
 * surface. A spinner there tells the user to wait for something they cannot
 * open, and it is indistinguishable from a hang: the packet-stream decode
 * behind it can be slow (a large replay), and the `useReplayPositions`
 * watchdog only bounds a stalled channel at 30 s. The window, by contrast,
 * is cheap to open empty and owns its own pending state — spinner +
 * `replay.loading` while the decode runs, swapped reactively to the decoded
 * full/fallback panel the moment data lands. So the pill stays interactive
 * from the moment a replay is open.
 *
 * The ONE exception is the danger face: a failed (or watchdog-timed-out)
 * decode with NOTHING to show keeps the pill mounted as a non-interactive
 * danger tag carrying the failure as its data-hint. A vanished pill was
 * read as "still spinning" in the 2026-11-13 report, and an empty window
 * would explain nothing.
 *
 * This module exists so both faces are pinned by unit tests rather than by
 * the view's JSX: both shipped regressions were face-selection bugs (the
 * 2026-11-12 "还在转圈" report retired the loading face, and the 2026-11-13
 * report — a vanished pill read as "still spinning" — pinned the danger
 * face).
 */

/** The pill's faces. There is deliberately NO loading face. */
export type ResultsPillFace = "failed" | "open";

/** Inputs for the pill's face. */
export interface ResultsPillState {
  /** The packet-stream decode failed: the IPC read rejected, or the
   *  `useReplayPositions` watchdog settled a stalled read. */
  failed: boolean;
  /** Viewable results data exists — a decoded battle-results payload or a
   *  decoded trajectory stream. Read with truthiness semantics (an empty
   *  payload string counts as absent), exactly like the window body gate. */
  hasData: boolean;
}

/**
 * The face the results pill wears.
 *
 * Data outranks failure on purpose: a decode that published part of the
 * stream before throwing still leaves a window worth opening, so the pill
 * opens it and the decoded panel takes over (the window body ranks data
 * first too — hasData means the body is panel/fallback, never the error
 * note; see resultsWindowBody).
 */
export function resultsPillFace({ failed, hasData }: ResultsPillState): ResultsPillFace {
  return failed && !hasData ? "failed" : "open";
}

/** Which body the results window renders for the open replay. */
export type ResultsWindowBody = "panel" | "fallback" | "pending" | "error" | "empty";

/** Inputs for the window body's state. */
export interface ResultsWindowState {
  /** A decoded battle-results payload exists (the full PostBattlePanel). */
  hasBattleResults: boolean;
  /** Decoded trajectories exist (the fallback panel — last recorded state). */
  hasTrajectories: boolean;
  /** The packet-stream decode is still running. */
  loading: boolean;
  /** The decode failed (rejection or watchdog timeout). */
  failed: boolean;
}

/**
 * The window body's state, in swap priority order:
 *
 *  - "panel"    — the full PostBattlePanel (battle results landed);
 *  - "fallback" — PostBattleFallbackPanel (trajectories landed, no results
 *                 payload: a replay that ended before the results were
 *                 recorded);
 *  - "pending"  — the window's OWN wait (spinner + `replay.loading`);
 *  - "error"    — the decode failed with nothing to show;
 *  - "empty"    — a settled decode produced nothing to display (the
 *                 incomplete-data note).
 *
 * Data FIRST, always: the decoded panel must replace the pending body in the
 * same reactive flush the decode lands in. In current code there is no
 * render in which data and `loading` are both true (the view's `apply()`
 * and the composable's settle run in one synchronous continuation), but the
 * order is pinned here so a future async split cannot reintroduce the
 * "spins while the data is already on screen" class this window exists to
 * fix.
 */
export function resultsWindowBody({
  hasBattleResults,
  hasTrajectories,
  loading,
  failed,
}: ResultsWindowState): ResultsWindowBody {
  if (hasBattleResults) return "panel";
  if (hasTrajectories) return "fallback";
  if (loading) return "pending";
  if (failed) return "error";
  return "empty";
}
