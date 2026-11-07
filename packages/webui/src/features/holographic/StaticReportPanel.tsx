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
 * onSeek is the timeline's one-click return to the battle: clicking a
 * keyframe forwards through the modal to the host, which closes the report,
 * seeks the 3D board's playhead to that moment and focuses the camera on
 * the analyzed player. The picker switches any roster perspective (the Rust
 * side reuses its scoring cache, so a switch is one IPC away).
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
 *
 * 2026-11-07 OFFSCREEN CAPTURE (user request: do not temporarily modify the
 * page when producing the screenshot): capturePng used to flip a capturing
 * ref on the LIVE panel, so the open window visibly mutated for a few frames
 * (annotation band appeared, picker/chevrons disabled, watermark footer
 * mounted) before html-to-image cloned it. The sheet body is now a
 * subcomponent rendered TWICE: the live window always renders the
 * interactive sheet (capturing=false), while capturePng mounts a hidden,
 * far-off-viewport Teleport host on <body> that renders the same sheet with
 * capture mode on, waits for its lane measurement to settle, and hands THAT
 * node to html-to-image. The visible window never changes during a copy —
 * the capture-mode sheet exists only offscreen.
 */
import {
  computed,
  defineComponent,
  nextTick,
  ref,
  Teleport,
  type PropType,
} from "vue";
import { HkCopyBadge, HkScrollContainer } from "@celestia-island/hikari";

import AppTag from "@/components/base/AppTag";
import MapNameTag from "@/features/replay/MapNameTag";
import ShotFooter from "@/features/share/ShotFooter";
import { aiModelVersion } from "@/features/ai/modelVersion";
import { t } from "@/i18n";
import type {
  StaticReport,
  StaticRosterEntry,
  TorpedoScores,
} from "@/api";
import ReportPlayerPicker from "./ReportPlayerPicker";
import ReportTimeline from "./ReportTimeline";
import { formatClock, formatDuration, formatHp, pct } from "./reportFormat";
import type { ReportSheetView } from "./reportSheet";
import "./StaticReportPanel.scss";

/** Ceiling on the long-image capture: past this the copy reports failure. */
const CAPTURE_TIMEOUT_MS = 20_000;

/** The SVG presentation properties a capture must pin as INLINE styles.
 *  Curated for this sheet: the paint that a class rule drives on the score
 *  track and its grid / hairline lines (fill, stroke and their modifiers),
 *  the inherited faces a future nested <g> / <text> would otherwise lose
 *  (color — the resolution target of currentColor — plus the text and
 *  transform properties), and the one geometry hint the track relies on
 *  (vector-effect: non-scaling-stroke). Kept to a proof set rather than the
 *  whole computed declaration: the clone only needs what the app stylesheet
 *  used to supply. */
const SVG_PRESENTATION_PROPS = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "visibility",
  "display",
  "color",
  "stop-color",
  "stop-opacity",
  "paint-order",
  "shape-rendering",
  "vector-effect",
  "transform",
  "transform-origin",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
] as const;

/**
 * Pin the computed PRESENTATION styles of every SVG descendant under `root`
 * as INLINE styles — the capture-time repair for html-to-image's SVG
 * short-circuit.
 *
 * html-to-image 1.11.13 deep-clones an <svg> subtree (`cloneSingleNode` →
 * `node.cloneNode(true)` for SVG) and its `cloneChildren` returns early for
 * SVG nodes, so only HTML nodes get their computed styles inlined
 * (`cloneCSSStyle`). The clone is then rendered through an SVG/foreignObject
 * data URL WITHOUT the app stylesheets: every class-driven `fill`/`stroke`
 * inside the score track is dropped, so each <path> falls back to SVG's
 * default solid BLACK fill and the grid / hairline <line>s lose their
 * strokes. Inline presentation declarations travel with the deep clone, so
 * stamping the computed values here makes the copied long image paint
 * exactly like the window.
 *
 * The caller passes the HIDDEN offscreen sheet only, so the live window is
 * never mutated (a copy leaves it byte-identical). The <svg> roots themselves
 * are decorated by html-to-image (its `decorate` pass runs on SVG clones
 * too), hence descendants suffice. One `getComputedStyle` read per element,
 * not per property: the report sheet carries a handful of SVG nodes, so the
 * walk stays cheap.
 */
