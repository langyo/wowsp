/**
 * Manual-locate picker — an in-app SUB-WINDOW of the main window, rendered
 * as a plain HkModal (the same window context as Settings), NOT a dedicated
 * Tauri window and NOT a full-screen takeover. Opened in "battle" mode by
 * the manual-locate flow after the backend gates pass (`startManualLocate`)
 * or in "calibration" mode by the settings calibration editor
 * (`startCalibrationLocate`); the open state lives in the manualLocate
 * store so a mid-pick roster update cannot unmount the picker out from
 * under the user.
 *
 * The background is a REFERENCE IMAGE — by default the newest capture of
 * the automatic in-game archive (frames the Rust watcher stored while the
 * player held Tab over the roster, persisted to the system temp dir, so the
 * last ten survive game exits and app restarts), downscaled for transport.
 * The footer-adjacent selector row swaps it: one entry per archived capture
 * (thumbnail + age), a pasted clipboard image, or a picked file. The
 * detector's knowledge of the displayed image is overlaid as GUIDES — the
 * table rectangle, one horizontal line per row, the team seam — and the
 * drag box's edges snap to them (toggleable; hiding the guides disables
 * the snapping). A suggested box (the detected table) is pre-drawn so a
 * good detection is one Enter away.
 *
 * CALIBRATION MODE adds a team-count control (bottom-right, once a box is
 * drawn): rosters differ between battles (12v12 one match, 10v10 the next)
 * and the stored entry's shape can be stale, so the per-team player counts
 * are editable right there — the row grid preview inside the selection
 * re-spreads live, and the counts ride the submit (`setCalibrationAnchor`)
 * so the saved anchor is derived from the roster the drawing was aligned
 * against.
 *
 * Submit routing keys off the store's mode: battle submits go to
 * `setManualRosterRect` (anchored against the capture's game rect);
 * calibration submits go to `setCalibrationAnchor` with the editor target
 * (client + class) and the `source` describing the displayed reference
 * image — the backend rescales the frame-space box onto the STORED
 * entry's window size, so editing works against any reference.
 *
 * Coordinates under zoom/DPI: a single factor `k` (CSS px per physical px)
 * is derived from the canvas element's actual on-screen box, so the app
 * window's own devicePixelRatio never enters the math — the window may sit
 * on any monitor regardless of the game monitor's scale factor. The shell's
 * MANUAL interface-scale preference additionally applies root CSS `zoom`,
 * which would otherwise double-scale the canvas (the measured box inflates
 * by Z, the canvas lays out Z× the stage and renders Z²) — the surface
 * therefore NEUTRALIZES zoom (`neutralizeZoom`): the subtree runs at
 * effective zoom 1 and every px inside is a true CSS px again. The
 * submitted box converts back through `k` into PHYSICAL px relative to the
 * reference image's top-left (what the backend validates).
 *
 * Closing paths: Confirm (submit Ok), Cancel (footer / Esc — HkModal's own
 * Esc/X/mask close included, routed through `cancelPick` so the backend's
 * open flag always clears), and the backend's `wowsp://manual-locate-close`
 * force-close push (game window gone / overlay mode ended).
 *
 * Interaction contract:
 *   - press + drag on the frame → draw the selection (dashed border, light
 *     wash, live W×H readout in physical game px);
 *   - release → the footer's Confirm arms; a box below the 32-physical-px
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
import {
  HkButton,
  HkModal,
  HkNumberInput,
  HkSpinner,
  HkTag,
  useToast,
} from "@celestia-island/hikari";
import { Copy, FileImage } from "@lucide/vue";

import {
  api,
  type ManualLocateContext,
  type ManualLocateGalleryFrame,
  type ManualLocateSource,
  type Rect,
} from "@/api";
import { t } from "@/i18n";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import { useManualLocateStore } from "@/stores/manualLocate";
import { nextZoomFix } from "./manualLocateZoom";
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
    const toast = useToast();

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

    // ── reference-image selector (the picker's bottom row) ───────────────
    // `activeSource` is the IDENTITY of the displayed image: null = the
    // newest automatic capture, a frame source names one gallery capture,
    // an image source the user's own picture. Calibration submits send it
    // verbatim; battle submits never send it.
    const activeSource = ref<ManualLocateSource | null>(null);
    const gallery = ref<ManualLocateGalleryFrame[]>([]);
    /** The ORIGINAL user-supplied base64 (and its mime, for the thumbnail)
     *  behind an `image` selection — the backend context re-encodes to a
     *  downscaled PNG, but submits must carry what the user supplied. */
    const customImageBase64 = ref<string | null>(null);
    const customImageMime = ref("image/png");
    const fileInput = ref<HTMLInputElement | null>(null);

    /** The source a calibration submit describes the displayed image with
     *  (battle submits never send one): the chosen gallery frame, the
     *  user's original image bytes, or undefined for the newest frame. */
    function submitSource(): ManualLocateSource | undefined {
      const src = activeSource.value;
      if (src?.kind === "image" && customImageBase64.value) {
        return { kind: "image", imageBase64: customImageBase64.value };
      }
      if (src?.kind === "frame" && src.atMs != null) {
        return { kind: "frame", atMs: src.atMs };
      }
      return undefined;
    }

    /** The custom image's thumb as a data URL (empty while none). */
    const customThumbSrc = computed(() =>
      customImageBase64.value
        ? `data:${customImageMime.value};base64,${customImageBase64.value}`
        : "",
    );

    /** Read a Blob/File into BARE base64 (no data-URL prefix — the wire
     *  format `manual_locate_context_for` / `set_calibration_anchor`
     *  expects). */
    function readAsBase64(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const s = String(reader.result ?? "");
          const i = s.indexOf(";base64,");
          const b64 = i >= 0 ? s.slice(i + ";base64,".length) : "";
          if (b64) resolve(b64);
          else reject(new Error("empty base64 read"));
        };
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.readAsDataURL(blob);
      });
    }

    /** Stage a user-supplied image (paste / file) and load its context. */
    function selectImage(base64: string, mime: string) {
      customImageBase64.value = base64;
      customImageMime.value = mime || "image/png";
      void load({ kind: "image", imageBase64: base64 });
    }

    /** Clipboard image: `navigator.clipboard.read()` (the async clipboard
     *  API — read() is the only route to ITEMS; readText() cannot carry
     *  images), then the first image blob type. Failures (permission
     *  denied, no image, unsupported browser) toast — never silent. */
    async function pasteImage() {
      try {
        if (!navigator.clipboard?.read) {
          throw new Error("async clipboard unavailable");
        }
        const items = await navigator.clipboard.read();
        let blob: Blob | null = null;
        for (const item of items) {
          const type = item.types.find((ty) => ty.startsWith("image/"));
          if (type) {
            blob = await item.getType(type);
            break;
          }
        }
        if (!blob) throw new Error("clipboard carries no image");
        selectImage(await readAsBase64(blob), blob.type);
      } catch (err) {
        toast.error(t("replay.live.manualShotLoadFailed"));
        console.warn("[manual-locate] clipboard image unavailable:", err);
      }
    }

    async function onFileChange(e: Event) {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      try {
        selectImage(await readAsBase64(file), file.type);
      } catch (err) {
        toast.error(t("replay.live.manualShotLoadFailed"));
        console.warn("[manual-locate] image file read failed:", err);
      }
    }

    async function loadGallery() {
      try {
        gallery.value = await api.fetchManualLocateGallery();
      } catch (err) {
        console.warn("[manual-locate] gallery unavailable:", err);
      }
    }

    // ── selection state (PHYSICAL px; conversions at the pointer edge) ──
    const box = ref<Box | null>(null);

    // ── calibration team counts (the shape the saved grid is derived from) ──
    // Rosters differ between battles (12v12 one match, 10v10 the next) and
    // the stored entry's shape may be stale — the editor exposes them as a
    // bottom-right control (calibration mode, once a box is drawn) and the
    // submit rides them into `setCalibrationAnchor`. Seeded from the target
    // entry's stored shape, or the class's classic placeholder default.
    const teamAllies = ref(12);
    const teamEnemies = ref(12);
    function seedTeamCounts() {
      const cal = manual.calibration;
      const sizes = cal?.teamSizes ?? (cal?.class === "pve" ? ([9, 0] as const) : ([12, 12] as const));
      teamAllies.value = Math.min(12, Math.max(1, Math.round(sizes[0] || 12)));
      teamEnemies.value = cal?.class === "pve" ? 0 : Math.min(12, Math.max(1, Math.round(sizes[1] || 12)));
    }
    /** The roster hint the context loads (and the calibration submit)
     *  carry: only the calibration editor knows a target shape; the battle
     *  flow leaves the backend's live arena read in charge. */
    const teamSizesHint = computed<[number, number] | undefined>(() =>
      manual.mode === "calibration" && manual.calibration
        ? [teamAllies.value, teamEnemies.value]
        : undefined,
    );
    /** Drag origin in canvas CSS px, null while no drag is in progress. */
    let dragStart: { x: number; y: number } | null = null;
    /** CSS px per physical px — derived from the canvas's actual box (the
     *  app window's DPI — and, thanks to `neutralizeZoom`, the shell's
     *  interface-scale zoom — never enter the math). */
    const cssPerPhys = ref(1);
    const guidesOn = ref(true);
    /** Guards a double confirm (double Enter / button + Enter race). */
    const submitting = ref(false);
    /** Metaline note slot: a too-small flash or a submit error, in place of
     *  the default hint. Cleared by the next drag. */
    const note = ref<string | null>(null);
    let flashTimer: ReturnType<typeof setTimeout> | null = null;

    const rootEl = ref<HTMLElement | null>(null);
    const stageEl = ref<HTMLElement | null>(null);
    const canvasEl = ref<HTMLElement | null>(null);
    /** Compensating zoom applied on the picker surface so the subtree runs
     *  at effective zoom 1 — see `neutralizeZoom`. */
    const zoomFix = ref(1);

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

    // ── the team-count control's live row grid (calibration mode, box
    //    drawn) — the SAME math the backend's `manual_row_centers` applies:
    //    the taller side fills the box at pitch = height / max(allies,
    //    enemies), each row center half a pitch in; PvP draws the mid seam,
    //    PvE is one full-width team. Drawn in a distinct tint over the
    //    detector's guides so the box can be aligned against the counts the
    //    submit will actually save. ──
    const countGrid = computed<{ lines: number[]; seam: number | null } | null>(() => {
      if (manual.mode !== "calibration" || !box.value) return null;
      const b = box.value;
      const allies = Math.max(1, teamAllies.value);
      const enemies = Math.max(0, teamEnemies.value);
      const tallest = Math.max(allies, enemies);
      const pitch = b.h / tallest;
      const lines: number[] = [];
      for (let i = 0; i < tallest; i++) lines.push(b.y + pitch * (i + 0.5));
      return { lines, seam: enemies === 0 ? null : b.x + b.w * 0.5 };
    });
    const gridLineStyle = (y: number) => ({ top: `${y * cssPerPhys.value}px` });
    const gridSeamStyle = computed(() => {
      const g = countGrid.value;
      return g && g.seam != null ? { left: `${g.seam * cssPerPhys.value}px` } : {};
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

    /** Bring the surface back to effective zoom 1. The shell's manual DPI
     *  scale applies root CSS `zoom`; measured off THIS root's visual-vs-
     *  layout width ratio (works for whatever zoom the shell applies, and
     *  re-converges after mid-pick scale changes — the pure step function
     *  `nextZoomFix` owns the math AND the convergence contract, including
     *  the no-oscillation property under ResizeObserver feedback). */
    function neutralizeZoom() {
      const el = rootEl.value;
      if (!el) return;
      const visual = el.getBoundingClientRect().width;
      const layout = el.offsetWidth;
      if (layout < 1 || visual < 1) return;
      zoomFix.value = nextZoomFix(zoomFix.value, visual / layout);
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
    /** Zoom-normalize FIRST (the fix lands on the next render), then measure
     *  k in the normalized space. */
    async function relayout() {
      neutralizeZoom();
      await nextTick();
      layout();
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
    function ageLabelOf(at: number): string {
      const minutes = Math.max(0, Math.floor((now.value - at) / 60000));
      return minutes < 1
        ? t("replay.live.manualShotFresh")
        : t("replay.live.manualShotAge", { n: minutes });
    }
    const ageText = computed(() => {
      const at = ctx.value?.capturedAtMs;
      return at == null ? "" : ageLabelOf(at);
    });

    // ── payload load (open + selector switches + the Retry button) ────────
    /** Load the context for one source (null = the newest automatic
     *  capture). The whole boot sequence — suggested box, zoom
     *  neutralization, stage measurement — re-runs on the new image. */
    async function load(source: ManualLocateSource | null = null) {
      loading.value = true;
      ctx.value = null;
      box.value = null;
      note.value = null;
      let next: ManualLocateContext | null = null;
      try {
        next = await api.fetchManualLocateContextFor(source ?? undefined, teamSizesHint.value);
      } catch (err) {
        console.warn("[manual-locate] context unavailable:", err);
      }
      activeSource.value = source;
      if (source?.kind !== "image") {
        // Leaving a custom image (or re-picking the same slot class):
        // drop the stale user bytes so a later submit cannot send them.
        customImageBase64.value = null;
        customImageMime.value = "image/png";
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
        await relayout();
        observeStage();
      }
    }

    // Relayout on stage resize (maximize / restore / monitor or interface-
    // scale changes included): the factor follows the canvas's actual box,
    // nothing else.
    let ro: ResizeObserver | null = null;
    function observeStage() {
      if (!ro) ro = new ResizeObserver(() => void relayout());
      ro.disconnect();
      if (stageEl.value) ro.observe(stageEl.value);
    }
    // A root-zoom change does NOT necessarily resize the stage in layout px
    // (a max-width-driven modal keeps its layout box), so the ResizeObserver
    // alone can miss it — watch the applied interface scale directly and
    // re-neutralize + re-measure when it moves mid-pick.
    const dpiScale = useAppliedDpiScale();
    watch(dpiScale, () => {
      if (manual.open) void relayout();
    });

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
      // Which branch ran — only a calibration submit bumps the store's
      // version (the settings section watches it to re-read its list).
      let calibrationSubmit = false;
      try {
        if (manual.mode === "calibration" && manual.calibration) {
          // Calibration editor submit: the frame-space box plus the
          // displayed reference image's identity — the backend rescales
          // onto the STORED entry's window size, so the game need not be
          // running (or even installed at this window size) right now. An
          // empty target is CREATED from the drawing; the install's kind
          // rides along for exactly that case.
          await api.setCalibrationAnchor(
            manual.calibration.clientKey,
            manual.calibration.class,
            Math.round(b.x),
            Math.round(b.y),
            Math.round(b.w),
            Math.round(b.h),
            submitSource(),
            manual.calibration.kind,
            teamSizesHint.value,
          );
          calibrationSubmit = true;
        } else {
          await api.setManualRosterRect(
            Math.round(b.x),
            Math.round(b.y),
            Math.round(b.w),
            Math.round(b.h),
            // The rect the cached frame was captured against — the drawing is
            // relative to it. The live window rect is useless here: the picker
            // is designed for Alt-Tab use, where the minimized window reports
            // a placeholder rect that refuses valid boxes.
            ctx.value?.capturedGameRect ?? null,
          );
        }
        // Success: the backend armed the anchor and cleared its open flag —
        // drop the picker. `submitting` stays true until the close reset: no
        // further input is accepted meanwhile.
        if (calibrationSubmit) manual.noteCalibrationSaved();
        manual.closePicker();
      } catch (err) {
        // Validation failed (too small / no battle / unknown client kind /
        // reference frame gone). Keep the picker open so the user
        // can retry or hit Esc — surface the reason inline, and (calibration
        // mode) as a toast carrying the raw backend string behind a generic
        // prefix so it reads as the editor's failure, not a stray code.
        submitting.value = false;
        const msg = err instanceof Error ? err.message : String(err);
        note.value = msg;
        if (manual.mode === "calibration") {
          toast.error(`${t("settings.overlayCalibrationEditor")}: ${msg}`);
        }
        console.warn("[manual-locate] submit refused:", err);
      }
    }

    function cancelPick() {
      // Fire-and-forget: clears the backend's open flag. A failed invoke
      // means the backend never armed it (defensive anyway).
      void api.cancelManualLocate().catch(() => {});
      manual.closePicker();
    }

    /** HkModal-internal closes (X button / mask / its own Esc handling):
     *  the picker must treat them all as a cancel so the backend flag
     *  clears. Programmatic closes (confirm / force-close) flip the store
     *  directly and never emit this. */
    function onModalUpdate(v: boolean) {
      if (!v) cancelPick();
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

    // ── keyboard: Esc must ALWAYS be an exit — mid-drag included (HkModal's
    //    own Esc path lands here too; both are idempotent) — and Enter
    //    confirms an armed box ──
    function onKey(e: KeyboardEvent) {
      if (!manual.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancelPick();
      } else if (e.key === "Enter" && box.value) {
        // Never hijack Enter on a focused control (HkModal focuses its close
        // button first; the user may be on a footer button) — only the
        // "canvas intent" Enter confirms.
        const target = e.target as HTMLElement | null;
        if (target?.closest("button, a, input, select, textarea")) return;
        e.preventDefault();
        void confirmSelection();
      }
    }

    // ── open/close lifecycle ───────────────────────────────────────────────
    watch(
      () => manual.open,
      (open) => {
        if (open) {
          // The click that opened the picker leaves its button focused; blur
          // it so Enter/Space cannot fall through and re-trigger the panel
          // underneath the modal.
          (document.activeElement as HTMLElement | null)?.blur?.();
          now.value = Date.now();
          ageTimer = setInterval(() => (now.value = Date.now()), 30000);
          seedTeamCounts();
          void load();
          void loadGallery();
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
          zoomFix.value = 1;
          activeSource.value = null;
          gallery.value = [];
          customImageBase64.value = null;
          customImageMime.value = "image/png";
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
        <HkModal
          modelValue={manual.open}
          onUpdate:modelValue={onModalUpdate}
          title={
            manual.mode === "calibration"
              ? t("settings.overlayCalibrationEditor")
              : t("replay.live.manualLocate")
          }
          width="min(72rem, 94vw)"
          footerActions={[
            {
              label: t("replay.live.manualCancel"),
              variant: "secondary",
              onClick: cancelPick,
            },
            {
              label: t("replay.live.manualConfirm"),
              variant: "primary",
              disabled: !box.value || submitting.value,
              loading: submitting.value,
              onClick: () => void confirmSelection(),
            },
          ]}
        >
          {loading.value ? (
            <div class="manual-locate ml-state">
              <HkSpinner size={28} tone="current" />
            </div>
          ) : hasImage.value ? (
            <div class="manual-locate" ref={rootEl} style={{ zoom: zoomFix.value }}>
              <div class="ml-metaline">
                <HkButton
                  size="sm"
                  variant={guidesOn.value ? "secondary" : "ghost"}
                  aria-pressed={guidesOn.value}
                  onClick={() => (guidesOn.value = !guidesOn.value)}
                >
                  {t("replay.live.manualGuides")}
                </HkButton>
                {ageText.value ? <span class="ml-age">{ageText.value}</span> : null}
                <span class="ml-hint">{note.value ?? t("replay.live.manualShotHint")}</span>
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
                    class={["ml-guide-layer", { "ml-guide-layer--hidden": !guidesOn.value }]}
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
                  {/* The team-count control's live row grid — the shape the
                      calibration submit will save, re-spread over the drawn
                      box as the counts change (independent of the guides
                      toggle: this is the user's own alignment tool). */}
                  {countGrid.value?.lines.map((y, i) => (
                    <div
                      key={`grid-${i}`}
                      class="ml-countgrid-line"
                      style={gridLineStyle(y)}
                    />
                  ))}
                  {countGrid.value?.seam != null ? (
                    <div
                      class="ml-countgrid-line ml-countgrid-line--seam"
                      style={gridSeamStyle.value}
                    />
                  ) : null}
                </div>
                {/* Team-count control (calibration editor, bottom-right):
                    rosters differ between battles and the stored shape may
                    be stale — adjust both sides here and the grid preview +
                    the saved anchor follow. Sits OVER the stage; pointer
                    events never reach the drag surface underneath. */}
                {manual.mode === "calibration" && manual.calibration ? (
                  <div class="ml-count">
                    <span class="ml-count__hint">{t("replay.live.manualTeamHint")}</span>
                    <div class="ml-count__row">
                      <span class="ml-count__team">
                        {t("replay.live.manualTeamAllies")}
                      </span>
                      <HkNumberInput
                        size="sm"
                        min={1}
                        max={12}
                        modelValue={teamAllies.value}
                        onUpdate:modelValue={(v: number) => (teamAllies.value = v)}
                      />
                      {manual.calibration.class === "pve" ? (
                        <HkTag size="sm">PvE</HkTag>
                      ) : (
                        <>
                          <span class="ml-count__team">
                            {t("replay.live.manualTeamEnemies")}
                          </span>
                          <HkNumberInput
                            size="sm"
                            min={1}
                            max={12}
                            modelValue={teamEnemies.value}
                            onUpdate:modelValue={(v: number) => (teamEnemies.value = v)}
                          />
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div class="manual-locate ml-state">
              <p class="ml-state__msg">{t("replay.live.manualNoFrame")}</p>
              <div class="ml-state__actions">
                <HkButton
                  size="sm"
                  variant="secondary"
                  onClick={() => void load(activeSource.value)}
                >
                  {t("common.retry")}
                </HkButton>
                <HkButton size="sm" variant="primary" onClick={cancelPick}>
                  {t("replay.live.manualCancel")}
                </HkButton>
              </div>
            </div>
          )}
          {/* Reference-image selector — the bottom strip above the footer
              buttons. One thumbnail per archived capture (the newest ten,
              disk-backed so they survive restarts and game exits; hover =
              its age; the default load shows the newest without a button of
              its own), the clipboard / file entries for a user-supplied
              picture, and a loaded custom image as a highlighted thumb.
              Every entry reloads the whole context — guides included — via
              `manual_locate_context_for`. Visible in BOTH modes: the
              calibration editor wants it, and the battle picker benefits
              the same way (pick the frame the roster moment actually sat
              on). Hidden while loading so a switch cannot stack on a
              half-built stage. */}
          {!loading.value ? (
            <div class="ml-shots">
              <span class="ml-shots__label">{t("replay.live.manualShotPick")}</span>
              <div class="ml-shots__row">
                {gallery.value.map((f) => (
                  <button
                    key={f.atMs}
                    type="button"
                    class={[
                      "ml-shot ml-shot--thumb",
                      {
                        "ml-shot--on":
                          activeSource.value?.kind === "frame" &&
                          activeSource.value.atMs === f.atMs,
                      },
                    ]}
                    title={ageLabelOf(f.atMs)}
                    onClick={() => void load({ kind: "frame", atMs: f.atMs })}
                  >
                    <img
                      src={`data:image/png;base64,${f.imageBase64}`}
                      alt=""
                      draggable={false}
                    />
                  </button>
                ))}
                {customThumbSrc.value ? (
                  <span class="ml-shot ml-shot--thumb ml-shot--on">
                    <img src={customThumbSrc.value} alt="" draggable={false} />
                  </span>
                ) : null}
                <HkButton size="sm" variant="secondary" onClick={() => void pasteImage()}>
                  <Copy size={13} />
                  {t("replay.live.manualShotPaste")}
                </HkButton>
                <HkButton
                  size="sm"
                  variant="secondary"
                  onClick={() => fileInput.value?.click()}
                >
                  <FileImage size={13} />
                  {t("replay.live.manualShotFile")}
                </HkButton>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept=".png,.jpg,.jpeg,.bmp"
                style="display:none"
                onChange={onFileChange}
              />
            </div>
          ) : null}
        </HkModal>
      </Teleport>
    );
  },
});
