/**
 * Standalone tactical plan stage: the replay review's board facilities
 * (TacticalBoard + toolbar + timeline) hosted over a bare map instead of a
 * replay. Used by the tactics-analysis page, and the place every future
 * plan-mode change belongs — the replay host (HolographicMap) and this one
 * share the same components, styles and document model, differing only in
 * what feeds the clock and the base canvas:
 *
 *   replay host  → battle clock, ships/shells/caps painted onto the art
 *   plan stage   → a fixed 20-minute planning clock, minimap art only
 *
 * The map art is painted onto the SAME canvas the annotation layer exports
 * from, so image/video export and recording keep working on a plan.
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { resolveMapMinimapUrl, loadMapBounds, type MapBounds } from "../modelLoader";
import { HMinimap } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import TacticalBoard from "./TacticalBoard";
import { TACTICAL_SIZE, viewWindow, type TacticalView } from "./render";
import { MAP_GRID_COLUMNS, gridLabelLayoutForView } from "./mapGrid";
import { TACTICAL_MAX_SCALE } from "./geometry";
import "./PlanStage.scss";

/** A plan is always a full 20-minute battle — the timeline's "fully loaded"
 *  default, independent of how much of it has been annotated. */
export const PLAN_DURATION_S = 20 * 60;

/** Teleport target for the board's toolbar + timeline dock. */
export const PLAN_DOCK_ID = "tactics-tac-dock";

