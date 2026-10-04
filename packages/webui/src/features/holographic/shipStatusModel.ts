/**
 * Per-ship combat status rows for the holographic map's below-hull chips
 * (shown when the camera is close enough): row one tracks what a ship DOES
 * — gunfire / torpedo launches with their reload countdown, smoke and repair
 * windows — and row two what it SUFFERS — shell / torpedo hits with the
 * damage they took, plus persistent fire / flooding dots with their
 * remaining burn time.
 *
 * The decoded replay stream carries no consumable-activation events, so
 * everything here is derived from the signals it DOES carry: artillery /
 * torpedo launches (exact, replay lookahead makes the next salvo — and thus
 * the reload end — knowable), joined shell-flight kills and torpedo
 * detonations (impact points), smoke-screen entity spawns (attributed by
 * proximity) and the HP step timeline (rises = repair ticks, small
 * repeating drops = burn/flood dots). Pure data-in/data-out — no Vue, no
 * DOM, no THREE — so the heuristics are unit-testable.
 */
import type { EntityTrajectory, ShellLaunchEvent, TorpedoLaunch } from "@/api";
import { sampleAt } from "./trajectoryMath";

// ── Public shape ────────────────────────────────────────────────────────

export type ShipActionKey = "gun" | "torp" | "smoke" | "repair";

/** One row-one chip: a square icon with an LoL-style progress bar under it.
 *  `flash` = just fired (no reload info, brief highlight); `cooldown` =
 *  draining reload bar with countdown; `active` = effect in progress
 *  (smoke / repair), the bar shows the remaining effect time. */
export interface ShipActionChip {
  key: ShipActionKey;
  phase: "flash" | "cooldown" | "active";
  /** 0..1 remaining fraction of the current phase. */
  frac: number;
  /** Ceil remaining seconds; null when the end is unknowable. */
  secs: number | null;
}

/** One row-two hit pill: shell ammo family (or torpedo) + damage taken. */
export interface ShipHitChip {
  key: string;
  kind: "shell" | "torpedo";
  /** HE / AP / SAP for shells; null when the params id didn't resolve. */
  ammo: string | null;
  dmg: number;
}

/** One row-two damage-over-time chip with its remaining burn seconds. */
export interface ShipDotChip {
  key: "fire" | "flood";
  secs: number;
}

export interface ShipStatusSnapshot {
  actions: ShipActionChip[];
  hits: ShipHitChip[];
  dots: ShipDotChip[];
}

// ── Tuning constants ────────────────────────────────────────────────────

/** Launch bursts inside this window count as one salvo (matches the
 *  tactical timeline's grouping). */
const SALVO_WINDOW_S = 2;
/** The just-fired highlight lingers this long before the reload bar takes
 *  over (torpedoes read longer — the launch itself is the spectacle). */
const GUN_FLASH_S = 1.2;
const TORP_FLASH_S = 2;
/** Salvo gaps beyond this stop rendering as a reload bar — a 5-minute lull
 *  draining a bar is noise, not information. */
const MAX_RELOAD_S = 60;
/** Impact positions within this distance of a ship count as hits on it
 *  (hull + a little splash tolerance; far misses stay misses). */
const HIT_RADIUS = 160;
/** A shell impact only renders when HP actually dropped in this window
 *  around it (filters joined kills that were water splashes / bounces). */
const HIT_DAMAGE_WINDOW_S = 1.6;
/** How long a hit pill stays on the row. */
const HIT_TTL_S = 2.5;
/** Max hit pills shown at once (newest wins). */
const HIT_CAP = 3;
/** HP rises merged with gaps up to this are one repair window. */
const REPAIR_GAP_S = 1.5;
/** Small-drop ticks merged with gaps up to this form one burn window. */
const DOT_GAP_S = 2.5;
/** A drop is a DoT tick (not a shell hit) when it takes at most this
 *  fraction of max HP — HE pens / torps dwarf burn ticks. */
