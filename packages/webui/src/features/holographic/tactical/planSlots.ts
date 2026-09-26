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

// ── Plan bundles: every slot of one map in a single shareable file ────────

/** One slot's payload inside a bundle (the tactical document itself). */
export interface PlanBundleEntry {
  name: string;
  doc: { version: number; elements: unknown[]; steps: unknown[] };
}

export interface PlanBundle {
  version: 1;
  kind: "wowsp-tactics-plans";
  /** Space the bundle was exported from — imports onto a different map are
   *  allowed (new/old map successions) but the caller should warn. */
  spaceId: string;
  exportedAt: string;
  slots: PlanBundleEntry[];
}

/** Assemble every slot of the map (inventory + documents) into a bundle. */
export function exportBundle(spaceId: string): PlanBundle {
  const slots = loadSlots(spaceId);
  return {
    version: 1,
    kind: "wowsp-tactics-plans",
    spaceId,
    exportedAt: new Date().toISOString(),
    slots: slots.map((s) => {
      let doc: PlanBundleEntry["doc"] = { version: 1, elements: [], steps: [] };
      try {
        const raw = window.localStorage.getItem(docStorageKey(slotDocPath(spaceId, s.id)));
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (
          typeof parsed === "object" && parsed != null &&
          Array.isArray((parsed as PlanBundleEntry["doc"]).elements) &&
          Array.isArray((parsed as PlanBundleEntry["doc"]).steps)
        ) {
          doc = parsed as PlanBundleEntry["doc"];
        }
      } catch {
        // unreadable slot ships as empty
      }
      return { name: s.name, doc };
    }),
  };
}

/** Structural check of a bundle file; null = not a tactics bundle. */
export function parseBundle(json: string): PlanBundle | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data == null) return null;
  const b = data as Partial<PlanBundle>;
  if (
    b.kind !== "wowsp-tactics-plans" ||
    b.version !== 1 ||
    !Array.isArray(b.slots) ||
    b.slots.length === 0
  ) {
    return null;
  }
  const slots: PlanBundleEntry[] = [];
  for (const entry of b.slots) {
    if (typeof entry !== "object" || entry == null) return null;
    const e = entry as Partial<PlanBundleEntry>;
    if (typeof e.name !== "string" || typeof e.doc !== "object" || e.doc == null) return null;
    if (!Array.isArray(e.doc.elements) || !Array.isArray(e.doc.steps)) return null;
    slots.push({ name: e.name, doc: { version: 1, elements: e.doc.elements, steps: e.doc.steps } });
  }
  return {
    version: 1,
    kind: "wowsp-tactics-plans",
    spaceId: typeof b.spaceId === "string" ? b.spaceId : "",
    exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : "",
    slots,
  };
}

/** Write a bundle into the map's plan storage: slots are renumbered from the
 *  default slot, every document lands under its key, the inventory is
 *  replaced, and stale keys of slots the bundle doesn't carry are removed. */
export function importBundle(spaceId: string, bundle: PlanBundle): void {
  const stale = loadSlots(spaceId)
    .filter((s) => s.id !== DEFAULT_SLOT_ID)
    .map((s) => s.id);
  const slots: PlanSlot[] = bundle.slots.map((entry, i) => {
    const id = String(i);
    try {
      window.localStorage.setItem(
        docStorageKey(slotDocPath(spaceId, id)),
        JSON.stringify({ ...entry.doc, version: 1 }),
      );
    } catch {
      // storage full — the slot shows empty rather than blocking the rest
    }
    return { id, name: entry.name };
  });
  saveSlots(spaceId, slots);
  for (const id of stale) {
    if (!slots.some((s) => s.id === id)) deleteSlotDoc(spaceId, id);
  }
}
