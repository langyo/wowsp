/** Tests for the 战后统计 entry point's faces (features/replay/resultsPill).
 *
 *  The pill's contract is "NEVER a loading face": it is the post-battle
 *  window's only entry point, so a spinner on it blocks exactly the surface
 *  that would explain the wait. These tests pin that (the previous #1966
 *  gate — `resultsLoading && !resultsPillHasData` — still left a spinner as
 *  the pill's default face for the whole decode, which is the state the
 *  2026-11-12 "还在转圈" report retired).
 *
 *  The window-body contract is the other half: the window owns the pending
 *  state and swaps to the decoded panel the moment data lands, in that
 *  priority order (data first).
 */
import { describe, expect, it } from "vitest";

import { resultsPillFace, resultsWindowBody } from "./resultsPill";

describe("resultsPillFace", () => {
  it("opens the window before any decode data exists (never a spinner)", () => {
    // The reported class: a replay is open, the packet decode is still
    // running (or stalled), nothing landed yet. The pill must stay the
    // window's entry point — the WINDOW carries the spinner.
    expect(resultsPillFace({ failed: false, hasData: false })).toBe("open");
  });

  it("opens the window while the decode is still running but data landed", () => {
    expect(resultsPillFace({ failed: false, hasData: true })).toBe("open");
  });

  it("wears the danger face when the decode failed with nothing to show", () => {
    // The 2026-11-13 report: the pill used to vanish on a failed/stalled
    // read, which read as "still spinning". It stays mounted, non-
    // interactive, carrying the failure as its data-hint.
    expect(resultsPillFace({ failed: true, hasData: false })).toBe("failed");
  });

  it("prefers the openable window over the failure when data landed", () => {
    // A decode that published part of the stream before throwing still
    // leaves a window worth opening; the window's own body ranks data
    // above the failure flag the same way.
    expect(resultsPillFace({ failed: true, hasData: true })).toBe("open");
  });
});

describe("resultsWindowBody", () => {
  it("renders the full panel once the battle results land", () => {
    expect(
      resultsWindowBody({
        hasBattleResults: true,
        hasTrajectories: true,
        loading: false,
        failed: false,
      }),
    ).toBe("panel");
  });

  it("renders the fallback panel when only trajectories landed", () => {
    expect(
      resultsWindowBody({
        hasBattleResults: false,
        hasTrajectories: true,
        loading: false,
        failed: false,
      }),
    ).toBe("fallback");
  });

  it("keeps the decoded panel ahead of a still-pending decode", () => {
    // Pins the swap order: if loading ever overlaps published data, the
    // panel must win — a window stuck on its spinner while the results are
    // already decoded is exactly the reported class.
    expect(
      resultsWindowBody({
        hasBattleResults: true,
        hasTrajectories: true,
        loading: true,
        failed: false,
      }),
    ).toBe("panel");
    expect(
      resultsWindowBody({
        hasBattleResults: false,
        hasTrajectories: true,
        loading: true,
        failed: false,
      }),
    ).toBe("fallback");
  });

  it("owns the pending state while the decode runs with nothing landed", () => {
    expect(
      resultsWindowBody({
        hasBattleResults: false,
        hasTrajectories: false,
        loading: true,
        failed: false,
      }),
    ).toBe("pending");
  });

  it("shows the decode failure once the read settled with nothing landed", () => {
    expect(
      resultsWindowBody({
        hasBattleResults: false,
        hasTrajectories: false,
        loading: false,
        failed: true,
      }),
    ).toBe("error");
  });

  it("shows the incomplete-data note when a settled decode produced nothing", () => {
    expect(
      resultsWindowBody({
        hasBattleResults: false,
        hasTrajectories: false,
        loading: false,
        failed: false,
      }),
    ).toBe("empty");
  });
});
