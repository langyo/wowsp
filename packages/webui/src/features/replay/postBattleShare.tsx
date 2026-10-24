/**
 * Sharing + shared-row utilities for the post-battle panels (replay 结果
 * modal and the incomplete-results fallback matrix) and the live battle
 * panel: nickname masking (hide all / hide single players), the "copy share
 * shot" flow that renders the matrix to a watermarked PNG and pushes it onto
 * the system clipboard (the copy flow itself lives in the shared share kit —
 * features/share/useShareImage.ts), and the aligned roster-stat columns
 * (`rosterStatCols` / `rosterColumns` / `rosterStatLine`) every roster row
 * renders — the column LIST (scope × metric, order included) follows the
 * stats prefs' overlayColumns, and each column's numbers resolve through
 * its own scope over the panel-wide battle mode (utils/statView).
 *
 * Masking state is deliberately per-view and ephemeral — it is a share-time
 * privacy choice, not a preference. The fixed-width mask is NOT
 * length-preserving: a nick's length is itself information.
 */
import { defineComponent, ref, type PropType, type VNode } from "vue";
import { Camera, Eye, EyeOff, Rows2, Rows3 } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  statsPrefsState,
  type OverlayColumnMetric,
  type OverlayColumnScope,
} from "@/stores/statsPrefs";
import {
  battlesColor,
  damageColor,
  prTier,
  winrateColor,
} from "@/utils/winrate";
import { rosterStatView, type RosterModeNumbers } from "@/utils/statView";
import { isAiName, type RosterStat } from "@/composables/useRosterStats";
import { shareFooterStrings } from "@/features/share/shotKit";
import { useShareImage } from "@/features/share/useShareImage";
import LiveStatsModeChip from "./LiveStatsModeChip";
import { renderPostBattleShot, type ShotModel, type ShotStat } from "./postBattleShot";
import "./postBattleShare.scss";

/** Display replacement for a hidden nickname (fixed width, see header). */
export const NICK_MASK = "••••••";

/** Nickname masking state for one masked view (a post-battle modal, or the
 *  live panel's head actions). `hideAll` masks every nick; per-name toggles
 *  ride on top and persist across hide-all flips. */
export function useNickMasking() {
  const hideAll = ref(false);
  const hiddenNames = ref(new Set<string>());
  const isHidden = (name: string) =>
    hideAll.value || hiddenNames.value.has(name);
  function toggleAll() {
    hideAll.value = !hideAll.value;
  }
  function toggleOne(name: string) {
    // Replace the Set so Vue's reactivity sees the change (Set mutation in
    // place would not trigger the render).
    const next = new Set(hiddenNames.value);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    hiddenNames.value = next;
  }
  /** Row display name: the mask when hidden, the raw nick otherwise. */
  const maskOf = (name: string) => (isHidden(name) ? NICK_MASK : name);
  return { hideAll, hiddenNames, isHidden, toggleAll, toggleOne, maskOf };
}

/** Copy flow for the post-battle share shot: renders the model off-DOM via
 *  the shared copy pipeline, with the shot kit's localized watermark footer. */
export function useShareShot(getModel: () => ShotModel, getEl: () => HTMLElement | null) {
  return useShareImage(async () =>
    renderPostBattleShot(getModel(), { el: getEl(), ...shareFooterStrings() }),
  );
}

/** One configured roster-stat column of a roster row — the prefs'
 *  scope × metric pair dressed for render (labels, fixed track width).
 *  The LIST (order included) comes straight off the stats prefs, so every
 *  surface — compact rows, aggregate headers, full-card strips, share
 *  shots — renders the identical column set. */
export interface RosterColumnSpec {
  /** Stable `${scope}:${metric}` id (keys React-style lists, keys the
   *  shot aggregate's column origins). */
  id: string;
  scope: OverlayColumnScope;
  metric: OverlayColumnMetric;
  /** Full tooltip label ("仅单排 · 胜率"). */
  title: string;
  /** Compact header label ("单排胜率" — the bare metric when global). */
  head: string;
  /** Fixed ch track so the columns align across rows: the aggregate
   *  header grids mirror the template AND the compact cells take it as
   *  their min-width — one width source, so each header label lands
   *  exactly on its own column; scoped columns widen for their scope
   *  tag. */
  width: string;
}

