/**
 * Live self-combat model (我的战绩) — the pure data layer behind
 * LiveSelfPanel. Builds the "battle so far" personal report the panel and
 * its share shot render: authoritative totals from the recorder's
 * receiveDamageStat stream, the hit-level per-target damage attribution
 * (shot impacts claim shares of each victim's HP-drop timeline — one
 * claim model per hull, so salvo volleys and crossfire cannot multiply
 * the same lost HP), achievements earned, and the post-battle
 * authoritative merge once the BattleResults payload lands.
 *
 * Sources (all from one decoded stream — the live temp container or the
 * settled replay; see `stores/liveSelf.ts`):
 *  - `damageStats`  — cumulative per-weapon damage dealt (server truth).
 *  - `shotKills`    — server-confirmed hits with firing entity + impact
 *                     point: the per-target attribution key.
 *  - `shellLaunches`/`torpedoes` — launch joins classifying each hit's
 *                     weapon bucket (the row composition chips).
 *  - `trajectories` — per-ship HP timelines (hpSamples) + deathTime.
 *  - `recorderVehicleId` — the recorder's own vehicle entity id (the
 *                     avatar's PlayerPosition link): the self anchor when
 *                     the arena join misses and the mirror-pick arbiter.
 *  - `arenaPlayers` — the authoritative entity ↔ player join (isSelf marks
 *                     the recorder).
 *  - `achievements` — onAchievementEarned events (roster player ids).
 *  - `battleResults`— the 0x22 payload (parsePostBattle): final damage,
 *                     taken, frags, killer ids, ribbons, exp.
 */
import type {
  AchievementEvent,
  ArenaPlayer,
  DamageStatSample,
  EntityTrajectory,
  HpSample,
  ReplayStream,
  ShotKillEvent,
  VehicleEntry,
} from "@/api";
import { foldDamageStats } from "@/api";
import achievementNamesRaw from "@/data/achievement_names.json";
import { parsePostBattle, type PostBattleData } from "./postBattle";
import { shotWeaponJoiner, foldDamageComp, type FamilyDamage, type RowComp, type RowCompKey } from "./damageComp";

const achievementNames: Record<
  string,
  { key: string; type: string; names: Partial<Record<string, string>> } | undefined
> = achievementNamesRaw;

/** Impact-to-ship attribution radius (m) — mirrors the replay review view's
 *  computeSelfStats; two ships inside 500 m of one impact are rare enough
 *  that the HP-delta window settles the ambiguity. */
const HIT_RADIUS_M = 500;
/** HP-delta window around an impact (s): HP sampled at t−0.4 and t+0.6. */
const HIT_HP_BEFORE_S = 0.4;
const HIT_HP_AFTER_S = 0.6;
/** Minimum HP drop counted as damage (tick noise floor). */
const HIT_HP_MIN_DELTA = 50;
/** Death within this window BEFORE-OR-AFTER my impact credits the frag.
 *  Direct shell kills land inside ±1.2 s; a sunk-by-DoT victim (fire/flood
 *  from my earlier salvo — no impact at death time) still credits within
 *  the longer pre-window: the 2026-10-08 calibration battle's third kill
 *  died 3.1 s after my last hit, and the game's killer-attribution counted
 *  it. The post-side stays tight (a post-death splash is not a kill). */
const FRAG_DEATH_WINDOW_S = 1.2;
const FRAG_DOT_PRE_WINDOW_S = 5.0;

// ── calibration tolerances ────────────────────────────────────────────────
// The estimate-vs-authority envelope the calibration suite pins: the
// single-battle test (liveSelfCalibration.test.ts) against the results
// screen of the 2026-10-08 battle, and the corpus bench
// (liveSelfCalibrationCorpus.test.ts) against every drained battle whose
// settled stream carries the BattleResults payload. Named here so the two
// tests share one source of truth — a tolerance change is a calibration
// decision, made once and visibly.
/** Hull-HP totals (damage dealt / taken): float32 server streams vs the
 * results accounting agree within ~0.01%, plus ribbon-class rounding. */
export const CALIB_DAMAGE_TOL = 10;
/** Direct-hit counters: the volley-ticked impact estimate sits within a
 * handful of the game's ribbon total (splash volleys on already-sunk ships
 * differ). */
export const CALIB_HITS_TOL = 5;
/** Kill attribution envelope: direct-window kills land reliably, DoT kills
 * (fire/flood-out seconds after the last shell) ride the engagement
 * fallback — the estimate stays within ±1 of the server's count. */
export const CALIB_FRAGS_TOL = 1;
/** Damage taken: the same hull-HP float32 class as dealt damage (max −
 * final HP, both sides final-based). */
export const CALIB_TAKEN_TOL = 10;

/** One per-ship combat row: what I did to that ship (dealt) or that ship
 *  did to me (received). */
