/**
 * Replay-playback export modal (the playback bar's export button): one
 * hikari surface collecting the output settings — format (video / GIF),
 * range (from now / full match), speed (battle-time compression), fps,
 * size, and the footer toggle — plus a frame/duration estimate before
 * the offline render starts. Starting the export closes the modal;
 * progress then rides the map's chip (the render owns the playhead until
 * it finishes). Takes beyond the format's frame budget are refused with
 * the warning line (raise speed or narrow the range).
 *
 * Mirrors the tactical board's ExportWizardModal grammar (HkModal +
 * HkPopupSelect + HkSwitch) so the two export surfaces read as one family.
 */
import { computed, defineComponent, type PropType } from "vue";
import { HkModal, HkPopupSelect, HkSwitch } from "@celestia-island/hikari";
import "./HoloExportModal.scss";

import { t as i18nT } from "@/i18n";
import {
  PLAYBACK_EXPORT_FPS,
  PLAYBACK_EXPORT_SIZES,
  PLAYBACK_EXPORT_SPEEDS,
  exportFrameBudget,
  frameTimesAtSpeed,
  gifDelayMs,
  type PlaybackExportSettings,
} from "./playbackExport";

export default defineComponent({
  name: "HoloExportModal",
  props: {
    modelValue: { type: Boolean, required: true },
    /** The host's reactive settings object — mutated in place so values
     *  survive between passes (same contract as the tactical wizard). */
    settings: { type: Object as PropType<PlaybackExportSettings>, required: true },
    duration: { type: Number, required: true },
    current: { type: Number, required: true },
    onStart: { type: Function as PropType<() => void>, required: true },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    /** Frames the current settings would render — the estimate line and
     *  the guard against a degenerate empty range. */
    const frameCount = computed(() =>
      frameTimesAtSpeed(
        props.settings.from === "start" ? 0 : props.current,
        props.duration,
        props.settings.fps,
        props.settings.speed,
      ).length,
    );
    const seconds = computed(() => {
      if (frameCount.value === 0) return 0;
      // Video paces at its fps; GIF at the centisecond-snapped delay.
      const per = props.settings.format === "gif"
        ? gifDelayMs(props.settings.fps) / 1000
        : 1 / props.settings.fps;
      return Math.round(frameCount.value * per);
    });
    /** The take exceeds the format's in-memory frame budget — starting
     *  is refused until speed rises or the range narrows. */
    const budget = computed(() => exportFrameBudget(props.settings.format));
    const tooLong = computed(() => frameCount.value > budget.value);

    const setFormat = (v: string): void => {
      props.settings.format = v === "gif" ? "gif" : "video";
      // Keep fps/size on the new format's ladder.
      if (!PLAYBACK_EXPORT_FPS[props.settings.format].includes(props.settings.fps)) {
        props.settings.fps = PLAYBACK_EXPORT_FPS[props.settings.format][0];
      }
      if (!PLAYBACK_EXPORT_SIZES[props.settings.format].includes(props.settings.size)) {
        props.settings.size = PLAYBACK_EXPORT_SIZES[props.settings.format][0];
      }
    };

    const start = (): void => {
      if (frameCount.value < 2 || tooLong.value) return;
      props.onStart();
      emit("update:modelValue", false);
    };

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={i18nT("replay.export.title")}
        width="min(34rem, 92vw)"
        footerActions={[
          {
            label: i18nT("replay.export.cancel"),
            variant: "secondary",
            onClick: () => emit("update:modelValue", false),
          },
          {
            label: i18nT("replay.export.start"),
            variant: "primary",
            disabled: frameCount.value < 2 || tooLong.value,
            onClick: start,
          },
        ]}
      >
        <div class="holo-export">
          <div class="holo-export__grid">
            <HkPopupSelect
              label={i18nT("replay.export.format")}
              modelValue={props.settings.format}
              options={[
                { value: "video", label: i18nT("replay.export.formatVideo") },
                { value: "gif", label: i18nT("replay.export.formatGif") },
              ]}
              onUpdate:modelValue={setFormat}
            />
            <HkPopupSelect
              label={i18nT("replay.export.range")}
              modelValue={props.settings.from}
              options={[
                { value: "now", label: i18nT("replay.export.rangeNow") },
                { value: "start", label: i18nT("replay.export.rangeFull") },
              ]}
              onUpdate:modelValue={(v: string) => {
                props.settings.from = v === "start" ? "start" : "now";
              }}
            />
            <HkPopupSelect
              label={i18nT("replay.export.fps")}
              modelValue={String(props.settings.fps)}
              options={PLAYBACK_EXPORT_FPS[props.settings.format].map((f) => ({
                value: String(f),
                label: String(f),
              }))}
              onUpdate:modelValue={(v: string) => {
                const f = Number(v);
                if (PLAYBACK_EXPORT_FPS[props.settings.format].includes(f)) {
                  props.settings.fps = f;
                }
              }}
            />
            <HkPopupSelect
              label={i18nT("replay.export.speed")}
              modelValue={String(props.settings.speed)}
              options={PLAYBACK_EXPORT_SPEEDS.map((sp) => ({
                value: String(sp),
                label: `${sp}×`,
              }))}
              onUpdate:modelValue={(v: string) => {
                const sp = Number(v);
                if ((PLAYBACK_EXPORT_SPEEDS as readonly number[]).includes(sp)) {
                  props.settings.speed = sp;
                }
              }}
            />
            <HkPopupSelect
              label={i18nT("replay.export.resolution")}
              modelValue={String(props.settings.size)}
              options={PLAYBACK_EXPORT_SIZES[props.settings.format].map((s) => ({
                value: String(s),
                label: props.settings.format === "gif" ? `${s} px` : `${s}p`,
              }))}
              onUpdate:modelValue={(v: string) => {
                const s = Number(v);
                if (PLAYBACK_EXPORT_SIZES[props.settings.format].includes(s)) {
                  props.settings.size = s;
                }
              }}
            />
          </div>
          <div class="holo-export__toggles">
            <HkSwitch
              size="sm"
              modelValue={props.settings.footer}
              onUpdate:modelValue={(v: boolean) => {
                props.settings.footer = v;
              }}
            >
              {i18nT("replay.export.footer")}
            </HkSwitch>
          </div>
          <p class="holo-export__estimate">
            {i18nT("replay.export.estimate", { n: frameCount.value, s: seconds.value })}
          </p>
          {tooLong.value ? (
            <p class="holo-export__warn">{i18nT("replay.export.tooLong", { n: budget.value })}</p>
          ) : null}
        </div>
      </HkModal>
    );
  },
});
