import { computed, defineComponent, ref, watch, type PropType } from "vue";

import { HkTag } from "@celestia-island/hikari";
import IdentityHead from "@/components/stats/IdentityHead";
import PlayerBadge from "@/components/base/PlayerBadge";
import RatingStamp from "@/components/base/RatingStamp";
import type { PlayerStats } from "@/api";
import { t } from "@/i18n";
import {
  careerStamp,
  damageColor,
  prTier,
  prTierLabel,
  winrateColor,
  winrateTier,
} from "@/utils/winrate";
import { lookupClanWinrate } from "@/utils/clanWinrate";
import { useLanguage } from "@/i18n/useLanguage";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { useCompositionStamps } from "@/composables/useCompositionStamps";
import { useClipboard } from "@/composables/useClipboard";
import "./StatsCard.scss";

/**
 * Deep-stats card modeled on ApeRadar's layout:
 *   ┌─ identity: name + clan tag + realm + hidden badge ─
 *   ├─ PR summary bar: big PR number + tier label, color-coded
 *   ├─ KPI grid: winrate / battles / avg damage / avg XP / K-D / survival
 *   └─ division split: solo / div2 / div3 / ranked winrates (when present)
 *
 * Color coding (mirrors community convention):
 *   red < 47% → yellow 47-50% → green 50-55% → purple > 55%.
 */
