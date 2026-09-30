/**
 * Sharing + shared-row utilities for the post-battle panels (replay 结果
 * modal and the incomplete-results fallback matrix) and the live battle
 * panel: nickname masking (hide all / hide single players), the "copy share
 * shot" flow that renders the matrix to a watermarked PNG and pushes it onto
 * the system clipboard (the copy flow itself lives in the shared share kit —
 * features/share/useShareImage.ts), and the aligned roster-stat columns
 * (`rosterStatCols`) every compact roster row renders — post-battle rows and
 * the live panel's compact mode share the exact same columns.
 *
 * Masking state is deliberately per-view and ephemeral — it is a share-time
 * privacy choice, not a preference. The fixed-width mask is NOT
 * length-preserving: a nick's length is itself information.
 */
import { defineComponent, ref } from "vue";
import { Camera, Eye, EyeOff, Rows2, Rows3 } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { statsPrefsState } from "@/stores/statsPrefs";
import { damageColor, prTier, winrateColor } from "@/utils/winrate";
import { isAiName, type RosterStat } from "@/composables/useRosterStats";
import { shareFooterStrings } from "@/features/share/shotKit";
import { useShareImage } from "@/features/share/useShareImage";
import { renderPostBattleShot, type ShotModel } from "./postBattleShot";
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

/** The aligned roster-stat columns for one player name — overall winrate, PR
 *  (while the rating pref is on) and avg damage, tier-colored (the XVM-style
 *  level coloring from utils/winrate). A tiny spinner rides while the batch
 *  lookup runs; bots / hidden profiles / lookup misses render a muted "—".
 *  Shared by every compact roster row surface: the post-battle results
 *  panel, the replay view's fallback matrix and the live panel's compact
 *  mode — one definition, identical geometry everywhere. */
export function rosterStatCols(
  name: string,
  stats: Map<string, RosterStat>,
  loading: boolean,
) {
  const ai = isAiName(name);
  const stat = ai ? undefined : stats.get(name);
  const col = (
    mod: string,
    title: string,
    pick: (s: RosterStat) => number | null,
    colorOf: (v: number) => string,
    fmt: (v: number) => string,
  ) => {
    let tip = title;
    let body;
    if (ai) {
      tip = t("replay.botNote");
      body = <em>—</em>;
    } else if (!stat || loading) {
      body = <HkSpinner size="xs" tone="current" />;
    } else {
      const v = pick(stat);
      if (v == null) {
        if (stat.hidden) tip = t("replay.live.hiddenProfile");
        body = <em>—</em>;
      } else {
        body = <b style={{ color: colorOf(v) }}>{fmt(v)}</b>;
      }
    }
    return (
      <span
        class={`replay-view__postbattle-cell-stat ${mod}`}
        data-hint={tip}
      >
        {body}
      </span>
    );
  };
  return (
    <>
      {col(
        "replay-view__postbattle-cell-stat--wr",
        t("replay.postbattle.winrate"),
        (s) => s.winrate,
        winrateColor,
        (v) => `${v.toFixed(1)}%`,
      )}
      {statsPrefsState.value.prEnabled ? (
        col(
          "replay-view__postbattle-cell-stat--pr",
          "PR",
          (s) => s.pr,
          (v) => prTier(v).color,
          (v) => `${Math.round(v)}`,
        )
      ) : null}
      {col(
        "replay-view__postbattle-cell-stat--dmg",
        t("replay.postbattle.avgDamage"),
        (s) => s.avgDamage,
        damageColor,
        (v) => Math.round(v).toLocaleString(),
      )}
    </>
  );
}

/** Toolbar riding the post-battle panel top: hide-all-nicknames toggle (with
 *  the per-row eye hint), the optional roster-density toggle (compact rows ⇄
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
