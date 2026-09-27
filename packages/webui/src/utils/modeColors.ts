/**
 * WoWS battle-mode keys + colours for replay pills / tags.
 *
 * Mode identity is layered in the replay descriptor:
 *   - matchGroup  — coarse bucket (pvp / ranked / clan / event / brawl / pve)
 *   - scenario    — scenario name (domination_3point, asymm_3point_coop, ...)
 *   - eventType   — GameParams BattleScript id (PCVE027 = EV27AsymCoop, ...)
 *   - botCount    — roster entries with bot nicknames (`:Name:` bots, `IDS_*` / `#Name` scripted units)
 *   - scriptedUnitCount — the scripted-unit half of botCount (`IDS_*` text
 *     keys / `#Name` scenario style); co-op and random fills carry `:Name:`
 *     bots only, so a non-zero count in the pve family means operation (行动)
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
  scriptedUnitCount = 0,
): string {
  const et = (eventType ?? "").toLowerCase();
  const sc = (scenario ?? "").toLowerCase();
  const mg = (matchGroup ?? "").toLowerCase();

  // Battle-script level — the WG id encodes the exact event/operation. The
  // PCVO* scripts are the operation scenarios themselves (verified against
  // the vendored Narai golden replay: eventType
  // `PCVO009_OP_02_02_...`), so the prefix alone decides.
  if (et.startsWith("pcvo")) return "operation";
  if (et.startsWith("low_lvl_operation")) return "operation";
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
  if (et.includes("_op_")) return "operation";

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

  // Scenario level. A `pcvo*` scenario id is an operation script echoed
  // into the scenario field by some client versions.
  if (sc.includes("asymm")) return "asymmetric";
  if (sc.includes("convoy")) return "convoy";
  if (sc.includes("armsrace")) return "armsrace";
  if (sc.includes("ranked")) return "ranked";
  if (sc.startsWith("pcvo") || sc.includes("_op_") || sc.includes("_hl_")) return "operation";
  // The low-level escort op (new-account) is an operation too — its scenario
  // id says so even though its roster LAYOUT stays two-team (isOperationBattle
  // keeps that split; only the label here is operation 行动).
  if (sc.startsWith("low_lvl_operation")) return "operation";

  // matchGroup level. `pve` alone (no operation fingerprint above) is the
  // plain co-op bucket — operations normally arrive as `pve` too, but they
  // are caught by the scenario/script levels first. The one late-caught case
  // is the descriptor with NO operation fingerprint at all: scripted units
  // (`IDS_*` / `#Name`) never field in plain co-op, so their presence inside
  // the co-op family marks an operation (the escort op arrives this way when
  // the scenario field is empty).
  if (mg.startsWith("ranked")) return "ranked";
  if (mg === "pvp" || mg.includes("random")) return "pvp";
  if (mg.includes("clan")) return "clan";
  if (mg.includes("brawl")) return "brawl";
  const coopFamily =
    mg.includes("coop") || mg.includes("cooperative") || mg.startsWith("pve");
  if (coopFamily && scriptedUnitCount > 0) return "operation";
  if (coopFamily) return "cooperative";
  if (mg.includes("event")) return "event";
  if (mg.includes("train") || mg.includes("sandbox")) return "training";
  if (mg.includes("squad")) return "squad";
  return mg;
}

/**
 * Whether this battle is an operation scenario (行动模式): no enemy team —
 * the roster's `relation` values follow scenario team slots (escort waves,
 * target ships) instead of enemy semantics, and the in-game Tab table shows
 * ONE team. Rosters therefore render as a single allies column, and any
 * relation-based ally/enemy split is meaningless for them.
 *
 * The fingerprints mirror `is_operation_arena` in `wowsp_tauri_shared` and
 * the operation branches of `modeKey`, plus the roster scan every caller
 * needs when the arena file carries no scenario/script (operations with an
 * empty scenario field exist): scenario units keep their `IDS_OP_*` ship
 * name as nickname.
 *
 * EXCEPT the new-account scripted battles (the `FIRST_BATTLE` tutorial and
 * the `LOW_LVL_OPERATION_*` escort op) — those are coop-shaped two-team
 * battles whose relation values ARE enemy semantics, so they must take the
 * ordinary allies/enemies split (same exclusion as the Rust side). Their
 * mode LABEL is still "operation" (see modeKey) — only the roster layout
 * stays two-team here.
 */
export function isOperationBattle(
  matchGroup?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  names: string[] = [],
): boolean {
  const et = (eventType ?? "").toLowerCase();
  const sc = (scenario ?? "").toLowerCase();
  if (sc.startsWith("low_lvl_operation") || sc === "first_battle") return false;
  if (et.startsWith("low_lvl_operation") || et === "first_battle") return false;
  if (names.some((n) => n.toUpperCase().startsWith("IDS_OP_15_"))) return false;
  if (et.startsWith("pcvo") || sc.startsWith("pcvo")) return true;
  if (et.includes("_op_") || sc.includes("_op_") || sc.includes("_hl_")) return true;
  if ((matchGroup ?? "").toLowerCase() === "pve" && names.some((n) => n.toUpperCase().startsWith("IDS_OP_"))) {
    return true;
  }
  return false;
}

/** Resolve the colour triple for a battle mode. Unknown modes fall back to
 *  accent gold so the pill always has a colour. */
export function modeColor(
  matchGroup?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
  scriptedUnitCount = 0,
): ModeColor {
  const key = modeKey(matchGroup, scenario, eventType, botCount, scriptedUnitCount);
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
