/**
 * Shared 我的战绩 report body — the personal battle report BOTH hosts
 * render: the live panel (实时对局) and the replay results modal's "我的"
 * view. Self identity card, summary tiles, the damage-composition strip
 * (server-truth per-weapon split), achievements + ribbons, then the two
 * damage ledgers whose rows each spell out their own weapon composition.
 *
 * Pure display over a SelfStatsModel — hosts own their heads, share
 * buttons, masking state and scroll containers. Styling lives in
 * SelfReportBody.scss (the flat .live-self__* classes moved here from
 * LiveSelfPanel.scss so both hosts wear the exact same look).
 */
import { defineComponent, type PropType } from "vue";
import { Skull } from "@lucide/vue";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import BattleIcon from "@/components/base/BattleIcon";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import ribbonNamesRaw from "@/data/ribbon_names.json";
import { damageColor } from "@/utils/winrate";
import type { SelfCombatRow, SelfStatsModel } from "./liveSelfStats";
import {
  foldAchievementsOf,
  fmtClock,
  globalCompOf,
  selfRowViewOf,
  selfTilesOf,
} from "./selfReportView";
import "./SelfReportBody.scss";

const ribbonNames = ribbonNamesRaw as Record<string, Partial<Record<string, string>>>;

/** Achievement grade families → chip tint (the name bundle's `type`). */
const ACH_GRADE_CLASS: Record<string, string> = {
  heroic: "heroic",
  honorable: "honorable",
  service_medal: "service",
  squad: "squad",
};

