/**
 * Manual-locate picker window bootstrap — deliberately NOT Vue (same
 * rationale as the overlay page): the window covers the game the moment the
 * user clicks "manual locate" and must paint instantly.
 *
 * Interaction contract (screenshot-style drag box):
 *   - press + drag anywhere → draw the selection rectangle (dashed border,
 *     lighter wash inside); a live W×H readout (physical game px) follows;
 *   - release → Confirm / Cancel buttons appear inside the selection (a box
 *     below the 32-physical-px minimum is treated as a mis-click: it resets
 *     and flashes a "too small" notice instead of failing silently later);
 *   - Enter = confirm, Esc = cancel (always — Esc must never get stuck);
 *   - confirm submits the selection in PHYSICAL px relative to the game
 *     window origin via `set_manual_roster_rect` (the Rust side validates,
 *     stores the manual anchor, and destroys this window); cancel invokes
 *     `cancel_manual_locate` which destroys it without storing.
 *
 * CSS px → physical px = × devicePixelRatio: the picker window is placed by
 * Rust exactly over the game rect in physical pixels, so page coordinates
 * scale 1:1 with the game's framebuffer.
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
interface LiveCopy {
  manualDragHint: string;
  manualConfirm: string;
  manualCancel: string;
  manualTooSmall: string;
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
    live.manualTooSmall
  ) {
    messages.set(m[1], {
      manualDragHint: live.manualDragHint,
      manualConfirm: live.manualConfirm,
      manualCancel: live.manualCancel,
      manualTooSmall: live.manualTooSmall,
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
    }
  );
}

// ─── DOM (all built here; the html file is an empty shell) ────────────────
const copy = localizedCopy();

const dim = document.createElement("div");
dim.className = "ml-dim";

const hint = document.createElement("div");
hint.className = "ml-hint";
hint.textContent = copy.manualDragHint;

const selection = document.createElement("div");
selection.className = "ml-selection";
selection.hidden = true;

const sizeLabel = document.createElement("div");
sizeLabel.className = "ml-size";
sizeLabel.hidden = true;

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

// ─── Selection state ──────────────────────────────────────────────────────
/** Minimum selection size per axis in PHYSICAL px — mirrors the Rust-side
 *  `MANUAL_MIN_SIZE` gate in `set_manual_roster_rect` exactly, so a box this
 *  page accepts can never be refused by the backend. */
const MIN_PHYSICAL = 32;

/** Drag origin in CSS px, null while no drag is in progress. */
let dragStart: { x: number; y: number } | null = null;
/** Last drawn selection in CSS px (page coords = game-window coords). */
let box: { x: number; y: number; w: number; h: number } | null = null;
/** Guards a double confirm (double Enter / button + Enter race). */
let submitting = false;
/** Pending "too small" flash — a new drag cancels the revert. */
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function dpr(): number {
  return window.devicePixelRatio || 1;
}

function hideButtons() {
  buttons.hidden = true;
}

function showHint(text: string) {
  hint.textContent = text;
  hint.hidden = false;
}

function showDragHint() {
  showHint(copy.manualDragHint);
}

/** Back to the pre-drag stage: no selection, drag hint visible. */
function resetToHint() {
  box = null;
  selection.hidden = true;
  sizeLabel.hidden = true;
  hideButtons();
}

/** Mis-click below the Rust-side minimum: say so, then restore the drag
 *  hint shortly (a new drag or a real selection cancels the revert). */
function flashTooSmall() {
  showHint(copy.manualTooSmall);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    if (!dragStart && !box) showDragHint();
  }, 1400);
}

function showSelection(r: { x: number; y: number; w: number; h: number }) {
  selection.hidden = false;
  selection.style.left = `${r.x}px`;
  selection.style.top = `${r.y}px`;
  selection.style.width = `${r.w}px`;
  selection.style.height = `${r.h}px`;
}