export interface SelfCombatRow {
  /** The ship's vehicle entity id (the attribution key). */
  entityId: number;
  /** Roster player id when the join landed (null = unjoined entity). */
  playerId: number | null;
  name: string | null;
  bot: boolean;
  shipId: number | null;
  /** Roster relation: 0 self / 1 ally / 2+ enemy (null = unjoined). */
  relation: number | null;
  /** Attributed hull damage within this row. */
  damage: number;
  /** The same damage split by weapon bucket (launch-join estimate): shells
   *  vs torpedoes vs everything the launches never carried. */
  comp: RowComp;
  /** The ship's starting hull HP (arena value preferred). */
  maxHp: number | null;
  /** Current hull HP % (0..100) at the model's battle time. */
  hpRatio: number | null;
  /** I sank this ship (death-proximity credit; authoritative via
   *  BattleResults killer ids once available). */
  killed: boolean;
  /** Battle time of the last attributed hit (ties break by recency). */
  lastAt: number;
}

/** One achievement I earned, localized. */
export interface SelfAchievement {
  time: number;
  name: string;
  /** Grade family from the name bundle ("heroic" / "honorable" / …). */
  grade: string;
}

/** Authoritative end-state extras — present once BattleResults decodes. */
export interface SelfFinalStats {
  exp: number | null;
  ribbons: { key: string; value: number }[];
  /** Who sank me (nick), null when I survived. */
  killerName: string | null;
  killerShipId: number | null;
  /** Ships I sank, by the server's killer ids (names + ships). */
  myKills: { name: string; shipId: number | null; bot: boolean }[];
}

export interface SelfStatsModel {
  selfName: string | null;
  selfShipId: number | null;
  selfEntityId: number | null;
  selfPlayerId: number | null;
  /** Furthest battle second the snapshot decoded. */
  battleTime: number;
  /** Server truth (receiveDamageStat) vs HP-delta attribution fallback. */
  damageSource: "server" | "heuristic";
  damage: number;
  planeDamage: number;
  hits: number;
  /** Hull HP I lost so far (max − current). */
  taken: number;
  /** My current hull HP % (0..100). */
  hpRatio: number | null;
  /** My ship is down (deathTime decoded / results say sunk). */
  sunk: boolean;
  frags: number;
  /** Damage I dealt, per target ship (desc). */
  dealt: SelfCombatRow[];
  /** Damage I took, per attacker ship (desc). */
  received: SelfCombatRow[];
  /** The server's own damage split by weapon family (enemy category) — the
   *  composition strip under the summary tiles. Empty when the damage-stat
   *  stream has nothing decodable yet. */
  damageComp: FamilyDamage[];
  achievements: SelfAchievement[];
  final: SelfFinalStats | null;
}

/** Resolve one ship trajectory's position at time t (linear interpolation,
 *  clamped at the ends — mirrors the replay review view). */
function sampleAtTraj(traj: EntityTrajectory, t: number): { x: number; z: number } | null {
  const ss = traj.samples;
  if (!ss || ss.length === 0) return null;
  if (t <= ss[0].time) return ss[0];
  if (t >= ss[ss.length - 1].time) return ss[ss.length - 1];
  let lo = 0;
  let hi = ss.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ss[mid].time < t) lo = mid;
    else hi = mid;
  }
  const a = ss[lo];
  const b = ss[hi];
  const f = (t - a.time) / (b.time - a.time || 1);
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

/** HP at time t (last sample at or before t). */
function hpAtTime(hp: HpSample[] | undefined, t: number): number | null {
  if (!hp || hp.length === 0) return null;
  let last = hp[0].value;
  for (const s of hp) {
    if (s.time > t) break;
    last = s.value;
  }
  return last;
}

/** Bot-name markers, same vocabulary as the roster surfaces (`:…:` umbrella
 *  bots, `IDS_*` scripted units, `#Name` unnamed fills). */
function looksLikeBotName(name: string | null | undefined): boolean {
  return !!name && (/^:.*:$/.test(name) || name.startsWith("IDS_") || name === "#Name");
}

/** The ship's starting hull HP: the arena's authoritative value when the
 *  join landed, else the HP stream's peak (post-anchoring, the first sample
 *  IS the start, but the max tolerates unanchored legacy streams). */
function maxHpOf(traj: EntityTrajectory, arena?: ArenaPlayer): number | null {
  if (arena?.maxHealth && arena.maxHealth > 0) return arena.maxHealth;
  const hp = traj.hpSamples;
  if (!hp || hp.length === 0) return null;
  let max = 0;
  for (const s of hp) if (s.value > max) max = s.value;
  return max > 0 ? max : null;
}

/** Per-ship rows keyed by entity id, carrying the arena/roster identity
 *  join. One instance per direction: the dealt book keys on the ship I hit,
 *  the received book on the ship that hit me — a ship that traded fire both
 *  ways owns a row in each, its damage never summed across directions. */
