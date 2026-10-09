/** Tests for the live panel head's telemetry grade: the top state is
 *  "exact" — the plugin's telemetry carried the game's OWN Tab sort keys
 *  for the whole roster (read off the avatars' ship components), so the
 *  row order is the client's. Without a covering sort-key map a connected
 *  plugin grades "partial" (alive/sunk authoritative, row order still the
 *  offline per-realm inference — the unstable-knowledge stance in
 *  docs/en/designs/ingame-stats-plugin.md; the pill must never present
 *  the inferred order as game-truth). */
import { describe, expect, it } from "vitest";

import { telemetryGradeFor } from "./telemetryGrade";

describe("telemetryGradeFor", () => {
  it("grades exact when the telemetry sort keys cover the roster", () => {
    expect(telemetryGradeFor("plugin", { installed: true, outdated: false }, true)).toBe("exact");
  });

  it("grades partial while connected without game-true sort keys", () => {
    // Alive/sunk come from inside the game, but no sort-key map arrived:
    // the row order is still the offline per-realm inference.
    expect(telemetryGradeFor("plugin", { installed: true, outdated: false }, false)).toBe("partial");
  });

  it("grades incomplete when the mode is picked but the plugin is missing", () => {
    expect(telemetryGradeFor("plugin", { installed: false, outdated: false }, false)).toBe("incomplete");
    // An outdated build predates telemetry.json — it never emits, so it
    // cannot even deliver the alive/sunk half (a sort-key map from a
    // stale stream is ignored by the same 30 s freshness gate).
    expect(telemetryGradeFor("plugin", { installed: true, outdated: true }, true)).toBe("incomplete");
  });

  it("grades infer when plugin detection is not the selected roster mode", () => {
    // Even a healthy install changes nothing while the pixel pipeline is
    // the selected source.
    expect(telemetryGradeFor("passive", { installed: true, outdated: false }, true)).toBe("infer");
    expect(telemetryGradeFor("passive", { installed: false, outdated: true }, false)).toBe("infer");
  });
});
