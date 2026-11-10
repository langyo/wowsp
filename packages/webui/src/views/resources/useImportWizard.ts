/** Custom import wizard state (自定义导入安装): pick a kind → pick the
 *  source (with its probe verdict) → stage/install and register the layer.
 *
 *  Takes the useModHub context (game root, guards, scans, the layer stack)
 *  as input, mirroring useMigrateWizard. The three steps map 1:1 onto
 *  HkStepFlow's keyed slots (see ImportWizard.tsx):
 *
 *    "kind"   — which compliant asset to build (HkSelectionGrid);
 *    "source" — the picked path + the backend probe's verdict;
 *    "run"    — the import itself (progress event → result/error).
 *
 *  Everything structural (size, layouts, ffmpeg availability) comes from the
 *  Rust probe: the webview cannot stat a path, so the state machine never
 *  guesses. The cheap path-string checks live in importKinds.ts.
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { useToast } from "@celestia-island/hikari";

import {
  api,
  type CustomImportKind,
  type CustomImportProbe,
  type CustomImportProgress,
  type CustomImportReport,
} from "@/api";
import { requestModOpDisclaimer } from "@/features/modhub/ModOpDisclaimer";
import { t } from "@/i18n";
import {
  defaultDisplayName,
  kindOption,
  leafName,
  probeBlocks,
  progressPercent,
  validatePickedPath,
} from "./importKinds";
import type { ModHubCtx } from "./useModHub";

export type ImportWizardStep = "kind" | "source" | "run";

/** The run step's sub-state (idle = not started yet). */
export type ImportRunState = "idle" | "running" | "done" | "failed";

