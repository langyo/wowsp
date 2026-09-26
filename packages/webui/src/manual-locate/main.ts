/**
 * Manual-locate picker window bootstrap — deliberately NOT Vue (same
 * rationale as the overlay page): the window must paint the moment the user
 * clicks "manual locate".
 *
 * Two modes, chosen by the `manual_locate_context` payload the page pulls
 * on load:
 *
 * SCREENSHOT mode (preferred — a usable cached automatic capture exists):
 * the background is the LAST frame the Tab detector itself analyzed,
 * downscaled for transport. The detector's knowledge of that frame is
 * overlaid as GUIDES — the table rectangle, one horizontal line per row,
 * the team seam — and the drag box's edges snap to them (toggleable from
 * the toolbar; hiding the guides disables the snapping). A suggested box
 * (the detected table) is pre-drawn so a good detection is one Enter away.
 * The mapping is display-relative: a single factor `k` (CSS px per physical
 * px) is derived from the canvas element's actual on-screen box, so the
 * picker window's own DPI NEVER enters the math — the window may sit on any
 * monitor regardless of the game monitor's scale factor. The submitted box
 * converts back through the same `k` into PHYSICAL px relative to the game
 * window origin (what `set_manual_roster_rect` validates).
 *
 * LIVE mode (legacy fallback — no cached frame): the transparent window
 * sits exactly over the game rect, so CSS px × devicePixelRatio map 1:1
 * onto the game framebuffer, and the player boxes the live table.
 *
 * Shared interaction contract:
 *   - press + drag → draw the selection (dashed border, light wash, live
 *     W×H readout in physical game px);
 *   - release → screenshot mode arms the toolbar's Confirm, live mode shows
 *     Confirm/Cancel inside the selection; a box below the 32-physical-px
 *     minimum is a mis-click (reset + "too small" notice);
 *   - Enter = confirm, Esc = cancel (always — Esc must never get stuck);
 *   - confirm submits via `set_manual_roster_rect` (Rust validates, stores
 *     the manual anchor and destroys this window); cancel invokes
 *     `cancel_manual_locate`.
 */
import "./manual-locate.css";

interface PickerTauriApi {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}
const tauri = (window as unknown as { __TAURI__?: PickerTauriApi }).__TAURI__;
// App locale forwarded by start_manual_locate — picks the hint/button copy.
const locale = new URLSearchParams(window.location.search).get("locale") || "en-US";

// Same locale files the Vue app consumes — one source of truth for the copy
// (replay.live.* keys), bundled eagerly into this tiny page.
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface ManualLocateGuides {
  tableRect?: Rect | null;
  rowLines?: number[];
  seamX?: number | null;
}
interface ManualLocateContext {
  imageBase64?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  physWidth?: number;
  physHeight?: number;
  capturedAtMs?: number | null;
  guides?: ManualLocateGuides | null;
}
interface LiveCopy {
  manualDragHint: string;
  manualConfirm: string;
  manualCancel: string;
  manualTooSmall: string;
  manualShotHint: string;
  manualGuides: string;
  manualShotFresh: string;
  manualShotAge: string;
}
const MESSAGES = import.meta.glob<{ live: Partial<LiveCopy> }>(
  "../../../../res/i18n/locales/*/replay.json",
  { eager: true },
);
const messages = new Map<string, LiveCopy>();
for (const [path, mod] of Object.entries(MESSAGES)) {
  const m = path.match(/locales\/([a-zA-Z-]+)\/replay\.json$/);
  const live = mod?.live;
  if (
    m &&
    live?.manualDragHint &&
    live.manualConfirm &&
    live.manualCancel &&
    live.manualTooSmall &&
    live.manualShotHint &&
    live.manualGuides &&
    live.manualShotFresh &&
    live.manualShotAge
  ) {
    messages.set(m[1], {
      manualDragHint: live.manualDragHint,
      manualConfirm: live.manualConfirm,
      manualCancel: live.manualCancel,
      manualTooSmall: live.manualTooSmall,
      manualShotHint: live.manualShotHint,
      manualGuides: live.manualGuides,
      manualShotFresh: live.manualShotFresh,
      manualShotAge: live.manualShotAge,
    });
  }
}

