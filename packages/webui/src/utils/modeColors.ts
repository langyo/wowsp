/**
 * WoWS battle-mode keys + colours for replay pills / tags.
 *
 * Mode identity is layered in the replay descriptor:
 *   - matchGroup  — coarse bucket (pvp / ranked / clan / event / brawl / pve)
 *   - scenario    — scenario name (domination_3point, asymm_3point_coop, ...)
 *   - eventType   — GameParams BattleScript id (PCVE027 = EV27AsymCoop, ...)
 *   - botCount    — roster entries with the client's `:Name:` bot nickname
 *
 * The eventType is the most specific signal (a WG battle-script id); scenario
 * is next; matchGroup is the fallback. botCount subdivides WITHIN that layering
 * (see modeKey): the same bot-nickname style fills official co-op rosters, so
 * it only reclassifies a battle where official bots cannot appear.
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
  room_bots: "12a5b4", // Custom room vs bots — teal
};

/** Fallback colour (accent gold) for unknown modes. */
const FALLBACK_HEX = "e6a817";

/**
 * Resolve a battle's canonical mode key from its layered identity fields.
 * Battle-script (eventType) wins, then the custom-room subdivision, then
 * scenario, then matchGroup.
 *
 * The custom-room subdivision sits between eventType and scenario because a
 * training room copies whatever template it was created from: its descriptor
 * reports a pvp-family matchGroup and scenario names like
 * `domination_tournament_3point`. Two fingerprints, usable together or alone:
 *   - the tournament scenario variants — room-only, regardless of roster;
 *   - `:Name:` bot rosters — but official co-op fills bots the SAME way, so
 *     this means "custom room" only where official bots cannot appear: a
 *     pvp-family matchGroup (pvp / ranked / clan / brawl / squad), or when
 *     the tournament scenario confirms the room. Bot rosters in pve-family
 *     groups keep their official labels (Co-op, Asymmetric, Operations).
 */
export function modeKey(
  matchGroup?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
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

  // Custom-room level (see doc above).
  const tournamentRoom = sc.includes("tournament");
  const pvpFamily =
    mg === "pvp" ||
    mg.includes("random") ||
    mg.startsWith("ranked") ||
    mg.includes("clan") ||
    mg.includes("brawl") ||
    mg.includes("squad");
  if (botCount > 0 && (pvpFamily || tournamentRoom)) return "room_bots";
  if (tournamentRoom) return "training";

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
  botCount = 0,
): ModeColor {
  const key = modeKey(matchGroup, scenario, eventType, botCount);
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
