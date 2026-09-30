/**
 * The spaces /tactics can actually board: catalog battle maps (not a
 * harbor) that carry bundled minimap art — exactly the inventory the
 * tactics rail lists, in rail order. One source of truth shared by
 * TacticsView and the map-name tag, so the tag only promises a jump when
 * the board can receive it.
 */
import { resolveMapMinimapUrl } from "@/features/holographic/modelLoader";
import { MAP_NAMES } from "@/utils/mapNames";
import { battleMapIds } from "@/utils/mapModes";

export const ANALYSABLE_SPACE_IDS: readonly string[] = battleMapIds(
  Object.keys(MAP_NAMES),
  (id) => resolveMapMinimapUrl(id) !== null,
);

const ANALYSABLE = new Set(ANALYSABLE_SPACE_IDS);

export function isAnalysableSpace(spaceId: string): boolean {
  return ANALYSABLE.has(spaceId);
}
