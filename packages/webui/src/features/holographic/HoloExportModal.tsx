/**
 * Replay-playback export modal (the playback bar's export button): one
 * hikari surface collecting the output settings — the FORMAT as a button
 * group, fps / speed / resolution on one row, the RANGE as hikari's
 * selection-waterfall clip cards on its own row, the EXPORT FOLDER picked
 * in-window (default: the OS Downloads folder, remembered by the shell),
 * the frame/duration estimate, and the frame-budget guard.
 *
 * The footer watermark is NOT a setting: every clip carries it, and the
 * band renders in the CURRENT UI language (shareFooterStrings already
 * reads the active locale), so the toggle is gone by design.
 *
 * Starting the export closes the modal; progress then rides the shell's
 * toast card (ToastCardBase) — frames first, then the encoder/muxer
 * flush, then the file write.
 */
import { computed, defineComponent, type PropType } from "vue";
import { HkButton, HkModal, HkPopupSelect, HSelectionWaterfall } from "@celestia-island/hikari";
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

/** "MM:SS" battle clock for the range cards. */
function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export default defineComponent({
  name: "HoloExportModal",
  props: {
    modelValue: { type: Boolean, required: true },
    /** The host's reactive settings object — mutated in place so values
     *  survive between passes (same contract as the tactical wizard). */
    settings: { type: Object as PropType<PlaybackExportSettings>, required: true },
    duration: { type: Number, required: true },
    current: { type: Number, required: true },
    /** The export folder (shell-persisted), or null on hosts without the
     *  native surface — the row then hides and the legacy save dialog
     *  handles the target. */
    exportDir: { type: String as PropType<string | null>, default: null },
    onStart: { type: Function as PropType<() => void>, required: true },
    onPickDir: { type: Function as PropType<() => void>, default: null },
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

    /** Range cards for hikari's selection waterfall: the full match vs
     *  the remaining one, each carrying its own length so the choice reads
     *  without opening anything. */
    const rangeItems = computed(() => {
      const remaining = Math.max(0, props.duration - props.current);
      return [
        {
          id: "start",
          title: i18nT("replay.export.rangeFull"),
          description: i18nT("replay.export.rangeFullDesc", {
            time: clockLabel(props.duration),
          }),
        },
        {
          id: "now",
          title: i18nT("replay.export.rangeNow"),
          description: i18nT("replay.export.rangeNowDesc", {
            time: clockLabel(remaining),
          }),
        },
      ];
    });

    const start = (): void => {
      if (frameCount.value < 2 || tooLong.value) return;
      // The footer watermark is mandatory on every clip.
      props.settings.footer = true;
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
          {/* Format as a button group — the two choices are peers, not a
              menu (the 2026-11-20 layout report). */}
          <div class="holo-export__row">
            <span class="holo-export__label">{i18nT("replay.export.format")}</span>
            <div class="holo-export__btn-group" role="group">
              {([
                { value: "video", label: i18nT("replay.export.formatVideo") },
                { value: "gif", label: i18nT("replay.export.formatGif") },
              ] as const).map((opt) => (
                <HkButton
                  key={opt.value}
                  size="sm"
                  variant={props.settings.format === opt.value ? "primary" : "ghost"}
                  aria-pressed={props.settings.format === opt.value}
                  onClick={() => setFormat(opt.value)}
                >
                  {opt.label}
                </HkButton>
              ))}
            </div>
          </div>
          {/* fps · speed · resolution on ONE row. */}
          <div class="holo-export__params">
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
          {/* Range: hikari's selection waterfall, one row of clip cards. */}
          <HSelectionWaterfall
            groupTitle={i18nT("replay.export.range")}
            items={rangeItems.value}
            selectedIds={[props.settings.from]}
            onSelect={(item) => {
              props.settings.from = item.id === "start" ? "start" : "now";
            }}
          />
          {/* Export folder: the default lives in the shell config, the
              picker is a native folder dialog, and the choice persists. */}
          {props.exportDir ? (
            <div class="holo-export__row holo-export__row--path">
              <span class="holo-export__label">{i18nT("replay.export.pathLabel")}</span>
              <code class="holo-export__path" data-hint={props.exportDir}>
                {props.exportDir}
              </code>
              {props.onPickDir ? (
                <HkButton size="sm" variant="secondary" onClick={() => props.onPickDir?.()}>
                  {i18nT("replay.export.pathChange")}
                </HkButton>
              ) : null}
            </div>
          ) : null}
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