class RowBook {
  readonly rows = new Map<number, SelfCombatRow>();

  constructor(
    trajectories: EntityTrajectory[],
    roster: VehicleEntry[],
    arenaPlayers: ArenaPlayer[],
  ) {
    const vehicleById = new Map(roster.map((v) => [v.id, v]));
    const arenaByEntity = new Map(arenaPlayers.map((p) => [p.entityId, p]));
    // Fallback join for versions without the arena state: unique shipIds
    // join directly; ambiguous ids (mirror picks) stay unjoined — safer
    // nameless than mis-named.
    const rosterByShipId = new Map<number, VehicleEntry[]>();
    for (const v of roster) {
      if (v.shipId != null) {
        rosterByShipId.set(v.shipId, [...(rosterByShipId.get(v.shipId) ?? []), v]);
      }
    }
    const uniqueShipJoin = (shipId: number | null | undefined): VehicleEntry | null => {
      if (shipId == null) return null;
      const list = rosterByShipId.get(shipId);
      return list && list.length === 1 ? list[0] : null;
    };
    for (const traj of trajectories) {
      if (traj.kind?.entityType !== 2) continue;
      const arena = arenaByEntity.get(traj.entityId);
      const vehicle =
        (arena?.playerId != null ? vehicleById.get(arena.playerId) : undefined) ??
        uniqueShipJoin(traj.kind.shipId);
      this.rows.set(traj.entityId, {
        entityId: traj.entityId,
        playerId: arena?.playerId ?? vehicle?.id ?? null,
        name: arena?.name ?? vehicle?.name ?? null,
        bot: arena?.isBot ?? looksLikeBotName(vehicle?.name),
        shipId: vehicle?.shipId ?? arena?.shipParamsId ?? traj.kind.shipId ?? null,
        relation: vehicle ? vehicle.relation : null,
        damage: 0,
        comp: {},
        maxHp: maxHpOf(traj, arena),
        hpRatio: null,
        killed: false,
        lastAt: 0,
      });
    }
  }

  /** Attribute `delta` HP loss at time `t` onto the row (creating a bare
   *  one for entities the pre-pass missed — e.g. a scripted spawn). The
   *  hit's weapon bucket rides along into the row's composition. */
  add(entityId: number, delta: number, t: number, compKey?: RowCompKey): void {
    let row = this.rows.get(entityId);
    if (!row) {
      row = {
        entityId,
        playerId: null,
        name: null,
        bot: false,
        shipId: null,
        relation: null,
        damage: 0,
        comp: {},
        maxHp: null,
        hpRatio: null,
        killed: false,
        lastAt: 0,
      };
      this.rows.set(entityId, row);
    }
    row.damage += delta;
    if (compKey) row.comp[compKey] = (row.comp[compKey] ?? 0) + delta;
    if (t > row.lastAt) row.lastAt = t;
  }

  /** Stamp every row's current HP % at the model's battle time, rounding
   *  the attributed damage into display integers (the claim split is
   *  fractional — one drop shared evenly across its covering impacts). */
  finish(trajectories: EntityTrajectory[], at: number): void {
    const byEntity = new Map(trajectories.map((t) => [t.entityId, t]));
    for (const row of this.rows.values()) {
      row.damage = Math.round(row.damage);
      for (const key of Object.keys(row.comp) as RowCompKey[]) {
        row.comp[key] = Math.round(row.comp[key] ?? 0);
      }
      const hp = byEntity.get(row.entityId)?.hpSamples;
      const now = hp?.length ? hpAtTime(hp, at) : null;
      if (row.maxHp && now != null && row.maxHp > 0) {
        row.hpRatio = Math.max(0, Math.min(100, (now / row.maxHp) * 100));
      }
    }
  }

  /** Rows worth showing (any damage or a kill), damage-desc. */
  sorted(): SelfCombatRow[] {
    return [...this.rows.values()]
      .filter((r) => r.damage > 0 || r.killed)
      .sort((a, b) => b.damage - a.damage || b.lastAt - a.lastAt);
  }
}

/** The stream families the model consumes — satisfied by both the full
 *  ReplayStream (settled-replay parse) and the slim LiveSelfStream (the
 *  polled temp-replay snapshot). */
export type SelfStatsStream = Pick<
  ReplayStream,
  | "trajectories"
  | "recorderVehicleId"
  | "shotKills"
  | "damageStats"
  | "achievements"
  | "arenaPlayers"
  | "battleResults"
  | "shellLaunches"
  | "torpedoes"
>;

export interface BuildSelfStatsInput {
  stream: SelfStatsStream;
  /** The live roster (tempArenaInfo vehicles) — names, relations and the
   *  self fallback (relation 0). */
  roster: VehicleEntry[];
  /** Data language for achievement names (falls back to en-US). */
  dataLang: string;
}

