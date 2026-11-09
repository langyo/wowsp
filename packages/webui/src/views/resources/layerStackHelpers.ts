/** Pure helpers behind the layered resource-pack swimlane: ordering,
 *  legacy pinning, row badges and the render report's conflict-path fold.
 *  Kept free of IPC and Vue state so layerStackHelpers.test.ts can pin the
 *  rules the UI and the reorder call share. */
import type {
  LayerPathWinner,
  LayerSlotConflict,
  ModKind,
  ModLayer,
} from "@/api";
import { KIND_ORDER, isCatalogCat } from "@/features/modhub/taxonomy";

/** One row badge, language-neutral: the component maps the key through
 *  `resources.layers.*` and renders `count` where present. */
export type LayerBadgeKey = "shadowed" | "slotConflict" | "unmanaged" | "pending";

export interface LayerBadge {
  key: LayerBadgeKey;
  count?: number;
}

/** Row badges for one layer, in visual priority order. `rendered=false`
 *  means the saved order is not in the game yet, so every row carries the
 *  pending dot (the stack-level banner carries the action). */
export function layerBadges(
  layer: ModLayer,
  options: { rendered: boolean; conflicts: LayerSlotConflict[] },
): LayerBadge[] {
  const badges: LayerBadge[] = [];
  if (layer.shadowedCount > 0) {
    badges.push({ key: "shadowed", count: layer.shadowedCount });
  }
  if (options.conflicts.some((c) => c.packIds.includes(layer.packId))) {
    badges.push({ key: "slotConflict" });
  }
  if (!layer.managed) badges.push({ key: "unmanaged" });
  if (!options.rendered) badges.push({ key: "pending" });
  return badges;
}

/** Slot conflicts that name this layer. */
export function conflictsOfLayer(
  layer: ModLayer,
  conflicts: LayerSlotConflict[],
): LayerSlotConflict[] {
  return conflicts.filter((c) => c.packIds.includes(layer.packId));
}

/** Reorder a list by packId, appending any layer whose id is absent from
 *  `packIds` (a stale rename must not silently drop a row). */
export function orderLayers<T extends { packId: string }>(
  layers: T[],
  packIds: string[],
): T[] {
  const byId = new Map(layers.map((layer) => [layer.packId, layer]));
  const out: T[] = [];
  for (const id of packIds) {
    const layer = byId.get(id);
    if (!layer) continue;
    out.push(layer);
    byId.delete(id);
  }
  for (const layer of layers) {
    if (byId.has(layer.packId)) out.push(layer);
  }
  return out;
}

/** Apply a HkDraggableList reorder (from/to indexes) to a copied list. */
export function moveLayer<T>(layers: T[], from: number, to: number): T[] {
  const next = [...layers];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Legacy layers (managed=false) are pinned at the bottom and can never be
 *  dragged, but another row may be dropped BELOW one during a drag; this
 *  stable partition keeps the backend's pinning rule visible in the
 *  optimistic order too. */
export function normalizeLayerOrder<T extends { managed: boolean }>(layers: T[]): T[] {
  const managed = layers.filter((layer) => layer.managed);
  const legacy = layers.filter((layer) => !layer.managed);
  return [...managed, ...legacy];
}

/** The report modal's conflict list: only paths something shadows or a
 *  foreign file occupies, capped with the total kept for the "showing N
 *  of M" line. */
export function conflictPaths(
  paths: LayerPathWinner[],
  limit = 200,
): { rows: LayerPathWinner[]; total: number } {
  const hits = paths.filter((p) => p.shadowed.length > 0 || p.foreign);
  return { rows: hits.slice(0, limit), total: hits.length };
}

/** i18n key for a layer's category label: catalog categories first (the
 *  online index vocabulary), then the on-disk kind vocabulary. Null means
 *  the caller renders the raw code (a future value the locales predate). */
export function layerCategoryKey(category: string): string | null {
  if (isCatalogCat(category)) return `resources.cat.${category}`;
  if ((KIND_ORDER as string[]).includes(category)) {
    return `resources.kind.${category as ModKind}`;
  }
  return null;
}
