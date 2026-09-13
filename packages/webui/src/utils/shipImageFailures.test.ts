/** Tests for the session-scoped ship-portrait failure tracker that drives
 *  the ShipsView image banner. The tracker is a module singleton, so each
 *  test re-imports the module with vi.resetModules() to start from a clean
 *  state instead of carrying failures across cases. */
import { describe, expect, it, vi } from "vitest";

import type * as tracker from "./shipImageFailures";

async function loadTracker(): Promise<typeof tracker> {
  vi.resetModules();
  return import("./shipImageFailures");
}

describe("shipImageFailures", () => {
  it("starts empty with the banner hidden", async () => {
    const { shipImageFailureCount, shouldShowImageBanner } = await loadTracker();
    expect(shipImageFailureCount.value).toBe(0);
    expect(shouldShowImageBanner.value).toBe(false);
  });

  it("counts distinct ship ids and ignores duplicate recordings", async () => {
    const { recordShipImageFailure, shipImageFailureCount, shouldShowImageBanner } =
      await loadTracker();
    recordShipImageFailure(101);
    recordShipImageFailure(101); // same ship again — idempotent
    expect(shipImageFailureCount.value).toBe(1);
    expect(shouldShowImageBanner.value).toBe(false);
  });

  it("flips the banner exactly at three distinct failures and keeps it on", async () => {
    const { recordShipImageFailure, shipImageFailureCount, shouldShowImageBanner } =
      await loadTracker();
    recordShipImageFailure(101);
    recordShipImageFailure(102);
    expect(shouldShowImageBanner.value).toBe(false);
    recordShipImageFailure(103);
    expect(shipImageFailureCount.value).toBe(3);
    expect(shouldShowImageBanner.value).toBe(true);
    // Further failures (new or duplicate ids) never turn the banner back off.
    recordShipImageFailure(104);
    recordShipImageFailure(101);
    expect(shipImageFailureCount.value).toBe(4);
    expect(shouldShowImageBanner.value).toBe(true);
  });
});