export default defineComponent({
  name: "StatsCard",
  props: {
    stats: { type: Object as () => PlayerStats, required: true },
    /** Combined ranked winrate across the loaded seasons (null = unknown). */
    rankedWr: { type: Number as PropType<number | null>, default: null },
    /** Combined ranked battles across the loaded seasons (null = unknown). */
    rankedBattles: { type: Number as PropType<number | null>, default: null },
    /** Clan tag clicked → jump to the clan view. Rendered as a link only
     *  when the stats carry a clan id. */
    onClanClick: Function as PropType<() => void>,
  },
  setup(props) {
    const prefs = useStatsPrefsStore();
    const pr = computed(() => prTier(props.stats.pr));
    // Localized fun wording (夯/人上人…) or the standard English band word,
    // per the stats prefs (see prTierLabel).
    const prLabel = computed(() => prTierLabel(pr.value.key));
    // ── Hidden-profile clan gate ──
    // The 过街老鼠 stamp waits for the player's clan winrate: a clan beating
    // RAT_CLAN_WINRATE_MAX excuses the hidden profile. Tri-state ref:
    // undefined = verdict in flight, number | null = resolved (null = the
    // lookup failed → fail-open stamp).
    const clanWinrate = ref<number | null | undefined>(undefined);
    // Generation guard: only the lookup fired for the LATEST (clanId, realm)
    // pair may write the ref back — a fast string of lookups must not let a
    // stale response win.
    let clanGen = 0;
    watch(
      () => [props.stats.clanId, props.stats.realm] as const,
      ([clanId, realm]) => {
        const gen = ++clanGen;
        if (clanId == null) {
          // No clan to query — a terminal "no verdict needed" state, so a
          // clanless hidden profile stamps at once instead of waiting.
          clanWinrate.value = null;
          return;
        }
        clanWinrate.value = undefined;
        void lookupClanWinrate(realm, clanId).then((wr) => {
          if (gen !== clanGen) return;
          clanWinrate.value = wr;
        });
      },
      { immediate: true },
    );
    const stamp = computed(() => {
      const s = props.stats;
      // A hidden profile with a clan holds its stamp until the clan verdict
      // lands (undefined) — the gate must never flash 老鼠 first and retract
      // it a beat later; clanless hidden profiles stamp immediately.
      if (s.hidden && s.clanId != null && clanWinrate.value === undefined) return null;
      return careerStamp(s.pr, s.battles, s.winrate, s.hidden, clanWinrate.value);
    });
    /** 成分 tags (空中小人 / 水下小人) from the shared per-ship cache — the
     *  same lookup flow that fills the ship distribution below this card. */
    const composition = useCompositionStamps(
      () => props.stats.accountId,
      () => props.stats.realm,
    );
    // The seals render nothing outside zh locales (RatingStamp's own rule),
    // while the PR rating is off (the seals toggle is the master switch's
    // sub-control in settings — off master, no seals), nor when the user
    // turned them off — three AND-composed gates; gating the cluster too
    // keeps non-zh / no-seal heroes from growing an empty slot.
    const { uiLocale } = useLanguage();
    const sealsVisible = computed(
      () =>
        uiLocale.value.startsWith("zh") &&
        prefs.prefs.prEnabled &&
        prefs.prefs.sealsEnabled,
    );
    const wrTier = computed(() => winrateTier(props.stats.winrate));
    const wrColor = computed(() => winrateColor(props.stats.winrate));
    const { copy } = useClipboard();

    const kpis = computed(() => {
      const s = props.stats;
      // Any real battle deals damage — a zero with battles played is broken
      // data, flagged with the same anomaly text as the ship modal's KPI
      // strip (stats.dataAnomaly, red) instead of an implausible 0.
      const damageAnomaly =
        s.battles != null && s.battles > 0 && s.avgDamage != null && s.avgDamage <= 0;
      return [
        {
          label: t("stats.battles"),
          value: s.battles != null ? s.battles.toLocaleString() : "—",
        },
        {
          label: t("stats.avgDamage"),
          value: damageAnomaly
            ? t("stats.dataAnomaly")
            : s.avgDamage != null
              ? Math.round(s.avgDamage).toLocaleString()
              : "—",
          color: damageAnomaly ? damageColor(0) : undefined,
        },
        {
          label: t("stats.avgExp"),
          value: s.avgXp != null ? Math.round(s.avgXp).toLocaleString() : "—",
        },
        {
          label: t("stats.kdRatio"),
          value: s.kdRatio != null ? s.kdRatio.toFixed(2) : "—",
        },
        {
          label: t("stats.survivalRate"),
          value: s.survivalRate != null ? `${s.survivalRate.toFixed(0)}%` : "—",
        },
        {
          label: t("stats.hitRate"),
          value: s.hitRate != null ? `${s.hitRate.toFixed(0)}%` : "—",
        },
      ];
    });

    /** "场次: 12,345" tooltip body for a split (null = count unknown —
     *  cache files written before the counts were added carry none). */
    const battlesHint = (battles: number | null | undefined) =>
      battles != null ? `${t("stats.battles")}: ${battles.toLocaleString()}` : null;

    /** Division splits: solo / div2 / div3 / ranked winrates. Ranked is fed
     *  from the ranked store via the `rankedWr` prop (null = no data).
     *  Displayed in a compact row below the main winrate; the tooltip on
     *  each slot names how many battles the split is built from. */
    const divisions = computed<{ label: string; wr: number | null; hint?: string | null }[]>(() => [
      {
        label: t("stats.solo"),
        wr: props.stats.soloWr ?? null,
        hint: battlesHint(props.stats.soloBattles),
      },
      {
        label: t("stats.div2"),
        wr: props.stats.div2Wr ?? null,
        hint: battlesHint(props.stats.div2Battles),
      },
      {
        label: t("stats.div3"),
        wr: props.stats.div3Wr ?? null,
        hint: battlesHint(props.stats.div3Battles),
      },
      {
        label: t("stats.ranked"),
        wr: props.rankedWr,
        hint: [t("stats.rankedHint"), battlesHint(props.rankedBattles)]
          .filter(Boolean)
          .join(" · "),
      },
    ]);

    return () => (
      <div class={["stats-card", `stats-card--${wrTier.value}`]}>
        {/* identity header */}
        <IdentityHead
          name={props.stats.name}
          tag={props.stats.clanTag}
          onTagClick={
            props.onClanClick && props.stats.clanId != null
              ? () => props.onClanClick?.()
              : undefined
          }
          v-slots={{
            avatar: () => (
              <PlayerBadge
                tier={props.stats.levelingTier ?? 0}
                dogTag={props.stats.dogTag ?? null}
                size={36}
              />
            ),
            badges: () => (
              <>
                <HkTag variant="default" size="sm">{props.stats.realm.toUpperCase()}</HkTag>
                {props.stats.hidden ? (
                  <HkTag variant="danger" size="sm">{t("stats.hidden")}</HkTag>
                ) : null}
              </>
            ),
          }}
        />

        {/* ── Main winrate + PR bar ──
            Big winrate on the left, PR on the right (same row).
            Below: total battles as small text.
            Below that: 4 division winrates in a compact centered row. */}
        <div class="stats-card__hero">
          <div class="stats-card__hero-main">
            <span
              class="stats-card__wr"
              style={wrColor.value ? { color: wrColor.value } : undefined}
              onClick={() => copy(String(props.stats.winrate?.toFixed(1) ?? "—"), t("common.copied"))}
              data-hint={`${t("stats.winrate")} · ${t("common.clickToCopy")}`}
            >
              {props.stats.winrate != null ? `${props.stats.winrate.toFixed(1)}%` : "—"}
            </span>
            <span class="stats-card__wr-label">{t("stats.winrate")}</span>
            <span
              class="stats-card__battles-total"
              onClick={() => copy(String(props.stats.battles ?? "—"), t("common.copied"))}
              data-hint={`${t("stats.battles")} · ${t("common.clickToCopy")}`}
            >
              {props.stats.battles != null ? `${props.stats.battles.toLocaleString()} ${t("stats.battles")}` : "—"}
            </span>
          </div>
          {sealsVisible.value &&
          (stamp.value || composition.value.air || composition.value.sub) ? (
            <div class="stats-card__stamps">
              {stamp.value ? (
                <RatingStamp class="stats-card__stamp" kind={stamp.value} size={58} />
              ) : null}
              {composition.value.air ? (
                <RatingStamp class="stats-card__stamp" kind="air" size={58} />
              ) : null}
              {composition.value.sub ? (
                <RatingStamp class="stats-card__stamp" kind="sub" size={58} />
              ) : null}
            </div>
          ) : null}
          {/* PR block — hidden entirely while the rating is off (opt-out
              look); the hero keeps the winrate + seals layout. */}
          {prefs.prefs.prEnabled ? (
            <div
              class={["stats-card__pr-block", pr.value.rainbow ? "rainbow-text" : null]}
              style={pr.value.rainbow ? undefined : { color: pr.value.color }}
              onClick={() => copy(String(props.stats.pr ?? "—"), t("common.copied"))}
              data-hint={`PR: ${props.stats.pr ?? "—"} (${prLabel.value}) · ${t("common.clickToCopy")}`}
            >
              <span class="stats-card__pr-num">
                {props.stats.pr != null ? props.stats.pr.toLocaleString() : "—"}
              </span>
              <span class="stats-card__pr-label">{prLabel.value}</span>
            </div>
          ) : null}
        </div>

        {/* Division splits: 4 columns centered (solo / div2 / div3 / ranked) */}
        {divisions.value.some((d) => d.wr != null) ? (
          <div class="stats-card__divisions">
            {divisions.value.map((d) => (
              <div class="stats-card__division" key={d.label}>
                <span
                  class="stats-card__division-wr"
                  style={d.wr != null ? { color: winrateColor(d.wr) } : undefined}
                  data-hint={d.hint}
                >
                  {d.wr != null ? `${d.wr.toFixed(1)}%` : "—"}
                </span>
                <span class="stats-card__division-label">{d.label}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* KPI grid (battles/damage/exp/kd/survival/hitRate — no WR or PR,
            those are in the hero bar above) */}
        <div class="stats-card__kpis">
          {kpis.value.map((k) => (
            <div
              class={["stats-card__kpi", "stats-card__kpi--copyable"]}
              onClick={() => copy(String(k.value), t("common.copied"))}
              data-hint={`${k.label}: ${k.value} · ${t("common.clickToCopy")}`}
            >
              <span class="stats-card__kpi-label">{k.label}</span>
              <span
                class="stats-card__kpi-value"
                style={k.color ? { color: k.color } : undefined}
              >
                {k.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  },
});
