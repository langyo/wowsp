/**
 * WoWS battle-mode keys + colours for replay pills / tags.
 *
 * Mode identity is layered in the replay descriptor:
 *   - matchGroup  — coarse bucket (pvp / ranked / clan / event / brawl / pve)
 *   - scenario    — scenario name (domination_3point, asymm_3point_coop, ...)
 *   - eventType   — GameParams BattleScript id (PCVE027 = EV27AsymCoop, ...)
 *
 * The eventType is the most specific signal (a WG battle-script id); scenario
 * is next; matchGroup is the fallback. This lets us label a battle "Asymmetric"
 * even though its matchGroup is just "event".
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
  event: "e6a817", // Event — gold
  pve_event: "e6a817", // PvE event — gold
  convoy: "e6a817", // Convoy escort — gold
  training: "8a8a8a", // Training — grey
  sandbox: "8a8a8a", // Sandbox — grey
  squad: "0078c8", // Squad battle — blue
  asymmetric: "0078c8", // Asymmetric — blue
  armsrace: "e756a3", // Arms race — pink (random-like)
  operation: "e6a817", // Operation — gold
  halloween: "8a4fff", // Halloween — purple
};

/** Fallback colour (accent gold) for unknown modes. */
const FALLBACK_HEX = "e6a817";

/**
 * Resolve a battle's canonical mode key from its layered identity fields.
 * Battle-script (eventType) wins, then scenario, then matchGroup.
 */
export function modeKey(
  matchGroup?: string | null,
  scenario?: string | null,
  eventType?: string | null,
): string {
  const et = (eventType ?? "").toLowerCase();
  const sc = (scenario ?? "").toLowerCase();
  const mg = (matchGroup ?? "").toLowerCase();

  // Battle-script level — the WG id encodes the exact event/operation.
  if (et.includes("asym")) return "asymmetric";
  if (et.includes("convoy")) return "convoy";
  if (et.includes("armsrace")) return "armsrace";
  if (et.includes("halloween") || et.includes("_hl_")) return "halloween";
  if (et.includes("firstapril")) return "event";
  if (et.includes("pinata")) return "event";
  if (et.includes("d_day")) return "operation";
  if (et.includes("portal")) return "event";
  if (et.includes("classic")) return "event";
  if (et.includes("moderera")) return "event";
  if (et.includes("skirmish")) return "brawl";
  if (et.includes("airships")) return "event";
  if (et.includes("airbarrier")) return "event";
  if (et.includes("respawns")) return "event";
  if (et.includes("_op_") || et.includes("_hl_")) return "operation";

  // Scenario level.
  if (sc.includes("asymm")) return "asymmetric";
  if (sc.includes("convoy")) return "convoy";
  if (sc.includes("armsrace")) return "armsrace";
  if (sc.includes("ranked")) return "ranked";
  if (sc.includes("_op_") || sc.startsWith("pcvo") || sc.includes("_hl_")) return "operation";

  // matchGroup level.
  if (mg.startsWith("ranked")) return "ranked";
  if (mg === "pvp" || mg.includes("random")) return "pvp";
  if (mg.includes("clan")) return "clan";
  if (mg.includes("brawl")) return "brawl";
  if (mg.includes("coop") || mg.includes("cooperative") || mg.startsWith("pve")) return "cooperative";
  if (mg.includes("event")) return "event";
  if (mg.includes("train") || mg.includes("sandbox")) return "training";
  if (mg.includes("squad")) return "squad";
  return mg;
}

/** Resolve the colour triple for a battle mode. Unknown modes fall back to
 *  accent gold so the pill always has a colour. */
export function modeColor(
  matchGroup?: string | null,
  scenario?: string | null,
  eventType?: string | null,
): ModeColor {
  const key = modeKey(matchGroup, scenario, eventType);
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
