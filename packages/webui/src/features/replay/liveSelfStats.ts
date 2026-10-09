/**
 * Live self-combat model (我的战绩) — the pure data layer behind
 * LiveSelfPanel. Builds the "battle so far" personal report the panel and
 * its share shot render: authoritative totals from the recorder's
 * receiveDamageStat stream, the hit-level per-target damage attribution
 * (shot impacts + victim HP deltas — the same heuristic the replay review
 * view uses for its self card), achievements earned, and the post-battle
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

  /** Stamp every row's current HP % at the model's battle time. */
  finish(trajectories: EntityTrajectory[], at: number): void {
    const byEntity = new Map(trajectories.map((t) => [t.entityId, t]));
    for (const row of this.rows.values()) {
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
  // + player id + starting HP); the roster's relation-0 player is the
  // fallback, its unique shipId the last resort (mirror picks make the
  // shipId join unsafe when ambiguous).
  const selfArena = arenaPlayers.find((p) => p.isSelf) ?? null;
  let selfTraj: EntityTrajectory | undefined;
  if (selfArena) selfTraj = ships.find((t) => t.entityId === selfArena.entityId);
  let selfPlayerId = selfArena?.playerId ?? null;
  let selfShipId = selfArena?.shipParamsId ?? null;
  let selfName = selfArena?.name ?? null;
  if (!selfTraj) {
    const selfVehicle =
      selfPlayerId != null
        ? roster.find((v) => v.id === selfPlayerId)
        : roster.find((v) => v.relation === 0);
    if (selfVehicle) {
      selfPlayerId ??= selfVehicle.id;
      selfName ??= selfVehicle.name;
      selfShipId ??= selfVehicle.shipId ?? null;
      const byShip = ships.filter((t) => t.kind?.shipId === selfShipId);
      if (byShip.length === 1) selfTraj = byShip[0];
    }
  }
  if (selfName == null && selfPlayerId != null) {
    selfName = roster.find((v) => v.id === selfPlayerId)?.name ?? null;
  }

  const folded =
    (stream.damageStats?.length ?? 0) > 0
      ? foldDamageStats(stream.damageStats, Infinity)
      : null;
  const damageComp = foldDamageComp(stream.damageStats);
  const battleTime = lastTimeOf(trajectories, shotKills, stream.damageStats ?? []);

  if (!selfTraj) {
    // No ship entity yet (loading screen / first ticks) — surface the
    // server totals while the damage stream already flows; without it there
    // is nothing personal to show (shot kills cannot be attributed).
    if (!folded) return null;
    return {
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
  }
  const selfEntityId = selfTraj.entityId;
  const selfMaxHp = maxHpOf(selfTraj, selfArena ?? undefined);

  // ── hit-level attribution, both directions over the same walk: MY impacts
  // near any other ship attribute that ship's HP drop to me (dealt); anyone
  // else's impact near MY ship attributes MY HP drop to the firing entity
  // (received). DoT and out-of-stream hits stay unattributed — the totals
  // come from the server stream instead.
  const dealtBook = new RowBook(trajectories, roster, arenaPlayers);
  const takenBook = new RowBook(trajectories, roster, arenaPlayers);
  const shipEntityIds = new Set(ships.map((t) => t.entityId));
  // The launch join behind the per-row composition chips (shell / torpedo /
  // other) — classifies each impact once per event, both directions.
  const weaponOf = shotWeaponJoiner(stream.shellLaunches, stream.torpedoes);
  let heuristicDamage = 0;
  /** Server-confirmed hits of mine — the game's 命中 counter semantics:
   *  one VOLLEY tick (shells arriving inside 0.25 s count once — the game
   *  ribbons per salvo, not per shell) landing near a ship ALIVE at impact
   *  time on the enemy side. The receiveDamageStat dict's counts only
   *  cover damage-dealing hits (63 vs the game's 73 on the 2026-10-08
   *  calibration battle); the raw per-shell count over-counts splashes
   *  (91 events → 77 volleys → 73 game hits). */
  let impactHits = 0;
  let lastVolleyTick = -10.0;
  /** One impact's victim HP delta, attributed by direction: my hit near a
   *  ship credits me (row = victim); their hit near me credits the firing
   *  entity (row = attacker, victim fixed to my own hull). */
  const attribute = (
    book: RowBook,
    victim: EntityTrajectory,
    rowKey: number,
    e: ShotKillEvent,
    compKey: RowCompKey,
  ): number => {
    const at = sampleAtTraj(victim, e.time);
    if (!at) return 0;
    if (Math.hypot(at.x - e.x, at.z - e.z) > HIT_RADIUS_M) return 0;
    const hpBefore = hpAtTime(victim.hpSamples, e.time - HIT_HP_BEFORE_S);
    const hpAfter = hpAtTime(victim.hpSamples, e.time + HIT_HP_AFTER_S);
    if (hpBefore == null || hpAfter == null) return 0;
    const delta = hpBefore - hpAfter;
    if (delta < HIT_HP_MIN_DELTA) return 0;
    book.add(rowKey, delta, e.time, compKey);
    return delta;
  };
  for (const e of shotKills) {
    if (e.ownerId === selfEntityId) {
      const newVolley = e.time - lastVolleyTick > 0.25;
      if (newVolley) lastVolleyTick = e.time;
      const compKey = weaponOf(e.ownerId, e.shotId, e.time) ?? "other";
      let countedHit = false;
      for (const tr of ships) {
        if (tr.entityId === selfEntityId) continue;
        // Hit accounting: an impact near a ship that was ALIVE at impact
        // time is a direct hit (dead ships soak in-flight shells without
        // ribboning — live calibration: unfiltered 91 vs the game's 73).
        // Counted ONCE per impact even with overlapping hulls; the HP-delta
        // attribution below runs unchanged.
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
        const delta = attribute(dealtBook, tr, tr.entityId, e, compKey);
        if (delta > 0) {
          // The server's totals (and this fallback) count ENEMY-side damage
          // only — a teammate my splash grazed (the 2026-10-09 co-op battle
          // credited an ally 693 HP here) is not damage dealt.
          const victim = dealtBook.rows.get(tr.entityId);
          if (!victim || victim.relation == null || victim.relation > 1) {
            heuristicDamage += delta;
          }
          // Frag credit: MY impact's HP delta must have landed while the
          // victim was still afloat (diedBefore rejects the sinking
          // animation's post-death splash ticks — the 2026-10-08
          // calibration battle over-credited 4 vs the game's 3 until the
          // alive-at-impact gate joined the death-proximity window).
          if (!diedBefore && tr.deathTime != null) {
            // Kill credit is ENEMY-side only: a teammate's sinking under
            // my splash window is never my frag (the 2026-10-08
            // calibration battle credited an ally DoT death until this
            // gate). Unjoined entities (unknown side) stay uncredited —
            // an estimate never guesses a kill.
            const ap = arenaPlayers.find((p) => p.entityId === tr.entityId);
            const enemySide = ap != null && ap.teamId !== 0;
            const dt = e.time - tr.deathTime; // <0: my hit before death
            // DoT kills: the victim burns/floods out seconds after my last
            // shell, so the death-window HP delta may be unreadable (sparse
            // sampling near death) — my row's OWN attributed damage on the
            // victim is the fallback proof of engagement.
            const rowSoFar = dealtBook.rows.get(tr.entityId);
            const engaged = delta > 0 || (rowSoFar?.damage ?? 0) > 0;
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
    } else {
      // Received: only ship entities can be attackers (squadron/ward owners
      // are not in the ship set).
      if (!shipEntityIds.has(e.ownerId)) continue;
      attribute(takenBook, selfTraj, e.ownerId, e, weaponOf(e.ownerId, e.shotId, e.time) ?? "other");
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
    for (const row of model.dealt) {
      if (row.playerId != null) row.killed = killedIds.has(row.playerId);
    }
    const withRow = new Set(
      model.dealt.filter((r) => r.killed).map((r) => r.playerId ?? r.name),
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