/** Build the self-combat model off one decoded stream. Returns null when
 *  neither the arena join nor the roster can identify the recorder's ship —
 *  nothing personal to report yet. */
export function buildSelfStats(input: BuildSelfStatsInput): SelfStatsModel | null {
  const { stream, roster, dataLang } = input;
  const trajectories = stream.trajectories ?? [];
  const shotKills = stream.shotKills ?? [];
  const arenaPlayers = stream.arenaPlayers ?? [];
  const ships = trajectories.filter((t) => t.kind?.entityType === 2);

  // ── self identity: the arena's isSelf entry is authoritative (entity id
  // + player id + starting HP); the recorder's own vehicle link
  // (recorderVehicleId — the avatar's PlayerPosition stream) anchors the
  // trajectory when the arena join misses (a version-drifted arena state,
  // an unpinned method id) and disambiguates the roster fallback's mirror
  // shipId picks; the roster's relation-0 player is the identity fallback,
  // its unique shipId the last resort.
  const selfArena = arenaPlayers.find((p) => p.isSelf) ?? null;
  const recorderEntityId = stream.recorderVehicleId ?? null;
  let selfTraj: EntityTrajectory | undefined;
  if (selfArena) selfTraj = ships.find((t) => t.entityId === selfArena.entityId);
  if (!selfTraj && recorderEntityId != null) {
    selfTraj = ships.find((t) => t.entityId === recorderEntityId);
  }
  let selfPlayerId = selfArena?.playerId ?? null;
  let selfShipId = selfArena?.shipParamsId ?? null;
  let selfName = selfArena?.name ?? null;
  if (selfArena && selfTraj && selfArena.entityId !== selfTraj.entityId) {
    // The arena entry failed to join the recorder's trajectory — its tail
    // fields (shipParamsId included) read from a drifted layout, so the
    // trajectory kind's roster-joined shipId is the trustworthy identity.
    selfShipId = selfTraj.kind?.shipId ?? selfShipId;
  }
  // The roster identity fallback runs whenever the identity is incomplete —
  // not only when the trajectory is: the recorder link can anchor selfTraj
  // while no arena isSelf entry ever joined (a partial live prefix, a
  // method-id drift), and the roster's relation-0 player still names me
  // (and with the player id, my achievements).
  if (!selfTraj || selfPlayerId == null) {
    const selfVehicle =
      selfPlayerId != null
        ? roster.find((v) => v.id === selfPlayerId)
        : roster.find((v) => v.relation === 0);
    if (selfVehicle) {
      selfPlayerId ??= selfVehicle.id;
      selfName ??= selfVehicle.name;
      selfShipId ??= selfVehicle.shipId ?? null;
      if (!selfTraj) {
        const byShip = ships.filter((t) => t.kind?.shipId === selfShipId);
        if (byShip.length === 1) selfTraj = byShip[0];
        else if (recorderEntityId != null) {
          // Mirror pick (two entities share the roster shipId): the
          // recorder's own vehicle link settles which trajectory is mine.
          selfTraj = byShip.find((t) => t.entityId === recorderEntityId);
        }
      }
    }
  }
  if (selfName == null && selfPlayerId != null) {
    selfName = roster.find((v) => v.id === selfPlayerId)?.name ?? null;
  }
  if (selfTraj && selfShipId == null) {
    // The recorder link resolved the trajectory but no roster/arena identity
    // joined — the kind's roster-joined shipId still names the ship (and
    // with it the identity card's icon).
    selfShipId = selfTraj.kind?.shipId ?? null;
  }

  const folded =
    (stream.damageStats?.length ?? 0) > 0
      ? foldDamageStats(stream.damageStats, Infinity)
      : null;
  const damageComp = foldDamageComp(stream.damageStats);
  const battleTime = lastTimeOf(trajectories, shotKills, stream.damageStats ?? []);

  if (!selfTraj) {
    // No ship entity yet (loading screen / first ticks — or every identity
    // join missed) — surface the server totals while the damage stream
    // already flows; without it there is nothing personal to show (shot
    // kills cannot be attributed). A settled BattleResults payload still
    // merges its authoritative figures (frags by killer ids, ribbons, my
    // killer, exp) over the empty ledgers — the report stays useful even
    // when the hit-level attribution had nothing to work on.
    if (!folded) return null;
    const early: SelfStatsModel = {
      selfName,
      selfShipId,
      selfEntityId: null,
      selfPlayerId,
      battleTime,
      // Reached only when the server stream already flows (folded != null).
      damageSource: "server",
      damage: folded?.damage ?? 0,
      planeDamage: folded?.planeDamage ?? 0,
      hits: folded?.hits ?? 0,
      taken: 0,
      hpRatio: null,
      sunk: false,
      frags: 0,
      dealt: [],
      received: [],
      damageComp,
      achievements: achievementsOf(stream.achievements ?? [], selfPlayerId, dataLang),
      final: null,
    };
    const post = parsePostBattle(stream.battleResults ?? null);
    if (post) mergeFinal(early, post);
    return early;
  }
  const selfEntityId = selfTraj.entityId;
  const selfMaxHp = maxHpOf(selfTraj, selfArena ?? undefined);

  // ── hit-level attribution over ONE claim model per hull: each victim's
  // HP-loss timeline is partitioned among the impacts (any owner) that sat
  // near it, every drop credited ONCE and split evenly across its covering
  // impacts. The old per-impact walk re-credited the FULL ±window HP delta
  // once per shell event — a 12-shell salvo multiplied ~12x, and a focused
  // hull's loss re-credited once per attacker shell (the 2026-10 corpus of
  // 119 settled battles summed the dealt rows to a 2.4x median of the
  // results screen and the received rows to 7.7x, worst 13.8x — the tiles
  // read server truth while both ledgers grew into the hundreds of
  // thousands). DoT and impact-less damage stay unattributed — the totals
  // still come from the server stream instead.
  const dealtBook = new RowBook(trajectories, roster, arenaPlayers);
  const takenBook = new RowBook(trajectories, roster, arenaPlayers);
  const shipEntityIds = new Set(ships.map((t) => t.entityId));
  // The launch join behind the per-row composition chips (shell / torpedo /
  // other) — classifies each impact once per event, both directions.
  const weaponOf = shotWeaponJoiner(stream.shellLaunches, stream.torpedoes);
  let heuristicDamage = 0;
  const indexedImpacts = shotKills.map((e, idx) => ({ e, idx }));
  // The claim candidates: any SHIP's impacts — a drop's budget is shared
  // with teammates' and enemies' shells landing nearby just as with my
  // own (squadron/ward owners are not in the ship set). The victim's own
  // impacts never join its partition (a hull's shells cannot hurt it).
  const shipImpacts = indexedImpacts.filter(({ e }) => shipEntityIds.has(e.ownerId));
  const myImpacts = indexedImpacts.filter(({ e }) => e.ownerId === selfEntityId);
  const othersImpacts = shipImpacts.filter(({ e }) => e.ownerId !== selfEntityId);
  /** Server-confirmed hits of mine — the game's 命中 counter semantics:
   *  one VOLLEY tick (shells arriving inside 0.25 s count once — the game
   *  ribbons per salvo, not per shell) landing near a ship ALIVE at impact
   *  time on the enemy side. The receiveDamageStat dict's counts only
   *  cover damage-dealing hits (63 vs the game's 73 on the 2026-10-08
   *  calibration battle); the raw per-shell count over-counts splashes
   *  (91 events → 77 volleys → 73 game hits). */
  let impactHits = 0;
  let lastVolleyTick = -10.0;
  /** One near impact classified for a victim: the event (with its
   *  shotKills index — the frag walk's engagement key) plus its weapon
   *  bucket. */
  interface VictimImpact {
    idx: number;
    e: ShotKillEvent;
    compKey: RowCompKey;
  }

  /** Impacts whose terminal point sits within HIT_RADIUS_M of `victim` at
   *  their own impact time — the covering candidates for the victim's HP
   *  drops. The candidate list is time-ascending by construction (the
   *  events arrive ascending; the filters preserve order). */
  const impactsNear = (
    victim: EntityTrajectory,
    events: { e: ShotKillEvent; idx: number }[],
  ): VictimImpact[] => {
    const out: VictimImpact[] = [];
    for (const { e, idx } of events) {
      const at = sampleAtTraj(victim, e.time);
      if (!at) continue;
      if (Math.hypot(at.x - e.x, at.z - e.z) > HIT_RADIUS_M) continue;
      out.push({ idx, e, compKey: weaponOf(e.ownerId, e.shotId, e.time) ?? "other" });
    }
    return out;
  };

  /** One hull's HP-loss timeline: every sample whose value fell by at
   *  least HIT_HP_MIN_DELTA since the previous one (time-ascending; heals
   *  never produce drops). The drops' sum is the hull's real HP loss —
   *  the attribution budget its covering impacts share. */
  const dropsOf = (victim: EntityTrajectory): { time: number; delta: number }[] => {
    const hp = victim.hpSamples;
    const out: { time: number; delta: number }[] = [];
    if (!hp || hp.length < 2) return out;
    for (let i = 1; i < hp.length; i++) {
      const d = hp[i - 1].value - hp[i].value;
      if (d >= HIT_HP_MIN_DELTA) out.push({ time: hp[i].time, delta: d });
    }
    return out;
  };

  /** Split `victim`'s HP drops evenly across their covering near impacts —
   *  an impact covers a drop when the drop's sample lands inside its
   *  attribution window (t − HIT_HP_BEFORE_S < drop ≤ t + HIT_HP_AFTER_S,
   *  the same envelope the old hpBefore/hpAfter read). Both directions
   *  partition the same victim timeline through here, so no lost HP can
   *  be counted twice — not across one salvo's shells, not across
   *  crossfiring attackers. Returns the per-impact shares and which
   *  impacts covered anything (the frag walk's engagement proof). */
  const partitionDrops = (
    victim: EntityTrajectory,
    refs: VictimImpact[],
  ): { share: number[]; engaged: boolean[] } => {
    const share = new Array<number>(refs.length).fill(0);
    const engaged = new Array<boolean>(refs.length).fill(false);
    const drops = dropsOf(victim);
    if (refs.length === 0 || drops.length === 0) return { share, engaged };
    let lo = 0; // refs ascend in time alongside the drops — a sliding window
    for (const drop of drops) {
      while (lo < refs.length && refs[lo].e.time + HIT_HP_AFTER_S < drop.time) lo++;
      const covering: number[] = [];
      for (let i = lo; i < refs.length && refs[i].e.time - HIT_HP_BEFORE_S < drop.time; i++) {
        covering.push(i);
      }
      if (covering.length === 0) continue;
      const per = drop.delta / covering.length;
      for (const i of covering) {
        share[i] += per;
        engaged[i] = true;
      }
    }
    return { share, engaged };
  };
  /** My impacts that covered ≥1 HP drop on a victim — the frag walk's
   *  engagement proof, read off the claim partition (the old walk read it
   *  off the per-impact window delta). */
  const coveredByImpact = new Map<number, Set<number>>();
  const noteCovered = (idx: number, victimId: number): void => {
    const set = coveredByImpact.get(idx);
    if (set) set.add(victimId);
    else coveredByImpact.set(idx, new Set([victimId]));
  };

  // ── dealt: my impacts near each other hull claim their shares of its
  // drops (row = victim hull). A focused hull's drop shared with my
  // teammates' impacts credits me my slice only — the ledger can never
  // exceed what actually left the hulls I was shooting at.
  for (const tr of ships) {
    if (tr.entityId === selfEntityId) continue;
    const refs = impactsNear(
      tr,
      shipImpacts.filter(({ e }) => e.ownerId !== tr.entityId),
    );
    const { share, engaged } = partitionDrops(tr, refs);
    for (let i = 0; i < refs.length; i++) {
      if (refs[i].e.ownerId !== selfEntityId || share[i] <= 0) continue;
      dealtBook.add(tr.entityId, share[i], refs[i].e.time, refs[i].compKey);
      if (engaged[i]) noteCovered(refs[i].idx, tr.entityId);
    }
  }
  // The server totals (and this fallback) count ENEMY-side damage only —
  // a teammate my splash grazed (the 2026-10-09 co-op battle credited an
  // ally 693 HP here) is not damage dealt.
  for (const row of dealtBook.rows.values()) {
    if (row.relation == null || row.relation > 1) heuristicDamage += row.damage;
  }

  // ── received: everyone else's ship impacts near MY hull claim their
  // shares of my drops (row = attacker; squadron/ward owners are not in
  // the ship set).
  {
    const refs = impactsNear(selfTraj, othersImpacts);
    const { share } = partitionDrops(selfTraj, refs);
    for (let i = 0; i < refs.length; i++) {
      if (share[i] > 0) {
        takenBook.add(refs[i].e.ownerId, share[i], refs[i].e.time, refs[i].compKey);
      }
    }
  }

  // ── the hits counter + death-proximity frag credit walk over MY impacts
  // (damage attribution happened above, on the claim partition).
  for (const { e, idx } of myImpacts) {
    const newVolley = e.time - lastVolleyTick > 0.25;
    if (newVolley) lastVolleyTick = e.time;
    let countedHit = false;
    for (const tr of ships) {
      if (tr.entityId === selfEntityId) continue;
      // Hit accounting: an impact near a ship that was ALIVE at impact
      // time is a direct hit (dead ships soak in-flight shells without
      // ribboning — live calibration: unfiltered 91 vs the game's 73).
      // Counted ONCE per impact even with overlapping hulls; the claim
      // partition above runs unchanged.
      const impactAt = sampleAtTraj(tr, e.time);
      const diedBefore = tr.deathTime != null && tr.deathTime <= e.time;
      if (
        !countedHit &&
        newVolley &&
        impactAt &&
        !diedBefore &&
        // Enemy side only: the self entry anchors team 0, and friendly
        // splashes do not ribbon.
        (() => {
          const ap = arenaPlayers.find((p) => p.entityId === tr.entityId);
          return ap == null || ap.teamId !== 0;
        })() &&
        Math.hypot(impactAt.x - e.x, impactAt.z - e.z) <= HIT_RADIUS_M
      ) {
        impactHits++;
        countedHit = true;
      }
      // Frag credit: my impact must sit within HIT_RADIUS_M of this victim
      // (the same proximity the old attribute() read before its window
      // delta — a kill across the map never credits) and must have covered
      // an HP drop on it while it was still afloat (diedBefore rejects the
      // sinking animation's post-death splash ticks — the 2026-10-08
      // calibration battle over-credited 4 vs the game's 3 until the
      // alive-at-impact gate joined the death-proximity window).
      const nearVictim =
        impactAt != null && Math.hypot(impactAt.x - e.x, impactAt.z - e.z) <= HIT_RADIUS_M;
      if (nearVictim && !diedBefore && tr.deathTime != null) {
        // Kill credit is ENEMY-side only: a teammate's sinking under my
        // splash window is never my frag (the 2026-10-08 calibration
        // battle credited an ally DoT death until this gate). Unjoined
        // entities (unknown side) stay uncredited — an estimate never
        // guesses a kill.
        const ap = arenaPlayers.find((p) => p.entityId === tr.entityId);
        const enemySide = ap != null && ap.teamId !== 0;
        const dt = e.time - tr.deathTime; // <0: my hit before death
        // DoT kills: the victim burns/floods out seconds after my last
        // shell, so the death-window impact may not have covered the fatal
        // drop (sparse sampling near death) — my row's OWN attributed
        // damage on the victim is the fallback proof of engagement.
        const rowSoFar = dealtBook.rows.get(tr.entityId);
        const engaged =
          (coveredByImpact.get(idx)?.has(tr.entityId) ?? false) ||
          (rowSoFar?.damage ?? 0) > 0;
        const credited =
          enemySide &&
          (Math.abs(dt) < FRAG_DEATH_WINDOW_S ||
            (dt < 0 && -dt < FRAG_DOT_PRE_WINDOW_S && engaged));
        if (credited) {
          const row = dealtBook.rows.get(tr.entityId);
          if (row) row.killed = true;
        }
      }
    }
  }
  dealtBook.finish(trajectories, battleTime);
  takenBook.finish(trajectories, battleTime);

  // ── my hull state.
  const lastHp = selfTraj.hpSamples?.length
    ? hpAtTime(selfTraj.hpSamples, battleTime)
    : null;
  const taken =
    selfMaxHp != null && lastHp != null ? Math.max(0, Math.round(selfMaxHp - lastHp)) : 0;
  const hpRatio =
    selfMaxHp != null && lastHp != null && selfMaxHp > 0
      ? Math.max(0, Math.min(100, (lastHp / selfMaxHp) * 100))
      : null;

  const model: SelfStatsModel = {
    selfName,
    selfShipId,
    selfEntityId,
    selfPlayerId,
    battleTime,
    damageSource: folded ? "server" : "heuristic",
    damage: Math.round(folded?.damage ?? heuristicDamage),
    planeDamage: folded?.planeDamage ?? 0,
    // The impact count matches the game's hit counter; the server dict's
    // damage-dealing-only count stays the fallback (no ship entity yet).
    hits: impactHits > 0 ? impactHits : (folded?.hits ?? 0),
    taken,
    hpRatio,
    sunk: selfTraj.deathTime != null,
    frags: [...dealtBook.rows.values()].filter((r) => r.killed).length,
    // 对敌造成伤害: known allies stay out of the dealt ledger entirely —
    // the attribution cannot help grazing one (its row would read as a
    // green ally inside an enemies-only list; the 2026-10-09 co-op
    // "Stenga" case). Unjoined entities (no roster relation) stay listed —
    // they are overwhelmingly enemies whose join simply missed.
    dealt: dealtBook.sorted().filter((r) => r.relation == null || r.relation > 1),
    received: takenBook.sorted(),
    damageComp,
    achievements: achievementsOf(stream.achievements ?? [], selfPlayerId, dataLang),
    final: null,
  };

  // ── post-battle authoritative merge (present from the results screen on:
  // the temp container already carries the 0x22 payload there).
  const post = parsePostBattle(stream.battleResults ?? null);
  if (post) mergeFinal(model, post);
  return model;
}

