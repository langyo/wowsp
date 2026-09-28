/**
 * Manual-locate picker layer — a full-cover sub-window INSIDE the main
 * window (rendered by the app shell; no dedicated Tauri window exists
 * anymore). Opened by the live-battle panel's "manual locate" button after
 * the backend gates pass (`startManualLocate`); the state itself lives in
 * the manualLocate store so a mid-pick roster update cannot unmount the
 * picker out from under the user.
 *
 * The background is the LAST frame the Tab detector itself analyzed (the
 * Rust capture cache, downscaled for transport). The detector's knowledge
 * of that frame is overlaid as GUIDES — the table rectangle, one
 * horizontal line per row, the team seam — and the drag box's edges snap
 * to them (toggleable from the toolbar; hiding the guides disables the
 * snapping). A suggested box (the detected table) is pre-drawn so a good
 * detection is one Enter away.
 *
 * The mapping is display-relative: a single factor `k` (CSS px per
 * physical px) is derived from the canvas element's actual on-screen box,
 * so the app window's own DPI NEVER enters the math — the window may sit
 * on any monitor regardless of the game monitor's scale factor. The
 * submitted box converts back through the same `k` into PHYSICAL px
 * relative to the game window origin (what `set_manual_roster_rect`
 * validates). Closing paths: Confirm (submit Ok), Cancel / Esc
 * (`cancelManualLocate` clears the backend flag), and the backend's
 * `wowsp://manual-locate-close` force-close push (game window gone /
 * overlay mode ended).
 *
 * Interaction contract (same as the picker window this layer replaces):
 *   - press + drag on the frame → draw the selection (dashed border, light
 *     wash, live W×H readout in physical game px);
 *   - release → the toolbar's Confirm arms; a box below the 32-physical-px
 *     minimum is a mis-click (reset + "too small" note);
 *   - Enter = confirm, Esc = cancel (always — Esc must never get stuck).
 */
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { Teleport } from "vue";
import { HkSpinner } from "@celestia-island/hikari";

import {
  api,
  type ManualLocateContext,
  type Rect,
} from "@/api";
import { t } from "@/i18n";
import { useManualLocateStore } from "@/stores/manualLocate";
import "./ManualLocateOverlay.scss";

/** One selection box, PHYSICAL game px (the layer converts through its own
 *  display factor `k` at the pointer-edge). */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Minimum selection size per axis in PHYSICAL px — mirrors the Rust-side
 *  `MANUAL_MIN_SIZE` gate in `set_manual_roster_rect` exactly, so a box
 *  this layer accepts can never be refused by the backend. */
const MIN_PHYSICAL = 32;

/** Snap distance in CSS px — a box edge within this of a guide line jumps
 *  onto it. The tolerance lives in screen space (converted to physical per
 *  the current `k`) so it feels immediate on any DPI. */
const SNAP_TOLERANCE_CSS = 10;

