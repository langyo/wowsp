/**
 * Rich hover card for one scorebar ship slot — everything the replay knows
 * about a player at the current playhead, in one glance:
 *
 *   header    [TAG]nickname (+ 我 / bot tags) and the ship identity;
 *   战绩       career numbers (WG batch, same stats-source mode as the
 *             post-battle panels, tier-coloured);
 *   当前状态   the ship's estimated state at the playhead — hull HP bar,
 *             damage taken, kills so far, sunk time / position status;
 *   标准配置   the ship's consumable slots / upgrade count / signal
 *             capacity (the replay carries no per-player fittings — the
 *             section says so instead of inventing a loadout);
 *   船只属性   the baked spec groups (range / AA / concealment / …).
 *
 * Teleported to <body> and placed under the hovered slot with the same
 * measure-then-place policy as the live panel's ship card; the parent
 * keeps it mounted while the pointer rests on either the slot or the card
 * (onCardHover reports the card side of that bridge).
 */
import {
  computed,
  defineComponent,
  nextTick,
  onMounted,
  onUpdated,
  ref,
  Teleport,
  watch,
  type CSSProperties,
  type PropType,
} from "vue";
import { Flag, Wrench } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import BattleIcon from "@/components/base/BattleIcon";
import NationFlag from "@/components/base/NationFlag";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { isAiName, type RosterStat } from "@/composables/useRosterStats";
import { scopedViewOf } from "@/utils/shipStatsScope";
import type { ResolvedStatsMode, RosterModeNumbers } from "@/utils/statView";
import { battlesColor, damageColor, prTier, winrateColor } from "@/utils/winrate";
import {
  formatShipSpecGroups,
  isBadgeConsumable,
  shipConsumableLabel,
  shipLiveStats,
  shipTypeShort,
  tierRoman,
} from "@/features/replay/shipLiveStats";
import { LIVE_CARD_WIDTH_PX, placeLiveCard } from "@/features/replay/liveCardPlacement";
import {
  nationNameFromDb,
  shipOfflineEntry,
  shipNameFromModelDb,
  shipNameFromOfflineDb,
} from "./modelLoader";
import { hpAtTime, UNSEEN_GAP_S } from "./trajectoryMath";
import type { EntityTrajectory, ShipInfo, VehicleEntry } from "@/api";
import "./HoloShipTooltip.scss";

/** The live-state slice the map component resolves per hovered player. */
export interface HoloTipState {
  traj: EntityTrajectory | null;
  deathTime: number | null;
  maxHp: number | null;
}

/** Consumable families worth a badge (damage-control party excluded —
 *  every ship carries it, same rule as the live panel's strip). */
function badgeFamilies(load: string[] | undefined): string[] {
  return (load ?? []).filter((f) => isBadgeConsumable(f));
}

/** mm:ss battle clock for sunk times. */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** One career metric cell: tier-coloured value over a dim label. */
function MetricCell({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <span class="holo-ship-tip__metric">
      <b style={color ? { color } : undefined}>{value}</b>
      <span>{label}</span>
    </span>
  );
}

