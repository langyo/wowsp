/**
 * Tactical-board interaction layer over the enlarged 2D map: the annotation
 * canvas (same HiDPI / logical-760 contract as zoomCanvas), pointer tools
 * (pen/shapes/text/markers/path-pin/select), keyboard shortcuts, the
 * region-crop picker and the image/video export runners. Pure drawing lives
 * in render.ts; state lives in useTactical.
 */
import {
  computed,
  defineComponent,
  Teleport,
  onBeforeUnmount,
  onMounted,
  ref,
  toRef,
  watch,
  type PropType,
} from "vue";
import {
  bindContextMenu,
  useContextMenu,
  useToast,
  type ContextMenuRequest,
  type HkMenuItem,
} from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import type { EntityTrajectory } from "@/api/client";
import type { MapBounds } from "../modelLoader";
import TacticalToolbar from "./TacticalToolbar";
import Timeline, { type TimelineUserMarker } from "./Timeline";
import { viewSummaryLabel } from "./timelineModel";
import { useTactical } from "./useTactical";
import type { ShipAction } from "./actions";
import { planTracks as planTracksOf, type PlanTrack } from "./plan";
import type { CapSpec } from "./modes";
import {
  TEAM_COLOR,
  mirrorHeading,
  mirrorPoint,
  zoneSourceOf,
  type PlanUnit,
} from "./lineup";
import { kinematicsOf, planLeg, type Pose } from "./kinematics";
import {
  zoneEndedAt,
  zoneParamsOf,
  type ZoneParams,
  type ZoneType,
} from "./zones";
import { newElementId } from "./model";
import {
  makeProjection,
  markerHandlePx,
  planNextOf,
  planTweensOf,
  renderTactical,
  TACTICAL_SIZE,
  type TacticalProjection,
  type TacticalView,
} from "./render";
import {
  commitFreehand,
  commitMarker,
  commitPath,
  commitRouteMarker,
  commitShape,
  commitText,
  hitTestElement,
  markerPoseAt,
  moveElement,
  parseDoc,
  presentParkTarget,
  serializeDoc,
} from "./model";
import type {
  LogicalRect,
  MarkerElement,
  TacticalActionKind,
  TacticalElement,
  Vec2,
  ZoneElement,
} from "./types";
import { TACTICAL_MAX_SCALE, pointAlongPolyline, smoothPolyline } from "./geometry";
import {
  canvasToBlob,
  composeExportCanvas,
  drawMinimapChip,
  drawTimestampChip,
  formatBattleClock,
  frameTimes,
  pickRecorderMime,
  renderVideoOffline,
  saveExportBlob,
  TacticalRecorder,
} from "./exporters";
import "./TacticalBoard.scss";

/** Ship hit from the host map (HolographicMap's live marker positions). */
export interface ShipPick {
  entityId: number;
  label: string;
}

type Drag =
  | { kind: "draw"; raw: Vec2[] }
  | { kind: "shape"; from: Vec2; to: Vec2 }
  | { kind: "marker"; at: Vec2; start: Vec2; heading: number }
  | { kind: "rotate"; id: string; pushed: boolean }
  | { kind: "move"; id: string; grab: Vec2; last: Vec2; pushed: boolean }
  | { kind: "region"; from: Vec2; to: Vec2 }
  | { kind: "pan"; lastLx: number; lastLy: number }
  | { kind: "route"; raw: Vec2[] }
  | { kind: "erase" };

/** Min drag extents (logical px) below which a gesture is treated as a click. */
const MIN_SHAPE_PX = 8;
const MIN_REGION_PX = 24;

/** After committing a plan action, the clock jumps this far ahead so the NEXT
 *  drop of the same unit lands after this one and chains a leg without the
 *  author having to scrub between clicks. */
const PLAN_KEYFRAME_STEP_S = 30;