/** Update the box from the current drag; renders selection + live size. */
function updateBox(origin: { x: number; y: number }, cur: { x: number; y: number }) {
  box = {
    x: Math.min(origin.x, cur.x),
    y: Math.min(origin.y, cur.y),
    w: Math.abs(origin.x - cur.x),
    h: Math.abs(origin.y - cur.y),
  };
  showSelection(box);
  // The readout is PHYSICAL px — the unit actually submitted to Rust and the
  // unit the game renders in.
  sizeLabel.hidden = false;
  sizeLabel.textContent = `${Math.round(box.w * dpr())} × ${Math.round(box.h * dpr())}`;
  sizeLabel.style.left = `${box.x}px`;
  sizeLabel.style.top = `${Math.max(0, box.y - 24)}px`;
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement | null)?.closest("button")) return; // buttons drag nothing
  dragStart = { x: e.clientX, y: e.clientY };
  document.body.setPointerCapture(e.pointerId);
  hideButtons();
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  hint.hidden = true;
  updateBox(dragStart, dragStart);
}

function onPointerMove(e: PointerEvent) {
  if (!dragStart) return;
  updateBox(dragStart, { x: e.clientX, y: e.clientY });
}

function onPointerUp(e: PointerEvent) {
  if (!dragStart) return;
  dragStart = null;
  document.body.releasePointerCapture(e.pointerId);
  if (!box || box.w < 4 || box.h < 4) {
    // Stray click, not a drag — reset to the hint stage.
    resetToHint();
    showDragHint();
    return;
  }
  const scale = dpr();
  if (Math.round(box.w * scale) <= MIN_PHYSICAL || Math.round(box.h * scale) <= MIN_PHYSICAL) {
    // Below the backend's minimum: reset NOW with a visible notice instead
    // of letting set_manual_roster_rect reject the submit silently later.
    resetToHint();
    flashTooSmall();
    return;
  }
  // Buttons sit INSIDE the selection's top-left corner (standard screenshot
  // picker placement).
  buttons.hidden = false;
  buttons.style.left = `${box.x + 8}px`;
  buttons.style.top = `${box.y + 8}px`;
}

async function confirmSelection() {
  if (submitting || !box || box.w < 4 || box.h < 4 || !tauri) return;
  const scale = dpr();
  const phys = {
    x: Math.round(box.x * scale),
    y: Math.round(box.y * scale),
    width: Math.round(box.w * scale),
    height: Math.round(box.h * scale),
  };
  // Defensive (mouseup already filters): never submit a sub-minimum box.
  if (phys.width <= MIN_PHYSICAL || phys.height <= MIN_PHYSICAL) {
    flashTooSmall();
    return;
  }
  submitting = true;
  try {
    await tauri.core.invoke("set_manual_roster_rect", phys);
    // Success: Rust destroys this window. Nothing to do here — and no
    // further input must be accepted meanwhile (`submitting` stays true).
  } catch (err) {
    // Validation failed (too small / no battle / game gone). Keep the
    // picker open so the user can retry or hit Esc — but surface the reason
    // in the hint area instead of failing silently. It stays until the next
    // drag (or mis-click reset) refreshes the copy.
    submitting = false;
    showHint(err instanceof Error ? err.message : String(err));
  }
}

function cancelPick() {
  // Fire-and-forget: the Rust side destroys the window. A failed invoke
  // means it was already gone.
  void tauri?.core.invoke("cancel_manual_locate").catch(() => {});
}

confirmBtn.addEventListener("click", () => void confirmSelection());
cancelBtn.addEventListener("click", cancelPick);
document.body.addEventListener("pointerdown", onPointerDown);
document.body.addEventListener("pointermove", onPointerMove);
document.body.addEventListener("pointerup", onPointerUp);

window.addEventListener("keydown", (e) => {
  // Esc must ALWAYS be an exit — mid-drag included.
  if (e.key === "Escape") {
    e.preventDefault();
    cancelPick();
  } else if (e.key === "Enter" && !buttons.hidden) {
    e.preventDefault();
    void confirmSelection();
  }
});
