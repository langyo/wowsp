/**
 * StaticReportPanel — E25's shareable per-player decision report.
 *
 * One vertical column (the "long image" is exactly this DOM node exported
 * via html-to-image): header with the perspective picker and whole-game
 * scores, a coverage bar that paints the unresolvable segments instead of
 * papering over them, the instant-score sparkline with moment markers,
 * and one card per key decision — situation, action, the models' verdict,
 * and the realised outcome. `onSeek` jumps the 3D board's playhead so the
 * same report doubles as an in-app step-through; the picker switches any
 * roster perspective (the Rust side reuses its scoring cache, so a switch
 * is one IPC away).
 */
import { computed, defineComponent, ref, type PropType } from "vue";
import { HkButton, HkScrollContainer, HkSpinner, HkTag } from "@celestia-island/hikari";
import { Camera, Download, X } from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import type { StaticMoment, StaticReport, StaticRosterEntry } from "@/api";
import "./StaticReportPanel.scss";

const pct = (v: number): string => Math.round(v * 100).toString();

/** Compact damage/HP rendering (84.2k / 1.31M). Exported for vitest. */
export function formatHp(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toString();
}

/** Move-sector → relative bearing label ("+45°"; 16 = held). Vitest. */
export function sectorLabel(sector: number): string {
  if (sector === 16) return i18nT("replay.report.held");
  const deg = Math.round(((sector * 22.5 + 360) % 360));
  return `${deg}°`;
}

/** Coverage badge class: full / partial / none. Exported for vitest. */
export function coverageClass(c: { samples: number; completeness: number }): string {
  if (c.samples === 0) return "none";
  return c.completeness > 0.9 ? "full" : "partial";
}

/** The caption params per category; the localized sentence comes from
 * the i18n table keyed by `replay.report.cat_<category>`. */
/** Category → the HkTag variant (and marker class) it paints — one table
 * so the card badge and the timeline marker can never disagree. */
const CATEGORY_TONE: Record<
  StaticMoment["category"],
  { tone: string; tag: "success" | "danger" | "warning" | "info" }
> = {
  damageRealized: { tone: "good", tag: "success" },
  missedOpportunity: { tone: "bad", tag: "danger" },
  weakWindow: { tone: "bad", tag: "danger" },
  forcedShot: { tone: "warn", tag: "warning" },
  strongWindow: { tone: "ok", tag: "info" },
};
function categoryTone(category: StaticMoment["category"]): string {
  return CATEGORY_TONE[category].tone;
}

const Sparkline = defineComponent({
  name: "StaticReportSparkline",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
  },
  setup(props) {
    const W = 640;
    const H = 56;
    const path = computed(() => {
      const tl = props.report.timeline;
      if (tl.length < 2) return "";
      const dur = Math.max(1, props.report.durationS);
      return tl
        .map((s, i) => {
          const x = ((s.t / dur) * W).toFixed(1);
          const y = (H - 4 - s.inst * (H - 10)).toFixed(1);
          return `${i === 0 ? "M" : "L"}${x},${y}`;
        })
        .join(" ");
    });
    const gaps = computed(() => {
      const dur = Math.max(1, props.report.durationS);
      const me = props.report.roster.find((r) => r.entityId === props.report.entityId);
      return (me?.coverage.gapSegments ?? []).map(([a, b]) => ({
        x: (a / dur) * W,
        w: Math.max(2, ((b - a) / dur) * W),
      }));
    });
    const markers = computed(() => {
      const dur = Math.max(1, props.report.durationS);
      return props.report.moments.map((m) => ({
        x: (m.t / dur) * W,
        tone: categoryTone(m.category),
        key: m.t,
      }));
    });
    return () => (
      <svg class="srp-spark" width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {gaps.value.map((g, i) => (
          <rect key={`g${i}`} class="srp-spark__gap" x={g.x} y={0} width={g.w} height={H} />
        ))}
        <line class="srp-spark__mid" x1={0} y1={H / 2} x2={W} y2={H / 2} />
        <path class="srp-spark__line" d={path.value} />
        {markers.value.map((m) => (
          <line key={m.key} class={`srp-spark__mark srp-spark__mark--${m.tone}`} x1={m.x} y1={0} x2={m.x} y2={H} />
        ))}
      </svg>
    );
  },
});

