/**
 * Stale-bin migration wizard: display-name resolution for plan files.
 *
 * The backend hands the wizard raw res_mods-relative paths only. To make the
 * decide list readable, each path is matched against two offline sources —
 * the online catalog already loaded by the resources view (catalog ids like
 * `battle.calculator.penetration` vs path segments such as
 * `PnFMods/<DirName>/...`) and a built-in alias table for the Aslain
 * modpack's well-known directory names. Everything here is pure and
 * dependency-free so migrateIdentity.test.ts can pin the matching order:
 * catalog two-segment hint, catalog one-segment hint, then the alias table;
 * unmatched paths stay raw.
 */
import type { CatalogEntry } from "@/api";

/**
 * Known Aslain modpack directory names → human display names. Each entry
 * gets its own name (no generic "Aslain 功能模组" buckets): the stale tree
 * was installed by the Aslain modpack, whose directories carry stable
 * CamelCase names the catalog ids do not cover.
 */
export const DIR_ALIASES: Record<string, string> = {
  advancedtorpedomarkerpy: "Advanced Torpedo Marker",
  consumablesmonitor2py: "Consumables Monitor",
  regenmonitorpy: "Regen Monitor",
  intuitions: "Intuition Alerts",
  minimapsubpingerpy: "Minimap Submarine Pinger",
  modulestateviewerpy: "Module State Viewer",
  penetrationcalculatorpy: "Penetration Calculator",
  buildviewerpy: "Build Viewer",
  battleframe_torpedoes: "Battle Frame: Torpedo HUD",
  teamhp: "Team HP Panels",
  threedimentionalhydro: "3D Hydroacoustic Search",
};

/**
 * Versioned Aslain directories whose name embeds a pack version (e.g.
 * `ModsInstaller_4_3_1`) — matched by prefix after the exact alias table.
 */
const DIR_PREFIX_ALIASES: ReadonlyArray<{ prefix: string; name: string }> = [
  { prefix: "modsinstaller", name: "Aslain Modpack Installer" },
];

/**
 * Directory hints derived from a dotted catalog id: the last two segments
 * joined (`battle.calculator.penetration` → `calculator.penetration`) and
 * the last segment alone (`penetration`), lowercased for path matching.
 */
export function idHints(id: string): string[] {
  const segs = id
    .split(".")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const hints: string[] = [];
  if (segs.length >= 2) hints.push(segs.slice(-2).join("."));
  if (segs.length >= 1 && !hints.includes(segs[segs.length - 1])) {
    hints.push(segs[segs.length - 1]);
  }
  return hints;
}

/** Lowercased segments of a res_mods-relative path (forward slashes). */
function pathSegments(path: string): string[] {
  return path
    .split(/[/\\]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/** Two-segment hint match: the hint equals a whole segment (directories can
 *  carry the dotted slug themselves, `PnFMods/calculator.penetration/...`)
 *  or a consecutive segment pair joined by a dot. */
function matchTwoSegHint(segs: string[], hint: string): boolean {
  if (segs.includes(hint)) return true;
  for (let i = 0; i + 1 < segs.length; i++) {
    if (`${segs[i]}.${segs[i + 1]}` === hint) return true;
  }
  return false;
}

/** Alias-table lookup over the path's segments (exact, then the versioned
 *  prefix families). */
function matchAlias(segs: string[]): string | null {
  for (const seg of segs) {
    const hit = DIR_ALIASES[seg];
    if (hit) return hit;
    const prefixed = DIR_PREFIX_ALIASES.find((p) => seg.startsWith(p.prefix));
    if (prefixed) return prefixed.name;
  }
  return null;
}

/**
 * Resolve the display identity of one plan file. Catalog entries are tried
 * most-specific-first (two-segment id hint, then the bare last segment);
 * the built-in Aslain alias table is the offline fallback. `nameOf` lets
 * the caller localize the matched entry; returns null when nothing matches
 * (the UI then shows the raw path).
 */
export function resolveIdentity(
  path: string,
  entries: readonly CatalogEntry[],
  nameOf: (entry: CatalogEntry) => string,
): string | null {
  const segs = pathSegments(path);
  if (segs.length === 0) return null;
  // Catalog pass — most specific hint first, catalog order breaks ties.
  for (const entry of entries) {
    const hints = idHints(entry.id);
    if (hints[0] && matchTwoSegHint(segs, hints[0])) return nameOf(entry);
  }
  for (const entry of entries) {
    const hints = idHints(entry.id);
    const single = hints.length >= 2 ? hints[1] : hints[0];
    if (single && segs.includes(single)) return nameOf(entry);
  }
  return matchAlias(segs);
}
