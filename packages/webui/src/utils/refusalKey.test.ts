/**
 * Tests for the narrow mod-hub guard-sentence mapping. The helper backs the
 * key-or-raw error contract: only the two known backend guard sentences may
 * become localized message keys, every other error must stay verbatim.
 */
import { describe, expect, it } from "vitest";

import { guardRefusalKey } from "./refusalKey";

describe("guardRefusalKey", () => {
  it("maps the safe-mode guard sentence", () => {
    expect(
      guardRefusalKey(
        "safe mode is active — turn mods back on before installing, uninstalling or toggling them",
      ),
    ).toBe("resources.safeModeBlock");
  });

  it("maps the running-client guard sentence", () => {
    expect(
      guardRefusalKey(
        "World of Warships is running from D:/Korabli (pid 7) — close that client before installing",
      ),
    ).toBe("resources.gameRunningBlock");
  });

  it("matches a capitalized variant of either sentence", () => {
    expect(guardRefusalKey("Safe mode is active — nothing to do")).toBe(
      "resources.safeModeBlock",
    );
    expect(guardRefusalKey("The game client is running from E:/Games")).toBe(
      "resources.gameRunningBlock",
    );
  });

  it("keeps the mapping narrow: unrelated errors stay raw (null)", () => {
    expect(guardRefusalKey("res_mods is locked by the game")).toBeNull();
    expect(guardRefusalKey("failed to rename res_mods")).toBeNull();
    expect(guardRefusalKey("safe mode is already active")).toBeNull();
    expect(guardRefusalKey("")).toBeNull();
  });
});
