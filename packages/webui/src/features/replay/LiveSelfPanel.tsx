/**
 * Live self-stats panel (我的战绩) — the /live page's second body, mounted
 * while the title-bar's 全员/我的 switch reads "mine". The in-game results
 * screen's page 1 + page 3 fused into one live view: my running damage /
 * plane damage / hits / taken / frags (server-authoritative totals from the
 * recorder's damage stream), the achievements earned so far, and the
 * per-ship damage ledger both ways — whom I hurt (and sank) and who hurt
 * me — rebuilt every few seconds off the game's in-progress temp replay
 * (see stores/liveSelf.ts + features/replay/liveSelfStats.ts).
 *
 * During battle the numbers stream live (per-target attribution is a
 * hit-point estimate, flagged by the footnote); once the battle settles the
 * BattleResults payload swaps in the authoritative figures, ribbons and the
 * killer attribution. The head mirrors the roster panel's pill vocabulary
 * and carries the same share actions: copy-shot (the watermarked PNG
 * pipeline shared with the post-battle panels) and the ephemeral
 * hide-nicknames toggle — masked nicks never reach the copied image.
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties,
} from "vue";
import { Camera, Eye, EyeOff, Skull } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import type { ArenaInfo } from "@/api";
import BattleIcon from "@/components/base/BattleIcon";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import type { ShipIconVariant } from "@/features/holographic/shipIcons";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import { shareFooterStrings } from "@/features/share/shotKit";
import { useShareImage } from "@/features/share/useShareImage";
import { useLiveSelfStore } from "@/stores/liveSelf";
import { displayMapName } from "@/utils/mapNames";
import { modeColor, modeKey } from "@/utils/modeColors";
import { damageColor } from "@/utils/winrate";
import { useNickMasking } from "./postBattleShare";
import {
  renderLiveSelfShot,
  type SelfShotColumn,
  type SelfShotModel,
  type SelfShotRow,
  type SelfShotStat,
} from "./liveSelfShot";
import type { SelfCombatRow, SelfStatsModel } from "./liveSelfStats";
import { useBattleClock } from "./useBattleClock";
import MapNameTag from "./MapNameTag";
import { WaitingRadarArt } from "./liveGuideArt";
import ribbonNamesRaw from "@/data/ribbon_names.json";
import "./LiveBattlePanel.scss";
import "./LiveSelfPanel.scss";

const ribbonNames = ribbonNamesRaw as Record<string, Partial<Record<string, string>>>;

/** Achievement grade families → chip tint (the name bundle's `type`). */
const ACH_GRADE_CLASS: Record<string, string> = {
  heroic: "heroic",
  honorable: "honorable",
  service_medal: "service",
  squad: "squad",
};

/** Match-time stamp (M:SS) for the 同步至 line and row tooltips. */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Localize a battle mode from its layered identity (matchGroup / scenario /
 *  battle script / roster bots) — the roster panel's helper, verbatim. */
