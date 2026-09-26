/**
 * Plan-slot storage: one map can carry SEVERAL tactical plans (variants of
 * a setup to compare in a clan briefing). Slot "0" is the legacy single
 * plan — its document keeps living under the original `tactics:<space>` key,
 * so existing authors' boards upgrade in place — while added slots get
 * `#<id>`-suffixed keys of their own. The slot inventory itself is one
 * small JSON list per space, stored beside the documents.
 */
import { docStorageKey } from "./model";

export interface PlanSlot {
  id: string;
  /** Author-given name; "" = display as "Plan N" at render time. */
  name: string;
}

/** Legacy/default slot id: its document lives under the unsuffixed key. */
export const DEFAULT_SLOT_ID = "0";

function slotsKey(spaceId: string): string {
  return docStorageKey(`tactics-slots:${spaceId}`);
}

/** Storage path of a slot's tactical document (what TacticalBoard's store
 *  persists under). */
export function slotDocPath(spaceId: string, slotId: string): string {
  return slotId === DEFAULT_SLOT_ID ? `tactics:${spaceId}` : `tactics:${spaceId}#${slotId}`;
}

export function loadSlots(spaceId: string): PlanSlot[] {
  try {
    const raw = window.localStorage.getItem(slotsKey(spaceId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) {
      const slots = parsed.filter(
        (s): s is PlanSlot =>
          typeof s === "object" &&
          s != null &&
          typeof (s as PlanSlot).id === "string" &&
          typeof (s as PlanSlot).name === "string",
      );
      if (slots.length > 0) return slots;
    }
  } catch {
    // unreadable/corrupt inventory — fall through to the default
  }
  return [{ id: DEFAULT_SLOT_ID, name: "" }];
}

export function saveSlots(spaceId: string, slots: PlanSlot[]): void {
  try {
    window.localStorage.setItem(slotsKey(spaceId), JSON.stringify(slots));
  } catch {
    // storage full/disabled — the inventory stays for this session only
  }
}

/** Smallest positive integer id not in use (0 is the legacy slot). */
export function nextSlotId(slots: PlanSlot[]): string {
  let n = 1;
  while (slots.some((s) => s.id === String(n))) n++;
  return String(n);
}

/** Copy one slot's persisted document into another slot's key (duplicate). */
export function duplicateSlotDoc(spaceId: string, fromId: string, toId: string): void {
  try {
    const raw = window.localStorage.getItem(docStorageKey(slotDocPath(spaceId, fromId)));
    if (raw == null) return;
    window.localStorage.setItem(docStorageKey(slotDocPath(spaceId, toId)), raw);
  } catch {
    // best effort — a failed copy just starts the new slot empty
  }
}

export function deleteSlotDoc(spaceId: string, slotId: string): void {
  try {
    window.localStorage.removeItem(docStorageKey(slotDocPath(spaceId, slotId)));
  } catch {
    // already gone
  }
}
