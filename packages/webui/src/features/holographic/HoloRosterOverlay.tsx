/**
 * Tab-held scoreboard overlay of the holographic map — the in-game Tab
 * table rebuilt from the replay streams at the CURRENT playhead:
 *
 *   - both teams' players (operations render one allies table — their
 *     relation values still split sides, the enemy scripted block is
 *     simply not listed),
 *   - kills credited so far (post-battle killer attribution joined with
 *     the crossed death times — hidden entirely when the replay carries
 *     no BattleResults packet),
 *   - the tier badge in its OWN fixed-width centered column, so the
 *     Roman numeral never shifts the ship name beside it (it used to be
 *     an inline prefix whose width swung the name with every tier),
 *   - sunk rows dimmed with their sinking time,
 *   - a thin team-coloured HP bar under the icon of every afloat row
 *     (the top scorebar's slot-bar recipe: dark rail + team-coloured fill
 *     read from the HP stream at the playhead and the roster's
 *     authoritative total HP),
 *   - ALIVE rows carrying the per-ship combat status chips — the same
 *     below-hull card the 3D chase view floats under each ship (see
 *     shipStatusModel / HoloShipStatus): firing/reload countdowns, smoke
 *     and repair windows, fire / flooding dots and the freshest hit
 *     pills, re-queried on every HUD tick. Hit pills now MERGE by damage
 *     source (attacker entity + shell family): the summed damage with a
 *     ×N suffix once follow-up hits joined, and a tooltip naming the
 *     attacker. A ship with nothing showing renders a dim dash — the
 *     static 存活 text carried no information the alive-count header
 *     doesn't already give; sunk rows keep their red sunk phrasing.
 *   - while the AI analysis layer is on, four extra columns after 击杀:
 *     the E21 contribution (window-attributed damage), the whole-game
 *     E17/E18 model agreement, the instant score at the playhead (its
 *     confidence in the tooltip) and a CONTINUOUS red -> yellow -> green
 *     agreement lamp (rosterScore.ts's aiLampColor — never three fixed
 *     buckets). A footer strip under the board carries the E17 honesty
 *     disclaimer, the movement-layer glyph legend and the report's
 *     samples / loading / no-data line.
 *   - the game's OWN row order (utils/shipClass's recovered Tab sort —
 *     alive rows first in class/tier/nation order, sunk rows re-sorted to
 *     the bottom; CN replays flip the within-(class, tier) order to the
 *     localized-ship-name permutation via shipNameOrder — Lesta
 *     renders its own key order, established by the 2026-10-10
 *     capture).
 *
 * Clan tags come from the lazily armed WG roster batch (they participate
 * in the game's sort key via the '[TAG]nick' display name).
 */
import { computed, defineComponent, type PropType } from "vue";
import { X } from "@lucide/vue";
import { HkScrollContainer } from "@celestia-island/hikari";

import { t as i18nT } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { markerTintClass } from "@/features/markers/markerTint";
import { markerColorLabel } from "@/features/markers/playerContextMenu";
import { useMarkersStore } from "@/stores/markers";
import type { RosterStat } from "@/composables/useRosterStats";
import { gameTabRowCompare, type TabRowCompareOptions } from "@/utils/shipClass";
import { isListedPlayer } from "@/utils/rosterSides";
import BattleIcon from "@/components/base/BattleIcon";
import { shipNameFromModelDb, shipNameFromOfflineDb, shipOfflineEntry } from "./modelLoader";
import { tierRoman } from "@/features/replay/shipLiveStats";
import {
  shipStatusAt,
  type ShipActionChip,
  type ShipDotChip,
  type ShipHitChip,
  type ShipStatusIndex,
} from "./shipStatusModel";
import { actionIconUrl, dotIconUrl, torpedoIconUrl, AMMO_ICON } from "./statusIcons";
import { fmtSecs } from "./HoloShipStatus";
import { hpAtTime } from "./trajectoryMath";
import { aiLampColor, formatContribution, scoreSampleAt } from "./rosterScore";
import type { ShipInfo, ShipScoreEntry, ShipScoreReport, VehicleEntry } from "@/api";
import type { HoloTipState } from "./HoloShipTooltip";

