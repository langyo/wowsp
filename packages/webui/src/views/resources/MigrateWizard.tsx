/** Stale-bin migration wizard modal — plain render functions taking the
 *  view context (they render INSIDE ResourcesView's own tree, so the
 *  modal vnodes stay children of the view component). */
import { Ban, ChevronDown, Undo2 } from "@lucide/vue";
import {
  HkButton,
  HkCheckbox,
  HkIconButton,
  HkModal,
  HkSpinner,
  HkTabs,
} from "@celestia-island/hikari";

import type { PlanFile } from "@/api";
import {
  keptPending,
  masterChecked,
} from "@/features/modhub/migrationDecide";
import { t } from "@/i18n";
import { migKb } from "./display";
import type { ResourcesCtx } from "./context";

/** One auto-cleaned group (duplicates / superseded): collapsed to a
 *  count + one-line explanation, expandable to the raw file list. */
function renderMigGroup(ctx: ResourcesCtx, kind: "duplicate" | "superseded", files: PlanFile[]) {
  const open = ctx.migGroupOpen.value === kind;
  return (
    <div class="mig-wizard__group" key={kind}>
      <button
        type="button"
        class="mig-wizard__group-head"
        disabled={files.length === 0}
        onClick={() => (ctx.migGroupOpen.value = open ? null : kind)}
      >
        <ChevronDown size={14} class={["mig-wizard__chevron", { open }]} />
        <strong>{t(`resources.migrateGroup.${kind}`)}</strong>
        <span class="mig-wizard__count">{files.length}</span>
      </button>
      <p class="mig-wizard__hint">{t(`resources.migrateGroup.${kind}Hint`)}</p>
      {open && files.length > 0 && (
        <ul class="mig-wizard__files">
          {files.map((f) => (
            <li key={f.path} title={f.path}>
              {f.path}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A decide row: checkbox (= keep), the resolved identity name when the
 *  path maps to a catalog entry / known Aslain directory, the raw path,
 *  the size, and the ignore action ("leave alone" in the stale bin).
 *  The row is a div — the checkable part is its own label so the ignore
 *  button never toggles the checkbox. */
const renderMigRow = (ctx: ResourcesCtx, f: PlanFile) => {
  const identity = ctx.migIdentity(f);
  return (
    <div key={f.path} class="mig-wizard__row" title={f.path}>
      <label class="mig-wizard__row-body">
        <HkCheckbox
          modelValue={ctx.migDecide.value.keep.has(f.path)}
          onUpdate:modelValue={(v: boolean) => ctx.toggleMigKeep(f.path, v)}
        />
        <span class="mig-wizard__row-main">
          <span class="mig-wizard__row-name">{identity ?? f.path}</span>
          {identity && <span class="mig-wizard__row-path">{f.path}</span>}
        </span>
      </label>
      <span class="mig-wizard__row-size">{migKb(f.size)}</span>
      <HkIconButton
        size={24}
        variant="ghost"
        data-hint={t("resources.migrateIgnore")}
        onClick={() => ctx.ignoreMigPath(f.path)}
      >
        <Ban size={14} />
      </HkIconButton>
    </div>
  );
};

/** An ignored row: no checkbox (the verdict is made), the identity/path
 *  pair in a dimmer dress, and the way back (restore to kept). */
const renderMigIgnoredRow = (ctx: ResourcesCtx, f: PlanFile) => {
  const identity = ctx.migIdentity(f);
  return (
    <div key={f.path} class="mig-wizard__row mig-wizard__row--ignored" title={f.path}>
      <span class="mig-wizard__row-body">
        <span class="mig-wizard__row-main">
          <span class="mig-wizard__row-name">{identity ?? f.path}</span>
          {identity && <span class="mig-wizard__row-path">{f.path}</span>}
        </span>
      </span>
      <span class="mig-wizard__row-size">{migKb(f.size)}</span>
      <HkIconButton
        size={24}
        variant="ghost"
        data-hint={t("resources.migrateUnignore")}
        onClick={() => ctx.restoreMigPath(f.path)}
      >
        <Undo2 size={14} />
      </HkIconButton>
    </div>
  );
};

export function renderMigrateWizard(ctx: ResourcesCtx) {
  const plan = ctx.migPlan.value;
  const step = ctx.migStep.value;
  const busy = step === "executing";
  const title = t("resources.staleMigrate");
  const footers = (() => {
    if (step === "done") {
      return [
        {
          label: t("common.close"),
          variant: "primary" as const,
          onClick: ctx.closeMigrate,
        },
      ];
    }
    if (busy) return [];
    const cancel = {
      label: t("resources.migrateCancel"),
      variant: "secondary" as const,
      onClick: ctx.closeMigrate,
    };
    if (step === "review" && plan) {
      return [
        cancel,
        {
          label: t("resources.migrateStart"),
          variant: "primary" as const,
          // A bin holding ONLY the probe still has work to do — the
          // probe reinstall is not a plan row (the backend carries it
          // outside the buckets).
          disabled:
            plan.duplicate.length + plan.superseded.length + plan.decide.length === 0 &&
            !ctx.migProbe.value,
          onClick: () => void ctx.startMigrate(),
        },
      ];
    }
    if (step === "confirm") {
      return [
        cancel,
        {
          label: t("resources.migrateScanStart"),
          variant: "primary" as const,
          onClick: () => void ctx.loadMigPlan(),
        },
      ];
    }
    if (step === "plan" && ctx.migError.value) {
      return [
        cancel,
        {
          label: t("common.retry"),
          variant: "primary" as const,
          onClick: () => void ctx.loadMigPlan(),
        },
      ];
    }
    return [cancel];
  })();

  return (
    <HkModal
      modelValue={ctx.migrateWizardOpen.value}
      onUpdate:modelValue={(v: boolean) => {
        // Opening is driven by the entry points; an in-flight execute
        // must not be dismissable mid-sweep.
        if (v || busy) return;
        ctx.closeMigrate();
      }}
      title={title}
      width="34rem"
      footerActions={footers}
    >
      <div class="mig-wizard">
        {step === "confirm" && (
          <>
            {ctx.staleBins.value.length > 1 && (
              <HkTabs
                block
                variant="segmented"
                modelValue={ctx.migFrom.value}
                onUpdate:modelValue={(v: string) => ctx.pickMigFrom(v)}
                tabs={ctx.staleBins.value.map((b) => ({
                  key: b.binVersion,
                  label: `bin/${b.binVersion} (${b.fileCount})`,
                }))}
                renderPanels={false}
              />
            )}
            <p class="mig-wizard__status">{t("resources.migrateScanIntro", { from: ctx.migFrom.value, count: ctx.staleBins.value.find((b) => b.binVersion === ctx.migFrom.value)?.fileCount ?? 0 })}</p>
            {ctx.migProbe.value ? (
              <p class="mig-wizard__status mig-wizard__status--muted">
                {t("resources.migrateProbeNote")}
              </p>
            ) : null}
            <p class="mig-wizard__status mig-wizard__status--muted">
              {t("resources.migrateScanNote")}
            </p>
          </>
        )}
        {step === "plan" &&
          (ctx.migError.value ? (
            <div class="resources-banner resources-banner--error">{ctx.migError.value}</div>
          ) : (
            <p class="mig-wizard__status">
              <HkSpinner size="sm" tone="current" />
              {t("resources.migrateAnalyzing", { from: ctx.migFrom.value })}
            </p>
          ))}

        {step === "review" && plan && (
          <>
            {ctx.staleBins.value.length > 1 && (
              <HkTabs
                block
                variant="segmented"
                modelValue={ctx.migFrom.value}
                onUpdate:modelValue={(v: string) => ctx.pickMigFrom(v)}
                tabs={ctx.staleBins.value.map((b) => ({
                  key: b.binVersion,
                  label: `bin/${b.binVersion}`,
                }))}
                renderPanels={false}
              />
            )}
            {ctx.migError.value && (
              <div class="resources-banner resources-banner--error">{ctx.migError.value}</div>
            )}
            {plan.duplicate.length +
              plan.superseded.length +
              plan.decide.length ===
            0 ? (
              ctx.migProbe.value ? (
                // Nothing but the probe in this bin: the run still
                // cleans the stranded copy and reinstalls it fresh.
                <p class="mig-wizard__status mig-wizard__status--muted">
                  {t("resources.migrateProbeNote")}
                </p>
              ) : (
                <p class="mig-wizard__empty">{t("resources.migrateEmpty")}</p>
              )
            ) : (
              <>
                {renderMigGroup(ctx, "duplicate", plan.duplicate)}
                {renderMigGroup(ctx, "superseded", plan.superseded)}
                <div class="mig-wizard__group">
                  <div class="mig-wizard__group-head mig-wizard__group-head--static">
                    <HkCheckbox
                      modelValue={
                        masterChecked(
                          ctx.decidePaths(),
                          ctx.migDecide.value.keep,
                          ctx.migDecide.value.ignore,
                        ) as boolean
                      }
                      disabled={ctx.decideAllIgnored.value}
                      data-hint={t("resources.migrateToggleAll")}
                      onUpdate:modelValue={(v: boolean) => ctx.toggleMigKeepAll(v)}
                    />
                    <strong>{t("resources.migrateGroup.decide")}</strong>
                    <span class="mig-wizard__count">
                      {(() => {
                        const { kept, pending } = keptPending(
                          ctx.decidePaths(),
                          ctx.migDecide.value.keep,
                          ctx.migDecide.value.ignore,
                        );
                        return t("resources.migrateKeptCount", {
                          kept,
                          total: pending,
                        });
                      })()}
                    </span>
                    <HkButton
                      variant="ghost"
                      size="sm"
                      disabled={ctx.decideAllIgnored.value}
                      onClick={ctx.ignoreMigAll}
                    >
                      {t("resources.migrateIgnoreAll")}
                    </HkButton>
                  </div>
                  <p class="mig-wizard__hint">{t("resources.migrateGroup.decideHint")}</p>
                  {(() => {
                    const ignore = ctx.migDecide.value.ignore;
                    const rows = plan.decide.filter((f) => !ignore.has(f.path));
                    return rows.length > 0 ? (
                      <div class="mig-wizard__rows">
                        {rows.map((f) => renderMigRow(ctx, f))}
                      </div>
                    ) : null;
                  })()}
                </div>
                {ctx.migDecide.value.ignore.size > 0 && (
                  <div class="mig-wizard__group">
                    <button
                      type="button"
                      class="mig-wizard__group-head"
                      onClick={() =>
                        (ctx.migGroupOpen.value =
                          ctx.migGroupOpen.value === "ignored" ? null : "ignored")
                      }
                    >
                      <ChevronDown
                        size={14}
                        class={[
                          "mig-wizard__chevron",
                          { open: ctx.migGroupOpen.value === "ignored" },
                        ]}
                      />
                      <strong>{t("resources.migrateGroup.ignored")}</strong>
                      <span class="mig-wizard__count">{ctx.migDecide.value.ignore.size}</span>
                    </button>
                    <p class="mig-wizard__hint">
                      {t("resources.migrateGroup.ignoredHint")}
                    </p>
                    <div class="mig-wizard__group-foot">
                      <HkButton variant="ghost" size="sm" onClick={ctx.restoreMigAll}>
                        {t("resources.migrateUnignoreAll")}
                      </HkButton>
                    </div>
                    {ctx.migGroupOpen.value === "ignored" && (
                      <div class="mig-wizard__rows">
                        {plan.decide
                          .filter((f) => ctx.migDecide.value.ignore.has(f.path))
                          .map((f) => renderMigIgnoredRow(ctx, f))}
                      </div>
                    )}
                  </div>
                )}
                <p class="mig-wizard__hint mig-wizard__hint--foot">
                  {t("resources.migrateCleanupNote")}
                </p>
              </>
            )}
          </>
        )}

        {step === "executing" && (
          <p class="mig-wizard__status">
            <HkSpinner size="sm" tone="current" />
            {t("resources.migrateExecuting", {
              from: ctx.migFrom.value,
              to: plan?.toVersion ?? "",
            })}
          </p>
        )}

        {step === "done" && ctx.migReport.value && (
          <>
            <div class="resources-banner resources-banner--ok">
              {t("resources.migrateDone", {
                moved: ctx.migReport.value.movedFiles,
                to: ctx.migReport.value.toVersion,
                skipped: ctx.migReport.value.skippedFiles,
              })}
            </div>
            {(ctx.migReport.value.ignoredFiles ?? 0) > 0 && (
              <p class="mig-wizard__status mig-wizard__status--muted">
                {t("resources.migrateDoneIgnored", {
                  ignored: ctx.migReport.value.ignoredFiles,
                  from: ctx.migReport.value.fromVersion,
                })}
              </p>
            )}
            {ctx.migReport.value.probeReinstalled && (
              <p class="mig-wizard__status mig-wizard__status--muted">
                {t("resources.migrateProbeDone", {
                  version: ctx.migReport.value.toVersion,
                })}
              </p>
            )}
          </>
        )}
      </div>
    </HkModal>
  );
}
