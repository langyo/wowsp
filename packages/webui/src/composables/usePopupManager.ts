import { readonly, ref } from "vue";
import { uuidv7 } from "@/utils/uuid";

export type PopupKind = "dropdown" | "modal" | "drawer" | "tooltip" | "toast";

interface PopupEntry {
  id: string;
  kind: PopupKind;
  locksScroll: boolean;
  zIndex: number;
  title?: string;
}

const Z_BASE = 1000;
const Z_STEP = 2;
const registry = ref<Map<string, PopupEntry>>(new Map());
let nextZ = Z_BASE;
let scrollLockCount = 0;

function updateBodyScroll() {
  document.body.style.overflow = scrollLockCount > 0 ? "hidden" : "";
}

export interface PopupHandle {
  id: string;
  zIndex: number;
}

export function usePopupManager() {
  function register(kind: PopupKind, locksScroll = false, title?: string): PopupHandle {
    const id = uuidv7();
    const zIndex = nextZ;
    nextZ += Z_STEP;
    registry.value.set(id, { id, kind, locksScroll, zIndex, title });
    if (locksScroll) {
      scrollLockCount++;
      updateBodyScroll();
    }
    return { id, zIndex };
  }

  function setTitle(id: string, title: string) {
    const entry = registry.value.get(id);
    if (!entry) return;
    entry.title = title;
    registry.value = new Map(registry.value);
  }

  function unregister(id: string) {
    const entry = registry.value.get(id);
    if (!entry) return;
    registry.value.delete(id);
    if (entry.locksScroll) {
      scrollLockCount = Math.max(0, scrollLockCount - 1);
      updateBodyScroll();
    }
    if (registry.value.size === 0) nextZ = Z_BASE;
  }

  return { registry: readonly(registry), register, setTitle, unregister };
}
