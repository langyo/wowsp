/**
 * Sharing + shared-row utilities for the post-battle panels (replay 结果
 * modal and the incomplete-results fallback matrix) and the live battle
 * panel: nickname masking (hide all / hide single players), the "copy share
 * shot" flow that renders the matrix to a watermarked PNG and pushes it onto
 * the system clipboard (the copy flow itself lives in the shared share kit —
 * features/share/useShareImage.ts), and the aligned roster-stat columns
 * (`rosterStatCols` / `rosterColumns` / `rosterStatLine`) every roster row
 * renders — which columns appear follows the stats prefs' chip toggles, and
 * the numbers themselves follow the stats-source mode (utils/statView).
 *
 * Masking state is deliberately per-view and ephemeral — it is a share-time
 * privacy choice, not a preference. The fixed-width mask is NOT
 * length-preserving: a nick's length is itself information.
 */
import { defineComponent, ref, type VNode } from "vue";
import { Camera, Eye, EyeOff, Rows2, Rows3 } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { statsPrefsState } from "@/stores/statsPrefs";
import {
  battlesColor,
  damageColor,
  prTier,
  winrateColor,
} from "@/utils/winrate";
import {
  EMPTY_ROSTER_VIEW,
  rosterStatView,
  type RosterModeNumbers,
} from "@/utils/statView";
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

/** The default view resolver: the randoms career (the pre-mode behavior). */
const randomsView = (st: RosterStat): RosterModeNumbers => ({
  winrate: st.winrate,
  pr: st.pr,
  battles: st.battles,
  avgDamage: st.avgDamage,
});

/** One enabled career-stat column of a roster row. */
export interface RosterColumnSpec {
  key: "winrate" | "pr" | "battles" | "damage";
  /** Column header / tooltip label. */
  title: string;
  /** Fixed ch track so the columns align across rows (and the aggregate
   *  header grids can mirror the template). */
  width: string;
}

/** The enabled career-stat columns in render order, per the stats prefs'
 *  chip toggles (+ the PR master switch on the PR column). Every compact
 *  roster row and every aggregate header builds off this ONE list, so the
 *  toggles move columns and headers together. */
export function rosterColumns(): RosterColumnSpec[] {
  const chips = statsPrefsState.value.overlayChips;
  const out: RosterColumnSpec[] = [];
  if (chips.winrate) {
    out.push({
      key: "winrate",
      title: t("replay.postbattle.winrate"),
      width: "6.5ch",
    });
  }
  if (chips.pr && statsPrefsState.value.prEnabled) {
    out.push({ key: "pr", title: "PR", width: "5ch" });
  }
  if (chips.battles) {
    out.push({ key: "battles", title: t("replay.roster.battles"), width: "7ch" });
  }
  if (chips.damage) {
    out.push({
      key: "damage",
      title: t("replay.postbattle.avgDamage"),
      width: "7.5ch",
    });
  }
  return out;
}

/** One column's number formatting/coloring (battles: red under 200 battles,
 *  plain above — a count carries no tier color). `empty` marks a null
 *  value so the caller can retip the cell for hidden profiles. */
