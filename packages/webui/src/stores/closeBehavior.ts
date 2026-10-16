import { defineStore } from "pinia";
import { ref } from "vue";

/** What the window close button does. "ask" is never written to storage —
 *  it IS the absence of the key, so builds that only understand the two
 *  concrete actions keep working against the same slot. */
export type CloseAction = "ask" | "minimize" | "quit";

/** The persisted slot, shared with the close dialog in AppShell. The string
 *  is already shipped in the wild — never change it. */
export const CLOSE_ACTION_STORAGE_KEY = "wowsp-close-action";

/** Read the remembered close action, sweeping junk: a stale value would
 *  otherwise re-fail validation on every single close instead of landing
 *  back on the ask dialog. Missing key = first run = "ask". Storage that
 *  throws degrades to "ask" for the session. */
export function loadCloseAction(): CloseAction {
  try {
    const raw = localStorage.getItem(CLOSE_ACTION_STORAGE_KEY);
    if (raw === "minimize" || raw === "quit") return raw;
    if (raw != null) localStorage.removeItem(CLOSE_ACTION_STORAGE_KEY);
    return "ask";
  } catch {
    return "ask";
  }
}

/** Persist one action. "ask" removes the key rather than writing the string
 *  — absent IS the ask state, and older builds only understand the two
 *  concrete values. Failures are silent: the choice holds for the session. */
function persist(action: CloseAction): void {
  try {
    if (action === "ask") localStorage.removeItem(CLOSE_ACTION_STORAGE_KEY);
    else localStorage.setItem(CLOSE_ACTION_STORAGE_KEY, action);
  } catch {
    // see loadCloseAction
  }
}

/** App-wide source of truth as a MODULE-level ref (not store-owned state):
 *  the loader runs at import time, so the remembered action is hydrated
 *  before any component mounts — a close request can arrive before the
 *  settings surface (the only other writer) was ever opened. */
export const closeActionState = ref<CloseAction>(loadCloseAction());

/** The remembered close action, written by the AppShell close dialog's
 *  "remember my choice" checkbox and by the Settings → closeBehavior radio,
 *  which is the only way to change or clear a one-way remembered choice. */
export const useCloseBehaviorStore = defineStore("closeBehavior", () => {
  /** Shared with the module-level ref — the store is the write API. */
  const action = closeActionState;

  function setAction(a: CloseAction) {
    action.value = a;
    persist(a);
  }

  return { action, setAction };
});
