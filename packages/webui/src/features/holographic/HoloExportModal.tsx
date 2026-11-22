/**
 * Replay-playback export modal (the playback bar's export button) — the
 * single surface the take is configured on:
 *
 *   · FORMAT   hikari HkPillToggleGroup (视频（MP4）/ 视频（WebM）/ GIF /
 *              WebP) — a standard toggle group, not a menu: the two video
 *              pills are the CONTAINER choice (MP4 = H.264 compatibility,
 *              WebM = VP9 compression), the last two the image formats;
 *   · PARAMS   fps / speed / resolution on ONE row (three ladders);
 *   · RANGE    hikari HkRangeRibbon — the sequence-ribbon waterfall with a
 *              draggable window over the battle timeline. The window IS
 *              the exported span (numbers, not presets); GIF takes
 *              auto-shrink to the 1500-frame budget so the selection can
 *              never ask for more than the format can carry;
 *   · FOLDER   hikari HkFilePickerField (the shun-style path field): the
 *              remembered export directory, native picker on browse,
 *              persisted by the shell (export-config.toml).
 *
 * The footer watermark is not a setting — every clip carries it, in the
 * active UI language. Starting closes the modal; the toast card then
 * reports frames → encoder/mux flush → file write.
 */
import { computed, defineComponent, type PropType } from "vue";
import {
  HkFilePickerField,
  HkModal,
  HkPillToggleGroup,
  HkPopupSelect,
  HkRangeRibbon,
  HkSwitch,
} from "@celestia-island/hikari";
import "./HoloExportModal.scss";

import { api as rpcApi } from "@/api";
import { t as i18nT } from "@/i18n";
import {
  PLAYBACK_EXPORT_DEFAULT_FPS,
  PLAYBACK_EXPORT_DEFAULT_SIZE,
  PLAYBACK_EXPORT_FPS,
  PLAYBACK_EXPORT_SIZES,
  PLAYBACK_EXPORT_SPEEDS,
  exportFrameBudget,
  exportMaxSpan,
  frameTimesAtSpeed,
  gifDelayMs,
  isImageFormat,
  normalizeExportRange,
  webpDelayMs,
  type PlaybackExportFormat,
  type PlaybackExportSettings,
} from "./playbackExport";

