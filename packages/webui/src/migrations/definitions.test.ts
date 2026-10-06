/** The 0.5.2 delegated body: a default-theme profile sitting on the old
 *  80% default moves to the raised 95%, silently; custom schemes and
 *  explicit dial choices are untouched. Version gating and the ledger are
 *  shell-side (commands/app_migrations.rs + its Rust tests) — here only
 *  the body's own semantics. Each case re-imports the graph so hikari's
 *  theme refs and the opacity ref re-hydrate from freshly seeded storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPACITY_KEY = "wowsp-ui-opacity";

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

async function runBody(): Promise<void> {
  const { WEBUI_MIGRATION_ACTIONS } = await import("./definitions");
  WEBUI_MIGRATION_ACTIONS.ui_opacity_95_on_default_theme?.();
}

describe("ui_opacity_95_on_default_theme", () => {
  it("moves a default-theme profile from the old 80% default to 95%", async () => {
    localStorage.setItem(OPACITY_KEY, "80");
    await runBody();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("95");
    expect(document.documentElement.style.getPropertyValue("--ui-opacity")).toBe("0.95");
  });

  it("leaves an unset dial alone — the raised default carries the profile", async () => {
    await runBody();
    expect(localStorage.getItem(OPACITY_KEY)).toBeNull();
  });

  it("keeps an explicit dial choice", async () => {
    localStorage.setItem(OPACITY_KEY, "60");
    await runBody();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("60");
  });

  it("skips profiles on a custom scheme", async () => {
    localStorage.setItem(
      "hikari-custom-themes",
      JSON.stringify([{ id: "my-scheme", name: "My scheme", dark: {}, light: {} }]),
    );
    localStorage.setItem("hikari-theme", "my-scheme");
    localStorage.setItem(OPACITY_KEY, "80");
    await runBody();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("80");
  });

  it("treats a retired preset id as the default scheme", async () => {
    localStorage.setItem("hikari-theme", "nord");
    localStorage.setItem(OPACITY_KEY, "80");
    await runBody();
    expect(localStorage.getItem(OPACITY_KEY)).toBe("95");
  });
});