export function inlineSvgPresentationStyles(root: HTMLElement): void {
  for (const svg of root.querySelectorAll("svg")) {
    for (const element of svg.querySelectorAll<SVGElement>("*")) {
      const style = element.style;
      // Defensive: every SVGElement exposes .style, but the walk must never
      // throw on an exotic descendant of a foreignObject.
      if (!style) continue;
      const computed = window.getComputedStyle(element);
      for (const property of SVG_PRESENTATION_PROPS) {
        const value = computed.getPropertyValue(property);
        // Empty = the property does not apply here; a stray empty inline
        // declaration would only bloat the cloned frame.
        if (value) style.setProperty(property, value);
      }
    }
  }
}

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

/** Two frames: the offscreen copy mounts the annotation band and re-lays the
 *  lane grid against the measured plot width, so html-to-image must clone a
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

/** Width fallback for the offscreen column when the live root reports no
 *  layout width (the modal's reading frame is min(1180px, 94vw); 1128 is its
 *  content width at the default window). A real browser always measures the
 *  live root, so this only backstops headless hosts / pre-layout mounts. */
const CAPTURE_FALLBACK_WIDTH_PX = 1128;

/** One-decimal percentage for probability means: the torpedo head-B base
 *  rate is ~1.6 %, which must not round into a false "2 %" face. */
const pct1 = (v: number): string => (v * 100).toFixed(1);

/**
 * The head's torpedo diagnostics card (E26 / P2). A SEPARATE dimension by
 * design: it never feeds `wholeGame`, the contribution or any ranking, so
 * the card carries the diagnostic numbers and nothing that reads as a
 * player rating. `scores == null` means the torpedo model is missing or the
 * hull's class is not torpedo-applicable — render N/A, never a 0 score.
 */
function TorpedoCard(props: {
  scores: TorpedoScores | null;
  applicable: boolean;
}) {
  const scores = props.scores;
  return (
    <div class="srp-head__score srp-head__score--torpedo">
      <span class="srp-head__score-label">
        {t("replay.report.torpedoAgreement")}
      </span>
      {scores != null && props.applicable ? (
        <>
          <b>{pct(scores.agreement)}%</b>
          <span class="srp-head__score-sub">
            {t("replay.report.torpedoDetail", {
              a: pct(scores.agreement),
              p: pct1(scores.meanProb),
              n: scores.canLaunchWindows,
              l: scores.launches,
            })}
          </span>
        </>
      ) : (
        <span class="srp-head__score-na">
          {t("replay.report.torpedoNotCovered")}
        </span>
      )}
    </div>
  );
}

/**
 * The sheet body — the head (perspective dropdown, scores, coverage), the
 * editor timeline, the model footnote and (capture mode only) the shared
 * WoWSP watermark footer. One component, rendered by the live window with
 * capturing=false and by the hidden capture host with capturing=true, so the
 * copied long image and the window can never drift apart.
 */