export default defineComponent({
  name: "TacticalBoard",
  props: {
    replayPath: { type: String, required: true },
    /** Filename fragment for export defaults (map name). */
    mapTag: { type: String, default: "map" },
    /** Map-frame rotation (degrees, +90° per rotate click). The annotation
     *  canvas renders through the same rotation as the base map; pointer
     *  input is un-rotated before hitting world space. */
    rotationDeg: { type: Number, default: 0 },
    /** Toolbar + interactions visible; off = view-only annotations. */
    editMode: { type: Boolean, default: false },
    getBounds: { type: Function as PropType<() => MapBounds | null>, required: true },
    /** FULL map bounds (grid squares are counted over the whole map —
     *  getBounds returns the moving view window, useless for coordinates). */
    getFullBounds: {
      type: Function as PropType<() => MapBounds | null>,
      default: undefined,
    },
    getTime: { type: Function as PropType<() => number>, required: true },
    getDuration: { type: Function as PropType<() => number>, required: true },
    getPlaying: { type: Function as PropType<() => boolean>, required: true },
    play: { type: Function as PropType<() => void>, required: true },
    pause: { type: Function as PropType<() => void>, required: true },
    /** Pause + jump the battle clock AND repaint markers + the 2D map
     *  synchronously (step navigation + offline frame rendering). */
    seekTo: { type: Function as PropType<(t: number) => void>, required: true },
    /** Pan/zoom handle for the enlarged 2D viewport (wheel zoom, hand pan,
     *  step camera tweens). Owned by HolographicMap. */
    viewApi: {
      type: Object as PropType<{
        snapshot(): TacticalView;
        zoomAt(lx: number, ly: number, factor: number): void;
        panByLogical(dxL: number, dyL: number): void;
        reset(): void;
        tweenTo(target: TacticalView, durMs?: number): void;
      }>,
      required: true,
    },
    trajectories: { type: Function as PropType<() => EntityTrajectory[]>, required: true },
    /** Replay-action markers for the timeline (shells / torpedoes / planes /
     *  speed changes). Empty on hosts that don't supply one. */
    actions: { type: Array as PropType<ShipAction[]>, default: () => [] },
    /** Entity id → display label (ship name) for timeline tooltips. */
    labelOf: {
      type: Function as PropType<(entityId: number) => string>,
      default: (id: number) => String(id),
    },
    pickShipAt: {
      type: Function as PropType<(x: number, z: number) => ShipPick | null>,
      required: true,
    },
    baseCanvas: {
      type: Function as PropType<() => HTMLCanvasElement | null>,
      required: true,
    },
    /** The host's overview minimap canvas (full map + view box), burned
     *  into exports/recordings when the export setting says so. Absent on
     *  hosts without one. */
    overlayCanvas: {
      type: Function as PropType<() => HTMLCanvasElement | null>,
      default: undefined,
    },
    /** Plan board (no replay behind it): virtual units render SOLID (they are
     *  the subject here, not a plan sketched over someone else's fight),
     *  markers carry action kinds and the timeline switches to accordion unit
     *  rows with tween arrows. */
    planMode: { type: Boolean, default: false },
    /** Fleet-planner units (lineup.ts PlanUnit[]): present and non-empty the
     *  board runs in unit mode — units come from the lineup (no free marker
     *  stamping), left-click orders the selected hull to the point via the
     *  kinematics estimator, and the right-click menu offers stops / zone
     *  launches through hikari's app-wide context menu. */
    planUnits: {
      type: Array as PropType<PlanUnit[]>,
      default: () => [],
    },
    /** Auto-mirror: every committed order/zone also lands on the unit's
     *  paired hull of the opposite side (PlanUnit.mateKey). */
    mirror: { type: Boolean, default: false },
    /** Ask the host to flip the mirror toggle (the toolbar's button). */
    onToggleMirror: {
      type: Function as PropType<() => void>,
      default: undefined,
    },
    /** Ask the host to open the lineup editor (the context menu's item). */
    onEditLineup: {
      type: Function as PropType<() => void>,
      default: undefined,
    },
    /** Capture points of the plan's battle mode (rendered + time-gated). */
    caps: { type: Array as PropType<CapSpec[]>, default: () => [] },
    /** Anchor the teleported toolbar/timeline dock. The replay host docks the
     *  board into the playback bar's tall form; a plan host docks its own. */
    dockSelector: { type: String, default: "#holo-map-tac-dock" },
  },
  setup(props, { expose }) {
    const canvasRef = ref<HTMLCanvasElement | null>(null);
    const inputRef = ref<HTMLInputElement | null>(null);
    const store = useTactical(toRef(props, "replayPath"));
    const toast = useToast();
    /** Host-facing surface: flush the store's debounced save so a plan-slot
     *  duplicate reads the CURRENT document, not one up to 400 ms stale;
     *  reloadDoc re-reads after a bundle import overwrote the storage. */
    expose({
      flushDoc: () => store.flush(),
      reloadDoc: () => store.reloadDoc(),
    });

    const drag = ref<Drag | null>(null);
    /** Unit mode is active on a plan board with a lineup behind it. */
    const lineupActive = computed(
      () => props.planMode && props.planUnits.length > 0,
    );
    /** Pending zone launch (the right-click calculator): aims with the
     *  pointer, commits on the next left click. */
    const aiming = ref<{
      pu: PlanUnit;
      type: ZoneType;
      heading: number;
      params: ZoneParams;
    } | null>(null);
    /** RTS order preview under the cursor (kinematics plan for the selected
     *  unit toward the pointer) — recomputed on pointermove, drawn by the
     *  render loop as a dashed path + arrival chip. */
    const hoverLeg = ref<{ path: Vec2[]; durS: number; to: Vec2 } | null>(null);
    const ctxMenu = useContextMenu();
    // The order preview belongs to a selected hull: losing the selection
    // (Escape, Delete, doc swap) must drop it even without pointer motion.
    watch(
      () => store.selectedId.value,
      () => {
        hoverLeg.value = null;
      },
    );
    /** Heading shown for the marker being Shift-spun. The element adopts the
     *  new heading live (one undo step per gesture), but a marker mid-tween
     *  is DRAWN along its leg's tangent — this override keeps the glyph
     *  pointing where the pointer says during the spin (render.ts). */
    const rotateOverride = ref<Map<string, number> | null>(null);
    /** Toolbar zoom readout (percent). Refreshed from the view once per
     *  frame, written only on change so the toolbar doesn't re-render. */
    const zoomPercent = ref(100);
    /** Toolbar zoom rung — same factor as one wheel notch, anchored on the
     *  viewport centre (there is no cursor to anchor on). */
    function zoomByToolbar(factor: number): void {
      props.viewApi.zoomAt(TACTICAL_SIZE / 2, TACTICAL_SIZE / 2, factor);
    }
    /** Waiting for the user to drag the export-crop rectangle. */
    const regionMode = ref(false);
    /** Cap layer visibility (the toolbar's toggle; on by default when the
     *  mode provides any points). */
    const capsVisible = ref(true);
    /** Finished crop rectangle, kept highlighted until exported/cancelled. */
    const pendingRegion = ref<LogicalRect | null>(null);
    const textEdit = ref<{ at: Vec2; value: string; id: string | null } | null>(null);
    const recording = ref(false);
    const busy = ref(false);
    const recorderSupported = pickRecorderMime() != null;
    let recorder: TacticalRecorder | null = null;
    let autoPlayedOnRecord = false;

    // Offline (faster-than-realtime) export state.
    const offlineRendering = ref(false);
    const offlineProgress = ref({ done: 0, total: 0 });
    const offlineCancel: { cancelled: boolean } = { cancelled: false };

    // Presentation mode: auto-advance playback that pauses at each step.
    const presentMode = ref(false);
    let presentDwellTimer: ReturnType<typeof setTimeout> | null = null;
    /** Space held = temporary hand tool (pan), Photoshop-style. */
    const spacePanning = ref(false);

    // Export settings owned here; the toolbar mutates them via its settings prop.
    const exportSettings = ref({
      format: "png" as "png" | "webp",
      scale: 1 as 1 | 2,
      timestamp: false,
      /** Burn the overview minimap into the frame's corner (on by default:
     *  a recorded walkthrough without the "where are we" chip is much
     *  harder to follow once the view is zoomed in). */
      minimap: true,
      offlineFps: 30 as 30 | 60,
      offlineFrom: "now" as "now" | "start",
    });

    const trajMap = computed(() => {
      const m = new Map<number, EntityTrajectory>();
      for (const tr of props.trajectories()) m.set(tr.entityId, tr);
      return m;
    });

    /** User-authored markers on the timeline: virtual ships/planes and
     *  pinned real paths, anchored at their reveal time. Over a replay
     *  context these render hollow (they are plans, not observed events);
     *  a plan board owns its units, so they render solid.
     *
     *  Markers carrying an action kind are NOT listed here — they are the
     *  plan tracks, which the timeline draws as accordion rows instead. */
    const userMarkers = computed<TimelineUserMarker[]>(() => {
      const out: TimelineUserMarker[] = [];
      for (const el of store.elements.value) {
        if (el.kind === "replayPath") {
          out.push({
            id: el.id,
            t0: el.t0,
            color: el.color,
            label: props.labelOf(el.entityId),
            kind: "path",
            solid: props.planMode,
          });
        } else if (el.kind === "zone") {
          out.push({
            id: el.id,
            t0: el.t0,
            color: el.team ? TEAM_COLOR[el.team] : "#94a3b8",
            label: `${el.unit} · ${i18nT(`tactics.zone.${el.zoneType}`)}`,
            kind: el.zoneType,
            solid: true,
            endT: zoneEndedAt(el),
          });
        } else if (el.kind === "marker" && (el.action == null || !props.planMode)) {
          // Action markers belong to the accordion tracks on a plan board —
          // but a plan document opened on the REPLAY board has no tracks, so
          // there they stay ordinary markers (chips, tooltips, right-click).
          out.push({
            id: el.id,
            t0: el.t0,
            color: el.color,
            label: el.label,
            kind: "marker",
            solid: props.planMode,
          });
        }
      }
      return out;
    });
    /** Accordion rows for the plan timeline (empty on a replay board, whose
     *  markers are annotations rather than unit keyframes). */
    const planTracks = computed<PlanTrack[]>(() =>
      props.planMode ? planTracksOf(store.elements.value) : [],
    );
    function removeUserMarkerById(id: string): void {
      store.removeElement(id);
    }

    /** Timeline unit rename: relabels EVERY keyframe of the track's chain —
     *  the label is the unit's identity, so renaming one marker alone would
     *  split the chain into two accordion rows. Empty = back to "Unit N".
     *  Lineup units refuse: their identity comes from the lineup (edit the
     *  label there; the chain follows — syncPlanUnits adopts + relabels). */
    function renameUnit(track: PlanTrack, name: string): void {
      const value = name.trim();
      const ids = new Set(track.ids);
      const owned = store.elements.value.filter(
        (el): el is MarkerElement => ids.has(el.id) && el.kind === "marker",
      );
      if (owned.some((el) => el.shipId != null)) return;
      if (!owned.some((el) => el.label !== value)) return;
      store.pushHistory();
      for (const el of owned) store.replaceElement(el.id, { ...el, label: value });
    }

    /** Timeline action editor data: a marker's time (+ action kind, null on
     *  non-plan annotations). Non-markers report null — nothing to edit. */
    function markerOf(id: string): { t0: number; action: TacticalActionKind | null } | null {
      const el = store.elements.value.find((x) => x.id === id);
      if (!el || el.kind !== "marker") return null;
      return { t0: el.t0, action: el.action ?? null };
    }

    /** Step-camera summary for the timeline's ruler tooltips (grid square
     *  of the view centre + zoom; zoom alone before bounds are ready). The
     *  square needs the FULL map — through the view window it would always
     *  read the centre cell. */
    function viewLabelOf(view: { cx: number; cz: number; scale: number }): string {
      return viewSummaryLabel(view, props.getFullBounds?.() ?? null);
    }

    /** Timeline action edit: retime / re-kind a keyframe (one undo step).
     *  Deliberately active on the replay host too: double-clicking an
     *  annotation marker there retimes it (clamped to the battle length);
     *  the kind picker stays plan-board-only (props.tall on the timeline). */
    function editMarker(id: string, patch: { t0?: number; action?: TacticalActionKind }): void {
      const el = store.elements.value.find((x) => x.id === id);
      if (!el || el.kind !== "marker") return;
      const t0 =
        patch.t0 != null
          ? Math.max(0, Math.min(props.getDuration(), patch.t0))
          : el.t0;
      const action = patch.action ?? el.action;
      if (t0 === el.t0 && action === el.action) return;
      store.pushHistory();
      store.replaceElement(id, { ...el, t0, action });
    }

    // ── Unit mode (lineup-driven plan board) ─────────────────────────────
    /** The plan unit a marker belongs to (markers chain by label). */
    function planUnitByKey(key: string): PlanUnit | null {
      return props.planUnits.find((u) => u.key === key) ?? null;
    }

    /** World point + projection from CLIENT pixels (shared by pointer events
     *  and the context-menu trigger, which reports client coords). */
    function clientWorld(
      clientX: number,
      clientY: number,
    ): { p: Vec2; lx: number; ly: number; p2: TacticalProjection } | null {
      const pr = proj();
      const cvs = canvasRef.value;
      if (!pr || !cvs) return null;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return null;
      const raw = unrotate(
        ((clientX - rect.left) / rect.width) * TACTICAL_SIZE,
        ((clientY - rect.top) / rect.height) * TACTICAL_SIZE,
      );
      return { p: pr.toWorld(raw.lx, raw.ly), lx: raw.lx, ly: raw.ly, p2: pr };
    }

    /** The marker that currently owns a unit at the playhead: the latest
     *  keyframe at/before t, else the unit's first (a scrub before its spawn
     *  still orders the spawn pose). Null when the unit has no markers. */
    function owningMarkerOf(key: string): MarkerElement | null {
      const t = props.getTime();
      const chain = store.elements.value.filter(
        (el): el is MarkerElement => el.kind === "marker" && el.label === key,
      );
      if (chain.length === 0) return null;
      const sorted = [...chain].sort((a, b) => a.t0 - b.t0);
      return sorted.reduceRight((acc, el) => acc ?? (el.t0 <= t ? el : null), null as MarkerElement | null) ?? sorted[0];
    }

    /** A unit's live pose at the playhead (route/tween aware). */
    function unitPoseOf(el: MarkerElement): Pose {
      const tween = planTweensOf(store.elements.value).get(el.id) ?? null;
      const pose = markerPoseAt(el, props.getTime(), tween);
      return { at: pose.at, heading: pose.heading };
    }

    /** RTS order: plan the leg with the kinematics estimator, commit it as
     *  a scripted route marker (the animation/timeline machinery comes free)
     *  and advance the clock to the arrival — the next order then chains
     *  from where this one lands, exactly like an RTS. */
    function commitOrder(
      pu: PlanUnit,
      target: Vec2,
      opts: { arriveHeading?: number | null; stop?: boolean; mirrorChain?: boolean; seek?: boolean } = {},
    ): void {
      const owner = owningMarkerOf(pu.key);
      if (!owner) return;
      const pose = unitPoseOf(owner);
      const kin = kinematicsOf(pu.unit.topSpeedKn, pu.unit.shipType);
      const plan = planLeg({
        from: pose,
        to: target,
        kin,
        arriveHeading: opts.arriveHeading ?? null,
        stop: opts.stop,
      });
      if (plan.path.length < 2) return;
      const durS = Math.round(plan.durS * 10) / 10;
      store.commit({
        ...commitMarker(pose.at, pose.heading, "ship", TEAM_COLOR[pu.side], props.getTime(), pu.key, "move"),
        route: plan.path,
        moveDur: durS,
        shipId: pu.unit.entry.shipId,
        team: pu.side,
        ...(opts.stop ? { stop: true } : {}),
      });
      if (opts.seek !== false) {
        props.seekTo(Math.min(props.getDuration(), props.getTime() + durS));
      }
      // Auto-mirror: the paired hull receives the mirrored order (position
      // and heading flip across the midline; the same stop semantics).
      if (opts.mirrorChain !== false && props.mirror && pu.mateKey) {
        const mate = planUnitByKey(pu.mateKey);
        const full = props.getFullBounds?.();
        if (mate && full) {
          commitOrder(mate, mirrorPoint(target, full), {
            arriveHeading: opts.arriveHeading != null ? mirrorHeading(opts.arriveHeading) : null,
            stop: opts.stop,
            mirrorChain: false,
            seek: false,
          });
        }
      }
    }

    /** Commit a zone (torpedo spread aimed / consumable ring) anchored at
     *  the unit's pose NOW — the element bakes its own parameters so later
     *  lineup edits never rewrite history. */
    function commitZoneAt(pu: PlanUnit, type: ZoneType, heading: number, mirrorChain = true): void {
      const params = zoneParamsOf(type, zoneSourceOf(pu.unit));
      const owner = owningMarkerOf(pu.key);
      if (!params || !owner) return;
      const pose = unitPoseOf(owner);
      const zone: ZoneElement = {
        id: newElementId(),
        kind: "zone",
        t0: props.getTime(),
        zoneType: type,
        at: pose.at,
        heading,
        radius: params.radius,
        halfAngle: params.halfAngle,
        speed: params.speed,
        durS: params.durS,
        unit: pu.key,
        team: pu.side,
      };
      store.commit(zone);
      if (mirrorChain && props.mirror && pu.mateKey) {
        const mate = planUnitByKey(pu.mateKey);
        const full = props.getFullBounds?.();
        if (mate && full) {
          const mirrored = { ...zone };
          mirrored.id = newElementId();
          mirrored.at = mirrorPoint(zone.at, full);
          mirrored.heading = mirrorHeading(zone.heading);
          mirrored.team = mate.side;
          mirrored.unit = mate.key;
          store.commit(mirrored);
        }
      }
    }

    /** Begin aiming a zone launch (the menu's calculator items): the sector
     *  rides the pointer around the unit until the next left click commits
     *  (Escape / right click cancels). */
    function startAiming(pu: PlanUnit, type: ZoneType, heading: number): void {
      const params = zoneParamsOf(type, zoneSourceOf(pu.unit));
      if (!params) return;
      aiming.value = { pu, type, heading, params };
    }

    function commitAim(): void {
      const aim = aiming.value;
      if (!aim) return;
      aiming.value = null;
      commitZoneAt(aim.pu, aim.type, aim.heading);
    }

    /** Delete a unit's keyframes strictly after the playhead (the context
     *  menu's "drop the rest of this unit's plan") — keeps the pose the
     *  clock is parked on. */
    function pruneUnitAfter(pu: PlanUnit): void {
      const t = props.getTime();
      const doomed = store.elements.value.filter(
        (el) => el.kind === "marker" && el.label === pu.key && el.t0 > t,
      );
      if (doomed.length === 0) return;
      store.pushHistory();
      const ids = new Set(doomed.map((el) => el.id));
      store.applyDoc({
        elements: store.elements.value.filter((el) => !ids.has(el.id)),
        steps: store.steps.value,
      });
    }

    /** Keep the board's units in step with the lineup: spawn markers for
     *  hulls that have none, drop the chains of hulls that left. Runs once
     *  per lineup change; a no-op lineup (unit mode off) is ignored. */
    function syncPlanUnits(): void {
      if (!lineupActive.value) return;
      // Unit mode drives units by orders — a stray marker tool would stamp
      // ghost hulls that chain into nothing. Back to select.
      if (store.tool.value === "markerShip" || store.tool.value === "markerPlane") {
        store.tool.value = "select";
      }
      const chains = new Map<string, MarkerElement[]>();
      for (const el of store.elements.value) {
        if (el.kind === "marker" && el.shipId != null) {
          const list = chains.get(el.label);
          if (list) list.push(el);
          else chains.set(el.label, [el]);
        }
      }
      // Match units to chains: by key first, then — for a unit whose label
      // changed (lineup editor rename) — by hull+side ADOPTION, relabeling
      // the chain to the new key so the plan the author already drew
      // survives the rename instead of being orphaned and respawned.
      // Known ambiguity: TWO identical hulls (same ship, same side) where
      // one is renamed and the other removed in the same edit may adopt the
      // removed one's chain — the chains are indistinguishable, and both
      // keep a valid plan either way.
      const remaining = new Map(chains);
      const missing: PlanUnit[] = [];
      const relabels: { from: string; to: string }[] = [];
      for (const u of props.planUnits) {
        let list = remaining.get(u.key);
        if (list) {
          remaining.delete(u.key);
          continue;
        }
        let adoptedKey: string | null = null;
        for (const [k, l] of remaining) {
          if (l[0].shipId === u.unit.entry.shipId && l[0].team === u.side) {
            adoptedKey = k;
            list = l;
            break;
          }
        }
        if (list && adoptedKey != null) {
          remaining.delete(adoptedKey);
          relabels.push({ from: adoptedKey, to: u.key });
        } else {
          missing.push(u);
        }
      }
      const orphanKeys = [...remaining.keys()];
      if (missing.length === 0 && orphanKeys.length === 0 && relabels.length === 0) return;
      store.pushHistory();
      let elements = [...store.elements.value];
      for (const u of missing) {
        elements.push({
          ...commitMarker(u.spawn.at, u.spawn.heading, "ship", TEAM_COLOR[u.side], 0, u.key, "move"),
          shipId: u.unit.entry.shipId,
          team: u.side,
        });
      }
      if (orphanKeys.length > 0) {
        const orphans = new Set(orphanKeys);
        elements = elements.filter(
          (el) => !(el.kind === "marker" && el.shipId != null && orphans.has(el.label)),
        );
      }
      for (const r of relabels) {
        elements = elements.map((el) =>
          el.kind === "marker" && el.shipId != null && el.label === r.from
            ? { ...el, label: r.to }
            : el,
        );
      }
      store.applyDoc({ elements, steps: store.steps.value });
    }
    watch(
      () => props.planUnits,
      () => syncPlanUnits(),
      { deep: true },
    );
    onMounted(() => void syncPlanUnits());

    // ── App-wide context menu (hikari HkContextMenuProvider) ─────────────
    /** The unit-mode right-click menu: on a unit — its zone launches and a
     *  prune; on empty water with a unit selected — orders to that point;
     *  otherwise a shortcut into the lineup editor. Non-unit-mode boards
     *  return null and keep the platform menu suppressed as before. */
    function buildContextMenu(x: number, y: number): ContextMenuRequest | null {
      if (!lineupActive.value) return null;
      const hit = clientWorld(x, y);
      if (!hit) return null;
      const target = hitTest(hit.p, hit.p2);
      const unitOfMarker = (el: TacticalElement | null): PlanUnit | null =>
        el != null && el.kind === "marker" && el.shipId != null ? planUnitByKey(el.label) : null;
      const zoneItem = (type: ZoneType, key: string, labelKey: string, pu: PlanUnit): HkMenuItem | null =>
        zoneParamsOf(type, zoneSourceOf(pu.unit)) ? { key, label: i18nT(labelKey) } : null;
      const tu = unitOfMarker(target);
      if (tu) {
        const items: HkMenuItem[] = [];
        const zi = zoneItem("torpedo", "aim:torpedo", "tactics.ctx.torp", tu);
        if (zi) items.push(zi);
        for (const [type, labelKey] of [
          ["radar", "tactics.ctx.radar"],
          ["hydro", "tactics.ctx.hydro"],
          ["smoke", "tactics.ctx.smoke"],
        ] as const) {
          const item = zoneItem(type, `zone:${type}`, labelKey, tu);
          if (item) items.push(item);
        }
        items.push({
          key: "prune",
          label: i18nT("tactics.ctx.prune", { name: tu.key }),
          danger: true,
        });
        const owner = owningMarkerOf(tu.key);
        const pose = owner ? unitPoseOf(owner) : null;
        return {
          x,
          y,
          title: tu.key,
          items,
          onSelect: (key: string) => {
            if (key === "aim:torpedo" && pose) startAiming(tu, "torpedo", pose.heading);
            else if (key.startsWith("zone:") && pose) {
              commitZoneAt(tu, key.slice(5) as ZoneType, pose.heading);
            } else if (key === "prune") pruneUnitAfter(tu);
          },
        };
      }
      const su = unitOfMarker(store.selected.value);
      if (su) {
        const owner = owningMarkerOf(su.key);
        if (!owner) return null;
        const pose = unitPoseOf(owner);
        const bearing = Math.atan2(hit.p.x - pose.at.x, hit.p.z - pose.at.z);
        const items: HkMenuItem[] = [
          { key: "move", label: i18nT("tactics.ctx.move") },
          { key: "stop", label: i18nT("tactics.ctx.stop") },
        ];
        const zi = zoneItem("torpedo", "aimAt:torpedo", "tactics.ctx.torpAt", su);
        if (zi) items.push(zi);
        for (const [type, labelKey] of [
          ["radar", "tactics.ctx.radar"],
          ["hydro", "tactics.ctx.hydro"],
          ["smoke", "tactics.ctx.smoke"],
        ] as const) {
          const item = zoneItem(type, `zoneAt:${type}`, labelKey, su);
          if (item) items.push(item);
        }
        return {
          x,
          y,
          title: su.key,
          items,
          onSelect: (key: string) => {
            if (key === "move") commitOrder(su, hit.p);
            else if (key === "stop") commitOrder(su, hit.p, { arriveHeading: bearing, stop: true });
            else if (key === "aimAt:torpedo") startAiming(su, "torpedo", bearing);
            else if (key.startsWith("zoneAt:")) {
              commitZoneAt(su, key.slice(7) as ZoneType, bearing);
            }
          },
        };
      }
      return {
        x,
        y,
        items: [{ key: "lineup", label: i18nT("tactics.ctx.editLineup") }],
        onSelect: () => props.onEditLineup?.(),
      };
    }

    function proj(): TacticalProjection | null {
      const b = props.getBounds();
      return b ? makeProjection(b) : null;
    }

    /** Pointer event → world coords (null when the projection isn't ready). */
    function eventWorld(e: MouseEvent): { p: Vec2; lx: number; ly: number; p2: TacticalProjection } | null {
      return clientWorld(e.clientX, e.clientY);
    }

    const rotRad = computed(() => (props.rotationDeg * Math.PI) / 180);
    /** View-space (un-rotated) point for a canvas-space point: the annotation
     *  canvas renders rotated, so pointer input must spin back by -θ around
     *  the logical centre before it can hit world coordinates. */
    function unrotate(lx: number, ly: number): { lx: number; ly: number } {
      const r = -rotRad.value;
      if (r === 0) return { lx, ly };
      const c = TACTICAL_SIZE / 2;
      const dx = lx - c;
      const dy = ly - c;
      return {
        lx: c + dx * Math.cos(r) - dy * Math.sin(r),
        ly: c + dx * Math.sin(r) + dy * Math.cos(r),
      };
    }
    /** Screen-rotate a view-space point for DOM positioning (text editor). */
    function rotatePoint(q: { x: number; y: number }): { x: number; y: number } {
      const r = rotRad.value;
      if (r === 0) return q;
      const c = TACTICAL_SIZE / 2;
      const dx = q.x - c;
      const dy = q.y - c;
      return {
        x: c + dx * Math.cos(r) - dy * Math.sin(r),
        y: c + dx * Math.sin(r) + dy * Math.cos(r),
      };
    }
    /** Screen-space bounding box of a view-space rect under the map-frame
     *  rotation: the live canvases store the ROTATED composition, so a crop
     *  must spin forward before it can slice pixels — at 90° steps the
     *  result is exactly the framed rect (edges swapped for odd turns). */
    function screenCropRect(region: LogicalRect): LogicalRect {
      const corners = [
        { x: region.x, y: region.y },
        { x: region.x + region.w, y: region.y },
        { x: region.x, y: region.y + region.h },
        { x: region.x + region.w, y: region.y + region.h },
      ].map(rotatePoint);
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return {
        x: minX,
        y: minY,
        w: Math.max(...xs) - minX,
        h: Math.max(...ys) - minY,
      };
    }

    function anchorT0(): number {
      return store.anchorToTime.value ? props.getTime() : 0;
    }

    // ── Render loop ──────────────────────────────────────────────────────
    let raf = 0;
    function frame(): void {
      raf = requestAnimationFrame(frame);
      // While recording, drop the crop mask from the live overlay too — the
      // recorder composes this very canvas, so the dim rectangle would burn
      // into the video (WYSIWYG: live view == recorded frames).
      renderNow(recorder?.recording ? null : undefined);
      const z = Math.round(props.viewApi.snapshot().scale * 100);
      if (z !== zoomPercent.value) zoomPercent.value = z;
      if (recorder?.recording) {
        recorder.tick();
        const dur = props.getDuration();
        if (dur > 0 && props.getTime() >= dur - 0.08) void stopRecording();
      }
      // Presentation auto-advance: playing crosses a step boundary → park
      // exactly on it, dwell, then continue toward the next step.
      if (presentMode.value && props.getPlaying()) {
        const t = props.getTime();
        const park = presentParkTarget(store.stepsSorted.value, t);
        if (park) {
          props.seekTo(park.t);
          if (park.view) props.viewApi.tweenTo(park.view);
          props.pause();
          schedulePresentDwell();
        } else if (props.getDuration() > 0 && t >= props.getDuration() - 0.1) {
          exitPresentMode();
        }
      }
    }

    /** Paint one frame of the annotation layer now. `regionOverride` lets the
     *  exporters compose WITHOUT the crop mask burned in (a full-map export
     *  must not ship with everything outside the pending crop dimmed). */
    function renderNow(regionOverride?: LogicalRect | null): void {
      const cvs = canvasRef.value;
      const bounds = props.getBounds();
      if (!cvs || !bounds) return;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const px = Math.round(rect.width * dpr);
      if (cvs.width !== px) {
        cvs.width = px;
        cvs.height = px;
      }
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(px / TACTICAL_SIZE, 0, 0, px / TACTICAL_SIZE, 0, 0);
      // Mirror the base map's world-frame rotation (annotations are
      // world-anchored: they must spin together with the art).
      if (rotRad.value !== 0) {
        ctx.save();
        const c = TACTICAL_SIZE / 2;
        ctx.translate(c, c);
        ctx.rotate(rotRad.value);
        ctx.translate(-c, -c);
      }
      const p = makeProjection(bounds);
      const regionRect: LogicalRect | null =
        regionOverride !== undefined
          ? regionOverride
          : drag.value?.kind === "region"
            ? worldRectToLogical(drag.value.from, drag.value.to, p)
            : pendingRegion.value;
      renderTactical(ctx, {
        elements: store.elements.value,
        proj: p,
        time: props.getTime(),
        trajectories: trajMap.value,
        selectedId: store.selectedId.value,
        preview: previewElement.value,
        regionRect,
        showGhostFuture: store.showGhostFuture.value,
        headingOverrides: rotateOverride.value ?? undefined,
        // The route-end arrival knob only exists for ordered unit hulls —
        // a hand-drawn route marker (replay board) sails its own path with
        // no terminal heading to steer.
        scriptedHandles: lineupActive.value,
        caps: lineupActive.value && capsVisible.value ? props.caps : [],
        legPreview: hoverLeg.value,
        aimPreview: aimPreview.value,
        // Over a replay the virtual units are PLANS drawn hollow, so they
        // never read as observed contacts; a plan board has no contacts of
        // its own, so its units own the solid glyph.
        hollowMarkers: !props.planMode,
      });
      if (rotRad.value !== 0) ctx.restore();
      // Keep the text editor glued to its world anchor (screen-rotated),
      // tilting the box with the map frame: committed text pivots on its
      // top-left anchor (drawText, render.ts), so the editor rotates around
      // the same corner — its -0.35em lift rides the rotated frame and
      // keeps clearing the first line.
      if (textEdit.value && inputRef.value) {
        const q = rotatePoint(p.toPx(textEdit.value.at));
        inputRef.value.style.left = `${(q.x / TACTICAL_SIZE) * 100}%`;
        inputRef.value.style.top = `${(q.y / TACTICAL_SIZE) * 100}%`;
        inputRef.value.style.transform =
          rotRad.value !== 0 ? `rotate(${props.rotationDeg}deg) translateY(-0.35em)` : "";
      }
    }

    function worldRectToLogical(a: Vec2, b: Vec2, p: TacticalProjection): LogicalRect {
      const q1 = p.toPx(a);
      const q2 = p.toPx(b);
      return {
        x: Math.min(q1.x, q2.x),
        y: Math.min(q1.y, q2.y),
        w: Math.abs(q2.x - q1.x),
        h: Math.abs(q2.y - q1.y),
      };
    }

    // ── Preview element while a gesture is in flight ─────────────────────
    const previewElement = computed<TacticalElement | null>(() => {
      const d = drag.value;
      const look = store.style.value;
      if (!d) return null;
      switch (d.kind) {
        case "draw":
          return {
            id: "preview",
            kind: "freehand",
            t0: 0,
            points: d.raw,
            drawIn: 0,
            ...look,
          };
        case "shape":
          return {
            id: "preview",
            kind: store.tool.value === "arrow"
              ? "arrow"
              : store.tool.value === "rect"
                ? "rect"
                : store.tool.value === "ellipse"
                  ? "ellipse"
                  : "line",
            t0: 0,
            points: [d.from, d.to],
            drawIn: 0,
            ...look,
          };
        case "marker":
          return {
            id: "preview",
            kind: "marker",
            t0: 0,
            at: d.at,
            heading: d.heading,
            variant: store.tool.value === "markerPlane" ? "plane" : "ship",
            color: look.color,
            label: "",
            size: 40,
          };
        case "route":
          return {
            id: "preview",
            kind: "marker",
            t0: 0,
            at: d.raw[0],
            heading: 0,
            variant: "ship",
            color: look.color,
            label: "",
            size: 40,
            route: d.raw,
            moveDur: 30,
          };
        default:
          return null;
      }
    });

    // ── Pointer interactions ─────────────────────────────────────────────
    // Touch/pen pointers on the canvas, by pointer id. TWO at once = pinch
    // zoom + pan (the tool gesture in flight is cancelled); the canvas has
    // touch-action:none so the browser never races us for the gesture.
    const touchPts = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; cx: number; cy: number } | null = null;

    function canvasLogical(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
      const cvs = canvasRef.value;
      if (!cvs) return null;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      // View-space: the pinch feeds zoomAt/panByLogical, which operate on
      // the un-rotated viewport.
      const q = unrotate(
        ((e.clientX - rect.left) / rect.width) * TACTICAL_SIZE,
        ((e.clientY - rect.top) / rect.height) * TACTICAL_SIZE,
      );
      return { x: q.lx, y: q.ly };
    }

    /** Advance the pinch from the current two pointers: zoom by the distance
     *  ratio (anchored on the midpoint) and pan by the midpoint's move. */
    function pinchUpdate(): void {
      const pts = [...touchPts.values()];
      if (pts.length < 2) {
        pinch = null;
        return;
      }
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (pinch != null && dist > 1) {
        props.viewApi.zoomAt(cx, cy, dist / pinch.dist);
        props.viewApi.panByLogical(cx - pinch.cx, cy - pinch.cy);
      }
      pinch = { dist, cx, cy };
    }

    function onPointerDown(e: PointerEvent): void {
      // Never let the click bubble to the mmzoom overlay (it closes on click).
      e.stopPropagation();
      if (e.pointerType !== "mouse") {
        const q = canvasLogical(e);
        if (q) touchPts.set(e.pointerId, q);
        if (touchPts.size >= 2) {
          // A second finger takes over from any single-pointer gesture.
          cancelDrag();
          pinchUpdate();
          return;
        }
      }
      if (e.button !== 0) return;
      const hit = eventWorld(e);
      if (!hit) return;
      // A pending zone launch commits on the next left click — everything
      // else (pan, select, orders) waits until the aim resolves.
      if (aiming.value) {
        commitAim();
        return;
      }
      // View-only mode still pans/zooms the camera (annotations are read).
      // Edit mode pans via the hand tool or while Space is held.
      const wantPan = !props.editMode || spacePanning.value || store.tool.value === "hand";
      if (wantPan) {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.value = { kind: "pan", lastLx: hit.lx, lastLy: hit.ly };
        return;
      }
      if (!props.editMode) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const tool = store.tool.value;
      if (regionMode.value) {
        drag.value = { kind: "region", from: hit.p, to: hit.p };
        return;
      }
      // Spin-handle grab: when a spinnable marker is selected, its heading
      // knob outranks ordinary hit-testing so the knob is always grabbable
      // even when it sits over another element. Scripted (RTS-ordered)
      // markers only offer their arrival knob in unit mode — on a replay
      // host they sail a hand-drawn route with no terminal constraint.
      if (tool === "select" && store.selectedId.value) {
        const sel = store.elements.value.find((x) => x.id === store.selectedId.value);
        if (sel) {
          const scripted =
            sel.kind === "marker" && sel.route != null && sel.route.length >= 2 && !!sel.moveDur;
          const knobOK = !scripted || (lineupActive.value && sel.kind === "marker" && sel.shipId != null);
          if (knobOK) {
            const handle = markerHandlePx(
              sel,
              store.elements.value,
              hit.p2,
              props.getTime(),
              rotateOverride.value ?? undefined,
            );
            if (handle && Math.hypot(handle.at.x - hit.lx, handle.at.y - hit.ly) <= 9) {
              drag.value = { kind: "rotate", id: sel.id, pushed: false };
              return;
            }
          }
        }
      }
      // Unit mode: left-clicking open water with a hull selected ORDERS it
      // there (the RTS click). A click on a unit selects that unit instead;
      // annotation elements keep their ordinary select behaviour.
      if (lineupActive.value && tool === "select") {
        const target = hitTest(hit.p, hit.p2);
        if (target == null) {
          const sel = store.selected.value;
          if (sel && sel.kind === "marker" && sel.shipId != null) {
            const pu = planUnitByKey(sel.label);
            if (pu) {
              commitOrder(pu, hit.p);
              return;
            }
          }
        } else if (
          target.kind === "marker" &&
          target.shipId != null &&
          target.id !== store.selectedId.value
        ) {
          store.selectedId.value = target.id;
          return;
        }
      }
      switch (tool) {
        case "pen":
          drag.value = { kind: "draw", raw: [hit.p] };
          break;
        case "line":
        case "arrow":
        case "rect":
        case "ellipse":
          drag.value = { kind: "shape", from: hit.p, to: hit.p };
          break;
        case "markerShip":
        case "markerPlane":
          drag.value = { kind: "marker", at: hit.p, start: hit.p, heading: 0 };
          break;
        case "markerRoute":
          drag.value = { kind: "route", raw: [hit.p] };
          break;
        case "eraser":
          drag.value = { kind: "erase" };
          eraseAt(hit.p, hit.p2);
          break;
        case "text":
          openTextEditor(hit.p, null);
          break;
        case "pinPath": {
          const ship = props.pickShipAt(hit.p.x, hit.p.z);
          if (ship) {
            store.commit(commitPath(ship.entityId, store.style.value, "now", anchorT0()));
            toast.info(i18nT("replay.tactical.toast.pinned", { name: ship.label }));
          } else {
            toast.info(i18nT("replay.tactical.hint.pin"));
          }
          break;
        }
        case "select": {
          const target = hitTest(hit.p, hit.p2);
          store.selectedId.value = target?.id ?? null;
          // Shift+drag a marker = spin it in place: precise heading control
          // without re-dropping the unit. Scripted route markers are exempt
          // — they sail their route and are drawn along its tangent, so a
          // manual heading would be invisible the moment the pointer lifts.
          const spinnable =
            target?.kind === "marker" &&
            !(target.route != null && target.route.length >= 2 && !!target.moveDur && target.moveDur > 0);
          if (target && spinnable && e.shiftKey) {
            drag.value = { kind: "rotate", id: target.id, pushed: false };
          } else if (
            target &&
            target.kind !== "replayPath" &&
            // An ordered (scripted) unit marker sits at the START of its
            // planned route — dragging it would desync hull from route, so
            // unit-mode hulls move by orders only.
            !(lineupActive.value && target.kind === "marker" && target.route != null)
          ) {
            drag.value = { kind: "move", id: target.id, grab: hit.p, last: hit.p, pushed: false };
          }
          break;
        }
      }
    }

    /** Eraser hit: delete the topmost element under the point (each removal
     *  is its own undo entry — matches Delete-key semantics). The radius is
     *  a fixed screen size, independent of the current stroke width. */
    function eraseAt(p: Vec2, pr: TacticalProjection): void {
      const t = props.getTime();
      const padWorld = 10 * pr.worldPerPx * 1.6;
      const tweens = planTweensOf(store.elements.value);
      const nexts = planNextOf(store.elements.value);
      for (let i = store.elements.value.length - 1; i >= 0; i--) {
        const el = store.elements.value[i];
        if (!ownsUnitAt(el, t, nexts)) continue; // superseded: no glyph on screen
        if (hitTestElement(el, p, padWorld, t, tweens.get(el.id))) {
          store.removeElement(el.id);
          return;
        }
      }
    }

    /** Is this element's glyph on screen at time t? Plan chains draw only the
     *  hull of the action that currently owns the unit (render.ts), so hit
     *  testing and the eraser must skip the keyframes it has moved past. */
    function ownsUnitAt(el: TacticalElement, t: number, nexts: Map<string, number>): boolean {
      if (el.kind !== "marker" || el.action == null) return true;
      const handover = nexts.get(el.id);
      return handover == null || t < handover;
    }

    /** A pending launch rendered as the dashed envelope: pivots on the
     *  unit's live pose, radius/half-angle from the baked launch params. */
    const aimPreview = computed(() => {
      const aim = aiming.value;
      if (!aim) return null;
      const owner = owningMarkerOf(aim.pu.key);
      const pose = owner
        ? unitPoseOf(owner)
        : { at: aim.pu.spawn.at, heading: aim.pu.spawn.heading };
      return {
        at: pose.at,
        heading: aim.heading,
        radius: aim.params.radius,
        halfAngle: aim.params.halfAngle,
        type: aim.type,
      };
    });

    /** Cursor-time unit feedback: the RTS order preview for the selected
     *  hull toward the pointer. */
    function updateHoverLeg(e: MouseEvent): void {
      if (!lineupActive.value || aiming.value) {
        hoverLeg.value = null;
        return;
      }
      const sel = store.selected.value;
      if (!sel || sel.kind !== "marker" || sel.shipId == null) {
        hoverLeg.value = null;
        return;
      }
      const pu = planUnitByKey(sel.label);
      const owner = pu ? owningMarkerOf(pu.key) : null;
      if (!pu || !owner) {
        hoverLeg.value = null;
        return;
      }
      const hit = eventWorld(e);
      if (!hit) return;
      const pose = unitPoseOf(owner);
      const plan = planLeg({
        from: pose,
        to: hit.p,
        kin: kinematicsOf(pu.unit.topSpeedKn, pu.unit.shipType),
      });
      hoverLeg.value = { path: plan.path, durS: plan.durS, to: hit.p };
    }

    /** A pending launch aims at the pointer: the sector pivots on its unit. */
    function updateAiming(e: MouseEvent): void {
      const aim = aiming.value;
      if (!aim) return;
      const owner = owningMarkerOf(aim.pu.key);
      if (!owner) return;
      const hit = eventWorld(e);
      if (!hit) return;
      const pose = unitPoseOf(owner);
      aim.heading = Math.atan2(hit.p.x - pose.at.x, hit.p.z - pose.at.z);
    }

    function onPointerMove(e: PointerEvent): void {
      if (touchPts.has(e.pointerId)) {
        const q = canvasLogical(e);
        if (q) touchPts.set(e.pointerId, q);
        if (touchPts.size >= 2) {
          pinchUpdate();
          e.stopPropagation();
          return;
        }
      }
      if (!drag.value) {
        if (aiming.value) updateAiming(e);
        else updateHoverLeg(e);
        return;
      }
      e.stopPropagation();
      const hit = eventWorld(e);
      if (!hit) return;
      const d = drag.value;
      switch (d.kind) {
        case "pan": {
          // hit.lx/ly are view-space logical px; their delta IS the drag
          // delta, so the map follows the pointer 1:1.
          props.viewApi.panByLogical(hit.lx - d.lastLx, hit.ly - d.lastLy);
          d.lastLx = hit.lx;
          d.lastLy = hit.ly;
          break;
        }
        case "draw": {
          const last = d.raw[d.raw.length - 1];
          if (!last || Math.hypot(last.x - hit.p.x, last.z - hit.p.z) > hit.p2.worldPerPx * 1.2) {
            d.raw.push(hit.p);
          }
          break;
        }
        case "route": {
          const last = d.raw[d.raw.length - 1];
          if (!last || Math.hypot(last.x - hit.p.x, last.z - hit.p.z) > hit.p2.worldPerPx * 1.2) {
            d.raw.push(hit.p);
          }
          break;
        }
        case "erase":
          eraseAt(hit.p, hit.p2);
          break;
        case "shape":
          d.to = hit.p;
          break;
        case "marker": {
          // The marker rides the pointer — release drops it exactly where
          // the cursor is, so placement is as precise as the pointer itself.
          // Once the drag pulls away from the press point the heading follows
          // the pull direction (referenced to the FIXED start, so the bow
          // doesn't jitter with every detour); a plain click keeps north.
          d.at = hit.p;
          const dx = hit.p.x - d.start.x;
          const dz = hit.p.z - d.start.z;
          if (Math.hypot(dx, dz) > hit.p2.worldPerPx * 4) {
            d.heading = Math.atan2(dx, dz); // clockwise from north
          }
          break;
        }
        case "rotate": {
          const el = store.elements.value.find((x) => x.id === d.id);
          if (el && el.kind === "marker") {
            // An ordered unit's knob re-plans the leg's TERMINAL heading
            // (stop orders): drag the knob, the arrival turn + minimum time
            // recompute around the same route endpoints.
            const scripted =
              el.route != null && el.route.length >= 2 && !!el.moveDur && el.shipId != null;
            if (scripted && lineupActive.value) {
              const pu = planUnitByKey(el.label);
              if (pu) {
                const routeEnd = pointAlongPolyline(smoothPolyline(el.route!), 1);
                const dx = hit.p.x - routeEnd.at.x;
                const dz = hit.p.z - routeEnd.at.z;
                if (Math.hypot(dx, dz) > hit.p2.worldPerPx * 2) {
                  if (!d.pushed) {
                    store.pushHistory();
                    d.pushed = true;
                  }
                  const heading = Math.atan2(dx, dz);
                  const plan = planLeg({
                    from: { at: el.at, heading: el.heading },
                    to: routeEnd.at,
                    kin: kinematicsOf(pu.unit.topSpeedKn, pu.unit.shipType),
                    arriveHeading: heading,
                    stop: el.stop === true,
                  });
                  store.replaceElement(el.id, {
                    ...el,
                    route: plan.path,
                    moveDur: Math.round(plan.durS * 10) / 10,
                  });
                  rotateOverride.value = new Map([[d.id, heading]]);
                }
                break;
              }
            }
            // Spin about the glyph the user can see right now (a scripted or
            // mid-tween marker is drawn somewhere along its leg, not at its
            // authored `at`).
            const pose = markerPoseAt(
              el,
              props.getTime(),
              planTweensOf(store.elements.value).get(el.id) ?? null,
            );
            const dx = hit.p.x - pose.at.x;
            const dz = hit.p.z - pose.at.z;
            if (Math.hypot(dx, dz) > hit.p2.worldPerPx * 2) {
              // History only once the spin actually turns the unit — a
              // Shift-click with pointer jitter must not push an empty
              // undo step.
              if (!d.pushed) {
                store.pushHistory();
                d.pushed = true;
              }
              const heading = Math.atan2(dx, dz); // clockwise from north
              store.replaceElement(d.id, { ...el, heading });
              rotateOverride.value = new Map([[d.id, heading]]);
            }
          }
          break;
        }
        case "move": {
          if (!d.pushed) {
            store.pushHistory();
            d.pushed = true;
          }
          const el = store.elements.value.find((x) => x.id === d.id);
          if (el) {
            store.replaceElement(d.id, moveElement(el, hit.p.x - d.last.x, hit.p.z - d.last.z));
          }
          d.last = hit.p;
          break;
        }
        case "region":
          d.to = hit.p;
          break;
      }
    }

    /** End any in-flight gesture without committing it — shared by Escape,
     *  pointercancel/leave, recording start and the edit-mode watch (the
     *  pointer-up path owns its own commit). Also drops the spin override so
     *  an interrupted rotation doesn't leave a tweening glyph pinned. */
    function cancelDrag(): void {
      drag.value = null;
      rotateOverride.value = null;
    }

    function onPointerUp(e: PointerEvent): void {
      e.stopPropagation();
      touchPts.delete(e.pointerId);
      pinch = null; // re-baseline even if a finger pair survives a swap
      if (e.button !== 0) return; // only the primary button ends a gesture
      const d = drag.value;
      drag.value = null;
      rotateOverride.value = null;
      if (!d) return;
      const pr = proj();
      switch (d.kind) {
        case "pan":
        case "erase":
        case "rotate":
          break;
        case "draw":
          if (d.raw.length >= 2) {
            store.commit(
              commitFreehand(d.raw, store.style.value, anchorT0(), (pr?.worldPerPx ?? 1) * 2.2),
            );
          }
          break;
        case "route": {
          if (d.raw.length >= 2) {
            const el = commitRouteMarker(
              d.raw,
              store.style.value.color,
              anchorT0(),
              (pr?.worldPerPx ?? 1) * 2.2,
            );
            if (el) store.commit(el);
          }
          break;
        }
        case "shape": {
          const r = pr ? worldRectToLogical(d.from, d.to, pr) : null;
          if (r && (r.w >= MIN_SHAPE_PX || r.h >= MIN_SHAPE_PX)) {
            const kind =
              store.tool.value === "line" || store.tool.value === "arrow"
                ? store.tool.value
                : store.tool.value === "ellipse"
                  ? "ellipse"
                  : "rect";
            store.commit(commitShape(kind, d.from, d.to, store.style.value, anchorT0()));
          }
          break;
        }
        case "marker":
          store.commit(
            commitMarker(
              d.at,
              d.heading,
              store.tool.value === "markerPlane" ? "plane" : "ship",
              store.style.value.color,
              anchorT0(),
              "",
              // On a plan board every marker is a keyframe; over a replay the
              // marker stays a plain annotation (no action, no tweening).
              props.planMode ? store.actionKind.value : undefined,
            ),
          );
          // Plan flow: jump the clock past the mark just placed so the next
          // drop of the same unit lands after it (two actions on one second
          // would stack instead of chaining a tween leg). Unit mode has no
          // stamping (orders carry their own arrival clock), so it stays.
          if (props.planMode && !lineupActive.value) {
            props.seekTo(Math.min(props.getDuration(), props.getTime() + PLAN_KEYFRAME_STEP_S));
          }
          break;
        case "move":
          break;
        case "region": {
          const r = pr ? worldRectToLogical(d.from, d.to, pr) : null;
          regionMode.value = false;
          if (r && r.w >= MIN_REGION_PX && r.h >= MIN_REGION_PX) {
            pendingRegion.value = r;
          } else {
            pendingRegion.value = null;
          }
          break;
        }
      }
    }

    /** Wheel = cursor-anchored zoom of the 2D viewport (any mode). */
    function onWheel(e: WheelEvent): void {
      e.stopPropagation();
      e.preventDefault();
      const cvs = canvasRef.value;
      if (!cvs) return;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return;
      const hit = unrotate(
        ((e.clientX - rect.left) / rect.width) * TACTICAL_SIZE,
        ((e.clientY - rect.top) / rect.height) * TACTICAL_SIZE,
      );
      const factor = e.deltaY < 0 ? 1.22 : 1 / 1.22;
      props.viewApi.zoomAt(hit.lx, hit.ly, factor);
    }

    function onDoubleClick(e: MouseEvent): void {
      e.stopPropagation();
      if (!props.editMode) return;
      const hit = eventWorld(e);
      if (!hit) return;
      const target = hitTest(hit.p, hit.p2);
      if (!target) return;
      // Lineup hulls refuse in-place label edits (the timeline rename does
      // too): the label is the chain key, and a split keyframe chain gets
      // pruned at the next lineup sync. Rename those in the lineup editor.
      if (target.kind === "marker" && target.shipId != null) return;
      if (target.kind === "text") openTextEditor(target.at, target.id);
      else if (target.kind === "marker") {
        // Anchor at the marker's pose right now: a scripted one may be
        // anywhere along its route and a plan action mid-leg is between its
        // two marks — never at the authored `at`.
        const tween = planTweensOf(store.elements.value).get(target.id) ?? null;
        openTextEditor(markerPoseAt(target, props.getTime(), tween).at, target.id);
      }
    }

    /** Topmost element under a world point at the current time. */
    function hitTest(p: Vec2, pr: TacticalProjection): TacticalElement | null {
      const t = props.getTime();
      const padWorld = Math.max(6, store.style.value.width) * pr.worldPerPx;
      const tweens = planTweensOf(store.elements.value);
      const nexts = planNextOf(store.elements.value);
      for (let i = store.elements.value.length - 1; i >= 0; i--) {
        const el = store.elements.value[i];
        if (!ownsUnitAt(el, t, nexts)) continue;
        if (hitTestElement(el, p, padWorld, t, tweens.get(el.id))) return el;
      }
      return null;
    }

    // ── Text editing ─────────────────────────────────────────────────────
    function openTextEditor(at: Vec2, id: string | null): void {
      const el = id ? store.elements.value.find((x) => x.id === id) : null;
      textEdit.value = {
        at,
        value: el?.kind === "text" ? el.text : el?.kind === "marker" ? el.label : "",
        id,
      };
      requestAnimationFrame(() => inputRef.value?.focus());
    }

    function commitTextEdit(): void {
      const ed = textEdit.value;
      textEdit.value = null;
      if (!ed) return;
      const value = ed.value.trim();
      const el = ed.id ? store.elements.value.find((x) => x.id === ed.id) : null;
      if (el && el.kind === "text") {
        if (!value) {
          store.removeElement(el.id);
        } else if (value !== el.text) {
          store.pushHistory();
          store.replaceElement(el.id, { ...el, text: value });
        }
      } else if (el && el.kind === "marker") {
        if (value !== el.label) {
          store.pushHistory();
          store.replaceElement(el.id, { ...el, label: value });
        }
      } else if (value) {
        store.commit(commitText(ed.at, value, store.style.value.color, anchorT0()));
      }
    }

    function onTextInputKeydown(e: KeyboardEvent): void {
      e.stopPropagation();
      if (e.key === "Enter") commitTextEdit();
      else if (e.key === "Escape") {
        textEdit.value = null;
      }
    }

    // ── Keyboard shortcuts ───────────────────────────────────────────────
    const TOOL_KEYS: Record<string, string> = {
      v: "select",
      p: "pen",
      l: "line",
      a: "arrow",
      r: "rect",
      o: "ellipse",
      t: "text",
      h: "markerShip",
      i: "markerPlane",
      m: "markerRoute",
      g: "pinPath",
      e: "eraser",
    };

    /** Any hikari modal/frame stacked above the map — while one is open the
     *  board's shortcuts (tool letters, [ ] seeks, Ctrl+Z) must stay dead
     *  instead of acting on an invisible surface. */
    function otherModalOpen(): boolean {
      return document.querySelector(".hk-modal-content") != null;
    }

    function onKeydown(e: KeyboardEvent): void {
      if (!props.editMode) return;
      if (otherModalOpen()) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      // The capture-phase listener sees keys from ANY focused input — the
      // board's own text editor, the timeline's rename box, dock selects.
      // They own Escape/Enter themselves; acting here as well would e.g.
      // cancel the selection while merely closing a rename.
      if (typing && (e.key === "Escape" || e.key === "Enter")) return;
      if (e.key === "Escape") {
        if (aiming.value) {
          aiming.value = null;
          return;
        }
        if (drag.value) {
          cancelDrag();
          return;
        }
        if (regionMode.value || pendingRegion.value) {
          regionMode.value = false;
          pendingRegion.value = null;
          return;
        }
        if (presentMode.value) {
          exitPresentMode();
          return;
        }
        store.selectedId.value = null;
        return;
      }
      if (typing) return;
      // Space = temporary hand tool (hold to pan, release to restore) — but
      // never steal it from a focused button/select (keyboard activation).
      if (e.key === " ") {
        const tag = target?.tagName;
        if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return;
        e.preventDefault();
        spacePanning.value = true;
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "z") {
          e.preventDefault();
          if (e.shiftKey) store.redo();
          else store.undo();
        } else if (key === "y") {
          e.preventDefault();
          store.redo();
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (store.selectedId.value) {
          e.preventDefault();
          store.removeElement(store.selectedId.value);
        }
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const tool = TOOL_KEYS[e.key.toLowerCase()];
        if (tool) {
          // The plan board has no replay to pin a path from.
          if (props.planMode && tool === "pinPath") return;
          store.tool.value = tool as typeof store.tool.value;
          regionMode.value = false;
          return;
        }
        if (e.key === "[") {
          e.preventDefault();
          stepPrev();
        } else if (e.key === "]") {
          e.preventDefault();
          stepNext();
        }
      }
    }

    // ── Exports ──────────────────────────────────────────────────────────
    function defaultName(ext: string): string {
      const clock = formatBattleClock(props.getTime()).replace("T+", "").replace(":", "");
      return `wowsp-tactical-${props.mapTag || "map"}-${clock}.${ext}`;
    }

    async function runImageExport(crop: LogicalRect | null): Promise<void> {
      const base = props.baseCanvas();
      if (!base || busy.value) return;
      busy.value = true;
      try {
        const s = exportSettings.value;
        // The canvases hold the view-space composition rotated by the map
        // frame (renderNow), so a crop spins into screen space before it
        // slices pixels. Null = full view: the square maps onto itself at
        // every 90° step, nothing to transform.
        const screen = crop ? screenCropRect(crop) : null;
        const native = base.width / TACTICAL_SIZE;
        const edgeW = screen ? screen.w : TACTICAL_SIZE;
        const edgeH = screen ? screen.h : TACTICAL_SIZE;
        // Repaint the overlay without the crop mask so exports stay clean.
        renderNow(null);
        const canvas = composeExportCanvas(
          base,
          canvasRef.value,
          { format: s.format, scale: s.scale, crop: screen, timestamp: s.timestamp },
          Math.round(edgeW * native * s.scale),
          Math.round(edgeH * native * s.scale),
          s.timestamp ? formatBattleClock(props.getTime()) : null,
          s.minimap ? props.overlayCanvas?.() ?? null : null,
        );
        const blob = await canvasToBlob(canvas, s.format === "webp" ? "image/webp" : "image/png");
        const saved = await saveExportBlob(blob, defaultName(s.format), "Image", s.format);
        if (saved) toast.info(i18nT("replay.tactical.toast.saved", { path: saved }));
        // Only a crop export consumes the crop — a full-view snapshot keeps
        // the pending region for further cropped exports.
        if (crop != null) pendingRegion.value = null;
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      } finally {
        busy.value = false;
      }
    }

    /** Compose one finished frame (base map + annotations + battle clock)
     *  onto an export ctx at `size`. Used by both the realtime recorder and
     *  the offline renderer — the battle time is passed explicitly so the
     *  offline path stamps the frame it just painted, not the live clock. */
    function composePaintedFrame(ctx: CanvasRenderingContext2D, size: number, t: number): void {
      const base = props.baseCanvas();
      if (!base) return;
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(base, 0, 0, base.width, base.height, 0, 0, size, size);
      const overlay = canvasRef.value;
      if (overlay) ctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, 0, 0, size, size);
      drawTimestampChip(ctx, size, formatBattleClock(t));
      const minimap = exportSettings.value.minimap ? props.overlayCanvas?.() : undefined;
      if (minimap) drawMinimapChip(ctx, size, size, minimap);
    }

    async function startRecording(): Promise<void> {
      if (!props.baseCanvas() || busy.value) return;
      if (!recorderSupported) {
        toast.error(i18nT("replay.tactical.record.unsupported"));
        return;
      }
      pendingRegion.value = null; // a crop box must not record into the take
      regionMode.value = false;
      cancelDrag();
      const rec = new TacticalRecorder(
        (ctx, size) => composePaintedFrame(ctx, size, props.getTime()),
        1280,
      );
      if (!rec.start()) {
        toast.error(i18nT("replay.tactical.record.unsupported"));
        return;
      }
      recorder = rec;
      autoPlayedOnRecord = !props.getPlaying();
      if (autoPlayedOnRecord) props.play();
      recording.value = true;
    }

    /** Stop + save a recorder take (shared by the manual stop button, the
     *  editMode toggle and component unmount — closing the overlay mid-take
     *  must not silently discard the video). */
    async function finalizeRecording(rec: TacticalRecorder): Promise<void> {
      recording.value = false;
      if (autoPlayedOnRecord && props.getPlaying()) props.pause();
      busy.value = true;
      try {
        const blob = await rec.stop();
        if (blob.size === 0) {
          toast.info(i18nT("replay.tactical.toast.empty"));
          return;
        }
        const saved = await saveExportBlob(blob, defaultName(rec.ext), "Video", rec.ext);
        if (saved) toast.info(i18nT("replay.tactical.toast.saved", { path: saved }));
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      } finally {
        busy.value = false;
      }
    }

    async function stopRecording(): Promise<void> {
      const rec = recorder;
      recorder = null;
      if (!rec) return;
      await finalizeRecording(rec);
    }

    // ── Presentation mode (step timeline) ────────────────────────────────
    const stepsSorted = computed(() => store.stepsSorted.value);
    /** Index of the last step at or before the playhead (-1 = before the
     *  first step). */
    const currentStepIndex = computed(() => {
      const t = props.getTime();
      let idx = -1;
      for (let i = 0; i < stepsSorted.value.length; i++) {
        if (stepsSorted.value[i].t <= t + 0.05) idx = i;
        else break;
      }
      return idx;
    });

    function goToStep(i: number): void {
      if (offlineRendering.value) return;
      // Manual navigation takes control from the auto-advance dwell.
      if (presentDwellTimer != null) {
        clearTimeout(presentDwellTimer);
        presentDwellTimer = null;
        if (presentMode.value) props.pause();
      }
      const s = stepsSorted.value[i];
      if (!s) return;
      props.seekTo(s.t);
      // Step camera ("运镜"): eased viewport tween to the captured view.
      if (s.view) props.viewApi.tweenTo(s.view);
    }
    function stepPrev(): void {
      goToStep(Math.max(0, currentStepIndex.value));
    }
    function stepNext(): void {
      goToStep(Math.min(stepsSorted.value.length - 1, currentStepIndex.value + 1));
    }
    function addStepHere(): void {
      if (offlineRendering.value) return;
      const ok = store.addStep(props.getTime(), props.viewApi.snapshot());
      if (!ok) toast.info(i18nT("replay.tactical.steps.duplicate"));
    }
    function removeStepById(id: string): void {
      store.removeStep(id);
    }

    function schedulePresentDwell(): void {
      if (presentDwellTimer != null) clearTimeout(presentDwellTimer);
      presentDwellTimer = setTimeout(() => {
        presentDwellTimer = null;
        if (!presentMode.value) return;
        // More steps ahead → keep playing toward the next one; otherwise the
        // show is over.
        const hasFurther = stepsSorted.value.some((s) => s.t > props.getTime() + 0.05);
        if (hasFurther) props.play();
        else exitPresentMode();
      }, 1400);
    }
    function enterPresentMode(): void {
      if (offlineRendering.value) return;
      if (stepsSorted.value.length === 0) {
        toast.info(i18nT("replay.tactical.steps.empty"));
        return;
      }
      presentMode.value = true;
      props.play();
    }
    function exitPresentMode(): void {
      if (!presentMode.value) return;
      presentMode.value = false;
      if (presentDwellTimer != null) {
        clearTimeout(presentDwellTimer);
        presentDwellTimer = null;
      }
      props.pause();
    }
    function togglePresent(): void {
      if (presentMode.value) exitPresentMode();
      else enterPresentMode();
    }

    // ── Offline (faster-than-realtime) video export ──────────────────────
    function cancelOfflineExport(): void {
      offlineCancel.cancelled = true;
    }

    async function runOfflineExport(): Promise<void> {
      const base = props.baseCanvas();
      const dur = props.getDuration();
      if (!base || dur <= 0 || busy.value || offlineRendering.value) return;
      // The offline render seeks the live clock frame by frame — it cannot
      // share the stage with a realtime recording or presentation playback.
      if (recording.value) {
        toast.info(i18nT("replay.tactical.record.recording"));
        return;
      }
      exitPresentMode();
      const s = exportSettings.value;
      const from = s.offlineFrom === "start" ? 0 : props.getTime();
      const times = frameTimes(from, dur, s.offlineFps);
      if (times.length < 2) {
        toast.info(i18nT("replay.tactical.toast.empty"));
        return;
      }
      props.pause();
      const resumeAt = props.getTime();
      offlineCancel.cancelled = false;
      offlineRendering.value = true;
      offlineProgress.value = { done: 0, total: times.length };
      busy.value = true;
      try {
        const result = await renderVideoOffline({
          fps: s.offlineFps,
          times,
          size: 1280,
          paintAt: (t, ctx, size) => {
            // Step the whole live 2D map (base + ships + caps + smoke +
            // planes) to t, repaint annotations, then compose one frame.
            props.seekTo(t);
            renderNow(null);
            composePaintedFrame(ctx, size, t);
          },
          onProgress: (done, total) => {
            offlineProgress.value = { done, total };
          },
          cancelToken: offlineCancel,
        });
        if (!result) {
          toast.error(i18nT("replay.tactical.record.unsupported"));
        } else if (result.cancelled && result.blob.size === 0) {
          // User cancelled before anything encoded — stay quiet.
        } else if (result.blob.size > 0) {
          const saved = await saveExportBlob(result.blob, defaultName(result.ext), "Video", result.ext);
          if (saved) toast.info(i18nT("replay.tactical.toast.saved", { path: saved }));
        } else {
          toast.info(i18nT("replay.tactical.toast.empty"));
        }
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      } finally {
        offlineRendering.value = false;
        busy.value = false;
        props.seekTo(resumeAt);
      }
    }

    // ── Toolbar actions ──────────────────────────────────────────────────
    function beginRegionMode(): void {
      pendingRegion.value = null;
      regionMode.value = true;
      store.tool.value = "select";
    }

    function toggleRecording(): void {
      if (recording.value) void stopRecording();
      else void startRecording();
    }

    // Leaving edit mode hides the toolbar (the only stop button) — end any
    // in-flight gesture and recording instead of stranding it.
    watch(
      () => props.editMode,
      (on) => {
        if (on) return;
        cancelDrag();
        regionMode.value = false;
        pendingRegion.value = null;
        if (textEdit.value) commitTextEdit();
        exitPresentMode();
        if (recorder) {
          const rec = recorder;
          recorder = null;
          void finalizeRecording(rec);
        }
      },
    );

    // ── Annotation-doc JSON import / export ──────────────────────────────
    function exportDocJson(): void {
      const json = serializeDoc({
        version: 1,
        elements: store.elements.value,
        steps: store.steps.value,
      });
      const blob = new Blob([json], { type: "application/json" });
      void saveExportBlob(blob, `wowsp-tactical-${props.mapTag || "map"}.json`, "JSON", "json").then(
        (saved) => {
          if (saved) toast.info(i18nT("replay.tactical.toast.saved", { path: saved }));
        },
      );
    }

    const jsonInput = ref<HTMLInputElement | null>(null);
    function importDocJson(e: Event): void {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      void file
        .text()
        .then((text) => {
          const doc = parseDoc(text);
          if (!doc) {
            toast.error(i18nT("replay.tactical.toast.importBad"));
            return;
          }
          store.applyDoc(doc);
          toast.info(i18nT("replay.tactical.toast.imported"));
        })
        .catch(() => toast.error(i18nT("replay.tactical.toast.importBad")));
    }

    // The app-wide context menu (HkContextMenuProvider at the app root):
    // right-click / long-press / menu-key all funnel through the same
    // hikari menu machinery the rest of the app will adopt.
    let unbindCtx: (() => void) | null = null;
    onMounted(() => {
      raf = requestAnimationFrame(frame);
      window.addEventListener("keydown", onKeydown, true);
      window.addEventListener("keyup", onKeyUp, true);
      if (canvasRef.value) {
        unbindCtx = bindContextMenu(canvasRef.value, ctxMenu, (point) =>
          buildContextMenu(point.x, point.y),
        );
      }
    });
    onBeforeUnmount(() => {
      cancelAnimationFrame(raf);
      unbindCtx?.();
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      exitPresentMode();
      // Stop the offline render at the next frame boundary; whatever was
      // encoded so far still gets saved by the finally-block in the runner.
      offlineCancel.cancelled = true;
      // Unmounting (overlay closed / replay switched) mid-take still saves.
      if (recorder) {
        const rec = recorder;
        recorder = null;
        void finalizeRecording(rec);
      }
    });

    function onKeyUp(e: KeyboardEvent): void {
      if (e.key === " ") spacePanning.value = false;
    }

    const cursorClass = computed(() => {
      if (aiming.value) return "tac-layer__canvas--cross";
      if (drag.value?.kind === "pan" || spacePanning.value || !props.editMode) {
        return "tac-layer__canvas--grab";
      }
      if (store.tool.value === "hand") return "tac-layer__canvas--grab";
      if (store.tool.value === "eraser") return "tac-layer__canvas--point";
      if (regionMode.value) return "tac-layer__canvas--cross";
      switch (store.tool.value) {
        case "pen":
        case "line":
        case "arrow":
        case "rect":
        case "ellipse":
        case "markerShip":
        case "markerPlane":
        case "markerRoute":
        case "text":
          return "tac-layer__canvas--cross";
        case "pinPath":
          return "tac-layer__canvas--point";
        default:
          return "";
      }
    });

    return () => {
      const edit = props.editMode;
      return (
        <div class="tac-layer">
          <canvas
            ref={canvasRef}
            class={["tac-layer__canvas", cursorClass.value]}
            onPointerdown={onPointerDown}
            onPointermove={onPointerMove}
            onPointerup={onPointerUp}
            onWheel={onWheel}
            onPointercancel={(e: PointerEvent) => {
              // Lost pointer capture mid-gesture — drop the stroke, don't
              // leave a frozen preview on screen.
              e.stopPropagation();
              touchPts.delete(e.pointerId);
              pinch = null; // re-baseline even if a finger pair survives a swap
              cancelDrag();
            }}
            onPointerleave={(e: PointerEvent) => {
              touchPts.delete(e.pointerId);
              pinch = null;
              hoverLeg.value = null;
              if (drag.value && e.buttons === 0) {
                cancelDrag();
                e.stopPropagation();
              }
            }}
            onClick={(e: MouseEvent) => e.stopPropagation()}
            onDblclick={onDoubleClick}
            onContextmenu={(e: MouseEvent) => {
              e.stopPropagation();
              // While aiming a launch, the right button cancels it (the
              // context menu stays closed — buildContextMenu sees the aim
              // as no-man's-land only after this clears it).
              if (aiming.value) {
                e.preventDefault();
                aiming.value = null;
              }
            }}
          />
          {textEdit.value ? (
            <input
              ref={inputRef}
              class="tac-layer__text-input"
              value={textEdit.value.value}
              placeholder={i18nT("replay.tactical.text.placeholder")}
              onInput={(e: Event) => {
                if (textEdit.value) textEdit.value.value = (e.target as HTMLInputElement).value;
              }}
              onKeydown={onTextInputKeydown}
              onBlur={commitTextEdit}
            />
          ) : null}
          {recording.value ? (
            <div class="tac-layer__rec-chip" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <span class="tac-layer__rec-dot" />
              {i18nT("replay.tactical.record.recording")}
            </div>
          ) : null}
          {offlineRendering.value ? (
            <div class="tac-layer__rec-chip" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <span class="tac-layer__rec-dot" />
              {i18nT("replay.tactical.export.offlineRunning")}
              <b class="tac-layer__rec-count">
                {offlineProgress.value.done}/{offlineProgress.value.total}
              </b>
              <button class="tac-layer__rec-cancel" onClick={cancelOfflineExport}>
                {i18nT("replay.tactical.export.cancel")}
              </button>
            </div>
          ) : null}
          {regionMode.value ? (
            <div class="tac-layer__hint" onClick={(e: MouseEvent) => e.stopPropagation()}>
              {i18nT("replay.tactical.hint.region")}
            </div>
          ) : null}
          {edit ? (
            <Teleport defer to={props.dockSelector}>
            <div
              class={["tac-dock", offlineRendering.value ? "tac-dock--busy" : ""]}
              onClick={(e: MouseEvent) => e.stopPropagation()}
            >
              <TacticalToolbar
                store={store}
                plan={props.planMode}
                lineupMode={lineupActive.value}
                mirror={props.mirror}
                onToggleMirror={props.onToggleMirror}
                showCaps={capsVisible.value}
                onToggleCaps={() => (capsVisible.value = !capsVisible.value)}
                regionActive={regionMode.value}
                pendingRegion={pendingRegion.value != null}
                recording={recording.value}
                recordingSupported={recorderSupported}
                busy={busy.value}
                exportSettings={exportSettings.value}
                hasSelection={store.selected.value != null}
                viewZoom={{
                  percent: zoomPercent.value,
                  canIn: zoomPercent.value < TACTICAL_MAX_SCALE * 100,
                  canOut: zoomPercent.value > 100,
                }}
                actions={{
                  exportFull: () => void runImageExport(null),
                  exportRegion: () => {
                    if (pendingRegion.value) void runImageExport(pendingRegion.value);
                    else beginRegionMode();
                  },
                  recordToggle: toggleRecording,
                  offlineExport: () => void runOfflineExport(),
                  exportJson: exportDocJson,
                  importJson: () => jsonInput.value?.click(),
                  resetView: () => props.viewApi.reset(),
                  zoomIn: () => zoomByToolbar(1.22),
                  zoomOut: () => zoomByToolbar(1 / 1.22),
                }}
              />
              <Timeline
                getTime={props.getTime}
                getDuration={props.getDuration}
                getPlaying={props.getPlaying}
                play={() => { if (!props.getPlaying()) props.play(); }}
                pause={() => { if (props.getPlaying()) props.pause(); }}
                seekTo={props.seekTo}
                actions={props.actions}
                labelOf={props.labelOf}
                steps={stepsSorted.value}
                currentStepIndex={currentStepIndex.value}
                userMarkers={userMarkers.value}
                tracks={planTracks.value}
                tall={props.planMode}
                presentMode={presentMode.value}
                addStep={addStepHere}
                stepPrev={stepPrev}
                stepNext={stepNext}
                togglePresent={togglePresent}
                goToStep={goToStep}
                removeStep={removeStepById}
                removeUserMarker={removeUserMarkerById}
                onRenameUnit={renameUnit}
                markerOf={markerOf}
                onEditMarker={editMarker}
                viewLabelOf={viewLabelOf}
              />
            </div>
            </Teleport>
          ) : null}
          <input
            ref={jsonInput}
            class="tac-layer__file-input"
            type="file"
            accept=".json,application/json"
            onChange={importDocJson}
          />
        </div>
      );
    };
  },
});

// Re-export for the toolbar's prop typing.
export type { TacticalStore } from "./useTactical";
