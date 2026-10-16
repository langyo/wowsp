/**
 * Plan-stage overview panel: the "where am I" instrument for the tactics
 * page's right flank (and the in-stage corner card on narrow windows).
 *
 * HkMinimap letterboxes a square map inside its fixed 160×110 card — the
 * art rendered small with dead margins and no room for battle marks — so
 * the plan board owns its overview instead: a full-bleed square canvas
 * painting the map art, the battle mode's capture points, the live unit
 * poses (hulled green/red) and the current view window, plus a compact
 * zoom/pan bar. Drag the map to pan; the bar steps the zoom and resets.
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import { HkIconButton } from "@celestia-island/hikari";
import { Maximize2, ZoomIn, ZoomOut } from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import type { MapBounds } from "../modelLoader";
import { MAP_GRID_COLUMNS } from "./mapGrid";
import type { CapSpec } from "./modes";
import "./OverviewPanel.scss";

export interface OverviewHandle {
  /** Map art URL (the same asset the stage paints). */
  artUrl: string | null;
  /** World bounds of the full map. */
  full: MapBounds;
  /** Current view window (world rect). */
  view: MapBounds;
  /** Capture points of the battle mode (world coords). */
  caps: CapSpec[];
  /** Live unit poses at the playhead (world coords + team). */
  poses: { x: number; z: number; team?: "ally" | "enemy"; color: string }[];
  /** Battle clock, for appearT-gated cap ghosts. */
  time: number;
}

