/** Ship acquisition sources for the pickers' 来源 filter.
 *
 *  Three of the five tags derive from data the app already carries:
 *  - `tree`  — the ship is a node in tech_tree.json (the researchable
 *              silver line, superships included);
 *  - `event` — the tech-tree node is still in its early-access group, or
 *              the curated table tags it (Halloween/space clones etc.);
 *  - `gold`  — the encyclopedia row's isPremium flag.
 *  `coal` and `steel` exist nowhere in GameParams or the WG API — they
 *  come from the curated ship_sources.json (name-keyed, matched against
 *  every locale the offline db carries plus the API display name), which
 *  the maintainer extends by hand.
 *
 *  Tags are ADDITIVE: a ship commonly holds several at once (a coal ship
 *  that is also sold for gold), so the filter tests membership, not
 *  equality. */
import techTree from "@/data/tech_tree.json";
import sourcesDoc from "@/data/ship_sources.json";
import shipNamesDb from "@/data/ship_names.json";

export type ShipSource = "tree" | "gold" | "coal" | "steel" | "event";

export const SHIP_SOURCES: readonly ShipSource[] = [
  "tree",
  "gold",
  "coal",
  "steel",
  "event",
];

const TREE_IDS = new Set<string>();
const EARLY_ACCESS_IDS = new Set<string>();
for (const [id, node] of Object.entries(techTree)) {
  TREE_IDS.add(id);
  if ((node as { group?: string }).group === "earlyAccess") {
    EARLY_ACCESS_IDS.add(id);
  }
}

const norm = (value: string) => value.trim().toLowerCase();

/** normalized name → curated tag (first tag wins on a duplicate name).
 *  The manual arrays are the maintainer's hand additions. */
const CURATED_BY_NAME = new Map<string, ShipSource>();
for (const tag of ["coal", "steel", "event"] as const) {
  for (const name of (sourcesDoc as unknown as { [k: string]: string[] })[tag] ?? []) {
    if (!CURATED_BY_NAME.has(norm(name))) CURATED_BY_NAME.set(norm(name), tag);
  }
}

/** The scraper's generated shipId → tags map (live armory regions +
 *  Wayback history union — see scripts/scrape_armory_sources.py). */
const GENERATED_BY_ID = new Map<string, ShipSource[]>(
  Object.entries(
    (sourcesDoc as unknown as { generated?: Record<string, string[]> }).generated ?? {},
  ).map(([id, tags]) => [id, tags.filter((t): t is ShipSource => (SHIP_SOURCES as readonly string[]).includes(t))]),
);

/** shipId → every normalized name the offline db carries for it. */
const NAMES_BY_SHIP = new Map<string, Set<string>>();
for (const [id, row] of Object.entries(shipNamesDb)) {
  const names = (row as { names?: Record<string, string> }).names ?? {};
  NAMES_BY_SHIP.set(
    id,
    new Set(Object.values(names).map((n) => norm(n))),
  );
}

/** The source set of one ship row (encyclopedia or any id/name shape). */
export function shipSourcesOf(ship: {
  shipId: number | string;
  name?: string | null;
  isPremium?: boolean | null;
}): Set<ShipSource> {
  const id = String(ship.shipId);
  const out = new Set<ShipSource>();
  if (EARLY_ACCESS_IDS.has(id)) out.add("event");
  else if (TREE_IDS.has(id)) out.add("tree");
  if (ship.isPremium) out.add("gold");
  const names = NAMES_BY_SHIP.get(id);
  if (names) {
    for (const name of names) {
      const tag = CURATED_BY_NAME.get(name);
      if (tag) out.add(tag);
    }
  }
  const apiTag = CURATED_BY_NAME.get(norm(ship.name ?? ""));
  if (apiTag) out.add(apiTag);
  for (const tag of GENERATED_BY_ID.get(String(ship.shipId)) ?? []) out.add(tag);
  return out;
}
