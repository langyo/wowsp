/**
 * Shared map-name helpers: localized map display names resolved from a
 * space id, plus the game install's replays directory. Extracted from
 * ReplayView so the other map-centric surfaces (tactics analysis, live
 * battle) resolve names through the same authoritative catalog.
 */
import { t } from "@/i18n";

import mapNamesRaw from "@/data/map_names.json";

/** The replays subfolder of a client install. WoWS writes replays under
 *  `<install>/replays/`. */
export function replaysDir(installPath: string): string {
  const trimmed = installPath.replace(/[\\/]+$/, "");
  return `${trimmed}/replays`;
}

/** Official map display names extracted from the game's gettext catalogs
 *  (`scripts/model_convert/extract_map_names.py`): space id → {lang: name}.
 *  Space ids often DON'T match the display name (WG renamed maps but kept
 *  the internal id — "20_NE_two_brothers" is "双峰海峡"/"Two Brothers", not
 *  "两兄弟"), so the catalog is authoritative. */
export const MAP_NAMES = mapNamesRaw as Record<string, Record<string, string>>;

export function mapNameForLang(spaceId: string, lang: string): string | null {
  const names = MAP_NAMES[spaceId];
  if (!names) return null;
  // Take the exact server language first (国服 zh-cn and 亚服 zh-sg are
  // different official translations, e.g. 断层线 vs 海神之击). Never fall
  // back across servers — if the chosen language lacks an entry (e.g. the
  // official zh-tw catalog keeps map names in English), use English, not
  // the other server's name.
  return names[lang] ?? names["en"] ?? null;
}

/** Resolve a map's localized display name from its internal space id. Falls
 *  back to the prettified id, then to the unknown-map label. */
export function displayMapName(spaceId?: string | null, lang?: string): string {
  if (!spaceId) return t("replay.map.unknown");
  const clean = spaceId.replace(/^spaces\//, "");
  const official = mapNameForLang(clean, lang ?? "");
  if (official) return official;
  const key = `replay.map.names.${clean}`;
  const lbl = t(key);
  return lbl === key ? clean : lbl;
}