/** mm:ss battle clock for sunk times. */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/** Whole-number percentage for the AI score columns (0..100). */
const pct = (v: number): string => Math.round(v * 100).toString();

interface RosterRow {
  vehicle: VehicleEntry;
  shipName: string;
  tier: string | null;
  type: string | null;
  alive: boolean;
  /** Battle seconds the ship sank at (null = still afloat at the playhead). */
  deathTime: number | null;
  kills: number;
  /** HP at the playhead (null = sunk or no HP stream) and the roster's
   *  authoritative total HP — the icon column's mini bar reads both. */
  hp: number | null;
  maxHp: number | null;
  /** The trajectory entity this roster entry joined with (null = no
   *  stream) — the key into the per-ship status index and the AI scores. */
  entityId: number | null;
}

/** Render-side context: the marker/stats join plus the live status index,
 *  the AI score rows and the playhead the chips describe. */
interface TableCtx {
  markers: ReturnType<typeof useMarkersStore>;
  stats: Map<string, RosterStat>;
  shipStatus: Map<number, ShipStatusIndex>;
  time: number;
  /** AI analysis layer on -> the four extra score columns render. */
  aiOn: boolean;
  /** entity id -> report row (empty while the layer is off / no report). */
  scoreByEntity: Map<number, ShipScoreEntry>;
  /** trajectory entity id -> attacker display name (hit-chip source hints). */
  entityNameById: Map<number, string>;
}