/** Merge the BattleResults payload's authoritative figures over the live
 *  model: totals, kill attribution by killer ids, my killer, ribbons, exp. */
function mergeFinal(model: SelfStatsModel, post: PostBattleData): void {
  const self =
    (post.selfId != null
      ? post.players.find((p) => p.accountId === post.selfId)
      : undefined) ??
    (model.selfPlayerId != null
      ? post.players.find((p) => p.accountId === model.selfPlayerId)
      : undefined) ??
    (model.selfName != null
      ? post.players.find((p) => p.name === model.selfName)
      : undefined) ??
    null;
  const selfId = self?.accountId ?? post.selfId ?? model.selfPlayerId ?? null;
  const killedPlayers =
    selfId != null ? post.players.filter((p) => p.killerId === selfId) : [];
  // The dealt ledger is enemies-only — a server-credited TEAM kill must not
  // append an ally row (relation null would render it as an unjoined enemy)
  // nor re-stamp one with a kill skull. Unknown teams (legacy payloads) keep
  // the old behavior.
  const selfTeam = self?.team ?? null;
  const killedEnemies = killedPlayers.filter(
    (p) => selfTeam == null || p.team == null || p.team !== selfTeam,
  );
  const killedIds = new Set(killedEnemies.map((p) => p.accountId));
  if (self) {
    model.damage = self.damage;
    model.taken = self.damageTaken;
    model.hpRatio = self.hpRatio;
    model.sunk = !self.alive;
    model.frags = self.frags;
    // Server kill attribution beats the death-proximity heuristic: re-stamp
    // every dealt row whose player the results settle, and append a bare
    // killed row for DoT-only sinks the hit-level attribution never saw.
    // The row→results join rides id OR name: modern WG payloads key the
    // results by a per-battle session id (the arena state's idx-0 field)
    // while the arena/roster join carries the account dbids — two id
    // spaces over the same players, and nicknames are unique per battle
    // (the 2026-10-17 15.9.0 capture's kill skulls rode the name join).
    const postByName = new Map(post.players.map((p) => [p.name, p]));
    for (const row of model.dealt) {
      const settled =
        (row.playerId != null
          ? post.players.find((p) => p.accountId === row.playerId)
          : undefined) ??
        (row.name != null ? postByName.get(row.name) : undefined);
      if (settled) row.killed = killedIds.has(settled.accountId);
    }
    // Both join keys, not `playerId ?? name`: a row whose skull arrived via
    // the name join still carries its other-space playerId, and the dedup
    // must recognize it by either key (same dual join as the re-stamp).
    const withRow = new Set(
      model.dealt.flatMap((r) => (r.killed ? [r.playerId, r.name] : [])),
    );
    for (const p of killedEnemies) {
      if (withRow.has(p.accountId) || withRow.has(p.name)) continue;
      // The heuristic may already carry the sink as an UNJOINED row (no
      // arena join): stamp its identity instead of duplicating it.
      const anon = model.dealt.find(
        (r) => r.killed && r.playerId == null && r.name == null && r.shipId === p.shipId,
      );
      if (anon) {
        anon.playerId = p.accountId;
        anon.name = p.name;
        anon.bot = looksLikeBotName(p.name);
        continue;
      }
      model.dealt.push({
        entityId: -1,
        playerId: p.accountId,
        name: p.name,
        bot: looksLikeBotName(p.name),
        shipId: p.shipId,
        relation: null,
        damage: 0,
        comp: {},
        maxHp: null,
        hpRatio: null,
        killed: true,
        lastAt: 0,
      });
    }
    model.dealt.sort((a, b) => b.damage - a.damage || Number(b.killed) - Number(a.killed));
  }
  const killer =
    self && self.killerId != null && !self.alive
      ? post.players.find((p) => p.accountId === self.killerId) ?? null
      : null;
  model.final = {
    exp: self?.exp ?? post.selfExp ?? null,
    ribbons: self?.ribbons ?? [],
    killerName: killer?.name ?? null,
    killerShipId: killer?.shipId ?? null,
    myKills: killedPlayers.map((p) => ({
      name: p.name,
      shipId: p.shipId,
      bot: looksLikeBotName(p.name),
    })),
  };
}

/** My achievements from the event stream (localized, chronological). */
function achievementsOf(
  events: AchievementEvent[],
  selfPlayerId: number | null,
  dataLang: string,
): SelfAchievement[] {
  if (selfPlayerId == null) return [];
  return events
    .filter((a) => a.playerId === selfPlayerId)
    .map((a) => {
      const bundle = achievementNames[String(a.achievementId)];
      return {
        time: a.time,
        name:
          bundle?.names[dataLang] ??
          bundle?.names["en-US"] ??
          bundle?.key ??
          `#${a.achievementId}`,
        grade: bundle?.type ?? "",
      };
    });
}

/** The furthest battle second any of the consumed streams reached — the
 *  snapshot's own clock (the panel prints it as 同步至 M:SS). */
function lastTimeOf(
  trajectories: EntityTrajectory[],
  shotKills: ShotKillEvent[],
  damageStats: DamageStatSample[],
): number {
  let t = 0;
  for (const s of shotKills) if (s.time > t) t = s.time;
  for (const s of damageStats) if (s.time > t) t = s.time;
  for (const tr of trajectories) {
    const hp = tr.hpSamples;
    if (hp?.length && hp[hp.length - 1].time > t) t = hp[hp.length - 1].time;
  }
  return t;
}
