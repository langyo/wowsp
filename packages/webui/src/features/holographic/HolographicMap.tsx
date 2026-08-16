import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import { Crosshair, Shield, Skull, Swords } from "lucide-vue-next";
import planeTypesRaw from "../../data/plane_types.json";
import shellTypesRaw from "../../data/shell_types.json";

import { SCENE_THEMES, scenePalette, useThreeScene } from "./useThreeScene";
import { useTheme } from "@/theme/useTheme";
import {
  resolveMapModelUrl,
  resolveMapMinimapUrl,
  resolveShipModelForEntry,
  resolveShipModelByShipId,
  resolvePlaneModelUrl,
  resolvePropModelUrl,
  shipNameFromModelDb,
  shipNameFromOfflineDb,
  shipModelStem,
  shipSilhouetteUrl,
  shipOfflineEntry,
  loadGlbModel,
  loadMapBounds,
  loadSilhouettes,
  type MapBounds,
  type ShipModelSpec,
} from "./modelLoader";
import { makeHoloContourMaterial } from "./holoContourShader";
import { buildShipMarker, buildMarkerFromSource, disposeMarker, clearShipMarkerCache } from "./shipMarker";
import { buildPropMarker, clearPropMarkerCache } from "./propMarker";
import { TEAM_COLOR, roleFromRelation, type TeamRole } from "./teamColors";
import type {
  CameraSample,
  EntityTrajectory,
  ExplosionEvent,
  HpSample,
  NetStatsSample,
  ShipInfo,
  SquadronCreate,
  SquadronPlane,
  TorpedoLaunch,
  VehicleEntry,
  WeaponLockEvent,
} from "@/api";
import planeIcon from "./planeIcons";
import { shipIconUrl, shipTypeClass } from "./shipIcons";
import {
  HoloScorebar, HoloLabel, HoloShipCard, registerHoloShipIcons,
  captureSecondsRemaining, formatEta,
  type HoloCapZone, type HoloHudState, type HoloShip, type HoloShipCardData,
} from "@wowsp/holo";

// The shared scorebar renders the game's own HUD icons — register the
// bundled URLs once (same PNGs the minimap canvas uses).
for (const variant of ["ally", "enemy", "sunk"] as const) {
  registerHoloShipIcons(variant, {
    battleship: shipIconUrl("battleship", variant) ?? undefined,
    cruiser: shipIconUrl("cruiser", variant) ?? undefined,
    destroyer: shipIconUrl("destroyer", variant) ?? undefined,
    aircarrier: shipIconUrl("aircarrier", variant) ?? undefined,
    submarine: shipIconUrl("submarine", variant) ?? undefined,
    auxiliary: shipIconUrl("auxiliary", variant) ?? undefined,
  });
}
import { parsePostBattle } from "@/features/replay/postBattle";

/** Per-plane local offsets inside ONE flight group (the group's own wedge):
 *  1 → single, 2 → side by side, 3 → arrow (1 lead + 2 wing), 4+ → 2 up front
 *  and the rest trailing. Positive oz is BACKWARD along the heading (the
 *  leader flies at the front of the formation). */
function groupInnerOffsets(n: number): { ox: number; oz: number }[] {
  const p = 9;
  if (n <= 1) return [{ ox: 0, oz: 0 }];
  if (n === 2) return [{ ox: -p, oz: 0 }, { ox: p, oz: 0 }];
  if (n === 3) return [{ ox: 0, oz: -p }, { ox: -p, oz: p }, { ox: p, oz: p }];
  const out: { ox: number; oz: number }[] = [
    { ox: -p, oz: -p },
    { ox: p, oz: -p },
  ];
  for (let i = 2; i < n; i++) {
    out.push({ ox: (i % 2 === 0 ? -1 : 1) * p, oz: p });
  }
  return out;
}

/** Filled-wedge layout over flight GROUPS: row r holds r+1 groups (1, 2, 3,
 *  …); a leftover group that cannot fill the next row sits centered in it.
 *  Examples: 6 groups → rows 1,2,3; 4 groups → 1,2,1; 7 → 1,2,3,1. */
function formationOffsets(groupCount: number, groupSize: number): { ox: number; oz: number }[] {
  const out: { ox: number; oz: number }[] = [];
  let rem = groupCount;
  const rows: number[] = [];
  for (let r = 0; rem > 0; r++) {
    const n = Math.min(r + 1, rem);
    rows.push(n);
    rem -= n;
  }
  const gSpacing = 20;
  const gDepth = 15;
  rows.forEach((n, r) => {
    for (let k = 0; k < n; k++) {
      const gx = (k - (n - 1) / 2) * gSpacing;
      const gz = -r * gDepth;
      for (const it of groupInnerOffsets(groupSize)) {
        out.push({ ox: gx + it.ox, oz: gz + it.oz });
      }
    }
  });
  return out;
}

/** Infer the squadron's group layout by greedy-clustering the aircraft
 *  positions right after launch: planes spawn in groups (2/group, 3/group,
 *  …), so the median cluster size is the per-group count and the cluster
 *  count is the number of flight groups. */
function inferGrouping(
  entries: { trail: { id: number; samples: SquadronPlane[] } }[],
  sampleAtFn: (tr: { samples: SquadronPlane[] }, t: number) => { x: number; z: number } | null,
): { groupSize: number; groupCount: number } {
  const t0 = Math.min(...entries.map((e) => e.trail.samples[0]?.time ?? 0));
  const pts: { x: number; z: number }[] = [];
  for (const e of entries) {
    const s = sampleAtFn(e.trail, t0 + 0.05);
    if (s) pts.push(s);
  }
  if (pts.length < 2) return { groupSize: 1, groupCount: Math.max(1, pts.length) };
  const clusters: { members: { x: number; z: number }[]; cx: number; cz: number }[] = [];
  for (const p of pts) {
    let best: (typeof clusters)[number] | null = null;
    let bestD = 45;
    for (const c of clusters) {
      const d = Math.hypot(c.cx - p.x, c.cz - p.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) {
      best.members.push(p);
      best.cx = best.members.reduce((a, q) => a + q.x, 0) / best.members.length;
      best.cz = best.members.reduce((a, q) => a + q.z, 0) / best.members.length;
    } else {
      clusters.push({ members: [p], cx: p.x, cz: p.z });
    }
  }
  const sizes = clusters.map((c) => c.members.length).sort((a, b) => a - b);
  return {
    groupSize: sizes[Math.floor(sizes.length / 2)] || 1,
    groupCount: clusters.length,
  };
}

/** paramsId → plane metadata (index/name/type/count) baked from GameParams by
 *  `scripts/model_convert/extract_planes.py` — the type drives which in-game
 *  aircraft icon the minimap uses; `count` is the full squadron size. */
const PLANE_TYPES = planeTypesRaw as Record<
  string,
  { index: string; name: string; type: string; count?: number }
>;
/** Shell encyclopedia (paramsId → ammo/tint) baked from GameParams by
 *  `scripts/model_convert/extract_shells.py`. */
const SHELL_TYPES = shellTypesRaw as Record<
  string,
  { name: string; ammo: string; tint: number[] | null }
>;
/** Shell-flight colors per ammo type: HE yellow, AP silver, SAP grey. */
const SHELL_COLORS: Record<string, number> = {
  HE: 0xffcc33,
  AP: 0xc8d0e0,
  SAP: 0x9aa0a8,
  CS: 0xffa07a,
};

/** Resolve a shell's ammo family (+ color) from its GameParams id. SAP shells
 *  are stored as AP in the game data — detect them by name. */
function shellAmmoOf(paramsId?: number): { ammo: string; color: number } {
  if (paramsId == null) return { ammo: "unknown", color: 0xffe08a };
  const info = SHELL_TYPES[String(paramsId)];
  if (!info) return { ammo: "unknown", color: 0xffe08a };
  const ammo =
    info.ammo === "AP" && info.name.toUpperCase().includes("SAP")
      ? "SAP"
      : info.ammo;
  const color = SHELL_COLORS[ammo] ?? 0xffe08a;
  return { ammo, color };
}
import { tierToRoman } from "@/utils/tierRoman";
import BattleIcon from "@/components/base/BattleIcon";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useStatsStore } from "@/stores/stats";
import { useAccountStore } from "@/stores/account";
import { useLanguage } from "@/i18n/useLanguage";
import SCheckbox from "@/components/base/SCheckbox";
import { t as i18nT } from "@/i18n";
import "./HolographicMap.scss";

/**
 * The holographic battle map. Renders every entity's decoded trajectory (M3)
 * as a colored line, plus a ship marker at the current playback time that
 * points along its heading. A time slider scrubs the whole match.
 *
 * Map terrain: if a converted GLB for this map's space id exists under
 * `src/res/models/maps/<spaceId>.glb`, it is loaded and added to the scene.
 * Otherwise the scene falls back to the GridHelper sea plane (defined in
 * useThreeScene). Model loading is progressive — the app works without any
 * converted assets and enriches as the user runs the conversion scripts.
 *
 * Coordinates: WoWS world space is x=east, z=north (planar). We map (x,z)
 * straight onto the three.js XZ plane and drop y. Bounds auto-fit to the data.
 */