export default defineComponent({
  name: "StaticReportPanel",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
    loading: { type: Boolean, default: false },
    /** Battle-time seek (the 3D board playhead); optional so the demo
     * route can render the panel without a map. */
    onSeek: { type: Function as PropType<(t: number) => void>, default: null },
    /** Perspective switch (refetch from the Rust cache). */
    onPick: { type: Function as PropType<(entityId: number) => void>, required: true },
    /** Optional close affordance (the secondary window supplies its own
     *  title-bar close; the in-map modal passed one). */
    onClose: { type: Function as PropType<() => void>, default: null },
  },
  setup(props) {
    const exporting = ref(false);
    const me = computed<StaticRosterEntry | undefined>(() =>
      props.report.roster.find((r) => r.entityId === props.report.entityId),
    );
    const rosterByTeam = computed(() => {
      const allies = props.report.roster.filter((r) => r.teamId === 0);
      const enemies = props.report.roster.filter((r) => r.teamId === 1);
      return { allies, enemies };
    });

    const exportPng = async () => {
      const node = document.querySelector<HTMLElement>(".static-report-panel__export-root");
      if (!node || exporting.value) return;
      exporting.value = true;
      try {
        const { toPng } = await import("html-to-image");
        // skipFonts: embedding the app webfonts fetches every font URL,
        // which hangs behind proxies / offline; the panel's own stack is
        // self-contained dark-surface CSS, so the system fallback is fine.
        // The race keeps the button from sticking if embedding stalls.
        const render = toPng(node, {
          backgroundColor: "#0d1117",
          // The panel scrolls inside the modal; capture the full column.
          height: node.scrollHeight,
          pixelRatio: 2,
          skipFonts: true,
          style: { maxHeight: "none", overflow: "visible" },
        });
        const url = await Promise.race([
          render,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("report export render timed out")), 20000),
          ),
        ]);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${props.report.replayId}_${props.report.entityId}_report.png`;
        a.click();
      } catch (err) {
        console.warn("[report] export failed", err);
      } finally {
        exporting.value = false;
      }
    };

    return () => (
      <div class="static-report-panel" role="dialog">
        <div class="static-report-panel__chrome">
          <span class="static-report-panel__title">{i18nT("replay.report.title")}</span>
          {props.loading ? <HkSpinner size={14} /> : null}
          <div class="static-report-panel__actions">
            <HkButton
              variant="secondary"
              size="sm"
              disabled={exporting.value}
              onClick={() => void exportPng()}
            >
              {exporting.value ? null : <Download size={13} />}
              <span>{i18nT(exporting.value ? "replay.report.exporting" : "replay.report.export")}</span>
            </HkButton>
            {props.onClose ? (
              <HkButton
                variant="ghost"
                size="sm"
                onClick={() => props.onClose()}
                aria-label={i18nT("replay.report.close")}
              >
                <X size={14} />
              </HkButton>
            ) : null}
          </div>
        </div>

        <HkScrollContainer class="static-report-panel__scroll">
        <div class="static-report-panel__export-root">
          {/* ── perspective picker (both teams, coverage-badged) ── */}
          <div class="srp-picker">
            <div class="srp-picker__team">
              <span class="srp-picker__label">{i18nT("replay.report.allies")}</span>
              <div class="srp-picker__row">
                {rosterByTeam.value.allies.map((r) => (
                  <button
                    key={r.entityId}
                    class={[
                      "srp-picker__chip",
                      r.entityId === props.report.entityId ? "srp-picker__chip--self" : "",
                    ]}
                    onClick={() => r.entityId !== props.report.entityId && props.onPick(r.entityId)}
                    disabled={r.coverage.samples === 0}
                    data-hint={
                      r.coverage.samples === 0
                        ? i18nT("replay.report.noData")
                        : `${i18nT("replay.report.coverage")}: ${pct(r.coverage.completeness)}%`
                    }
                  >
                    <span class="srp-picker__dot" />
                    <span class="srp-picker__name">{r.name ?? r.entityId}</span>
                    <span class={`srp-picker__badge srp-picker__badge--${coverageClass(r.coverage)}`}>
                      {r.coverage.samples === 0
                        ? "—"
                        : r.coverage.completeness > 0.9
                          ? "✓"
                          : pct(r.coverage.completeness)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div class="srp-picker__team">
              <span class="srp-picker__label">{i18nT("replay.report.enemies")}</span>
              <div class="srp-picker__row">
                {rosterByTeam.value.enemies.map((r) => (
                  <button
                    key={r.entityId}
                    class={[
                      "srp-picker__chip",
                      "srp-picker__chip--enemy",
                      r.entityId === props.report.entityId ? "srp-picker__chip--self" : "",
                    ]}
                    onClick={() => r.entityId !== props.report.entityId && props.onPick(r.entityId)}
                    disabled={r.coverage.samples === 0}
                    data-hint={
                      r.coverage.samples === 0
                        ? i18nT("replay.report.noData")
                        : `${i18nT("replay.report.coverage")}: ${pct(r.coverage.completeness)}%`
                    }
                  >
                    <span class="srp-picker__dot srp-picker__dot--enemy" />
                    <span class="srp-picker__name">{r.name ?? r.entityId}</span>
                    <span class={`srp-picker__badge srp-picker__badge--${coverageClass(r.coverage)}`}>
                      {r.coverage.samples === 0
                        ? "—"
                        : r.coverage.completeness > 0.9
                          ? "✓"
                          : pct(r.coverage.completeness)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── header: who, whole-game scores, coverage ── */}
          <div class="srp-head">
            <div class="srp-head__id">
              <span class="srp-head__name">{me.value?.name ?? props.report.entityId}</span>
              {me.value?.isRecorder ? (
                <HkTag variant="info" size="sm">{i18nT("replay.report.recorder")}</HkTag>
              ) : null}
              {me.value?.diedAt != null ? (
                <HkTag variant="danger" size="sm">
                  {i18nT("replay.report.diedAt", { t: Math.round(me.value.diedAt) })}
                </HkTag>
              ) : (
                <HkTag variant="success" size="sm">{i18nT("replay.report.survived")}</HkTag>
              )}
              <span class="srp-head__map">
                {props.report.mapName?.replace("spaces/", "") ?? ""} ·{" "}
                {i18nT("replay.report.duration", { t: Math.round(props.report.durationS) })}
              </span>
            </div>
            <div class="srp-head__scores">
              <div class="srp-head__score">
                <span class="srp-head__score-label">{i18nT("replay.report.contribution")}</span>
                <b>{me.value?.whole?.contribution != null ? formatHp(me.value.whole.contribution) : "—"}</b>
                {me.value?.whole?.contributionShots ? (
                  <span class="srp-head__score-sub">
                    {i18nT("replay.report.perShot", {
                      v: formatHp(me.value.whole.contribution! / me.value.whole.contributionShots),
                    })}
                  </span>
                ) : null}
              </div>
              <div class="srp-head__score">
                <span class="srp-head__score-label">{i18nT("replay.report.wholeGame")}</span>
                <b>{me.value ? pct(me.value.whole!.wholeGame) : "—"}%</b>
                <span class="srp-head__score-sub">
                  {i18nT("replay.report.fireMove", {
                    f: me.value?.whole?.wholeFire != null ? pct(me.value.whole.wholeFire) : "—",
                    m: me.value ? pct(me.value.whole!.wholeMove) : "—",
                  })}
                </span>
              </div>
            </div>
            <div class="srp-head__coverage">
              <span class="srp-head__coverage-label">
                {i18nT("replay.report.coverage")}: {me.value ? pct(me.value.coverage.completeness) : "—"}%
                {me.value && me.value.coverage.gapSeconds > 12 ? (
                  <span class="srp-head__coverage-note">
                    {i18nT("replay.report.gapNote", { s: Math.round(me.value.coverage.gapSeconds) })}
                  </span>
                ) : null}
              </span>
              <div class="srp-coverage-bar">
                {(me.value?.coverage.gapSegments ?? []).map(([a, b], i) => (
                  <div
                    key={i}
                    class="srp-coverage-bar__gap"
                    style={{
                      left: `${(a / Math.max(1, props.report.durationS)) * 100}%`,
                      width: `${((b - a) / Math.max(1, props.report.durationS)) * 100}%`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          <Sparkline report={props.report} />

          {/* ── moment cards ── */}
          <div class="srp-moments">
            {props.report.moments.length === 0 ? (
              <div class="srp-moments__empty">{i18nT("replay.report.noMoments")}</div>
            ) : (
              props.report.moments.map((m, i) => (
                <div key={m.t} class={`srp-moment srp-moment--${categoryTone(m.category)}`}>
                  <div class="srp-moment__head">
                    <span class="srp-moment__idx">#{i + 1}</span>
                    <span class="srp-moment__time">
                      {String(Math.floor(m.t / 60)).padStart(2, "0")}:
                      {String(Math.floor(m.t % 60)).padStart(2, "0")}
                    </span>
                    <HkTag variant={CATEGORY_TONE[m.category].tag} size="sm">
                      {i18nT(`replay.report.cat_${m.category}`)}
                    </HkTag>
                    {props.onSeek ? (
                      <HkButton
                        variant="secondary"
                        size="xs"
                        onClick={() => props.onSeek?.(m.t)}
                        aria-label={i18nT("replay.report.seekHint")}
                      >
                        <Camera size={12} />
                        <span>{i18nT("replay.report.seek")}</span>
                      </HkButton>
                    ) : null}
                  </div>
                  <div class="srp-moment__body">
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.hp")}</span>
                      <b>{m.hpFrac != null ? `${pct(m.hpFrac)}%` : "—"}</b>
                      {m.hpFracAfter != null && m.hpFrac != null ? (
                        <span class="srp-moment__delta">
                          → {pct(m.hpFracAfter)}% ({i18nT("replay.report.after20")})
                        </span>
                      ) : null}
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.speed")}</span>
                      <b>{m.speedKt != null ? `${Math.round(m.speedKt)}kt` : "—"}</b>
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.nearestEnemy")}</span>
                      {m.nearestEnemy ? (
                        <b>
                          {formatHp(m.nearestEnemy.distM)}m
                          <span class={`srp-moment__range ${m.nearestEnemy.inRange ? "in" : "out"}`}>
                            {i18nT(
                              m.nearestEnemy.inRange
                                ? "replay.report.inRange"
                                : "replay.report.outOfRange",
                            )}
                          </span>
                        </b>
                      ) : (
                        <b>—</b>
                      )}
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.observed")}</span>
                      <b>{m.enemiesObserved}</b>
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.fireAction")}</span>
                      <b>
                        {m.fired == null
                          ? "—"
                          : m.fired
                            ? i18nT("replay.report.fired")
                            : i18nT("replay.report.held")}
                        {m.fireProb != null ? (
                          <span class="srp-moment__prob">p={pct(m.fireProb)}%</span>
                        ) : null}
                      </b>
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.moveAdvice")}</span>
                      <b>
                        {sectorLabel(m.advisedSector)} ({pct(m.advisedProb)}%)
                        <span class="srp-moment__actual">
                          {i18nT("replay.report.actual")} {sectorLabel(m.moveSector)}
                        </span>
                      </b>
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.instScore")}</span>
                      <b>
                        {pct(m.inst)}%
                        <span class="srp-moment__prob">κ={pct(m.confidence)}%</span>
                      </b>
                    </div>
                    <div class="srp-moment__stat srp-moment__stat--outcome">
                      <span>{i18nT("replay.report.outcome")}</span>
                      <b>
                        {m.hpLostWindow != null && m.hpLostWindow > 0
                          ? i18nT("replay.report.hpLost", { v: formatHp(m.hpLostWindow) })
                          : i18nT("replay.report.noAttributed")}
                      </b>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div class="srp-foot">
            {i18nT("replay.report.modelNote")} · {props.report.modelSources.fire.split(/[\\/]/).pop()} ·{" "}
            {props.report.modelSources.moveModel.split(/[\\/]/).pop()}
          </div>
        </div>
        </HkScrollContainer>
      </div>
    );
  },
});