export default defineComponent({
  name: "ManualLocateOverlay",
  setup() {
    const manual = useManualLocateStore();

    // ── picker payload ───────────────────────────────────────────────────
    const loading = ref(false);
    const ctx = ref<ManualLocateContext | null>(null);
    const hasImage = computed(
      () =>
        !!ctx.value?.imageBase64 &&
        (ctx.value.physWidth ?? 0) > 0 &&
        (ctx.value.physHeight ?? 0) > 0,
    );
    const physW = computed(() => ctx.value?.physWidth || 1);
    const physH = computed(() => ctx.value?.physHeight || 1);
    const frameSrc = computed(() =>
      ctx.value?.imageBase64 ? `data:image/png;base64,${ctx.value.imageBase64}` : "",
    );

    // ── selection state (PHYSICAL px; conversions at the pointer edge) ──
    const box = ref<Box | null>(null);
    /** Drag origin in canvas CSS px, null while no drag is in progress. */
    let dragStart: { x: number; y: number } | null = null;
    /** CSS px per physical px — derived from the canvas's actual box (the
     *  app window's DPI never enters the math). */
    const cssPerPhys = ref(1);
    const guidesOn = ref(true);
    /** Guards a double confirm (double Enter / button + Enter race). */
    const submitting = ref(false);
    /** Toolbar note slot: a too-small flash or a submit error, in place of
     *  the default hint. Cleared by the next drag. */
    const note = ref<string | null>(null);
    let flashTimer: ReturnType<typeof setTimeout> | null = null;

    const stageEl = ref<HTMLElement | null>(null);
    const canvasEl = ref<HTMLElement | null>(null);

    // ── guides (physical px snap targets + drawn lines) ──────────────────
    const tableRect = computed<Rect | null>(() => ctx.value?.guides?.tableRect ?? null);
    const hGuides = computed<Set<number>>(() => {
      const s = new Set<number>(ctx.value?.guides?.rowLines ?? []);
      const tb = ctx.value?.guides?.tableRect;
      if (tb) {
        s.add(tb.y);
        s.add(tb.y + tb.height);
      }
      return s;
    });
    const vGuides = computed<Set<number>>(() => {
      const s = new Set<number>();
      const tb = ctx.value?.guides?.tableRect;
      if (tb) {
        s.add(tb.x);
        s.add(tb.x + tb.width);
      }
      if (ctx.value?.guides?.seamX != null) s.add(ctx.value.guides.seamX);
      return s;
    });

    /** Snap a physical-px box's edges onto the nearest guide lines. */
    function snap(b: Box): Box {
      if (!guidesOn.value) return b;
      const tol = SNAP_TOLERANCE_CSS / cssPerPhys.value;
      const snapAxis = (v: number, lines: Iterable<number>): number => {
        let best = v;
        let bestD = tol;
        for (const l of lines) {
          const d = Math.abs(v - l);
          if (d < bestD) {
            bestD = d;
            best = l;
          }
        }
        return best;
      };
      const x0 = snapAxis(b.x, vGuides.value);
      const x1 = snapAxis(b.x + b.w, vGuides.value);
      const y0 = snapAxis(b.y, hGuides.value);
      const y1 = snapAxis(b.y + b.h, hGuides.value);
      if (x1 - x0 <= 0 || y1 - y0 <= 0) return b; // snapped inside-out — keep raw
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /** Update the box from the current drag (origin + current pointer, both
     *  canvas CSS px); renders selection + live size. */
    function updateBox(origin: { x: number; y: number }, cur: { x: number; y: number }) {
      const k = cssPerPhys.value;
      const o = { x: origin.x / k, y: origin.y / k };
      const c = { x: cur.x / k, y: cur.y / k };
      box.value = snap({
        x: Math.min(o.x, c.x),
        y: Math.min(o.y, c.y),
        w: Math.abs(o.x - c.x),
        h: Math.abs(o.y - c.y),
      });
    }

    // ── layout: one factor maps physical px → CSS px, derived from the
    //    canvas's actual box; a relayout CANCELS a drag in progress (its
    //    origin lives in the old k's CSS space) — the completed box redraws
    //    at the new factor ──
    function layout() {
      dragStart = null;
      const stage = stageEl.value;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      cssPerPhys.value = Math.min(
        Math.max(r.width, 1) / physW.value,
        Math.max(r.height, 1) / physH.value,
      );
    }
    const canvasStyle = computed(() => ({
      width: `${Math.max(1, Math.floor(physW.value * cssPerPhys.value))}px`,
      height: `${Math.max(1, Math.floor(physH.value * cssPerPhys.value))}px`,
    }));

    // ── derived chrome styles (all through the single factor k) ──────────
    const guideRectStyle = computed(() => {
      const tb = tableRect.value;
      if (!tb) return {};
      const k = cssPerPhys.value;
      return {
        left: `${tb.x * k}px`,
        top: `${tb.y * k}px`,
        width: `${tb.width * k}px`,
        height: `${tb.height * k}px`,
      };
    });
    const selectionStyle = computed(() => {
      const b = box.value;
      if (!b) return {};
      const k = cssPerPhys.value;
      return {
        left: `${b.x * k}px`,
        top: `${b.y * k}px`,
        width: `${b.w * k}px`,
        height: `${b.h * k}px`,
      };
    });
    const sizeStyle = computed(() => {
      const b = box.value;
      if (!b) return {};
      const k = cssPerPhys.value;
      return {
        left: `${b.x * k}px`,
        top: `${Math.max(0, b.y * k - 24)}px`,
      };
    });
    const sizeText = computed(() => {
      const b = box.value;
      return b ? `${Math.round(b.w)} × ${Math.round(b.h)}` : "";
    });

    // ── age label ("缓存截屏 · 刚刚 / N 分钟前"), ticking every 30 s ─────
    const now = ref(Date.now());
    let ageTimer: ReturnType<typeof setInterval> | null = null;
    const ageText = computed(() => {
      const at = ctx.value?.capturedAtMs;
      if (at == null) return "";
      const minutes = Math.max(0, Math.floor((now.value - at) / 60000));
      return minutes < 1
        ? t("replay.live.manualShotFresh")
        : t("replay.live.manualShotAge", { n: minutes });
    });

    // ── payload load (open + the layer's Retry button) ───────────────────
    async function load() {
      loading.value = true;
      ctx.value = null;
      box.value = null;
      note.value = null;
      let next: ManualLocateContext | null = null;
      try {
        next = await api.fetchManualLocateContext();
      } catch (err) {
        console.warn("[manual-locate] context unavailable:", err);
      }
      // Flip `loading` BEFORE measuring: the stage only mounts once the
      // spinner branch is gone, and the layout factor below needs its box.
      ctx.value = next;
      loading.value = false;
      if (next && hasImage.value) {
        // Suggested selection: the detected table — one Enter away, and a
        // visible reference while dragging a correction.
        const table = next.guides?.tableRect;
        if (table && table.width > MIN_PHYSICAL && table.height > MIN_PHYSICAL) {
          box.value = { x: table.x, y: table.y, w: table.width, h: table.height };
        }
        await nextTick();
        layout();
        observeStage();
      }
    }

    // Relayout on stage resize (maximize / restore / monitor moves included):
    // the factor follows the canvas's actual box, nothing else.
    let ro: ResizeObserver | null = null;
    function observeStage() {
      if (!ro) ro = new ResizeObserver(() => layout());
      ro.disconnect();
      if (stageEl.value) ro.observe(stageEl.value);
    }

    // ── confirm / cancel ──────────────────────────────────────────────────
    async function confirmSelection() {
      const b = box.value;
      if (submitting.value || !b || b.w < 4 || b.h < 4) return;
      // Defensive (pointerup already filters): never submit a sub-minimum box.
      if (Math.round(b.w) <= MIN_PHYSICAL || Math.round(b.h) <= MIN_PHYSICAL) {
        note.value = t("replay.live.manualTooSmall");
        return;
      }
      submitting.value = true;
      try {
        await api.setManualRosterRect(
          Math.round(b.x),
          Math.round(b.y),
          Math.round(b.w),
          Math.round(b.h),
        );
        // Success: the backend armed the anchor and cleared its open flag —
        // drop the layer. `submitting` stays true until the close reset: no
        // further input is accepted meanwhile.
        manual.closePicker();
      } catch (err) {
        // Validation failed (too small / no battle / game gone). Keep the
        // layer open so the user can retry or hit Esc — surface the reason.
        submitting.value = false;
        note.value = err instanceof Error ? err.message : String(err);
        console.warn("[manual-locate] submit refused:", err);
      }
    }

    function cancelPick() {
      // Fire-and-forget: clears the backend's open flag. A failed invoke
      // means the backend never armed it (defensive anyway).
      void api.cancelManualLocate().catch(() => {});
      manual.closePicker();
    }

    // ── pointer flow (canvas-local CSS px; drag surface = the frame only) ──
    function localPoint(e: PointerEvent) {
      const r = canvasEl.value?.getBoundingClientRect();
      return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
    }
    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      if (flashTimer) {
        clearTimeout(flashTimer);
        flashTimer = null;
      }
      note.value = null;
      dragStart = localPoint(e);
      canvasEl.value?.setPointerCapture(e.pointerId);
      updateBox(dragStart, dragStart);
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragStart) return;
      updateBox(dragStart, localPoint(e));
    }
    function onPointerUp(e: PointerEvent) {
      if (!dragStart) return;
      dragStart = null;
      try {
        canvasEl.value?.releasePointerCapture(e.pointerId);
      } catch {
        // capture already released — nothing to do
      }
      const b = box.value;
      const k = cssPerPhys.value;
      if (!b || b.w * k < 4 || b.h * k < 4) {
        box.value = null;
        return;
      }
      if (Math.round(b.w) <= MIN_PHYSICAL || Math.round(b.h) <= MIN_PHYSICAL) {
        box.value = null;
        note.value = t("replay.live.manualTooSmall");
        flashTimer = setTimeout(() => {
          flashTimer = null;
          if (!dragStart && !box.value) note.value = null;
        }, 1400);
      }
    }
    // Alt-Tab / system gestures cancel the pointer stream mid-drag: drop the
    // drag origin so the next move cannot extend a stale one.
    function onPointerCancel() {
      dragStart = null;
    }

    // ── keyboard: Esc must ALWAYS be an exit — mid-drag included ──────────
    function onKey(e: KeyboardEvent) {
      if (!manual.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancelPick();
      } else if (e.key === "Enter" && box.value) {
        e.preventDefault();
        void confirmSelection();
      }
    }

    // ── open/close lifecycle ───────────────────────────────────────────────
    watch(
      () => manual.open,
      (open) => {
        if (open) {
          // The click that opened the layer leaves its button focused; blur
          // it so Enter/Space cannot fall through and re-trigger the panel
          // underneath the full-cover layer.
          (document.activeElement as HTMLElement | null)?.blur?.();
          now.value = Date.now();
          ageTimer = setInterval(() => (now.value = Date.now()), 30000);
          void load();
        } else {
          if (ageTimer) {
            clearInterval(ageTimer);
            ageTimer = null;
          }
          if (flashTimer) {
            clearTimeout(flashTimer);
            flashTimer = null;
          }
          ro?.disconnect();
          dragStart = null;
          ctx.value = null;
          box.value = null;
          note.value = null;
          submitting.value = false;
          guidesOn.value = true;
        }
      },
    );

    let unlistenClose: (() => void) | null = null;
    onMounted(async () => {
      window.addEventListener("keydown", onKey);
      unlistenClose = (await api.listenManualLocateClose(() =>
        manual.closePicker(),
      )) as (() => void) | null;
    });
    onBeforeUnmount(() => {
      window.removeEventListener("keydown", onKey);
      unlistenClose?.();
      unlistenClose = null;
      if (ageTimer) clearInterval(ageTimer);
      if (flashTimer) clearTimeout(flashTimer);
      ro?.disconnect();
      ro = null;
    });

    return () => (
      <Teleport to="body">
        {manual.open && (
          <div class="manual-locate">
            {loading.value ? (
              <div class="ml-loading">
                <HkSpinner size={28} tone="current" />
              </div>
            ) : hasImage.value ? (
              <>
                <div class="ml-bar">
                  <button
                    type="button"
                    class="ml-guide-toggle"
                    aria-pressed={guidesOn.value}
                    onClick={() => (guidesOn.value = !guidesOn.value)}
                  >
                    {t("replay.live.manualGuides")}
                  </button>
                  {ageText.value ? <span class="ml-age">{ageText.value}</span> : null}
                  <span class="ml-bar-hint">
                    {note.value ?? t("replay.live.manualShotHint")}
                  </span>
                  <div class="ml-bar-actions">
                    <button
                      type="button"
                      class="ml-btn ml-btn--primary"
                      disabled={!box.value || submitting.value}
                      onClick={() => void confirmSelection()}
                    >
                      {t("replay.live.manualConfirm")}
                    </button>
                    <button type="button" class="ml-btn" onClick={cancelPick}>
                      {t("replay.live.manualCancel")}
                    </button>
                  </div>
                </div>
                <div class="ml-stage" ref={stageEl}>
                  <div
                    class="ml-canvas"
                    ref={canvasEl}
                    style={canvasStyle.value}
                    onPointerdown={onPointerDown}
                    onPointermove={onPointerMove}
                    onPointerup={onPointerUp}
                    onPointercancel={onPointerCancel}
                  >
                    <img class="ml-frame" src={frameSrc.value} alt="" draggable={false} />
                    <div
                      class={[
                        "ml-guide-layer",
                        { "ml-guide-layer--hidden": !guidesOn.value },
                      ]}
                    >
                      {tableRect.value ? (
                        <div class="ml-guide-rect" style={guideRectStyle.value} />
                      ) : null}
                      {[...hGuides.value].map((y) => (
                        <div
                          key={`h-${y}`}
                          class="ml-guide-line ml-guide-line--h"
                          style={{ top: `${y * cssPerPhys.value}px` }}
                        />
                      ))}
                      {[...vGuides.value].map((x) => (
                        <div
                          key={`v-${x}`}
                          class="ml-guide-line ml-guide-line--v"
                          style={{ left: `${x * cssPerPhys.value}px` }}
                        />
                      ))}
                    </div>
                    {box.value ? (
                      <div class="ml-selection" style={selectionStyle.value} />
                    ) : null}
                    {box.value ? (
                      <div class="ml-size" style={sizeStyle.value}>
                        {sizeText.value}
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <div class="ml-unavailable">
                <p class="ml-unavailable__msg">{t("replay.live.manualNoFrame")}</p>
                <div class="ml-unavailable__actions">
                  <button type="button" class="ml-btn" onClick={() => void load()}>
                    {t("common.retry")}
                  </button>
                  <button type="button" class="ml-btn ml-btn--primary" onClick={cancelPick}>
                    {t("replay.live.manualCancel")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Teleport>
    );
  },
});
