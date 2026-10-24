/**
 * Ship-class hover cards for the water-table type badges (BB / CV / CA / CL
 * / CA/CL / DD / SS).
 *
 * The card is the global tooltip's structured form (`data-hint-card`, see
 * composables/globalTooltip.ts): the class glyph exactly as the board draws
 * it on the minimap — the game's white, right-pointing marker art — beside a
 * bold class name, then a short gameplay briefing (what the class is FOR,
 * not just how it is bracketed against its neighbours).
 *
 * Every string is resolved here at call time and the card is serialized to
 * JSON, because the tooltip's contract is pre-localized plain text (the popup
 * is built with DOM APIs and never parses markup). Call sites therefore pass
 * the RESULT of `shipTypeBadgeShort` — the badge's own vocabulary — so the
 * cruiser split the row shows is the card the pointer explains.
 */
import type { HintCard } from "@/composables/globalTooltip";
import { shipIconUrl } from "@/features/holographic/shipIcons";
import { t } from "@/i18n";

/** Water-table badge code → i18n key under `ships.typeInfo`.
 *
 *  Cruisers carry both hull designations: a ship whose baked main-gun
 *  caliber is known shows CA or CL and gets that hull's card, while hulls
 *  the bake could not classify keep the combined "CA/CL" code and share the
 *  generic cruiser card (the same fallback rule the badge itself uses). */
const HINT_KEY: Record<string, string> = {
  BB: "bb",
  CV: "cv",
  CA: "ca",
  CL: "cl",
  "CA/CL": "cruiser",
  DD: "dd",
  SS: "ss",
};

/** i18n key → the WG ShipInfo.type the minimap marker is keyed by (the
 *  "white" variant is the neutral, right-facing marker the rows themselves
 *  draw). */
const ICON_TYPE: Record<string, string> = {
  bb: "Battleship",
  cv: "AirCarrier",
  ca: "Cruiser",
  cl: "Cruiser",
  cruiser: "Cruiser",
  dd: "Destroyer",
  ss: "Submarine",
};

/** The card for one badge code, or null when the class has no briefing
 *  (`?` — unknown/auxiliary hulls) or the active locale carries no text.
 *  The head glyph is the class's minimap marker, white and pointing right. */
export function shipTypeHintCardOf(code: string | null | undefined): HintCard | null {
  const key = HINT_KEY[(code ?? "").trim()];
  if (!key) return null;
  const title = t(`ships.typeInfo.${key}.title`);
  const body = t(`ships.typeInfo.${key}.body`);
  // An unshipped/missing message resolves to the key path itself (vue-i18n's
  // miss behaviour) — never leak that into the popup.
  if (!title || !body || title.startsWith("ships.typeInfo.")) return null;
  // The "white" variant is the neutral minimap marker — the same art the
  // rows draw next to the name — so the card hands it over as markerUrl (its
  // white glyph needs the tooltip's dark plate; see HintCard.markerUrl).
  const markerUrl = shipIconUrl(ICON_TYPE[key], "white");
  return {
    title,
    ...(markerUrl ? { markerUrl } : {}),
    body,
  };
}

/** `data-hint-card` JSON for one badge code, or undefined when the badge has
 *  no card — a Vue JSX `undefined` attribute is simply not rendered. */
export function shipTypeHintCard(code: string | null | undefined): string | undefined {
  const card = shipTypeHintCardOf(code);
  return card ? JSON.stringify(card) : undefined;
}