export default defineComponent({
  name: "HoloShipTooltip",
  props: {
    vehicle: { type: Object as PropType<VehicleEntry>, required: true },
    anchorEl: { type: Object as PropType<HTMLElement>, required: true },
    /** Battle seconds the card describes (tracks the playhead live). */
    time: { type: Number, required: true },
    state: { type: Object as PropType<HoloTipState | null>, default: null },
    /** Kills credited to this player by `time` (post-battle attribution). */
    kills: { type: Number, default: 0 },
    /** False when the replay carries no BattleResults packet — the kills
     *  row is hidden instead of showing a misleading 0. */
    showKills: { type: Boolean, default: false },
    stats: { type: Object as PropType<Map<string, RosterStat>>, required: true },
    statsLoading: { type: Boolean, default: false },
    statsMode: { type: String as () => ResolvedStatsMode, default: "random" },
    operation: { type: Boolean, default: false },
    encyclopedia: { type: Object as PropType<Map<number, ShipInfo>>, required: true },
    /** Pointer entered / left the card itself (the hover bridge). */
    onCardHover: { type: Function as PropType<(inside: boolean) => void>, required: true },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();
    const encStore = useEncyclopediaStore();

    const enemy = computed(
      () => !props.operation && props.vehicle.relation >= 2,
    );
    const self = computed(() => props.vehicle.relation === 0);
    const ai = computed(() => isAiName(props.vehicle.name));

    const info = computed(
      () => props.encyclopedia.get(props.vehicle.shipId) as ShipInfo | undefined,
    );
    const offline = computed(() => shipOfflineEntry(props.vehicle.shipId));
    const shipName = computed(() => {
      const sid = props.vehicle.shipId;
      return (
        (info.value ? encStore.shipDisplayName(info.value) : null) ??
        (sid != null ? shipNameFromOfflineDb(sid, dataLanguage.value) : null) ??
        (sid != null ? shipNameFromModelDb(sid) : null) ??
        props.vehicle.shipName ??
        ""
      );
    });
    const tier = computed(() => tierRoman(info.value?.tier ?? offline.value?.tier ?? null));
    const shipType = computed(() => info.value?.type ?? offline.value?.type ?? null);
    const nation = computed(() => offline.value?.nation ?? null);
    const nationLabel = computed(() =>
      nation.value
        ? nationNameFromDb(nation.value, dataLanguage.value) ?? nation.value
        : "",
    );

    // ── Live state at the playhead ────────────────────────────────────────
    const dead = computed(() => {
      const d = props.state?.deathTime;
      return d != null && d <= props.time;
    });
    const hp = computed(() =>
      hpAtTime(props.state?.traj?.hpSamples, props.time),
    );
    const maxHp = computed(() => props.state?.maxHp ?? null);
    /** Cumulative hull damage taken up to the playhead (sum of HP drops —
     *  heals don't refund it, mirroring the self-card's 承伤 readout). */
    const damageTaken = computed(() => {
      const hps = props.state?.traj?.hpSamples ?? [];
      let taken = 0;
      for (let i = 1; i < hps.length; i++) {
        if (hps[i].time > props.time) break;
        const drop = hps[i - 1].value - hps[i].value;
        if (drop > 0) taken += drop;
      }
      return taken;
    });
    /** Enemy position status: never seen / last seen stale (the minimap
     *  freeze window) — allies are always known. Null = show nothing. */
    const positionNote = computed<string | null>(() => {
      if (!enemy.value || dead.value) return null;
      const samples = props.state?.traj?.samples;
      if (!samples || samples.length === 0) return t("replay.tip.noTrajectory");
      if (props.time < samples[0].time) return t("replay.tip.neverSpotted");
      const last = samples[samples.length - 1];
      if (props.time - last.time > UNSEEN_GAP_S) return t("replay.tip.positionUnknown");
      return null;
    });

    // ── Career stats (resolved stats-source view) ─────────────────────────
    const stat = computed(() =>
      ai.value ? undefined : props.stats.get(props.vehicle.name),
    );
    const view = computed<RosterModeNumbers | null>(() =>
      stat.value
        ? scopedViewOf(stat.value, props.vehicle.shipId, props.statsMode)
        : null,
    );

    // ── Standard loadout + specs (baked ship capabilities) ────────────────
    const liveStats = computed(() => shipLiveStats(props.vehicle.shipId));
    const badges = computed(() =>
      liveStats.value ? badgeFamilies(liveStats.value.load) : [],
    );
    const upgrades = computed(() => liveStats.value?.upg ?? []);
    const flagCap = computed(() => liveStats.value?.flags ?? null);
    const specGroups = computed(() =>
      liveStats.value ? formatShipSpecGroups(liveStats.value) : [],
    );

    // ── Placement (measure-then-place, refreshed on every content change
    //    so HP/dead flips keep the card hugging its anchor) ────────────────
    const cardEl = ref<HTMLElement | null>(null);
    const pos = ref<CSSProperties>({
      left: "0px",
      top: "0px",
      width: `${LIVE_CARD_WIDTH_PX}px`,
      visibility: "hidden",
    });
    function place(force = false): void {
      const card = cardEl.value;
      if (!card) return;
      // Re-measure/replace only when the content box actually changed size
      // (dead-flip, spec groups loading) — the card re-renders every frame
      // during playback, and a per-frame layout read would thrash. A forced
      // pass (hover slid to another slot) bypasses the size cache.
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      if (!force && w === lastW && h === lastH) return;
      const r = props.anchorEl.getBoundingClientRect();
      if (!r.width && !r.height) return; // detached anchor — don't cache
      lastW = w;
      lastH = h;
      const { left, top } = placeLiveCard(
        r,
        w,
        h,
        window.innerWidth,
        window.innerHeight,
      );
      pos.value = {
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        width: `${LIVE_CARD_WIDTH_PX}px`,
        visibility: "visible",
      };
    }
    let lastW = -1;
    let lastH = -1;
    // Hover can slide straight from one slot to the next while the card
    // stays mounted — re-anchor whenever the anchor (or described player)
    // changes, even at an identical content size.
    watch(
      [() => props.anchorEl, () => props.vehicle.id],
      () => void nextTick(() => place(true)),
    );
    onMounted(() => void nextTick(() => place(true)));
    onUpdated(() => place());

    const fmtInt = (v: number | null | undefined): string =>
      v == null ? "—" : Math.round(v).toLocaleString();

    return () => {
      const v = view.value;
      const hpPct =
        hp.value != null && maxHp.value
          ? Math.max(0, Math.min(1, hp.value / maxHp.value))
          : null;
      return (
        <Teleport to="body">
          <div
            ref={cardEl}
            class={[
              "holo-ship-tip",
              enemy.value ? "holo-ship-tip--enemy" : "",
              dead.value ? "holo-ship-tip--dead" : "",
            ].join(" ")}
            style={pos.value}
            onMouseenter={() => props.onCardHover(true)}
            onMouseleave={() => props.onCardHover(false)}
          >
            <div class="holo-ship-tip__head">
              <div class="holo-ship-tip__name-row">
                <span class="holo-ship-tip__name">
                  {stat.value?.clanTag ? (
                    <span class="holo-ship-tip__clan">[{stat.value.clanTag}]</span>
                  ) : null}
                  {props.vehicle.name}
                </span>
                {self.value ? (
                  <em class="holo-ship-tip__tag">{t("replay.camera.me")}</em>
                ) : null}
                {ai.value ? (
                  <em class="holo-ship-tip__tag">{t("replay.bot")}</em>
                ) : null}
              </div>
              <div class="holo-ship-tip__ship-row">
                {tier.value ? <b class="holo-ship-tip__tier">{tier.value}</b> : null}
                <BattleIcon type={shipType.value ?? ""} variant="plain" size={14} />
                <span class="holo-ship-tip__ship-name">{shipName.value}</span>
                {shipTypeShort(shipType.value) ? (
                  <span class="holo-ship-tip__type">{shipTypeShort(shipType.value)}</span>
                ) : null}
                {nation.value ? (
                  <NationFlag
                    nation={nation.value}
                    label={nationLabel.value}
                    variant="flag"
                    size="sm"
                  />
                ) : null}
              </div>
            </div>

            {/* ── Career stats ── */}
            <div class="holo-ship-tip__section">
              <div class="holo-ship-tip__sec-title">{t("replay.tip.career")}</div>
              {ai.value ? (
                <p class="holo-ship-tip__dim">{t("replay.botNote")}</p>
              ) : props.statsLoading && !stat.value ? (
                <div class="holo-ship-tip__loading">
                  <HkSpinner size="xs" tone="current" />
                  <span class="holo-ship-tip__dim">{t("replay.tip.careerLoading")}</span>
                </div>
              ) : stat.value?.hidden ? (
                <p class="holo-ship-tip__dim">{t("replay.live.hiddenProfile")}</p>
              ) : v ? (
                <div class="holo-ship-tip__metrics">
                  <MetricCell
                    label={t("replay.roster.winrate")}
                    value={v.winrate != null ? `${v.winrate.toFixed(1)}%` : "—"}
                    color={v.winrate != null ? winrateColor(v.winrate) : undefined}
                  />
                  {prTier(v.pr).rainbow ? (
                    <span class="holo-ship-tip__metric holo-ship-tip__metric--rainbow">
                      <b class="rainbow-text">{fmtInt(v.pr)}</b>
                      <span>PR</span>
                    </span>
                  ) : (
                    <MetricCell
                      label="PR"
                      value={fmtInt(v.pr)}
                      color={v.pr != null ? prTier(v.pr).color : undefined}
                    />
                  )}
                  <MetricCell
                    label={t("replay.roster.battles")}
                    value={fmtInt(v.battles)}
                    color={v.battles != null ? battlesColor(v.battles) ?? undefined : undefined}
                  />
                  <MetricCell
                    label={t("replay.postbattle.avgDamage")}
                    value={fmtInt(v.avgDamage)}
                    color={v.avgDamage != null ? damageColor(v.avgDamage) : undefined}
                  />
                </div>
              ) : (
                <p class="holo-ship-tip__dim">—</p>
              )}
            </div>

            {/* ── Live state at the playhead ── */}
            <div class="holo-ship-tip__section">
              <div class="holo-ship-tip__sec-title">{t("replay.tip.state")}</div>
              {dead.value ? (
                <div class="holo-ship-tip__rows">
                  <div class="holo-ship-tip__row">
                    <span class="holo-ship-tip__row-label">{t("replay.tip.status")}</span>
                    <span class="holo-ship-tip__row-value holo-ship-tip__row-value--dead">
                      {t("replay.legend.dead")}
                      {props.state?.deathTime != null
                        ? ` · ${t("replay.roster.sunkAt", { time: fmtClock(props.state.deathTime) })}`
                        : ""}
                    </span>
                  </div>
                </div>
              ) : hpPct != null && maxHp.value ? (
                <div class="holo-ship-tip__rows">
                  <div class="holo-ship-tip__row">
                    <span class="holo-ship-tip__row-label">{t("replay.hpRemaining")}</span>
                    <span class="holo-ship-tip__row-value">
                      {Math.round(hp.value!).toLocaleString()} /{" "}
                      {Math.round(maxHp.value).toLocaleString()}
                    </span>
                  </div>
                  <div class="holo-ship-tip__hpbar" aria-hidden="true">
                    <span
                      class={`holo-ship-tip__hpbar-fill holo-ship-tip__hpbar-fill--${
                        enemy.value ? "enemy" : "ally"
                      }`}
                      style={{ width: `${Math.round(hpPct * 100)}%` }}
                    />
                  </div>
                  <div class="holo-ship-tip__row">
                    <span class="holo-ship-tip__row-label">{t("replay.damageTaken")}</span>
                    <span class="holo-ship-tip__row-value">
                      {Math.round(damageTaken.value).toLocaleString()}
                    </span>
                  </div>
                  {props.showKills ? (
                    <div class="holo-ship-tip__row">
                      <span class="holo-ship-tip__row-label">{t("replay.roster.kills")}</span>
                      <span class="holo-ship-tip__row-value">{props.kills}</span>
                    </div>
                  ) : null}
                  {positionNote.value ? (
                    <div class="holo-ship-tip__row">
                      <span class="holo-ship-tip__row-label">{t("replay.tip.position")}</span>
                      <span class="holo-ship-tip__row-value holo-ship-tip__row-value--dim">
                        {positionNote.value}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p class="holo-ship-tip__dim">{t("replay.tip.noTrajectory")}</p>
              )}
            </div>

            {/* ── Standard loadout capability ── */}
            {liveStats.value ? (
              <div class="holo-ship-tip__section">
                <div class="holo-ship-tip__sec-title">{t("replay.tip.load")}</div>
                <div class="holo-ship-tip__badges">
                  {badges.value.map((f) => (
                    <span class="holo-ship-tip__badge" key={f}>
                      {shipConsumableLabel(f)}
                    </span>
                  ))}
                  {upgrades.value.length ? (
                    <span class="holo-ship-tip__badge holo-ship-tip__badge--upg">
                      <Wrench size={10} />
                      {"×"}
                      {upgrades.value.length}
                    </span>
                  ) : null}
                  {flagCap.value ? (
                    <span class="holo-ship-tip__badge holo-ship-tip__badge--flag">
                      <Flag size={10} />
                      {"×"}
                      {flagCap.value}
                    </span>
                  ) : null}
                </div>
                <p class="holo-ship-tip__dim holo-ship-tip__note">
                  {t("replay.tip.loadNote")}
                </p>
              </div>
            ) : null}

            {/* ── Ship specs ── */}
            {specGroups.value.length ? (
              <div class="holo-ship-tip__section">
                <div class="holo-ship-tip__sec-title">{t("replay.tip.specs")}</div>
                <div class="holo-ship-tip__specs hk-scroll-pin-host">
                  {specGroups.value.map(([group, rows]) => (
                    <div class="holo-ship-tip__spec-group" key={group}>
                      <div class="holo-ship-tip__spec-title">{group}</div>
                      {rows.map(([label, value]) => (
                        <div class="holo-ship-tip__spec-row" key={label}>
                          <span>{label}</span>
                          <span>{value}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div class="holo-ship-tip__foot">{t("replay.tip.holdTab")}</div>
          </div>
        </Teleport>
      );
    };
  },
});