/** Metric → the fixed track's base width (the value cells' ch widths the
 *  mono faces pin). */
const METRIC_WIDTH: Record<OverlayColumnMetric, string> = {
  winrate: "6.5ch",
  pr: "5ch",
  battles: "7ch",
  damage: "7.5ch",
};

const COLUMN_MOD: Record<OverlayColumnMetric, string> = {
  winrate: "wr",
  pr: "pr",
  battles: "battles",
  damage: "dmg",
};

/** Short scope tag for compact labels ("单排" — global carries none: the
 *  unmarked column IS the account career). */
const SCOPE_TAG_KEY: Partial<Record<OverlayColumnScope, string>> = {
  solo: "replay.roster.scopeTagSolo",
  ship: "replay.roster.scopeTagShip",
  shipSolo: "replay.roster.scopeTagShipSolo",
  class: "replay.roster.scopeTagClass",
};

/** Short metric word for compact labels (胜率 / PR / 场次 / 场均). */
const METRIC_KEY: Record<OverlayColumnMetric, string> = {
  winrate: "replay.roster.metricWinrate",
  pr: "replay.roster.metricPr",
  battles: "replay.roster.metricBattles",
  damage: "replay.roster.metricDamage",
};

/** Full scope name for tooltips (全局（账号） / 仅单排（账号） / 仅单船（本船）
 *  / 仅单船单排（本船） / 仅当前舰种). */
const SCOPE_FULL_KEY: Record<OverlayColumnScope, string> = {
  global: "replay.roster.scopeGlobal",
  solo: "replay.roster.scopeSolo",
  ship: "replay.roster.scopeShip",
  shipSolo: "replay.roster.scopeShipSolo",
  class: "replay.roster.scopeClass",
};

/** The configured roster-stat columns in render order, off the stats
 *  prefs' overlayColumns (PR columns additionally gate on the PR master
 *  switch). Every compact roster row and every aggregate header builds
 *  off this ONE list, so the settings' column editor moves columns and
 *  headers together — both rosters read it in the SAME left→right order
 *  (the live panel's enemy side no longer mirrors; the in-game Tab
 *  overlay's enemy chips keep their own game-true reversed layout in the
 *  overlay's renderer). */
export function rosterColumns(): RosterColumnSpec[] {
  const prOn = statsPrefsState.value.prEnabled;
  return statsPrefsState.value.overlayColumns
    .filter((c) => c.metric !== "pr" || prOn)
    .map((c) => {
      const tagKey = SCOPE_TAG_KEY[c.scope];
      const tag = tagKey ? t(tagKey) : "";
      const metric = t(METRIC_KEY[c.metric]);
      // CJK tags compound with the metric word (单排胜率); Latin tags
      // take a thin space (Solo WR) so the head never glues two words.
      // Printable ASCII only — the source used to carry raw NUL/DEL bytes
      // in this class, which turned the file binary for every tool.
      const head = tag
        ? /^[\x20-\x7e]+$/.test(tag)
          ? `${tag} ${metric}`
          : `${tag}${metric}`
        : metric;
      return {
        id: `${c.scope}:${c.metric}`,
        scope: c.scope,
        metric: c.metric,
        title: `${t(SCOPE_FULL_KEY[c.scope])} · ${metric}`,
        head,
        width: tag
          ? `calc(${METRIC_WIDTH[c.metric]} + 3ch)`
          : METRIC_WIDTH[c.metric],
      };
    });
}

/** One column's number formatting/coloring. Battles carries the red
 *  thin-sample warning (under 200) on ACCOUNT columns only — `warn` is the
 *  caller's `col.scope === "global"`; a scoped count under 200 is the norm
 *  (most ships never see 200 battles), so red there would flag half the
 *  roster. `empty` marks a null value so the caller can retip the cell for
 *  hidden profiles. */
