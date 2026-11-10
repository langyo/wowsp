/** Custom import wizard (自定义导入安装) — the HkStepFlow stepper behind the
 *  Mod Hub's custom-import entry. A plain render function over the view
 *  context (like the migration wizard), so its step bodies render inside
 *  ResourcesView's own tree.
 *
 *  Step cards are keyed slots on HkStepFlow: "kind" (what to build, an
 *  HkSelectionGrid with one requirement line each), "source" (the picked
 *  path through HkFilePickerField plus the backend probe's verdict) and
 *  "run" (the staging/install pass with its progress bar and result). */
import { Film, Music, Package, Palette } from "@lucide/vue";
import {
  HkAlert,
  HkButton,
  HkFilePickerField,
  HkInput,
  HkModal,
  HkProgressBar,
  HkSelectionGrid,
  HkSpinner,
  HkStepFlow,
  type ModalAction,
} from "@celestia-island/hikari";

import type { CustomImportKind, CustomImportProblem } from "@/api";
import ErrorCard from "@/components/base/ErrorCard";
import { t } from "@/i18n";
import {
  IMPORT_KINDS,
  formatBytes,
  pathExtension,
  problemKey,
  stageKey,
} from "./importKinds";
import "./ImportWizard.scss";
import type { ResourcesCtx } from "./context";

const KIND_ICONS = {
  video: Film,
  voice: Music,
  texture: Palette,
  misc: Package,
} as const;

/** The problem sentence for one probe problem (detail interpolated when the
 *  message carries it). */
function problemMessage(problem: CustomImportProblem): string {
  return t(problemKey(problem.code), { detail: problem.detail ?? "" });
}

/** Step 1 — which compliant asset to build. */
function renderKindStep(ctx: ResourcesCtx) {
  return (
    <div class="import-wizard__step">
      <p class="import-wizard__lead">{t("resources.importWizard.kindLead")}</p>
      <HkSelectionGrid
        layout="list"
        items={IMPORT_KINDS.map((kind) => ({
          id: kind.id,
          title: t(`resources.importWizard.kind.${kind.id}.title`),
          description: t(`resources.importWizard.kind.${kind.id}.desc`),
          icon: KIND_ICONS[kind.id],
        }))}
        selectedId={ctx.importKind.value ?? undefined}
        onSelect={(item: { id: string }) =>
          ctx.chooseImportKind(item.id as CustomImportKind)
        }
      />
      <p class="import-wizard__note">{t("resources.importWizard.kindNote")}</p>
      {/* A whole plugin package (PnFMods, scripts, …) is not one of the four
          custom kinds — the plain folder install stays one click away. */}
      <HkButton
        variant="ghost"
        size="sm"
        class="import-wizard__link"
        onClick={() => {
          ctx.closeImportWizard();
          ctx.openLocal();
        }}
      >
        {t("resources.importWizard.completePackage")}
      </HkButton>
    </div>
  );
}