function localizedCopy(): LiveCopy {
  const exact = messages.get(locale);
  if (exact) return exact;
  const lang = locale.split("-")[0];
  const byLang = [...messages.entries()].find(([k]) => k.split("-")[0] === lang);
  if (byLang) return byLang[1];
  return (
    messages.get("en-US") ?? {
      manualDragHint: "Drag to box-select the scoreboard area in the game window",
      manualConfirm: "Confirm",
      manualCancel: "Cancel",
      manualTooSmall: "Selection is too small",
      manualShotHint: "Drag a box around the scoreboard in the cached frame",
      manualGuides: "Guides & snap",
      manualShotFresh: "Cached frame · just now",
      manualShotAge: "Cached frame · {n} min ago",
    }
  );
}
const copy = localizedCopy();

// ─── Shared selection state ───────────────────────────────────────────────
/** One selection box, PHYSICAL game px (mode conversions happen at the
 *  edges: live mode multiplies CSS by dpr, screenshot mode divides by k). */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Minimum selection size per axis in PHYSICAL px — mirrors the Rust-side
 *  `MANUAL_MIN_SIZE` gate in `set_manual_roster_rect` exactly, so a box this
 *  page accepts can never be refused by the backend. */
const MIN_PHYSICAL = 32;
/** Drag origin in CSS px (canvas-relative in screenshot mode), null while
 *  no drag is in progress. */
let dragStart: { x: number; y: number } | null = null;
/** The current selection in PHYSICAL px, null before the first draw. */
let box: Box | null = null;
/** Guards a double confirm (double Enter / button + Enter race). */
let submitting = false;
/** Pending "too small" flash — a new drag cancels the revert. */
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function dpr(): number {
  return window.devicePixelRatio || 1;
}

/** CSS px per physical px for the ACTIVE mode (live: 1/dpr; shot: k). */
let cssPerPhys = 1;

const selection = document.createElement("div");
selection.className = "ml-selection";
selection.hidden = true;
const sizeLabel = document.createElement("div");
sizeLabel.className = "ml-size";
sizeLabel.hidden = true;

function showSelection(b: Box) {
  selection.hidden = false;
  selection.style.left = `${b.x * cssPerPhys}px`;
  selection.style.top = `${b.y * cssPerPhys}px`;
  selection.style.width = `${b.w * cssPerPhys}px`;
  selection.style.height = `${b.h * cssPerPhys}px`;
}

function showSize(b: Box) {
  sizeLabel.hidden = false;
  sizeLabel.textContent = `${Math.round(b.w)} × ${Math.round(b.h)}`;
  sizeLabel.style.left = `${b.x * cssPerPhys}px`;
  sizeLabel.style.top = `${Math.max(0, b.y * cssPerPhys - 24)}px`;
}

/** Update the box from the current drag (origin + current pointer, both
 *  CSS px in the active coordinate space); renders selection + live size.
 *  `snap`, when set, is applied to the PHYSICAL box after normalization. */
function updateBox(
  origin: { x: number; y: number },
  cur: { x: number; y: number },
  snap?: (b: Box) => Box,
) {
  const toPhys = (p: { x: number; y: number }) => ({ x: p.x / cssPerPhys, y: p.y / cssPerPhys });
  const o = toPhys(origin);
  const c = toPhys(cur);
  let b: Box = {
    x: Math.min(o.x, c.x),
    y: Math.min(o.y, c.y),
    w: Math.abs(o.x - c.x),
    h: Math.abs(o.y - c.y),
  };
  if (snap) b = snap(b);
  box = b;
  showSelection(b);
  showSize(b);
}

function flashTooSmall(notice: (text: string) => void, restore: () => void) {
  notice(copy.manualTooSmall);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    if (!dragStart && !box) restore();
  }, 1400);
}

async function confirmSelection(onError: (msg: string) => void) {
  if (submitting || !box || box.w < 4 || box.h < 4 || !tauri) return;
  // Defensive (mouseup already filters): never submit a sub-minimum box.
  if (Math.round(box.w) <= MIN_PHYSICAL || Math.round(box.h) <= MIN_PHYSICAL) {
    onError(copy.manualTooSmall);
    return;
  }
  submitting = true;
  try {
    await tauri.core.invoke("set_manual_roster_rect", {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.w),
      height: Math.round(box.h),
    });
    // Success: Rust destroys this window. Nothing to do here — and no
    // further input must be accepted meanwhile (`submitting` stays true).
  } catch (err) {
    // Validation failed (too small / no battle / game gone). Keep the
    // picker open so the user can retry or hit Esc — surface the reason.
    submitting = false;
    onError(err instanceof Error ? err.message : String(err));
  }
}

function cancelPick() {
  // Fire-and-forget: the Rust side destroys the window. A failed invoke
  // means it was already gone.
  void tauri?.core.invoke("cancel_manual_locate").catch(() => {});
}

