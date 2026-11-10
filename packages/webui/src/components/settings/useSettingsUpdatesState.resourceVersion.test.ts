/** The inventory's version-label normalizer (useSettingsUpdatesState).
 *
 *  The registry reports two version shapes on the same axis: RFC3339 stamps
 *  (the res/data-pack manifests) and opaque IDs (semver, build numbers,
 *  hash6). Both now share one column, so the timestamp-shaped values must
 *  render as the SAME local wall clock the installed column uses while the
 *  IDs stay verbatim — neither may leak into the other's formatting.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNetworkConfig: vi.fn(),
  setNetworkConfig: vi.fn(),
  githubMirrorLadder: vi.fn(),
  githubMirrorProbe: vi.fn(),
}));

vi.mock("@/api", () => ({ api: mocks }));
// settingsUi drags the router graph in — the normalizer never touches it.
vi.mock("@/stores/settingsUi", () => ({
  SETTINGS_ANCHOR_BAKED_MODELS: "baked-models",
  useSettingsUiStore: () => ({ show: vi.fn() }),
}));

import { formatLocalStamp } from "@/utils/format";
import { formatResourceVersion } from "./useSettingsUpdatesState";

describe("formatResourceVersion", () => {
  it("renders an RFC3339 version as the local YYYY-MM-DD HH:MM stamp", () => {
    const iso = "2026-11-06T14:34:10Z";
    // Same conversion the installed column uses (timezone-agnostic: both
    // sides run through formatLocalStamp on the test machine's clock).
    expect(formatResourceVersion(iso)).toBe(formatLocalStamp(iso));
    expect(formatResourceVersion(iso)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("keeps semver versions verbatim", () => {
    expect(formatResourceVersion("0.6.9")).toBe("0.6.9");
  });

  it("keeps numeric build ids verbatim", () => {
    expect(formatResourceVersion("13533378")).toBe("13533378");
  });

  it("keeps hash6 labels verbatim", () => {
    expect(formatResourceVersion("A1B2C3")).toBe("A1B2C3");
  });

  it("renders nothing for an empty version", () => {
    expect(formatResourceVersion(null)).toBeNull();
    expect(formatResourceVersion(undefined)).toBeNull();
    expect(formatResourceVersion("")).toBeNull();
  });
});
