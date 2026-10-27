/** The delegated WebView bodies: the 0.5.2 opacity raise (a default-theme
 *  profile on the old 80% default moves to 95%, silently; custom schemes
 *  and explicit dial choices are untouched) and the 0.6.8 live-roster
 *  density flip (a profile on the old full-card default moves to compact
 *  rows, silently, preserving every other pref). Version gating and the
 *  ledger are shell-side (commands/app_migrations.rs + its Rust tests) —
 *  here only the bodies' own semantics. Each case re-imports the graph so
 *  hikari's theme refs, the opacity ref and the stats-prefs store
 *  re-hydrate from freshly seeded storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPACITY_KEY = "wowsp-ui-opacity";
const STATS_PREFS_KEY = "wowsp-stats-prefs";

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

/** Load the 0.6.8 body from a freshly imported definitions graph (the
 *  stats-prefs store hydrates from storage at import, before the body). */
async function loadCompactBody(): Promise<() => void> {
  const { WEBUI_MIGRATION_ACTIONS } = await import("./definitions");
  const body = WEBUI_MIGRATION_ACTIONS.live_roster_compact_default_on;
  if (!body) throw new Error("live_roster_compact_default_on body is missing");
  return body;
}

async function runCompactBody(): Promise<void> {
  (await loadCompactBody())();
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

describe("live_roster_compact_default_on", () => {
  it("flips a profile on the old full-card default to compact rows", async () => {
    localStorage.setItem(
      STATS_PREFS_KEY,
      JSON.stringify({ liveRosterCompact: false, prAlgo: "expected" }),
    );
    await runCompactBody();
    const stored = JSON.parse(localStorage.getItem(STATS_PREFS_KEY)!) as {
      liveRosterCompact: boolean;
      prAlgo: string;
    };
    expect(stored.liveRosterCompact).toBe(true);
    // Seed rewrites the whole normalized blob — every other pref survives.
    expect(stored.prAlgo).toBe("expected");
    // Seed, not the store setter: the title-bar Saved chip never flashes.
    const { settingsSavedFlash } = await import("@/stores/settingsSavedFlash");
    expect(settingsSavedFlash.value).toBe(false);
  });

  it("leaves a profile already on the new compact default alone", async () => {
    localStorage.setItem(
      STATS_PREFS_KEY,
      JSON.stringify({ liveRosterCompact: true, prAlgo: "expected" }),
    );
    await runCompactBody();
    const stored = JSON.parse(localStorage.getItem(STATS_PREFS_KEY)!) as {
      liveRosterCompact: boolean;
      prAlgo: string;
    };
    expect(stored.liveRosterCompact).toBe(true);
    expect(stored.prAlgo).toBe("expected");
  });

  it("leaves an unset profile alone — the raised default carries it", async () => {
    await runCompactBody();
    expect(localStorage.getItem(STATS_PREFS_KEY)).toBeNull();
  });

  it("neither throws nor rewrites a corrupt blob", async () => {
    localStorage.setItem(STATS_PREFS_KEY, "{not json");
    // Importing the graph hydrates statsPrefs, whose own boot contract
    // heal-writes the garbage first; the body must then leave the healed
    // blob alone instead of throwing or re-seeding a fresh one.
    const body = await loadCompactBody();
    const healed = localStorage.getItem(STATS_PREFS_KEY);
    expect(() => body()).not.toThrow();
    expect(localStorage.getItem(STATS_PREFS_KEY)).toBe(healed);
  });
});