window.addEventListener("keydown", (e) => {
  // Esc must ALWAYS be an exit — mid-drag included.
  if (e.key === "Escape") {
    e.preventDefault();
    cancelPick();
  }
});

// ─── LIVE mode (legacy transparent picker over the game rect) ─────────────
function buildLiveMode() {
  cssPerPhys = 1 / dpr();
  document.body.classList.add("ml-live");

  const dim = document.createElement("div");
  dim.className = "ml-dim";
  const hint = document.createElement("div");
  hint.className = "ml-hint";
  hint.textContent = copy.manualDragHint;
  const buttons = document.createElement("div");
  buttons.className = "ml-buttons";
  buttons.hidden = true;
  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ml-btn ml-btn--primary";
  confirmBtn.textContent = copy.manualConfirm;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ml-btn";
  cancelBtn.textContent = copy.manualCancel;
  buttons.append(confirmBtn, cancelBtn);
  document.body.append(dim, hint, selection, sizeLabel, buttons);

  const resetToHint = () => {
    box = null;
    selection.hidden = true;
    sizeLabel.hidden = true;
    buttons.hidden = true;
    hint.hidden = false;
    hint.textContent = copy.manualDragHint;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    dragStart = { x: e.clientX, y: e.clientY };
    document.body.setPointerCapture(e.pointerId);
    buttons.hidden = true;
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    hint.hidden = true;
    updateBox(dragStart, dragStart);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragStart) return;
    updateBox(dragStart, { x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragStart) return;
    dragStart = null;
    document.body.releasePointerCapture(e.pointerId);
    if (!box || box.w * cssPerPhys < 4 || box.h * cssPerPhys < 4) {
      resetToHint();
      return;
    }
    if (Math.round(box.w) <= MIN_PHYSICAL || Math.round(box.h) <= MIN_PHYSICAL) {
      box = null;
      selection.hidden = true;
      sizeLabel.hidden = true;
      flashTooSmall(
        (t) => {
          hint.textContent = t;
          hint.hidden = false;
        },
        () => resetToHint(),
      );
      return;
    }
    buttons.hidden = false;
    buttons.style.left = `${box.x * cssPerPhys + 8}px`;
    buttons.style.top = `${box.y * cssPerPhys + 8}px`;
  };
  // The picker window is created at a default position and moved onto the
  // game's monitor by Rust AFTER this page boots; WebView2's devicePixelRatio
  // updates asynchronously on that move (mixed-DPI setups), so the CSS↔
  // physical factor must be RE-DERIVED whenever the ratio changes — a value
  // frozen at build time would submit a wrongly-scaled anchor box. A drag in
  // progress is CANCELLED rather than re-scaled (its origin lives in the old
  // ratio's CSS space): the completed box redraws at the new factor, and the
  // player redraws the correction.
  const relayoutForDpr = () => {
    dragStart = null;
    cssPerPhys = 1 / dpr();
    if (box) {
      showSelection(box);
      showSize(box);
      if (!buttons.hidden) {
        buttons.style.left = `${box.x * cssPerPhys + 8}px`;
        buttons.style.top = `${box.y * cssPerPhys + 8}px`;
      }
    }
  };
  const armDpr = () => {
    const mq = window.matchMedia(`(resolution: ${dpr()}dppx)`);
    const onChange = () => {
      mq.removeEventListener("change", onChange);
      relayoutForDpr();
      armDpr();
    };
    mq.addEventListener("change", onChange);
  };
  armDpr();
  confirmBtn.addEventListener("click", () =>
    void confirmSelection((msg) => {
      hint.textContent = msg;
      hint.hidden = false;
    }),
  );
  cancelBtn.addEventListener("click", cancelPick);
  document.body.addEventListener("pointerdown", onPointerDown);
  document.body.addEventListener("pointermove", onPointerMove);
  document.body.addEventListener("pointerup", onPointerUp);
  // Alt-Tab / system gestures cancel the pointer stream mid-drag: drop the
  // drag origin so the next move cannot extend a stale one.
  document.body.addEventListener("pointercancel", () => {
    dragStart = null;
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !buttons.hidden) {
      e.preventDefault();
      void confirmSelection((msg) => {
        hint.textContent = msg;
        hint.hidden = false;
      });
    }
  });
}

// ─── SCREENSHOT mode (cached frame + guides + snapping) ───────────────────
/** Snap distance in CSS px — a box edge within this of a guide line jumps
 *  onto it. Feels immediate on any DPI because the tolerance lives in
 *  screen space, converted to physical per the current k. */
const SNAP_TOLERANCE_CSS = 10;