export default defineComponent({
  name: "HolographicMap",
  props: {
    replayPath: { type: String, default: "" },
    trajectories: { type: Array as () => EntityTrajectory[], default: () => [] },
    /** World-space shell impacts (receiveExplosions on the avatar). */
    explosions: { type: Array as () => ExplosionEvent[], default: () => [] },
    /** Torpedo launches (shootTorpedo on firing vehicles). */
    torpedoes: { type: Array as () => TorpedoLaunch[], default: () => [] },
    /** Recorder weapon-lock timeline (SetWeaponLock 0x30). */
    weaponLocks: { type: Array as () => WeaponLockEvent[], default: () => [] },
    /** Raw post-battle statistics JSON (BattleResults 0x22). */
    battleResults: { type: String, default: "" },    /** Replay protocol version (Version 0x16). */
    replayVersion: { type: String, default: "" },
    /** Map name from the Map packet (0x28). */
    mapNamePkt: { type: String, default: "" },
    /** Recorder camera timeline (Camera 0x25) — enables the original-view mode. */
    cameraFrames: { type: Array as () => CameraSample[], default: () => [] },
    /** Player net stats (PlayerNetStats 0x1d). */
    netStats: { type: Array as () => NetStatsSample[], default: () => [] },
    /** Entity id → last leave time (EntityLeave 0x04). */
    leavesMap: { type: Object as () => Record<string, number>, default: () => ({}) },
    /** Camera-mode changes (0x27). */
    cameraModes: { type: Array as () => HpSample[], default: () => [] },
    /** Aircraft squadrons (avatar receive_addSquadron / updateSquadron). */
    squadronCreates: { type: Array as () => SquadronCreate[], default: () => [] },
    squadronPlanes: { type: Array as () => SquadronPlane[], default: () => [] },
    /** Roster from the replay header — used to map trajectories to teams and
     *  resolve each ship's model. */
    vehicles: { type: Array as () => VehicleEntry[], default: () => [] },
    /** Ship encyclopedia (shipId → ShipInfo). Used to resolve tier/nation/type
     *  for per-ship model loading + tier-based fallback when a model is missing. */
    encyclopedia: { type: Object as () => Map<number, ShipInfo>, default: () => new Map() },
    /** Map space id (e.g. "15_NE_north") — used to load the terrain GLB. */
    mapId: { type: String, default: "" },
    /** Match group from the replay descriptor (pvp/ranked/clan/brawl/...). */
    matchGroup: { type: String, default: "" },
    /** Map space id, for applying per-map domination scoring overrides. */
    mapName: { type: String, default: "" },
    /** Initial playback position (match seconds). Deep-link/dev aid; clamped
     *  to the decoded duration once trajectories arrive. */
    initialTime: { type: Number, default: 0 },
    /** Open with the enlarged 2D minimap shown (deep-link/dev aid). */
    initialMinimapZoom: { type: Boolean, default: false },
  },
  setup(props) {
    const container = ref<HTMLElement | null>(null);
    const { ready, api } = useThreeScene(container, (_dt) => {
      updateLabelPositions();
      drawMinimap();
      if (originalView.value) applyOriginalCamera(current.value);
      else followSelected();
    });

    // Playback state.
    const duration = ref(0);
    const current = ref(0);
    const playing = ref(false);
    /** Playback speed multiplier; the dropdown sits next to the clock. */
    const playbackSpeed = ref(2);
    const speedMenuOpen = ref(false);
    const PLAYBACK_SPEEDS = [0.5, 1, 2, 3, 5, 10] as const;
    let playRaf = 0;
    let lastTick = 0;

    const showRoster = ref(false);
    // Toggle for the floating ship labels (info overlay).
    const showLabels = ref(true);
    /** Replay the recorder's original spectating camera (Camera 0x25 frames). */
    const originalView = ref(false);
    watch(originalView, (on) => {
      if (!on) {
        const ctrl = api.value?.controls;
        if (ctrl) ctrl.enabled = true;
      }
    });

    // Camera mode dropdown (upward-opening, replaces the old original-view
    // toggle): "free" (orbit), "original" (recorder camera) or "follow"
    // (chase a specific ship, picked from the grouped roster list). The
    // original-view bit is derived from the mode so the per-frame camera
    // dispatch (`applyOriginalCamera` vs `followSelected`) stays untouched.
    const cameraMenuOpen = ref(false);
    const cameraMode = ref<"free" | "original" | "follow">("free");
    watch(cameraMode, (m) => {
      originalView.value = m === "original";
      if (m !== "follow") selectedEntityId.value = null;
    });
    /** Player stats shown in the follow menu (entityId → "WR% · battles").
     *  Resolved lazily when the menu opens; missing/failed lookups render "—". */
    const followStats = ref<Map<number, string>>(new Map());
    let statsSeq = 0;
    async function loadFollowStats() {
      const realm = useAccountStore().activeAccount?.realm;
      if (!realm) return;
      const seq = ++statsSeq;
      const store = useStatsStore();
      const items = shipLabels.value.filter((l) => l.kind !== "plane");
      for (let i = 0; i < items.length; i += 6) {
        if (seq !== statsSeq) return;
        const batch = items.slice(i, i + 6);
        const results = await Promise.all(
          batch.map(async (it) => {
            if (followStats.value.has(it.entityId)) return null;
            try {
              const st = await store.lookup(it.name, realm);
              if (st.hidden || st.winrate == null || st.battles == null) return null;
              return [it.entityId, `${st.winrate.toFixed(1)}% · ${st.battles.toLocaleString()}`] as const;
            } catch {
              return [it.entityId, "—"] as const;
            }
          }),
        );
        if (seq !== statsSeq) return;
        for (const r of results) {
          if (r) followStats.value.set(r[0], r[1]);
        }
      }
    }
    watch(cameraMenuOpen, (open) => { if (open) void loadFollowStats(); });

    // First-person follow: the entity id whose marker the camera tracks
    // (null = free orbit). Set by clicking a ship marker/label.
    const selectedEntityId = ref<number | null>(null);
    // 2D minimap enlarged overlay state.
    const minimapZoom = ref(props.initialMinimapZoom);
    const minimapShowTrails = ref(true);
    /** Roster assignment per ship entity — THE single source of truth for
     *  team roles, shared by 3D markers, minimap trails, shell-arc targets
     *  and self-stats. Rebuilt in rebuildActors; empty before first build. */
    let rosterAssignments = new Map<number, VehicleEntry | null>();
    /** Sorted ship entity ids — the spawn-order fallback for roleless ships
     *  (the game client spawns team A before team B). */
    let shipEntityIds: number[] = [];

    function formatTime(sec: number): string {
      const s = Math.max(0, Math.round(sec));
      const m = Math.floor(s / 60);
      return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }
    /** Fixed "elapsed / total" readout. */
    function displayTime(): string {
      const d = duration.value || 0;
      const c = current.value;
      return `${formatTime(c)} / ${formatTime(d)}`;
    }

    // Score bar data
    const allyTotal = computed(() => props.vehicles.filter(v => v.relation <= 1).length);
    const enemyTotal = computed(() => props.vehicles.filter(v => v.relation > 1).length);
    // Ships alive = total - sunk count at current time
    const allyAlive = ref(allyTotal.value);
    const enemyAlive = ref(enemyTotal.value);
    // Death time per roster ship (by shipId join on the trajectory kinds).
    const deathTimeByShipId = computed(() => {
      const m = new Map<number, number | null>();
      for (const tr of props.trajectories) {
        if (tr.kind?.shipId != null) m.set(tr.kind.shipId, tr.deathTime ?? null);
      }
      return m;
    });
    /** Roster rows for the ship-icon strip under the scorebar: team icons in
     *  roster order, sunk ships pushed to the far edge and greyed out. */
    interface ShipRowEntry {
      key: number;
      type: string | null;
      dead: boolean;
    }
    const shipRows = computed(() => {
      const dt = deathTimeByShipId.value;
      const mk = (v: VehicleEntry): ShipRowEntry => {
        const d = v.shipId != null ? dt.get(v.shipId) : undefined;
        const dead = d != null && d <= current.value;
        const info = props.encyclopedia.get(v.shipId) as ShipInfo | undefined;
        const offline = shipOfflineEntry(v.shipId);
        return {
          key: v.id,
          type: info?.type ?? offline?.type ?? null,
          dead,
        };
      };
      const allies = props.vehicles.filter((v) => v.relation <= 1).map(mk);
      const enemies = props.vehicles.filter((v) => v.relation > 1).map(mk);
      // Ship-size weight: carriers/battleships biggest, subs smallest. Sunk
      // ships form their own group at the outer edge of each side (allies:
      // leftmost, enemies: rightmost); within each group the biggest ships
      // sit at the outer edge — mirror image of each other.
      const sizeOf = (r: ShipRowEntry): number => {
        const t = (r.type ?? "").toLowerCase();
        if (t.includes("aircarrier") || t.includes("aircar")) return 5;
        if (t.includes("battleship")) return 4;
        if (t.includes("cruiser")) return 3;
        if (t.includes("destroyer")) return 2;
        if (t.includes("submarine")) return 1;
        return 0;
      };
      // Allies: sunk group first (left edge), then alive; big ships to the
      // left within each group.
      const sortAlly = (a: ShipRowEntry, b: ShipRowEntry) =>
        Number(b.dead) - Number(a.dead) || sizeOf(b) - sizeOf(a);
      // Enemies: alive group first, sunk group last (right edge); big ships
      // to the right within each group.
      const sortEnemy = (a: ShipRowEntry, b: ShipRowEntry) =>
        Number(a.dead) - Number(b.dead) || sizeOf(a) - sizeOf(b);
      allies.sort(sortAlly);
      enemies.sort(sortEnemy);
      return { allies, enemies };
    });
    // Live self statistics (top-right): derived from the explosion stream,
    // tracking the current playhead. An explosion counts as the recorder's
    // when its bearing matches the own ship's heading at that moment (same
    // heuristic as shell-arc reconstruction). Damage is the HP loss of enemy
    // ships near the impact right after it; a sinking near an impact counts
    // as a frag.
    const selfStats = computed(() => {
      const selfTraj = props.trajectories.find(
        (tr) => tr.kind?.entityType === 2 && resolveRoleQuick(tr) === "self",
      );      if (!selfTraj || selfTraj.samples.length === 0) return null;
      let hits = 0;
      let damage = 0;
      let frags = 0;
      // Damage taken: every point of HP the self ship lost up to the
      // playhead (the in-game "承受伤害" readout beside the HP plaque).
      let taken = 0;
      const hps = selfTraj.hpSamples ?? [];
      for (let i = 1; i < hps.length; i++) {
        if (hps[i].time > current.value) break;
        const drop = hps[i - 1].value - hps[i].value;
        if (drop > 0) taken += drop;
      }
      for (const e of props.explosions) {
        if (e.time > current.value) continue; // not time-sorted in all dumps
        const s = sampleAt(selfTraj, e.time);
        if (!s) continue;
        const dist = Math.hypot(s.x - e.x, s.z - e.z);
        if (dist < 300 || dist > 15000) continue;
        const aim = Math.atan2(e.x - s.x, e.z - s.z);
        let dAim = Math.abs(aim - s.yaw);
        if (dAim > Math.PI) dAim = 2 * Math.PI - dAim;
        if (dAim > 0.35) continue; // ~20° firing cone
        hits++;
        // Damage: enemy HP drop across the impact (500 m window).
        for (const tr of props.trajectories) {
          if (tr.kind?.entityType !== 2 || resolveRoleQuick(tr) !== "enemy") continue;
          const at = sampleAt(tr, e.time);
          if (!at) continue;
          if (Math.hypot(at.x - e.x, at.z - e.z) > 500) continue;
          const hpBefore = hpAtTime(tr.hpSamples, e.time - 0.4);
          const hpAfter = hpAtTime(tr.hpSamples, e.time + 0.6);
          if (hpBefore != null && hpAfter != null && hpBefore - hpAfter > 50) {
            damage += hpBefore - hpAfter;
          }
          const death = tr.deathTime;
          if (death != null && Math.abs(death - e.time) < 1.2) {
            frags++;
          }
        }
      }
      return { hits, damage, frags, taken };
    });
    /** Ship class for a shipId (encyclopedia → offline DB → "". */
    // Cap zone status (A=0, B=1, C=2) — 0=neutral, 1=ally, 2=enemy
    const capStatus = ref([0, 0, 0]);
    // Estimated match score: kills (1 pt) + fully-held cap points (3 pts each).
    // WoWS doesn't stream score packets into replays, so this is a close
    // approximation of the domination scoring shown in the top bar.
    const allyScore = ref(0);
    const enemyScore = ref(0);
    // Transient "X sunk Y" feed, newest first; entries expire after a few
    // seconds. Each side renders its own ship name with the player nickname
    // underneath (killer left-aligned, victim right-aligned, "sank" centred).
    interface KillEvent {
      id: number;
      /** Victim's player nickname. */
      text: string;
      /** Victim's ship display name. */
      shipName: string;
      /** Victim's ship type (for the HUD icon). */
      shipType: string | null;
      /** Killer's ship display name. */
      killerShipName: string;
      /** Killer's ship type (for the HUD icon). */
      killerShipType: string | null;
      /** Killer's player nickname (resolved from the post-battle payload). */
      killerName: string | null;
      /** Role of the KILLER (the card tint is the killer's side). */
      role: TeamRole;
    }
    const killFeed = ref<KillEvent[]>([]);
    let killSeq = 0;
    /** Lazily parsed post-battle payload (killer resolution + self team). */
    let pbCache: ReturnType<typeof parsePostBattle> | null = null;
    /** The recorder's own 0/1 side from the post-battle payload — maps a
     *  zone's teamId to the owner code (1 = own side, 2 = enemy). */
    const selfTeam = computed(() => {
      const pb = pbCache;
      if (!pb?.players || pb.selfId == null) return null;
      return pb.players.find((p) => p.accountId === pb.selfId)?.team ?? null;
    });
    // Entity ids already reported as sunk (avoid double-counting on scrub).
    const reportedSinks = new Set<number>();
    // The capture-zone entities + their ownership timelines. InteractiveZone
    // (type 14) covers ALL interactive areas — capture points, strike zones,
    // event regions. The AUTHORITATIVE discriminator is the create packet's
    // `controlPoint` component (`controlPointIndex`): only real domination
    // points carry it, and it ships with the EntityCreate itself, so the rule
    // holds even for replays that record no ownership/progress updates after
    // the zone spawns. The ownership/progress-stream checks below are kept
    // only as a fallback for very old replays predating the component.
    /** True capture point vs event/strike zone, from the replay streams
     *  themselves (the authoritative per-match source — a map can ship in
     *  multiple versions, so game resources alone can't be trusted):
     *  - controlPoint component (create state) — always a real point
     *    (older clients; 15.7+ no longer ships it)
     *  - capSamples (ownership stream) — real point when present
     *  - capProgress DYNAMICS (15.7+ discriminator, measured on real
     *    dumps): a capture point's progress is a tug-of-war — dozens of
     *    samples (66..223 on a 2-cap Canada match) rising and falling as
     *    ships enter/leave/contest. Strike/event targets carry 2-3
     *    samples that decay monotonically from a high start (health-style,
     *    often >1000) straight to zero when destroyed. The old
     *    "ended-at-zero" heuristic rejected a real point whose final
     *    contest bled out — the very state "each side holds one point"
     *    ends in — which collapsed a 2-cap map to a single chip.
     */
    function isCaptureZone(t: EntityTrajectory): boolean {
      if (t.kind?.controlPointIndex != null) return true;
      if ((t.capSamples?.length ?? 0) > 0) return true;
      const cp = t.capProgress ?? [];
      if (cp.length === 0) return false;
      if (cp.length >= 10) return true; // living tug-of-war stream
      const first = cp[0].value;
      if (first >= 1000) return false; // strike-target health pool
      const last = cp[cp.length - 1].value;
      if (last > 0) return true;
      // Few samples ending at zero: only a point NOBODY ever touched stays
      // zero the whole match. Strike targets decay from non-zero.
      return !cp.some((s) => s.value > 0);
    }
    const capZones = computed(() => {
      const zones = props.trajectories.filter((t) => {
        if (t.kind?.entityType !== 14) return false;
        if (!isCaptureZone(t)) return false;
        if (t.kind.initialX == null && t.kind.initialZ == null && t.samples.length === 0) {
          return false;
        }
        return true;
      });
      // Order letters by the game's own point index (0 = A) so the scorebar
      // matches the in-match callouts.
      zones.sort(
        (a, b) =>
          (a.kind?.controlPointIndex ?? 999) - (b.kind?.controlPointIndex ?? 999),
      );
      return zones;
    });
    /** Zones that actually score: same set as the visible capture points —
     *  strike/event zones never reach this list. */
    const scoringZones = computed(() => capZones.value);

    /** Alt held → show in-game point timers on the cap letters (shared
     *  capTimer rules, same as the marketing site). */
    const showCapEta = ref(false);

    /** Hull side-silhouettes (bake output, keyed by model name). Kept in a
     *  ref so the selfCard re-renders once the async fetch resolves (a plain
     *  object would populate silently and never update the card). */
    const silhouettes = ref<Record<string, { path: string }>>({});
    void loadSilhouettes().then((j) =>
      Object.assign(silhouettes.value, j),
    );

    /** Recorder ship health plaque (shared HoloShipCard, bottom-left). */
    const selfCard = computed<HoloShipCardData | null>(() => {
      const l = shipLabels.value.find((x) => x.role === "self" && x.shipName);
      if (!l) return null;
      const stem = shipModelStem(l.shipId) ?? undefined;
      return {
        shipType: l.type ?? undefined,
        silhouetteUrl: shipSilhouetteUrl(l.shipId),
        silhouette: (stem && silhouettes.value[stem]?.path) ?? null,
        name: l.shipName,
        hp: l.hp,
        maxHp: l.maxHp,
        dead: l.dead,
        // Repairable pool approximated as 60% of damage taken until the
        // replay stream carries the real value.
        repairableHp: l.hp != null && l.maxHp != null ? (l.maxHp - l.hp) * 0.6 : null,
      };
    });

    onMounted(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Tab") {
          e.preventDefault();
          showRoster.value = true;
        }
        if (e.key === "Alt") showCapEta.value = true;
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.key === "Tab") showRoster.value = false;
        if (e.key === "Alt") showCapEta.value = false;
      };
      window.addEventListener("keydown", onKey);
      window.addEventListener("keyup", onKeyUp);
      onBeforeUnmount(() => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKeyUp);
      });
    });

    // Three.js objects we own (to dispose on change/unmount).
    let trajectoryLines: THREE.Line[] = [];
    let shipMarkers: THREE.Group[] = [];
    /** Successfully loaded ship models, one per marker build — cloned as
     *  substitute hulls for ships whose own GLB is missing or failed to
     *  load (a same-team stand-in beats a bare cone). */
    let loadedModelPool: { model: THREE.Group; role: TeamRole }[] = [];
    /** Markers still waiting for a model (no URL or load failure); filled
     *  from `loadedModelPool` as soon as any model finishes loading. */
    let modelWaiters: { marker: THREE.Group; traj: EntityTrajectory }[] = [];
    /** Smoke-screen clusters (entityType 4 = SmokeScreen). Each cluster
     *  holds a start ring + end ring (white circles) and a remaining-time
     *  sprite. Puffs spawned within 300 m of each other merge into one
     *  cluster — the one with the longest lifetime wins. */
    let smokeClusters: {
      traj: EntityTrajectory;
      t0: number;
      lastT: number;
      endT: number;
      sx: number;
      sz: number;
      rings: THREE.Mesh[];
      timeSprite: THREE.Sprite | null;
    }[] = [];
    /** Reconstructed shell flights: a curved trace from a nearby ship that
     *  was aimed at the impact when it exploded. */
    let shellTraces: {
      line: THREE.Line;
      dots: THREE.Points;
      flash: THREE.Mesh;
      halo: THREE.Mesh;
      /** In-flight projectile visual — a cone until the real shell GLB swaps
       *  in, then a wrapped model group (driven identically). */
      shell: THREE.Object3D;
      /** Ammo tint (kept so the async GLB swap can re-tint the model). */
      color: number;
      t0: number;
      t1: number;
      from: () => THREE.Vector3 | null;
      to: THREE.Vector3;
      h: number;
    }[] = [];
    /** In-flight torpedoes: straight capsules from the launch point along
     *  the launch direction (swapped for the real torpedo GLB once loaded). */
    let torpedoMeshes: {
      mesh: THREE.Object3D;
      wake: THREE.Line;
      t0: number;
      life: number;
      base: THREE.Vector3;
      dir: THREE.Vector3;
    }[] = [];
    /** Transient explosion rings (splash hits). */
    let explosionFx: { ring: THREE.Mesh; born: number }[] = [];
    const _shellUp = new THREE.Vector3(0, 1, 0);
    const _shellDir = new THREE.Vector3();
    /** Recorder aim line to the currently locked target (SetWeaponLock). */
    let lockLine: THREE.Mesh | null = null;
    /** Big ring over the locked target (same render path as splash rings). */
    /** Aircraft formation cloud (one point per plane, from the avatar's
     *  receive_updateSquadron stream) — fallback for planes without a baked
     *  model; modeled planes render as GLB meshes in `planeMeshes`. */
    let planeCloud: THREE.Points | null = null;
    /** Per-plane sample lists grouped by plane id, sorted by time. */
    let planeTrails: { id: number; samples: SquadronPlane[] }[] = [];
    /** planeId*16+index → aircraft type (fighter/dive/torpedo/...). */
    const planeTypesById = new Map<number, string>();
    /** planeId*16+index → GameParams index (for the baked model GLB). */
    const planeIndexById = new Map<number, string>();
    /** Squadron label id → controlling ship's entity id (for name/HP sync). */
    const planeLabelCarriers = new Map<number, number | null>();
    /** planeId → team role of the controlling ship (drives marker colour:
     *  ally green, enemy red, like the battle HUD). */
    const planeRoleById = new Map<number, string>();
    /** planeId → the carrier card label id that shows it. */
    const planeLabelOfPlane = new Map<number, number>();
    /** planeId → formation render state: the GameParams squadron size, the
     *  inferred group layout and the per-plane model instances. */
    const planeFormations = new Map<
      number,
      { count: number; groupSize: number; groupCount: number; meshes: THREE.Object3D[] }
    >();
    /** planeId → 3D aircraft model pool (one per formation slot). */
    const planeMeshes = new Map<number, THREE.Object3D[]>();
    /** Capture-zone ring meshes (repainted per frame by cap state). */
    let capRings: THREE.Mesh[] = [];
    /** Cap-letter sprites (redrawn with the point ETA while Alt is held). */
    let capLetterSprites: THREE.Sprite[] = [];
    let mapModel: THREE.Group | null = null;
    let bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

    /** Per-marker display info for the floating HTML labels. Rebuilt alongside
     *  the markers; positions are updated each frame by projecting the marker's
     *  world position into screen space. */
    interface ShipLabel {
      entityId: number;
      role: TeamRole;
      name: string;
      shipName: string;
      /** WG shipId (roster/trajectory join) — drives the hull silhouette. */
      shipId?: number;
      tier: number | null;
      type: string | null;
      hp: number | null;
      maxHp: number | null;
      /** "plane" renders the aircraft icon + carrier name instead of the ship glyph. */
      kind?: "ship" | "plane";
      /** Aircraft type name (fighter/dive/...) for plane labels. */
      planeType?: string | null;
      /** Ghost (unseen/sunk) state: label gets a dashed border and the HP bar
       *  is replaced by a "gone for N s" countdown text. */
      ghostText?: string | null;
      /** Screen-space left/top in px (relative to the canvas). Updated per-frame. */
      x: number;
      y: number;
      visible: boolean;
      dead: boolean;
    }
    const shipLabels = ref<ShipLabel[]>([]);
    /** Follow-menu roster grouped by allegiance: self alone, then allies,
     *  then enemies (roster order within each group). Plane entities are
     *  excluded — only ships can be followed. */
    const cameraShipGroups = computed(() => {
      const groups: { key: string; title: string; items: ShipLabel[] }[] = [];
      const self: ShipLabel[] = [];
      const ally: ShipLabel[] = [];
      const enemy: ShipLabel[] = [];
      for (const l of shipLabels.value) {
        if (l.kind === "plane" || !l.shipName) continue;
        if (l.role === "self") self.push(l);
        else if (l.role === "ally") ally.push(l);
        else enemy.push(l);
      }
      if (self.length > 0) {
        groups.push({ key: "self", title: i18nT("replay.camera.me"), items: self });
      }
      if (ally.length > 0) {
        groups.push({ key: "ally", title: i18nT("replay.camera.allies"), items: ally });
      }
      if (enemy.length > 0) {
        groups.push({ key: "enemy", title: i18nT("replay.camera.enemies"), items: enemy });
      }
      return groups;
    });
    const _projVec = new THREE.Vector3();
    /** Pointer-down position for click-vs-drag discrimination: a click that
     *  moved more than a few px is an OrbitControls drag, and must NOT select
     *  a ship (selecting locks the camera via followSelected — dragging would
     *  fight the lock and feel "stuck"). */
    let _downPt: { x: number; y: number } | null = null;

    // Minimap canvas. The base layer is the game's own minimap art (water +
    // land composite, extracted by `extract_minimaps.py`); positions use the
    // map's world bounds from `minimaps.json` so ship dots sit on the same
    // spots as the in-battle minimap. Without art/bounds for this map we fall
    // back to the plain dark base + trajectory-derived bounds.
    const minimapCanvas = ref<HTMLCanvasElement | null>(null);
    const zoomCanvas = ref<HTMLCanvasElement | null>(null);
    let _mmCtx: CanvasRenderingContext2D | null = null;
    const MINIMAP_SIZE = 160;
    let minimapImage: HTMLImageElement | null = null;
    let minimapBounds: MapBounds | null = null;
    /** Cancels stale minimap-base loads when the map switches mid-flight. */
    let minimapEpoch = 0;

    /** (Re)load the base art + bounds for the current mapId. */
    function loadMinimapBase() {
      const epoch = ++minimapEpoch;
      minimapImage = null;
      minimapBounds = null;
      const url = resolveMapMinimapUrl(props.mapId);
      if (url) {
        const img = new Image();
        img.onload = () => { if (epoch === minimapEpoch) minimapImage = img; };
        img.src = url;
      }
      void loadMapBounds().then((all) => {
        if (epoch !== minimapEpoch) return;
        const key = props.mapId.replace(/^spaces\//, "");
        minimapBounds =
          all.get(key) ??
          all.get(key.toLowerCase()) ??
          [...all.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] ??
          null;
      });
    }

    function drawMinimap() {
      // Effective bounds in WORLD coordinates: the map's minimap bounds when
      // known (matches the base art), else the trajectory bounds converted
      // back from scene space (scene z = -world z) so the dots at least fit
      // the canvas.
      const full: MapBounds | null =
        minimapBounds ??
        (bounds
          ? { minX: bounds.minX, maxX: bounds.maxX, minZ: -bounds.maxZ, maxZ: -bounds.minZ }
          : null);
      if (!full) return;
      // Crop to the active battle area when the match plays out in a small
      // region of the map (brawls/events with a restricted border): the
      // in-game minimap shows only that region, and a full-map view would
      // compress every ship dot into one corner. `bounds` already holds the
      // active area in scene coords (z mirrored back to world here).
      let db = full;
      if (minimapBounds && bounds) {
        const active: MapBounds = {
          minX: bounds.minX,
          maxX: bounds.maxX,
          minZ: -bounds.maxZ,
          maxZ: -bounds.minZ,
        };
        const mapArea = (full.maxX - full.minX) * (full.maxZ - full.minZ);
        const activeArea =
          (active.maxX - active.minX) * (active.maxZ - active.minZ);
        // Crop whenever the active area is smaller than the full map —
        // mode-restricted matches (duels/brawls on one side of a ridge)
        // must not render as full-map thumbnails.
        if (activeArea > 0 && activeArea < 0.95 * mapArea) {
          db = {
            minX: Math.max(active.minX, full.minX),
            maxX: Math.min(active.maxX, full.maxX),
            minZ: Math.max(active.minZ, full.minZ),
            maxZ: Math.min(active.maxZ, full.maxZ),
          };
        }
      }
      const cvs = minimapCanvas.value;
      if (!cvs) return;
      if (!_mmCtx) _mmCtx = cvs.getContext("2d");
      const ctx = _mmCtx!;
      // HiDPI backing store EXACTLY matching the displayed element size
      // (rect × devicePixelRatio) — a 1:1 buffer↔element mapping avoids the
      // browser resampling the canvas and softening vector edges. The base
      // transform below keeps every drawing call in 160-unit logical coords.
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const dispMm = Math.round(Math.max(1, cvs.getBoundingClientRect().width));
      const px = Math.round(dispMm * dpr);
      if (cvs.width !== px) cvs.width = px;
      if (cvs.height !== px) cvs.height = px;
      ctx.setTransform(px / MINIMAP_SIZE, 0, 0, px / MINIMAP_SIZE, 0, 0);
      const w = MINIMAP_SIZE;
      const h = MINIMAP_SIZE;

      const dbW = db.maxX - db.minX;
      const dbH = db.maxZ - db.minZ;

      // Markers/camera live in three.js space (z = -worldZ); convert back to
      // world coordinates for the map projection. North (+worldZ) is up on
      // the game's minimap (world_to_minimap flips z).
      function wx(x: number) { return ((x - db.minX) / (dbW || 1)) * w; }
      function wz(zScene: number) { return ((db.maxZ + zScene) / (dbH || 1)) * h; }

      ctx.clearRect(0, 0, w, h);
      // The minimap art NEVER changes with the theme: it is the game's own
      // map bitmap, shown as-is in both modes (like a photo). Only the
      // surrounding HUD chrome (frame, scrims, panels) follows the theme.
      if (minimapImage) {
        if (db === full) {
          ctx.drawImage(minimapImage, 0, 0, w, h);
        } else {
          // Cropped: draw only the active-area slice of the art, scaled up.
          const img = minimapImage;
          const fullW = full.maxX - full.minX;
          const fullH = full.maxZ - full.minZ;
          const sx = ((db.minX - full.minX) / (fullW || 1)) * img.width;
          const sw = ((db.maxX - db.minX) / (fullW || 1)) * img.width;
          const sy = ((full.maxZ - db.maxZ) / (fullH || 1)) * img.height;
          const sh = ((db.maxZ - db.minZ) / (fullH || 1)) * img.height;
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
        }
      } else {
        ctx.fillStyle = "rgba(5, 8, 15, 0.85)";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.strokeStyle = "rgba(0, 170, 255, 0.3)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

      // Capture zones: rings sized from the zone's REAL radius. On a 160px
      // thumb of a 30 km map even 140 m is sub-pixel, so use a relative
      // scale — bigger radius → visibly bigger ring (sqrt keeps 20 m and
      // 140 m points clearly distinct) — tinted by owner, letter inside.
      const capRadiusPx = (radius: number) =>
        Math.max(4, Math.min(22, 3 + Math.sqrt(radius / 20) * 5));
      capZones.value.forEach((z, i) => {
        const cx = wx(z.kind!.initialX);
        const cz = wz(-z.kind!.initialZ);
        const owner = capDisplay.value[i]?.owner ?? 0;
        const radiusPx = capRadiusPx(Math.max(z.kind?.radius ?? 300, 25));
        ctx.strokeStyle =
          owner === 1 ? "rgba(74, 222, 128, 0.8)" : owner === 2 ? "rgba(204, 51, 51, 0.8)" : "rgba(255, 255, 255, 0.5)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cz, radiusPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = "bold 8px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String.fromCharCode(65 + i), cx, cz + 0.5);
      });

      // Ship markers: the game's own HUD class icons, tinted by team via the
      // variant (ally/enemy/sunk). Falls back to a plain dot until the icon
      // image decodes.
      const t = current.value;
      for (const m of shipMarkers) {
        const role = m.userData.role as TeamRole | undefined;
        const firstT = m.userData.firstT as number | undefined;
        // Unobserved ships: enemies are NOT shown at all; allies show a
        // GREEN outline glyph (class engraving kept via the polygon gaps)
        // at their spawn — white stays reserved for the recorder.
        if (t < (firstT ?? Infinity)) {
          if (role === "enemy") continue;
          const gx = wx(m.userData.spawnX as number);
          const gz = wz(-(m.userData.spawnZ as number));
          ctx.save();
          ctx.translate(gx, gz);
          ctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
          drawShipGlyph(ctx, m.userData.type as string | undefined, 0, 0, 14, TEAM_COLOR.ally, {
            outline: true,
          });
          ctx.restore();
          continue;
        }
        const dead =
          (m.userData.deathTime as number | null) != null &&
          t >= (m.userData.deathTime as number);
        const cx = wx(m.position.x);
        const cz = wz(m.position.z);
        // Solid vector class glyph (traced from the game's HUD bitmap —
        // original shape, crisp at any scale/rotation), rotated to the
        // ship's heading: rotation 0 points the glyph UP (north), yaw is
        // clockwise from north; the glyph's pointy end faces RIGHT (+x) at
        // rest, so subtract 90° for 0° = north (matching the 3D marker's
        // rotation.y = PI - yaw on the mirrored frame).
        const color = dead ? 0x8a97a5 : role ? TEAM_COLOR[role] : 0x9aa7b5;
        ctx.save();
        ctx.translate(cx, cz);
        ctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
        drawShipGlyph(ctx, m.userData.type as string | undefined, 0, 0, dead ? 11 : 13, color);
        ctx.restore();
      }

      // Smoke screens (entityType 4): white start/end rings + remaining
      // seconds, fading out after each puff's lifetime (90s past its last
      // update, or the recorded leave time).
      {
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 1;
        for (const cl of smokeClusters) {
          if (t < cl.t0 || t > cl.endT) continue;
          let cur = t;
          if (t > cl.lastT) {
            const span = Math.max(1, cl.lastT - cl.t0);
            cur = cl.t0 + ((t - cl.lastT) * span) / Math.max(1, cl.endT - cl.lastT);
            if (cur > cl.lastT) cur = cl.lastT;
          }
          const pStart = sampleAt(cl.traj, cur);
          if (!pStart) continue;
          const pEnd = sampleAt(cl.traj, cl.lastT);
          const drift =
            pEnd != null ? Math.hypot(pStart.x - pEnd.x, pStart.z - pEnd.z) : 0;
          const showBoth = pEnd != null && drift >= 1000;
          ctx.beginPath();
          ctx.arc(wx(pStart.x), wz(-pStart.z), 3, 0, Math.PI * 2);
          ctx.stroke();
          if (showBoth && pEnd) {
            ctx.beginPath();
            ctx.arc(wx(pEnd.x), wz(-pEnd.z), 3, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.font = "bold 8px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${Math.ceil(cl.endT - t)}s`, wx(pStart.x), wz(-pStart.z) - 4);
        }
      }
      // Aircraft — one in-game type icon per FORMATION (squadron centre),
      // not per plane: a full 8-plane group reads as a single moving marker.
      {
        const drawn = new Set<number>();
        for (const trail of planeTrails) {
          const planeId = Math.floor(trail.id / 16);
          if (trail.id % 16 !== 0 || drawn.has(planeId)) continue;
          const samples = trail.samples;
          let s: SquadronPlane | null = null;
          for (const sp of samples) {
            if (sp.time > t) break;
            s = sp;
          }
          if (s == null) continue;
          if (t < samples[0].time || t > samples[samples.length - 1].time + 5) continue;
          drawn.add(planeId);
          const icon = planeIcon(planeTypesById.get(trail.id) ?? "attack");
          if (icon && icon.complete && icon.naturalWidth > 0) {
            const sz = 10;
            ctx.save();
            ctx.translate(wx(s.x), wz(-s.z));
            // Aircraft icons stay upright on the minimap (no rotation).
            ctx.drawImage(icon, -sz / 2, -sz / 2, sz, sz);
            ctx.restore();
          } else {
            ctx.fillStyle = "rgba(120, 210, 255, 0.95)";
            ctx.beginPath();
            ctx.arc(wx(s.x), wz(-s.z), 1.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Camera frustum.
      const cam = api.value?.camera;
      if (cam) {
        const corners = frustumCorners(cam);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(wx(corners[0].x), wz(corners[0].z));
        for (let i = 1; i < 4; i++) ctx.lineTo(wx(corners[i].x), wz(corners[i].z));
        ctx.closePath();
        ctx.stroke();
      }

      // Enlarged minimap overlay: full-map view with ship trails + glyphs.
      const zc = zoomCanvas.value;
      if (zc) {
        const zctx = zc.getContext("2d");
        if (zctx) {
          // HiDPI backing store EXACTLY matching the displayed element
          // size: rect × devicePixelRatio device px. Matching 1:1 avoids the
          // browser's own box resampling of the canvas (a 760·dpr buffer on
          // a differently-sized element reintroduced ~3px edge softening at
          // 150% scaling). All zwx/zwz math stays in 760 logical units.
          const dprZ = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
          const rectZ = zc.getBoundingClientRect();
          const dispZ = Math.round(Math.max(1, rectZ.width));
          const pxZ = Math.round(dispZ * dprZ);
          if (zc.width !== pxZ) { zc.width = pxZ; zc.height = pxZ; }
          zctx.setTransform(pxZ / 760, 0, 0, pxZ / 760, 0, 0);
          const zw = 760;
          // The 2D map art NEVER changes with the theme (the game's own
          // bitmap, shown as-is in both modes); only the overlay chrome —
          // scrim, head pill, frame — follows the app theme.
          zctx.clearRect(0, 0, zw, zw);
          if (minimapImage) {
            zctx.imageSmoothingEnabled = true;
            zctx.drawImage(minimapImage, 0, 0, zw, zw);
          } else {
            zctx.fillStyle = "rgba(5, 8, 15, 0.9)";
            zctx.fillRect(0, 0, zw, zw);
          }
          const zwx = (x: number) => ((x - full.minX) / (full.maxX - full.minX || 1)) * zw;
          const zwz = (zScene: number) => ((full.maxZ + zScene) / (full.maxZ - full.minZ || 1)) * zw;
          // Capture rings + letters (same rendering as the small thumb, at
          // the enlarged scale).
          const zcapR = (radius: number) =>
            Math.max(8, Math.min(48, 5 + Math.sqrt(radius / 20) * 9));
          capZones.value.forEach((z, i) => {
            const cx = zwx(z.kind!.initialX);
            const cz = zwz(-z.kind!.initialZ);
            const owner = capDisplay.value[i]?.owner ?? 0;
            const rPx = zcapR(Math.max(z.kind?.radius ?? 300, 25));
            zctx.strokeStyle =
              owner === 1 ? "rgba(74, 222, 128, 0.85)" : owner === 2 ? "rgba(204, 51, 51, 0.85)" : "rgba(255, 255, 255, 0.55)";
            zctx.lineWidth = 2;
            zctx.beginPath();
            zctx.arc(cx, cz, rPx, 0, Math.PI * 2);
            zctx.stroke();
            zctx.fillStyle = zctx.strokeStyle;
            zctx.font = "bold 16px sans-serif";
            zctx.textAlign = "center";
            zctx.textBaseline = "middle";
            zctx.fillText(String.fromCharCode(65 + i), cx, cz + 0.5);
          });
          if (minimapShowTrails.value) {
            for (const tr of props.trajectories) {
              if (tr.kind?.entityType !== 2 || tr.samples.length < 2) continue;
              const role = resolveRoleQuick(tr);
              zctx.strokeStyle =
                role === "enemy"
                  ? "rgba(204, 51, 51, 0.5)"
                  : role === "self"
                    ? "rgba(255, 255, 255, 0.6)"
                    : "rgba(60, 180, 120, 0.5)";
              zctx.lineWidth = 1.5;
              zctx.beginPath();
              tr.samples.forEach((s, i) => {
                const px = zwx(s.x);
                const py = zwz(-s.z);
                if (i === 0) zctx.moveTo(px, py);
                else zctx.lineTo(px, py);
              });
              zctx.stroke();
            }
          }
          for (const m of shipMarkers) {
            const role = m.userData.role as TeamRole | undefined;
            const firstT = m.userData.firstT as number | undefined;
            // Unobserved ships: enemies not shown; allies get a white glyph
            // outline at spawn — the game's "last known position" marker.
            if (t < (firstT ?? Infinity)) {
              if (role === "enemy") continue;
              const gx = zwx(m.userData.spawnX as number);
              const gz = zwz(-(m.userData.spawnZ as number));
              zctx.save();
              zctx.translate(gx, gz);
              zctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
              drawShipGlyph(zctx, m.userData.type as string | undefined, 0, 0, 30, TEAM_COLOR.ally, {
                outline: true,
              });
              zctx.restore();
              continue;
            }
            const dead =
              (m.userData.deathTime as number | null) != null &&
              t >= (m.userData.deathTime as number);
            const cx = zwx(m.position.x);
            const cz = zwz(m.position.z);
            // Solid traced vector glyph (original HUD shape, crisp at any
            // zoom/rotation); sunk ships render greyed-out, live ships in
            // their team colour.
            const color = dead ? 0x8a97a5 : role ? TEAM_COLOR[role] : 0x9aa7b5;
            zctx.save();
            zctx.translate(cx, cz);
            zctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
            drawShipGlyph(zctx, m.userData.type as string | undefined, 0, 0, dead ? 26 : 34, color);
            zctx.restore();
          }
          // Smoke screens — white start/end rings + remaining seconds on
          // the enlarged map (same lifetime/dissipation rules as minimap).
          zctx.strokeStyle = "rgba(255,255,255,0.85)";
          zctx.fillStyle = "rgba(255,255,255,0.95)";
          zctx.lineWidth = 1.4;
          for (const cl of smokeClusters) {
            if (t < cl.t0 || t > cl.endT) continue;
            let cur = t;
            if (t > cl.lastT) {
              const span = Math.max(1, cl.lastT - cl.t0);
              cur = cl.t0 + ((t - cl.lastT) * span) / Math.max(1, cl.endT - cl.lastT);
              if (cur > cl.lastT) cur = cl.lastT;
            }
            const pStart = sampleAt(cl.traj, cur);
            if (!pStart) continue;
            const pEnd = sampleAt(cl.traj, cl.lastT);
            const drift =
              pEnd != null ? Math.hypot(pStart.x - pEnd.x, pStart.z - pEnd.z) : 0;
            const showBoth = pEnd != null && drift >= 1000;
            zctx.beginPath();
            zctx.arc(zwx(pStart.x), zwz(-pStart.z), 6, 0, Math.PI * 2);
            zctx.stroke();
            if (showBoth && pEnd) {
              zctx.beginPath();
              zctx.arc(zwx(pEnd.x), zwz(-pEnd.z), 6, 0, Math.PI * 2);
              zctx.stroke();
            }
            zctx.font = "bold 12px sans-serif";
            zctx.textAlign = "center";
            zctx.textBaseline = "bottom";
            zctx.fillText(`${Math.ceil(cl.endT - t)}s`, zwx(pStart.x), zwz(-pStart.z) - 7);
          }
          // Aircraft — one icon per formation (squadron centre).
          {
            const drawn = new Set<number>();
            for (const trail of planeTrails) {
              const planeId = Math.floor(trail.id / 16);
              if (trail.id % 16 !== 0 || drawn.has(planeId)) continue;
              const samples = trail.samples;
              let s: SquadronPlane | null = null;
              for (const sp of samples) {
                if (sp.time > t) break;
                s = sp;
              }
              if (s == null) continue;
              if (t < samples[0].time || t > samples[samples.length - 1].time + 5) continue;
              drawn.add(planeId);
              const icon = planeIcon(planeTypesById.get(trail.id) ?? "attack");
              if (icon && icon.complete && icon.naturalWidth > 0) {
                const sz = 22;
                zctx.save();
                zctx.translate(zwx(s.x), zwz(-s.z));
                // Aircraft icons stay upright on the minimap (no rotation).
                zctx.drawImage(icon, -sz / 2, -sz / 2, sz, sz);
                zctx.restore();
              } else {
                zctx.fillStyle = "rgba(120, 210, 255, 0.95)";
                zctx.beginPath();
                zctx.arc(zwx(s.x), zwz(-s.z), 3.5, 0, Math.PI * 2);
                zctx.fill();
              }
            }
          }
        }
      }
    }

    /** Quick team-role lookup for the minimap trails, shell-arc targets and
     *  self-stats — reads the SAME roster assignments the 3D markers use
     *  (computed in rebuildActors), so trails and markers can never disagree.
     *  Ships without an assignment (older replays, decode gaps) fall back to
     *  the entity-id spawn-order heuristic: the client spawns team A first. */
    function resolveRoleQuick(tr: EntityTrajectory): TeamRole {
      const entry = rosterAssignments.get(tr.entityId);
      if (entry) return roleFromRelation(entry.relation);
      const idx = shipEntityIds.indexOf(tr.entityId);
      return idx >= 0 && idx < shipEntityIds.length / 2 ? "ally" : "enemy";
    }

    function frustumCorners(cam: THREE.PerspectiveCamera): THREE.Vector3[] {
      const hw = 0.5;
      const hh = hw / cam.aspect;
      const corners: THREE.Vector3[] = [];
      for (let i = 0; i < 4; i++) {
        const sx = i === 0 || i === 3 ? -hw : hw;
        const sy = i < 2 ? -hh : hh;
        const pt = new THREE.Vector3(sx, sy, 1).unproject(cam);
        const ray = pt.clone().sub(cam.position).normalize();
        const t = -(cam.position.y) / ray.y;
        corners.push(cam.position.clone().add(ray.multiplyScalar(t)));
      }
      return corners;
    }

    /** Class-scaled hull lengths for the 3D outline markers (world units —
     *  roughly 1.5× real scale so outlines stay readable at tactical zoom). */
    const HULL_LEN: Record<string, number> = {
      battleship: 46,
      aircarrier: 52,
      cruiser: 38,
      destroyer: 30,
      submarine: 26,
    };

    /** Build a ship-shaped LINE LOOP for the 3D scene: a pointed bow,
     *  parallel midbody and tapered stern, laid out on XZ with the bow along
     *  +Z (matching the marker cone / model convention). Doubles as the
     *  live outline (child of the marker, follows position + yaw) and the
     *  "last known position" ghost. */
    function makeHullOutline(
      color: number,
      type: string | null | undefined,
      scale = 1,
    ): THREE.LineLoop {
      const t = (type ?? "").toLowerCase();
      const len =
        (HULL_LEN[
          Object.keys(HULL_LEN).find((k) => t.includes(k)) ?? "cruiser"
        ] ?? HULL_LEN.cruiser) * scale;
      const beam = len * 0.24;
      // (x, z) around the hull, bow at +Z.
      const pts: [number, number][] = [
        [0, 0.5],
        [0.5, 0.3],
        [0.5, 0.0],
        [0.42, -0.36],
        [0, -0.5],
        [-0.42, -0.36],
        [-0.5, 0.0],
        [-0.5, 0.3],
      ];
      const arr = new Float32Array(pts.length * 3);
      pts.forEach(([px, pz], i) => {
        arr[i * 3] = px * beam;
        arr[i * 3 + 1] = 0.6;
        arr[i * 3 + 2] = pz * len;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      geo.computeBoundingSphere();
      return new THREE.LineLoop(
        geo,
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      );
    }

    /** Ship-class glyph polygons TRACED from the game's own 28×28 HUD
     *  bitmaps (scripts/trace_icons.mjs: connected-component boundary
     *  extraction + Douglas-Peucker). Each class is a list of solid
     *  polygons; the GAPS between them reproduce the icons' engraved class
     *  separators — battleship: two slanted cuts, cruiser: one, carrier:
     *  deck line + bow joint, submarine: tail joint, destroyer: plain
     *  triangle. Bow points RIGHT (+x) at 0 rotation. */
    const SHIP_GLYPH_POLYS: Record<string, number[][][]> = {
      destroyer: [
        [[5.5, 9.5], [21.5, 13.5], [5.5, 17.5]],
      ],
      cruiser: [
        [[16.5, 9.5], [18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [11.5, 17.5], [15.5, 10.5]],
        [[5.5, 9.5], [13.5, 9.5], [8.5, 17.5], [5.5, 17.5]],
      ],
      battleship: [
        [[5.5, 9.5], [11.5, 9.5], [6.5, 17.5], [5.5, 17.5]],
        [[14.5, 9.5], [15.5, 9.5], [11.5, 16.5], [9.5, 17.5], [13.5, 10.5]],
        [[18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [13.5, 17.5], [17.5, 10.5]],
      ],
      aircarrier: [
        [[16.5, 9.5], [18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [16.5, 17.5]],
        [[5.5, 9.5], [14.5, 9.5], [14.5, 12.5], [5.5, 12.5]],
        [[5.5, 14.5], [14.5, 14.5], [14.5, 17.5], [5.5, 17.5]],
      ],
      submarine: [
        [[5.5, 9.5], [6.5, 9.5], [6.5, 17.5], [5.5, 17.5]],
        [[9.5, 10.5], [21.5, 13.5], [9.5, 16.5]],
      ],
    };

    /** Draw a WoWS class glyph on a canvas context, centered at (x, y),
     *  `size` px tall, in the given color. Solid mode fills the traced
     *  polygons (vector — anti-aliased at any scale/rotation, where the
     *  raster HUD PNGs alias); outline mode strokes each polygon with a
     *  THIN line and no fill — the inter-polygon gaps stay transparent so
     *  the class engraving reads as a proper cut-out (thick strokes would
     *  bridge the 1-2px seams between the traced bands). */
    function drawShipGlyph(
      ctx: CanvasRenderingContext2D,
      type: string | undefined,
      x: number,
      y: number,
      size: number,
      color: number,
      opts?: { outline?: boolean; lineWidth?: number },
    ) {
      const t = type?.toLowerCase() ?? "";
      const cls = t.includes("destroyer")
        ? "destroyer"
        : t.includes("battleship")
          ? "battleship"
          : t.includes("aircarrier") || t.includes("aircar")
            ? "aircarrier"
            : t.includes("submarine")
              ? "submarine"
              : "cruiser"; // auxiliary + unknown fall back to cruiser
      const polys = SHIP_GLYPH_POLYS[cls];
      const s = size / 28;
      const hex = `#${color.toString(16).padStart(6, "0")}`;
      for (const poly of polys) {
        ctx.beginPath();
        ctx.moveTo(x + poly[0][0] * s, y + poly[0][1] * s);
        for (let i = 1; i < poly.length; i++) {
          ctx.lineTo(x + poly[i][0] * s, y + poly[i][1] * s);
        }
        ctx.closePath();
        if (opts?.outline) {
          // Hairline engraved outline: 0.75 device px per polygon edge (the
          // seams between the traced bands read as the class engraving).
          // Modern displays rasterise sub-pixel strokes cleanly, and thin
          // beats thick here — the traced polygons sit 1-2 atlas units
          // apart, so fat strokes bridge the seams. NOTE the scale is the
          // rotation-invariant magnitude (a alone is s·cosθ and would make
          // diagonally-rotated glyphs ~41% thicker).
          const m = ctx.getTransform();
          const devScale = Math.max(1e-6, Math.hypot(m.a, m.b) || 1);
          ctx.strokeStyle = hex;
          ctx.lineWidth = 0.75 / devScale;
          ctx.lineJoin = "round";
          ctx.stroke();
        } else {
          ctx.fillStyle = hex;
          ctx.fill();
        }
      }
    }

    /** Tokens used to cancel in-flight async marker loads when actors are
     *  rebuilt/unmounted before a GLB resolves. Each rebuild bumps the epoch;
     *  stale loads compare against the live epoch before mutating the scene. */
    let markerEpoch = 0;

    /** Dispose an Object3D generically — primitive mesh or wrapped GLB group.
     *  Materials are always disposed (per-instance). Geometry is disposed too,
     *  EXCEPT for GLB-derived groups (userData.sharedGeometry): their buffers
     *  are shared with the decode cache and must survive until the cache is
     *  cleared on unmount. */
    function disposeAny(obj: THREE.Object3D): void {
      const shared = obj.userData.sharedGeometry === true;
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (!shared) mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose();
      });
    }

    function clearActors() {
      markerEpoch++;
      const scene = api.value?.scene;
      if (!scene) return;
      for (const l of trajectoryLines) {
        scene.remove(l);
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
      for (const m of shipMarkers) {
        scene.remove(m);
        const ghost = m.userData.ghost as THREE.Mesh | undefined;
        if (ghost) {
          scene.remove(ghost);
          ghost.geometry.dispose();
          (ghost.material as THREE.Material).dispose();
        }
        // Hull outline (LineLoop child — not a Mesh, so the mesh traversal
        // below would leak its buffers).
        const hull = m.userData.hull as THREE.LineLoop | undefined;
        if (hull) {
          hull.geometry.dispose();
          (hull.material as THREE.Material).dispose();
        }
        if (m.userData.isDot) {
          m.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.geometry.dispose();
              (o.material as THREE.Material).dispose();
            }
          });
        } else {
          disposeMarker(m);
        }
      }
      trajectoryLines = [];
      shipMarkers = [];
      loadedModelPool = [];
      modelWaiters = [];
      capRings = [];
      capLetterSprites = [];
      capSim.clear();
      for (const cl of smokeClusters) {
        for (const ring of cl.rings) {
          scene.remove(ring);
          ring.geometry.dispose();
          (ring.material as THREE.Material).dispose();
        }
        if (cl.timeSprite) {
          scene.remove(cl.timeSprite);
          (cl.timeSprite.material as THREE.Material).dispose();
        }
      }
      smokeClusters = [];
      for (const st of shellTraces) {
        scene.remove(st.line);
        st.line.geometry.dispose();
        (st.line.material as THREE.Material).dispose();
        scene.remove(st.dots);
        st.dots.geometry.dispose();
        (st.dots.material as THREE.Material).dispose();
        // st.shell may be a primitive mesh or a wrapped GLB group (after the
        // model swap) — dispose generically.
        scene.remove(st.shell);
        disposeAny(st.shell);
        scene.remove(st.flash);
        st.flash.geometry.dispose();
        (st.flash.material as THREE.Material).dispose();
        scene.remove(st.halo);
        st.halo.geometry.dispose();
        (st.halo.material as THREE.Material).dispose();
      }
      shellTraces = [];
      for (const tm of torpedoMeshes) {
        scene.remove(tm.mesh);
        disposeAny(tm.mesh);
        scene.remove(tm.wake);
        tm.wake.geometry.dispose();
        (tm.wake.material as THREE.Material).dispose();
      }
      torpedoMeshes = [];
      for (const pool of planeMeshes.values()) {
        for (const g of pool) {
          scene.remove(g);
          disposeAny(g);
        }
      }
      planeMeshes.clear();
      planeFormations.clear();
      for (const fx of explosionFx) {
        scene.remove(fx.ring);
        fx.ring.geometry.dispose();
        (fx.ring.material as THREE.Material).dispose();
      }
      explosionFx = [];
      if (lockLine) {
        scene.remove(lockLine);
        lockLine.geometry.dispose();
        (lockLine.material as THREE.Material).dispose();
        lockLine = null;
      }
      if (planeCloud) {
        scene.remove(planeCloud);
        planeCloud.geometry.dispose();
        (planeCloud.material as THREE.Material).dispose();
        planeCloud = null;
      }
      planeTrails = [];
      allyAlive.value = allyTotal.value;
      enemyAlive.value = enemyTotal.value;
      capStatus.value = [0, 0, 0];
      capDisplay.value = [];
      allyScore.value = 0;
      enemyScore.value = 0;
      killFeed.value = [];
      reportedSinks.clear();
      selectedEntityId.value = null;
      rosterAssignments = new Map();
      shipEntityIds = [];
    }

    /** Remove a previously-loaded map terrain model. */
    function clearMapModel() {
      if (mapModel) {
        api.value?.scene.remove(mapModel);
        mapModel.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
        mapModel = null;
      }
    }

    /** Deep-sea floor plane stretching far past the playable area. Without
     *  it the terrain mesh (bounded by the space's chunk rect) ends in a hard
     *  edge against the void, which reads as a bright square patch around the
     *  map's center. The plane sits just below the deepest seabed and uses
     *  the same deep-water color as the contour shader's trench zone, so the
     *  terrain edge blends into open sea instead of clipping. Opaque on
     *  purpose — no blend-order interaction with the transparent terrain. */
    let waterFloor: THREE.Mesh | null = null;
    let seaSurface: THREE.Mesh | null = null;
    /** Water colours follow the app theme: deep-space navy in dark mode,
     *  soft paper-blue sea in light mode (same palette family as the scene
     *  background/grid — see useThreeScene.SCENE_THEMES). */
    function ensureWaterFloor() {
      const scene = api.value?.scene;
      if (!scene || waterFloor) return;
      const p = scenePalette();
      const mat = new THREE.MeshBasicMaterial({ color: p.bg === SCENE_THEMES.light.bg ? 0xd7e2ec : 0x05121f });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = -40;
      mesh.renderOrder = -1;
      mesh.raycast = () => {}; // never intercept picks
      scene.add(mesh);
      waterFloor = mesh;
      // Translucent sea surface at y≈0: hides the seabed tint behind it and
      // lets islands poke through, while keeping ship wake depth readable.
      const seaMat = new THREE.MeshBasicMaterial({
        color: p.bg === SCENE_THEMES.light.bg ? 0xc2d5e4 : 0x071827,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      const sea = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000), seaMat);
      sea.rotation.x = -Math.PI / 2;
      sea.position.y = 0.6;
      sea.renderOrder = 5;
      sea.raycast = () => {};
      scene.add(sea);
      seaSurface = sea;
    }
    // Live theme switch: recolour the water planes already in the scene
    // (scene background + grid are handled inside useThreeScene).
    const { effectiveMode: sceneMode } = useTheme();
    watch(sceneMode, () => {
      const light = scenePalette() === SCENE_THEMES.light;
      if (waterFloor) {
        (waterFloor.material as THREE.MeshBasicMaterial).color.setHex(
          light ? 0xd7e2ec : 0x05121f,
        );
      }
      if (seaSurface) {
        (seaSurface.material as THREE.MeshBasicMaterial).color.setHex(
          light ? 0xc2d5e4 : 0x071827,
        );
      }
    });

    /** Attempt to load the terrain GLB for the current mapId and restyle it as
     *  a holographic island mesh (same cyan scanline/fresnel shader as the ship
     *  viewer). If no converted GLB exists, the scene keeps its GridHelper
     *  fallback. Contour-line terrain is a planned feature — for now the map is
     *  the low-poly island geometry in holo style. */
    async function tryLoadMapModel() {
      clearMapModel();
      const scene = api.value?.scene;
      if (!scene || !props.mapId) return;
      const url = resolveMapModelUrl(props.mapId);
      if (!url) return; // no converted model — use grid fallback
      try {
        const model = await loadGlbModel(url);
        // Baked GLBs drop POSITION accessor min/max — recompute per-geometry so
        // bounds-dependent logic (future fit/clip) still works.
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry?.attributes.position) {
            mesh.geometry.computeBoundingBox();
            mesh.geometry.computeBoundingSphere();
          }
        });
        // Restyle meshes by role. The converted map GLB is a multi-mesh file
        // whose nodes are named `Terrain` (the elevation height-field, incl.
        // sea-floor bathymetry/trenches) and `Islands` (simplified land). The
        // terrain gets the contour shader (topographic + bathymetric bands);
        // islands get the plain holographic shader. Both share the same
        // time/scanOffset uniforms so one onFrame tick animates everything.
        const contourMat = makeHoloContourMaterial();
        const wireMat = new THREE.MeshBasicMaterial({
          color: 0x2a8fb5,
          wireframe: true,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
        });
        const meshes: THREE.Mesh[] = [];
        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
        for (const mesh of meshes) {
          let isTerrain = mesh.name === "Terrain";
          let p: THREE.Object3D | null = mesh.parent;
          while (!isTerrain && p && p !== model) {
            if (p.name === "Terrain") isTerrain = true;
            p = p.parent;
          }
          if (isTerrain) {
            mesh.material = contourMat;
          } else {
            mesh.visible = false;
          }
          const wire = new THREE.Mesh(mesh.geometry, wireMat);
          wire.raycast = () => {}; // overlay shouldn't intercept picks
          mesh.add(wire);
        }
        mapModel = model;
        scene.add(model);
      } catch (e) {
        // Model load failed (corrupt GLB?) — silently fall back to grid.
        console.warn("[HolographicMap] map model load failed:", e);
      }
    }

    /** Recompute the match duration + auto-fit the camera to the data bounds. */
    function recomputeBoundsAndCamera() {
      let minT = Infinity;
      let maxT = -Infinity;
      for (const t of props.trajectories) {
        for (const s of t.samples) {
          if (s.time < minT) minT = s.time;
          if (s.time > maxT) maxT = s.time;
        }
      }
      // Active battle area: ships (type 2) + capture zones (type 14) only.
      // Planes/torpedoes roam far past the battle border and would stretch
      // the view to the whole map even when the mode restricts play to a
      // small region (e.g. brawls fight inside a 600x600 border).
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      const eat = (x: number, z: number) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      };
      for (const t of props.trajectories) {
        if (t.kind?.entityType === 2) {
          // Sample positions AND the spawn point: ships that stay hidden
          // early (first sample minutes in) still need their opening-phase
          // ghost at the spawn inside the initial camera view.
          for (const s of t.samples) eat(s.x, -s.z);
          eat(t.kind.initialX, -t.kind.initialZ);
        } else if (t.kind?.entityType === 14) {
          eat(t.kind.initialX, -t.kind.initialZ);
        }
      }
      if (Number.isFinite(minT)) {
        duration.value = Math.max(maxT - minT, 0.1);
        if (current.value > duration.value) current.value = duration.value;
        if (Number.isFinite(minX)) {
          const mx = Math.max((maxX - minX) * 0.08, 80);
          const mz = Math.max((maxZ - minZ) * 0.08, 80);
          bounds = { minX: minX - mx, maxX: maxX + mx, minZ: minZ - mz, maxZ: maxZ + mz };
          fitCamera(bounds);
        }
      }
    }

    function fitCamera(b: { minX: number; maxX: number; minZ: number; maxZ: number }) {
      const ctrl = api.value?.controls;
      const cam = api.value?.camera;
      if (!ctrl || !cam) return;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      const span = Math.max(w, d, 200);
      const diagonal = Math.sqrt(w * w + d * d);
      ctrl.target.set(cx, 0, cz);
      ctrl.minDistance = span * 0.08;    // closest: see ship silhouettes
      ctrl.maxDistance = diagonal * 1.6; // farthest: whole map fits viewport
      ctrl.maxPolarAngle = Math.PI / 2.1;
      // Start closer — roughly half the default distance so islands fill
      // more of the viewport on open.
      cam.position.set(cx, span * 0.5, cz + span * 0.5);
      cam.lookAt(cx, 0, cz);
      ctrl.update();
    }

    /** Assign each ship trajectory its roster entry via the EntityCreate
     *  `shipId` (recovered from the state stream by the backend). Most shipIds
     *  are unique per match; when two players sail the same ship (mirror
     *  picks, bots), the collision is broken by spawn-side: centroids are
     *  computed from the unambiguous joins, and each ambiguous entity takes
     *  the same-side roster entry. Entities with no roster hit get `null` and
     *  fall back to the spawn-order team heuristic in `resolveMarkerContext`. */
    function resolveRosterAssignments(
      shipTrajs: EntityTrajectory[],
    ): Map<number, VehicleEntry | null> {
      const byShipId = new Map<number, VehicleEntry[]>();
      for (const v of props.vehicles) {
        const arr = byShipId.get(v.shipId) ?? [];
        arr.push(v);
        byShipId.set(v.shipId, arr);
      }
      const spawnOf = (t: EntityTrajectory) => ({
        x: t.kind?.initialX ?? t.samples[0]?.x ?? 0,
        z: t.kind?.initialZ ?? t.samples[0]?.z ?? 0,
      });
      const assignments = new Map<number, VehicleEntry | null>();
      const ambiguous: { traj: EntityTrajectory; entries: VehicleEntry[] }[] = [];
      for (const traj of shipTrajs) {
        const sid = traj.kind?.shipId;
        const entries = sid != null ? byShipId.get(sid) : undefined;
        if (entries && entries.length === 1) {
          assignments.set(traj.entityId, entries[0]);
        } else if (entries && entries.length > 1) {
          ambiguous.push({ traj, entries });
        } else {
          assignments.set(traj.entityId, null);
        }
      }
      if (ambiguous.length > 0) {
        let ax = 0, az = 0, an = 0, ex = 0, ez = 0, en = 0;
        // Roster entries already taken by unique joins — ambiguous picks must
        // not steal them, and two ambiguous entities must not share an entry.
        const claimed = new Set<VehicleEntry>();
        for (const traj of shipTrajs) {
          const a = assignments.get(traj.entityId);
          if (!a) continue;
          claimed.add(a);
          const s = spawnOf(traj);
          if (a.relation <= 1) { ax += s.x; az += s.z; an++; }
          else { ex += s.x; ez += s.z; en++; }
        }
        for (const { traj, entries } of ambiguous) {
          const unclaimed = entries.filter((e) => !claimed.has(e));
          let pick: VehicleEntry;
          if (an > 0 && en > 0) {
            const s = spawnOf(traj);
            const dAlly = (s.x - ax / an) ** 2 + (s.z - az / an) ** 2;
            const dEnemy = (s.x - ex / en) ** 2 + (s.z - ez / en) ** 2;
            const wantAlly = dAlly < dEnemy;
            pick =
              unclaimed.find((e) => (wantAlly ? e.relation <= 1 : e.relation > 1)) ??
              unclaimed[0] ??
              entries[0];
          } else {
            pick = unclaimed[0] ?? entries[0];
          }
          claimed.add(pick);
          assignments.set(traj.entityId, pick);
        }
      }
      return assignments;
    }

    /** Map each ship trajectory to its roster entry (for team role + ship
     *  model) via the precomputed roster assignments. When a trajectory has
     *  no matching roster entry (older replay, decode gap), the role falls
     *  back to the entity-id spawn-order heuristic: the client spawns team A
     *  before team B, so the first half of ships (by entity id) are treated
     *  as allies. Unresolved ships never claim the "self" role, so the
     *  recorder's own marker stays uniquely white. */
    function resolveMarkerContext(
      traj: EntityTrajectory,
      shipEntityIds: number[],
      assignments: Map<number, VehicleEntry | null>,
    ): { role: TeamRole; shipInfo: ShipInfo | null; entry: VehicleEntry | null } {
      const entry = assignments.get(traj.entityId) ?? null;
      let role: TeamRole;
      let shipInfo: ShipInfo | null;
      if (entry) {
        role = roleFromRelation(entry.relation);
        shipInfo = props.encyclopedia.get(entry.shipId) ?? null;
      } else {
        // Fallback: entity-id spawn order (team A spawns before team B).
        // Never "self" — only the exact match earns the recorder tint.
        const idx = shipEntityIds.indexOf(traj.entityId);
        const isAlly = idx >= 0 && idx < shipEntityIds.length / 2;
        role = isAlly ? "ally" : "enemy";
        shipInfo = null;
      }
      return { role, shipInfo, entry };
    }

    /** Build the trajectory lines + ship markers from the decoded data.
     *
     *  Each ship gets a colored trajectory line (team-tinted) and a marker.
     *  The marker starts as a small cone (instant, correct color), then an
     *  async GLB load swaps in the actual ship model (or a tier/nation/type
     *  fallback) tinted to the team color. If the model fails to load, the
     *  cone stays.
     *
     *  Also populates `shipLabels` — per-ship display data for the floating
     *  HTML labels overlaid on the canvas. Labels track player name, ship
     *  name, tier, type icon, role colour, and death state. */
    function rebuildActors() {
      clearActors();
      followStats.value.clear();
      const scene = api.value?.scene;
      if (!scene || props.trajectories.length === 0) { shipLabels.value = []; return; }
      const epoch = markerEpoch;

      // Encyclopedia as the fallback pool for tier/nation/type resolution.
      const encSpecs: ShipModelSpec[] = [...props.encyclopedia.values()];

      // Ships = EntityCreate type 2 that moved at least once. No sample-count
      // threshold: planes/torpedoes/smokes arrive on OTHER entity types, so a
      // type-2 entity with 2+ position samples IS a vessel — ships that sank
      // or sailed unobserved early carry few samples and must stay counted.
      // Zero/one-sample type-2 entities are re-creation duplicates with no
      // usable trajectory; skipping them prevents double-counting players.
      const isShip = (t: EntityTrajectory) =>
        t.kind?.entityType === 2 && t.samples.length > 1;
      const shipTrajs = props.trajectories.filter(isShip);
      shipEntityIds = shipTrajs.map((t) => t.entityId).sort((a, b) => a - b);
      rosterAssignments = resolveRosterAssignments(shipTrajs);
      const assignments = rosterAssignments;

      // Smoke screens (entityType 4 = SmokeScreen): white ring markers at
      // the smoke's START point (and END point when the drift exceeds 1 km)
      // with a floating remaining-seconds tag. No volumetric puffs — the
      // rings trace the smoke band. WoWS smoke lasts ~90s; without a destroy
      // packet each puff expires 90s after its last recorded position
      // update. While dissipating, the start ring walks from the launch
      // point toward the end point. Clusters of puffs at (almost) the same
      // spot collapse into one marker: the one with the longest lifetime.
      smokeClusters.length = 0;
      {
        const smokes = props.trajectories
          .filter((t) => t.kind?.entityType === 4 && t.samples.length >= 1)
          .sort((a, b) => (a.samples[0]?.time ?? 0) - (b.samples[0]?.time ?? 0));
        for (const tr of smokes) {
          const t0 = tr.samples[0].time;
          const lastT = tr.samples[tr.samples.length - 1].time;
          const endT = props.leavesMap[tr.entityId] ?? lastT + 90;
          const s0 = sampleAt(tr, t0);
          if (!s0) continue;
          let cluster = smokeClusters.find(
            (c) => Math.hypot(c.sx - s0.x, c.sz - s0.z) < 300,
          );
          if (!cluster) {
            cluster = {
              traj: tr,
              t0,
              lastT,
              endT,
              sx: s0.x,
              sz: s0.z,
              rings: [],
              timeSprite: null,
            };
            smokeClusters.push(cluster);
          } else if (endT > cluster.endT) {
            cluster.traj = tr;
            cluster.t0 = t0;
            cluster.lastT = lastT;
            cluster.endT = endT;
          }
        }
        const smokeRingGeom = new THREE.RingGeometry(40, 46, 36);
        const smokeRingMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        for (const cl of smokeClusters) {
          for (let i = 0; i < 2; i++) {
            const ring = new THREE.Mesh(smokeRingGeom, smokeRingMat);
            ring.rotation.x = -Math.PI / 2;
            ring.visible = false;
            scene.add(ring);
            cl.rings.push(ring);
          }
          const cvs = document.createElement("canvas");
          cvs.width = 128;
          cvs.height = 64;
          const tex = new THREE.CanvasTexture(cvs);
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: tex,
              transparent: true,
              depthWrite: false,
            }),
          );
          sprite.visible = false;
          sprite.scale.set(60, 30, 1);
          sprite.userData.canvas = cvs;
          sprite.userData.text = "";
          scene.add(sprite);
          cl.timeSprite = sprite;
        }
      }

      // Shell flights reconstructed between a launch and its impact: for
      // every explosion find the nearest ship that was alive, within 15 km,
      // and pointed within ~25° of the impact at the estimated launch time;
      // draw a ballistic arc from its position to the impact point. Launch
      // time is estimated from distance with a ~800 m/s muzzle velocity.
      const shipForImpact = (e: ExplosionEvent) => {
        let best: { tr: EntityTrajectory; score: number; t0: number; h: number } | null = null;
        for (const tr of props.trajectories) {
          if (tr.kind?.entityType !== 2 || tr.samples.length < 2) continue;
          const s = sampleAt(tr, e.time);
          if (!s) continue;
          const dist = Math.hypot(s.x - e.x, s.z - e.z);
          // A main-battery round can't come from 300 m away — requiring a
          // minimum range rejects near-impact ships that merely sail past the
          // splash (those read as short, flat, "not a shell" streaks).
          if (dist < 300 || dist > 15000) continue;
          const flightT = Math.min(8, Math.max(0.8, dist / 800));
          const t0 = e.time - flightT;
          const s0 = sampleAt(tr, t0);
          if (!s0) continue;
          const dx = e.x - s0.x;
          const dz = e.z - s0.z;
          const aim = Math.atan2(dx, dz);
          let dYaw = Math.abs(aim - s0.yaw);
          if (dYaw > Math.PI) dYaw = 2 * Math.PI - dYaw;
          if (dYaw > 0.45) continue; // ~25°
          const score = dist + dYaw * 4000;
          if (!best || score < best.score) {
            // Ballistic height: steep enough to read as a shell arc, growing
            // with range (a flat 10-unit curve looks like a laser beam).
            best = { tr, score, t0, h: Math.min(420, 60 + dist * 0.16) };
          }
        }
        return best;
      };
      const flashGeom = new THREE.SphereGeometry(20, 10, 10);
      const flashMat = new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const flashHaloGeom = new THREE.SphereGeometry(46, 10, 10);
      const flashHaloMat = new THREE.MeshBasicMaterial({
        color: 0xffb347,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      const curvePts = new Float32Array(28 * 3);
      // Shared cone geometry for in-flight shells (tip pointing +Y; oriented
      // along the trajectory tangent each frame for a smooth補间).
      const shellGeom = new THREE.ConeGeometry(3, 12, 8);
      // The enemy ship nearest the impact point at impact time, INSIDE the
      // launch-direction cone — arcs end at the TARGET SHIP (not the bare
      // water splash) so they read as fire against the opposing fleet. The
      // cone keeps the endpoint on the shell's actual heading: a nearby enemy
      // that is off to the side must not bend the arc sideways.
      const targetShipAt = (e: ExplosionEvent, from: { x: number; z: number }) => {
        let best: { x: number; z: number } | null = null;
        let bestD = 500;
        const baseAim = Math.atan2(e.x - from.x, e.z - from.z);
        for (const tr of props.trajectories) {
          if (tr.kind?.entityType !== 2 || resolveRoleQuick(tr) !== "enemy") continue;
          const s = sampleAt(tr, e.time);
          if (!s) continue;
          const d = Math.hypot(s.x - e.x, s.z - e.z);
          if (d > bestD) continue;
          const aim = Math.atan2(s.x - from.x, s.z - from.z);
          let dAim = Math.abs(aim - baseAim);
          if (dAim > Math.PI) dAim = 2 * Math.PI - dAim;
          if (dAim > 0.35) continue; // ~20° cone around the launch heading
          bestD = d;
          best = { x: s.x, z: s.z };
        }
        return best;
      };
      for (const e of props.explosions) {
        const match = shipForImpact(e);
        if (!match) continue;
        // Per-ammo colors: HE yellow, AP silver, SAP grey.
        const ammo = shellAmmoOf(e.paramsId);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(curvePts, 3));
        // Manual BufferGeometry has no bounding sphere; without computing one
        // (or disabling culling) the frustum culler skips these lines.
        geom.computeBoundingSphere();
        const mat = new THREE.LineBasicMaterial({
          color: ammo.color,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        });
        const line = new THREE.Line(geom, mat);
        line.visible = false;
        scene.add(line);
        // Same curve rendered as fixed-pixel points so the flight reads even
        // at full-map zoom (a 1px line vanishes at that distance).
        const dotGeo = new THREE.BufferGeometry();
        dotGeo.setAttribute("position", new THREE.BufferAttribute(curvePts, 3));
        dotGeo.computeBoundingSphere();
        const dotMat = new THREE.PointsMaterial({
          color: ammo.color,
          size: 3.5,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        });
        const dots = new THREE.Points(dotGeo, dotMat);
        dots.visible = false;
        scene.add(dots);
        // In-flight shell: a pointed cone sliding along the arc (interpolated
        // every frame so playback looks smooth).
        const shellMat = new THREE.MeshBasicMaterial({
          color: ammo.color,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        });
        const shell = new THREE.Mesh(shellGeom, shellMat);
        shell.visible = false;
        scene.add(shell);
        const flash = new THREE.Mesh(flashGeom, flashMat);
        flash.position.set(e.x, 1, -e.z);
        flash.visible = false;
        scene.add(flash);
        const flashHalo = new THREE.Mesh(flashHaloGeom, flashHaloMat);
        flashHalo.position.set(e.x, 1, -e.z);
        flashHalo.visible = false;
        scene.add(flashHalo);
        const target = targetShipAt(e, {
          x: sampleAt(match.tr, match.t0)?.x ?? e.x,
          z: sampleAt(match.tr, match.t0)?.z ?? e.z,
        });
        shellTraces.push({
          line,
          dots,
          flash,
          halo: flashHalo,
          shell,
          color: ammo.color,
          t0: match.t0,
          t1: e.time,
          // Launch point is fixed at the firing ship's position at t0 — using
          // the live playhead position would drag the whole arc (and the
          // shell) across the map as playback moves on.
          from: () => {
            const s = sampleAt(match.tr, match.t0);
            return s ? new THREE.Vector3(s.x, 0, -s.z) : null;
          },
          to: new THREE.Vector3(target?.x ?? e.x, 0, -(target?.z ?? e.z)),
          h: match.h,
        });
      }
      trajectoryLines.push(...shellTraces.map((st) => st.line));

      // Torpedoes: straight white capsules from the firing ship's position at
      // launch time along the launch direction. Speed ~33 m/s (60 knots);
      // visible until 8 km of travel (or match end). Each torpedo carries a
      // long white wake line so it reads at full-map zoom.
      const torpedoGeom = new THREE.CapsuleGeometry(3, 12, 2, 8);
      const torpedoMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const wakeGeom = new THREE.BufferGeometry();
      wakeGeom.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(6), 3),
      );
      const wakeMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      for (const tp of props.torpedoes) {
        const traj = props.trajectories.find((tr) => tr.entityId === tp.entityId);
        const s = traj ? sampleAt(traj, tp.time) : null;
        if (!s) continue;
        const mesh = new THREE.Mesh(torpedoGeom, torpedoMat);
        const wake = new THREE.Line(wakeGeom, wakeMat);
        mesh.visible = false;
        wake.visible = false;
        scene.add(mesh);
        scene.add(wake);
        torpedoMeshes.push({
          mesh,
          wake,
          t0: tp.time,
          life: 240,
          base: new THREE.Vector3(s.x, 0, -s.z),
          dir: new THREE.Vector3(tp.dirX, 0, -tp.dirZ).normalize(),
        });
      }

      // Swap the primitive placeholders for the real game models (baked GLBs
      // from scripts/model_convert/bake_planes.py). Each swap keeps driving
      // the replacement exactly like the primitive it replaces.
      const shellPropUrl = resolvePropModelUrl("shell");
      if (shellPropUrl) {
        for (const st of shellTraces) {
          buildPropMarker({ url: shellPropUrl, color: st.color, axis: "y", targetLen: 9 })
            .then((g) => {
              if (epoch !== markerEpoch || !api.value?.scene) return;
              g.visible = st.shell.visible;
              g.position.copy(st.shell.position);
              g.quaternion.copy(st.shell.quaternion);
              scene.add(g);
              scene.remove(st.shell);
              st.shell = g;
            })
            .catch(() => { /* keep the cone fallback */ });
        }
      }
      const torpedoPropUrl = resolvePropModelUrl("torpedo");
      if (torpedoPropUrl) {
        for (const tm of torpedoMeshes) {
          buildPropMarker({ url: torpedoPropUrl, color: 0xffffff, axis: "y", targetLen: 14, opacity: 1 })
            .then((g) => {
              if (epoch !== markerEpoch || !api.value?.scene) return;
              g.visible = tm.mesh.visible;
              g.position.copy(tm.mesh.position);
              g.quaternion.copy(tm.mesh.quaternion);
              scene.add(g);
              scene.remove(tm.mesh);
              tm.mesh = g;
            })
            .catch(() => { /* keep the capsule fallback */ });
        }
      }

      // Reusable explosion rings for shell impacts / splashes.
      const ringGeomFx = new THREE.RingGeometry(0.35, 1, 24);
      const ringMatFx = new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      for (let i = 0; i < 20; i++) {
        const ring = new THREE.Mesh(ringGeomFx, ringMatFx);
        ring.visible = false;
        ring.rotation.x = -Math.PI / 2;
        scene.add(ring);
        explosionFx.push({ ring, born: -1 });
      }

      // Recorder aim line: thin line from the own ship to the locked target
      // entity (SetWeaponLock 0x30 timeline), updated per frame. Same render
      // path as shell traces (line + bounding sphere) which is known-good.
      if (props.weaponLocks.length > 0) {
        const lockGeom = new THREE.BufferGeometry();
        lockGeom.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(6), 3),
        );
        lockGeom.computeBoundingSphere();
        const lockMat = new THREE.LineBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
        });
        const line = new THREE.Line(lockGeom, lockMat);
        line.visible = false;
        scene.add(line);
        lockLine = line as unknown as THREE.Mesh;
      }

      // Aircraft squadrons: one model per plane, positions come from the
      // avatar's receive_updateSquadron stream. Each update packet carries
      // one sample per aircraft (index 0..count-1), so (planeId, index)
      // uniquely identifies a single plane — a squadron of N planes becomes
      // N trails instead of one.
      const byPlane = new Map<number, SquadronPlane[]>();
      for (const sp of props.squadronPlanes) {
        const key = sp.planeId * 16 + (sp.index ?? 0);
        let list = byPlane.get(key);
        if (!list) {
          list = [];
          byPlane.set(key, list);
        }
        list.push(sp);
      }
      planeTrails = [...byPlane.entries()].map(([id, samples]) => ({
        id,
        samples: samples.sort((a, b) => a.time - b.time),
      }));
      // (planeId, index) → aircraft type (via the squadron create's
      // paramsId). Trails keyed by planeId*16+index, so every formation
      // member maps to its squadron's type.
      planeTypesById.clear();
      for (const c of props.squadronCreates) {
        const type = PLANE_TYPES[String(c.paramsId)]?.type ?? "attack";
        const index = PLANE_TYPES[String(c.paramsId)]?.index;
        for (let i = 0; i < 16; i++) {
          planeTypesById.set(c.planeId * 16 + i, type);
          if (index) planeIndexById.set(c.planeId * 16 + i, index);
        }
      }
      if (planeTrails.length > 0) {
        const colors = new Float32Array(planeTrails.length * 3);
        for (let i = 0; i < planeTrails.length; i++) {
          // Team colour (ally green / enemy red) instead of per-type tint —
          // the HUD paints aircraft by allegiance, not by airframe.
          const planeId = Math.floor(planeTrails[i].id / 16);
          const role = planeRoleById.get(planeId) ?? "enemy";
          const c = new THREE.Color(TEAM_COLOR[role as TeamRole] ?? 0x78d2ff);
          colors[i * 3] = c.r;
          colors[i * 3 + 1] = c.g;
          colors[i * 3 + 2] = c.b;
        }
        const pg = new THREE.BufferGeometry();
        pg.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(planeTrails.length * 3), 3),
        );
        pg.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        pg.computeBoundingSphere();
        const pm = new THREE.PointsMaterial({
          size: 5,
          sizeAttenuation: false,
          vertexColors: true,
        });
        const points = new THREE.Points(pg, pm);
        points.visible = false;
        scene.add(points);
        planeCloud = points;
      }

      // Real aircraft models: per FORMATION (one GLB clone per squadron slot —
      // the GameParams squadron size, e.g. 8), arranged in a wedge each frame.
      // Trails whose model fails/misses keep the Points fallback.
      planeMeshes.clear();
      planeFormations.clear();
      {
        // Group trails by planeId first.
        const byPlane = new Map<number, { idx: string; role: string; count: number; trail: { id: number; samples: SquadronPlane[] } }[]>();
        for (const trail of planeTrails) {
          const planeId = Math.floor(trail.id / 16);
          const idx = planeIndexById.get(trail.id);
          if (!idx) continue;
          const role = planeRoleById.get(planeId) ?? "enemy";
          let list = byPlane.get(planeId);
          if (!list) {
            list = [];
            byPlane.set(planeId, list);
          }
          const typeKey = PLANE_TYPES[String(
            props.squadronCreates.find((c) => c.planeId === planeId)?.paramsId,
          )];
          const count = (typeKey?.count ?? 3);
          if (list.length === 0) {
            planeFormations.set(planeId, { count, groupSize: 1, groupCount: count, meshes: [] });
          }
          list.push({ idx, role, count, trail });
        }
        const seenKey = new Set<string>();
        for (const [planeId, entries] of byPlane) {
          // Infer the group layout from the launch positions (clusters of
          // planes spawned together = one flight group).
          const grp = inferGrouping(entries, sampleAt);
          const formation = planeFormations.get(planeId)!;
          formation.groupSize = Math.max(1, Math.min(grp.groupSize, formation.count));
          formation.groupCount = Math.max(1, grp.groupCount);
          const first = entries[0];
          const url = resolvePlaneModelUrl(first.idx);
          if (!url) continue;
          const seen = `${first.idx}:${first.role}`;
          const build = seenKey.has(seen)
            ? null
            : buildPropMarker({
                url,
                color: TEAM_COLOR[first.role as TeamRole] ?? 0x78d2ff,
                axis: "z",
                targetLen: 7,
                opacity: 0.95,
              }).catch(() => null);
          seenKey.add(seen);
          if (!build) continue;
          const formationForPool = planeFormations.get(planeId)!;
          build.then((proto) => {
            if (epoch !== markerEpoch || !api.value?.scene || !proto) return;
            if (planeMeshes.has(planeId)) return;
            const pool: THREE.Object3D[] = [];
            for (let i = 0; i < formationForPool.count; i++) {
              const inst = proto.clone(true);
              inst.userData.sharedGeometry = true;
              inst.visible = false;
              scene.add(inst);
              pool.push(inst);
            }
            planeMeshes.set(planeId, pool);
          });
        }
      }

      const newLabels: ShipLabel[] = [];

      for (const traj of props.trajectories) {
        if (traj.samples.length < 2) continue;
        // Only render ships (EntityCreate type 2 with many samples); skip
        // zones/avatars/planes/torpedoes.
        if (!isShip(traj)) continue;

        const { role, shipInfo, entry: rosterEntry } = resolveMarkerContext(
          traj,
          shipEntityIds,
          assignments,
        );
        const color = TEAM_COLOR[role];
        const offline = shipOfflineEntry((rosterEntry?.shipId ?? traj.kind?.shipId) ?? undefined);
        const shipType = shipInfo?.type ?? offline?.type ?? null;

        // Marker: class-scaled HULL OUTLINE (vector line loop — reads at any
        // zoom and never depends on GLB availability) plus a small cone+dot
        // so the heading stays visible before/outside the outline. Cone
        // points +Z (forward) at yaw 0.
        const marker = new THREE.Group();
        const hull = makeHullOutline(color, shipType);
        hull.userData.hullOutline = true;
        marker.add(hull);
        marker.userData.hull = hull;
        const coneGeom = new THREE.ConeGeometry(7, 18, 6);
        const coneMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 });
        const cone = new THREE.Mesh(coneGeom, coneMat);
        cone.rotation.x = Math.PI / 2; // cone tip along +Z
        cone.position.z = 6; // shift forward so sphere is behind the tip
        marker.add(cone);
        const dotGeom = new THREE.SphereGeometry(8, 10, 6);
        const dotMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 });
        const dot = new THREE.Mesh(dotGeom, dotMat);
        dot.position.z = 0;
        marker.add(dot);
        marker.userData.entityId = traj.entityId;
        marker.userData.role = role;
        marker.userData.type = shipType;
        marker.userData.modelLoaded = false;
        marker.userData.isDot = true;
        marker.userData.deathTime = traj.deathTime ?? null;
        marker.userData.spawnX = traj.kind?.initialX ?? 0;
        marker.userData.spawnZ = traj.kind?.initialZ ?? 0;
        marker.userData.firstT = traj.samples[0]?.time ?? Infinity;
        // Ghost: the same class-scaled hull outline marking an unobserved /
        // sunk ship's last-known position — GREEN for allies, red for
        // enemies (the game's "not spotted" marker; white stays reserved
        // for the recorder's own hull). Enemy ships that were never seen
        // stay invisible.
        {
          const ghostCol = role === "enemy" ? 0xcc3333 : TEAM_COLOR.ally;
          const ghost = makeHullOutline(ghostCol, shipType, 0.85);
          ghost.position.set(traj.kind?.initialX ?? 0, 0, -(traj.kind?.initialZ ?? 0));
          ghost.rotation.y = Math.PI - (traj.samples[0]?.yaw ?? 0);
          ghost.visible = false;
          scene.add(ghost);
          marker.userData.ghost = ghost;
        }
        marker.visible = false;
        scene.add(marker);
        shipMarkers.push(marker);

        const modelUrl =
          resolveShipModelForEntry(shipInfo, encSpecs) ??
          (rosterEntry?.shipId != null
            ? resolveShipModelByShipId(rosterEntry.shipId)
            : null);
        // The marker's cone stays as-is until a model arrives; ships whose
        // own GLB is missing/unloadable still get a hull — a same-role model
        // already loaded for another ship, cloned and re-tinted — instead of
        // a bare cone.
        const installModel = (target: THREE.Group, model: THREE.Group) => {
          for (const child of [...target.children]) {
            // The hull outline survives the model swap — it is the tactical
            // marker, not placeholder art.
            if ((child.userData?.hullOutline as boolean) === true) continue;
            target.remove(child);
            child.traverse((o) => {
              if (o instanceof THREE.Mesh) {
                o.geometry.dispose();
                (o.material as THREE.Material).dispose();
              }
            });
          }
          target.add(model);
          target.userData.modelLoaded = true;
          target.userData.isDot = false;
          // Re-run the per-frame visibility rules (opening-phase enemy
          // hiding, creation time) instead of forcing the marker on.
          updateMarkersAt(current.value);
          initMarkerPosition(target, traj, current.value);
          updateLabelPositions();
        };
        const buildFromLoadedPool = () => {
          // Prefer a model from the same side (self/ally vs enemy).
          const sub =
            loadedModelPool.find((p) => p.role === role) ??
            loadedModelPool[0];
          if (!sub) return false;
          try {
            const replacement = buildMarkerFromSource(sub.model, role);
            loadedModelPool.push({ model: replacement, role });
            installModel(marker, replacement);
            return true;
          } catch (e) {
            console.warn(`[HolographicMap] substitute model for entity ${traj.entityId} failed:`, e);
            return false;
          }
        };
        const drainModelWaiters = () => {
          for (let i = modelWaiters.length - 1; i >= 0; i--) {
            const w = modelWaiters[i];
            if (w.marker.userData.modelLoaded) {
              modelWaiters.splice(i, 1);
              continue;
            }
            const sub =
              loadedModelPool.find((p) => p.role === w.marker.userData.role) ??
              loadedModelPool[0];
            if (!sub) continue;
            try {
              const replacement = buildMarkerFromSource(sub.model, w.marker.userData.role);
              loadedModelPool.push({ model: replacement, role: w.marker.userData.role });
              installModel(w.marker, replacement);
              modelWaiters.splice(i, 1);
            } catch (e) {
              console.warn(`[HolographicMap] substitute model for entity ${w.traj.entityId} failed:`, e);
            }
          }
        };
        if (!modelUrl) {
          console.warn(`[HolographicMap] no model URL for entity ${traj.entityId}`
            + ` (ship: ${shipInfo?.name ?? "?"}, shipId: ${rosterEntry?.shipId}, encyclopedia: ${encSpecs.length} entries)`);
          if (!buildFromLoadedPool()) modelWaiters.push({ marker, traj });
        } else {
          buildShipMarker({ url: modelUrl, role })
            .then((shipModel) => {
              if (epoch !== markerEpoch || !api.value?.scene) return;
              loadedModelPool.push({ model: shipModel, role });
              installModel(marker, shipModel);
              // Fill every marker still waiting on a hull from the model
              // pool (same-role first), newest models included.
              drainModelWaiters();
            })
            .catch((e) => {
              console.warn(`[HolographicMap] failed to load marker model for entity ${traj.entityId}:`, e);
              if (epoch !== markerEpoch) return;
              if (!buildFromLoadedPool()) modelWaiters.push({ marker, traj });
            });
        }

        const name = rosterEntry?.name ?? `#${traj.entityId}`;
        const encStore = useEncyclopediaStore();
        const dataLang = useLanguage().dataLanguage.value;
        // Name/tier/type: the WG encyclopedia when it knows the ship, else the
        // complete offline DB (GameParams + game gettext catalogs — covers
        // event/clone ships), else the baked model DB's English base name.
        const shipName =
          (shipInfo ? encStore.shipDisplayName(shipInfo) : null) ??
          shipNameFromOfflineDb((rosterEntry?.shipId ?? traj.kind?.shipId) ?? undefined, dataLang) ??
          rosterEntry?.shipName ??
          shipInfo?.name ??
          shipNameFromModelDb((rosterEntry?.shipId ?? traj.kind?.shipId) ?? undefined) ??
          "?";
        // Max HP: the peak of the entity's own HP stream — authoritative for
        // the battle's actual scaling (event/asymmetric modes cut bot HP to a
        // fraction of the encyclopedia hull value; upgraded hulls raise it).
        // Ships without any HP stream fall back to the encyclopedia hull value
        // so their label still shows a (static) health line.
        const streamMax =
          traj.hpSamples && traj.hpSamples.length > 0
            ? Math.max(...traj.hpSamples.map((s) => s.value))
            : null;
        const dp = shipInfo?.defaultProfile as
          | Record<string, Record<string, unknown>>
          | undefined;
        const encHealth =
          dp?.hull?.health != null && typeof dp.hull.health === "number"
            ? dp.hull.health
            : null;
        // Fallback chain: battle stream (authoritative) → encyclopedia hull →
        // offline DB hull HP (GameParams) → none (label hides the HP row).
        const maxHp = streamMax ?? encHealth ?? offline?.hp ?? null;
        newLabels.push({
          entityId: traj.entityId,
          role,
          name,
          shipName,
          shipId: (rosterEntry?.shipId ?? traj.kind?.shipId) ?? undefined,
          tier: shipInfo?.tier ?? offline?.tier ?? null,
          type: shipInfo?.type ?? offline?.type ?? null,
          hp: maxHp,
          maxHp,
          ghostText: null,
          x: 0, y: 0,
          visible: false,
          dead: false,
        });
      }
      // Aircraft labels: ONE card per controlling carrier (aircraft squadrons
      // re-launch constantly — 100+ sorties in a carrier match — so per-
      // squadron cards would explode the UI). The card shows the carrier's
      // name + HP with the plane-type icon. A squadron's carrier is the ship
      // nearest its FIRST create position (the create fires on the deck at
      // launch; later creates are mid-air sortie positions).
      planeLabelCarriers.clear();
      planeRoleById.clear();
      const planeCarrierOf = new Map<number, number | null>();
      const createFirst = new Map<number, { x: number; z: number; time: number; paramsId: number }>();
      for (const c of props.squadronCreates) {
        if (!createFirst.has(c.planeId)) {
          createFirst.set(c.planeId, { x: c.x, z: c.z, time: c.time, paramsId: c.paramsId });
        }
      }
      for (const [planeId, first] of createFirst) {
        // Match against the ship's position AT LAUNCH TIME (ships move — the
        // current playhead position would pair a sortie with the wrong ship).
        // The create fires on the flight deck, so prefer a REAL carrier
        // (AirCarrier type) within carrier range; only fall back to any ship
        // within a much tighter radius when no CV is nearby (hybrid carriers
        // like Ise/Tone are typed Battleship, unknown offline ships have no
        // type). Without the type filter a sortie from a distant CV gets
        // pinned to whatever friendly ship sails nearest — e.g. a Vladivostok
        // ends up wearing a bomber label and squadrons flip to the wrong side.
        let cvId: number | null = null;
        let cvD = 1000;
        let anyId: number | null = null;
        let anyD = 400;
        for (const m of shipMarkers) {
          const tr = props.trajectories.find((t) => t.entityId === m.userData.entityId);
          if (!tr) continue;
          const s = sampleAt(tr, first.time);
          if (!s) continue;
          const d = Math.hypot(s.x - first.x, s.z - first.z);
          if (d < cvD) {
            const lbl = newLabels.find((l) => l.entityId === m.userData.entityId);
            if (/^AirCarrier/i.test(lbl?.type ?? "")) {
              cvD = d;
              cvId = m.userData.entityId as number;
            }
          }
          if (d < anyD) {
            anyD = d;
            anyId = m.userData.entityId as number;
          }
        }
        const carrierId = cvId ?? anyId;
        planeCarrierOf.set(planeId, carrierId);
        const carrierMarker = carrierId == null
          ? null
          : shipMarkers.find((m) => m.userData.entityId === carrierId);
        planeRoleById.set(planeId, carrierMarker?.userData.role ?? "enemy");
        const firstCreate = props.squadronCreates.find((c) => c.planeId === planeId);
        const planeIdx = PLANE_TYPES[String(firstCreate?.paramsId)]?.index;
        if (planeIdx) planeIndexById.set(planeId * 16, planeIdx);
      }
      // One label per carrier that controls any aircraft.
      const carriersOfPlanes = new Map<number, { paramsId: number }>();
      for (const [planeId, carrierId] of planeCarrierOf) {
        if (carrierId == null) continue;
        const first = createFirst.get(planeId)!;
        const acc = carriersOfPlanes.get(carrierId) ?? { paramsId: first.paramsId };
        carriersOfPlanes.set(carrierId, acc);
      }
      for (const [carrierId, info] of carriersOfPlanes) {
        const planeType = PLANE_TYPES[String(info.paramsId)]?.type ?? "attack";
        newLabels.push({
          entityId: 2_000_000_000 + Number(carrierId),
          role: "self",
          name: "",
          shipName: "",
          tier: null,
          type: null,
          kind: "plane",
          planeType,
          hp: null,
          maxHp: null,
          x: 0, y: 0,
          visible: false,
          dead: false,
        });
        planeLabelCarriers.set(2_000_000_000 + Number(carrierId), carrierId);
      }
      // Keep a per-plane → labelId map for the per-frame position update.
      planeLabelOfPlane.clear();
      for (const [planeId, carrierId] of planeCarrierOf) {
        if (carrierId != null) {
          planeLabelOfPlane.set(planeId, 2_000_000_000 + Number(carrierId));
        }
      }
      shipLabels.value = newLabels;

      // Opening view: aim the camera at the allied fleet and skip any
      // pre-battle countdown (ships frozen before the first movement).
      openSceneDefaults();

      // Capture zones: entityType 14 circles on the XZ plane.
      // Capture zones are static and may have no position samples; use the
      // initial position from EntityCreate metadata. Points that share the
      // same center (concentric inner/outer-ring layouts, e.g. two cap zones
      // on one spot) are merged visually: their rings are pushed side by side
      // with tiered radii so both letters stay readable instead of stacking
      // on top of each other. The number of points is data-driven (PvE
      // scenarios create new points mid-battle).
      // Only real domination points (those with an ownership/progress stream)
      // get 3D rings + letters — non-capture InteractiveZones are filtered by
      // capZones. The number of points is data-driven (PvE scenarios create
      // new points mid-battle).
      const capEntries = capZones.value.map((t, idx) => ({
        x: t.kind!.initialX,
        z: t.kind!.initialZ,
        // Modern domination points carry ~490 m rings; fall back to a large
        // default when the create state yields no radius candidate.
        radius: t.kind!.radius ?? 300,
        order: idx,
      }));
      if (capEntries.length === 0) {
        console.warn("[HolographicMap] no capture zone data found in trajectory kinds");
      }
      // Group by shared center (within 30 m).
      const groups: { x: number; z: number; members: { x: number; z: number; radius: number; order: number }[] }[] = [];
      for (const e of capEntries) {
        const g = groups.find(
          (gr) => Math.abs(gr.x - e.x) < 30 && Math.abs(gr.z - e.z) < 30,
        );
        if (g) g.members.push(e);
        else groups.push({ x: e.x, z: e.z, members: [e] });
      }
      groups.sort((a, b) => a.members[0].order - b.members[0].order);
      let letterIdx = 0;
      for (const g of groups) {
        const n = g.members.length;
        for (let k = 0; k < n; k++) {
          // Concentric group: offset each member along x, outer ring larger.
          // Use the REAL radius (create-state InteractiveZone.radius, 20..60 m
          // typical) — clamping to a big minimum made adjacent points'
          // rings overlap and diverged from the minimap proportions.
          const spread = n > 1 ? 55 * (k - (n - 1) / 2) : 0;
          const radius = Math.max(g.members[k].radius, 25);
          const cx = g.x + spread;
          const cz = g.z;
          const ringGeom = new THREE.TorusGeometry(radius, 2.4, 8, 48);
          const ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          });
          const ring = new THREE.Mesh(ringGeom, ringMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.set(cx, 0.6, -cz);
          scene.add(ring);
          trajectoryLines.push(ring as unknown as THREE.Line);
          capRings.push(ring);
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 64;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "rgba(255,255,255,0.8)";
          ctx.font = "bold 48px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String.fromCharCode(65 + letterIdx++), 32, 32);
          const tex = new THREE.CanvasTexture(canvas);
          const spriteMat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
          });
          const sprite = new THREE.Sprite(spriteMat);
          sprite.position.set(cx, 30, -cz);
          sprite.scale.set(40, 40, 1);
          scene.add(sprite);
          trajectoryLines.push(sprite as unknown as THREE.Line);
          capLetterSprites.push(sprite);
        }
      }
    }

    /** Set a freshly-loaded marker to the correct world position at the current
     *  playback time so it snaps to the right spot immediately. */
    function initMarkerPosition(
      marker: THREE.Group,
      traj: EntityTrajectory,
      t: number,
    ) {
      const s = sampleAt(traj, t);
      if (s) {
        marker.position.set(s.x, 0, -s.z);
        // WoWS yaw: 0=north(+worldZ), clockwise. three.js north is -z, so the
        // yaw maps to rotation.y = PI - yaw on the mirrored coordinate frame.
        marker.rotation.y = Math.PI - s.yaw;
        marker.userData.yaw = s.yaw;
      }
    }

    /** Find the last HP value at or before time t. */
    function hpAtTime(samples: HpSample[] | undefined, t: number): number | null {
      if (!samples || samples.length === 0) return null;
      let last: number = samples[0].value;
      for (const s of samples) {
        if (s.time > t) break;
        last = s.value;
      }
      return last;
    }

    /** Capture progress (0..1000) at time t from the game's own stream.
     *  STEP semantics, zero outside the stream's span: a home point emits no
     *  samples until it is first contested (the Canada 2-cap's own point's
     *  first sample is at t=311s) — extrapolating that first sample back to
     *  t=0 made every home point read "being captured" from the opening
     *  second. Values hold between samples (the game reports on change). */
    function progressAtTime(samples: HpSample[] | undefined, t: number): number | null {
      if (!samples || samples.length === 0) return null;
      if (t < samples[0].time) return 0;
      let v = samples[0].value;
      for (const s of samples) {
        if (s.time <= t) v = s.value;
        else break;
      }
      return v;
    }

    /** Position + orient each ship marker at the current playback time.
     *  Ships whose model hasn't loaded yet are skipped; ships that have been
     *  destroyed (time ≥ deathTime) are frozen at their last position and
     *  their materials desaturated to a faint grey tint. */
    function updateMarkersAt(t: number) {
      const labels = shipLabels.value;
      // Alive counts are recomputed every frame from the markers' death times
      // (not incremented) so scrubbing backward restores sunk ships.
      let allyAliveNow = 0;
      let enemyAliveNow = 0;
      for (const m of shipMarkers) {
        const dt = m.userData.deathTime as number | null;
        if (dt == null || t < dt) {
          const role = m.userData.role as TeamRole;
          if (role === "ally" || role === "self") allyAliveNow++;
          else if (role === "enemy") enemyAliveNow++;
        }
      }
      allyAlive.value = allyAliveNow;
      enemyAlive.value = enemyAliveNow;
      for (let i = 0; i < shipMarkers.length; i++) {
        const marker = shipMarkers[i];
        const label = labels[i];
        const entityId = marker.userData.entityId as number;
        const traj = props.trajectories.find((tr) => tr.entityId === entityId);
        if (!traj || traj.samples.length === 0) {
          marker.visible = false;
          if (label) label.visible = false;
          continue;
        }
        // Ghost policy: an unobserved enemy (never seen once) is NOT rendered
        // at all; an unobserved ally shows a hollow WHITE box at its spawn.
        // Sunk ships (observed before dying) keep a hollow box at their last
        // position — white for allies, red for enemies.
        const role = marker.userData.role as TeamRole;
        const ghostBox = marker.userData.ghost as THREE.LineLoop | undefined;
        const firstT = marker.userData.firstT as number;
        // NOTE: no creationTime gate. A ship's EntityCreate fires when the
        // recorder FIRST OBSERVES it (creationTime tracks the first sample),
        // so gating on it would hide not-yet-spotted ALLIES for the whole
        // opening. The game shows teammates' last-known position from t=0 —
        // we do the same via the spawn ghost below. Unobserved enemies are
        // already fully hidden by the firstT rule.
        const deathTime = marker.userData.deathTime as number | null;
        const dead = deathTime != null && t >= deathTime;
        if (label) label.dead = dead;
        const tEff = dead ? deathTime! : t;
        const observed = tEff >= firstT;

        if (!observed) {
          if (role === "enemy") {
            if (ghostBox) ghostBox.visible = false;
            marker.visible = false;
            if (label) label.visible = false;
          } else {
            marker.position.set(traj.kind?.initialX ?? 0, 0, -(traj.kind?.initialZ ?? 0));
            marker.rotation.y = Math.PI - (traj.samples[0]?.yaw ?? 0);
            marker.visible = false;
            if (ghostBox) {
              ghostBox.visible = true;
              ghostBox.position.set(traj.kind?.initialX ?? 0, 0, -(traj.kind?.initialZ ?? 0));
            }
            if (label) {
              label.visible = true;
              label.ghostText = i18nT("replay.legend.gone", { n: t.toFixed(0) });
            }
          }
          continue;
        }
        if (ghostBox) ghostBox.visible = false;

        // After death the ship is gone from the water: hollow box at the
        // LIVE position (sinking ships keep drifting in the samples) + a
        // "sunk" label that keeps tracking the actual coordinates.
        const s: ReturnType<typeof sampleAt> | null = sampleAt(traj, dead ? t : tEff);
        if (!s) {
          marker.visible = false;
          if (label) label.visible = false;
          continue;
        }
        // Show the dot marker even before the ship model loads; hide only
        // when model is missing entirely (not dot, not loaded).
        const hasModel = marker.userData.modelLoaded as boolean;
        const hasDot = marker.userData.isDot as boolean;
        if (!hasModel && !hasDot) continue;
        if (dead) {
          if (ghostBox) {
            ghostBox.visible = true;
            ghostBox.position.set(s.x, 0, -s.z);
          }
          marker.visible = false;
          // Keep the marker transform in sync so the floating label projects
          // to the ship's actual position (not the death instant).
          marker.position.set(s.x, 0, -s.z);
          marker.rotation.y = Math.PI - s.yaw;
          if (label) {
            // Sunk ships keep the dead tag — no "gone for N s" counter.
            label.visible = true;
            label.ghostText = null;
          }
          if (!marker.userData._countedDead) {
            marker.userData._countedDead = true;
            const role = marker.userData.role as TeamRole;
            // Kill feed + score tick. The killer's identity lives in the
            // post-battle payload (killerId, index 408) — resolve it to a
            // nickname, ship name and ship type at sink time.
            if (!reportedSinks.has(entityId)) {
              reportedSinks.add(entityId);
              const who = label?.name ?? `#${entityId}`;
              // Killer resolution: the killer's account id lives in the
              // post-battle payload (index 408); map it back to a nickname
              // via the same playersPublicInfo table.
              let killerName: string | null = null;
              let killerShipId: number | null = null;
              let killerShipName = "";
              let killerShipType: string | null = null;
              if (props.battleResults) {
                pbCache ??= parsePostBattle(props.battleResults);
              }
              if (pbCache?.players && who) {
                const vn = who.trim().toLowerCase();
                const victim = pbCache.players.find(
                  (p) => (p.name ?? "").trim().toLowerCase() === vn,
                );
                if (victim?.killerId != null) {
                  const killer = pbCache.players.find(
                    (p) => p.accountId === victim.killerId,
                  );
                  killerName = killer?.name ?? null;
                  killerShipId = killer?.shipId ?? null;
                }
              }
              if (killerShipId != null) {
                const encStore = useEncyclopediaStore();
                const dataLang = useLanguage().dataLanguage.value;
                const kinfo = props.encyclopedia.get(killerShipId) as ShipInfo | undefined;
                const koff = shipOfflineEntry(killerShipId);
                killerShipName =
                  (kinfo ? encStore.shipDisplayName(kinfo) : null) ??
                  shipNameFromOfflineDb(killerShipId, dataLang) ??
                  shipNameFromModelDb(killerShipId) ??
                  "";
                killerShipType = kinfo?.type ?? koff?.type ?? null;
              }
              const feedId = ++killSeq;
              killFeed.value.unshift({
                id: feedId,
                text: who,
                shipName: label?.shipName ?? "",
                shipType: label?.type ?? null,
                killerShipName,
                killerShipType,
                killerName,
                role,
              });
              if (killFeed.value.length > 4) killFeed.value.pop();
              window.setTimeout(() => {
                killFeed.value = killFeed.value.filter((k) => k.id !== feedId);
              }, 4000);
            }
          }
          continue;
        }
        marker.visible = true;
        marker.position.set(s.x, 0, -s.z);
        marker.rotation.y = Math.PI - s.yaw;
        // Keep the minimap's heading in sync — userData.yaw must track the
        // playhead, not just the initial load.
        marker.userData.yaw = s.yaw;
        if (label) {
          label.ghostText = null;
          const currentHp = hpAtTime(traj.hpSamples, tEff);
          if (currentHp != null) label.hp = currentHp;
          label.maxHp ??= currentHp ?? label.maxHp;
        }
      }
      // Capture-zone ownership + estimated score at this instant.
      updateCapsAndScore(t);
      // Repaint the 3D cap rings by live state (owner color, capture pulse).
      capDisplay.value.forEach((c, i) => {
        const ring = capRings[i];
        if (!ring) return;
        const mat = ring.material as THREE.MeshBasicMaterial;
        if (c.owner === 1) mat.color.set(0x4ade80);
        else if (c.owner === 2) mat.color.set(0xcc3333);
        else mat.color.set(0xffffff);
        mat.opacity = c.capturing ? 0.7 : c.contested ? 0.5 : 0.35;
      });
      // Cap letters: Alt held → redraw with the shared point timer (capture
      // seconds while capturing; idle neutral points stay clean).
      const capAlt = showCapEta.value;
      capDisplay.value.forEach((c, i) => {
        const sprite = capLetterSprites[i];
        if (!sprite) return;
        const canvas = sprite.userData.canvas as HTMLCanvasElement | undefined;
        if (!canvas) return;
        const text = String(c.letter);
        let etaLine = "";
        if (capAlt) {
          const teamShips = c.captureTeam === 1 ? c.alliesIn : c.enemiesIn;
          const rem = captureSecondsRemaining(c.progress, teamShips, c.contested);
          if (c.capturing && rem.seconds != null) etaLine = formatEta(rem.seconds);
        }
        if (sprite.userData.text === `${text}|${etaLine}`) return;
        sprite.userData.text = `${text}|${etaLine}`;
        const ctx = canvas.getContext("2d")!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = "bold 48px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 32, 32);
        if (etaLine) {
          ctx.fillStyle = "rgba(251,191,36,0.95)";
          ctx.font = "bold 22px sans-serif";
          ctx.fillText(etaLine, 32, 56);
        }
        (sprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
      });
      // Smoke screens: white start/end rings + a floating remaining-seconds
      // tag. The start ring walks toward the end while the smoke dissipates
      // (WoWS smoke fades from the launch point); each cluster shows both
      // endpoints only when the drift is >= 1 km, otherwise a single puff.
      for (const cl of smokeClusters) {
        const hide = () => {
          cl.rings[0].visible = false;
          cl.rings[1].visible = false;
          if (cl.timeSprite) cl.timeSprite.visible = false;
        };
        if (t < cl.t0 || t > cl.endT) {
          hide();
          continue;
        }
        // Dissipation walk: after the last recorded update the start point
        // slides from the launch position toward the end position.
        let cur = t;
        if (t > cl.lastT) {
          const span = Math.max(1, cl.lastT - cl.t0);
          cur = cl.t0 + ((t - cl.lastT) * span) / Math.max(1, cl.endT - cl.lastT);
          if (cur > cl.lastT) cur = cl.lastT;
        }
        const pStart = sampleAt(cl.traj, cur);
        if (!pStart) {
          hide();
          continue;
        }
        const pEnd = sampleAt(cl.traj, cl.lastT);
        const drift =
          pEnd != null ? Math.hypot(pStart.x - pEnd.x, pStart.z - pEnd.z) : 0;
        const showBoth = pEnd != null && drift >= 1000;
        cl.rings[0].visible = true;
        cl.rings[0].position.set(pStart.x, 2.5, -pStart.z);
        cl.rings[1].visible = showBoth;
        if (showBoth && pEnd) cl.rings[1].position.set(pEnd.x, 2.5, -pEnd.z);
        const sprite = cl.timeSprite;
        if (sprite) {
          const secs = Math.ceil(cl.endT - t);
          const text = `${secs}s`;
          if (sprite.userData.text !== text) {
            sprite.userData.text = text;
            const cvs = sprite.userData.canvas as HTMLCanvasElement;
            const ctx = cvs.getContext("2d")!;
            ctx.clearRect(0, 0, cvs.width, cvs.height);
            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.font = "bold 40px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.shadowColor = "rgba(0,0,0,0.9)";
            ctx.shadowBlur = 8;
            ctx.fillText(text, 64, 32);
            (sprite.material as THREE.SpriteMaterial).map!.needsUpdate = true;
          }
          sprite.position.set(pStart.x, 34, -pStart.z);
          sprite.visible = true;
        }
      }
      // Aircraft formations: full squadrons (GameParams size, e.g. 8 planes)
      // arranged in a wedge and slowly circling. Modeled formations drive
      // their GLB pool; the rest fall back to Points.
      {
        const attr = planeCloud
          ? (planeCloud.geometry.getAttribute("position") as THREE.BufferAttribute)
          : null;
        const arr = attr ? (attr.array as Float32Array) : null;
        let anyPoints = false;
        // Sample helper: last sample at or before t.
        const sampleOf = (samples: SquadronPlane[]): SquadronPlane | null => {
          let s: SquadronPlane | null = null;
          for (const sp of samples) {
            if (sp.time > t) break;
            s = sp;
          }
          return s;
        };
        // Formation anchors: index-0 trail of each planeId (position + yaw),
        // alive between its first update and ~2 min after the last one.
        const formationAnchor = new Map<number, { s: SquadronPlane; born: number; expiry: number }>();
        for (const trail of planeTrails) {
          const planeId = Math.floor(trail.id / 16);
          if (trail.id % 16 !== 0) continue;
          const s = sampleOf(trail.samples);
          if (!s) continue;
          const born = trail.samples[0].time;
          const expiry = trail.samples[trail.samples.length - 1].time + 5;
          if (t >= born && t <= expiry) {
            formationAnchor.set(planeId, { s, born, expiry });
          }
        }
        for (const [planeId, anchor] of formationAnchor) {
          const pool = planeMeshes.get(planeId);
          const formation = planeFormations.get(planeId);
          const total = formation?.count ?? 3;
          const gCount = formation?.groupCount ?? total;
          const gSize = formation?.groupSize ?? 1;
          // Filled-wedge layout over flight groups (leader front, groups
          // stepping back 1-2-3-…, leftover groups centered in the last row).
          const offsets = formationOffsets(gCount, gSize);
          const n = Math.min(total, offsets.length);
          // Slow circle so airborne squadrons visibly hold a patrol orbit.
          const ang = t * 0.22 + (planeId % 7) * 0.9;
          const R = 50;
          // Heading follows the patrol-circle TANGENT (the direction the
          // formation is actually moving) so the wedge turns as it orbits
          // instead of sliding sideways pointing at a fixed heading.
          const yaw = Math.atan2(-Math.sin(ang), Math.cos(ang));
          const fwd = { x: Math.sin(yaw), z: -Math.cos(yaw) };
          const right = { x: Math.cos(yaw), z: Math.sin(yaw) };
          // Orbit CENTRE = the formation's geometric centroid (not the lead
          // plane) — a filled wedge visibly spins around its middle, like the
          // in-game flight circle. The centroid sits at the anchor plus the
          // (heading-rotated) mean offset of all aircraft.
          const cxm = offsets.reduce((a, o) => a + o.ox, 0) / Math.max(1, offsets.length);
          const czm = offsets.reduce((a, o) => a + o.oz, 0) / Math.max(1, offsets.length);
          const ccx = anchor.s.x + cxm * right.x + czm * fwd.x;
          const ccz = anchor.s.z + cxm * right.z + czm * fwd.z;
          const cx = ccx + Math.cos(ang) * R;
          const cz = ccz + Math.sin(ang) * R;
          const yBase = Math.max(60, anchor.s.y);
          if (pool && pool.length >= n) {
            for (let i = 0; i < n; i++) {
              const mesh = pool[i];
              mesh.visible = true;
              const o = offsets[i];
              const ox = (o.ox - cxm) * right.x + (o.oz - czm) * fwd.x;
              const oz = (o.ox - cxm) * right.z + (o.oz - czm) * fwd.z;
              const yOff = (i % 3) * 2 - 2; // -2 / 0 / +2 alternating
              mesh.position.set(cx + ox, yBase + yOff, -cz + oz);
              mesh.rotation.y = Math.PI - yaw;
            }
          } else {
            // No model pool (yet): fall back to a point at the centroid.
            if (arr) {
              arr[(planeId % 16) * 3] = cx;
              arr[(planeId % 16) * 3 + 1] = yBase;
              arr[(planeId % 16) * 3 + 2] = -cz;
              anyPoints = true;
            }
          }
        }
        // Hide pools of formations currently not anchored.
        for (const [planeId, pool] of planeMeshes) {
          if (formationAnchor.has(planeId)) continue;
          for (const m of pool) m.visible = false;
        }
        if (planeCloud && attr) {
          planeCloud.visible = anyPoints;
          attr.needsUpdate = true;
        }
      }
      // Shell traces: ballistic arc from the firing ship (updated live) to
      // the impact point, shown during [t0, t1]; the impact flash lingers
      // 1s past the impact. The in-flight shell cone is interpolated along
      // the arc every frame (smooth補间 during playback).
      // Elements outside the fitted battle bounds are stray data — hidden so
      // they can't flash out in empty space.
      const inBounds = (x: number, z: number) =>
        !bounds || (x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ);
      for (const st of shellTraces) {
        const inFlight = t >= st.t0 && t <= st.t1;
        const flashOn = t >= st.t1 && t <= st.t1 + 1;
        // Traces whose launch OR impact point lies outside the fitted battle
        // bounds are stray data — hide the whole trace so it can't flash out
        // in empty space (both endpoints must be in-bounds).
        const fromP = st.from();
        const impactIn = inBounds(st.to.x, st.to.z) && !!fromP && inBounds(fromP.x, fromP.z);
        st.flash.visible = flashOn && impactIn;
        st.halo.visible = flashOn && impactIn;
        st.line.visible = inFlight && impactIn;
        st.dots.visible = inFlight && impactIn;
        st.shell.visible = inFlight && impactIn;
        if (inFlight) {
          const from = st.from();
          if (from) {
            const attr = st.line.geometry.getAttribute("position") as THREE.BufferAttribute;
            const arr = attr.array as Float32Array;
            for (let i = 0; i < 28; i++) {
              const k = i / 27;
              const kx = k * 2 - 1;
              const px = from.x + (st.to.x - from.x) * k;
              const pz = from.z + (st.to.z - from.z) * k;
              const py = Math.max(0, st.h * (1 - kx * kx));
              arr[i * 3] = px;
              arr[i * 3 + 1] = py;
              arr[i * 3 + 2] = pz;
            }
            attr.needsUpdate = true;
            const dotAttr = st.dots.geometry.getAttribute("position") as THREE.BufferAttribute;
            dotAttr.needsUpdate = true;
            // Shell position + orientation: interpolate k across the flight,
            // tip pointing along the local tangent.
            const k = Math.min(1, Math.max(0, (t - st.t0) / (st.t1 - st.t0)));
            const kx = k * 2 - 1;
            const px = from.x + (st.to.x - from.x) * k;
            const py = Math.max(0, st.h * (1 - kx * kx));
            const pz = from.z + (st.to.z - from.z) * k;
            st.shell.position.set(px, py, pz);
            const k2 = Math.min(1, k + 0.03);
            const kx2 = k2 * 2 - 1;
            const tx = from.x + (st.to.x - from.x) * k2 - px;
            const ty = Math.max(0, st.h * (1 - kx2 * kx2)) - py;
            const tz = from.z + (st.to.z - from.z) * k2 - pz;
            const len = Math.hypot(tx, ty, tz) || 1;
            _shellDir.set(tx / len, ty / len, tz / len);
            st.shell.quaternion.setFromUnitVectors(_shellUp, _shellDir);
          } else {
            st.line.visible = false;
            st.dots.visible = false;
            st.shell.visible = false;
          }
        }
      }
      // Torpedoes: advance straight along the launch direction. The capsule
      // geometry runs along +Y, so orient it flat along the travel direction
      // (a plain rotation.y would leave it standing upright).
      for (const tm of torpedoMeshes) {
        const age = t - tm.t0;
        const on = age >= 0 && age <= tm.life;
        tm.mesh.visible = on;
        tm.wake.visible = on;
        if (on) {
          const p = tm.base.clone().add(tm.dir.clone().multiplyScalar(33 * age));
          tm.mesh.position.set(p.x, 1.2, p.z);
          tm.mesh.quaternion.setFromUnitVectors(_shellUp, tm.dir);
          const wakeAttr = tm.wake.geometry.getAttribute("position") as THREE.BufferAttribute;
          const tail = tm.dir.clone().multiplyScalar(160);
          wakeAttr.setXYZ(0, p.x - tail.x, 0.4, p.z - tail.z);
          wakeAttr.setXYZ(1, p.x, 0.4, p.z);
          wakeAttr.needsUpdate = true;
        }
      }
      // Explosion rings: spawn on impacts, expand + fade over ~1.2s. Impacts
      // outside the fitted battle bounds are skipped so stray data points
      // don't flash rings out in empty space.
      let nextFx = explosionFx.find((f) => !f.ring.visible);
      for (const e of props.explosions) {
        if (e.time > t || t - e.time > 1.2) continue;
        if (!inBounds(e.x, -e.z)) continue;
        if (!nextFx) break;
        nextFx.ring.visible = true;
        nextFx.ring.position.set(e.x, 1, -e.z);
        nextFx.born = e.time;
        nextFx = explosionFx.find((f) => !f.ring.visible);
      }
      for (const fx of explosionFx) {
        if (!fx.ring.visible) continue;
        const age = t - fx.born;
        if (age > 1.2) {
          fx.ring.visible = false;
          continue;
        }
        const k = age / 1.2;
        fx.ring.scale.setScalar(40 + k * 240);
        (fx.ring.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - k);
      }
      // Recorder aim line: from the own ship to the currently locked target.
      if (lockLine) {
        const cur = props.weaponLocks.filter((l) => l.time <= t);
        const last = cur.length > 0 ? cur[cur.length - 1] : null;
        const selfMarker = shipMarkers.find((m) => m.userData.role === "self");
        const targetMarker = last
          ? shipMarkers.find((m) => m.userData.entityId === last.targetId)
          : null;
        const on =
          last != null &&
          last.lockType === 3 &&
          selfMarker != null &&
          targetMarker != null;
        lockLine.visible = on;
        if (on && selfMarker && targetMarker) {
          const a = selfMarker.position;
          const b = targetMarker.position;
          const attr = lockLine.geometry.getAttribute("position") as THREE.BufferAttribute;
          attr.setXYZ(0, a.x, 30, a.z);
          attr.setXYZ(1, b.x, 30, b.z);
          attr.needsUpdate = true;
        }
      }
      // Aircraft labels (one per carrier): sync name/HP from the carrier and
      // show while any of its squadrons is in the air (visible window =
      // first update .. last update + 2 min).
      {
        const labels = shipLabels.value;
        for (const [labelId, carrierId] of planeLabelCarriers) {
          const label = labels.find((l) => l.entityId === labelId);
          if (!label) continue;
          const carrierIdx = carrierId == null ? -1 : shipMarkers.findIndex(
            (m) => m.userData.entityId === carrierId,
          );
          const carrierLabel = carrierIdx >= 0 ? labels[carrierIdx] : null;
          if (carrierLabel) {
            label.name = carrierLabel.name;
            label.shipName = carrierLabel.shipName;
            label.tier = carrierLabel.tier;
            label.hp = carrierLabel.hp;
            label.maxHp = carrierLabel.maxHp;
            // Aircraft have no "sunk" state — planes are simply gone when
            // shot down, so the card never shows the ship's dead tag.
            label.dead = false;
          }
          // Any of this carrier's squadrons airborne?
          let visible = false;
          for (const [planeId, labelOf] of planeLabelOfPlane) {
            if (labelOf !== labelId) continue;
            const trail = planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
            if (!trail || trail.samples.length === 0) continue;
            const first = trail.samples[0].time;
            const last = trail.samples[trail.samples.length - 1].time;
            // Squadron is gone 5s after its last sample — no lingering labels.
            if (t >= first && t <= last + 5) {
              visible = true;
              break;
            }
          }
          label.visible = visible;
        }
      }
      // Update screen-space positions of floating labels from marker world positions.
      updateLabelPositions();
    }

    // ── Scoring rules (official: wiki.worldofwarships.com/Ship:Game_Modes) ──
    // Domination Random/Co-op: 3 areas → start 300, +3 per completed capture,
    // +3 every 5s per controlled area; 4 areas → start 200, +4, +4 every 9s.
    // Capture duration 60s (1 ship) / 40s (2+ ships); contested by both teams
    // freezes progress; being hit halves the accrued progress.
    // Eight maps override everything: start 150, kills +40, deaths -25.
    const SPECIAL_CAP_MAPS = new Set([
      "13_OC_new_dawn",
      "17_NA_fault_line",
      "23_Shards",
      "41_Conquest",
      "42_Neighbors",
      "52_Britain",
      "53_Shoreside",
      "54_Faroe",
    ]);
    // Kill/death points by ship class (Random & Co-op).
    const KILL_PTS: Record<string, { kill: number; death: number }> = {
      Submarine: { kill: 25, death: -40 },
      Destroyer: { kill: 30, death: -45 },
      Cruiser: { kill: 35, death: -50 },
      Battleship: { kill: 40, death: -60 },
      AirCarrier: { kill: 45, death: -65 },
    };

    interface CapZoneState {
      letter: string;
      owner: number; // 0 neutral, 1 ally, 2 enemy
      /** 0..1 progress of the current capture towards the capturing team. */
      progress: number;
      /** Ships of each side inside the point right now. */
      alliesIn: number;
      enemiesIn: number;
      /** true when both teams are inside (progress frozen). */
      contested: boolean;
      /** true when a capture is actively progressing. */
      capturing: boolean;
      /** Capturing team's progress speed: 1/60 or 1/40 per second. */
      speed: number;
      /** Capturing team (1/2) when capturing. */
      captureTeam: number;
    }
    const capDisplay = ref<CapZoneState[]>([]);

    /** Shared scorebar state — the app's cap simulator + roster mapped onto
     *  the @wowsp/holo contract (same component the marketing site uses). */
    const scorebarState = computed<HoloHudState>(() => {
      const caps: HoloCapZone[] = capDisplay.value.map((c) => ({
        letter: c.letter,
        owner: c.owner === 1 ? "ally" : c.owner === 2 ? "enemy" : "neutral",
        progress: c.progress,
        capturing: c.capturing,
        contested: c.contested,
        captureSide: c.captureTeam === 1 ? "ally" : c.captureTeam === 2 ? "enemy" : undefined,
        hint: c.contested
          ? `${c.letter} 双方压点，进度暂停`
          : c.capturing
            ? `${c.letter} 占领中（${c.alliesIn} vs ${c.enemiesIn} 船）`
            : c.owner === 0
              ? `${c.letter} 中立`
              : c.owner === 1
                ? `${c.letter} 我方控制`
                : `${c.letter} 敌方控制`,
      }));
      const ships: HoloShip[] = [
        ...shipRows.value.allies.map((s) => ({
          x: 0, z: 0, yaw: 0, role: "ally" as const, dead: s.dead, shipType: s.type ?? undefined,
        })),
        ...shipRows.value.enemies.map((s) => ({
          x: 0, z: 0, yaw: 0, role: "enemy" as const, dead: s.dead, shipType: s.type ?? undefined,
        })),
      ];
      return {
        scoreAlly: allyScore.value,
        scoreEnemy: enemyScore.value,
        aliveAlly: 0, aliveEnemy: 0,
        time: current.value,
        duration: duration.value,
        caps,
        ships,
      };
    });

    /** Per-zone incremental capture simulator state. `progress` is simulated
     *  forward in ~0.5s steps while the playhead advances; scrubbing backward
     *  resets and replays from the last ownership change. Hits inside the
     *  zone (ship HP dropping) halve the accrued progress, matching the game. */
    const capSim = new Map<
      number,
      {
        lastT: number;
        progress: number;
        owner: number;
        prevHp: Map<number, number>;
        /** Seconds the point has been controlled without contest (accrual). */
        accrualT: number;
        /** Score accumulated from this point (completion + accrual). */
        scoreAlly: number;
        scoreEnemy: number;
      }
    >();

    /** Ships inside a capture point at time t (within the zone radius) with
     *  their HP snapshots for hit-rollback detection. */
    function shipsInZone(zone: EntityTrajectory, t: number): { ally: number; enemy: number } {
      const cx = zone.kind!.initialX;
      const cz = zone.kind!.initialZ;
      const R = zone.kind!.radius ?? 60; // recovered from the EntityCreate state
      let ally = 0;
      let enemy = 0;
      for (const m of shipMarkers) {
        const traj = props.trajectories.find((tr) => tr.entityId === m.userData.entityId);
        if (!traj || traj.samples.length === 0) continue;
        const s = sampleAt(traj, t);
        if (!s) continue;
        const d = (s.x - cx) ** 2 + (s.z - cz) ** 2;
        if (d > R * R) continue;
        const role = m.userData.role as TeamRole;
        if (role === "ally" || role === "self") ally++;
        else if (role === "enemy") enemy++;
      }
      return { ally, enemy };
    }

    /** Advance a zone's capture simulation from lastSimT to t in 0.5s steps.
     *  Ownership always follows the recorded prop0 stream; the simulation
     *  drives the visible progress ring (speed by ships inside, frozen when
     *  contested, halved when an inside ship takes a hit) AND the point's
     *  score: +capComplete on every ownership change (except a pre-placed
     *  starting zone), plus accrual points only while the point is controlled
     *  with no enemy ship inside (the game pauses accrual while contested). */
    function simulateZone(
      zone: EntityTrajectory,
      eid: number,
      t: number,
      samples: { time: number; value: number }[],
      capCompletePts: number,
      accrualEvery: number,
      accrualPts: number,
    ) {
      const st = capSim.get(eid);
      if (!st) return;
      // The game's own progress stream (0x23) beats position simulation.
      const realProgress =
        zone.capProgress != null && zone.capProgress.length >= 2;
      let simT = st.lastT;
      // Ownership changes are applied step-by-step as the sim crosses their
      // timestamps (applying them up front would give the owner early
      // accrual for the whole [0, changeTime) stretch).
      let si = 0;
      while (si < samples.length && samples[si].time <= simT) si++;
      const step = 0.5;
      while (simT < t) {
        const nxt = Math.min(simT + step, t);
        const mid = (simT + nxt) / 2;
        while (si < samples.length && samples[si].time < nxt) {
          const s = samples[si];
          if (s.time > simT) {
            const changed = s.value !== st.owner;
            st.owner = s.value;
            st.progress = 0;
            st.prevHp = new Map();
            st.accrualT = 0;
            // A completed capture (any non-neutral change) scores
            // +capComplete; a starting zone placed at battle start (first
            // sample, t < 5) is not a capture event.
            if (changed && s.value !== 0 && s.time > 5) {
              if (s.value === 1) st.scoreAlly += capCompletePts;
              else st.scoreEnemy += capCompletePts;
            }
          }
          si++;
        }
        const cx = zone.kind!.initialX;
        const cz = zone.kind!.initialZ;
        const R = zone.kind!.radius ?? 60;
        let ally = 0;
        let enemy = 0;
        for (const m of shipMarkers) {
          const traj = props.trajectories.find((tr) => tr.entityId === m.userData.entityId);
          if (!traj || traj.samples.length === 0) continue;
          const s = sampleAt(traj, mid);
          if (!s) continue;
          if ((s.x - cx) ** 2 + (s.z - cz) ** 2 > R * R) continue;
          const role = m.userData.role as TeamRole;
          if (role === "ally" || role === "self") ally++;
          else if (role === "enemy") enemy++;
          // Hit rollback: HP dropped inside the zone → progress halves.
          if (traj.hpSamples && traj.hpSamples.length > 0) {
            const hp = hpAtTime(traj.hpSamples, mid);
            const prev = st.prevHp.get(traj.entityId) ?? hp;
            if (prev != null && hp != null && hp < prev - 50) {
              st.progress *= 0.5;
            }
            const hpVal = hp ?? prev;
            if (hpVal != null) st.prevHp.set(traj.entityId, hpVal);
          }
        }
        if (st.owner === 0) {
          // Neutral: a single team present starts capturing it.
          if ((ally > 0) !== (enemy > 0)) {
            st.progress += step / (Math.max(ally, enemy) >= 2 ? 40 : 60);
            if (st.progress > 1) st.progress = 1;
          }
        } else if (enemy > 0 && ally === 0) {
          // Enemy-only inside an allied point: re-capturing (ring visual;
          // the actual flip comes from the prop0 stream).
          st.progress += step / (enemy >= 2 ? 40 : 60);
          if (st.progress > 1) st.progress = 1;
        } else if (ally > 0 && enemy === 0) {
          // Allied-only inside an enemy point: we are re-capturing it the
          // same way (progress accrues, no owner accrual while inside).
          st.progress += step / (ally >= 2 ? 40 : 60);
          if (st.progress > 1) st.progress = 1;
        } else {
          // No enemy inside: the owner scores accrual points; allied ships
          // inside (or nobody) keep it ticking.
          if (accrualEvery > 0) {
            st.accrualT += step;
            while (st.accrualT >= accrualEvery) {
              st.accrualT -= accrualEvery;
              if (st.owner === 1) st.scoreAlly += accrualPts;
              else st.scoreEnemy += accrualPts;
            }
          }
        }
        // Override the simulated progress with the game's own stream when the
        // replay carries it (NestedPropertyUpdate 0x23): far more accurate
        // than inferring from ship positions.
        if (realProgress) {
          const cp = progressAtTime(zone.capProgress, nxt);
          if (cp != null) {
            st.progress = Math.min(1, cp / 1000);
            st.prevHp.clear();
          }
        }
        simT = nxt;
      }
      st.lastT = t;
    }

    /** Recompute cap zone states + score at playback time t. Fully derived
     *  from the replay stream (capSamples ownership changes, ship positions,
     *  HP streams) so scrubbing reproduces the same result. */
    /** Point the opening camera at the allied fleet (not map centre) and pull
     *  back far enough that every friendly ship is in view. Runs once after
     *  the scene is built. */
    function fitCameraToAllies() {
      const ctrl = api.value?.controls;
      const cam = api.value?.camera;
      if (!ctrl || !cam || shipMarkers.length === 0) return;
      const set = shipMarkers.filter((m) => {
        const r = m.userData.role as TeamRole;
        return r === "self" || r === "ally";
      });
      const use = set.length > 0 ? set : shipMarkers;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const m of use) {
        const p = m.position;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const span = Math.max(maxX - minX, maxZ - minZ, 500);
      const dist = Math.min(4500, Math.max(900, span * 1.3));
      ctrl.target.set(cx, 0, cz);
      cam.position.set(cx, dist * 0.55, cz + dist);
      ctrl.update();
    }

    function openSceneDefaults() {
      // Eager post-battle parse: opening cap colours need the recorder's team.
      if (props.battleResults) pbCache ??= parsePostBattle(props.battleResults);
      // Frame the ACTIVE battle area (mode-restricted maps like brawls/duels
      // play inside a small region of the full map) — the allies are inside
      // it, so this also satisfies the "open on our fleet" requirement.
      // Playback starts at the replay's raw time (no auto-skip).
      if (bounds) {
        fitCamera(bounds);
      } else {
        fitCameraToAllies();
      }
    }

    function updateCapsAndScore(t: number) {
      const zones = capZones.value;
      const scoring = scoringZones.value;
      // Scoring parameters by mode + map (based on REAL capture points).
      const isRanked = props.matchGroup === "ranked" || props.matchGroup === "clan";
      const special = SPECIAL_CAP_MAPS.has(props.mapName);
      const nAreas = scoring.length;
      const startPts = special ? 150 : isRanked ? 300 : nAreas >= 4 ? 200 : 300;
      const capCompletePts = special ? 40 : isRanked ? (nAreas >= 4 ? 2 : 9) : nAreas >= 4 ? 4 : 3;
      // Accrual: (every N seconds, +P per controlled area).
      let accrualEvery = 0;
      let accrualPts = 0;
      if (!special) {
        if (isRanked) {
          accrualEvery = nAreas >= 4 ? 0 : nAreas === 2 ? 10 : 3;
          accrualPts = nAreas >= 4 ? 0 : nAreas === 2 ? 9 : 2;
        } else {
          accrualEvery = nAreas >= 4 ? 9 : 5;
          accrualPts = nAreas >= 4 ? 4 : 3;
        }
      }

      let allyScoreNow = startPts;
      let enemyScoreNow = startPts;

      // Kill / death points by ship class (classic tables; special maps
      // override with flat +40/-25).
      for (const m of shipMarkers) {
        const dt = m.userData.deathTime as number | null;
        if (dt == null || t < dt) continue;
        const role = m.userData.role as TeamRole;
        const killer = role === "ally" || role === "self" ? "enemy" : "ally";
        const type = (m.userData.type as string | undefined) ?? "";
        let kill = 0;
        let death = 0;
        if (special) {
          kill = 40;
          death = -25;
        } else {
          const cls =
            type.includes("Destroyer") ? "Destroyer"
            : type.includes("Battleship") ? "Battleship"
            : type.includes("AirCarrier") || type.includes("AirCar") ? "AirCarrier"
            : type.includes("Submarine") ? "Submarine"
            : "Cruiser";
          kill = KILL_PTS[cls].kill;
          death = KILL_PTS[cls].death;
        }
        if (killer === "ally") allyScoreNow += kill;
        else enemyScoreNow += kill;
        if (role === "ally" || role === "self") allyScoreNow += death;
        else enemyScoreNow += death;
      }

      // Cap completion + accrual come from the per-zone simulation (which
      // pauses accrual while a point is contested), plus per-zone live capture
      // state for the UI.
      const display: CapZoneState[] = [];
      const scoringSet = new Set(scoring.map((z) => z.entityId));
      for (let i = 0; i < zones.length; i++) {
        const zone = zones[i];
        const eid = zone.entityId;
        const samples = (zone.capSamples ?? []).map((s) => ({ time: s.time, value: s.value }));
        if (!scoringSet.has(eid)) {
          // Strike/event zone: rendered, never scored, no capture sim.
          const { ally, enemy } = shipsInZone(zone, t);
          display.push({
            letter: String.fromCharCode(65 + i),
            owner: 0,
            progress: 0,
            alliesIn: ally,
            enemiesIn: enemy,
            contested: false,
            capturing: false,
            speed: 1 / 60,
            captureTeam: 0,
          });
          continue;
        }
        // Capture simulation: replay from scratch on scrub-back, else advance.
        let st = capSim.get(eid);
        if (!st || st.lastT > t) {
          st = {
            lastT: 0,
            progress: 0,
            owner: ownerAt(samples, 0, zone.kind?.initialTeam ?? null),
            prevHp: new Map(),
            accrualT: 0,
            scoreAlly: 0,
            scoreEnemy: 0,
          };
          capSim.set(eid, st);
        }
        simulateZone(zone, eid, t, samples, capCompletePts, accrualEvery, accrualPts);
        allyScoreNow += st.scoreAlly;
        enemyScoreNow += st.scoreEnemy;
        const { ally, enemy } = shipsInZone(zone, t);
        // Capturing requires someone INSIDE the point — a neutral point with
        // leftover progress (capture started, then everyone left) must not
        // keep its diamond + ring spinning forever.
        const capturing =
          st.progress > 0.001 && st.progress < 1 && ally + enemy > 0;
        display.push({
          letter: String.fromCharCode(65 + i),
          owner: st.owner,
          progress: st.progress,
          alliesIn: ally,
          enemiesIn: enemy,
          contested: ally > 0 && enemy > 0,
          capturing,
          speed: 1 / (Math.max(ally, enemy) >= 2 ? 40 : 60),
          captureTeam:
            st.owner === 0
              ? ally > enemy
                ? 1
                : enemy > ally
                  ? 2
                  : 0
              : st.owner === 1
                ? enemy > 0 && ally === 0
                  ? 2
                  : 0
                : ally > 0 && enemy === 0
                  ? 1
                  : 0,
        });
      }
      capDisplay.value = display;
      // Standard battles end at 1000 points — clamp both scores so the
      // reconstructed total can never exceed the real win condition.
      allyScore.value = Math.min(allyScoreNow, 1000);
      enemyScore.value = Math.min(enemyScoreNow, 1000);
    }

    /** Owner at time t from the raw capSamples stream; before the first
     *  ownership sample (or with no stream at all) fall back to the zone's
     *  initial team from the create state — zones captured from match start
     *  never emit ownership updates. teamId is a 0/1 SIDE number, so it maps
     *  to the owner code (1 = recorder's side) via the recorder's own team
     *  from the post-battle payload. */
    function ownerAt(
      samples: { time: number; value: number }[],
      t: number,
      initialTeam: number | null,
    ): number {
      let o = 0;
      let seen = false;
      for (const s of samples) {
        if (s.time <= t) {
          o = s.value;
          seen = true;
        } else break;
      }
      if (
        seen && o === 0 && samples.length === 1 &&
        initialTeam != null && initialTeam >= 0
      ) {
        seen = false; // cleanup flush only — keep the starting owner
      }
      if (!seen && initialTeam != null && initialTeam >= 0) {
        const st = selfTeam.value;
        o = st != null ? (initialTeam === st ? 1 : 2) : 0;
      }
      return o;
    }

    /** First-person camera: keep the selected ship centered, camera trailing
     *  behind it along its heading. Called every render frame.
     *
     *  The marker's model points along local +Z and carries rotation.y =
     *  PI - yaw, so its world forward is (sin(yaw), 0, -cos(yaw)) in
     *  three.js space (north = -Z). The camera sits behind that: minus the
     *  forward vector. */
    function followSelected() {
      const id = selectedEntityId.value;
      if (id == null) return;
      const ctrl = api.value?.controls;
      const cam = api.value?.camera;
      if (!ctrl || !cam) return;
      const marker = shipMarkers.find((m) => m.userData.entityId === id);
      if (!marker || !marker.visible) return;
      const pos = marker.position;
      const yaw = marker.rotation.y;
      const dist = 90;
      const behind = new THREE.Vector3(
        pos.x - Math.sin(yaw) * dist,
        35,
        pos.z + Math.cos(yaw) * dist,
      );
      cam.position.copy(behind);
      ctrl.target.copy(pos);
      ctrl.update();
    }

    /** Replay the recorder's original camera when the original-view toggle is
     *  on: pick the camera frame at the playhead, apply pose + fov, and
     *  disable OrbitControls so the user can't fight the replay. */
    function applyOriginalCamera(t: number) {
      const cam = api.value?.camera;
      const ctrl = api.value?.controls;
      if (!cam || !ctrl) return;
      const frames = props.cameraFrames;
      if (frames.length === 0) {
        originalView.value = false;
        ctrl.enabled = true;
        return;
      }
      ctrl.enabled = false;
      let frame = frames[frames.length - 1];
      for (const f of frames) {
        if (f.time > t) break;
        frame = f;
      }
      // Scene z is mirrored (z' = -z), so the camera z mirrors too.
      cam.position.set(frame.x, frame.y, -frame.z);
      cam.quaternion.set(frame.rotX, frame.rotY, frame.rotZ, frame.rotW);
      cam.fov = (frame.fov * 180) / Math.PI;
      cam.updateProjectionMatrix();
    }

    /** Select a ship by clicking either its 3D marker or its label. Clicking
     *  the empty scene clears the selection. Labels have pointer-events: none
     *  (so they can't break OrbitControls drag), so clicks reach the canvas
     *  and pick the nearest visible marker via raycast. */
    function selectShip(entityId: number | null) {
      selectedEntityId.value = entityId;
      // Clicking a ship switches to chase mode; clicking empty space returns
      // to the free orbit camera.
      cameraMode.value = entityId != null ? "follow" : "free";
    }

    /** Canvas click → raycast the nearest visible ship marker (within a
     *  generous screen distance) or clear the selection. */
    function onCanvasClick(e: MouseEvent) {
      speedMenuOpen.value = false;
      cameraMenuOpen.value = false;
      const cam = api.value?.camera;
      const rnd = api.value?.renderer;
      const canvas = rnd?.domElement;
      if (!cam || !canvas || shipMarkers.length === 0) {
        selectShip(null);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      // Pick the marker whose world position projects nearest to the click —
      // raycasting the small marker meshes is fragile; a screen-space
      // distance test against their projected anchors is stable.
      let bestId: number | null = null;
      let bestD = Infinity;
      for (const m of shipMarkers) {
        if (!m.visible) continue;
        _projVec.copy(m.position);
        _projVec.project(cam);
        if (_projVec.z >= 1) continue;
        const sx = (_projVec.x * rect.width) / 2 + rect.width / 2;
        const sy = (-_projVec.y * rect.height) / 2 + rect.height / 2;
        const d = Math.hypot(sx - e.clientX + rect.left, sy - e.clientY + rect.top);
        if (d < bestD && d < 60) {
          bestD = d;
          bestId = m.userData.entityId as number;
        }
      }
      selectShip(bestId);
    }

    /** Project every visible marker's world position into screen pixels and
     *  write them into `shipLabels` so the overlay <div>s track the ships. */
    function updateLabelPositions() {
      const cam = api.value?.camera;
      const rnd = api.value?.renderer;
      const el = container.value;
      const canvas = rnd?.domElement;
      if (!cam || !rnd || !el || !canvas) return;
      const labels = shipLabels.value;
      const hw = canvas.clientWidth / 2;
      const hh = canvas.clientHeight / 2;
      for (let i = 0; i < shipMarkers.length; i++) {
        const label = labels[i];
        if (!label) continue;
        const marker = shipMarkers[i];
        const dead =
          marker.userData.deathTime != null &&
          current.value >= (marker.userData.deathTime as number);
        if (!marker.visible && !dead) {
          label.visible = false;
          continue;
        }
        // Sunk markers are hidden, but their position keeps tracking the live
        // sample — project it anyway so the "sunk" label follows the actual
        // coordinates (and the camera) instead of freezing at the death spot.
        // Project the marker's world position (offset 20 units upward so the
        // label sits above the ship silhouette, not buried inside it).
        _projVec.copy(marker.position);
        _projVec.y += 20;
        _projVec.project(cam);
        // NDC → pixel within the canvas rect.
        label.x = (_projVec.x * hw) + hw;
        label.y = (-_projVec.y * hh) + hh;
        label.visible = _projVec.z < 1;
      }
      // Aircraft labels project above the carrier's currently airborne
      // squadrons (the newest sample of the newest sortie).
      for (const [labelId] of planeLabelCarriers) {
        const label = labels.find((l) => l.entityId === labelId);
        if (!label || !label.visible) continue;
        let anchor: SquadronPlane | null = null;
        for (const [planeId, labelOf] of planeLabelOfPlane) {
          if (labelOf !== labelId) continue;
          const trail = planeTrails.find((tr) => Math.floor(tr.id / 16) === planeId);
          if (!trail || trail.samples.length === 0) continue;
          const sp = trail.samples[trail.samples.length - 1];
          if (!anchor || sp.time > anchor.time) anchor = sp;
        }
        if (!anchor) { label.visible = false; continue; }
        _projVec.set(anchor.x, Math.max(60, anchor.y) + 30, -anchor.z);
        _projVec.project(cam);
        label.x = (_projVec.x * hw) + hw;
        label.y = (-_projVec.y * hh) + hh;
        if (_projVec.z >= 1) label.visible = false;
      }
    }

    /** Interpolate a sample at time t (linear between neighbors). */
    function sampleAt(
      traj: { samples: { time: number; x: number; z: number; yaw: number }[] },
      t: number,
    ) {
      const ss = traj.samples;
      if (t <= ss[0].time) return ss[0];
      if (t >= ss[ss.length - 1].time) return ss[ss.length - 1];
      // Binary search: called per frame from the capture simulation and the
      // aircraft cloud, so keep it O(log n).
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
      return {
        ...a,
        x: a.x + (b.x - a.x) * f,
        z: a.z + (b.z - a.z) * f,
        yaw: a.yaw + angleDiff(a.yaw, b.yaw) * f,
      };
    }

    function angleDiff(a: number, b: number): number {
      let d = b - a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    }

    // Playback loop.
    function playTick(now: number) {
      if (!playing.value) return;
      if (lastTick === 0) lastTick = now;
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      current.value += dt * playbackSpeed.value; // playback multiplier (0.5–10×)
      if (current.value >= duration.value) {
        current.value = duration.value;
        playing.value = false;
      }
      playRaf = requestAnimationFrame(playTick);
    }
    function togglePlay() {
      playing.value = !playing.value;
      if (playing.value) {
        lastTick = 0;
        if (current.value >= duration.value) current.value = 0;
        playRaf = requestAnimationFrame(playTick);
      }
    }

    // Reset playback when switching replays.
    watch(
      () => props.replayPath,
      () => {
        if (ready.value) {
          current.value = 0;
          playing.value = false;
          duration.value = 0;
          // The enlarged 2D view belongs to ONE replay — close it on switch
          // (clearActors no longer resets it so a deep-link ?mm=1 open and
          // mid-session rebuilds keep the overlay alive).
          minimapZoom.value = false;
          clearActors();
          shipLabels.value = [];
          bounds = null;
        }
      },
    );

    // Recompute + rebuild whenever trajectories change.
    watch(
      () => props.trajectories,
      (trajs) => {
        if (trajs.length === 0) {
          current.value = 0;
          playing.value = false;
          return;
        }
        recomputeBoundsAndCamera();
        rebuildActors();
        // One-shot deep-link seek: ?t=<seconds> jumps playback on load.
        if (props.initialTime > 0 && current.value === 0) {
          current.value = Math.min(props.initialTime, duration.value);
        }
        updateMarkersAt(current.value);
      },
      { deep: false },
    );

    // Rebuild when the roster arrives/changes (team roles + shipId resolution)
    // or when the encyclopedia finishes loading (enables tier-based fallback
    // models). Both are needed because they resolve independently of the
    // trajectory stream.
    watch(
      () => props.vehicles,
      () => {
        if (ready.value) {
          rebuildActors();
          updateMarkersAt(current.value);
        }
      },
      { deep: false },
    );
    watch(
      () => props.encyclopedia.size,
      (s) => {
        if (ready.value && s > 0) {
          rebuildActors();
          updateMarkersAt(current.value);
        }
      },
      { immediate: true },
    );

    // Recompute markers whenever the scrubber moves.
    watch(current, (t) => updateMarkersAt(t));

    // Once the scene is ready, build actors for any trajectories already set
    // and attempt to load the terrain model.
    watch(ready, (r) => {
      if (r) {
        ensureWaterFloor();
        loadMinimapBase();
        recomputeBoundsAndCamera();
        rebuildActors();
        updateMarkersAt(current.value);
        void tryLoadMapModel();
      }
    });

    // Reload terrain when the map changes (e.g. switching replays).
    watch(() => props.mapId, () => {
      if (ready.value) {
        loadMinimapBase();
        void tryLoadMapModel();
      }
    });

    onBeforeUnmount(() => {
      cancelAnimationFrame(playRaf);
      clearActors();
      clearMapModel();
      if (waterFloor) {
        api.value?.scene.remove(waterFloor);
        waterFloor.geometry.dispose();
        (waterFloor.material as THREE.Material).dispose();
        waterFloor = null;
      }
      if (seaSurface) {
        api.value?.scene.remove(seaSurface);
        seaSurface.geometry.dispose();
        (seaSurface.material as THREE.Material).dispose();
        seaSurface = null;
      }
      clearShipMarkerCache();
      clearPropMarkerCache();
    });

    return () => (
      <div class="holo-map">
        <div
          ref={container}
          class="holo-map__canvas"
          onPointerdown={(e: PointerEvent) => { _downPt = { x: e.clientX, y: e.clientY }; }}
          onClick={(e) => {
            if (_downPt && Math.hypot(e.clientX - _downPt.x, e.clientY - _downPt.y) > 6) {
              // This was a drag, not a click — clear any selection so the
              // camera isn't held by followSelected, then return.
              selectShip(null);
              return;
            }
            onCanvasClick(e);
          }}
        />
        {/* ── Floating ship labels (projected 3D→2D onto the canvas) ── */}
        <div class={["holo-map__labels", showLabels.value ? "" : "holo-map__labels--hidden"]} aria-hidden="true">
          {shipLabels.value.map((lbl) => (
            <HoloLabel
              key={lbl.entityId}
              deadText={i18nT("replay.legend.dead")}
              label={{
                key: lbl.entityId,
                x: lbl.x,
                y: lbl.y,
                role: lbl.role,
                name: lbl.name,
                shipName: lbl.shipName,
                tier: lbl.tier,
                iconUrl:
                  lbl.kind === "plane"
                    ? (planeIcon(lbl.planeType ?? "attack")?.src ?? null)
                    : lbl.type
                      ? (shipIconUrl(lbl.type, lbl.role === "enemy" ? "enemy" : "ally") ?? null)
                      : null,
                hp: lbl.hp,
                maxHp: lbl.maxHp,
                dead: lbl.dead,
                ghostText: lbl.ghostText,
                visible: lbl.visible,
                selected: selectedEntityId.value === lbl.entityId,
              }}
            />
          ))}
        </div>
        {!ready.value ? <div class="holo-map__hint">Initializing holographic scene…</div> : null}
        {props.replayPath ? (
          <>
          <div class="holo-map__scorebar-wrap"><HoloScorebar state={scorebarState.value} /></div>
          </>
        ) : null}
        {/* Kill feed (sink notifications) — bottom-left. Each entry shows
            both ships: killer ship + nickname on the left (left-aligned),
            "击沉了" centred, victim ship + nickname on the right
            (right-aligned). The card's accent is the killer's side. */}
        {killFeed.value.length > 0 ? (
          <div class="holo-map__killfeed">
            {killFeed.value.map((k) => (
              <div key={k.id} class={["holo-map__kill", `holo-map__kill--${k.role}`]}>
                <div class="holo-map__kill-side holo-map__kill-side--killer">
                  <span class="holo-map__kill-ship">
                    <span class="holo-map__kill-ico">
                      {k.killerShipType ? (
                        <BattleIcon
                          kind="ship"
                          type={k.killerShipType}
                          variant={k.role === "enemy" ? "enemy" : "ally"}
                          size={13}
                        />
                      ) : null}
                    </span>
                    {k.killerShipName || k.killerName || "?"}
                  </span>
                  <span class="holo-map__kill-name">
                    {k.killerName ?? ""}
                  </span>
                </div>
                <span class="holo-map__kill-verb">击沉了</span>
                <div class="holo-map__kill-side holo-map__kill-side--victim">
                  <span class="holo-map__kill-ship">
                    <span class="holo-map__kill-ico">
                      {k.shipType ? (
                        <BattleIcon
                          kind="ship"
                          type={k.shipType}
                          variant={k.role === "ally" ? "enemy" : "ally"}
                          size={13}
                        />
                      ) : null}
                    </span>
                    {k.shipName}
                  </span>
                  <span class="holo-map__kill-name">
                    {k.text}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <canvas
          ref={minimapCanvas}
          class="holo-map__minimap"
          width={160}
          height={160}
          onClick={() => { minimapZoom.value = true; }}
          style={{
            width: "160px",
            height: "160px",
            position: "absolute",
            right: "8px",
            bottom: "8px",
            zIndex: "3",
            borderRadius: "4px",
            pointerEvents: "auto",
            cursor: "zoom-in",
          }}
        />
        {/* Enlarged minimap overlay: trails + class glyphs, closeable */}
        {minimapZoom.value ? (
          <div class="holo-map__mmzoom" onClick={() => { minimapZoom.value = false; }}>
            <div class="holo-map__mmzoom-head">
              <span>{i18nT("replay.minimap.zoom")}</span>
              <SCheckbox
                modelValue={minimapShowTrails.value}
                variant="switch"
                onClick={(e: MouseEvent) => e.stopPropagation()}
                onUpdate:modelValue={(v: boolean) => { minimapShowTrails.value = v; }}
              >
                {i18nT("replay.minimap.trails")}
              </SCheckbox>
            </div>
            <canvas ref={zoomCanvas} width={760} height={760} class="holo-map__mmzoom-canvas" />
          </div>
        ) : null}
        {props.replayPath ? (
          <div class="holo-map__controls">
          {/* In the 2D enlarged view the plaque + stats duplicate what the 3D
              view shows — hide them so the 2D map owns the screen. */}
          {!minimapZoom.value && selfCard.value ? (
            <div class="holo-map__shipcard">
              <HoloShipCard data={selfCard.value} />
              {/* Self battle stats ride to the right of the hull plaque:
                  icon + short label + number per stat, bottom-aligned with
                  the plaque, content centred inside. */}
              {selfStats.value ? (
                <div class="holo-map__selfstats">
                  <span class="holo-map__selfstat">
                    <Crosshair size={14} class="holo-map__selfstat-ico" />
                    <i class="holo-map__selfstat-label">{i18nT("replay.selfHits")}</i>
                    <b class="holo-map__selfstat-num">{selfStats.value.hits}</b>
                  </span>
                  <span class="holo-map__selfstat">
                    <Skull size={14} class="holo-map__selfstat-ico" />
                    <i class="holo-map__selfstat-label">{i18nT("replay.selfFrags")}</i>
                    <b class="holo-map__selfstat-num">{selfStats.value.frags}</b>
                  </span>
                  <span class="holo-map__selfstat">
                    <Swords size={14} class="holo-map__selfstat-ico" />
                    <i class="holo-map__selfstat-label">{i18nT("replay.selfDamage")}</i>
                    <b class="holo-map__selfstat-num">{selfStats.value.damage.toLocaleString()}</b>
                  </span>
                  <span class="holo-map__selfstat">
                    <Shield size={14} class="holo-map__selfstat-ico" />
                    <i class="holo-map__selfstat-label">{i18nT("replay.selfTaken")}</i>
                    <b class="holo-map__selfstat-num">{selfStats.value.taken.toLocaleString()}</b>
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          <button
              class="holo-map__lbltoggle"
              onClick={() => { showLabels.value = !showLabels.value; }}
              title={showLabels.value ? i18nT("replay.labels.hide") : i18nT("replay.labels.show")}
            >
              {showLabels.value ? "◉" : "◎"}
            </button>
            {props.cameraFrames.length > 0 || cameraMode.value !== "free" ? (
              <div class="holo-map__camera">
                <button
                  class={["holo-map__lbltoggle", cameraMenuOpen.value ? "holo-map__lbltoggle--on" : ""]}
                  onClick={(e) => {
                    e.stopPropagation();
                    cameraMenuOpen.value = !cameraMenuOpen.value;
                  }}
                  title={i18nT("replay.camera.title")}
                >
                  {cameraMode.value === "original" ? "🎥" : cameraMode.value === "follow" ? "◎" : "⛶"}
                </button>
                {cameraMenuOpen.value ? (
                  <div class="holo-map__cam-menu" onClick={(e) => e.stopPropagation()}>
                    <div class="holo-map__cam-modes">
                      <button
                        class={["holo-map__cam-mode", cameraMode.value === "free" ? "holo-map__cam-mode--on" : ""]}
                        onClick={() => { cameraMode.value = "free"; cameraMenuOpen.value = false; }}
                      >
                        {i18nT("replay.camera.free")}
                      </button>
                      {props.cameraFrames.length > 0 ? (
                        <button
                          class={["holo-map__cam-mode", cameraMode.value === "original" ? "holo-map__cam-mode--on" : ""]}
                          onClick={() => { cameraMode.value = "original"; cameraMenuOpen.value = false; }}
                        >
                          {i18nT("replay.camera.original")}
                        </button>
                      ) : null}
                    </div>
                    {cameraShipGroups.value.map((g) => (
                      <div key={g.key} class="holo-map__cam-group">
                        <div class="holo-map__cam-group-title">{g.title}</div>
                        {g.items.map((item) => (
                          <button
                            key={item.entityId}
                            class={[
                              "holo-map__cam-item",
                              item.entityId === selectedEntityId.value ? "holo-map__cam-item--on" : "",
                              item.dead ? "holo-map__cam-item--dead" : "",
                            ]}
                            onClick={() => {
                              selectShip(item.entityId);
                              cameraMenuOpen.value = false;
                            }}
                          >
                            <span class="holo-map__cam-ico">
                              {item.type ? (
                                <BattleIcon
                                  kind="ship"
                                  type={item.type}
                                  variant={item.role === "enemy" ? "enemy" : "ally"}
                                  size={13}
                                />
                              ) : null}
                            </span>
                            <span class="holo-map__cam-body">
                              <span class="holo-map__cam-ship">{item.shipName}</span>
                              <span class="holo-map__cam-meta">
                                {item.tier ? tierToRoman(item.tier) : ""}
                                {item.type ? ` ${i18nT(`replay.classes.${shipTypeClass(item.type)}`)}` : ""}
                                {item.maxHp != null ? ` · ${item.maxHp.toLocaleString()} HP` : ""}
                              </span>
                            </span>
                            <span class="holo-map__cam-name">{item.name}</span>
                            <span class="holo-map__cam-stats">
                              {followStats.value.get(item.entityId) ?? "…"}
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <button class="holo-map__play" onClick={togglePlay}>
              {playing.value ? "❚❚" : "▶"}
            </button>
            <input
              class="holo-map__scrub"
              type="range"
              min={0}
              max={duration.value || 0}
              step={0.1}
              value={current.value}
              onInput={(e) => {
                playing.value = false;
                current.value = Number((e.target as HTMLInputElement).value);
              }}
            />
            <span class="holo-map__time">{displayTime()}</span>            <div class="holo-map__speed">
              <button
                class="holo-map__speed-btn"
                onClick={(e) => { e.stopPropagation(); speedMenuOpen.value = !speedMenuOpen.value; }}
                title="播放速度"
              >
                {playbackSpeed.value}×
              </button>
              {speedMenuOpen.value ? (
                <div class="holo-map__speed-menu" onClick={(e) => e.stopPropagation()}>
                  {PLAYBACK_SPEEDS.map((sp) => (
                    <button
                      key={sp}
                      class={["holo-map__speed-opt", sp === playbackSpeed.value ? "holo-map__speed-opt--on" : ""]}
                      onClick={() => {
                        playbackSpeed.value = sp;
                        speedMenuOpen.value = false;
                      }}
                    >
                      {sp}×
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {showRoster.value ? (
          <div class="holo-map__roster-overlay">
            <table>
              <thead>
                <tr><th colspan="3">{i18nT("replay.roster.allies")}</th></tr>
              </thead>
              <tbody>
                {props.vehicles.filter(v => v.relation <= 1).map(v => (
                  <tr key={v.id}>
                    <td style={{color: v.relation === 0 ? "#fff" : "#3cb478"}}>{v.name}</td>
                    <td>{v.shipName ?? shipNameFromOfflineDb(v.shipId, useLanguage().dataLanguage.value) ?? shipNameFromModelDb(v.shipId) ?? ""}</td>
                    <td></td>
                  </tr>
                ))}
              </tbody>
              <thead>
                <tr><th colspan="3">{i18nT("replay.roster.enemies")}</th></tr>
              </thead>
              <tbody>
                {props.vehicles.filter(v => v.relation > 1).map(v => (
                  <tr key={v.id}>
                    <td style={{color: "#cc3333"}}>{v.name}</td>
                    <td>{v.shipName ?? shipNameFromOfflineDb(v.shipId, useLanguage().dataLanguage.value) ?? shipNameFromModelDb(v.shipId) ?? ""}</td>
                    <td></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    );
  },
});