/** Step 2 — pick the source and show what the backend found. */
function renderSourceStep(ctx: ResourcesCtx) {
  const option = ctx.importOption.value;
  const probe = ctx.importProbe.value;
  const wantsFile = option?.wantsFile ?? false;
  const transcodes =
    option?.id === "video" &&
    ctx.importSourcePath.value.trim() !== "" &&
    pathExtension(ctx.importSourcePath.value) !== "webm";
  return (
    <div class="import-wizard__step">
      <HkFilePickerField
        modelValue={ctx.importSourcePath.value}
        backend="hook"
        directory={!wantsFile}
        pick={ctx.pickImportSource}
        label={t(
          wantsFile
            ? "resources.importWizard.pickFile"
            : "resources.importWizard.pickFolder",
        )}
        hint={t(
          wantsFile
            ? "resources.importWizard.sourceHintVideo"
            : "resources.importWizard.sourceHintFolder",
        )}
        disabled={ctx.importRunning.value}
        onUpdate:modelValue={(value: string) => {
          void ctx.acceptImportSource(value);
        }}
      />

      {ctx.importProbing.value && (
        <p class="import-wizard__busy">
          <HkSpinner size="xs" tone="current" />
          {t("resources.importWizard.probing")}
        </p>
      )}

      {ctx.importProbeError.value && (
        <ErrorCard
          error={ctx.importProbeError.value}
          description={t("resources.importWizard.probeFailed")}
        />
      )}

      {probe && (
        <div class="import-wizard__summary">
          <dl class="import-wizard__facts">
            <div class="import-wizard__fact">
              <dt>{t("resources.importWizard.fileName")}</dt>
              <dd>{probe.fileName}</dd>
            </div>
            <div class="import-wizard__fact">
              <dt>{t("resources.importWizard.size")}</dt>
              <dd>{formatBytes(probe.sizeBytes)}</dd>
            </div>
          </dl>
          {probe.structure.length > 0 && (
            <div class="import-wizard__structure">
              <span class="import-wizard__structure-title">
                {t("resources.importWizard.structure")}
              </span>
              <ul class="import-wizard__structure-list">
                {probe.structure.map((entry) => (
                  <li key={entry}>
                    <code>{entry}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {probe?.problems.map((problem) => (
        <HkAlert
          key={problem.code}
          variant="warning"
          message={problemMessage(problem)}
        />
      ))}

      {transcodes && probe && probe.problems.length === 0 && (
        <HkAlert variant="info" message={t("resources.importWizard.transcodeNote")} />
      )}

      {!ctx.importProbe.value && !ctx.importProbing.value && !ctx.importProbeError.value && (
        <p class="import-wizard__note">
          {t("resources.importWizard.noSource")}
        </p>
      )}

      <HkInput
        modelValue={ctx.importDisplayName.value}
        label={t("resources.importWizard.displayName")}
        hint={t("resources.importWizard.displayNameHint")}
        size="sm"
        disabled={ctx.importRunning.value}
        onUpdate:modelValue={(value: string) => ctx.setImportDisplayName(value)}
      />
    </div>
  );
}

/** Step 3 — the staging/install pass, its progress and its verdict. */
function renderRunStep(ctx: ResourcesCtx) {
  const runState = ctx.importRunState.value;
  const report = ctx.importReport.value;
  const progress = ctx.importProgress.value;
  if (runState === "running") {
    return (
      <div class="import-wizard__step">
        <p class="import-wizard__busy">
          <HkSpinner size="xs" tone="current" />
          {t(stageKey(progress?.stage ?? "preparing"))}
        </p>
        <HkProgressBar value={ctx.importPercent.value} size="sm" showLabel />
        <p class="import-wizard__note">{t("resources.importWizard.runningNote")}</p>
      </div>
    );
  }
  if (runState === "failed") {
    return (
      <div class="import-wizard__step">
        <ErrorCard
          error={ctx.importError.value}
          title={t("resources.importWizard.failedTitle")}
          retry={() => void ctx.retryImport()}
        />
      </div>
    );
  }
  if (runState === "done" && report) {
    const layer = report.layerId ? ctx.layerStack.layerById(report.layerId) : null;
    return (
      <div class="import-wizard__step">
        <div class="import-wizard__done">
          <span class="import-wizard__done-title">
            {report.layerId
              ? t("resources.importWizard.registered", { name: report.name })
              : t("resources.importWizard.installed", { name: report.name })}
          </span>
          <span class="import-wizard__done-meta">
            {t("resources.importWizard.reportMeta", {
              files: report.wroteFiles,
              version: report.binVersion,
            })}
          </span>
        </div>
        {layer && (
          <p class="import-wizard__note">
            {t("resources.importWizard.registeredHint")}
          </p>
        )}
        {report.warnings.length > 0 && (
          <ul class="import-wizard__warnings">
            {report.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div class="import-wizard__step">
      <p class="import-wizard__note">{t("resources.importWizard.runIntro")}</p>
    </div>
  );
}

/** The footer buttons per step / run state. */
function footerActions(ctx: ResourcesCtx): ModalAction[] {
  if (ctx.importRunning.value) return [];
  const step = ctx.importStep.value;
  const runState = ctx.importRunState.value;
  if (step === "run") {
    if (runState === "done") {
      return [
        {
          label: t("resources.importWizard.finish"),
          variant: "primary",
          onClick: () => ctx.closeImportWizard(),
        },
      ];
    }
    if (runState === "failed") {
      return [
        {
          label: t("resources.importWizard.back"),
          variant: "secondary",
          onClick: () => ctx.backImportStep(),
        },
        {
          label: t("common.retry"),
          variant: "primary",
          onClick: () => void ctx.retryImport(),
        },
      ];
    }
    return [];
  }
  const next: ModalAction = {
    label: t("resources.importWizard.next"),
    variant: "primary",
    disabled: !ctx.importCanAdvance.value,
    onClick: () => void ctx.nextImportStep(),
  };
  if (step === "source") {
    return [
      {
        label: t("resources.importWizard.back"),
        variant: "secondary",
        onClick: () => ctx.backImportStep(),
      },
      next,
    ];
  }
  return [
    {
      label: t("resources.importWizard.cancel"),
      variant: "secondary",
      onClick: () => ctx.closeImportWizard(),
    },
    next,
  ];
}

export function renderImportWizard(ctx: ResourcesCtx) {
  const steps = [
    { key: "kind", label: t("resources.importWizard.stepKind") },
    { key: "source", label: t("resources.importWizard.stepSource") },
    { key: "run", label: t("resources.importWizard.stepRun") },
  ];
  return (
    <HkModal
      modelValue={ctx.importWizardOpen.value}
      onUpdate:modelValue={(open: boolean) => {
        // Opening is driven by the entry button; a run in flight is not
        // dismissable (the backend is writing res_mods).
        if (open) return;
        ctx.closeImportWizard();
      }}
      title={t("resources.importWizard.title")}
      width="36rem"
      footerActions={footerActions(ctx)}
    >
      <HkStepFlow
        steps={steps}
        modelValue={ctx.importStep.value}
        timelineClickable
        onUpdate:modelValue={(value: string) =>
          ctx.goToImportStep(value as "kind" | "source" | "run")
        }
        v-slots={{
          kind: () => renderKindStep(ctx),
          source: () => renderSourceStep(ctx),
          run: () => renderRunStep(ctx),
        }}
      />
    </HkModal>
  );
}
