/**
 * Ship archetype → human-readable branch-flavour label.
 *
 * The `archetype` field in GameParams (e.g. "BB_Far", "CA_Spammer") encodes a
 * ship's playstyle archetype — the same code the in-game tech-tree UI uses to
 * label branch forks ("Fast battleships", "Gunboat destroyers", etc.). The
 * readable text is NOT shipped in GameParams; it lives only in the client's
 * localization, so we map the codes ourselves (13 non-"Undefined" archetypes).
 *
 * Labels are i18n keys: `ships.archetype.<code>` resolved by the component.
 * "Undefined" (legacy ships without an archetype) renders as no label.
 */
export interface ArchetypeInfo {
  /** Stable i18n key under `ships.archetype.*`. */
  key: string;
  /** Whether this archetype should be shown as a branch label. */
  labelable: boolean;
}

const ARCHETYPE_INFO: Record<string, ArchetypeInfo> = {
  Undefined: { key: "Undefined", labelable: false },
  BB_Far: { key: "BB_Far", labelable: true },
  BB_Mid: { key: "BB_Mid", labelable: true },
  BB_Close: { key: "BB_Close", labelable: true },
  CA_Spammer: { key: "CA_Spammer", labelable: true },
  CA_Hybrid: { key: "CA_Hybrid", labelable: true },
  CA_Controller: { key: "CA_Controller", labelable: true },
  CA_Auxiliary: { key: "CA_Auxiliary", labelable: true },
  DD_Art: { key: "DD_Art", labelable: true },
  DD_Hybrid: { key: "DD_Hybrid", labelable: true },
  DD_Auxiliary: { key: "DD_Auxiliary", labelable: true },
  CV_Universalist: { key: "CV_Universalist", labelable: true },
  "CV_Anti-Large": { key: "CV_Anti-Large", labelable: true },
  SS_Close: { key: "SS_Close", labelable: true },
  SS_Far: { key: "SS_Far", labelable: true },
};

/** Whether an archetype code should produce a visible branch label. */
export function isLabelableArchetype(code: string | undefined): boolean {
  if (!code) return false;
  return ARCHETYPE_INFO[code]?.labelable ?? false;
}

/** The i18n key (without namespace) for an archetype, or null if unlabelled. */
export function archetypeKey(code: string | undefined): string | null {
  if (!code || !isLabelableArchetype(code)) return null;
  return code;
}