export function useImportWizard(hub: ModHubCtx) {
  const toast = useToast();

  const open = ref(false);
  const step = ref<ImportWizardStep>("kind");
  const kind = ref<CustomImportKind | null>(null);
  const sourcePath = ref("");
  const displayName = ref("");
  const probe = ref<CustomImportProbe | null>(null);
  const probing = ref(false);
  const probeError = ref("");
  const picking = ref(false);
  const runState = ref<ImportRunState>("idle");
  const progress = ref<CustomImportProgress | null>(null);
  const report = ref<CustomImportReport | null>(null);
  const error = ref("");

  /** Guards every async landing: closing the wizard (or a root switch)
   *  bumps this, so a late probe/import never writes into a dead wizard. */
  let generation = 0;
  /** Probe sequence: only the newest probe may publish its verdict. */
  let probeSeq = 0;
  /** Detach handle of the progress event subscription. */
  let unlisten: (() => void) | null = null;
  /** Debounce of the display-name re-probe (voice only — its bank folder is
   *  named after the display name). */
  let nameTimer: ReturnType<typeof setTimeout> | null = null;

  const option = computed(() => kindOption(kind.value));
  const canAdvance = computed(() => {
    if (step.value === "kind") return kind.value !== null;
    if (step.value === "source") {
      return (
        !probing.value &&
        probe.value !== null &&
        !probeBlocks(probe.value.problems)
      );
    }
    return false;
  });
  /** The reason "next" is disabled, when it is (localized by the view). */
  const blockCode = computed<string | null>(() => {
    if (step.value === "source") {
      if (probing.value) return null;
      if (!sourcePath.value.trim()) return "missingPath";
      const local = validatePickedPath(kind.value, sourcePath.value);
      if (local) return local.code;
      return probe.value?.problems[0]?.code ?? null;
    }
    return null;
  });
  const running = computed(() => runState.value === "running");
  const percent = computed(() => progressPercent(progress.value?.percent ?? 0));

  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function clearNameTimer() {
    if (nameTimer !== null) {
      clearTimeout(nameTimer);
      nameTimer = null;
    }
  }

  function detachProgress() {
    unlisten?.();
    unlisten = null;
  }

  function reset() {
    generation++;
    probeSeq++;
    clearNameTimer();
    detachProgress();
    step.value = "kind";
    kind.value = null;
    sourcePath.value = "";
    displayName.value = "";
    probe.value = null;
    probing.value = false;
    probeError.value = "";
    picking.value = false;
    runState.value = "idle";
    progress.value = null;
    report.value = null;
    error.value = "";
  }

  /** Entry point: the sidebar's 自定义导入安装 button. Same guards as every
   *  res_mods mutation (the backend re-checks; this is the localized copy). */
  function openWizard() {
    if (!hub.gameRoot.value || open.value) return;
    if (hub.gameRunning() || hub.safeModeBlocked()) return;
    reset();
    open.value = true;
  }

  function close() {
    // A run in flight is not dismissable mid-write.
    if (runState.value === "running") return;
    generation++;
    probeSeq++;
    clearNameTimer();
    detachProgress();
    open.value = false;
  }

  function chooseKind(next: CustomImportKind) {
    if (running.value) return;
    kind.value = next;
  }

  /** Step navigation (footer buttons; the timeline is not clickable). */
  async function next() {
    if (!canAdvance.value) return;
    if (step.value === "kind") {
      step.value = "source";
      return;
    }
    if (step.value === "source") {
      step.value = "run";
      await startImport();
    }
  }

  /** Timeline click navigation: only the determined steps are reachable
   *  (a run starts from "next", never by clicking into it). */
  function goToStep(next: ImportWizardStep) {
    if (running.value || next === step.value) return;
    if (next === "run") return;
    if (next === "kind") {
      step.value = "kind";
      return;
    }
    if (step.value === "run") {
      runState.value = "idle";
      progress.value = null;
      error.value = "";
    }
    step.value = "source";
  }

  function back() {
    if (running.value) return;
    if (step.value === "source") {
      step.value = "kind";
      return;
    }
    if (step.value === "run") {
      runState.value = "idle";
      progress.value = null;
      error.value = "";
      step.value = "source";
    }
  }

  /** Step 2's native pick: the single-file dialog for video, the folder
   *  dialog for every other kind (both mint the source grant the commands
   *  require). Returns the path WITHOUT touching the wizard — HkFilePickerField's
   *  hook backend consumes the return value and emits it back through
   *  [`acceptImportSource`], so a pick and a typed path take ONE code path. */
  async function pickImportSource(): Promise<string | null> {
    const current = kind.value;
    if (!current || picking.value || running.value) return null;
    const wantsFile = kindOption(current)?.wantsFile ?? false;
    picking.value = true;
    probeError.value = "";
    try {
      return wantsFile
        ? await api.modHubPickCustomFile()
        : await api.modHubPickSource();
    } catch (e) {
      probeError.value = messageOf(e);
      return null;
    } finally {
      picking.value = false;
    }
  }

  /** The field's emitted path (picked or typed): prefill the display name
   *  and run the backend probe. A typed path reaches the same grant check
   *  every other source does, so the probe reports the truth. */
  async function acceptImportSource(path: string) {
    const current = kind.value;
    if (!current) return;
    sourcePath.value = path;
    displayName.value = defaultDisplayName(current, path);
    await probeSource();
  }

  /** Ask the backend what the picked path is. Returns whether it may be
   *  imported (the cheap checks short-circuit without an IPC). */
  async function probeSource(): Promise<boolean> {
    const current = kind.value;
    const path = sourcePath.value.trim();
    if (!current || !path) {
      probe.value = null;
      return false;
    }
    const local = validatePickedPath(current, path);
    if (local) {
      // A path the string itself proves wrong: answer locally, no IPC.
      probe.value = {
        path,
        fileName: leafName(path),
        isFile: kindOption(current)?.wantsFile ?? false,
        sizeBytes: 0,
        structure: [],
        problems: [local],
      };
      return false;
    }
    const seq = ++probeSeq;
    probing.value = true;
    probeError.value = "";
    try {
      const verdict = await api.modHubProbeCustomImport(
        current,
        path,
        displayName.value.trim() || null,
      );
      if (seq !== probeSeq) return false;
      probe.value = verdict;
      return !probeBlocks(verdict.problems);
    } catch (e) {
      if (seq !== probeSeq) return false;
      probe.value = null;
      probeError.value = messageOf(e);
      return false;
    } finally {
      if (seq === probeSeq) probing.value = false;
    }
  }

  /** Display-name input. The voice kind's bank folder is named after this
   *  value, so that kind re-probes (debounced) to keep the shown shape
   *  honest; the other kinds' structure never depends on the name. */
  function setDisplayName(value: string) {
    displayName.value = value;
    if (kind.value !== "voice") return;
    clearNameTimer();
    nameTimer = setTimeout(() => {
      nameTimer = null;
      void probeSource();
    }, 250);
  }

  async function attachProgress(gen: number) {
    detachProgress();
    try {
      const off = await api.listenCustomImportProgress((tick) => {
        if (gen !== generation) return;
        progress.value = {
          stage: tick.stage,
          percent: progressPercent(tick.percent),
        };
      });
      if (!off) return;
      if (gen !== generation) {
        off();
        return;
      }
      unlisten = off;
    } catch {
      // Progress is advisory: a transport without events still imports.
    }
  }

  /** Step 3: stage + install. On success the fresh layer is selected (the
   *  "完成" button then just closes) and every mod surface reloads. */
  async function startImport() {
    const current = kind.value;
    const path = sourcePath.value.trim();
    const root = hub.gameRoot.value;
    if (!current || !path || !root || running.value) return;
    if (hub.gameRunning() || hub.safeModeBlocked()) {
      step.value = "source";
      return;
    }
    if (!(await requestModOpDisclaimer())) {
      step.value = "source";
      return;
    }
    const gen = ++generation;
    runState.value = "running";
    error.value = "";
    report.value = null;
    progress.value = { stage: "preparing", percent: 0 };
    await attachProgress(gen);
    try {
      const result = await api.modHubImportCustom(
        root,
        current,
        path,
        displayName.value.trim() || null,
      );
      if (gen !== generation) return;
      report.value = result;
      runState.value = "done";
      progress.value = { stage: "done", percent: 100 };
      toast.success(
        t("resources.importWizard.doneToast", { name: result.name }),
      );
      // A custom import is a ledger install + a layer: reload the same
      // surfaces confirmInstall does.
      await Promise.all([
        hub.scan(),
        hub.loadRecords(),
        hub.pluginUpdates.syncFreshness(),
        hub.layerStack.refresh(),
      ]);
      if (gen !== generation) return;
      if (result.layerId) {
        const layer = hub.layerStack.layerById(result.layerId);
        if (layer) hub.selectLayer(layer);
      }
    } catch (e) {
      if (gen !== generation) return;
      error.value = messageOf(e);
      runState.value = "failed";
    } finally {
      if (gen === generation) detachProgress();
    }
  }

  /** The failed run step's retry: re-enter the same step and re-run. */
  async function retry() {
    if (runState.value !== "failed") return;
    await startImport();
  }

  /** Root switch: the wizard's source/verdict belong to a game install's
   *  layer stack, so a new root closes it (the view's gameRoot watch). */
  function beginRootChange() {
    generation++;
    probeSeq++;
    clearNameTimer();
    detachProgress();
    open.value = false;
    reset();
  }

  onBeforeUnmount(() => {
    generation++;
    probeSeq++;
    clearNameTimer();
    detachProgress();
  });

  return {
    // state
    importWizardOpen: open,
    importStep: step,
    importKind: kind,
    importOption: option,
    importSourcePath: sourcePath,
    importDisplayName: displayName,
    importProbe: probe,
    importProbing: probing,
    importProbeError: probeError,
    importPicking: picking,
    importRunState: runState,
    importProgress: progress,
    importPercent: percent,
    importReport: report,
    importError: error,
    // derived
    importCanAdvance: canAdvance,
    importBlockCode: blockCode,
    importRunning: running,
    // actions
    openImportWizard: openWizard,
    closeImportWizard: close,
    chooseImportKind: chooseKind,
    pickImportSource,
    acceptImportSource,
    probeImportSource: probeSource,
    setImportDisplayName: setDisplayName,
    nextImportStep: next,
    backImportStep: back,
    goToImportStep: goToStep,
    startImport,
    retryImport: retry,
    beginImportRootChange: beginRootChange,
  };
}

export type ImportWizardCtx = ReturnType<typeof useImportWizard>;
