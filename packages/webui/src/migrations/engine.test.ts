/** Migration engine: version compare, upgrade-crossing eligibility with
 *  the origin floor, and the run-once ledger (record on success, retry on
 *  throw). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compareVersions, isMigrationDue, runMigrations } from "./engine";
import type { AppMigration, MigrationContext } from "./engine";

const ctx = (previousVersion: string | null, currentVersion: string): MigrationContext => ({
  previousVersion,
  currentVersion,
});

beforeEach(() => {
  localStorage.clear();
});

describe("compareVersions", () => {
  it("orders numeric segments, not strings", () => {
    expect(compareVersions("0.5.10", "0.5.2")).toBe(1);
    expect(compareVersions("0.5.2", "0.5.10")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });

  it("treats missing segments, a v prefix, and garbage as zero", () => {
    expect(compareVersions("0.5.2", "0.5.2")).toBe(0);
    expect(compareVersions("0.5", "0.5.0")).toBe(0);
    expect(compareVersions("v0.5.2", "0.5.2")).toBe(0);
    expect(compareVersions("dev", "0.0.1")).toBe(-1);
  });
});

describe("isMigrationDue", () => {
  const migration: AppMigration = { id: "probe", introducedIn: "0.5.2", run: () => {} };

  it("is due exactly when the upgrade crosses into introducedIn", () => {
    expect(isMigrationDue(migration, ctx("0.5.1", "0.5.2"))).toBe(true);
    expect(isMigrationDue(migration, ctx("0.5.1", "0.5.3"))).toBe(true);
    // Crossed into 0.5.2 on an earlier upgrade; not this run's crossing.
    expect(isMigrationDue(migration, ctx("0.5.2", "0.5.3"))).toBe(false);
    // The running build predates the migration.
    expect(isMigrationDue(migration, ctx("0.5.1", "0.5.1"))).toBe(false);
  });

  it("never runs on a first-ever boot", () => {
    expect(isMigrationDue(migration, ctx(null, "0.5.2"))).toBe(false);
  });

  it("honors minPreviousVersion as a floor on the upgrade origin", () => {
    const floored: AppMigration = { ...migration, minPreviousVersion: "0.5.0" };
    expect(isMigrationDue(floored, ctx("0.5.1", "0.5.2"))).toBe(true);
    expect(isMigrationDue(floored, ctx("0.4.9", "0.5.2"))).toBe(false);
  });
});

describe("runMigrations", () => {
  it("runs a due migration once and records the ledger flag", () => {
    const run = vi.fn();
    const migrations: AppMigration[] = [{ id: "probe", introducedIn: "0.5.2", run }];
    const first = runMigrations({
      migrations,
      previousVersion: "0.5.1",
      currentVersion: "0.5.2",
    });
    expect(first).toEqual(["probe"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("wowsp-migration-probe")).toBe("0.5.2");
    // Second boot: consumed by the ledger even though still eligible.
    const second = runMigrations({
      migrations,
      previousVersion: "0.5.1",
      currentVersion: "0.5.2",
    });
    expect(second).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips migrations the current build predates", () => {
    const run = vi.fn();
    const ran = runMigrations({
      migrations: [{ id: "future", introducedIn: "99.0.0", run }],
      previousVersion: "0.5.1",
      currentVersion: "0.5.2",
    });
    expect(ran).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(localStorage.getItem("wowsp-migration-future")).toBeNull();
  });

  it("retries a failed action next boot instead of recording it", () => {
    const run = vi.fn((): void => {
      throw new Error("boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const migrations: AppMigration[] = [{ id: "boom", introducedIn: "0.5.2", run }];
    expect(
      runMigrations({ migrations, previousVersion: "0.5.1", currentVersion: "0.5.2" }),
    ).toEqual([]);
    expect(localStorage.getItem("wowsp-migration-boom")).toBeNull();
    run.mockImplementation(() => {});
    expect(
      runMigrations({ migrations, previousVersion: "0.5.1", currentVersion: "0.5.2" }),
    ).toEqual(["boom"]);
    warn.mockRestore();
  });

  it("defaults previousVersion to the last-run slot", () => {
    localStorage.setItem("wowsp-last-run-version", "0.5.1");
    const run = vi.fn();
    const ran = runMigrations({
      migrations: [{ id: "peeked", introducedIn: "0.5.2", run }],
      currentVersion: "0.5.2",
    });
    expect(ran).toEqual(["peeked"]);
  });
});
