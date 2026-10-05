/**
 * Combat range indicators for the replay viewer — the replay-side take on
 * the in-game minimap "ranges" mod. One dashed circle per weapon/consumable
 * around the RECORDED player's ship (the replay's own ship, not the camera
 * selection), each in its own colour with the range in km tagged at the
 * circle's 12-o'clock mark on the 2D minimap; the same colours reappear as
 * dashed rings on the 3D sea surface.
 *
 * All ranges are STOCK capability values (no per-player equipment), drawn
 * from the baked assets: `ship_live_stats.json` (main/sec/torpedo/AA/
 * concealment) and `ship_consumable_kit.json` (radar `radarM`, hydro
 * `hydroM`, in metres). 1 world unit = 30 m (see weather.ts).
 */
import { reactive, watch, type WatchStopHandle } from "vue";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import kitRaw from "@/data/ship_consumable_kit.json";
import { shipLiveStats } from "@/features/replay/shipLiveStats";
import { PLANE_TYPES } from "./tactical/shellTypes";
import { circlePositions, OVERLAY_RING_ORDER } from "./screenOverlays";
import { sampleAt } from "./trajectoryMath";
import { M_PER_WORLD_UNIT } from "./weather";
import type { MapInternals } from "./mapInternals";

/** Every drawable ring kind. `vis` is special: its radius is the LIVE
 *  weather spotting cap, resolved at paint time (2D only). */
export const RING_KINDS = [
  "main",
  "secondary",
  "torpedo",
  "aa",
  "radar",
  "hydro",
  "detect",
  "vis",
] as const;

export type RingKind = (typeof RING_KINDS)[number];

/** CSS/ canvas colour per kind — shared verbatim by the 2D painter and the
 *  3D ring materials so the two surfaces always agree. */
export const RING_COLOR: Record<RingKind, string> = {
  main: "#ffd24a",
  secondary: "#ff9d5c",
  torpedo: "#ff6b6b",
  aa: "#b48cff",
  radar: "#5cc8ff",
  hydro: "#63e6be",
  detect: "#f1f5f9",
  vis: "#8fa8cf",
};

/** Numeric colour twin for three.js materials. */
export function ringColorNum(kind: RingKind): number {
  return Number.parseInt(RING_COLOR[kind].slice(1), 16);
}

/** Range in metres → world units (the scene/ minimap share the replay's
 *  raw world coordinates). */
export function metersToUnits(m: number): number {
  return m / M_PER_WORLD_UNIT;
}

/** Range tag ("20.7", "8") for a ring's km value — trailing ".0" trimmed,
 *  the same formatting the in-game ranges mod uses. Shared by the minimap
 *  painter's 12-o'clock tags and the weather badge's visibility readout. */
export function ringLabelKm(meters: number): string {
  return (meters / 1000).toFixed(1).replace(/\.0$/, "");
}

/** One static range circle around the recorder's ship. */
export interface RangeRingDef {
  kind: RingKind;
  /** Stock range in metres. */
  meters: number;
}

type KitEntry = { h?: number; s?: number; r?: number; radarM?: number; hydroM?: number };
const KIT = kitRaw as Record<string, KitEntry>;

/** Resolve the recorder's stock range set from the baked assets; missing
 *  sources simply drop out (a BB yields no torpedo ring, a no-radar ship
 *  no radar ring). Order follows RING_KINDS for stable stacking. */
export function resolveSelfRings(shipId: number | string | null | undefined): RangeRingDef[] {
  if (shipId == null) return [];
  const key = String(shipId);
  const stats = shipLiveStats(key);
  const kit = KIT[key];
  const byKind = new Map<RingKind, number>();
  const km = (v: number | undefined) => (typeof v === "number" && v > 0 ? v * 1000 : null);
  const put = (kind: RingKind, meters: number | null) => {
    if (meters != null && meters > 0) byKind.set(kind, meters);
  };
  put("main", km(stats?.main));
  put("secondary", km(stats?.sec));
  put("torpedo", km(stats?.torp));
  put("detect", km(stats?.det));
  const aaFar = stats?.aa
    ? Math.max(
        ...[stats.aa.near?.r, stats.aa.medium?.r, stats.aa.far?.r].map((r) =>
          typeof r === "number" ? r : 0,
        ),
      )
    : 0;
  put("aa", aaFar > 0 ? aaFar * 1000 : null);
  put("radar", kit?.radarM ?? null);
  put("hydro", kit?.hydroM ?? null);
  return RING_KINDS.filter((k) => k !== "vis" && byKind.has(k)).map((k) => ({
    kind: k,
    meters: byKind.get(k)!,
  }));
}

