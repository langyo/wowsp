/**
 * Ship-class hover cards for the water-table type badges (BB / CV / CA / CL
 * / CA/CL / DD / SS).
 *
 * The card is the global tooltip's structured form (`data-hint-card`, see
 * composables/globalTooltip.ts): the class glyph exactly as the board draws
 * it on the minimap — the game's white, right-pointing marker art — beside
 * a bold class name, then a short gameplay briefing (what the class is
 * FOR, not just how it is bracketed against its neighbours). Control-heavy
 * classes (carrier, submarine) follow the briefing with an itemized
 * "press X to do Y" list (HintCard.keys) and a muted mechanics note, so
 * the card never grows back into one long paragraph.
 *
 * Every string is resolved here at call time and the card is serialized to
 * JSON, because the tooltip's contract is pre-localized plain text (the
 * popup is built with DOM APIs and never parses markup). Call sites therefore pass
 * the RESULT of `shipTypeBadgeShort` — the badge's own vocabulary — so the
 * cruiser split the row shows is the card the pointer explains.
 */
import type { HintCard, HintCardKey } from "@/composables/globalTooltip";
import { shipIconUrl } from "@/features/holographic/shipIcons";
import { t, te } from "@/i18n";

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

/** Numbered key-item slots read per class (`keys.<n>.key` /`keys.<n>.text`
 *  under `ships.typeInfo.<code>`): the loop stops at the first missing
 *  index, so a locale simply ships as many items as its card needs. Kept
 *  above any real list length so longer copy never silently truncates. */
const KEY_SLOTS = 8;

/** vue-i18n's miss behaviour resolves an unresolvable path to the key path
 *  itself (with the en-US fallback configured, that takes BOTH the active
 *  locale and the fallback missing) — the sentinel every lookup below is
 *  checked against. Locale parity is CI-enforced, so in practice this
 *  only fires for branches a class genuinely does not carry. */
function isMiss(value: string): boolean {
  return value.startsWith("ships.typeInfo.");
}

/** The itemized control entries of one class, read from consecutive
 *  numbered leaves; an absent first entry means the class has no list.
 *  te() leads every probe: prose-only classes carry no list, and walking
 *  t() through the missing indices would fire vue-i18n missing-warns on
 *  every render (see te's doc comment in i18n/index.ts). */
function keysFor(key: string): HintCardKey[] {
  const items: HintCardKey[] = [];
  for (let i = 1; i <= KEY_SLOTS; i++) {
    const base = `ships.typeInfo.${key}.keys.${i}`;
    if (!te(`${base}.key`) || !te(`${base}.text`)) break;
    const cap = t(`${base}.key`);
    const text = t(`${base}.text`);
    if (!cap || !text || isMiss(cap) || isMiss(text)) break;
    items.push({ key: cap, text });
  }
  return items;
}

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
  // rows draw next to the name — so the card hands it over as markerUrl
  // (the popup tints the white glyph to its own ink; see HintCard.markerUrl).
  const markerUrl = shipIconUrl(ICON_TYPE[key], "white");
  const keys = keysFor(key);
  const noteKey = `ships.typeInfo.${key}.note`;
  const note = te(noteKey) ? t(noteKey) : "";
  return {
    title,
    ...(markerUrl ? { markerUrl } : {}),
    body,
    ...(keys.length > 0 ? { keys } : {}),
    ...(!note || isMiss(note) ? {} : { note }),
  };
}

/** `data-hint-card` JSON for one badge code, or undefined when the badge has
 *  no card — a Vue JSX `undefined` attribute is simply not rendered. */
export function shipTypeHintCard(code: string | null | undefined): string | undefined {
  const card = shipTypeHintCardOf(code);
  return card ? JSON.stringify(card) : undefined;
}
