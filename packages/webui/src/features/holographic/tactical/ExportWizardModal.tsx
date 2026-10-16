/**
 * Export wizard (the toolbar's rightmost export button): a two-step
 * HkStepFlow — the same stepper the map setup and onboarding use. Step 1
 * collects the output settings (image format/scale, timestamp and corner-
 * minimap chips, video range/fps); step 2 lists the actual export runs
 * with one-line descriptions — full snapshot, region snapshot, realtime
 * recording, offline fast render, JSON out/in. Every run executes with the
 * settings from step 1 and closes the wizard (a started recording keeps
 * running — its chip lives on the canvas).
 */
import { computed, defineComponent, ref, watch, type PropType } from "vue";
import {
  HkMenuActionItem,
  HkMenuPanel,
  HkModal,
  HkPopupSelect,
  HkStepFlow,
  HkSwitch,
} from "@celestia-island/hikari";
import {
  Camera,
  Crop,
  Download,
  FastForward,
  Upload,
  Video,
} from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import type { TacticalToolbarActions } from "./TacticalToolbar";
import "./ExportWizardModal.scss";

/** The board actions the wizard's run step may trigger — the viewport
 *  camera actions stay toolbar-only. */
type ExportRunName =
  | "exportFull"
  | "exportRegion"
  | "recordToggle"
  | "offlineExport"
  | "exportJson"
  | "importJson";

interface ExportSettings {
  format: "png" | "webp";
  scale: 1 | 2;
  timestamp: boolean;
  minimap: boolean;
  offlineFps: 30 | 60;
  offlineFrom: "now" | "start";
}

