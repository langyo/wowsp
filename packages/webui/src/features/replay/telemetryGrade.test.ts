/** Tests for the live panel head's telemetry grade: a CONNECTED plugin
 *  must grade "partial" — its alive/sunk states are authoritative but the
 *  TAB row order is still the offline per-realm inference, because the
 *  plugin cannot read the game's own sorted collection (the unstable-
 *  knowledge stance in docs/en/designs/ingame-stats-plugin.md; the pill
 *  must never present the inferred order as game-truth). */
import { describe, expect, it } from "vitest";

import { telemetryGradeFor } from "./telemetryGrade";

describe("telemetryGradeFor", () => {
  it("grades partial while connected — the order is still inferred", () => {
    // Installed and current: alive/sunk come from inside the game, but no
    // payload field carries the game's row order today, so "plugin works
    // fully" would be a false claim.
    expect(telemetryGradeFor("plugin", { installed: true, outdated: false })).toBe("partial");
  });

  it("grades incomplete when the mode is picked but the plugin is missing", () => {
    expect(telemetryGradeFor("plugin", { installed: false, outdated: false })).toBe("incomplete");
    // An outdated build predates telemetry.json — it never emits, so it
    // cannot even deliver the alive/sunk half.
    expect(telemetryGradeFor("plugin", { installed: true, outdated: true })).toBe("incomplete");
  });

  it("grades infer when plugin detection is not the selected roster mode", () => {
    // Even a healthy install changes nothing while the pixel pipeline is
    // the selected source.
    expect(telemetryGradeFor("passive", { installed: true, outdated: false })).toBe("infer");
    expect(telemetryGradeFor("passive", { installed: false, outdated: true })).toBe("infer");
  });
});