const DOT_TICK_FRAC = 0.025;
/** A burn window needs at least this many ticks to read as a dot. */
const DOT_MIN_TICKS = 3;
/** Flooding can only follow a torpedo hit this recently. */
const FLOOD_ARM_S = 15;

// ── Build-time inputs ───────────────────────────────────────────────────

/** Joined shell flight end (a receiveShotKills impact), pre-resolved to the
 *  ammo family — derived from the map's ShellTraceStates at rebuild time. */
export interface ShellImpact {
  t: number;
  x: number;
  z: number;
  ownerId: number;
  ammo: string;
}

/** A short-lived torpedo (endT < launch + 240 = joined detonation). */
export interface TorpedoImpact {
  t: number;
  x: number;
  z: number;
  ownerId: number;
}

/** A smoke-screen cluster with its owner-attribution still pending. */
export interface SmokeCluster {
  t0: number;
  endT: number;
  x: number;
  z: number;
}

export interface ShipStatusSource {
  trajectories: EntityTrajectory[];
  shellLaunches: ShellLaunchEvent[];
  torpedoes: TorpedoLaunch[];
  shellImpacts: ShellImpact[];
  torpImpacts: TorpedoImpact[];
  smokes: SmokeCluster[];
}

// ── Per-ship index ──────────────────────────────────────────────────────

interface TimeWindow {
  t0: number;
  t1: number;
}

interface StoredHit {
  t: number;
  kind: "shell" | "torpedo";
  ammo: string | null;
  dmg: number;
}

interface DotWindow extends TimeWindow {
  kind: "fire" | "flood";
}

export interface ShipStatusIndex {
  /** Main-battery salvo start times, sorted. */
  gun: number[];
  /** Torpedo-tube salvo start times, sorted (plane drops excluded). */
  torp: number[];
  repairs: TimeWindow[];
  smokes: TimeWindow[];
  hits: StoredHit[];
  dots: DotWindow[];
}

/** Build the per-entity index consumed by `shipStatusAt`. Ships without any
 *  signal get no entry (their rows simply never render). */
export function buildShipStatusIndex(src: ShipStatusSource): Map<number, ShipStatusIndex> {
  const shipTrajs = src.trajectories.filter(
    (tr) => tr.kind?.entityType === 2 && tr.samples.length > 1,
  );
  const shipIds = new Set(shipTrajs.map((tr) => tr.entityId));
  const out = new Map<number, ShipStatusIndex>();
  for (const tr of shipTrajs) {
    const maxHp = peakHp(tr);
    const idx: ShipStatusIndex = {
      gun: gunSalvosFor(src.shellLaunches, tr.entityId),
      torp: torpedoSalvosFor(src.torpedoes, tr.entityId, shipIds),
      repairs: repairWindows(tr, maxHp),
      smokes: [],
      hits: [],
      dots: dotWindows(tr, maxHp, src.torpImpacts, tr.entityId),
    };
    out.set(tr.entityId, idx);
  }
  attributeSmokes(src, out, shipTrajs);
  attributeHits(src, out, shipTrajs);
  return out;
}

/** Query one ship's rows at playhead `t`. Returns null when nothing is
 *  showing — the common case, so callers can skip the DOM patch. */