function rosterColumnCell(
  key: RosterColumnSpec["key"],
  view: RosterModeNumbers,
): { body: VNode; empty: boolean } {
  const v = key === "damage" ? view.avgDamage : view[key];
  if (v == null) return { body: <em>—</em>, empty: true };
  if (key === "battles") {
    const color = battlesColor(v);
    return {
      body: (
        <b style={color ? { color } : undefined}>{Math.round(v).toLocaleString()}</b>
      ),
      empty: false,
    };
  }
  if (key === "winrate") {
    return { body: <b style={{ color: winrateColor(v) }}>{v.toFixed(1)}%</b>, empty: false };
  }
  if (key === "pr") {
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

const COLUMN_MOD: Record<RosterColumnSpec["key"], string> = {
  winrate: "wr",
  pr: "pr",
  battles: "battles",
  damage: "dmg",
};

/** The aligned roster-stat columns for one player name — the chip-enabled
 *  columns of the player's resolved stats-source view (randoms / ranked /
 *  global — pass a `viewOf` resolver; the default reads the randoms
 *  career). A tiny spinner rides while the batch lookup runs; bots /
 *  hidden profiles / lookup misses render a muted "—". Shared by every
 *  roster row surface: the post-battle results panel, the replay view's
 *  fallback matrix and the live panel's compact mode — one definition,
 *  identical geometry everywhere. */
export function rosterStatCols(
  name: string,
  stats: Map<string, RosterStat>,
  loading: boolean,
  viewOf: (st: RosterStat) => RosterModeNumbers = randomsView,
) {
  const ai = isAiName(name);
  const stat = ai ? undefined : stats.get(name);
  const view = stat ? viewOf(stat) : EMPTY_ROSTER_VIEW;
  return (
    <>
      {rosterColumns().map((col) => {
        let tip = col.title;
        let body;
        if (ai) {
          tip = t("replay.botNote");
          body = <em>—</em>;
        } else if (!stat || loading) {
          body = <HkSpinner size="xs" tone="current" />;
        } else {
          const cell = rosterColumnCell(col.key, view);
          body = cell.body;
          if (cell.empty && stat.hidden) tip = t("replay.live.hiddenProfile");
        }
        return (
          <span
            class={`replay-view__postbattle-cell-stat replay-view__postbattle-cell-stat--${COLUMN_MOD[col.key]}`}
            data-hint={tip}
          >
            {body}
          </span>
        );
      })}
    </>
  );
}

/** The full card's stat text line: the chip-enabled numbers of one resolved
 *  view inline (`52.3% WR · 1733 PR · 12,345 场次`), values tier-colored
 *  (PR keeps its rainbow 彩表 band; battles renders red under 200, plain
 *  above — a count carries no tier). An enabled number with no value keeps
 *  its slot with a bare "—" placeholder (the compact columns' face); the
 *  line is null when none of the winrate / PR / battles chips is on (avg
 *  damage is a column, not part of the text line) — callers then render
 *  their own "—". Loading / hidden states stay with the caller (each panel
 *  owns its pipeline). */
export function rosterStatLine(view: RosterModeNumbers) {
  const chips = statsPrefsState.value.overlayChips;
  const parts: VNode[] = [];
  if (chips.winrate) {
    parts.push(
      <>
        <b
          style={
            view.winrate != null ? { color: winrateColor(view.winrate) } : undefined
          }
        >
          {view.winrate != null ? `${view.winrate.toFixed(1)}%` : "—"}
        </b>{" "}
        WR
      </>,
    );
  }
  if (chips.pr && statsPrefsState.value.prEnabled) {
    const tier = prTier(view.pr);
    parts.push(
      <>
        <b
          class={tier.rainbow ? "rainbow-text" : undefined}
          style={tier.rainbow ? undefined : { color: tier.color }}
        >
          {view.pr ?? "—"}
        </b>{" "}
        PR
      </>,
    );
  }
  if (chips.battles) {
    const color = battlesColor(view.battles);
    parts.push(
      <>
        <b style={color ? { color } : undefined}>
          {view.battles != null ? Math.round(view.battles).toLocaleString() : "—"}
        </b>{" "}
        {t("replay.roster.battles")}
      </>,
    );
  }
  if (parts.length === 0) return null;
  const line: VNode[] = [];
  parts.forEach((p, i) => {
    if (i > 0) line.push(<>{" · "}</>);
    line.push(p);
  });
  return <>{line}</>;
}

/** Dashed cells for as many columns as are enabled — the share-shot face
 *  of a bot row / stats miss (rosterShotCells' counterpart). */
export function rosterShotDashes(): ShotStat[] {
  return rosterColumns().map(() => ({ text: "—" }));
}

/** The chip-gated career-stat cells of one resolved view, in
 *  rosterColumns() order — the share-shot rows render the EXACT columns
 *  the panels show, battles red-under-200 warning included, so the copied
 *  image never contradicts the roster on screen beside the copy button. */
export function rosterShotCells(view: RosterModeNumbers): ShotStat[] {
  return rosterColumns().map((col) => {
    const v = col.key === "damage" ? view.avgDamage : view[col.key];
    if (v == null) return { text: "—" };
    if (col.key === "battles") {
      const color = battlesColor(v);
      return { text: Math.round(v).toLocaleString(), ...(color ? { color } : {}) };
    }
    if (col.key === "winrate") {
      return { text: `${v.toFixed(1)}%`, color: winrateColor(v) };
    }
    if (col.key === "pr") {
      return { text: `${Math.round(v)}`, color: prTier(v).color };
    }
    return { text: Math.round(v).toLocaleString(), color: damageColor(v) };
  });
}

/** Column index of one stat key within the enabled rosterColumns() — the
 *  share-shot aggregate entries right-align their values onto it. */
export function rosterShotColIndex(key: RosterColumnSpec["key"]): number {
  return rosterColumns().findIndex((c) => c.key === key);
}

/** Re-exported for the panels' team aggregates: resolve one RosterStat's
 *  display view (randoms / ranked / global). */
export { rosterStatView };

/** Toolbar riding the post-battle panel top: the stats-source chip (the
 *  identical selector the live panel's head carries — one shared statsPrefs
 *  store, so a flip here re-resolves the roster and shows up in the live
 *  head / settings immediately), the hide-all-nicknames toggle (with the
 *  per-row eye hint), the optional roster-density toggle (compact rows ⇄
 *  the live panel's full cards — rendered only when the host passes the
 *  props) and the copy-share-shot action. Shared by the results panel and
 *  the incomplete-results fallback so both post-battle windows expose the
 *  same controls. */
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
  },
  emits: ["toggleAll", "shot", "toggleMode"],
  setup(props, { emit }) {
    return () => (
      <div class="replay-view__postbattle-toolbar">
        {/* Stats-source filter: ship/battle/solo dimensions, the same chip
            the live head mounts — the rows below already resolve through
            the shared prefs, so flips apply without host wiring. */}
        <LiveStatsModeChip />
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
        <span class="replay-view__postbattle-toolbar-hint">
          {t("replay.postbattle.maskHint")}
        </span>
        {props.showModeToggle ? (
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
  },
});