// ── Preferences ──────────────────────────────────────────────────────────

export interface RangeRingPrefs {
  /** Master switch — the whole indicator family. */
  enabled: boolean;
  /** Draw the dashed circles + km tags on the 2D minimap (both sizes). */
  show2d: boolean;
  /** Draw the dashed rings on the 3D sea surface. */
  show3d: boolean;
  kinds: Record<RingKind, boolean>;
}

// v2: v1 shipped `enabled: false` behind an off-state switch that was all
// but invisible on the dark HUD modal — the family looked configured while
// the master switch was off and nothing drew. v2 defaults ON (the feature
// is opt-out now) and everyone starts fresh.
const PREFS_KEY = "wowsp.holo.rangeRings.v2";

function defaultPrefs(): RangeRingPrefs {
  return {
    enabled: true,
    show2d: true,
    show3d: true,
    kinds: {
      main: true,
      secondary: false,
      torpedo: true,
      aa: true,
      radar: true,
      hydro: true,
      detect: false,
      vis: true,
    },
  };
}

function loadPrefs(): RangeRingPrefs {
  const base = defaultPrefs();
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<RangeRingPrefs>;
    return {
      ...base,
      ...saved,
      kinds: { ...base.kinds, ...(saved.kinds ?? {}) },
    };
  } catch {
    return base;
  }
}

/** Module-level reactive prefs, persisted to localStorage on change. One
 *  instance backs the settings modal, the 2D painter and the 3D rings. */
export const rangeRingPrefs = reactive(loadPrefs());

let persistStop: WatchStopHandle | null = null;
/** Persist on change. Arming (not the import itself) is what avoids write
 *  side effects in tests — reading the stored prefs at module load is
 *  harmless and try/catch-guarded; the lazy arm keeps unit tests from
 *  arming timers/watchers they never tear down. */
export function armRangeRingPrefsPersist(): void {
  if (persistStop != null) return;
  persistStop = watch(rangeRingPrefs, () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(rangeRingPrefs));
    } catch {
      // Private-browsing quota failures just lose the preference.
    }
  }, { deep: true });
}

// ── Live modifiers (spotter / smoke) + radius animation ─────────────────
//
// The stock circles are a capability snapshot; two battle states move them
// for real and the rings must follow: an own SPOTTER AIRCRAFT aloft lifts
// MAIN-battery firing range (the consumable's +20 % — the standard bonus;
// per-ship modifiers live in full GameParams the viewer never sees, and
// secondaries are unaffected in game), and sitting inside a smoke cloud
// collapses surface detectability to the 2 km assured-acquisition ring.
// Both surfaces animate radius changes so the transition reads as the
// circle breathing, not teleporting.

/** Gun-range multiplier while the recorder's spotter plane is airborne
 *  (stock consumable bonus; see the block comment above). */
const SPOTTER_RANGE_MULT = 1.2;
/** Concealment (m) shown while inside smoke — assured acquisition. */
const SMOKE_DETECT_M = 2000;
/** Seconds a squadron stays "airborne" after its last seen event when no
 *  explicit removal arrives (spotter work times run 90–120 s). */
const SQUADRON_GRACE_S = 120;

/** Whether the recorder's own spotter plane is airborne at battle second
 *  `t` — the minimap squadron stream's `scout` type owned by the self
 *  entity, from its first add until the matching removal (or the grace
 *  window). Teammates' spotters never count. */
export function selfSpotterActive(
  minimapAdds: { time: number; planeId: number; ownerId: number; paramsId: number }[],
  minimapRemoves: { time: number; planeId: number }[],
  selfEntityId: number | null,
  t: number,
): boolean {
  if (selfEntityId == null) return false;
  for (const a of minimapAdds) {
    if (a.ownerId !== selfEntityId) continue;
    if (PLANE_TYPES[String(a.paramsId)]?.type !== "scout") continue;
    if (t < a.time) continue;
    let end = a.time + SQUADRON_GRACE_S;
    for (const r of minimapRemoves) {
      if (r.planeId === a.planeId && r.time > a.time && r.time < end) {
        end = r.time;
      }
    }
    if (t <= end) return true;
  }
  return false;
}

/** Whether the recorder sits inside a smoke cloud at battle second `t` —
 *  within ~1.3 km of a puff cluster's DRIFTING centre (the cluster's own
 *  trajectory sampled at the playhead, falling back to its anchor) while
 *  the screen holds. */
