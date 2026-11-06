/**
 * StaticReportPanel — E25's shareable per-player decision report.
 *
 * One vertical column (the "long image" is exactly this DOM node captured
 * via html-to-image and copied to the clipboard): the selected player's
 * identity head (emblem + clan + nickname + ship, whole-game scores and
 * coverage) with the battle provenance in the right corner (map, mode,
 * start, replay fingerprint, duration), the editor timeline (ruler,
 * keyframe lane, score track — with the annotation band in capture mode),
 * the model footnote and the SHARED WoWSP share footer (shotKit's canvas
 * watermark as a DOM twin, plus the AI notice and model version).
 * `onSeek` jumps the 3D board's playhead from the timeline's keyframe
 * cards, so the same report doubles as an in-app step-through; the picker
 * switches any roster perspective (the Rust side reuses its scoring cache,
 * so a switch is one IPC away).
 *
 * EMBEDDED (always, since 2026-11-03): the column mounts inside
 * StaticReportModal — the replay view's first-class hikari window (the
 * former hand-rolled overlay + this panel's own title/action row and the
 * dev-only demo route died with the extraction). HkModal renders the ONE
 * window head; this panel is chromeless by construction and the modal
 * drives the exposed capturePng through a component ref, then hands the
 * bytes to the shared copy-shot flow (features/share/useShareImage) — the
 * long image is COPIED to the clipboard, never downloaded: a WebView2
 * download only landed in the user's Downloads folder with zero in-app
 * feedback and read as "the button does nothing" (2026-11-06 report).
 *
 * 2026-11-06 redesign: the roster chip grid collapsed into a single
 * perspective dropdown (the head shows only the player being read) and the
 * wall of key-moment cards became ReportTimeline — an editor-style
 * waterfall whose capture mode renders the annotation cards the interactive
 * surface keeps behind hover/tap.
 */
import { computed, defineComponent, nextTick, ref, type PropType } from "vue";
import { HkScrollContainer } from "@celestia-island/hikari";

import AppTag from "@/components/base/AppTag";
import ShotFooter from "@/features/share/ShotFooter";
import { aiModelVersion } from "@/features/ai/modelVersion";
import { t } from "@/i18n";
import type { StaticReport, StaticRosterEntry } from "@/api";
import ReportPlayerPicker from "./ReportPlayerPicker";
import ReportTimeline from "./ReportTimeline";
import { formatHp, pct } from "./reportFormat";
import type { ReportSheetView } from "./reportSheet";
import "./StaticReportPanel.scss";

/** Ceiling on the long-image capture: past this the copy reports failure. */
const CAPTURE_TIMEOUT_MS = 20_000;

/** The report column's own capture → bytes contract (no clipboard, no
 *  toast: both live in the shared share kit). Exported for vitest. */