function rosterColumnCell(
  metric: OverlayColumnMetric,
  view: RosterModeNumbers,
  warn = false,
): { body: VNode; empty: boolean } {
  const v = metric === "damage" ? view.avgDamage : view[metric];
  if (v == null) return { body: <em>—</em>, empty: true };
  if (metric === "battles") {
    const color = warn ? battlesColor(v) : undefined;
    return {
      body: (
        <b style={color ? { color } : undefined}>{Math.round(v).toLocaleString()}</b>
      ),
      empty: false,
    };
  }
  if (metric === "winrate") {
    return { body: <b style={{ color: winrateColor(v) }}>{v.toFixed(1)}%</b>, empty: false };
  }
  if (metric === "pr") {
    return {
      body: <b style={{ color: prTier(v).color }}>{Math.round(v)}</b>,
      empty: false,
    };
  }
  return {
    body: <b style={{ color: damageColor(v) }}>{Math.round(v).toLocaleString()}</b>,
    empty: false,
  };
}

/** The aligned roster-stat columns for one player name — the configured
 *  columns of the player's per-scope stats views (each column resolves
 *  through `viewOf(stat, scope)`; randoms / ranked / global battle scopes
 *  ride the panel-wide pref). A tiny spinner rides while the batch lookup
 *  runs; bots / hidden profiles / lookup misses render a muted "—".
 *  Both rosters read the columns in the same configured order (the live
 *  panel's enemy side no longer mirrors — user feedback). Shared by every
 *  roster row surface: the post-battle results panel, the replay view's
 *  fallback matrix and the live panel's compact mode — one definition,
 *  identical geometry everywhere. */
export function rosterStatCols(
  name: string,
  stats: Map<string, RosterStat>,
  loading: boolean,
  viewOf: (st: RosterStat, scope: OverlayColumnScope) => RosterModeNumbers,
) {
  const ai = isAiName(name);
  const stat = ai ? undefined : stats.get(name);
  const cols = rosterColumns();
  return (
    <>
      {cols.map((col) => {
        let tip = col.title;
        let body;
        if (ai) {
          tip = t("replay.botNote");
          body = <em>—</em>;
        } else if (!stat || loading) {
          body = <HkSpinner size="xs" tone="current" />;
        } else {
          const cell = rosterColumnCell(
            col.metric,
            viewOf(stat, col.scope),
            col.scope === "global",
          );
          body = cell.body;
          if (cell.empty && stat.hidden) tip = t("replay.live.hiddenProfile");
        }
        return (
          <span
            class={`replay-view__postbattle-cell-stat replay-view__postbattle-cell-stat--${COLUMN_MOD[col.metric]}`}
            // The cell mirrors the header grid's track — the class min-width
            // below is the bare metric, so without this the +3ch the scoped
            // header tracks reserve drifts every label left of its column.
            style={{ minWidth: col.width }}
            data-hint={tip}
          >
            {body}
          </span>
        );
      })}
    </>
  );
}

/** The full card's stat text line: the configured columns' numbers inline
 *  (`52.3% WR · 1733 PR · 12,345 场次 · 89.2k 场均`), each resolved
 *  through its own scope, values tier-colored (PR keeps its rainbow 彩表
 *  band; battles renders red under 200, plain above — a count carries no
 *  tier). Scoped columns prefix their short tag ("单船 52.3% WR"). An
 *  enabled number with no value keeps its slot with a bare "—"
 *  placeholder; the line is null when NO column is configured — callers
 *  then render their own "—". Loading / hidden states stay with the
 *  caller (each panel owns its pipeline). */