export default defineComponent({
  name: "TacticalExportWizard",
  props: {
    modelValue: { type: Boolean, required: true },
    exportSettings: { type: Object as PropType<ExportSettings>, required: true },
    actions: { type: Object as PropType<TacticalToolbarActions>, required: true },
    busy: { type: Boolean, default: false },
    recording: { type: Boolean, default: false },
    recordingSupported: { type: Boolean, default: true },
    regionActive: { type: Boolean, default: false },
    pendingRegion: { type: Boolean, default: false },
    /** Board annotations alive right now (the wizard's count line). */
    elementCount: { type: Number, default: 0 },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    const step = ref<"output" | "run">("output");

    const steps = computed(() => [
      { key: "output", label: i18nT("replay.tactical.export.stepOutput") },
      { key: "run", label: i18nT("replay.tactical.export.stepRun") },
    ]);

    // A fresh pass starts on the settings step; the settings themselves are
    // the board's reactive object, so they survive between passes by design.
    watch(
      () => props.modelValue,
      (open) => {
        if (open) step.value = "output";
      },
    );

    /** Run one export and close — the board keeps executing (recordings
     *  continue under their canvas chip). Only the export runs are
     *  reachable; the camera actions stay toolbar-only. */
    function run(what: ExportRunName): void {
      props.actions[what]();
      emit("update:modelValue", false);
    }

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={i18nT("replay.tactical.export.wizardTitle")}
        width="min(46rem, 92vw)"
        footerActions={[
          step.value === "run"
            ? {
                label: i18nT("tactics.setup.back"),
                variant: "secondary",
                onClick: () => (step.value = "output"),
              }
            : {
                label: i18nT("tactics.setup.cancel"),
                variant: "secondary",
                onClick: () => emit("update:modelValue", false),
              },
          step.value === "output"
            ? {
                label: i18nT("tactics.setup.next"),
                variant: "primary",
                onClick: () => (step.value = "run"),
              }
            : {
                label: i18nT("tactics.lineup.apply"),
                variant: "primary",
                onClick: () => emit("update:modelValue", false),
              },
        ]}
      >
        <HkStepFlow
          steps={steps.value}
          modelValue={step.value}
          timelineClickable
          onUpdate:modelValue={(v: string) => {
            step.value = v as "output" | "run";
          }}
          v-slots={{
            output: () => (
              <div class="tac-exportwiz">
                <div class="tac-exportwiz__section">
                  {i18nT("replay.tactical.export.imageTitle")}
                </div>
                <div class="tac-exportwiz__grid">
                  <HkPopupSelect
                    label={i18nT("replay.tactical.export.format")}
                    modelValue={props.exportSettings.format}
                    options={[
                      { value: "png", label: "PNG" },
                      { value: "webp", label: "WebP" },
                    ]}
                    onUpdate:modelValue={(v: string) => {
                      props.exportSettings.format = v === "webp" ? "webp" : "png";
                    }}
                  />
                  <HkPopupSelect
                    label={i18nT("replay.tactical.export.scale")}
                    modelValue={String(props.exportSettings.scale)}
                    options={[
                      { value: "1", label: "1×" },
                      { value: "2", label: "2×" },
                    ]}
                    onUpdate:modelValue={(v: string) => {
                      props.exportSettings.scale = v === "2" ? 2 : 1;
                    }}
                  />
                </div>
                <div class="tac-exportwiz__toggles">
                  <HkSwitch
                    size="sm"
                    modelValue={props.exportSettings.timestamp}
                    onUpdate:modelValue={(v: boolean) => {
                      props.exportSettings.timestamp = v;
                    }}
                  >
                    {i18nT("replay.tactical.export.timestamp")}
                  </HkSwitch>
                  <HkSwitch
                    size="sm"
                    modelValue={props.exportSettings.minimap}
                    onUpdate:modelValue={(v: boolean) => {
                      props.exportSettings.minimap = v;
                    }}
                  >
                    {i18nT("replay.tactical.export.minimap")}
                  </HkSwitch>
                </div>
                <div class="tac-exportwiz__section">
                  {i18nT("replay.tactical.export.videoTitle")}
                </div>
                <div class="tac-exportwiz__grid">
                  <HkPopupSelect
                    label={i18nT("replay.tactical.export.range")}
                    modelValue={props.exportSettings.offlineFrom}
                    options={[
                      { value: "now", label: i18nT("replay.tactical.export.rangeNow") },
                      { value: "start", label: i18nT("replay.tactical.export.rangeFull") },
                    ]}
                    onUpdate:modelValue={(v: string) => {
                      props.exportSettings.offlineFrom = v === "start" ? "start" : "now";
                    }}
                  />
                  <HkPopupSelect
                    label={i18nT("replay.tactical.export.fps")}
                    modelValue={String(props.exportSettings.offlineFps)}
                    options={[
                      { value: "30", label: "30" },
                      { value: "60", label: "60" },
                    ]}
                    onUpdate:modelValue={(v: string) => {
                      props.exportSettings.offlineFps = v === "60" ? 60 : 30;
                    }}
                  />
                </div>
              </div>
            ),
            run: () => (
              <div class="tac-exportwiz">
                <HkMenuPanel label={i18nT("replay.tactical.export.wizardTitle")}>
                  <HkMenuActionItem
                    icon={<Camera size={15} />}
                    label={i18nT("replay.tactical.export.full")}
                    disabled={props.busy}
                    onClick={() => run("exportFull")}
                  >
                    {{ suffix: () => <span class="tac-exportwiz__desc">{i18nT("replay.tactical.export.fullDesc")}</span> }}
                  </HkMenuActionItem>
                  <HkMenuActionItem
                    icon={<Crop size={15} />}
                    label={
                      props.pendingRegion
                        ? i18nT("replay.tactical.export.regionRun")
                        : i18nT("replay.tactical.export.region")
                    }
                    disabled={props.busy}
                    class={props.regionActive || props.pendingRegion ? "is-active" : ""}
                    onClick={() => run("exportRegion")}
                  >
                    {{ suffix: () => <span class="tac-exportwiz__desc">{i18nT("replay.tactical.export.regionDesc")}</span> }}
                  </HkMenuActionItem>
                  <HkMenuActionItem
                    icon={<Video size={15} />}
                    label={
                      props.recording
                        ? i18nT("replay.tactical.record.stop")
                        : i18nT("replay.tactical.record.start")
                    }
                    disabled={props.busy || (!props.recording && !props.recordingSupported)}
                    class={props.recording ? "is-active" : ""}
                    onClick={() => run("recordToggle")}
                  >
                    {{ suffix: () => <span class="tac-exportwiz__desc">{i18nT("replay.tactical.export.recordDesc")}</span> }}
                  </HkMenuActionItem>
                  <HkMenuActionItem
                    icon={<FastForward size={15} />}
                    label={i18nT("replay.tactical.export.offline")}
                    disabled={props.busy || props.recording}
                    onClick={() => run("offlineExport")}
                  >
                    {{ suffix: () => <span class="tac-exportwiz__desc">{i18nT("replay.tactical.export.offlineDesc")}</span> }}
                  </HkMenuActionItem>
                </HkMenuPanel>
                <div class="tac-exportwiz__section">
                  {i18nT("replay.tactical.export.jsonTitle")}
                </div>
                <HkMenuPanel label={i18nT("replay.tactical.export.jsonTitle")}>
                  <HkMenuActionItem
                    icon={<Download size={15} />}
                    label={i18nT("replay.tactical.action.exportJson")}
                    disabled={props.busy}
                    onClick={() => run("exportJson")}
                  >
                    {{ suffix: () => <span class="tac-exportwiz__desc">{i18nT("replay.tactical.export.jsonDesc")}</span> }}
                  </HkMenuActionItem>
                  <HkMenuActionItem
                    icon={<Upload size={15} />}
                    label={i18nT("replay.tactical.action.importJson")}
                    disabled={props.busy}
                    onClick={() => run("importJson")}
                  >
                    {{ suffix: () => <span class="tac-exportwiz__desc">{i18nT("replay.tactical.export.jsonImportDesc")}</span> }}
                  </HkMenuActionItem>
                </HkMenuPanel>
                <p class="tac-exportwiz__count">
                  {i18nT("replay.tactical.count", { n: props.elementCount })}
                </p>
              </div>
            ),
          }}
        />
      </HkModal>
    );
  },
});
