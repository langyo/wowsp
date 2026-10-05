/**
 * Global-weather (cyclone / storm) timeline for the replay viewer.
 *
 * WoWS streams the map's global weather through the BattleLogic entity as
 * `state.weather.globalWeather` nested-property updates, decoded by the
 * Rust side into two streams:
 *  - transitions `{startTime, endTime, fromParam, toParam}` — across that
 *    window the server lerps every weather-logic field linearly toward the
 *    target param's values;
 *  - notifications `{atTime, param}` — the in-game "weather incoming"
 *    warning, broadcast well before the transition starts.
 *
 * The params are GlobalWeather GameParams entries. The table below bakes
 * their logic values (ship-spotting cap in world units, "badness" 0..1)
 * from a 15.8 GameParams dump so the viewer reproduces exactly what the
 * client rendered without a game install — verified against a real cyclone
 * replay: lerping maxShipVisionDistance 2000 → 266.6664 across [421 s,
 * 541 s] matches the avatar's per-second weatherParams stream value for
 * value (266.6664 × 30 m = 8 km, the in-game cyclone spotting cap).
 */

/** BigWorld distance unit → metres (wows-core BW_TO_METERS; the same factor
 *  the consumable-kit extractor applies to radar/hydro `distShip`). */
export const M_PER_WORLD_UNIT = 30;

/** Raw timeline entries — camelCase mirrors of
 *  `wowsp_tauri_shared::{WeatherTransition, WeatherNotification}`. */
export interface WeatherTransition {
  /** Packet clock when the update arrived. */
  time: number;
  /** Interpolation window start (battle seconds). */
  startTime: number;
  /** Interpolation window end (battle seconds). */
  endTime: number;
  fromParam: number;
  toParam: number;
}

export interface WeatherNotification {
  /** Packet clock when the update arrived. */
  time: number;
  /** Battle second the announced weather lands. */
  atTime: number;
  param: number;
}

/** How a weather param presents in the HUD. */
export type WeatherKind = "cyclone" | "storm" | "snowstorm" | "cvc" | "calm" | "other";

interface WeatherParamInfo {
  kind: WeatherKind;
  /** Ship-spotting cap in world units (null when the param has no global
   *  logic — local-weather visuals the replay never references). */
  visUnits: number | null;
  /** Weather "badness" 0..1 — drives the minimap darkening. */
  bad: number;
}

/** GameParams id → logic slice (15.8 dump; ids are stable across builds —
 *  the PCOW family hashes haven't moved in years). Values are data-faithful:
 *  e.g. PCOW016 (an event-map storm) caps vision at 587 units yet carries
 *  badness 0 — the badge then reports the restriction while the minimap
 *  stays clear, exactly what the param encodes. */
const WEATHER_PARAMS: Record<number, WeatherParamInfo> = {
  4293183408: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW001_Sunny
  4292134832: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW002_Storm (visual only)
  4291086256: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW003_Cloudy
  4290037680: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW004_Snowstorm (visual)
  4288989104: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW005_Evening
  4286891952: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW007_Dull
  4285843376: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW008_Morning
  4282697648: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW011_Night
  4271163312: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW022_GlobalWeather
  4266969008: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW026_Rain (visual only)
  4261726128: { kind: "calm", visUnits: 2000, bad: 0 }, // PCOW031_PREBATTLE_Storm
  4277454768: { kind: "storm", visUnits: 587, bad: 0 }, // PCOW016_USS_CL_Storm (event)
  4287940528: { kind: "cyclone", visUnits: 266.6664, bad: 1 }, // PCOW006_Storm_Logic
  4283746224: { kind: "cyclone", visUnits: 266.6664, bad: 1 }, // PCOW010_Rain_Logic
  4284794800: { kind: "snowstorm", visUnits: 266.6664, bad: 1 }, // PCOW009_Snowstorm_Logic
  4269066160: { kind: "storm", visUnits: 399.9996, bad: 1 }, // PCOW024_Rain_Logic_12km
  4268017584: { kind: "storm", visUnits: 399.9996, bad: 1 }, // PCOW025_Storm_Logic_12km
  4275357616: { kind: "storm", visUnits: 570, bad: 1 }, // PCOW018_USS_CL_Light_Big
  4265920432: { kind: "cvc", visUnits: 1333.332, bad: 1 }, // PCOW027_CvC_Logic_Cloudy
  4264871856: { kind: "cvc", visUnits: 466.6662, bad: 1 }, // PCOW028_CvC_Logic
  4263823280: { kind: "cvc", visUnits: 433.3329, bad: 1 }, // PCOW029_CvCWeather_Logic_13km
  4262774704: { kind: "cvc", visUnits: 1333.332, bad: 1 }, // PCOW030_CvCWeather_Logic_40km
};