export function rosterStatLine(viewOf: (scope: OverlayColumnScope) => RosterModeNumbers) {
  const parts: VNode[] = [];
  for (const col of rosterColumns()) {
    const view = viewOf(col.scope);
    const tagKey = SCOPE_TAG_KEY[col.scope];
    const tag = tagKey ? <span class="replay-view__statline-scope">{t(tagKey)}</span> : null;
    const label =
      col.metric === "winrate"
        ? "WR"
        : col.metric === "pr"
          ? "PR"
          : t(METRIC_KEY[col.metric]);
    if (col.metric === "winrate") {
      parts.push(
        <>
          {tag}
          <b
            style={
              view.winrate != null ? { color: winrateColor(view.winrate) } : undefined
            }
          >
            {view.winrate != null ? `${view.winrate.toFixed(1)}%` : "—"}
          </b>{" "}
          {label}
        </>,
      );
    } else if (col.metric === "pr") {
      const tier = prTier(view.pr);
      parts.push(
        <>
          {tag}
          <b
            class={tier.rainbow ? "rainbow-text" : undefined}
            style={tier.rainbow ? undefined : { color: tier.color }}
          >
            {view.pr ?? "—"}
          </b>{" "}
          PR
        </>,
      );
    } else if (col.metric === "battles") {
      // Thin-sample red on the account column only — a scoped count under
      // 200 is the norm, not a warning.
      const color = col.scope === "global" ? battlesColor(view.battles) : undefined;
      parts.push(
        <>
          {tag}
          <b style={color ? { color } : undefined}>
            {view.battles != null ? Math.round(view.battles).toLocaleString() : "—"}
          </b>{" "}
          {t("replay.roster.battles")}
        </>,
      );
    } else {
      parts.push(
        <>
          {tag}
          <b style={view.avgDamage != null ? { color: damageColor(view.avgDamage) } : undefined}>
            {view.avgDamage != null
              ? Math.round(view.avgDamage).toLocaleString()
              : "—"}
          </b>{" "}
          {label}
        </>,
      );
    }
  }
  if (parts.length === 0) return null;
  const line: VNode[] = [];
  parts.forEach((p, i) => {
    if (i > 0) line.push(<>{" · "}</>);
    line.push(p);
  });
  return <>{line}</>;
}

/** Dashed cells for as many columns as are configured — the share-shot face
 *  of a bot row / stats miss (rosterShotCells' counterpart). */
export function rosterShotDashes(): ShotStat[] {
  return rosterColumns().map(() => ({ text: "—" }));
}

/** The configured columns' cells, each resolved through its own scope, in
 *  rosterColumns() order — the share-shot rows render the EXACT columns
 *  the panels show, the account columns' red-under-200 battles warning
 *  included, so the copied image never contradicts the roster on screen
 *  beside the copy button. */
export function rosterShotCells(
  viewOf: (scope: OverlayColumnScope) => RosterModeNumbers,
): ShotStat[] {
  return rosterColumns().map((col) => {
    const view = viewOf(col.scope);
    const v = col.metric === "damage" ? view.avgDamage : view[col.metric];
    if (v == null) return { text: "—" };
    if (col.metric === "battles") {
      const color = col.scope === "global" ? battlesColor(v) : undefined;
      return { text: Math.round(v).toLocaleString(), ...(color ? { color } : {}) };
    }
    if (col.metric === "winrate") {
      return { text: `${v.toFixed(1)}%`, color: winrateColor(v) };
    }
    if (col.metric === "pr") {
      return { text: `${Math.round(v)}`, color: prTier(v).color };
    }
    return { text: Math.round(v).toLocaleString(), color: damageColor(v) };
  });
}

/** Re-exported for the panels' team aggregates: resolve one RosterStat's
 *  display view (randoms / ranked / global). */
export { rosterStatView };

/** Toolbar riding the post-battle panel top: the optional 全员/我的 view
 *  switcher (a segmented pair — hosts without a second view leave it off),
 *  the stats-source chip (the identical selector the live panel's head
 *  carries — one shared statsPrefs store, so a flip here re-resolves the
 *  roster and shows up in the live head / settings immediately), the
 *  hide-all-nicknames toggle (with the per-row eye hint), the optional
 *  roster-density toggle (compact rows ⇄ the live panel's full cards —
 *  rendered only when the host passes the props) and the copy-share-shot
 *  action. In the 我的 view the roster-only controls (stats chip, density,
 *  mask hint) sit out — the camera button then copies the self report.
 *  Shared by the results panel and the incomplete-results fallback so both
 *  post-battle windows expose the same controls. */