function buildScreenshotMode(ctx: ManualLocateContext) {
  const physW = ctx.physWidth || 1;
  const physH = ctx.physHeight || 1;
  document.body.classList.add("ml-shot");

  // ── toolbar ──
  const bar = document.createElement("div");
  bar.className = "ml-bar";
  const guideBtn = document.createElement("button");
  guideBtn.type = "button";
  guideBtn.className = "ml-guide-toggle";
  guideBtn.setAttribute("aria-pressed", "true");
  guideBtn.textContent = copy.manualGuides;
  const age = document.createElement("span");
  age.className = "ml-age";
  const barHint = document.createElement("span");
  barHint.className = "ml-bar-hint";
  barHint.textContent = copy.manualShotHint;
  const barActions = document.createElement("div");
  barActions.className = "ml-bar-actions";
  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ml-btn ml-btn--primary";
  confirmBtn.textContent = copy.manualConfirm;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ml-btn";
  cancelBtn.textContent = copy.manualCancel;
  barActions.append(confirmBtn, cancelBtn);
  bar.append(guideBtn, age, barHint, barActions);

  // ── stage / canvas ──
  const stage = document.createElement("div");
  stage.className = "ml-stage";
  const canvas = document.createElement("div");
  canvas.className = "ml-canvas";
  const frame = document.createElement("img");
  frame.className = "ml-frame";
  frame.alt = "";
  frame.draggable = false;
  frame.src = `data:image/png;base64,${ctx.imageBase64}`;
  const guideLayer = document.createElement("div");
  guideLayer.className = "ml-guide-layer";
  canvas.append(frame, guideLayer, selection, sizeLabel);
  stage.append(canvas);
  document.body.append(bar, stage);

  // ── guides (physical px snap targets + drawn lines) ──
  const guides = ctx.guides ?? {};
  const table = guides.tableRect ?? null;
  const hLines = new Set<number>(guides.rowLines ?? []);
  const vLines = new Set<number>();
  if (table) {
    hLines.add(table.y);
    hLines.add(table.y + table.height);
    vLines.add(table.x);
    vLines.add(table.x + table.width);
  }
  if (guides.seamX != null) vLines.add(guides.seamX);
  let guidesOn = true;

  function drawGuides() {
    guideLayer.textContent = "";
    if (!table && hLines.size === 0 && vLines.size === 0) return;
    const rect = document.createElement("div");
    rect.className = "ml-guide-rect";
    if (table) {
      rect.style.left = `${table.x * cssPerPhys}px`;
      rect.style.top = `${table.y * cssPerPhys}px`;
      rect.style.width = `${table.width * cssPerPhys}px`;
      rect.style.height = `${table.height * cssPerPhys}px`;
    } else {
      rect.hidden = true;
    }
    guideLayer.appendChild(rect);
    for (const y of hLines) {
      const el = document.createElement("div");
      el.className = "ml-guide-line ml-guide-line--h";
      el.style.top = `${y * cssPerPhys}px`;
      guideLayer.appendChild(el);
    }
    for (const x of vLines) {
      const el = document.createElement("div");
      el.className = "ml-guide-line ml-guide-line--v";
      el.style.left = `${x * cssPerPhys}px`;
      guideLayer.appendChild(el);
    }
  }

  /** Snap a physical-px box's edges onto the nearest guide lines. */
  function snap(b: Box): Box {
    if (!guidesOn) return b;
    const tol = SNAP_TOLERANCE_CSS / cssPerPhys;
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
    const x0 = snapAxis(b.x, vLines);
    const x1 = snapAxis(b.x + b.w, vLines);
    const y0 = snapAxis(b.y, hLines);
    const y1 = snapAxis(b.y + b.h, hLines);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return b; // snapped inside-out — keep raw
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ── layout: one factor maps physical px → CSS px, derived from the
  //    canvas's actual box (the picker window's DPI never enters the math;
  //    a dpr change re-runs this and redraws everything at the new k — and
  //    cancels a drag in progress, whose origin lives in the old k's CSS
  //    space) ──
  function layout() {
    dragStart = null;
    const stageRect = stage.getBoundingClientRect();
    cssPerPhys = Math.min(
      Math.max(stageRect.width, 1) / physW,
      Math.max(stageRect.height, 1) / physH,
    );
    canvas.style.width = `${Math.max(1, Math.floor(physW * cssPerPhys))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(physH * cssPerPhys))}px`;
    drawGuides();
    if (box) {
      showSelection(box);
      showSize(box);
    }
    syncConfirm();
  }

  // ── age label ──
  function renderAge() {
    if (ctx.capturedAtMs == null) {
      age.hidden = true;
      return;
    }
    const minutes = Math.max(0, Math.floor((Date.now() - ctx.capturedAtMs) / 60000));
    age.textContent =
      minutes < 1 ? copy.manualShotFresh : copy.manualShotAge.replace("{n}", String(minutes));
  }
  renderAge();
  const ageTimer = setInterval(renderAge, 30000);

  /** Confirm follows the selection: disabled until a box exists. */
  function syncConfirm() {
    confirmBtn.disabled = !box || submitting;
  }

  // ── pointer flow (canvas-local CSS px) ──
  const localPoint = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragStart = localPoint(e);
    canvas.setPointerCapture(e.pointerId);
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    updateBox(dragStart, dragStart, snap);
    syncConfirm();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    updateBox(dragStart, localPoint(e), snap);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!dragStart) return;
    dragStart = null;
    canvas.releasePointerCapture(e.pointerId);
    if (!box || box.w * cssPerPhys < 4 || box.h * cssPerPhys < 4) {
      box = null;
      selection.hidden = true;
      sizeLabel.hidden = true;
      syncConfirm();
      return;
    }
    if (Math.round(box.w) <= MIN_PHYSICAL || Math.round(box.h) <= MIN_PHYSICAL) {
      box = null;
      selection.hidden = true;
      sizeLabel.hidden = true;
      syncConfirm();
      flashTooSmall(
        (t) => {
          barHint.textContent = t;
        },
        () => {
          barHint.textContent = copy.manualShotHint;
        },
      );
    }
  });
  // Alt-Tab / system gestures cancel the pointer stream mid-drag: drop the
  // drag origin so the next move cannot extend a stale one.
  canvas.addEventListener("pointercancel", () => {
    dragStart = null;
  });

  // ── toolbar actions ──
  guideBtn.addEventListener("click", () => {
    guidesOn = !guidesOn;
    guideBtn.setAttribute("aria-pressed", String(guidesOn));
    guideLayer.classList.toggle("ml-guide-layer--hidden", !guidesOn);
  });
  confirmBtn.addEventListener("click", () =>
    void confirmSelection((msg) => {
      barHint.textContent = msg;
    }),
  );
  cancelBtn.addEventListener("click", cancelPick);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && box) {
      e.preventDefault();
      void confirmSelection((msg) => {
        barHint.textContent = msg;
      });
    }
  });

  // ── relayout on resize / DPI change (mixed-DPI monitor moves included) ──
  window.addEventListener("resize", layout);
  const armDpr = () => {
    const mq = window.matchMedia(`(resolution: ${dpr()}dppx)`);
    const onChange = () => {
      mq.removeEventListener("change", onChange);
      layout();
      armDpr();
    };
    mq.addEventListener("change", onChange);
  };
  armDpr();

  // Suggested selection: the detected table — one Enter away, and a visible
  // reference while dragging a correction.
  if (table && table.width > MIN_PHYSICAL && table.height > MIN_PHYSICAL) {
    box = { x: table.x, y: table.y, w: table.width, h: table.height };
  }
  // The image may decode async; layout once the box is measurable and again
  // on decode (dimensions are canvas-driven, so decode only affects paint).
  layout();
  frame.addEventListener("load", layout);
  // Best-effort cleanup (the window is normally destroyed by Rust).
  window.addEventListener("beforeunload", () => clearInterval(ageTimer));
}

// ─── Boot ─────────────────────────────────────────────────────────────────
async function boot() {
  let ctx: ManualLocateContext | null = null;
  if (tauri) {
    try {
      ctx = (await tauri.core.invoke("manual_locate_context")) as ManualLocateContext | null;
    } catch (err) {
      console.warn("[manual-locate] context unavailable:", err);
    }
  }
  const hasImage =
    !!ctx?.imageBase64 && (ctx.physWidth ?? 0) > 0 && (ctx.physHeight ?? 0) > 0;
  // The Rust side already placed THIS window for screenshot mode; if the
  // frame it decided on is somehow unusable by load time (game window
  // resized between the two calls), falling back to live mode would submit
  // coordinates from a window that is NOT aligned to the game rect — close
  // instead, so a retry re-decides the mode cleanly.
  if (!hasImage && new URLSearchParams(window.location.search).get("mode") === "shot") {
    cancelPick();
    return;
  }
  if (hasImage && ctx) {
    buildScreenshotMode(ctx);
  } else {
    buildLiveMode();
  }
}
void boot();
