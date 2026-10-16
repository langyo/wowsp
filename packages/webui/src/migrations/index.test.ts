/** runStartupMigrations: the shell-driven pending/report cycle. The api
 *  client is mocked (no transport); the graph re-imports per case so the
 *  seeded theme/opacity state re-hydrates. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pendingMock = vi.fn<(previousHint: string | null) => Promise<string[]>>();
const completedMock = vi.fn<(id: string) => Promise<boolean>>();

vi.mock("@/api", () => ({
  api: {
    appMigrationsPending: (previousHint: string | null) => pendingMock(previousHint),
    appMigrationCompleted: (id: string) => completedMock(id),
  },
}));

const OPACITY_KEY = "wowsp-ui-opacity";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  document.documentElement.style.cssText = "";
  pendingMock.mockReset().mockResolvedValue([]);
  completedMock.mockReset().mockResolvedValue(true);
});

// Warm the transform cache for the hikari-heavy graph (see
// definitions.test.ts for why this is a top-level await, not a hook).
await import("./index");

async function runOnce(): Promise<string[]> {
  const { runStartupMigrations } = await import("./index");
  return runStartupMigrations();
}

describe("runStartupMigrations", () => {
  it("runs due bodies, reports each completion, and returns the ids", async () => {
    localStorage.setItem(OPACITY_KEY, "80");
    localStorage.setItem("wowsp-last-run-version", "0.5.1");
    pendingMock.mockResolvedValue(["ui_opacity_95_on_default_theme"]);

    expect(await runOnce()).toEqual(["ui_opacity_95_on_default_theme"]);
    expect(localStorage.getItem(OPACITY_KEY)).toBe("95");
    expect(completedMock).toHaveBeenCalledWith("ui_opacity_95_on_default_theme");
    expect(completedMock).toHaveBeenCalledTimes(1);
    // The webui's last-run slot rides along as the ledger seed hint.
    expect(pendingMock).toHaveBeenCalledWith("0.5.1");
  });

  it("skips unknown ids without reporting them (the shell retries)", async () => {
    pendingMock.mockResolvedValue(["not_yet_shipped", "ui_opacity_95_on_default_theme"]);

    expect(await runOnce()).toEqual(["ui_opacity_95_on_default_theme"]);
    expect(completedMock).toHaveBeenCalledTimes(1);
    expect(completedMock).not.toHaveBeenCalledWith("not_yet_shipped");
  });

  it("resolves to an empty run when the shell is unreachable", async () => {
    pendingMock.mockRejectedValue(new Error("off the desktop shell"));
    localStorage.setItem(OPACITY_KEY, "80");

    await expect(runOnce()).resolves.toEqual([]);
    expect(localStorage.getItem(OPACITY_KEY)).toBe("80");
    expect(completedMock).not.toHaveBeenCalled();
  });
});