const ReportSheetBody = defineComponent({
  name: "ReportSheetBody",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
    /** Host-resolved identity/meta/roster faces (avatar, clan, ship icon,
     *  map/mode/start/hash). Null renders the plain report (tests, dev). */
    sheet: { type: Object as PropType<ReportSheetView | null>, default: null },
    /** Export mode: static annotation band, inert tags, no dropdown chrome,
     *  watermark footer. Always false on the live window. */
    capturing: { type: Boolean, default: false },
    /** Keyframe pick (battle-time seek + camera focus); optional — the
     *  modal forwards the timeline's jump through to its host. */
    onSeek: { type: Function as PropType<(t: number) => void>, default: null },
    /** Perspective switch (refetch from the Rust cache). */
    onPick: {
      type: Function as PropType<(entityId: number) => void>,
      required: true,
    },
  },
  setup(props) {
    const me = computed<StaticRosterEntry | undefined>(() =>
      props.report.roster.find((row) => row.entityId === props.report.entityId),
    );
    /** The fire model has no label space for this ship class (AirCarrier /
     *  Submarine: zero positive fire examples in the training corpus), so
     *  its fire component and contribution are null BY CONTRACT. The head
     *  must say "not applicable" instead of a misleading face: the
     *  whole-game score then is the movement component alone. */
    const fireUnsupported = computed(() => me.value?.fireApplicable === false);
    /** E26/P2 torpedo diagnostics: an INDEPENDENT dimension carried by the
     *  whole block. Null = the torpedo model is not installed or this hull's
     *  class is not torpedo-applicable — the head then renders N/A, never a
     *  zero score, and the value never touches `wholeGame` or any ranking. */
    const torpedo = computed(() => me.value?.whole?.torpedo ?? null);
    /** Top-right battle provenance: map, mode, start time, fate, replay
     *  hash tail and duration — the header the replay's own meta row
     *  carries, trimmed to fit the sheet. */
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

    return () => (
      <>
        {/* ── head: the selected perspective, scores, coverage ── */}
        <div class="srp-head">
          <div class="srp-head__row">
            <ReportPlayerPicker
              report={props.report}
              capturing={props.capturing}
              identity={props.sheet?.identity ?? null}
              roster={props.sheet?.roster ?? null}
              onPick={(entityId: number) => props.onPick(entityId)}
            />
            {me.value?.isRecorder ? (
              <AppTag tone="info">{t("replay.report.recorder")}</AppTag>
            ) : null}
            <div class="srp-head__meta">
              <MapNameTag
                class="srp-head__meta-map"
                spaceId={props.report.mapName}
                lang={props.sheet?.meta.mapLang ?? null}
              />
              {modeLabel.value ? (
                <AppTag
                  color={props.sheet?.meta.modeColor ?? undefined}
                  class="srp-head__mode"
                >
                  {modeLabel.value}
                </AppTag>
              ) : null}
              {/* The provenance TELEMETRY (time / replay fingerprint /
                  duration) is tag-ified: the house HkCopyBadge contract
                  (never selectable, hover says click-to-copy, one shared
                  clipboard toast). The cloned share frame renders the
                  same tags INERT (disabled drops the button semantics and
                  tooltip) — a screenshot is not interactive. */}
              {battleStart.value ? (
                <HkCopyBadge
                  size="sm"
                  class="srp-head__time"
                  value={battleStart.value}
                  disabled={props.capturing}
                >
                  {battleStart.value}
                </HkCopyBadge>
              ) : null}
              {me.value?.diedAt != null ? (
                <AppTag
                  tone="danger"
                  class="srp-head__fate"
                  data-hint={t("replay.report.diedAt", {
                    t: formatClock(me.value.diedAt),
                  })}
                >
                  {t("replay.report.diedAt", {
                    t: formatClock(me.value.diedAt),
                  })}
                </AppTag>
              ) : (
                <AppTag tone="success" class="srp-head__fate">
                  {t("replay.report.survivedAtEnd")}
                </AppTag>
              )}
              {hashTail.value ? (
                <HkCopyBadge
                  size="sm"
                  mono
                  class="srp-head__hash"
                  value={props.sheet?.meta.replayHash ?? ""}
                  tooltip={t("replay.report.replayHashHint")}
                  disabled={props.capturing}
                >
                  #{hashTail.value}
                </HkCopyBadge>
              ) : null}
              <HkCopyBadge
                size="sm"
                mono
                class="srp-head__duration"
                value={formatDuration(props.report.durationS)}
                disabled={props.capturing}
              >
                {t("replay.report.duration", {
                  t: formatDuration(props.report.durationS),
                })}
              </HkCopyBadge>
            </div>
          </div>
          <div class="srp-head__scores">
            <div class="srp-head__score">
              <span class="srp-head__score-label">
                {t("replay.report.contribution")}
              </span>
              <b>
                {fireUnsupported.value
                  ? t("replay.report.notApplicable")
                  : me.value?.whole?.contribution != null
                    ? formatHp(me.value.whole.contribution)
                    : "—"}
              </b>
              {/* No per-window mean for an unsupported class: the
                  contribution is null by contract (zero fire positives),
                  not a missing measurement. */}
              {!fireUnsupported.value &&
              me.value?.whole?.contributionShots ? (
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
              {/* Unsupported classes never render the trivial fire face:
                  the whole-game score is the movement component alone, so
                  the sub-line says "move-only" instead of "fire —". */}
              <span class="srp-head__score-sub">
                {fireUnsupported.value
                  ? t("replay.report.moveOnly", {
                      m: me.value?.whole
                        ? pct(me.value.whole.wholeMove)
                        : "—",
                    })
                  : t("replay.report.fireMove", {
                      f:
                        me.value?.whole?.wholeFire != null
                          ? pct(me.value.whole.wholeFire)
                          : "—",
                      m: me.value ? pct(me.value.whole!.wholeMove) : "—",
                    })}
              </span>
            </div>
            {/* E26/P2 torpedo diagnostics — an independent small card: a
                diagnostic read, never part of the whole-game score / the
                contribution / any ranking. A missing model or a
                non-applicable hull renders N/A (the numbers are null by
                contract), never a 0 score. */}
            <TorpedoCard
              scores={torpedo.value}
              applicable={me.value?.torpedoApplicable !== false}
            />
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
                        ((to - from) / coverageWindow.value.span) * 100 + "%",
                    }}
                  />
                ))}
              </div>
              {fireUnsupported.value ? (
                <span class="srp-head__class-note">
                  {t("replay.report.classNotCovered")}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <ReportTimeline
          report={props.report}
          capturing={props.capturing}
          onSeek={props.onSeek ?? undefined}
        />

        <div class="srp-foot">
          {t("replay.report.modelNote")} ·{" "}
          {props.report.modelSources.fire.split(/[\\/]/).pop()} ·{" "}
          {props.report.modelSources.moveModel.split(/[\\/]/).pop()}
        </div>
        {/* The copied long image closes on the SAME WoWSP watermark every
            share shot carries, plus the AI-specific notice and the AI
            model version line. Capture-only: the watermark belongs to the
            share artifact, not to the window (the window already carries
            the modal chrome — 2026-11-07 review). */}
        {props.capturing ? (
          <ShotFooter
            class="srp-foot-shared"
            notes={[t("replay.report.aiNotice")]}
            meta={[aiVersionLine.value]}
          />
        ) : null}
      </>
    );
  },
});

