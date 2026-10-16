/**
 * Tests for the title-bar subtitle composition (App.tsx renders this
 * verbatim next to the WoWSP title). The subtitle has two parts: the
 * running version (`v<version>` from the Tauri app API) and, in debug
 * builds only, the git identity stamp (`branch:hash7`) that pins the
 * binary to its checkout — the same convention shittim-chest's status
 * bar carries.
 */
import { describe, expect, it } from "vitest";

import { titlebarSubtitle } from "./titlebarSubtitle";

describe("titlebarSubtitle", () => {
  it("renders the bare version when no debug stamp is present (release)", () => {
    expect(titlebarSubtitle("0.6.1", "")).toBe("v0.6.1");
  });

  it("appends the debug build stamp after the version", () => {
    expect(titlebarSubtitle("0.6.1", "master:05b69ad")).toBe("v0.6.1 master:05b69ad");
  });

  it("keeps branch slashes intact in the stamp", () => {
    expect(titlebarSubtitle("0.6.1", "feat/titlebar-build-identity:2cb4e90")).toBe(
      "v0.6.1 feat/titlebar-build-identity:2cb4e90",
    );
  });

  it("shows the stamp alone when the app version is unavailable", () => {
    expect(titlebarSubtitle("", "master:05b69ad")).toBe("master:05b69ad");
  });

  it("stays empty in browser dev mode (no version, no stamp)", () => {
    expect(titlebarSubtitle("", "")).toBe("");
  });
});