export async function captureReportPng(node: HTMLElement): Promise<Uint8Array> {
  const { toBlob } = await import("html-to-image");
  // skipFonts: embedding the app webfonts fetches every font URL, which
  // hangs behind proxies / offline; the panel's own stack is a
  // self-contained dark-surface CSS, so the system fallback is fine.
  const render = toBlob(node, {
    backgroundColor: "#0d1117",
    // The panel scrolls inside the modal; capture the full column.
    height: node.scrollHeight,
    pixelRatio: 2,
    skipFonts: true,
    style: { maxHeight: "none", overflow: "visible" },
  });
  // The render is an SVG foreignObject pass: a stall must surface as a
  // failed-copy toast, never as a spinner that never ends.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("report capture timed out")),
      CAPTURE_TIMEOUT_MS,
    );
  });
  let blob: Blob | null;
  try {
    blob = await Promise.race([render, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (!blob) throw new Error("report capture produced no PNG");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Two frames: capture mode mounts the annotation band and re-lays the lane
 *  grid against the measured plot width, so html-to-image must clone a
 *  settled layout rather than the mid-swap one. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

export default defineComponent({
  name: "StaticReportPanel",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
    /** Battle-time seek (the 3D board playhead); optional — the modal
     * forwards the timeline cards' jump through to its host. */
    onSeek: { type: Function as PropType<(t: number) => void>, default: null },
    /** Perspective switch (refetch from the Rust cache). */
    onPick: { type: Function as PropType<(entityId: number) => void>, required: true },
    /** Host-resolved identity/meta/roster faces (avatar, clan, ship icon,
     *  map/mode/start/hash). Null renders the plain report (tests, dev). */
    sheet: { type: Object as PropType<ReportSheetView | null>, default: null },
  },
  setup(props, { expose }) {
    /** The exported long-image column — the capture's DOM root (a template
     *  ref, not a document query: the panel must capture ITS root even if a
     *  future host mounts a second report somewhere). */
    const exportRootRef = ref<HTMLElement | null>(null);
    /** Capture mode: the timeline swaps its hover surface for the static
     *  annotation band; the picker is forced shut so the frame is clean. */
    const capturing = ref(false);
    const me = computed<StaticRosterEntry | undefined>(() =>
      props.report.roster.find((row) => row.entityId === props.report.entityId),
    );
    /** Top-right battle provenance: map, mode, start time, replay hash tail
     *  and duration — the header the replay's own meta row carries, trimmed
     *  to fit the sheet. */
    const mapLabel = computed(
      () =>
        props.sheet?.meta.mapName ??
        props.report.mapName?.replace("spaces/", "") ??
        "",
    );
    const modeLabel = computed(() => props.sheet?.meta.modeLabel ?? null);
    const battleStart = computed(() => props.sheet?.meta.battleStart ?? null);
    const hashTail = computed(() => {
      const hash = props.sheet?.meta.replayHash;
      return hash && hash.length > 6 ? hash.slice(-6) : null;
    });
    /** WoWSP AI identity: the model version line (app version + last weights
     *  training date) from the single model-version source. */
    const aiIdentity = aiModelVersion();
    const aiVersionLine = computed(() =>
      t("replay.report.aiVersion", {
        version: aiIdentity.version,
        date: aiIdentity.trainedAt,
      }),
    );
    /** The coverage bar spans the player's OBSERVED interval (death time for
     *  a sunk ship), matching the timeline axis — mapping the gaps over the
     *  full battle left a misleading empty tail. */
    const coverageWindow = computed(() => {
      const coverage = me.value?.coverage;
      const start = coverage?.aliveFrom ?? 0;
      const end = coverage?.aliveTo ?? Math.max(1, props.report.durationS);
      return { start, span: Math.max(1, end - start) };
    });

    /** Capture this panel's long image to PNG bytes for the host's copy
     *  button (the modal owns the clipboard write + the toast through
     *  features/share/useShareImage). A thrown error reaches that toast as
     *  the failure path — never a silent no-op. */
    const capturePng = async (): Promise<Uint8Array> => {
      const node = exportRootRef.value;
      if (!node) throw new Error("report export root is not mounted");
      capturing.value = true;
      try {
        await nextTick();
        await nextFrame();
        await nextFrame();
        return await captureReportPng(node);
      } finally {
        capturing.value = false;
      }
    };

    // The host (StaticReportModal) renders the window head; expose ONLY the
    // capture — the clipboard and the toast belong to the shared copy shot
    // kit. NOTE: the setup-context expose, not the defineExpose compiler
    // macro — the latter is a runtime no-op outside an SFC script-setup
    // block, silently leaving the host ref without the method.
    expose({ capturePng });

    return () => (
      <div class="static-report-panel">
        <HkScrollContainer class="static-report-panel__scroll">
          <div ref={exportRootRef} class="static-report-panel__export-root">
            {/* ── head: the selected perspective, scores, coverage ── */}
            <div class="srp-head">
              <div class="srp-head__row">
                <ReportPlayerPicker
                  report={props.report}
                  capturing={capturing.value}
                  identity={props.sheet?.identity ?? null}
                  roster={props.sheet?.roster ?? null}
                  onPick={(entityId: number) => props.onPick(entityId)}
                />
                {me.value?.isRecorder ? (
                  <AppTag tone="info">{t("replay.report.recorder")}</AppTag>
                ) : null}
                {me.value?.diedAt != null ? (
                  <AppTag tone="danger">
                    {t("replay.report.diedAt", {
                      t: Math.round(me.value.diedAt),
                    })}
                  </AppTag>
                ) : (
                  <AppTag tone="success">{t("replay.report.survived")}</AppTag>
                )}
                <div class="srp-head__meta">
                  <span class="srp-head__meta-map">{mapLabel.value}</span>
                  {modeLabel.value ? (
                    <span class="srp-head__mode">{modeLabel.value}</span>
                  ) : null}
                  {battleStart.value ? (
                    <span class="srp-head__meta-item">
                      {battleStart.value}
                    </span>
                  ) : null}
                  {hashTail.value ? (
                    <span
                      class="srp-head__hash"
                      data-hint={t("replay.report.replayHash")}
                    >
                      #{hashTail.value}
                    </span>
                  ) : null}
                  <span class="srp-head__meta-item">
                    {t("replay.report.duration", {
                      t: Math.round(props.report.durationS),
                    })}
                  </span>
                </div>
              </div>
              <div class="srp-head__scores">
                <div class="srp-head__score">
                  <span class="srp-head__score-label">
                    {t("replay.report.contribution")}
                  </span>
                  <b>
                    {me.value?.whole?.contribution != null
                      ? formatHp(me.value.whole.contribution)
                      : "—"}
                  </b>
                  {me.value?.whole?.contributionShots ? (
                    <span class="srp-head__score-sub">
                      {t("replay.report.perShot", {
                        v: formatHp(
                          me.value.whole.contribution! /
                            me.value.whole.contributionShots,
                        ),
                      })}
                    </span>
                  ) : null}
                </div>
                <div class="srp-head__score">
                  <span class="srp-head__score-label">
                    {t("replay.report.wholeGame")}
                  </span>
                  <b>{me.value ? pct(me.value.whole!.wholeGame) : "—"}%</b>
                  <span class="srp-head__score-sub">
                    {t("replay.report.fireMove", {
                      f:
                        me.value?.whole?.wholeFire != null
                          ? pct(me.value.whole.wholeFire)
                          : "—",
                      m: me.value ? pct(me.value.whole!.wholeMove) : "—",
                    })}
                  </span>
                </div>
                <div class="srp-head__coverage">
                  <span class="srp-head__coverage-label">
                    {t("replay.report.coverage")}:{" "}
                    {me.value ? pct(me.value.coverage.completeness) : "—"}%
                    {me.value && me.value.coverage.gapSeconds > 12 ? (
                      <span class="srp-head__coverage-note">
                        {t("replay.report.gapNote", {
                          s: Math.round(me.value.coverage.gapSeconds),
                        })}
                      </span>
                    ) : null}
                  </span>
                  <div class="srp-coverage-bar">
                    {(me.value?.coverage.gapSegments ?? []).map(([from, to], i) => (
                      <div
                        key={i}
                        class="srp-coverage-bar__gap"
                        style={{
                          left:
                            ((from - coverageWindow.value.start) /
                              coverageWindow.value.span) *
                              100 +
                            "%",
                          width:
                            ((to - from) / coverageWindow.value.span) * 100 +
                            "%",
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <ReportTimeline
              report={props.report}
              capturing={capturing.value}
              onSeek={props.onSeek ?? undefined}
            />

            <div class="srp-foot">
              {t("replay.report.modelNote")} ·{" "}
              {props.report.modelSources.fire.split(/[\\/]/).pop()} ·{" "}
              {props.report.modelSources.moveModel.split(/[\\/]/).pop()}
            </div>
            {/* The copied long image closes on the SAME WoWSP watermark every
                share shot carries, plus the AI-specific notice and the AI
                model version line. */}
            <ShotFooter
              class="srp-foot-shared"
              notes={[t("replay.report.aiNotice")]}
              meta={[aiVersionLine.value]}
            />
          </div>
        </HkScrollContainer>
      </div>
    );
  },
});