export function selfInSmoke(
  clusters: SmokeClusterLike[],
  selfWorldX: number,
  selfWorldZ: number,
  t: number,
): boolean {
  // Puff spread: a WoWS cloud reads ~0.9 km across; 1.3 km of slack covers
  // the drifting puffs and neighbouring clouds of one screen.
  const R = 42;
  for (const cl of clusters) {
    if (t < cl.t0 || t > cl.endT) continue;
    const drift = cl.traj ? sampleAt(cl.traj, Math.min(t, cl.lastT)) : null;
    const cx = drift?.x ?? cl.sx;
    const cz = drift?.z ?? cl.sz;
    const d = Math.hypot(cx - selfWorldX, cz - selfWorldZ);
    if (d <= R) return true;
  }
  return false;
}

/** The smoke-cluster slice selfInSmoke needs (the real SmokeClusterState
 *  satisfies this structurally). */
export interface SmokeClusterLike {
  sx: number;
  sz: number;
  t0: number;
  lastT: number;
  endT: number;
  traj: { samples: { time: number; x: number; z: number; yaw: number }[] } | null;
}

/** The ring's live target in metres at battle second `t` (base = stock). */
export function dynamicRingMeters(
  ctx: MapInternals,
  t: number,
  kind: RingKind,
  baseMeters: number,
): number {
  if (kind === "main") {
    const self = ctx.shipMarkers.find((m) => m.userData.role === "self");
    const selfId = self ? (self.userData.entityId as number) : null;
    if (
      selfSpotterActive(
        ctx.props.minimapSquadronAdds,
        ctx.props.minimapSquadronRemoves,
        selfId,
        t,
      )
    ) {
      return baseMeters * SPOTTER_RANGE_MULT;
    }
  }
  if (kind === "detect") {
    const self = ctx.shipMarkers.find((m) => m.userData.role === "self");
    if (self && selfInSmoke(ctx.smokeClusters, self.position.x, -self.position.z, t)) {
      return SMOKE_DETECT_M;
    }
  }
  return baseMeters;
}

// Radius animation: one eased value per kind, stepped by wall clock so the
// circles keep breathing while paused. Scrub-safe: the target is always
// recomputed from battle state; only the presentation eases.
const ringAnim = new Map<
  RingKind,
  { cur: number; tgt: number; at: number; base: number }
>();
/** Exponential-smoothing time constant (ms) — ~0.4 s to settle visually. */
const RING_ANIM_TAU = 110;

/** Step the animation for one kind toward its target and return the eased
 *  metres for this frame. */
export function animatedRingMeters(
  kind: RingKind,
  targetMeters: number,
  nowMs: number = performance.now(),
): number {
  const st = ringAnim.get(kind);
  if (!st) {
    ringAnim.set(kind, { cur: targetMeters, tgt: targetMeters, at: nowMs, base: 0 });
    return targetMeters;
  }
  st.tgt = targetMeters;
  const dt = Math.max(0, nowMs - st.at);
  st.at = nowMs;
  if (dt > 0) {
    st.cur = st.cur + (st.tgt - st.cur) * (1 - Math.exp(-dt / RING_ANIM_TAU));
  }
  if (Math.abs(st.tgt - st.cur) < 1) st.cur = st.tgt;
  return st.cur;
}

/** Drop the animation state (tests / hard resets). */
export function resetRingAnim(): void {
  ringAnim.clear();
}

/** Keep the eased radii across an actor rebuild when the underlying ring
 *  set is unchanged: the labels array re-assigns several times per load
 *  (trajectories/roster/encyclopedia watchers), and a rebuild landing
 *  mid-spotter must not snap the circle back to stock and re-ease. An
 *  entry whose base is a CONFIRMED different value (replay switch) is
 *  dropped; base 0 marks entries seeded lazily by the painter against the
 *  live set (their eased value is worth keeping), and kinds absent from
 *  `defs` (the live weather ring, which has no stock base) keep theirs. */
function preserveRingAnimAcrossRebuild(defs: { kind: RingKind; meters: number }[]): void {
  const bases = new Map(defs.map((d) => [d.kind, d.meters]));
  for (const [kind, st] of ringAnim) {
    const base = bases.get(kind);
    if (base != null && st.base !== 0 && st.base !== base) {
      ringAnim.delete(kind);
    }
  }
}

// ── 3D rings ─────────────────────────────────────────────────────────────

