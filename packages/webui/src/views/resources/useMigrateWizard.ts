/** Stale-bin migration wizard state (plan → review → executing → done):
 *  the source-bin picker, the decide-bucket selections and the execute
 *  step. Takes the useModHub context (game root, scans, toasts) as input;
 *  the view binds its `openMigrateWizard` back into the hub so a scan
 *  can consume the armed ?migrate=1 deep link. */
import { computed, onBeforeUnmount, ref } from "vue";
import { useToast } from "@celestia-island/hikari";

import type { MigrationPlan, MigrateReport, PlanFile } from "@/api";
import { api } from "@/api";
import { resolveIdentity } from "@/features/modhub/migrateIdentity";
import {
  ignoreAll,
  ignoreFile,
  restoreAll,
  restoreFile,
  selectAll,
  type DecideSelection,
} from "@/features/modhub/migrationDecide";
import { requestModOpDisclaimer } from "@/features/modhub/ModOpDisclaimer";
import { t } from "@/i18n";
import { localized } from "./display";
import type { ModHubCtx } from "./useModHub";

export function useMigrateWizard(hub: ModHubCtx) {
  const toast = useToast();

  // `migrating` means "the wizard's execute step is in flight"; the ⋯ menu
  // entry and the stale banner button both disable on it.
  const migrating = ref(false);

  // ── Migration wizard state (plan → review → executing → done) ──
  const migrateWizardOpen = ref(false);
  const migFrom = ref("");
  const migStep = ref<"confirm" | "plan" | "review" | "executing" | "done">(
    "confirm",
  );
  const migPlan = ref<MigrationPlan | null>(null);
  const migError = ref("");
  /** Decide-bucket verdicts: `keep` moves the file into the current bin,
   *  `ignore` leaves it untouched in the stale one, neither deletes it.
   *  The sets are disjoint (ignore wins); default is keep-all. */
  const migDecide = ref<DecideSelection>({ keep: new Set(), ignore: new Set() });
  const migReport = ref<MigrateReport | null>(null);
  // Whether the selected source bin carries the in-game probe plugin —
  // the migration then reinstalls it (embedded bytes) into the current
  // bin instead of leaving it stranded with the leftover files.
  const migProbe = computed(
    () => hub.staleBins.value.find((b) => b.binVersion === migFrom.value)?.probeInstalled ?? false,
  );
  // Which auto-cleaned / reviewed group is expanded (duplicates /
  // superseded / ignored).
  const migGroupOpen = ref<"duplicate" | "superseded" | "ignored" | null>(null);

  // Root-scoped generation counters: bumped by the view's gameRoot watch
  // and on unmount so a delayed plan/execute never lands in another
  // root's wizard (see useModHub's scanGeneration for the scan twin).
  let rootGeneration = 0;
  let migrationPlanGeneration = 0;
  onBeforeUnmount(() => {
    rootGeneration++;
    migrationPlanGeneration++;
  });

  /** Display name for a plan row: catalog/alias identity when the path
   *  maps to one, else null (the row then shows the raw path only). */
  const migIdentity = (f: PlanFile): string | null =>
    resolveIdentity(f.path, hub.catalog.value, (e) => localized(e).name || e.nameEn || e.title);

  /** Decide-bucket paths in plan order — the input every selection
   *  helper (master checkbox, ignore-all) sweeps over. */
  const decidePaths = (): string[] => migPlan.value?.decide.map((f) => f.path) ?? [];

  /** Nothing left to decide — every decide file is ignored (or the list
   *  is empty): the master checkbox and ignore-all both stand down. */
  const decideAllIgnored = computed(
    () => !decidePaths().some((p) => !migDecide.value.ignore.has(p)),
  );

  async function loadMigPlan() {
    if (!hub.gameRoot.value || !migFrom.value) return;
    const generation = ++migrationPlanGeneration;
    migStep.value = "plan";
    migError.value = "";
    migPlan.value = null;
    migReport.value = null;
    migGroupOpen.value = null;
    try {
      const p = await api.modHubMigrationPlan(hub.gameRoot.value, migFrom.value);
      if (generation !== migrationPlanGeneration) return;
      migPlan.value = p;
      migDecide.value = { keep: new Set(p.decide.map((f) => f.path)), ignore: new Set() };
      migStep.value = "review";
    } catch (e) {
      if (generation !== migrationPlanGeneration) return;
      migError.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** Entry points: the ⋯ menu item and the stale banner button. Re-checks
   *  the same guards the mutations run (localized messages included) and
   *  defaults to the freshest stale bin. Landing on the confirm step is
   *  deliberate: planning hashes every stranded file, a heavy disk sweep
   *  the owner asked to gate behind an explicit start click. */
  function openMigrateWizard() {
    if (
      !hub.gameRoot.value ||
      hub.staleBins.value.length === 0 ||
      migrating.value ||
      migrateWizardOpen.value
    ) {
      return;
    }
    if (hub.gameRunning() || hub.safeModeBlocked()) return;
    if (!migFrom.value || !hub.staleBins.value.some((b) => b.binVersion === migFrom.value)) {
      migFrom.value = hub.staleBins.value[0]?.binVersion ?? "";
    }
    migrateWizardOpen.value = true;
    migStep.value = "confirm";
    migError.value = "";
  }

  /** Switch the wizard's source bin (only shown with >1 stale bins) —
   *  back to confirm; the plan is rebuilt only on an explicit start. */
  function pickMigFrom(v: string) {
    if (v === migFrom.value || migrating.value) return;
    migrationPlanGeneration++;
    migFrom.value = v;
    migStep.value = "confirm";
    migPlan.value = null;
  }

  /** Row checkbox: flips one file between keep (migrate) and drop
   *  (delete). The ignore verdict has its own actions below. */
  function toggleMigKeep(path: string, keep: boolean) {
    const next = new Set(migDecide.value.keep);
    if (keep) next.add(path);
    else next.delete(path);
    migDecide.value = { ...migDecide.value, keep: next };
  }

  /** Master checkbox over the decide list: one click selects (or clears)
   *  every still-pending file; ignored files are never touched. */
  function toggleMigKeepAll(keepAll: boolean) {
    migDecide.value = selectAll(migDecide.value, decidePaths(), keepAll);
  }

  function ignoreMigPath(path: string) {
    migDecide.value = ignoreFile(migDecide.value, path);
  }

  function restoreMigPath(path: string) {
    migDecide.value = restoreFile(migDecide.value, path);
  }

  function ignoreMigAll() {
    migDecide.value = ignoreAll(migDecide.value, decidePaths());
  }

  function restoreMigAll() {
    migDecide.value = restoreAll(migDecide.value);
  }

  function closeMigrate() {
    migrationPlanGeneration++;
    migrateWizardOpen.value = false;
    migStep.value = "confirm";
    migPlan.value = null;
    migError.value = "";
    migDecide.value = { keep: new Set(), ignore: new Set() };
    migReport.value = null;
    migGroupOpen.value = null;
  }

  async function startMigrate() {
    if (!hub.gameRoot.value || !migPlan.value || migrating.value) return;
    if (hub.gameRunning() || hub.safeModeBlocked()) return;
    if (!(await requestModOpDisclaimer())) return;
    const generation = rootGeneration;
    migrating.value = true;
    migStep.value = "executing";
    migError.value = "";
    try {
      const r = await api.modHubMigrationExecute(
        hub.gameRoot.value,
        migFrom.value,
        [...migDecide.value.keep],
        [...migDecide.value.ignore],
      );
      if (generation !== rootGeneration) return;
      migReport.value = r;
      migStep.value = "done";
      // Probe carry-over verdict — the bin info is captured before the
      // re-scan wipes the stale list.
      const binHadProbe = hub.staleBins.value.some(
        (b) => b.binVersion === r.fromVersion && b.probeInstalled,
      );
      if (r.probeReinstalled) {
        toast.success(t("resources.migrateProbeDone", { version: r.toVersion }));
      } else if (binHadProbe) {
        toast.warning(t("resources.migrateProbeFailed"));
      }
      // The carry-over may have reinstalled the probe plugin and the
      // move rewrote the ledger — refresh BOTH freshness signals (the
      // shared sync covers the sidebar badge and the live probe card),
      // not just this page's scans.
      await Promise.all([hub.scan(), hub.loadRecords(), hub.pluginUpdates.syncFreshness()]);
    } catch (e) {
      if (generation !== rootGeneration) return;
      migError.value = e instanceof Error ? e.message : String(e);
      // Back to review so the plan stays visible instead of dead-ending
      // the wizard on a failed execute.
      migStep.value = "review";
    } finally {
      migrating.value = false;
    }
  }

  /** Root-switch invalidation, called by the view's sync gameRoot watch
   *  after useModHub's own resets: bumps both generation counters and
   *  closes the wizard (same closeMigrate the cancel path takes). */
  function beginRootChange() {
    rootGeneration++;
    closeMigrate();
  }

  return {
    migrating,
    migrateWizardOpen,
    migFrom,
    migStep,
    migPlan,
    migError,
    migDecide,
    migReport,
    migProbe,
    migGroupOpen,
    migIdentity,
    decidePaths,
    decideAllIgnored,
    loadMigPlan,
    openMigrateWizard,
    pickMigFrom,
    toggleMigKeep,
    toggleMigKeepAll,
    ignoreMigPath,
    restoreMigPath,
    ignoreMigAll,
    restoreMigAll,
    closeMigrate,
    startMigrate,
    beginRootChange,
  };
}

export type MigrateWizardCtx = ReturnType<typeof useMigrateWizard>;
