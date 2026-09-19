/**
 * Reactive tactical-board state: the element list, active tool, stroke look,
 * selection, undo/redo history and per-replay persistence. Rendering and
 * pointer interaction live in TacticalBoard.tsx; this composable is the
 * single source of truth for "what is on the board".
 */
import { computed, ref, watch, type Ref } from "vue";
import type { DashStyle, TacticalElement, TacticalToolId } from "./types";
import { docStorageKey, parseDoc, serializeDoc } from "./model";

export interface TacticalStyleState {
  color: string;
  width: number;
  dash: DashStyle;
}

/** Palette tuned for visibility over the game's dark minimap art. */
export const TACTICAL_PALETTE = [
  "#ffffff",
  "#f43f5e",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#22d3ee",
  "#60a5fa",
  "#a78bfa",
  "#f472b6",
  "#94a3b8",
] as const;

export const TACTICAL_WIDTHS = [2, 4, 7, 11] as const;

const HISTORY_LIMIT = 80;

export function useTactical(replayPath: Ref<string>) {
  const elements = ref<TacticalElement[]>([]);
  const tool = ref<TacticalToolId>("select");
  const style = ref<TacticalStyleState>({ color: "#f43f5e", width: 4, dash: "solid" });
  const selectedId = ref<string | null>(null);
  /** New elements get t0 = current replay time (slide-deck anchoring). */
  const anchorToTime = ref(true);
  /** Reveal not-yet-reached elements as faint ghosts while scrubbing. */
  const showGhostFuture = ref(true);

  const canUndo = ref(false);
  const canRedo = ref(false);
  const undoStack: string[] = [];
  const redoStack: string[] = [];

  function snapshot(): string {
    return serializeDoc({ version: 1, elements: elements.value });
  }
  function syncHistoryFlags(): void {
    canUndo.value = undoStack.length > 0;
    canRedo.value = redoStack.length > 0;
  }
  /** Snapshot the pre-mutation state (call once per user action). */
  function pushHistory(): void {
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    syncHistoryFlags();
  }
  function undo(): void {
    const prev = undoStack.pop();
    if (prev == null) return;
    redoStack.push(snapshot());
    applySnapshot(prev);
    syncHistoryFlags();
  }
  function redo(): void {
    const next = redoStack.pop();
    if (next == null) return;
    undoStack.push(snapshot());
    applySnapshot(next);
    syncHistoryFlags();
  }
  function applySnapshot(json: string): void {
    const doc = parseDoc(json);
    if (doc) elements.value = doc.elements;
    if (selectedId.value && !elements.value.some((el) => el.id === selectedId.value)) {
      selectedId.value = null;
    }
  }

  /** Add a finished element (history snapshot taken). */
  function commit(el: TacticalElement): void {
    pushHistory();
    elements.value = [...elements.value, el];
    selectedId.value = el.id;
  }
  /** Replace an element in place WITHOUT a history snapshot (live drags
   *  snapshot once at gesture start via `pushHistory`). */
  function replaceElement(id: string, next: TacticalElement): void {
    elements.value = elements.value.map((el) => (el.id === id ? next : el));
  }
  function removeElement(id: string): void {
    if (!elements.value.some((el) => el.id === id)) return;
    pushHistory();
    elements.value = elements.value.filter((el) => el.id !== id);
    if (selectedId.value === id) selectedId.value = null;
  }
  function clearAll(): void {
    if (elements.value.length === 0) return;
    pushHistory();
    elements.value = [];
    selectedId.value = null;
  }

  const selected = computed(() =>
    selectedId.value ? elements.value.find((el) => el.id === selectedId.value) ?? null : null,
  );

  // ── Persistence (per replay path, debounced) ──────────────────────────
  // Debounced persistence. The snapshot (path + doc) is captured when the
  // edit happens, so a timer that survives a replay switch still writes the
  // OLD replay's data under the OLD key — and `load` flushes it first.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave: { path: string; json: string } | null = null;
  function writePending(): void {
    if (!pendingSave) return;
    const { path, json } = pendingSave;
    pendingSave = null;
    try {
      window.localStorage.setItem(docStorageKey(path), json);
    } catch {
      // Storage full / disabled — the board stays in-memory for this view.
    }
  }
  function persist(): void {
    pendingSave = {
      path: replayPath.value,
      json: serializeDoc({ version: 1, elements: elements.value }),
    };
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writePending();
    }, 400);
  }
  function load(): void {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writePending();
    try {
      const raw = window.localStorage.getItem(docStorageKey(replayPath.value));
      const doc = raw ? parseDoc(raw) : null;
      elements.value = doc ? doc.elements : [];
      undoStack.length = 0;
      redoStack.length = 0;
      syncHistoryFlags();
    } catch {
      elements.value = [];
    }
  }

  watch(replayPath, load, { immediate: true });
  watch(elements, persist, { deep: true });

  return {
    elements,
    tool,
    style,
    selectedId,
    selected,
    anchorToTime,
    showGhostFuture,
    canUndo,
    canRedo,
    pushHistory,
    undo,
    redo,
    commit,
    replaceElement,
    removeElement,
    clearAll,
  };
}

export type TacticalStore = ReturnType<typeof useTactical>;