/** One dashed sea-surface ring in the 3D scene. */
export interface RangeRingSlot {
  kind: RingKind;
  line: Line2;
  /** The baked radius's stock metres — the scale denominator for the
   *  animated (spotter/smoke) radius. */
  baseMeters: number;
}

/** Pixel linewidth of the 3D range rings (screen-constant, like the cap
 *  rings but a touch finer — up to 7 rings stack around one ship). */
const RANGE_RING_PX = 2;

/** Build the 3D dashed rings for a resolved set (replacing any previous
 *  set). Radius stays in world units; the ring sits just above the cap
 *  rings (y 1.2) and its LineMaterial joins the overlay-resolution pool so
 *  the pixel linewidth survives resizes. Dash size scales with the radius
 *  so a 5 km hydro ring and a 20 km gun ring read with the same dash
 *  density. */
export function buildRangeRings(ctx: MapInternals, defs: RangeRingDef[]): void {
  disposeRangeRings(ctx);
  preserveRingAnimAcrossRebuild(defs);
  // Confirm the bases (and adopt painter-seeded entries) so the NEXT
  // rebuild can tell same-set rebuilds (keep the ease) from replay
  // switches (snap fresh).
  const nowMs = performance.now();
  for (const d of defs) {
    const st = ringAnim.get(d.kind);
    if (st) {
      st.base = d.meters;
    } else {
      ringAnim.set(d.kind, { cur: d.meters, tgt: d.meters, at: nowMs, base: d.meters });
    }
  }
  const scene = ctx.api.value?.scene;
  if (!scene) return;
  for (const def of defs) {
    if (def.kind === "vis") continue; // live weather cap: 2D-only
    const radius = Math.max(10, metersToUnits(def.meters));
    const geom = new LineGeometry();
    geom.setPositions(circlePositions(radius));
    const dash = (radius * Math.PI * 2) / 48;
    const mat = new LineMaterial({
      color: ringColorNum(def.kind),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      linewidth: RANGE_RING_PX,
      dashed: true,
      dashScale: 1,
      dashSize: dash,
      gapSize: dash,
    });
    const line = new Line2(geom, mat);
    line.computeLineDistances();
    line.visible = false;
    // Above the weather mask (see weatherScene.STORM_ORDER) so the km
    // tags stay crisp when the storm darkens the sea under them.
    line.renderOrder = OVERLAY_RING_ORDER;
    scene.add(line);
    ctx.overlayLineMats.push(mat);
    ctx.rangeRingSlots.push({ kind: def.kind, line, baseMeters: def.meters });
  }
}

/** Dispose the current 3D ring set (scene + GPU). */
export function disposeRangeRings(ctx: MapInternals): void {
  const scene = ctx.api.value?.scene;
  for (const slot of ctx.rangeRingSlots) {
    if (scene) scene.remove(slot.line);
    slot.line.geometry.dispose();
    const mat = slot.line.material as LineMaterial;
    mat.dispose();
    const i = ctx.overlayLineMats.indexOf(mat);
    if (i >= 0) ctx.overlayLineMats.splice(i, 1);
  }
  ctx.rangeRingSlots = [];
}

/** Reposition/hide the 3D rings for battle second `t`: they follow the
 *  recorder's marker and obey the prefs + the ship's liveness. Called from
 *  the playhead tick AND the RAF loop so the spotter/smoke radius ease
 *  keeps stepping while paused. */
export function updateRangeRings(ctx: MapInternals, t: number): void {
  const on = rangeRingPrefs.enabled && rangeRingPrefs.show3d;
  const self = ctx.shipMarkers.find((m) => m.userData.role === "self");
  const firstT = self ? (self.userData.firstT as number | undefined) : undefined;
  const deathTime = self ? (self.userData.deathTime as number | null) : null;
  const alive =
    self != null && t >= (firstT ?? 0) && (deathTime == null || t < deathTime);
  for (const slot of ctx.rangeRingSlots) {
    if (!on || !alive || !rangeRingPrefs.kinds[slot.kind]) {
      slot.line.visible = false;
      continue;
    }
    const meters = animatedRingMeters(
      slot.kind,
      dynamicRingMeters(ctx, t, slot.kind, slot.baseMeters),
    );
    slot.line.visible = true;
    // The geometry bakes the stock radius; the animated (spotter/smoke)
    // radius rides a uniform scale so no buffers rebuild per frame.
    const bakedUnits = metersToUnits(slot.baseMeters);
    slot.line.scale.setScalar(metersToUnits(meters) / bakedUnits);
    slot.line.position.set(self!.position.x, 1.2, self!.position.z);
  }
}