function teamTable(rows: RosterRow[], enemy: boolean, showKills: boolean, ctx: TableCtx) {
  const alive = rows.filter((r) => r.alive).length;
  return (
    <div class="holo-roster__team">
      {/* Team title lives OUTSIDE the table: with table-layout fixed the
          first table row defines column widths, and a colspan title row
          would defeat the colgroup shares below. */}
      <div class="holo-roster__team-head">
        <span class={enemy ? "holo-roster__title--enemy" : "holo-roster__title--ally"}>
          {enemy ? i18nT("replay.roster.enemies") : i18nT("replay.roster.allies")}
        </span>
        <span class="holo-roster__alive">
          {i18nT("replay.roster.aliveCount", { alive, total: rows.length })}
        </span>
      </div>
      <table class="holo-roster__table">
        <colgroup>
          <col class="holo-roster__col--icon" />
          <col class="holo-roster__col--player" />
          <col class="holo-roster__col--tier" />
          <col class="holo-roster__col--ship" />
          {showKills ? <col class="holo-roster__col--kills" /> : null}
          {/* AI columns live between 击杀 and 状态 (no kills column when the
              replay carries no BattleResults — they follow the ship name
              then; the order is stable for one replay). */}
          {ctx.aiOn ? (
            <>
              <col class="holo-roster__col--contrib" />
              <col class="holo-roster__col--whole" />
              <col class="holo-roster__col--instant" />
              <col class="holo-roster__col--lamp" />
            </>
          ) : null}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th class="holo-roster__th holo-roster__th--icon" />
            <th class="holo-roster__th">{i18nT("replay.tip.player")}</th>
            {/* The tier column carries no title — the empty header cell
                keeps 舰船 sitting over the ship NAME column. */}
            <th class="holo-roster__th holo-roster__th--tier" />
            <th class="holo-roster__th">{i18nT("replay.roster.ship")}</th>
            {showKills ? <th class="holo-roster__th holo-roster__th--num">{i18nT("replay.roster.kills")}</th> : null}
            {ctx.aiOn ? (
              <>
                <th class="holo-roster__th holo-roster__th--num">{i18nT("replay.scores.contribution")}</th>
                <th class="holo-roster__th holo-roster__th--num">{i18nT("replay.scores.whole")}</th>
                <th class="holo-roster__th holo-roster__th--num">{i18nT("replay.scores.instant")}</th>
                {/* The lamp carries no title — it is the colour form of the
                    瞬时 / 认同 pair. */}
                <th class="holo-roster__th holo-roster__th--lamp" />
              </>
            ) : null}
            <th class="holo-roster__th">{i18nT("replay.tip.status")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            /** Fill percentage of the icon-column HP bar (null = no bar). */
            const hpPct =
              r.alive && r.hp != null && r.maxHp != null && r.maxHp > 0
                ? Math.round(Math.max(0, Math.min(1, r.hp / r.maxHp)) * 100)
                : null;
            return (
              <tr key={r.vehicle.id} class={r.alive ? "" : "holo-roster__row--dead"}>
                <td class="holo-roster__td holo-roster__td--icon">
                  <span class="holo-roster__icon">
                    <BattleIcon
                      type={r.type ?? ""}
                      variant={
                        r.alive
                          ? r.vehicle.relation === 0
                            ? "white"
                            : enemy
                              ? "enemy"
                              : "ally"
                          : "sunk"
                      }
                      size={14}
                    />
                    {/* Same recipe as the top scorebar's slot mini bar: a dark
                        rail with a team-coloured fill (--hp-pct). Sunk rows
                        and rows with no HP stream render no bar at all. */}
                    {hpPct != null ? (
                      <span
                        class={[
                          "holo-roster__hp",
                          enemy ? "holo-roster__hp--enemy" : "holo-roster__hp--ally",
                        ].join(" ")}
                        aria-hidden="true"
                        style={{ "--hp-pct": hpPct + "%" } as Record<string, string>}
                      />
                    ) : null}
                  </span>
                </td>
                <td
                  class="holo-roster__td holo-roster__td--name"
                  data-player-name={r.vehicle.name}
                  data-player-account={
                    ctx.stats.get(r.vehicle.name)?.accountId != null
                      ? String(ctx.stats.get(r.vehicle.name)?.accountId)
                      : undefined
                  }
                  data-player-realm={ctx.stats.get(r.vehicle.name)?.realm ?? undefined}
                >
                  {/* No 「我」 label — the self row is marked by its WHITE
                      ship icon (alive), the game's own convention. The name
                      itself carries the marker tint (玩家标记); right-click
                      opens the shared menu (the overlay is aria-hidden
                      chrome, but pointer events still flow to the binding). */}
                  {(() => {
                    const color = ctx.markers.colorOf(
                      r.vehicle.name,
                      ctx.stats.get(r.vehicle.name)?.accountId ?? null,
                    );
                    return (
                      <span
                        class={["holo-roster__nick", markerTintClass(color)]}
                        data-hint={color ? markerColorLabel(color) : undefined}
                      >
                        {r.vehicle.name}
                      </span>
                    );
                  })()}
                </td>
                <td class="holo-roster__td holo-roster__td--tier">
                  {r.tier ? <b class="holo-roster__tier">{r.tier}</b> : null}
                </td>
                <td class="holo-roster__td">
                  <span class="holo-roster__ship">{r.shipName}</span>
                </td>
                {showKills ? (
                  <td class="holo-roster__td holo-roster__td--num">
                    {r.kills > 0 ? <b>{r.kills}</b> : <span class="holo-roster__zero">0</span>}
                  </td>
                ) : null}
                {ctx.aiOn ? (
                  <AiScoreCells
                    score={r.entityId != null ? ctx.scoreByEntity.get(r.entityId) ?? null : null}
                    time={ctx.time}
                  />
                ) : null}
                <td class="holo-roster__td holo-roster__td--status">
                  {r.alive ? (
                    <StatusCell ctx={ctx} entityId={r.entityId} />
                  ) : (
                    /* Compact for the narrow status column — the full
                       "已击毁 · 沉没于 mm:ss" phrasing lives in the tooltip. */
                    <span class="holo-roster__sunk">
                      {r.deathTime != null
                        ? i18nT("replay.roster.sunkAt", { time: fmtClock(r.deathTime) })
                        : i18nT("replay.legend.dead")}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One row's four AI score cells (contribution · whole-game agreement ·
 *  instant score · continuous agreement lamp). Rendered only while the AI
 *  analysis layer is on; a ship the report does not cover keeps the dim
 *  dash in every column and an unlit lamp. */
function AiScoreCells({ score, time }: { score: ShipScoreEntry | null; time: number }) {
  const now = score ? scoreSampleAt(score.samples, Math.floor(time)) : null;
  // Per-shot mean stays a tooltip fact (the old score panel's hint) — the
  // column itself is too narrow for two numbers.
  const contribHint =
    score?.contribution != null && score.contributionShots
      ? i18nT("replay.scores.perShot", {
          value: formatContribution(score.contribution / Math.max(1, score.contributionShots)),
        })
      : undefined;
  // Whole-game agreement decomposes into its fire / move halves — reuse the
  // old panel's labels for the tooltip rather than growing new keys.
  const wholeHint = score
    ? (score.wholeFire != null
        ? i18nT("replay.scores.fire") + " " + pct(score.wholeFire)
        : i18nT("replay.scores.noFire")) +
      " · " + i18nT("replay.scores.move") + " " + pct(score.wholeMove)
    : undefined;
  return (
    <>
      <td class="holo-roster__td holo-roster__td--num holo-roster__td--contrib" data-hint={contribHint}>
        {score?.contribution != null ? (
          <b>{formatContribution(score.contribution)}</b>
        ) : (
          <span class="holo-roster__idle">—</span>
        )}
      </td>
      <td class="holo-roster__td holo-roster__td--num" data-hint={wholeHint}>
        {score ? <b>{pct(score.wholeGame)}</b> : <span class="holo-roster__idle">—</span>}
      </td>
      <td
        class="holo-roster__td holo-roster__td--num holo-roster__td--instant"
        data-hint={now ? i18nT("replay.scores.confidence") + " " + pct(now.confidence) : undefined}
      >
        {now ? <b>{pct(now.inst)}</b> : <span class="holo-roster__idle">—</span>}
      </td>
      <td class="holo-roster__td holo-roster__td--lamp">
        {now ? (
          <span
            class="holo-roster__lamp"
            aria-hidden="true"
            style={{ "--lamp-color": aiLampColor(now.inst) } as Record<string, string>}
          />
        ) : (
          <span class="holo-roster__lamp holo-roster__lamp--empty" aria-hidden="true" />
        )}
      </td>
    </>
  );
}

/** One alive row's live combat status: the action / dot / hit chips at the
 *  playhead, or a dim dash while the ship sits idle (and a dash too when
 *  the row never joined a trajectory — nothing is knowable). */
function StatusCell({ ctx, entityId }: { ctx: TableCtx; entityId: number | null }) {
  const st = entityId != null ? shipStatusAt(ctx.shipStatus.get(entityId), ctx.time) : null;
  if (!st) return <span class="holo-roster__idle">—</span>;
  return (
    <span class="holo-roster__st">
      {st.actions.map((a) => (
        <StatusActionChip key={a.key} chip={a} />
      ))}
      {st.dots.map((d) => (
        <StatusDotChip key={d.key} chip={d} />
      ))}
      {st.hits.map((h) => (
        <StatusHitChip key={h.key} chip={h} entityNameById={ctx.entityNameById} />
      ))}
    </span>
  );
}

/* ── Status chips ────────────────────────────────────────────────────────
   The 3D below-hull card's tiles (HoloShipStatus) re-proportioned for a
   table cell: same game-art icons, tint and draining bar, but the
   countdown sits beside the tile instead of below it so every row keeps
   the table's line height. */

function StatusActionChip({ chip }: { chip: ShipActionChip }) {
  return (
    <span class={["holo-roster__st-chip", "is-" + chip.key, "is-" + chip.phase]}>
      <span class="holo-roster__st-icon">
        <img
          class="holo-roster__st-img"
          src={actionIconUrl(chip.key, chip.ammo)}
          alt=""
          draggable={false}
        />
        <span
          class="holo-roster__st-bar"
          style={{ width: Math.round(chip.frac * 100) + "%" }}
        />
      </span>
      {chip.phase !== "flash" && chip.secs != null ? (
        <span class="holo-roster__st-secs">{fmtSecs(chip.secs)}</span>
      ) : null}
    </span>
  );
}

function StatusDotChip({ chip }: { chip: ShipDotChip }) {
  return (
    <span class={["holo-roster__st-chip", "is-" + chip.key]}>
      <span class="holo-roster__st-icon">
        <img class="holo-roster__st-img" src={dotIconUrl(chip.key)} alt="" draggable={false} />
        <span
          class="holo-roster__st-bar"
          style={{ width: Math.round(chip.frac * 100) + "%" }}
        />
      </span>
      <span class="holo-roster__st-secs">{fmtSecs(chip.secs)}</span>
    </span>
  );
}

/** Merged hit pill: one damage source's impacts inside the display window
 *  (see shipStatusModel's ShipHitChip) — ammo sprite, summed damage and a
 *  ×N suffix once follow-up hits merged in. The tooltip names the source
 *  through the roster's own entity join. */
function StatusHitChip({
  chip,
  entityNameById,
}: {
  chip: ShipHitChip;
  entityNameById: Map<number, string>;
}) {
  // Torpedo hits show the torpedo sprite; shell hits the ammo family's
  // sprite; unresolvable params ids fall back to the bare damage number.
  const src =
    chip.kind === "torpedo"
      ? torpedoIconUrl
      : chip.ammo != null
        ? AMMO_ICON[chip.ammo]
        : undefined;
  // A plane / squadron source has no roster row to take a name from — the
  // pill then keeps its bare number (never a misattributed hint).
  const source = entityNameById.get(chip.sourceId);
  return (
    <span
      class={[
        "holo-roster__st-hit",
        chip.kind === "torpedo" ? "is-torpedo" : "",
      ]}
      data-hint={
        source != null
          ? i18nT("replay.roster.hitSource", { name: source, n: chip.count })
          : undefined
      }
    >
      {src ? (
        <img class="holo-roster__st-hit-img" src={src} alt="" draggable={false} />
      ) : null}
      <span class="holo-roster__st-dmg">{"-" + chip.dmg.toLocaleString()}</span>
      {chip.count > 1 ? <span class="holo-roster__st-count">{"×" + chip.count}</span> : null}
    </span>
  );
}

export default defineComponent({
  name: "HoloRosterOverlay",
  props: {
    vehicles: { type: Array as PropType<VehicleEntry[]>, required: true },
    /** Operation scenario (行动): single allies table, no enemy one. */
    operation: { type: Boolean, default: false },
    /** Current battle seconds — the whole table describes THIS instant. */
    time: { type: Number, required: true },
    /** Roster player id -> live state (death time etc.), from the map. */
    rosterState: { type: Object as PropType<Map<number, HoloTipState>>, required: true },
    /** Player id -> kills credited by time (empty when unattributable). */
    kills: { type: Object as PropType<Map<number, number>>, required: true },
    /** False when the replay has no BattleResults — kills column hidden. */
    showKills: { type: Boolean, default: false },
    /** Career stats (clan tags feed the game's own sort key). */
    stats: { type: Object as PropType<Map<string, RosterStat>>, required: true },
    /** Ship encyclopedia (WG API, loaded per realm) — FIRST link of the
     *  ship-name/tier/type chain, so ships missing from the baked offline
     *  DBs (supertest hulls like Sovetskaya) still resolve when the
     *  encyclopedia knows them. */
    encyclopedia: { type: Object as PropType<Map<number, ShipInfo>>, required: true },
    /** Per-entity combat status index (see shipStatusModel.ts) — the
     *  chips the alive rows re-query at time. Non-reactive by design:
     *  it rebuilds with the actors, and the rows re-render on every
     *  time tick regardless. */
    shipStatus: { type: Object as PropType<Map<number, ShipStatusIndex>>, required: true },
    /** CN row order (localized ship name, pinyin-collated) for the open
     *  replay's own realm — the replay scoreboard must mirror the client
     *  the replay was recorded on, not the WG permutation. */
    shipNameOrder: { type: Boolean, default: false },
    /** AI analysis layer on: adds the four decision-score columns after
     *  击杀 and the disclaimer/legend footer under the board. Optional so
     *  every mount that does not carry the layer keeps working. */
    aiOn: { type: Boolean, default: false },
    /** The debug report's full-timeline E17 scores (null while the first
     *  call is in flight or after a failure) — resolved per row entity. */
    scoreReport: { type: Object as PropType<ShipScoreReport | null>, default: null },
    /** First-call / refresh indicator for the footer's loading line. */
    scoreLoading: { type: Boolean, default: false },
    /** Phone-only dismissal: the desktop hold retires on Tab keyup, an
     *  event touch never fires. Wired only on phone layouts (the parent
     *  passes it under useBreakpoint().isMobile) — its presence both
     *  arms the handler and renders the close bar. */
    onClose: { type: Function as PropType<() => void>, default: undefined },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();
    const encStore = useEncyclopediaStore();
    // Local player markers (玩家标记) for the rows' dots; the right-click
    // menu itself is the app-global binding (data-player-name attrs).
    const markers = useMarkersStore();
    void markers.ensureLoaded();

    /** Ship identity (name / tier / type): WG encyclopedia -> offline DB ->
     *  model DB -> the descriptor's raw index name. */
    const identityOf = (v: VehicleEntry): { name: string; tier: string | null; type: string | null } => {
      const sid = v.shipId;
      const info = sid != null ? (props.encyclopedia.get(sid) as ShipInfo | undefined) : undefined;
      const offline = sid != null ? shipOfflineEntry(sid) : undefined;
      return {
        name:
          // Empty-string display names (pathological encyclopedia entries)
          // must fall through like a miss, not stop the chain.
          (info ? encStore.shipDisplayName(info) || null : null) ??
          (sid != null ? shipNameFromOfflineDb(sid, dataLanguage.value) : null) ??
          v.shipName ??
          (sid != null ? shipNameFromModelDb(sid) : null) ??
          "",
        tier: tierRoman(info?.tier ?? offline?.tier ?? null),
        type: info?.type ?? offline?.type ?? null,
      };
    };

    /** The AI report's rows keyed by trajectory entity id (one lookup per
     *  table cell — the report arrives as one flat ordered list). */
    const scoreByEntity = computed<Map<number, ShipScoreEntry>>(() => {
      const m = new Map<number, ShipScoreEntry>();
      for (const entry of props.scoreReport?.perShip ?? []) m.set(entry.entityId, entry);
      return m;
    });

    /** trajectory entity id -> attacker name: the roster's own vehicle ->
     *  trajectory join read backwards. The hit pills' tooltips name the
     *  damage source through it. */
    const entityNameById = computed<Map<number, string>>(() => {
      const m = new Map<number, string>();
      for (const v of props.vehicles) {
        const entityId = props.rosterState.get(v.id)?.traj?.entityId;
        if (entityId != null && !m.has(entityId)) m.set(entityId, v.name);
      }
      return m;
    });

    /** The game's own Tab row order: alive-first / sunk-last, then class,
     *  tier desc, and — per the replay's realm flavor — nation rank or
     *  the localized-ship-name permutation. */
    const rows = computed<RosterRow[]>(() => {
      const clanTagOf = (v: { name: string }) => props.stats.get(v.name)?.clanTag ?? null;
      const compareOptions: TabRowCompareOptions = {
        locale: dataLanguage.value,
        clanTagOf,
        shipNameOrder: props.shipNameOrder,
      };
      // The comparator deliberately never compares the alive prefix (each
      // sort orders ONE layout), so the game's [alive] ++ [sunk] split
      // happens here — the same partition the live panel's orderForTab
      // applies.
      const byTab = (a: RosterRow, b: RosterRow) =>
        gameTabRowCompare(
          { shipId: a.vehicle.shipId, name: a.vehicle.name },
          { shipId: b.vehicle.shipId, name: b.vehicle.name },
          compareOptions,
        );
      const all = props.vehicles
        // Scripted scenario NPCs (story-mode ally flagships and their
        // IDS_* kin) are not players — the scoreboard lists players only;
        // :Name: co-op fills stay.
        .filter(isListedPlayer)
        .map((v): RosterRow => {
          const st = props.rosterState.get(v.id);
          const deathTime = st?.deathTime ?? null;
          const alive = deathTime == null || deathTime > props.time;
          const id = identityOf(v);
          const traj = st?.traj ?? null;
          return {
            vehicle: v,
            shipName: id.name,
            tier: id.tier,
            type: id.type,
            alive,
            deathTime,
            kills: props.kills.get(v.id) ?? 0,
            // The bar freezes/vanishes with the hull — a sunk row keeps no
            // live HP reading (its stream is dead there anyway).
            hp: alive && traj ? hpAtTime(traj.hpSamples, props.time) : null,
            maxHp: st?.maxHp ?? null,
            entityId: traj?.entityId ?? null,
          };
        });
      return [
        ...all.filter((r) => r.alive).sort(byTab),
        ...all.filter((r) => !r.alive).sort(byTab),
      ];
    });

    // The relation split holds in operations (行动) too — their rosters
    // carry real side semantics (allied escort waves <= 1, enemy warships
    // > 1), so the enemy scripted block never rolls into the allies table;
    // only the enemy TABLE stays hidden for them (scripted spawns, and a
    // list nobody reads).
    const allies = computed(() => rows.value.filter((r) => r.vehicle.relation <= 1));
    const enemies = computed(() =>
      props.operation ? [] : rows.value.filter((r) => r.vehicle.relation > 1),
    );

    return () => {
      const report = props.scoreReport;
      const tableCtx = (): TableCtx => ({
        markers,
        stats: props.stats,
        shipStatus: props.shipStatus,
        time: props.time,
        aiOn: props.aiOn,
        scoreByEntity: scoreByEntity.value,
        entityNameById: entityNameById.value,
      });
      return (
        /* Scroll region: hikari's HkScrollContainer owns the scrollbar
           (auto-hiding overlay track on the pane's right edge); the board
           scrolls inside its viewport. The absolute full-pane positioning
           stays on the class — it outranks hikari's relative root rule. */
        <HkScrollContainer class="holo-map__roster-overlay" aria-hidden="true">
          <div class="holo-map__roster-inner">
            {/* Phone close bar (sticky at the scroll top): the overlay owns
                the whole pane, so the opening chip is unreachable beneath
                it — this plays the Tab-keyup half of the desktop hold. */}
            {props.onClose ? (
              <div class="holo-map__roster-closebar">
                <button
                  class="holo-map__roster-close"
                  onClick={props.onClose}
                  data-hint={i18nT("common.close")}
                  aria-label={i18nT("common.close")}
                >
                  <X size={16} />
                </button>
              </div>
            ) : null}
            <div
              class={[
                "holo-map__roster-board",
                // AI columns need room: the modifier stacks the two team
                // tables and widens the board (see HolographicMap.scss).
                props.aiOn ? "holo-map__roster-board--ai" : "",
              ].filter(Boolean).join(" ")}
            >
              {teamTable(allies.value, false, props.showKills, tableCtx())}
              {enemies.value.length
                ? teamTable(enemies.value, true, props.showKills, tableCtx())
                : null}
            </div>
            {/* AI footer: the E17 honesty disclaimer, the movement-layer
                legend and the report's samples / loading / no-data line. */}
            {props.aiOn ? (
              <div class="holo-map__roster-ai-foot">
                <span class="holo-map__roster-ai-disclaimer hk-selectable">
                  {i18nT("replay.scores.disclaimer")}
                </span>
                <span class="holo-map__roster-ai-legend">
                  <span>{i18nT("replay.moveAdvice.holdMark")}</span>
                  <span>{i18nT("replay.moveAdvice.second")}</span>
                </span>
                <span class="holo-map__roster-ai-samples hk-selectable">
                  {props.scoreLoading
                    ? i18nT("replay.moveAdvice.loading")
                    : report
                      ? i18nT("replay.scores.samples", {
                          ships: report.perShip.length,
                          rows: report.stats.rowsScored,
                        })
                      : i18nT("replay.scores.noData")}
                </span>
              </div>
            ) : null}
          </div>
        </HkScrollContainer>
      );
    };
  },
});