export default defineComponent({
  name: "SelfReportBody",
  props: {
    model: { type: Object as () => SelfStatsModel | null, default: null },
    /** The host's nickname resolver — share-time masking stays a host
     *  concern (the live head's toggle and the modal's bar each drive
     *  their own instance). */
    maskOf: {
      type: Function as PropType<(name: string) => string>,
      required: true,
    },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();

    /** One damage-ledger row card: icon + nick/ship stack (+ per-weapon
     *  composition chips) + damage figure + kill marker + the share bar. */
    const rowCard = (row: SelfCombatRow) => {
      const v = selfRowViewOf(row, dataLanguage.value, props.maskOf);
      const share =
        v.maxHp && v.maxHp > 0 ? Math.min(100, (v.damage / v.maxHp) * 100) : null;
      return (
        <div
          class={["live-self__crow", { "live-self__crow--sunk": v.killed || v.hpRatio === 0 }]}
          key={`${row.entityId}-${row.playerId ?? ""}-${v.lastAt}`}
        >
          <span class="live-self__crow-ico">
            {v.shipType ? <BattleIcon type={v.shipType} variant={v.iconVariant} size={20} /> : null}
          </span>
          <span class="live-self__crow-main">
            <span class="live-self__crow-name">
              <span class="live-self__crow-nick">{v.nick}</span>
              {v.bot ? <em class="live-self__crow-bot">{t("replay.bot")}</em> : null}
              {v.killed ? (
                <span class="live-self__crow-kill" data-hint={t("replay.live.selfKillHint")}>
                  <Skull size={12} />
                </span>
              ) : null}
            </span>
            <span class="live-self__crow-ship">
              {v.shipName || "—"}
              {v.lastAt > 0 ? (
                <span class="live-self__crow-at">{fmtClock(v.lastAt)}</span>
              ) : null}
            </span>
            {v.compChips.length > 0 ? (
              <span class="live-self__crow-comp">
                {v.compChips.map((c) => (
                  <span
                    key={c.key}
                    class={`live-self__comp-chip live-self__comp-chip--${c.key}`}
                  >
                    {c.label} <b>{c.text}</b>
                  </span>
                ))}
              </span>
            ) : null}
          </span>
          <span class="live-self__crow-right">
            {share != null ? (
              <span class="live-self__crow-bar">
                <i style={{ width: `${share.toFixed(1)}%` }} />
              </span>
            ) : null}
            <b class="live-self__crow-dmg" style={{ color: damageColor(v.damage) }}>
              {v.damage.toLocaleString()}
            </b>
          </span>
        </div>
      );
    };

    return () => {
      const m = props.model;
      if (!m) return null;
      const lang = dataLanguage.value;
      const maskOf = props.maskOf;

      const selfShipName =
        m.selfShipId != null ? (shipNameFromOfflineDb(m.selfShipId, lang) ?? "") : "";
      const selfShipType =
        m.selfShipId != null ? (shipOfflineEntry(m.selfShipId)?.type ?? null) : null;

      const tiles = selfTilesOf(m);
      const compChips = globalCompOf(m);

      // Achievement chips with duplicates folded (name ×n), grade kept
      // from the last duplicate for the tint.
      const gradeOf = new Map((m.achievements ?? []).map((a) => [a.name, a.grade]));
      const achChips = foldAchievementsOf(m).map((a) => ({
        ...a,
        grade: gradeOf.get(a.name) ?? "",
      }));

      return (
        <>
          {/* Self identity + hull state — the game results screen's
              page-1 headline. */}
          <div class="live-self__card">
            <span class="live-self__card-ico">
              {selfShipType ? (
                <BattleIcon type={selfShipType} variant="white" size={22} />
              ) : null}
            </span>
            <div class="live-self__card-main">
              <span class="live-self__card-name">
                {maskOf(m.selfName ?? "")}
                {m.sunk ? (
                  <em class="live-self__card-sunk">{t("replay.live.selfSunk")}</em>
                ) : null}
              </span>
              <span class="live-self__card-ship">{selfShipName || "—"}</span>
            </div>
            <div class="live-self__card-hp">
              <span class="live-self__card-hp-bar">
                <i
                  class={{ "is-sunk": m.sunk }}
                  style={{ width: `${(m.hpRatio ?? 0).toFixed(1)}%` }}
                />
              </span>
              <span class="live-self__card-hp-num">
                {m.hpRatio != null ? `${Math.round(m.hpRatio)}%` : "—"}
              </span>
            </div>
            {m.final?.killerName ? (
              <span class="live-self__card-killer">
                {t("replay.live.selfKiller", { name: maskOf(m.final.killerName) })}
              </span>
            ) : null}
          </div>

          {/* Summary tiles (damage / plane damage / hits / taken / frags —
              exp once final). */}
          <div class="live-self__tiles">
            {tiles.map((x) => (
              <div class="live-self__tile" key={x.label}>
                <span class="live-self__tile-label">{x.label}</span>
                <b class="live-self__tile-value" style={x.color ? { color: x.color } : undefined}>
                  {x.value}
                </b>
              </div>
            ))}
          </div>

          {/* Damage composition (伤害组成): the server's per-weapon split
              as one proportional strip + labeled chips. */}
          {compChips.length > 0 ? (
            <div class="live-self__comp">
              <span class="live-self__comp-title">{t("replay.live.selfCompTitle")}</span>
              <span class="live-self__comp-bar">
                {compChips.map((c) => (
                  <i
                    key={c.key}
                    class={`live-self__comp-seg live-self__comp-seg--${c.key}`}
                    style={{ width: `${(c.share * 100).toFixed(1)}%` }}
                  />
                ))}
              </span>
              <span class="live-self__comp-chips">
                {compChips.map((c) => (
                  <span
                    key={c.key}
                    class={`live-self__comp-chip live-self__comp-chip--${c.key}`}
                  >
                    {c.label} <b>{c.text}</b>
                  </span>
                ))}
              </span>
            </div>
          ) : null}

          {/* Achievements earned so far (grade-tinted chips). */}
          {achChips.length > 0 ? (
            <div class="live-self__achs">
              {achChips.map((a) => (
                <span
                  class={["live-self__ach", `live-self__ach--${ACH_GRADE_CLASS[a.grade] ?? "common"}`]}
                  key={a.name}
                >
                  {a.name}
                  {a.count > 1 ? <em>×{a.count}</em> : null}
                </span>
              ))}
            </div>
          ) : null}

          {/* Ribbons (结算后 the server's counters land). */}
          {m.final && m.final.ribbons.length > 0 ? (
            <div class="live-self__ribbons">
              {m.final.ribbons.map((x) => {
                const url = bundledRibbonUrl(x.key);
                if (!url) return null;
                const name = ribbonNames[x.key]?.[lang] ?? x.key;
                return (
                  <span class="live-self__ribbon" data-hint={`${name} ×${x.value}`} key={x.key}>
                    <img src={url} alt="" width={40} height={15} />
                    <em>{x.value}</em>
                  </span>
                );
              })}
            </div>
          ) : null}

          {/* The damage ledger: dealt (whom I hurt) vs received (who hurt
              me) — the results screen's page 3. */}
          <div class="live-self__matrix">
            <div class="live-self__col">
              <div class="live-self__col-title">{t("replay.live.selfDealtTitle")}</div>
              {m.dealt.length > 0 ? (
                m.dealt.map(rowCard)
              ) : (
                <p class="live-self__empty">{t("replay.live.selfNoRows")}</p>
              )}
            </div>
            <div class="live-self__col">
              <div class="live-self__col-title">{t("replay.live.selfReceivedTitle")}</div>
              {m.received.length > 0 ? (
                m.received.map(rowCard)
              ) : (
                <p class="live-self__empty">{t("replay.live.selfNoRows")}</p>
              )}
            </div>
          </div>

          <p class="live-self__note">{t("replay.live.selfEstimate")}</p>
        </>
      );
    };
  },
});