export function shipStatusAt(idx: ShipStatusIndex | undefined, t: number): ShipStatusSnapshot | null {
  if (!idx) return null;
  const actions: ShipActionChip[] = [];
  const gun = weaponChip(idx.gun, t, GUN_FLASH_S, "gun");
  if (gun) actions.push(gun);
  const torp = weaponChip(idx.torp, t, TORP_FLASH_S, "torp");
  if (torp) actions.push(torp);
  for (const w of idx.smokes) {
    if (t < w.t0 || t > w.t1) continue;
    actions.push({
      key: "smoke",
      phase: "active",
      frac: (w.t1 - t) / Math.max(0.001, w.t1 - w.t0),
      secs: Math.ceil(w.t1 - t),
    });
    break;
  }
  for (const w of idx.repairs) {
    if (t < w.t0 || t > w.t1) continue;
    actions.push({
      key: "repair",
      phase: "active",
      frac: (w.t1 - t) / Math.max(0.001, w.t1 - w.t0),
      secs: Math.ceil(w.t1 - t),
    });
    break;
  }
  const hits: ShipHitChip[] = [];
  for (let i = idx.hits.length - 1; i >= 0 && hits.length < HIT_CAP; i--) {
    const h = idx.hits[i];
    if (h.t < t - HIT_TTL_S || h.t > t) continue;
    hits.push({ key: `${h.kind}-${h.t.toFixed(2)}-${i}`, kind: h.kind, ammo: h.ammo, dmg: h.dmg });
  }
  const dots: ShipDotChip[] = [];
  for (const d of idx.dots) {
    if (t < d.t0 || t > d.t1) continue;
    dots.push({ key: d.kind, secs: Math.ceil(d.t1 - t) });
  }
  if (actions.length === 0 && hits.length === 0 && dots.length === 0) return null;
  return { actions, hits, dots };
}

// ── Row one: launches, reloads, smoke, repair ───────────────────────────

function weaponChip(
  times: number[],
  t: number,
  flashS: number,
  key: "gun" | "torp",
): ShipActionChip | null {
  // Last salvo at or before the playhead (arrays are tiny — tail scan wins
  // over a binary search).
  let t0: number | null = null;
  for (let i = times.length - 1; i >= 0; i--) {
    if (times[i] <= t) {
      t0 = times[i];
      break;
    }
  }
  if (t0 == null) return null;
  const since = t - t0;
  if (since <= flashS) {
    return { key, phase: "flash", frac: 1, secs: null };
  }
  let next: number | null = null;
  for (const tm of times) {
    if (tm > t0) {
      next = tm;
      break;
    }
  }
  if (next == null) return null;
  const reload = next - t0;
  if (reload > MAX_RELOAD_S) return null;
  return {
    key,
    phase: "cooldown",
    frac: (next - t) / reload,
    secs: Math.ceil(next - t),
  };
}

/** Group one owner's launches into salvo start times (bursts within
 *  SALVO_WINDOW_S collapse; each burst is timestamped at its first event). */
function salvoTimesFor<T extends { time: number }>(events: T[]): number[] {
  const times: number[] = [];
  let lastT = -1e9;
  for (const e of events) {
    if (e.time < lastT) continue; // unsorted guard
    if (e.time - lastT <= SALVO_WINDOW_S) continue;
    times.push(e.time);
    lastT = e.time;
  }
  return times;
}

function gunSalvosFor(launches: ShellLaunchEvent[], ownerId: number): number[] {
  return salvoTimesFor(launches.filter((e) => e.ownerId === ownerId));
}

/** Ship-tube salvos only — air-dropped fish belong to squadrons, not to
 *  the below-hull action row. */
function torpedoSalvosFor(
  launches: TorpedoLaunch[],
  ownerId: number,
  shipIds: Set<number>,
): number[] {
  if (!shipIds.has(ownerId)) return [];
  return salvoTimesFor(launches.filter((e) => e.ownerId === ownerId));
}

function repairWindows(tr: EntityTrajectory, maxHp: number): TimeWindow[] {
  const hp = tr.hpSamples;
  if (!hp || hp.length < 2 || maxHp <= 0) return [];
  const wins: TimeWindow[] = [];
  // A window spans the maximal run of rising samples with gaps ≤
  // REPAIR_GAP_S. Small granularity: HP streams step per heal tick.
  let open: TimeWindow | null = null;
  let prevT = hp[0].time;
  for (let i = 1; i < hp.length; i++) {
    const gap = hp[i].time - prevT;
    if (hp[i].value > hp[i - 1].value) {
      if (open && gap <= REPAIR_GAP_S + 0.5) open.t1 = hp[i].time;
      else {
        if (open) wins.push(open);
        open = { t0: prevT, t1: hp[i].time };
      }
    } else if (open && gap > REPAIR_GAP_S) {
      wins.push(open);
      open = null;
    }
    prevT = hp[i].time;
  }
  if (open) wins.push(open);
  // Windows shorter than one heal tick of visibility are noise.
  return wins.filter((w) => w.t1 - w.t0 >= 1);
}