export default defineComponent({
  name: "TacticalPlanStage",
  props: {
    /** Space id the plan is authored for (also the doc's storage key). */
    spaceId: { type: String, required: true },
    /** Display name, used for export filenames. */
    mapName: { type: String, default: "" },
    durationS: { type: Number, default: PLAN_DURATION_S },
  },
  setup(props) {
    const artCanvas = ref<HTMLCanvasElement | null>(null);
    const stageRef = ref<HTMLDivElement | null>(null);

    // ── Map art + world bounds ───────────────────────────────────────────
    let artImage: HTMLImageElement | null = null;
    const fullBounds = ref<MapBounds | null>(null);
    const boundsReady = ref(false);
    /** Minimap art URL (the overview card's background); null until loaded. */
    const mapArtUrl = ref<string | null>(null);
    /** Cancels stale loads when the selected map switches mid-flight. */
    let loadEpoch = 0;
    const dirty = ref(true);

    function loadMap() {
      const epoch = ++loadEpoch;
      artImage = null;
      fullBounds.value = null;
      boundsReady.value = false;
      mapArtUrl.value = null;
      const url = resolveMapMinimapUrl(props.spaceId);
      if (url) {
        mapArtUrl.value = url;
        const img = new Image();
        img.onload = () => {
          if (epoch !== loadEpoch) return;
          artImage = img;
          dirty.value = true;
        };
        img.src = url;
      }
      void loadMapBounds().then((all) => {
        if (epoch !== loadEpoch) return;
        const key = props.spaceId.replace(/^spaces\//, "");
        fullBounds.value =
          all.get(key) ??
          all.get(key.toLowerCase()) ??
          [...all.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] ??
          null;
        boundsReady.value = true;
        dirty.value = true;
      });
    }

    // ── Viewport (pan / zoom / camera tweens). Same window math as the
    //    replay host, so annotations and terrain can never drift apart. ───
    const view = ref<TacticalView>({ cx: 0, cz: 0, scale: 1 });
    let viewTween: {
      from: TacticalView;
      to: TacticalView;
      startedAt: number;
      durMs: number;
    } | null = null;

    function viewBounds(full: MapBounds): MapBounds {
      return viewWindow(view.value, full);
    }
    function tacticalBounds(): MapBounds | null {
      const full = fullBounds.value;
      return full ? viewBounds(full) : null;
    }
    /** Advance an in-flight camera tween; true while it moved this frame. */
    function advanceViewTween(): boolean {
      const tw = viewTween;
      if (!tw) return false;
      const p = Math.min(1, (performance.now() - tw.startedAt) / tw.durMs);
      if (p >= 1) {
        // Land exactly on the captured view (no 1-ulp float drift).
        view.value = { ...tw.to };
        viewTween = null;
      } else {
        const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
        view.value = {
          cx: tw.from.cx + (tw.to.cx - tw.from.cx) * e,
          cz: tw.from.cz + (tw.to.cz - tw.from.cz) * e,
          scale: tw.from.scale + (tw.to.scale - tw.from.scale) * e,
        };
      }
      return true;
    }

    /** Viewport handle handed to the tactical board (pan/zoom/wheel/tweens). */
    const viewApi = {
      snapshot(): TacticalView {
        const full = fullBounds.value ?? { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
        const v = viewBounds(full);
        return { cx: (v.minX + v.maxX) / 2, cz: (v.minZ + v.maxZ) / 2, scale: view.value.scale };
      },
      zoomAt(lx: number, ly: number, factor: number): void {
        viewTween = null;
        const full = fullBounds.value;
        if (!full) return;
        const vb = viewBounds(full);
        // Resync the raw centre to the effective clamped one first, so the
        // cursor anchor cannot carry drift from an over-pan the clamp ate.
        const s0 = view.value.scale;
        const cx = (vb.minX + vb.maxX) / 2;
        const cz = (vb.minZ + vb.maxZ) / 2;
        const wx = vb.minX + (lx / TACTICAL_SIZE) * (vb.maxX - vb.minX);
        const wz = vb.maxZ - (ly / TACTICAL_SIZE) * (vb.maxZ - vb.minZ);
        const s1 = Math.min(TACTICAL_MAX_SCALE, Math.max(1, s0 * factor));
        if (s1 === s0) {
          view.value = { cx, cz, scale: s0 };
          return;
        }
        // Keep the world point under the cursor at the same logical px: the
        // window shrinks around the cursor, so the centre moves toward it by
        // the zoom ratio.
        view.value = {
          scale: s1,
          cx: wx - (wx - cx) * (s0 / s1),
          cz: wz - (wz - cz) * (s0 / s1),
        };
      },
      panByLogical(dxL: number, dyL: number): void {
        viewTween = null;
        const full = fullBounds.value;
        if (!full) return;
        const vb = viewBounds(full);
        const wxPerL = (vb.maxX - vb.minX) / TACTICAL_SIZE;
        const wzPerL = (vb.maxZ - vb.minZ) / TACTICAL_SIZE;
        view.value = {
          scale: view.value.scale,
          cx: (vb.minX + vb.maxX) / 2 - dxL * wxPerL,
          cz: (vb.minZ + vb.maxZ) / 2 + dyL * wzPerL,
        };
      },
      reset(): void {
        viewTween = null;
        view.value = { cx: 0, cz: 0, scale: 1 };
      },
      /** Eased camera move to a captured view (presentation "运镜"). */
      tweenTo(target: TacticalView, durMs = 450): void {
        viewTween = {
          from: viewApi.snapshot(),
          to: {
            cx: target.cx,
            cz: target.cz,
            scale: Math.min(TACTICAL_MAX_SCALE, Math.max(1, target.scale)),
          },
          startedAt: performance.now(),
          durMs: Math.max(60, durMs),
        };
      },
    };

    // ── Overview card (hikari HMinimap): full-map art with the view window
    //    boxed + a zoom bar, so a zoomed-in author always knows where on the
    //    map they are looking. HMinimap speaks translate(panX,panY)+scale
    //    over its content rect; the props below express the plan's world
    //    camera in NORMALISED art space (the unit square), where the window's
    //    normalised size is exactly 1/scale — hence viewportWidth/Height 1. ─
    const minimap = computed(() => {
      const full = fullBounds.value;
      if (!full || !mapArtUrl.value) return null;
      const vb = viewBounds(full);
      const zoom = view.value.scale;
      const w = full.maxX - full.minX || 1;
      const h = full.maxZ - full.minZ || 1;
      return {
        imageSrc: mapArtUrl.value,
        zoom,
        panX: (-(vb.minX - full.minX) / w) * zoom,
        panY: (-(full.maxZ - vb.maxZ) / h) * zoom,
        zoomPercent: Math.round(zoom * 100),
        canZoomIn: zoom < TACTICAL_MAX_SCALE - 1e-9,
        canZoomOut: zoom > 1 + 1e-9,
      };
    });

    /** Zoom-bar request (both the ± steps and the slider speak absolute
     *  percent rungs): re-aim the camera at that zoom, centre unchanged. */
    function setZoomPercent(percent: number): void {
      const full = fullBounds.value;
      if (!full) return;
      const vb = viewBounds(full);
      viewTween = null;
      view.value = {
        cx: (vb.minX + vb.maxX) / 2,
        cz: (vb.minZ + vb.maxZ) / 2,
        scale: Math.min(TACTICAL_MAX_SCALE, Math.max(1, percent / 100)),
      };
    }

    /** Overview drag: HMinimap emits pan deltas in content units × its zoom
     *  prop (dragging the box right shows terrain to the right); converted
     *  back through the same normalisation into world-space centre moves. */
    function panFromMinimap(dx: number, dy: number): void {
      const full = fullBounds.value;
      if (!full) return;
      const vb = viewBounds(full);
      const w = full.maxX - full.minX || 1;
      const h = full.maxZ - full.minZ || 1;
      viewTween = null;
      view.value = {
        cx: (vb.minX + vb.maxX) / 2 - (dx / view.value.scale) * w,
        cz: (vb.minZ + vb.maxZ) / 2 + (dy / view.value.scale) * h,
        scale: view.value.scale,
      };
    }

    // ── Planning clock: realtime playback over a fixed-length plan ───────
    const time = ref(0);
    const playing = ref(false);
    const duration = computed(() => Math.max(1, props.durationS));

    function seekTo(t: number): void {
      playing.value = false;
      time.value = Math.max(0, Math.min(duration.value, t));
    }
    function play(): void {
      if (time.value >= duration.value) time.value = 0;
      playing.value = true;
    }
    function pause(): void {
      playing.value = false;
    }

    // ── Base canvas: the map art through the view window plus the game's own
    //    A–J/1–10 grid. This is also the export/record base layer. ─────────
    function paintArt(): void {
      const cvs = artCanvas.value;
      const full = fullBounds.value;
      if (!cvs || !full) return;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const px = Math.max(1, Math.round(rect.width * dpr));
      if (cvs.width !== px || cvs.height !== px) {
        cvs.width = px;
        cvs.height = px;
      }
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(px / TACTICAL_SIZE, 0, 0, px / TACTICAL_SIZE, 0, 0);
      const vl = viewBounds(full);
      ctx.clearRect(0, 0, TACTICAL_SIZE, TACTICAL_SIZE);
      if (artImage) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        const img = artImage;
        const fullW = full.maxX - full.minX || 1;
        const fullH = full.maxZ - full.minZ || 1;
        // Crop the art to the view window (source rect in image px).
        const fx = ((vl.minX - full.minX) / fullW) * img.width;
        const fw = ((vl.maxX - vl.minX) / fullW) * img.width;
        const fy = ((full.maxZ - vl.maxZ) / fullH) * img.height;
        const fh = ((vl.maxZ - vl.minZ) / fullH) * img.height;
        ctx.drawImage(img, fx, fy, fw, fh, 0, 0, TACTICAL_SIZE, TACTICAL_SIZE);
      } else {
        ctx.fillStyle = "rgba(5, 8, 15, 0.9)";
        ctx.fillRect(0, 0, TACTICAL_SIZE, TACTICAL_SIZE);
      }
      // Grid: the game's own 10×10 columns over the FULL map rect, so it is
      // world-anchored under pan/zoom exactly like the replay 2D map.
      const gx = (x: number): number =>
        ((x - vl.minX) / (vl.maxX - vl.minX || 1)) * TACTICAL_SIZE;
      const gz = (z: number): number =>
        ((vl.maxZ - z) / (vl.maxZ - vl.minZ || 1)) * TACTICAL_SIZE;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < MAP_GRID_COLUMNS; i++) {
        const x = gx(full.minX + ((full.maxX - full.minX) * i) / MAP_GRID_COLUMNS);
        ctx.moveTo(x, 0);
        ctx.lineTo(x, TACTICAL_SIZE);
        const z = gz(full.minZ + ((full.maxZ - full.minZ) * i) / MAP_GRID_COLUMNS);
        ctx.moveTo(0, z);
        ctx.lineTo(TACTICAL_SIZE, z);
      }
      ctx.stroke();
      // Edge rulers (screen-frame, always upright) — the same A–J/1–10
      // coordinate language the replay's enlarged map shows. Each label is
      // projected through the view window like the grid lines it names, so
      // it rides its square under pan/zoom instead of sitting at a fixed
      // decile slot (which decoupled from the lines on first zoom).
      const colCenters: number[] = [];
      const rowCenters: number[] = [];
      for (let i = 0; i < MAP_GRID_COLUMNS; i++) {
        colCenters.push(
          gx(full.minX + ((full.maxX - full.minX) * (i + 0.5)) / MAP_GRID_COLUMNS),
        );
        // Row 1 is the NORTHERNMOST band (+worldZ is up), so count the row
        // centres off maxZ — minZ-first would mirror 1–10 onto the south.
        rowCenters.push(
          gz(full.maxZ - ((full.maxZ - full.minZ) * (i + 0.5)) / MAP_GRID_COLUMNS),
        );
      }
      const layout = gridLabelLayoutForView(0, TACTICAL_SIZE, colCenters, rowCenters);
      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const l of layout.top) {
        // Clamped = its square is off-canvas (deep zoom); it names the
        // nearest square THAT way, so it steps back visually.
        ctx.fillStyle = l.clamped ? "rgba(203, 213, 225, 0.38)" : "rgba(203, 213, 225, 0.72)";
        ctx.fillText(l.text, l.x, 3);
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const l of layout.left) {
        ctx.fillStyle = l.clamped ? "rgba(203, 213, 225, 0.38)" : "rgba(203, 213, 225, 0.72)";
        ctx.fillText(l.text, 4, l.y);
      }
      ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
      ctx.strokeRect(0.5, 0.5, TACTICAL_SIZE - 1, TACTICAL_SIZE - 1);
    }

    // ── Frame loop: advance the plan clock, tween the camera, repaint the
    //    art only when one of them actually changed. ─────────────────────
    let raf = 0;
    let last = 0;
    let lastDpr = 0;
    function frame(now: number): void {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
      last = now;
      if (playing.value) {
        const next = time.value + dt;
        if (next >= duration.value) {
          time.value = duration.value;
          playing.value = false;
        } else {
          time.value = next;
        }
      }
      if (advanceViewTween()) dirty.value = true;
      // The backing store is sized in DEVICE px: dragging the window onto a
      // different-DPR monitor changes no CSS size, so the art would stay at
      // the old resolution unless the ratio itself invalidates the paint.
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      if (dpr !== lastDpr) {
        lastDpr = dpr;
        dirty.value = true;
      }
      if (dirty.value) {
        dirty.value = false;
        paintArt();
      }
    }

    let ro: ResizeObserver | null = null;
    onMounted(() => {
      loadMap();
      raf = requestAnimationFrame(frame);
      if (stageRef.value) {
        ro = new ResizeObserver(() => {
          dirty.value = true;
        });
        ro.observe(stageRef.value);
      }
    });
    onBeforeUnmount(() => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    });
    watch(
      () => props.spaceId,
      () => {
        loadMap();
        view.value = { cx: 0, cz: 0, scale: 1 };
        time.value = 0;
        playing.value = false;
        dirty.value = true;
      },
    );
    watch(
      view,
      () => {
        dirty.value = true;
      },
      { deep: true },
    );

    /** The clock closure shared by the dock and the board, so the two can
     *  never disagree about "now". */
    const boardProps = {
      replayPath: computed(() => `tactics:${props.spaceId}`),
      getTime: () => time.value,
      getDuration: () => duration.value,
      getPlaying: () => playing.value,
      play,
      pause,
      seekTo,
    };

    return () => (
      <div class="plan-stage">
        {boundsReady.value && !fullBounds.value ? (
          // Art without world bounds (a space the bounds extractor has no row
          // for): there is no rect to project actions onto.
          <div class="plan-stage__notice">{i18nT("tactics.plan.noBounds")}</div>
        ) : (
          <>
            <div class="plan-stage__viewport">
              <div ref={stageRef} class="plan-stage__stage">
                <canvas ref={artCanvas} class="plan-stage__art" />
                <TacticalBoard
                  replayPath={boardProps.replayPath.value}
                  mapTag={props.mapName || props.spaceId}
                  editMode
                  planMode
                  dockSelector={`#${PLAN_DOCK_ID}`}
                  getBounds={tacticalBounds}
                  getTime={boardProps.getTime}
                  getDuration={boardProps.getDuration}
                  getPlaying={boardProps.getPlaying}
                  play={boardProps.play}
                  pause={boardProps.pause}
                  seekTo={boardProps.seekTo}
                  viewApi={viewApi}
                  // A plan has no replay behind it: nothing to pin, nothing to
                  // pick, no trajectories to draw.
                  trajectories={() => []}
                  actions={[]}
                  pickShipAt={() => null}
                  baseCanvas={() => artCanvas.value}
                />
                {minimap.value && (
                  <HMinimap
                    class="plan-stage__minimap"
                    imageSrc={minimap.value.imageSrc}
                    imageBounds={{ x: 0, y: 0, w: 1, h: 1 }}
                    contentBounds={{ x: 0, y: 0, w: 1, h: 1 }}
                    zoom={minimap.value.zoom}
                    panX={minimap.value.panX}
                    panY={minimap.value.panY}
                    viewportWidth={1}
                    viewportHeight={1}
                    zoomPercent={minimap.value.zoomPercent}
                    zoomStepPercent={22}
                    minZoomPercent={100}
                    maxZoomPercent={1200}
                    canZoomIn={minimap.value.canZoomIn}
                    canZoomOut={minimap.value.canZoomOut}
                    showReset
                    onZoomTo={setZoomPercent}
                    onReset={() => viewApi.reset()}
                    onPanDelta={panFromMinimap}
                  />
                )}
              </div>
            </div>
            <div class="plan-stage__dock" id={PLAN_DOCK_ID} />
          </>
        )}
      </div>
    );
  },
});
