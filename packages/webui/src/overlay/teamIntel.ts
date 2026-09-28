/** Team consumable intel for the Tab overlay's two-sided summary cards.
 *
 *  At match start the roster's shipIds join against the baked capability
 *  asset (`data/ship_consumable_kit.json`, generator:
 *  `scripts/extract_ship_consumable_kit.py`) to answer "how many
 *  radars/hydros/smokes can each side field" — as an ESTIMATE RANGE,
 *  because utility cruisers mount one consumable per slot chosen from
 *  several: a slot offering radar + spotter + fighter only MIGHT be a
 *  radar. Per family the baked level is therefore
 *
 *    2 = definite (some slot offers ONLY this family — every loadout has it)
 *    1 = possible (shares a slot with alternatives)
 *    0 = cannot mount (no entry in the asset at all)
 *
 *  and a side's count is min = definites, max = definites + possibles.
 *  Ships the asset doesn't know (a brand-new ship before a data refresh)
 *  contribute nothing rather than guessing. `radarMaxM` is the side's
 *  longest STOCK radar detection radius in meters, so the player knows how
 *  far out they can be lit. All numbers are match-start capability — they
 *  do not decrement as ships sink. */

import kitRaw from "../data/ship_consumable_kit.json";

/** Baked per-ship level per counted family (see the module docstring). */
type KitLevel = 0 | 1 | 2;

interface KitEntry {
  /** RLSSearch (radar). */
  r?: KitLevel;
  /** SonarSearch (hydroacoustic search). */
  h?: KitLevel;
  /** SmokeGenerator (ship smoke). */
  s?: KitLevel;
  /** Longest stock radar detection radius, meters (only when r > 0). */
  radarM?: number;
}

const KIT = kitRaw as Record<string, KitEntry>;

export interface TeamIntelCount {
  min: number;
  max: number;
}

export interface TeamIntel {
  radar: TeamIntelCount;
  hydro: TeamIntelCount;
  smoke: TeamIntelCount;
  /** Longest stock radar radius among the side's radar-capable ships
   *  (meters); null when nobody can mount radar (or no ranges baked). */
  radarMaxM: number | null;
}

type KitLookup = (shipId: number) => KitEntry | undefined;

/** The pure aggregation, injected with the kit lookup so tests can feed a
 *  fake capability table without touching the baked asset. */
export function teamIntelFrom(
  shipIds: Array<number | null | undefined>,
  kitOf: KitLookup,
): TeamIntel {
  const radar: TeamIntelCount = { min: 0, max: 0 };
  const hydro: TeamIntelCount = { min: 0, max: 0 };
  const smoke: TeamIntelCount = { min: 0, max: 0 };
  let radarMaxM: number | null = null;
  for (const id of shipIds) {
    if (id == null) continue;
    const e = kitOf(id);
    if (!e) continue;
    // A ship contributes AT MOST one of each family even when two slots
    // could carry it — max counts SHIPS, not slots.
    if (e.r) {
      radar.max += 1;
      if (e.r === 2) radar.min += 1;
      if (typeof e.radarM === "number" && e.radarM > (radarMaxM ?? 0)) radarMaxM = e.radarM;
    }
    if (e.h) {
      hydro.max += 1;
      if (e.h === 2) hydro.min += 1;
    }
    if (e.s) {
      smoke.max += 1;
      if (e.s === 2) smoke.min += 1;
    }
  }
  return { radar, hydro, smoke, radarMaxM };
}

/** Team intel for one side's vehicles (each entry's shipId; duplicates
 *  count — two Worcesters are two radars). */
export function teamIntelFor(shipIds: Array<number | null | undefined>): TeamIntel {
  return teamIntelFrom(shipIds, (id) => KIT[id]);
}

/** `3` / `3~5` — the range notation the cards show per family. */
export function formatIntelCount(c: TeamIntelCount): string {
  return c.min === c.max ? `${c.max}` : `${c.min}~${c.max}`;
}

/** `10000` → `"10.0"`. */
export function formatIntelKm(meters: number): string {
  return (meters / 1000).toFixed(1);
}