// ── Row two: hits and damage-over-time ──────────────────────────────────

interface HpDrop {
  t: number;
  amount: number;
  small: boolean;
}

function hpDrops(tr: EntityTrajectory, maxHp: number): HpDrop[] {
  const hp = tr.hpSamples;
  if (!hp || hp.length < 2) return [];
  const smallLimit = maxHp > 0 ? maxHp * DOT_TICK_FRAC : Infinity;
  const drops: HpDrop[] = [];
  for (let i = 1; i < hp.length; i++) {
    const d = hp[i - 1].value - hp[i].value;
    if (d > 0) drops.push({ t: hp[i].time, amount: d, small: d <= smallLimit });
  }
  return drops;
}

function peakHp(tr: EntityTrajectory): number {
  const hp = tr.hpSamples;
  if (!hp || hp.length === 0) return 0;
  let m = 0;
  for (const s of hp) if (s.value > m) m = s.value;
  return m;
}

/** Burn / flood windows: maximal runs of SMALL hp drops with gaps ≤
 *  DOT_GAP_S, needing DOT_MIN_TICKS ticks. Classification: flooding can
 *  only exist when a torpedo detonated ON this ship (within reach and
 *  FLOOD_ARM_S before the first tick); everything else is fire. */
function dotWindows(
  tr: EntityTrajectory,
  maxHp: number,
  torpImpacts: TorpedoImpact[],
  entityId: number,
): DotWindow[] {
  const drops = hpDrops(tr, maxHp).filter((d) => d.small);
  const wins: DotWindow[] = [];
  let run: HpDrop[] = [];
  const flush = (): void => {
    if (run.length >= DOT_MIN_TICKS) {
      const t0 = run[0].t;
      const t1 = run[run.length - 1].t + 1; // tick cadence tail
      const flooded = torpImpacts.some(
        (k) => k.ownerId !== entityId && k.t <= t0 && t0 - k.t <= FLOOD_ARM_S && landedOn(tr, k),
      );
      wins.push({ t0, t1, kind: flooded ? "flood" : "fire" });
    }
    run = [];
  };
  for (const d of drops) {
    if (run.length > 0 && d.t - run[run.length - 1].t > DOT_GAP_S) flush();
    run.push(d);
  }
  flush();
  // Merge same-kind windows separated by a large hit's interruption (the
  // burn continues after the pen is healed into the HP curve).
  const merged: DotWindow[] = [];
  for (const w of wins.sort((a, b) => a.t0 - b.t0)) {
    const last = merged[merged.length - 1];
    if (last && last.kind === w.kind && w.t0 - last.t1 <= DOT_GAP_S) last.t1 = Math.max(last.t1, w.t1);
    else merged.push({ ...w });
  }
  return merged;
}

/** Whether a torpedo detonation landed on this ship: the impact point must
 *  sit within hull reach of the ship's own position at that instant — an
 *  unrelated fish connecting across the map must not turn a fire into a
 *  flood. */
function landedOn(tr: EntityTrajectory, k: TorpedoImpact): boolean {
  const s = sampleAt(tr, k.t);
  if (!s) return false;
  return Math.hypot(s.x - k.x, s.z - k.z) <= HIT_RADIUS;
}

/** Impacts become hit pills on the nearest ship within HIT_RADIUS; each HP
 *  drop inside an impact's damage window is assigned to exactly ONE impact
 *  — the nearest in time — so two near-simultaneous pens split the drops
 *  instead of the first swallowing both. */