export default defineComponent({
  name: "StaticReportPanel",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
    /** Keyframe pick (battle-time seek + camera focus); optional — the
     * modal forwards the timeline's jump through to its host. */
    onSeek: { type: Function as PropType<(t: number) => void>, default: null },
    /** Perspective switch (refetch from the Rust cache). */
    onPick: { type: Function as PropType<(entityId: number) => void>, required: true },
    /** Host-resolved identity/meta/roster faces (avatar, clan, ship icon,
     *  map/mode/start/hash). Null renders the plain report (tests, dev). */
    sheet: { type: Object as PropType<ReportSheetView | null>, default: null },
  },
  setup(props, { expose }) {
    /** The LIVE long-image column. It is only ever MEASURED (its client
     *  width seeds the offscreen copy) — the visible window renders the
     *  interactive sheet and is never mutated for a capture. A template ref,
     *  not a document query: the panel must capture its OWN column even if a
     *  future host mounts a second report somewhere. */
    const exportRootRef = ref<HTMLElement | null>(null);
    /** Capture mode is buffered: while true, a hidden Teleport host on <body>
     *  renders a second copy of the sheet with capture mode ON. The live
     *  window's capturing is always false. */
    const captureHost = ref(false);
    /** Width handed to the offscreen column — the live export root's own
     *  content width, so the copied image keeps the window's proportions. */
    const captureWidth = ref(CAPTURE_FALLBACK_WIDTH_PX);
    /** The offscreen copy's export root (the node html-to-image clones). */
    const captureRootRef = ref<HTMLElement | null>(null);

    /** Capture this panel's long image to PNG bytes for the host's copy
     *  button (the modal owns the clipboard write + the toast through
     *  features/share/useShareImage). A thrown error reaches that toast as
     *  the failure path — never a silent no-op. */
    const capturePng = async (): Promise<Uint8Array> => {
      const liveRoot = exportRootRef.value;
      if (!liveRoot) throw new Error("report export root is not mounted");
      const measured = liveRoot.clientWidth;
      captureWidth.value =
        measured > 0 ? measured : CAPTURE_FALLBACK_WIDTH_PX;
      captureHost.value = true;
      try {
        await nextTick();
        // The annotation band measures the OFFSCREEN lane's real width and
        // the band height re-lays the column: two frames so the clone sees
        // the settled sheet, never the freshly mounted one.
        await nextFrame();
        await nextFrame();
        const node = captureRootRef.value;
        if (!node) throw new Error("report capture root is not mounted");
        // html-to-image deep-clones SVG subtrees WITHOUT inlining their
        // descendants' computed styles (see inlineSvgPresentationStyles), so
        // the score track must reach the clone pre-pinned: otherwise its
        // envelopes render as solid black slabs and the grid lines lose
        // their strokes. Only the hidden offscreen copy is mutated here — it
        // is torn down in the finally block and the live window stays
        // byte-identical.
        inlineSvgPresentationStyles(node);
        return await captureReportPng(node);
      } finally {
        // The host is a render effect: unmount it and wait for that pass so
        // the resolve means "the offscreen sheet is gone" — a caller can
        // never observe a lingering copy, and a failed render still cleans
        // up (the copy toast owns the failure).
        captureHost.value = false;
        await nextTick();
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
            <ReportSheetBody
              report={props.report}
              sheet={props.sheet}
              capturing={false}
              onSeek={props.onSeek ?? undefined}
              onPick={props.onPick}
            />
          </div>
        </HkScrollContainer>
        {/* The capture-mode sheet lives ONLY here: a fixed, far-off-viewport
            duplicate with real layout (html-to-image needs computed styles,
            so no display:none / visibility:hidden) that never paints over
            the window and never creates scrollbars (fixed + negative left,
            pointer-events:none). Teleported to <body> so no ancestor
            transform/overflow/contain in the modal can clip or rescale the
            captured layout. */}
        {captureHost.value ? (
          <Teleport to="body">
            <div
              class="static-report-panel__capture-host"
              aria-hidden="true"
              // A copy must not add a tab stop to the window: the offscreen
              // sheet carries the same buttons as the live one, and inert
              // removes them from focus / the a11y tree (aria-hidden hides
              // the text, inert stops the Tab key landing off-viewport).
              inert={true}
              style={{
                position: "fixed",
                left: "-30000px",
                top: "0px",
                width: captureWidth.value + "px",
                pointerEvents: "none",
                zIndex: -1,
              }}
            >
              <div
                class="static-report-panel static-report-panel--capture"
                style={{ width: captureWidth.value + "px" }}
              >
                <div
                  ref={captureRootRef}
                  class="static-report-panel__export-root"
                >
                  <ReportSheetBody
                    report={props.report}
                    sheet={props.sheet}
                    capturing={true}
                    onSeek={props.onSeek ?? undefined}
                    onPick={props.onPick}
                  />
                </div>
              </div>
            </div>
          </Teleport>
        ) : null}
      </div>
    );
  },
});
