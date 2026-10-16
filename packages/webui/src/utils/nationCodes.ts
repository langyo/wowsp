/**
 * Nation-code normalization between the spellings WG mixes across its data:
 * `ship_names.json` / the encyclopedia keep lowercase game-file codes ("usa",
 * "united_kingdom"), while GameParams commander and modernization entries use
 * the capitalized faction names ("USA", "United_Kingdom"). Everything that
 * matches one against the other (build planner, live-battle panel) goes
 * through here.
 */
export const GAME_NATION: Record<string, string> = {
  usa: "USA",
  japan: "Japan",
  germany: "Germany",
  uk: "United_Kingdom",
  ussr: "Russia",
  france: "France",
  italy: "Italy",
  netherlands: "Netherlands",
  spain: "Spain",
  pan_asia: "Pan_Asia",
  pan_america: "Pan_America",
  commonwealth: "Commonwealth",
  europe: "Europe",
  // WG mixes both spellings for the pan-European faction (tech tree ships
  // carry "pan_europe", GameParams mods/commanders say "Europe").
  pan_europe: "Europe",
  // ship_names.json keeps the raw game-file spellings; synthetic ShipInfo
  // entries (event ships outside the encyclopedia) carry them verbatim.
  united_kingdom: "United_Kingdom",
  russia: "Russia",
};

/** Lowercase ship-data nation code → GameParams faction name (identity when
 *  the code is already a GameParams spelling or unknown). */
export function gameNationOf(nation: string): string {
  return GAME_NATION[nation] ?? nation;
}