export const PostBattleShareBar = defineComponent({
  name: "PostBattleShareBar",
  props: {
    hideAll: { type: Boolean, default: false },
    shotBusy: { type: Boolean, default: false },
    /** Render the density toggle at all (hosts without a full-card mode —
     *  the fallback matrix — leave it off). */
    showModeToggle: { type: Boolean, default: false },
    /** Current density for the toggle: true = full cards, false = compact
     *  rows. The button always offers the switch TO the other mode. */
    fullMode: { type: Boolean, default: false },
    /** The active view when the host carries both (the roster matrix + the
     *  self report): renders the segmented 全员/我的 switcher up front and
     *  trims the toolbar to the controls that view honors. */
    view: {
      type: String as PropType<"roster" | "self" | undefined>,
      default: undefined,
    },
  },
  emits: ["toggleAll", "shot", "toggleMode", "setView"],
  setup(props, { emit }) {
    return () => {
      // Re-read per render: the view flips at toolbar level, the captured
      // value would go stale after the first switch.
      const isSelf = props.view === "self";
      return (
      <div class="replay-view__postbattle-toolbar">
        {props.view ? (
          <span class="replay-view__postbattle-viewswitch" role="tablist">
            <button
              class={[
                "replay-view__postbattle-viewswitch-btn",
                { "replay-view__postbattle-viewswitch-btn--on": !isSelf },
              ]}
              type="button"
              role="tab"
              aria-selected={!isSelf}
              onClick={() => emit("setView", "roster")}
            >
              {t("replay.postbattle.viewAll")}
            </button>
            <button
              class={[
                "replay-view__postbattle-viewswitch-btn",
                { "replay-view__postbattle-viewswitch-btn--on": isSelf },
              ]}
              type="button"
              role="tab"
              aria-selected={isSelf}
              onClick={() => emit("setView", "self")}
            >
              {t("replay.postbattle.viewSelf")}
            </button>
          </span>
        ) : null}
        {/* Stats-source filter: ship/battle/solo dimensions, the same chip
            the live head mounts — the roster rows below already resolve
            through the shared prefs, so flips apply without host wiring.
            The self report reads no career stats; the chip sits out there. */}
        {!isSelf ? <LiveStatsModeChip /> : null}
        <button
          class={[
            "replay-view__postbattle-tool",
            { "replay-view__postbattle-tool--on": props.hideAll },
          ]}
          type="button"
          onClick={() => emit("toggleAll")}
        >
          {props.hideAll ? <Eye size={13} /> : <EyeOff size={13} />}
          {props.hideAll
            ? t("replay.postbattle.showAll")
            : t("replay.postbattle.hideAll")}
        </button>
        {!isSelf ? (
          <span class="replay-view__postbattle-toolbar-hint">
            {t("replay.postbattle.maskHint")}
          </span>
        ) : null}
        {props.showModeToggle && !isSelf ? (
          <button
            class={[
              "replay-view__postbattle-tool",
              { "replay-view__postbattle-tool--on": props.fullMode },
            ]}
            type="button"
            onClick={() => emit("toggleMode")}
          >
            {/* Icon + label show the mode a click switches TO — Rows2 = the
                compact two-line row, Rows3 = the full three-line card. */}
            {props.fullMode ? <Rows2 size={13} /> : <Rows3 size={13} />}
            {props.fullMode
              ? t("replay.roster.compactMode")
              : t("replay.roster.fullMode")}
          </button>
        ) : null}
        <button
          class="replay-view__postbattle-tool replay-view__postbattle-tool--shot"
          type="button"
          disabled={props.shotBusy}
          onClick={() => emit("shot")}
        >
          {props.shotBusy ? <HkSpinner size="xs" tone="current" /> : <Camera size={13} />}
          {t("share.copyShot")}
        </button>
      </div>
      );
    };
  },
});
