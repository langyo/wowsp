/** The shipped 0.5.2 migration: a default-theme profile sitting on the
 *  old 80% default moves to the raised 95% once, silently; custom schemes
 *  and explicit dial choices are untouched. Each case re-imports the
 *  graph so hikari's theme refs and the opacity ref re-hydrate from the
 *  freshly seeded storage (currentVersion is the baked-in package
 *  version, which stays >= the migration's 0.5.2). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPACITY_KEY = "wowsp-ui-opacity";
const LEDGER_KEY = "wowsp-migration-ui-opacity-95-on-default-theme";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  document.documentElement.style.cssText = "";
});

// Warm the transform cache for the (large, JSX-source) hikari graph before
// the timed tests: each case re-imports it after vi.resetModules(), which
// re-evaluates against seeded storage but must not pay the cold transform.
// Deliberately a top-level await, not a beforeAll hook — the cold transform
// exceeds vitest's 10s hook timeout (module evaluation has none).
await import("./definitions");

async function runOnce(): Promise<string[]> {
  const { runStartupMigrations } = await import("./definitions");
  return runStartupMigrations();
}

function upgradeFrom(previous: string): void {
  localStorage.setItem("wowsp-last-run-version", previous);
}

describe("ui-opacity-95-on-default-theme", () => {
  it("moves a default-theme profile from the old 80% default to 95%, once", async () => {
    upgradeFrom("0.5.1");
    localStorage.setItem(OPACITY_KEY, "80");
    expect(await runOnce()).toEqual(["ui-opacity-95-on-default-theme"]);
    expect(localStorage.getItem(OPACITY_KEY)).toBe("95");
    expect(document.documentElement.style.getPropertyValue("--ui-opacity")).toBe("0.95");
    expect(localStorage.getItem(LEDGER_KEY)).not.toBeNull();
    // Next boot: consumed by the ledger.
    expect(await runOnce()).toEqual([]);
    expect(localStorage.getItem(OPACITY_KEY)).toBe("95");
  });

  it("leaves an unset dial alone — the raised default carries the profile", async () => {
    upgradeFrom("0.5.1");
    await runOnce();
    expect(localStorage.getItem(OPACITY_KEY)).toBeNull();
    expect(localStorage.getItem(LEDGER_KEY)).not.toBeNull();
  });

  it("keeps an explicit dial choice", async () => {
    upgradeFrom("0.5.1");
    localStorage.setItem(OPACITY_KEY, "60");
    await runOnce();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("60");
  });

  it("skips profiles on a custom scheme (and still consumes the migration)", async () => {
    upgradeFrom("0.5.1");
    localStorage.setItem(
      "hikari-custom-themes",
      JSON.stringify([{ id: "my-scheme", name: "My scheme", dark: {}, light: {} }]),
    );
    localStorage.setItem("hikari-theme", "my-scheme");
    localStorage.setItem(OPACITY_KEY, "80");
    await runOnce();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("80");
    expect(localStorage.getItem(LEDGER_KEY)).not.toBeNull();
  });

  it("treats a retired preset id as the default scheme", async () => {
    upgradeFrom("0.5.1");
    localStorage.setItem("hikari-theme", "nord");
    localStorage.setItem(OPACITY_KEY, "80");
    await runOnce();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("95");
  });

  it("does nothing on a first-ever boot or a same-version reload", async () => {
    localStorage.setItem(OPACITY_KEY, "80");
    // No wowsp-last-run-version slot: first-ever boot, nothing to migrate.
    await runOnce();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("80");
    expect(localStorage.getItem(LEDGER_KEY)).toBeNull();
    // A webview reload into the same build: the upgrade crossed nothing.
    upgradeFrom("0.5.2");
    await runOnce();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("80");
    expect(localStorage.getItem(LEDGER_KEY)).toBeNull();
  });
});
