/**
 * Identity-line helpers for the post-battle results matrix: how a row's seal
 * kinds split between the line itself and the collapsed badge, plus the
 * model the row's rich identity hover card paints.
 *
 * Why the split exists (2026-11-08 review): the four-character composition
 * tags (空中小人 / 水下小人, the veteran and merged families) pressed as
 * StampTag chips BEFORE the nickname overflowed or overlapped the nick on a
 * narrow results column. The rule is wording-based, not kind-based: a seal
 * whose EFFECTIVE wording (the user's sealLabels override or the default
 * STAMP_WORDING) is a single character still presses inline exactly as
 * before (猴 / 蛆), while every wider wording collapses behind ONE small "!"
 * superscript badge at the nickname's top-right — BOTH densities. The row's
 * hover card is where the complete list survives (the real StampTag chips,
 * collapsed ones included).
 */
import { stampWording, type SealLabelMap, type StampKind } from "@/utils/winrate";

/** One row's seal kinds split by whether they stay inline. Both lists keep
 *  the incoming display order (career first, air before sub). */
export interface IdentitySealSplit {
  /** Single-character wordings — pressed inline as StampTag chips. */
  inline: StampKind[];
  /** Every wider wording — hidden behind the row's "!" badge and listed in
   *  the hover card. */
  collapsed: StampKind[];
}

/** One row's full seal state: every kind it owns plus the split above —
 *  the panel's single lookup feeds the inline cluster, the "!" badge and the
 *  hover card from the same ordered list. */
export interface IdentitySealLine extends IdentitySealSplit {
  /** EVERY seal kind the row owns, in display order. */
  kinds: StampKind[];
}

/** Split the row's identity-line seal kinds by their EFFECTIVE wording
 *  length: exactly one character stays inline, anything longer collapses.
 *  The length counts code points, not UTF-16 units — a custom seal label may
 *  be one emoji (two UTF-16 units) and must still read as one character. */
export function splitIdentitySeals(
  kinds: readonly StampKind[],
  labels?: SealLabelMap,
): IdentitySealSplit {
  const inline: StampKind[] = [];
  const collapsed: StampKind[] = [];
  for (const kind of kinds) {
    const wording = Array.from(stampWording(kind, labels).trim());
    if (wording.length > 1) collapsed.push(kind);
    else inline.push(kind);
  }
  return { inline, collapsed };
}

/** The collapsed seals' full wording, in display order — the "!" badge's
 *  accessible label (the minimal hint it carries inside the row button; the
 *  rich hover card paints each seal as a real chip). */
export function sealBadgeWording(
  kinds: readonly StampKind[],
  labels?: SealLabelMap,
): string {
  return kinds.map((kind) => stampWording(kind, labels)).join(" · ");
}

/** The identity presentation one row's hover card paints — the row's own
 *  three lines escaped from the clipping result columns: (1) the marker-
 *  tinted, masked nickname with its clan tag / bot marker, (2) every tag the
 *  row carries as the real list faces — the yellow division tag, the local
 *  marker's name and EVERY seal (collapsed ones included), (3) the ship tier
 *  + name. */
export interface PostBattleIdentityModel {
  /** Already-masked display nickname (never the raw nick — masking is the
   *  caller's job, so a hidden name cannot leak through the card). */
  name: string;
  /** Clan tag WITHOUT brackets, or null (bots and clanless players). */
  clanTag: string | null;
  /** markerTintClass() result for the row's marker color ("" when unmarked). */
  tintClass: string;
  /** AI-controlled row: paints the localized bot marker after the clan. */
  ai: boolean;
  /** Division letter for the yellow DivisionTag face, or null for a solo
   *  row (the tag renders under every locale, exactly as in the row). */
  divisionLetter: string | null;
  /** The local marker's localized color name (markerColorLabel), or null.
   *  The nickname tint alone cannot say WHICH mark the row carries. */
  markerLabel: string | null;
  /** Every seal kind the row owns, in display order (collapsed included). */
  seals: readonly StampKind[];
  /** Roman tier marker ("I" / "VIII" / "★"), "" when unknown. */
  tier: string;
  /** Ship name, "" when the offline DB does not know the hull. */
  shipName: string;
}