const UNKNOWN_PARAM: WeatherParamInfo = { kind: "other", visUnits: null, bad: 0 };

export function weatherParamInfo(id: number): WeatherParamInfo {
  return WEATHER_PARAMS[id] ?? UNKNOWN_PARAM;
}

/** Restrictive weather caps spotting below the normal 2000-unit (60 km)
 *  ceiling — the badge treats every such param as a real restriction. */
const RESTRICTIVE_MAX_UNITS = 1500;

/** Whether a param caps spotting at all (drives the "weather restriction"
 *  framing of the HUD badge). */
export function weatherParamRestrictive(id: number): boolean {
  const vis = weatherParamInfo(id).visUnits;
  return vis != null && vis < RESTRICTIVE_MAX_UNITS;
}

/** Weather state at battle second `t`, or null when the sky is clear and
 *  nothing is announced. Scrub-safe — recomputed from the timelines, never
 *  incremented. */
export interface WeatherView {
  phase: "incoming" | "shifting" | "active" | "clearing";
  /** 0..1 progress through the active transition (1 once settled). */
  progress: number;
  /** Target weather kind (what the sky is becoming). */
  kind: WeatherKind;
  /** Source weather kind — the badge names THIS one while a storm clears. */
  fromKind: WeatherKind;
  /** Current ship-spotting cap in world units — the lerped live value the
   *  in-game HUD showed (null when either param is unknown). */
  visUnits: number | null;
  /** Current badness 0..1 (minimap darkening strength). */
  badness: number;
  /** Seconds until the announced weather lands (incoming phase only). */
  etaSeconds: number | null;
  /** The announced/target weather's spotting cap in world units (known for
   *  incoming notifications and transitions; null = unknown param). */
  targetVisUnits: number | null;
  /** True when the target param actually restricts spotting. */
  restrictive: boolean;
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

/** Weather state at time `t`; null when clear with nothing announced. */
export function weatherStateAt(
  transitions: WeatherTransition[],
  notifications: WeatherNotification[],
  t: number,
): WeatherView | null {
  // The last REAL change whose window has begun wins. The server also
  // re-asserts the current item mid-state (a same-param window, e.g. the
  // Rain→Rain re-send that re-baselines the cyclone's end time) — those
  // carry no state change and must not mask an earlier real transition
  // that is still (or already fully) in effect.
  let active: WeatherTransition | null = null;
  for (const tr of transitions) {
    if (tr.startTime <= t && tr.fromParam !== tr.toParam) active = tr;
  }
  if (active && active.fromParam !== active.toParam) {
    const span = Math.max(1, active.endTime - active.startTime);
    const p = Math.min(1, Math.max(0, (t - active.startTime) / span));
    const from = weatherParamInfo(active.fromParam);
    const to = weatherParamInfo(active.toParam);
    const visUnits =
      from.visUnits != null && to.visUnits != null
        ? lerp(from.visUnits, to.visUnits, p)
        : null;
    const clearing = to.kind === "calm";
    if (!clearing || p < 1) {
      return {
        phase: clearing ? "clearing" : p < 1 ? "shifting" : "active",
        progress: p,
        kind: to.kind,
        fromKind: from.kind,
        visUnits,
        badness: lerp(from.bad, to.bad, p),
        etaSeconds: null,
        targetVisUnits: to.visUnits,
        restrictive: weatherParamRestrictive(active.toParam),
      };
    }
    // A finished lift is clear skies — only a still-pending announcement
    // (checked below) can bring the badge back.
  }
  // No change underway — the earliest still-pending announcement becomes
  // the "incoming" warning (the in-game banner).
  for (const n of notifications) {
    if (n.atTime > t) {
      const to = weatherParamInfo(n.param);
      return {
        phase: "incoming",
        progress: 0,
        kind: to.kind,
        fromKind: "calm",
        visUnits: null,
        badness: 0,
        etaSeconds: n.atTime - t,
        targetVisUnits: to.visUnits,
        restrictive: weatherParamRestrictive(n.param),
      };
    }
  }
  return null;
}

/** Current spotting cap in km (helper for HUD readouts). */
export function weatherVisKm(view: WeatherView | null): number | null {
  if (!view || view.visUnits == null) return null;
  return (view.visUnits * M_PER_WORLD_UNIT) / 1000;
}

// ── Minimap storm-zone geometry ─────────────────────────────────────────
//
// The global cyclone darkens the whole map, but the client renders it as a
// huge dark front that slowly sweeps the sea rather than a flat tint. The
// replay carries no zone geometry (the client derives it procedurally), so
// the painter reproduces the presentation: a map-wide tint whose strength
// follows `badness`, plus a large "storm core" disc drifting across the
// map. The drift is deterministic per match — seeded by the first
// transition's window start so scrubbing back and forth replays the same
// path.

export interface CycloneZoneGeo {
  /** Storm-core centre in WORLD coordinates (x, z with +z north). */
  cx: number;
  cz: number;
  /** Core radius in world units. */
  radius: number;
}

/** Deterministic drift direction for a match (unit vector, world xz). */
function driftDirection(seedT: number): { dx: number; dz: number } {
  const a = ((seedT * 2654435761) % 360) * (Math.PI / 180);
  return { dx: Math.cos(a), dz: Math.sin(a) };
}

/** Storm-core disc at battle second `t`. Crosses the map along its drift
 *  direction over a full battle, starting one core-radius outside the
 * centre so the front visibly rolls in. */
export function cycloneZoneAt(
  mapMinX: number,
  mapMaxX: number,
  mapMinZ: number,
  mapMaxZ: number,
  badness: number,
  t: number,
  seedT: number,
): CycloneZoneGeo {
  const w = mapMaxX - mapMinX;
  const h = mapMaxZ - mapMinZ;
  const midX = (mapMinX + mapMaxX) / 2;
  const midZ = (mapMinZ + mapMaxZ) / 2;
  const radius = 0.62 * Math.max(w, h);
  // ~1.2 world units/s (≈36 m/s) — a battle-length traverse, "slowly
  // moving" at map scale exactly like the in-game front.
  const speed = 1.2;
  const { dx, dz } = driftDirection(seedT);
  const travel = (t - seedT) * speed;
  const half = Math.max(w, h) * 0.75;
  const off = Math.max(-half, Math.min(half, travel - radius * 0.5)) - half * 0.35;
  // Fade the disc in with badness so the approach reads as weather, not a
  // blob: before the transition starts the tint alone carries the signal.
  const cx = midX + dx * off;
  const cz = midZ + dz * off;
  return { cx, cz, radius: radius * (0.55 + 0.45 * badness) };
}

/** Drift seed for a match's storm front: the first transition that turns
 *  RESTRICTIVE (the weather event proper), else the battle's opening
 *  window. Shared by the 2D painter and the 3D storm mask so both surfaces
 *  drift the same core along the same path — and stay scrub-safe (the seed
 *  is stable per match, never "now"). */
export function cycloneDriftSeed(transitions: WeatherTransition[]): number {
  return (
    transitions.find(
      (tr) => tr.fromParam !== tr.toParam && weatherParamRestrictive(tr.toParam),
    )?.startTime ??
    transitions[0]?.startTime ??
    0
  );
}

/** Storm-core colour (dark blue-black) — the 3D mask twin of the 2D fill
 *  helpers' rgb(4, 7, 16) core, so the two surfaces darken identically. */
export const STORM_CORE_HEX = 0x040710;

/** Paint-helper: rgba fill for the map-wide weather tint. */
export function weatherTintStyle(badness: number): string {
  return `rgba(7, 11, 22, ${(0.34 * badness).toFixed(3)})`;
}

/** Paint-helper: rgba fill for the drifting storm core. */
export function weatherCoreStyle(badness: number): string {
  return `rgba(4, 7, 16, ${(0.42 * badness).toFixed(3)})`;
}