function modeLabelOf(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
  scriptedUnitCount = 0,
): string {
  const key = modeKey(group, scenario, eventType, botCount, scriptedUnitCount);
  if (!key) return t("replay.mode._fallback");
  const i18nKey = "replay.mode." + key;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

export default defineComponent({
  name: "LiveSelfPanel",
  props: {
    arena: { type: Object as () => ArenaInfo | null, default: null },
    settling: { type: Boolean, default: false },
    ended: { type: Boolean, default: false },
    /** The just-finished battle's replay path (LiveView's settling signal):
     *  swapped in for the authoritative full parse. */
    settledReplay: { type: String, default: null },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();
    const live = useLiveSelfStore();
    const masking = useNickMasking();
    const root = ref<HTMLElement | null>(null);
    const { label: clockLabel } = useBattleClock(() => props.arena?.dateTime ?? null);

    // The store mirrors the arena (a fresh dateTime wipes the previous
    // battle's model) and parses the settled replay exactly once per battle.
    watch(
      () => props.arena,
      (a) => live.setArena(a),
      { immediate: true },
    );
    watch(
      () => props.settledReplay,
      (p) => {
        if (p) void live.settle(p);
      },
      { immediate: true },
    );
    onMounted(() => live.attach());
    onBeforeUnmount(() => live.detach());

    const model = computed<SelfStatsModel | null>(() => live.model);

    // ── share shot (the post-battle panels' copy pipeline, own renderer). */
    const shot = useShareImage(() =>
      renderLiveSelfShot(buildShotModel(), {
        el: root.value,
        ...shareFooterStrings(),
      }),
    );

    /** Localized + masked view of one combat row (panel + shot share it). */
    const rowView = (row: SelfCombatRow) => {
      const shipName =
        row.shipId != null
          ? (shipNameFromOfflineDb(row.shipId, dataLanguage.value) ?? "")
          : "";
      const relation = row.relation;
      const iconVariant: ShipIconVariant =
        row.killed || row.hpRatio === 0
          ? "sunk"
          : relation == null
            ? "plain"
            : relation <= 1
              ? "ally"
              : "enemy";
      return {
        nick: masking.maskOf(row.name ?? `#${row.entityId}`),
        rawNick: row.name,
        bot: row.bot,
        shipName,
        shipType: row.shipId != null ? (shipOfflineEntry(row.shipId)?.type ?? null) : null,
        iconVariant,
        damage: row.damage,
        maxHp: row.maxHp,
        hpRatio: row.hpRatio,
        killed: row.killed,
        lastAt: row.lastAt,
      };
    };

    /** Fold duplicate achievements into name ×n chips — ALL duplicates, not
     *  just consecutive ones (an A · B · A earn order must still read
     *  A ×2 · B), first-earn order preserved. Shared by the DOM chips and
     *  the shot model. */
    const foldAchievements = (m: SelfStatsModel | null): { name: string; count: number }[] => {
      const byName = new Map<string, { name: string; count: number }>();
      for (const a of m?.achievements ?? []) {
        const hit = byName.get(a.name);
        if (hit) hit.count += 1;
        else byName.set(a.name, { name: a.name, count: 1 });
      }
      return [...byName.values()];
    };

    function buildShotModel(): SelfShotModel {
      const m = model.value;
      const arena = props.arena;
      let mode: SelfShotModel["mode"] = null;
      if (arena?.matchGroup) {
        const c = modeColor(
          arena.matchGroup,
          arena.scenario,
          arena.eventType,
          arena.botCount ?? 0,
          arena.scriptedUnitCount ?? 0,
        );
        mode = {
          label: modeLabelOf(
            arena.matchGroup,
            arena.scenario,
            arena.eventType,
            arena.botCount ?? 0,
            arena.scriptedUnitCount ?? 0,
          ),
          color: c.color,
          background: c.background,
        };
      }
      const stats: SelfShotStat[] = [
        {
          label: t("replay.live.selfDamage"),
          value: m ? m.damage.toLocaleString() : "—",
          color: m ? damageColor(m.damage) : undefined,
        },
        { label: t("replay.live.selfPlaneDamage"), value: m ? m.planeDamage.toLocaleString() : "—" },
        { label: t("replay.live.selfHits"), value: m ? String(m.hits) : "—" },
        { label: t("replay.live.selfTaken"), value: m ? m.taken.toLocaleString() : "—" },
        { label: t("replay.live.selfFrags"), value: m ? String(m.frags) : "—" },
      ];
      if (m?.final && m.final.exp != null) {
        stats.push({
          label: t("replay.live.selfExp"),
          value: m.final.exp.toLocaleString(),
        });
      }
      const folded = foldAchievements(m).map(
        (a) => (a.count > 1 ? `${a.name} ×${a.count}` : a.name),
      );
      const mkCol = (rows: SelfCombatRow[], title: string): SelfShotColumn => ({
        title,
        emptyLabel: t("replay.live.selfNoRows"),
        rows: rows.map(
          (r): SelfShotRow => {
            const v = rowView(r);
            return {
              nick: v.nick,
              shipName: v.shipName || "—",
              bot: v.bot,
              sunk: v.killed || v.hpRatio === 0,
              killed: v.killed,
              shipType: v.shipType,
              iconVariant: v.iconVariant === "plain" ? undefined : v.iconVariant,
              damage: v.damage.toLocaleString(),
            };
          },
        ),
      });
      return {
        title: t("replay.live.selfTitle"),
        mode,
        mapLabel: arena?.mapName
          ? displayMapName(arena.mapName, dataLanguage.value)
          : null,
        metaLine: m
          ? m.final
            ? t("replay.live.selfSettled")
            : t("replay.live.selfSyncAt", { time: fmtClock(m.battleTime) })
          : null,
        selfLine: m
          ? `${masking.maskOf(m.selfName ?? "")}${m.selfShipId != null ? " · " + (shipNameFromOfflineDb(m.selfShipId, dataLanguage.value) ?? "") : ""}`
          : "",
        summary: stats,
        achievements: folded,
        columns: [
          mkCol(m?.dealt ?? [], t("replay.live.selfDealtTitle")),
          mkCol(m?.received ?? [], t("replay.live.selfReceivedTitle")),
        ],
        estimateNote: t("replay.live.selfEstimate"),
        botLabel: t("replay.bot"),
        killLabel: t("replay.live.selfKillMark"),
      };
    }

    /** One damage-ledger row card (icon + nick/ship stack + damage figure +
     *  kill marker + the damage-share bar against the target's pool). */
    const combatRow = (row: SelfCombatRow) => {
      const v = rowView(row);
      const share =
        v.maxHp && v.maxHp > 0 ? Math.min(100, (v.damage / v.maxHp) * 100) : null;
      return (
        <div
          class={[
            "live-self__crow",
            { "live-self__crow--sunk": v.killed || v.hpRatio === 0 },
          ]}
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
          </span>
          <span class="live-self__crow-right">
            {share != null ? (
              <span class="live-self__crow-bar">
                <i style={{ width: `${share.toFixed(1)}%` }} />
              </span>
            ) : null}
            <b
              class="live-self__crow-dmg"
              style={{ color: damageColor(v.damage) }}
            >
              {v.damage.toLocaleString()}
            </b>
          </span>
        </div>
      );
    };

    // Reactive like the roster panel's own pill: the panel can mount while
    // the game runs but tempArenaInfo.json has yet to appear — a setup-time
    // const would stay null (or stale after a second battle) forever.
    const modePill = computed(() => {
      const arena = props.arena;
      if (!arena?.matchGroup) return null;
      return (
        <span
          class="live-battle__pill"
          style={
            modeColor(
              arena.matchGroup,
              arena.scenario,
              arena.eventType,
              arena.botCount ?? 0,
              arena.scriptedUnitCount ?? 0,
            ) as CSSProperties
          }
        >
          {modeLabelOf(
            arena.matchGroup,
            arena.scenario,
            arena.eventType,
            arena.botCount ?? 0,
            arena.scriptedUnitCount ?? 0,
          )}
        </span>
      );
    });

    return () => {
      // No roster at all (game off / between battles): the same radar-scope
      // waiting state the roster panel shows.
      if (!props.arena || props.arena.vehicles.length === 0) {
        return (
          <div class="live-battle live-battle--empty">
            <WaitingRadarArt class="live-battle__empty-art" />
            <p class="live-battle__empty-title">{t("replay.live.waitingTitle")}</p>
            <p class="live-battle__empty-hint">{t("replay.live.selfWaitingHint")}</p>
          </div>
        );
      }

      const m = model.value;
      const selfShipName =
        m?.selfShipId != null
          ? (shipNameFromOfflineDb(m.selfShipId, dataLanguage.value) ?? "")
          : "";
      const selfShipType =
        m?.selfShipId != null ? (shipOfflineEntry(m.selfShipId)?.type ?? null) : null;

      // Achievement chips with duplicates folded (name ×n), grade kept
      // from the last duplicate for the tint.
      const gradeOf = new Map((m?.achievements ?? []).map((a) => [a.name, a.grade]));
      const achChips = foldAchievements(m).map((a) => ({
        ...a,
        grade: gradeOf.get(a.name) ?? "",
      }));

      const tiles = [
        {
          label: t("replay.live.selfDamage"),
          value: m ? m.damage.toLocaleString() : "—",
          color: m ? damageColor(m.damage) : undefined,
        },
        { label: t("replay.live.selfPlaneDamage"), value: m ? m.planeDamage.toLocaleString() : "—" },
        { label: t("replay.live.selfHits"), value: m ? String(m.hits) : "—" },
        { label: t("replay.live.selfTaken"), value: m ? m.taken.toLocaleString() : "—" },
        { label: t("replay.live.selfFrags"), value: m ? String(m.frags) : "—" },
      ];
      if (m?.final && m.final.exp != null) {
        tiles.push({
          label: t("replay.live.selfExp"),
          value: m.final.exp.toLocaleString(),
        });
      }

      return (
        <div class="live-battle live-self" ref={root}>
          <div class="live-battle__head live-battle__head--status">
            <h1 class="live-battle__title">{t("replay.live.selfTitle")}</h1>
            {props.ended ? (
              <span class="live-battle__pill live-battle__pill--ended">
                {t("replay.live.ended")}
              </span>
            ) : props.settling ? (
              <span class="live-battle__pill live-battle__pill--settling">
                {t("replay.live.settling")}
              </span>
            ) : (
              <span class="live-battle__pill live-battle__pill--live">LIVE</span>
            )}
            {modePill.value}
            {!props.ended && clockLabel.value ? (
              <span class="live-battle__clock">{clockLabel.value}</span>
            ) : null}
            <MapNameTag
              class="live-battle__map"
              spaceId={props.arena.mapName}
              lang={dataLanguage.value}
            />
            {/* Snapshot sync state: the temp-replay decode's own clock —
                同步至 M:SS while live, the settled badge once final. */}
            {m ? (
              <span
                class={[
                  "live-battle__pill",
                  m.final ? "live-battle__pill--ended" : "live-self__sync",
                ]}
              >
                {m.final
                  ? t("replay.live.selfSettled")
                  : t("replay.live.selfSyncAt", { time: fmtClock(m.battleTime) })}
              </span>
            ) : (
              <span class="live-battle__pill live-self__sync">
                <HkSpinner size="xs" tone="current" />
                {t("replay.live.selfSyncing")}
              </span>
            )}
            <button
              class="live-battle__shot-btn"
              type="button"
              disabled={shot.busy.value || !m}
              onClick={() => void shot.copyShot()}
            >
              {shot.busy.value ? <HkSpinner size="xs" tone="current" /> : <Camera size={13} />}
              {t("share.copyShot")}
            </button>
            <button
              class={[
                "live-battle__mask-btn",
                { "live-battle__mask-btn--on": masking.hideAll.value },
              ]}
              type="button"
              onClick={() => masking.toggleAll()}
            >
              {masking.hideAll.value ? <Eye size={13} /> : <EyeOff size={13} />}
              {masking.hideAll.value
                ? t("replay.live.showNicks")
                : t("replay.live.hideNicks")}
            </button>
          </div>

          <div class="live-self__body">
            {!m ? (
              <div class="live-self__pending">
                <WaitingRadarArt class="live-self__pending-art" />
                <p class="live-self__pending-title">{t("replay.live.selfSyncing")}</p>
                <p class="live-self__pending-hint">{t("replay.live.selfSyncingHint")}</p>
                {live.error ? <p class="live-self__pending-err">{live.error}</p> : null}
              </div>
            ) : (
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
                      {masking.maskOf(m.selfName ?? "")}
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
                      {t("replay.live.selfKiller", {
                        name: masking.maskOf(m.final.killerName),
                      })}
                    </span>
                  ) : null}
                </div>

                {/* Summary tiles (damage / plane damage / hits / taken /
                    frags — exp once final). */}
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

                {/* Achievements earned so far (grade-tinted chips). */}
                {achChips.length > 0 ? (
                  <div class="live-self__achs">
                    {achChips.map((a) => (
                      <span
                        class={[
                          "live-self__ach",
                          `live-self__ach--${ACH_GRADE_CLASS[a.grade] ?? "common"}`,
                        ]}
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
                      const name = ribbonNames[x.key]?.[dataLanguage.value] ?? x.key;
                      return (
                        <span class="live-self__ribbon" data-hint={`${name} ×${x.value}`} key={x.key}>
                          <img src={url} alt="" width={40} height={15} />
                          <em>{x.value}</em>
                        </span>
                      );
                    })}
                  </div>
                ) : null}

                {/* The damage ledger: dealt (whom I hurt) vs received (who
                    hurt me) — the results screen's page 3. */}
                <div class="live-self__matrix">
                  <div class="live-self__col">
                    <div class="live-self__col-title">{t("replay.live.selfDealtTitle")}</div>
                    {m.dealt.length > 0 ? (
                      m.dealt.map(combatRow)
                    ) : (
                      <p class="live-self__empty">{t("replay.live.selfNoRows")}</p>
                    )}
                  </div>
                  <div class="live-self__col">
                    <div class="live-self__col-title">{t("replay.live.selfReceivedTitle")}</div>
                    {m.received.length > 0 ? (
                      m.received.map(combatRow)
                    ) : (
                      <p class="live-self__empty">{t("replay.live.selfNoRows")}</p>
                    )}
                  </div>
                </div>

                <p class="live-self__note">{t("replay.live.selfEstimate")}</p>
              </>
            )}
          </div>
        </div>
      );
    };
  },
});
