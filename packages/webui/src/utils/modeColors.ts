/**
 * WoWS battle-mode colours for replay pills / tags.
 *
 * The game client tints each battle type distinctly in its battle picker; we
 * mirror those hues so a replay's mode is recognisable at a glance without
 * reading the text. These are calibrated to the in-game palette (community
 * reference; WG does not publish hex values):
 *
 *   Random (pvp)      pink/magenta
 *   Ranked            dark red
 *   Clan              purple
 *   Co-op / PvE       green
 *   Brawl             orange
 *   Event / Convoy    gold
 *   Training / Sandbox grey
 *   Squad / Asymmetric blue
 *
 * `modeColor(group)` returns a {background, color, borderColor} style object
 * ready to spread onto an element's `style`. Unknown modes fall back to the
 * accent gold. Variant modes (ranked_solo, ranked_sprint, pve_event, …) inherit
 * their parent mode's colour via the normalisation step.
 */

export interface ModeColor {
  background: string;
  color: string;
  borderColor: string;
}

/** Raw hex per canonical mode (without the leading #). */
const MODE_HEX: Record<string, string> = {
  pvp: "e756a3", // Random — pink/magenta
  ranked: "c43030", // Ranked — dark red
  clan: "8a4fff", // Clan battle — purple
  cooperative: "3cb478", // Co-op — green
  pve: "3cb478", // PvE (alt key for co-op) — green
  brawl: "e67e22", // Brawl — orange
  event: "e6a817", // Event / operation — gold
  pve_event: "e6a817", // PvE event — gold
  convoy: "e6a817", // Convoy escort — gold
  training: "8a8a8a", // Training — grey
  sandbox: "8a8a8a", // Sandbox — grey
  squad: "0078c8", // Squad battle — blue
  asymmetric: "0078c8", // Asymmetric — blue
};

/** Normalise a raw matchGroup string to its canonical mode key, so that
 *  variants (ranked_solo, ranked_sprint, …) inherit their parent's colour. */
function canonicalMode(group: string): string {
  const g = group.toLowerCase();
  if (MODE_HEX[g]) return g;
  // Ranked variants → ranked; PvE variants → pve; event variants → event.
  if (g.startsWith("ranked")) return "ranked";
  if (g.startsWith("pve")) return "pve";
  if (g.includes("event")) return "event";
  if (g.includes("convoy")) return "convoy";
  if (g.includes("clan")) return "clan";
  if (g.includes("brawl")) return "brawl";
  if (g.includes("train") || g.includes("sandbox")) return "training";
  if (g.includes("squad") || g.includes("asym")) return "squad";
  if (g === "pvp" || g.includes("random")) return "pvp";
  if (g.includes("coop") || g.includes("cooperative")) return "cooperative";
  return "";
}

/** Fallback colour (accent gold) for unknown modes. */
const FALLBACK_HEX = "e6a817";

/** Resolve the colour triple for a matchGroup. Unknown / null modes fall back
 *  to accent gold so the pill always has a colour. */
export function modeColor(group?: string | null): ModeColor {
  const key = group ? canonicalMode(group) : "";
  const hex = (key && MODE_HEX[key]) || FALLBACK_HEX;
  return {
    background: `rgb(${parseHex(hex)} / 18%)`,
    color: `#${hex}`,
    borderColor: `rgb(${parseHex(hex)} / 45%)`,
  };
}

/** "rrggbb" → "r g b" (space-separated decimal, for use in rgb() with /alpha). */
function parseHex(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}