export default defineComponent({
  name: "TacticalOverviewPanel",
  props: {
    /** Reactive snapshot getter — the host re-evaluates it every frame it
     *  repaints; the panel draws whatever it returns. */
    snapshot: {
      type: Function as PropType<() => OverviewHandle | null>,
      required: true,
    },
    onZoomStep: { type: Function as PropType<(factor: number) => void>, required: true },
    onZoomTo: { type: Function as PropType<(percent: number) => void>, required: true },
    onReset: { type: Function as PropType<() => void>, required: true },
    onPanBy: {
      type: Function as PropType<(fracDX: number, fracDY: number) => void>,
      required: true,
    },
  },
  setup(props) {
    const cvsRef = ref<HTMLCanvasElement | null>(null);
    const artImg = ref<HTMLImageElement | null>(null);
    const artSrc = ref<string | null>(null);
    const percent = ref(100);

    // (Re)load the art when its URL changes; redraw is RAF-driven anyway.
    const snap = computed(() => props.snapshot());
    watch(snap, (s) => {
      const url = s?.artUrl ?? null;
      if (url === artSrc.value) return;
      artSrc.value = url;
      if (!url) {
        artImg.value = null;
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (artSrc.value === url) artImg.value = img;
      };
      img.src = url;
    }, { immediate: true });

    // ── Painting ─────────────────────────────────────────────────────────
    const PANEL = 512; // logical drawing space (DPR-scaled on the canvas)
    let raf = 0;
    let lastKey = "";

    function frame(): void {
      raf = requestAnimationFrame(frame);
      const s = props.snapshot();
      const cvs = cvsRef.value;
      if (!cvs || !s) return;
      const zoom = Math.round(
        ((s.full.maxX - s.full.minX) / (s.view.maxX - s.view.minX || 1)) * 100,
      );
      if (zoom !== percent.value) percent.value = zoom;
      // Cheap change detection: art identity + window + marks + clock second.
      const key = [
        s.artUrl,
        s.view.minX.toFixed(1),
        s.view.maxX.toFixed(1),
        s.view.minZ.toFixed(1),
        s.view.maxZ.toFixed(1),
        s.caps.length,
        s.poses.length,
        Math.floor(s.time * 2),
        artImg.value ? "1" : "0",
      ].join("|");
      if (key === lastKey) return;
      lastKey = key;

      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const px = Math.round(rect.width * dpr);
      if (cvs.width !== px || cvs.height !== px) {
        cvs.width = px;
        cvs.height = px;
      }
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(px / PANEL, 0, 0, px / PANEL, 0, 0);
      ctx.clearRect(0, 0, PANEL, PANEL);
      ctx.fillStyle = "rgba(5, 8, 15, 0.92)";
      ctx.fillRect(0, 0, PANEL, PANEL);
      const img = artImg.value;
      if (img) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, PANEL, PANEL);
      }

      // The game's own 10×10 grid, so the card speaks the same A–J/1–10
      // coordinate language as the stage: the panel always shows the WHOLE
      // map, so the lines sit at fixed deciles of the square (no labels —
      // they would be illegible at this size).
      ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < MAP_GRID_COLUMNS; i++) {
        const p = (i / MAP_GRID_COLUMNS) * PANEL;
        ctx.moveTo(p, 0);
        ctx.lineTo(p, PANEL);
        ctx.moveTo(0, p);
        ctx.lineTo(PANEL, p);
      }
      ctx.stroke();

      // World fraction helpers (the art fills the full square).
      const fx = (x: number): number => ((x - s.full.minX) / (s.full.maxX - s.full.minX || 1)) * PANEL;
      const fz = (z: number): number => ((s.full.maxZ - z) / (s.full.maxZ - s.full.minZ || 1)) * PANEL;
      const fr = (r: number): number =>
        (r / Math.max(s.full.maxX - s.full.minX, s.full.maxZ - s.full.minZ || 1)) * PANEL;

      // Capture points.
      for (const cap of s.caps) {
        const future = (cap.appearT ?? 0) > s.time;
        ctx.globalAlpha = future ? 0.25 : 0.85;
        ctx.strokeStyle =
          cap.team === "ally" ? "#4ade80" : cap.team === "enemy" ? "#f43f5e" : "rgba(226,232,240,0.9)";
        ctx.lineWidth = 1.4;
        ctx.setLineDash(future ? [4, 4] : []);
        ctx.beginPath();
        ctx.arc(fx(cap.at.x), fz(cap.at.z), Math.max(2, fr(cap.radius)), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = "700 12px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(cap.letter, fx(cap.at.x), fz(cap.at.z));
      }

      // Unit poses: green/red dots (enemy gets a hollow centre for the
      // colour-blind read), a short heading tick.
      for (const p of s.poses) {
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = p.team === "ally" ? "#4ade80" : p.team === "enemy" ? "#f43f5e" : p.color;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.beginPath();
        ctx.arc(fx(p.x), fz(p.z), 3, 0, Math.PI * 2);
        ctx.fill();
        if (p.team === "enemy") {
          ctx.fillStyle = "rgba(5,8,15,0.85)";
          ctx.beginPath();
          ctx.arc(fx(p.x), fz(p.z), 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // View window.
      const vb = s.view;
      const vx = fx(vb.minX);
      const vy = fz(vb.maxZ);
      const vw = fx(vb.maxX) - vx;
      const vh = fz(vb.minZ) - vy;
      ctx.strokeStyle = "rgba(0, 195, 255, 0.95)";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(vx + 1, vy + 1, Math.max(2, vw - 2), Math.max(2, vh - 2));
      ctx.setLineDash([]);
    }

    onMounted(() => {
      raf = requestAnimationFrame(frame);
    });
    onBeforeUnmount(() => cancelAnimationFrame(raf));

    // ── Drag-to-pan (content follows the pointer) ────────────────────────
    let drag: { x: number; y: number } | null = null;
    function onDown(e: PointerEvent): void {
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY };
    }
    function onMove(e: PointerEvent): void {
      if (!drag) return;
      e.stopPropagation();
      const cvs = cvsRef.value;
      if (!cvs) return;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return;
      const dx = (e.clientX - drag.x) / rect.width;
      const dy = (e.clientY - drag.y) / rect.height;
      drag = { x: e.clientX, y: e.clientY };
      props.onPanBy(dx, dy);
    }
    function onUp(): void {
      drag = null;
    }

    return () => (
      <div class="tac-overview" onClick={(e: MouseEvent) => e.stopPropagation()}>
        <canvas
          ref={cvsRef}
          class="tac-overview__canvas"
          onPointerdown={onDown}
          onPointermove={onMove}
          onPointerup={onUp}
          onPointercancel={onUp}
        />
        <div class="tac-overview__bar">
          <HkIconButton
            size={24}
            data-hint={i18nT("replay.tactical.view.zoomOut")}
            aria-label={i18nT("replay.tactical.view.zoomOut")}
            onClick={() => props.onZoomStep(1 / 1.22)}
          >
            <ZoomOut size={13} />
          </HkIconButton>
          <button
            type="button"
            class="tac-overview__pct"
            title={i18nT("replay.tactical.timeline.zoomFit")}
            onClick={() => props.onReset()}
          >
            {percent.value}%
          </button>
          <HkIconButton
            size={24}
            data-hint={i18nT("replay.tactical.view.zoomIn")}
            aria-label={i18nT("replay.tactical.view.zoomIn")}
            onClick={() => props.onZoomStep(1.22)}
          >
            <ZoomIn size={13} />
          </HkIconButton>
          <HkIconButton
            size={24}
            data-hint={i18nT("replay.tactical.view.reset")}
            aria-label={i18nT("replay.tactical.view.reset")}
            onClick={() => props.onReset()}
          >
            <Maximize2 size={13} />
          </HkIconButton>
        </div>
      </div>
    );
  },
});