function attributeHits(
  src: ShipStatusSource,
  out: Map<number, ShipStatusIndex>,
  shipTrajs: EntityTrajectory[],
): void {
  type Impact = {
    t: number;
    x: number;
    z: number;
    ownerId: number;
    kind: "shell" | "torpedo";
    ammo: string | null;
    victimId: number | null;
  };
  const impacts: Impact[] = [
    ...src.shellImpacts.map((s) => ({ ...s, kind: "shell" as const, ammo: s.ammo })),
    ...src.torpImpacts.map((s) => ({ ...s, kind: "torpedo" as const, ammo: null })),
  ]
    .map((im) => ({ ...im, victimId: victimOf(im, shipTrajs) }))
    .filter((im) => im.victimId != null);
  // Bucket by victim once, so each ship's drop scan only walks its own
  // attackers — a full drops × impacts cross product is tens of millions
  // of iterations on a heavy 12v12.
  const byVictim = new Map<number, Impact[]>();
  for (const im of impacts) {
    const list = byVictim.get(im.victimId!);
    if (list) list.push(im);
    else byVictim.set(im.victimId!, [im]);
  }
  // Assign every drop to its nearest victim impact, then sum per impact.
  const dmgByImpact = new Map<Impact, number>();
  for (const tr of shipTrajs) {
    const mine = byVictim.get(tr.entityId);
    if (!mine || mine.length === 0) continue;
    for (const drop of hpDrops(tr, peakHp(tr))) {
      let best: Impact | null = null;
      let bestDt = Infinity;
      for (const im of mine) {
        if (drop.t < im.t - 0.4 || drop.t > im.t + HIT_DAMAGE_WINDOW_S) continue;
        const dt = Math.abs(drop.t - im.t);
        if (dt < bestDt) {
          bestDt = dt;
          best = im;
        }
      }
      if (best) dmgByImpact.set(best, (dmgByImpact.get(best) ?? 0) + drop.amount);
    }
  }
  for (const im of impacts) {
    const dmg = dmgByImpact.get(im);
    if (dmg == null || im.victimId == null) continue; // splash / bounce / dud
    out.get(im.victimId)?.hits.push({
      t: im.t,
      kind: im.kind,
      ammo: im.kind === "shell" ? im.ammo : null,
      dmg: Math.round(dmg),
    });
  }
  for (const idx of out.values()) idx.hits.sort((a, b) => a.t - b.t);
}

/** Nearest alive-at-impact ship that is not the shooter, within reach. */
function victimOf(
  im: { t: number; x: number; z: number; ownerId: number },
  shipTrajs: EntityTrajectory[],
): number | null {
  let victim: number | null = null;
  let bestD = HIT_RADIUS;
  for (const tr of shipTrajs) {
    if (tr.entityId === im.ownerId) continue;
    const s = sampleAt(tr, im.t);
    if (!s) continue;
    const death = tr.deathTime;
    if (death != null && im.t > death + 1) continue;
    const d = Math.hypot(s.x - im.x, s.z - im.z);
    if (d < bestD) {
      bestD = d;
      victim = tr.entityId;
    }
  }
  return victim;
}

/** Smoke clusters join to the ship nearest their first puff when it
 *  appeared (smoke spawns at the generator's stern); no ship within
 *  reach → unattributed, no chip. */
function attributeSmokes(
  src: ShipStatusSource,
  out: Map<number, ShipStatusIndex>,
  shipTrajs: EntityTrajectory[],
): void {
  for (const cl of src.smokes) {
    let owner: number | null = null;
    let bestD = 400;
    for (const tr of shipTrajs) {
      const s = sampleAt(tr, cl.t0);
      if (!s) continue;
      const death = tr.deathTime;
      if (death != null && cl.t0 > death) continue;
      const d = Math.hypot(s.x - cl.x, s.z - cl.z);
      if (d < bestD) {
        bestD = d;
        owner = tr.entityId;
      }
    }
    if (owner == null) continue;
    out.get(owner)?.smokes.push({ t0: cl.t0, t1: cl.endT });
  }
  for (const idx of out.values()) idx.smokes.sort((a, b) => a.t0 - b.t0);
}
