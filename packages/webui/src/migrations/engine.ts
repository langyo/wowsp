/**
 * One-time app migrations — version-conditioned actions that run once per
 * profile on the MAIN shell's boot (main.ts calls runStartupMigrations
 * before bootstrap(); the overlay and tray windows never migrate).
 *
 * Eligibility is "the upgrade crossed into the migration's version":
 * previous < introducedIn <= current, where `previous` is the version the
 * LAST run booted into (`wowsp-last-run-version`, still untouched at this
 * point of the boot — the update toast records the current run later, on
 * mount). A first-ever boot (no previous version) never migrates: a fresh
 * profile starts on current defaults. `minPreviousVersion` narrows an
 * upgrade's ORIGIN for repairs that only make sense coming from a known
 * era.
 *
 * The ledger is one localStorage key per migration — `wowsp-migration-<id>`
 * = the version that ran it — the same run-once flag family as
 * `wowsp-onboarding-completed`. An action that throws is NOT recorded and
 * the next boot retries it, so actions must stay idempotent (worst case a
 * retry rewrites a slot with the same value). A recorded migration never
 * runs again, even across a downgrade/re-upgrade dance.
 */
import { peekLastRunVersion } from "@/utils/lastRunVersion";

/** Context handed to every migration action. */
export interface MigrationContext {
  /** Version the previous run booted into (null on a first-ever boot). */
  previousVersion: string | null;
  /** Version the current run booted into. */
  currentVersion: string;
}

export interface AppMigration {
  /** Stable unique id — becomes the ledger key `wowsp-migration-<id>`.
   *  Never rename a shipped id: the old flag orphans and the action
   *  re-runs. */
  id: string;
  /** The version that introduced this migration; eligible when the
   *  upgrade crossed into it (previous < introducedIn <= current). */
  introducedIn: string;
  /** Optional floor on the upgrade's origin: a profile coming from
   *  anything older than this skips the migration entirely. */
  minPreviousVersion?: string;
  run: (ctx: MigrationContext) => void;
}

const LEDGER_PREFIX = "wowsp-migration-";

function hasRun(id: string): boolean {
  try {
    return localStorage.getItem(LEDGER_PREFIX + id) != null;
  } catch {
    // Storage unavailable — nothing an action writes would persist either,
    // so treat the ledger as consumed instead of re-running every boot.
    return true;
  }
}

function recordRun(id: string, version: string): void {
  try {
    localStorage.setItem(LEDGER_PREFIX + id, version);
  } catch {
    // Unrecordable: the next boot may retry; actions are idempotent.
  }
}

/** Numeric segment compare ("0.5.10" > "0.5.2"; "0.5" == "0.5.0"; an
 *  unparsable segment such as "dev" or "-beta" reads as 0 — the app ships
 *  plain x.y.z, so suffixes never decide an ordering in practice). */
export function compareVersions(a: string, b: string): number {
  const segments = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((seg) => {
        const n = Number.parseInt(seg, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const sa = segments(a);
  const sb = segments(b);
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    const diff = (sa[i] ?? 0) - (sb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isMigrationDue(migration: AppMigration, ctx: MigrationContext): boolean {
  if (ctx.previousVersion === null) return false;
  if (compareVersions(ctx.currentVersion, migration.introducedIn) < 0) return false;
  if (compareVersions(ctx.previousVersion, migration.introducedIn) >= 0) return false;
  if (
    migration.minPreviousVersion !== undefined &&
    compareVersions(ctx.previousVersion, migration.minPreviousVersion) < 0
  ) {
    return false;
  }
  return true;
}

export interface RunMigrationsOptions {
  /** Overrides the baked-in __APP_VERSION__ (tests). */
  currentVersion?: string;
  /** Overrides the `wowsp-last-run-version` peek (tests). */
  previousVersion?: string | null;
  migrations: AppMigration[];
}

/** Runs every due migration in list order; returns the ids executed this
 *  call. Never throws — a failing action is skipped and retried next boot. */
export function runMigrations(options: RunMigrationsOptions): string[] {
  let previous: string | null;
  try {
    previous =
      options.previousVersion !== undefined ? options.previousVersion : peekLastRunVersion();
  } catch {
    previous = null;
  }
  const ctx: MigrationContext = {
    previousVersion: previous,
    currentVersion: options.currentVersion ?? __APP_VERSION__,
  };
  const ran: string[] = [];
  for (const migration of options.migrations) {
    if (hasRun(migration.id)) continue;
    if (!isMigrationDue(migration, ctx)) continue;
    try {
      migration.run(ctx);
    } catch (error) {
      console.warn(`[migrations] "${migration.id}" failed; retrying next boot`, error);
      continue;
    }
    recordRun(migration.id, ctx.currentVersion);
    ran.push(migration.id);
  }
  return ran;
}
