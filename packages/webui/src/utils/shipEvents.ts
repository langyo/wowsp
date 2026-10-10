/**
 * Event registry — the "活动·<official name>" ship tag's metadata side.
 *
 * Membership (which ship belongs to which event) is generated per game
 * build by `scripts/extract/build_event_map.py` into
 * `data/ship_events.json`; this registry carries everything that cannot be
 * derived from the data and is curated by hand:
 *
 *   - `since` — the event's first-appearance version/date, best effort.
 *     Anchored to what the data itself encodes where possible (the
 *     `_H20xx` name suffixes, `Postap2022`, `FA2023`,
 *     `CAMO_1ST_APRIL_2024`, the `Star_Trek_1310` collection name), to
 *     patch-history knowledge for the collaboration waves. Null = not
 *     traceable locally; the tooltip simply omits it.
 *
 * Localized official names live under `ships.event.<id>` in
 * res/i18n/locales/&lt;locale&gt;/ships.json (the key IS the id — an
 * ID-shaped indirection, so the baked data never depends on any one
 * language's wording).
 */
import { t } from "@/i18n";

export interface EventMeta {
  /** First appearance, human-readable ("2020-10", "13.10 · 2025-10"). */
  since: string | null;
}

export const EVENT_META: Record<string, EventMeta> = {
  // Battle-mode fleets
  halloween_2016: { since: "2016-10" },
  halloween_2017: { since: "2017-10" },
  halloween_2018: { since: "2018-10" },
  halloween_2019: { since: "2019-10" },
  halloween_2020: { since: "2020-10" },
  halloween_2022: { since: "2022-10" },
  space_battles: { since: "2018-04" },
  star_event: { since: null },
  postap_2022: { since: "2022" },
  april_fools_2023: { since: "2023-04" },
  april_fools_2024: { since: "2024-04" },
  modern_era: { since: null },
  // Collaborations
  collab_arp: { since: "2016" },
  collab_azur_lane: { since: "2018" },
  collab_hsf: { since: "2017" },
  collab_wh40k: { since: "2020" },
  collab_blue_archive: { since: "2025" },
  collab_megadeth: { since: "2023" },
  collab_star_trek: { since: "13.10 · 2025-10" },
  // Themed families
  lunar_new_year: { since: "2019" },
  hunt_bismarck: { since: "2017" },
  scarlet_future: { since: null },
};

/** The tag label: "活动·<official event name>" (both parts localized). */
export function eventLabel(eventId: string): string {
  return `${t("ships.event._prefix")}·${t(`ships.event.${eventId}`)}`;
}

/** Tooltip text for the tag: the event name plus its first appearance. */
export function eventTooltip(eventId: string): string {
  const meta = EVENT_META[eventId];
  const name = t(`ships.event.${eventId}`);
  return meta?.since ? `${name} · ${meta.since}` : name;
}