/** "MM:SS" battle clock. */
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
    /** The host's reactive settings — mutated in place so values survive
     *  between passes (same contract as the tactical wizard). */
    settings: { type: Object as PropType<PlaybackExportSettings>, required: true },
    duration: { type: Number, required: true },
    current: { type: Number, required: true },
    /** The shell-persisted export folder (null on hosts without the native
     *  surface — the row then hides and the save dialog handles the target). */
    exportDir: { type: String as PropType<string | null>, default: null },
    onStart: { type: Function as PropType<() => void>, required: true },
    onDirChange: { type: Function as PropType<(dir: string) => void>, default: null },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    /** The window actually rendered: normalized against the replay, with
     *  the GIF budget shortening the end (the ribbon shows the shrink). */
    const range = computed(() =>
      normalizeExportRange(
        props.settings.from,
        props.settings.to,
        props.duration,
        props.settings.format,
        props.settings.fps,
        props.settings.speed,
      ),
    );
    const frameCount = computed(
      () =>
        frameTimesAtSpeed(range.value.from, range.value.to, props.settings.fps, props.settings.speed)
          .length,
    );
    /** Is the take an IMAGE format (GIF / WebP)? They share the ladder,
     *  the frame budget, the auto-shrinking range and the progress card's
     *  live size estimate; only the container differs. */
    const imageFormat = computed(() => isImageFormat(props.settings.format));
    const seconds = computed(() => {
      if (frameCount.value === 0) return 0;
      // Each format's real per-frame duration: GIF snaps to centiseconds,
      // WebP stores plain milliseconds, video runs on the fps grid.
      const per =
        props.settings.format === "gif"
          ? gifDelayMs(props.settings.fps) / 1000
          : props.settings.format === "webp"
            ? webpDelayMs(props.settings.fps) / 1000
            : 1 / props.settings.fps;
      return Math.round(frameCount.value * per);
    });
    /** Video over its in-memory budget is refused (the muxer holds the
     *  whole track); the image formats never trip this — their window
     *  auto-shrinks. */
    const tooLong = computed(
      () => !imageFormat.value && frameCount.value > exportFrameBudget("video"),
    );
    /** An image take silently shortened the requested end — say so, with
     *  the cap. */
    const clamped = computed(
      () =>
        imageFormat.value &&
        props.settings.to - range.value.from >
          exportMaxSpan(props.settings.format, props.settings.fps, props.settings.speed) + 1e-6,
    );

    const ribbonDomain = computed<number[]>(() => [0, Math.max(1, props.duration)]);
    const ribbonWindow = computed<number[]>(() => [range.value.from, range.value.to]);
    /** The format row's pills: the two video containers plus the two image
     *  formats. A video pill carries its container in the value
     *  ("video:mp4" / "video:webm") because the settings model keeps format
     *  and container separate. */
    const formatPills = computed<{ value: string; label: string }[]>(() => [
      { value: "video:mp4", label: i18nT("replay.export.formatVideo") },
      { value: "video:webm", label: i18nT("replay.export.formatVideoWebm") },
      { value: "gif", label: i18nT("replay.export.formatGif") },
      { value: "webp", label: i18nT("replay.export.formatWebp") },
    ]);
    const formatPick = computed(() =>
      props.settings.format === "gif" || props.settings.format === "webp"
        ? props.settings.format
        : `video:${props.settings.container === "webm" ? "webm" : "mp4"}`,
    );
    const setFormat = (v: string): void => {
      const next: PlaybackExportFormat =
        v === "gif" ? "gif" : v === "webp" ? "webp" : "video";
      const formatChanged = next !== props.settings.format;
      props.settings.format = next;
      if (next === "video") {
        props.settings.container = v === "video:webm" ? "webm" : "mp4";
      }
      // A CONTAINER switch (both pills are video) leaves the ladders alone;
      // a FORMAT switch re-seeds them to that format's own default (video:
      // 2K @ 30 fps, GIF / WebP: 720p @ 10 fps). An "if it is on the ladder
      // keep it" check would carry a 2K GIF over from a video take — the
      // exact illegible/oversized case the new defaults exist to prevent.
      if (!formatChanged) return;
      props.settings.fps = PLAYBACK_EXPORT_DEFAULT_FPS[next];
      props.settings.size = PLAYBACK_EXPORT_DEFAULT_SIZE[next];
    };

    const start = (): void => {
      if (frameCount.value < 2 || tooLong.value) return;
      // Commit the normalized window so the job renders exactly this take.
      props.settings.from = range.value.from;
      props.settings.to = range.value.to;
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
        width="min(36rem, 94vw)"
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
          {/* Format: the standard pill toggle group. */}
          <div class="holo-export__row">
            <span class="holo-export__label">{i18nT("replay.export.format")}</span>
            <HkPillToggleGroup
              label={i18nT("replay.export.format")}
              options={formatPills.value}
              selected={new Set([formatPick.value])}
              onToggle={(v: string) => setFormat(v)}
            />
          </div>
          {/* View: the 2D tactical painting vs the replay's three.js scene
              from the fixed god camera. A second standard pill group — ONLY
              the map square swaps; every other band is identical. */}
          <div class="holo-export__row">
            <span class="holo-export__label">{i18nT("replay.export.view")}</span>
            <HkPillToggleGroup
              label={i18nT("replay.export.view")}
              options={[
                { value: "2d", label: i18nT("replay.export.view2d") },
                { value: "3d", label: i18nT("replay.export.view3d") },
              ]}
              selected={new Set([props.settings.view === "3d" ? "3d" : "2d"])}
              onToggle={(v: string) => {
                props.settings.view = v === "3d" ? "3d" : "2d";
              }}
            />
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
                // The image ladders pick the composition WIDTH (px); the video
                // ladders are the familiar "1080p" reading.
                label: isImageFormat(props.settings.format) ? `${s} px` : `${s}p`,
              }))}
              onUpdate:modelValue={(v: string) => {
                const s = Number(v);
                if (PLAYBACK_EXPORT_SIZES[props.settings.format].includes(s)) {
                  props.settings.size = s;
                }
              }}
            />
          </div>
          {/* Stats band: paint the live roster's configured stat columns
              (labels over the team averages + the first two values per
              row), or drop the band entirely so the identity lines use the
              full column width. Defaults to the live surface's own
              preference (the configured column list). */}
          <div class="holo-export__toggle">
            <span class="holo-export__toggle-label">
              {i18nT("replay.export.showStats")}
            </span>
            <HkSwitch
              modelValue={props.settings.stats !== false}
              onUpdate:modelValue={(v: boolean) => {
                props.settings.stats = v;
              }}
            />
          </div>
          {/* Range: the sequence-ribbon waterfall — drag to pick the span. */}
          <div class="holo-export__range">
            <span class="holo-export__label">{i18nT("replay.export.range")}</span>
            <p class="holo-export__range-readout">
              {clockLabel(range.value.from)} → {clockLabel(range.value.to)} ·{" "}
              {i18nT("replay.export.rangeLength", {
                time: clockLabel(range.value.to - range.value.from),
              })}
            </p>
            <HkRangeRibbon
              minimal
              lanes={[]}
              segments={[]}
              domain={ribbonDomain.value}
              window={ribbonWindow.value}
              minWindow={Math.max(0.01, 1 / Math.max(1, props.duration))}
              onWindowChange={(w: [number, number] | null) => {
                // Reset (the chip / Esc / double-click / Home) emits null:
                // that means the WHOLE domain, not "ignore".
                if (!w) {
                  props.settings.from = 0;
                  props.settings.to = Math.max(1, props.duration);
                  return;
                }
                props.settings.from = w[0];
                props.settings.to = w[1];
              }}
            />
            {clamped.value ? (
              <p class="holo-export__clamp">
                {i18nT("replay.export.rangeClamp", { time: clockLabel(range.value.to) })}
              </p>
            ) : null}
          </div>
          {/* Folder: the shun-style path field (picker backend = our native
              folder dialog; the shell persists the choice). */}
          {props.exportDir ? (
            <div class="holo-export__row holo-export__row--path">
              <HkFilePickerField
                label={i18nT("replay.export.pathLabel")}
                modelValue={props.exportDir}
                backend="hook"
                directory
                pick={async () => {
                  try {
                    return (await rpcApi.exportDirPick()) ?? null;
                  } catch {
                    return null;
                  }
                }}
                onUpdate:modelValue={(v: string) => props.onDirChange?.(v)}
              />
            </div>
          ) : null}
          <p class="holo-export__estimate">
            {i18nT("replay.export.estimate", { n: frameCount.value, s: seconds.value })}
          </p>
          {/* Common chat platforms' attachment limits, as small print under
              the take's stats — IMAGE formats only (a video take is not what
              these numbers are about). Reference values, verified 2026-11-22:
              Discord's free tier went 10 → 20 MB on 2026-08-14; Telegram caps
              a photo message at 10 MB and files at 2 GB (4 GB Premium); QQ's
              media API degrades images over ~20 MB to file uploads. */}
          {imageFormat.value ? (
            <div class="holo-export__limits">
              <p class="holo-export__limits-line">
                {i18nT("replay.export.platformLimits")}
              </p>
              <p class="holo-export__limits-note">
                {i18nT("replay.export.platformLimitsNote")}
              </p>
            </div>
          ) : null}
          {tooLong.value ? (
            <p class="holo-export__warn">
              {i18nT("replay.export.tooLong", { n: exportFrameBudget("video") })}
            </p>
          ) : null}
        </div>
      </HkModal>
    );
  },
});
