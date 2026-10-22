/**
 * Per-slot consumable selection for the lineup editor's second row.
 *
 * The authoritative layout comes from a GameParams slice (async, per
 * hull): one mini button-group per consumable SLOT, single-select within
 * the slot — a slot with alternatives (spotter vs fighter, radar vs
 * spotter) offers them as sibling icon buttons, independent across
 * slots. Same join as the ship-detail specs tab (buildConsumableSlots),
 * collapsed to family level here.
 *
 * The synchronous baked fallback (ship_live_stats `load`) is a DEDUPED
 * family inventory — slot boundaries and alternatives do not survive
 * the bake — so it renders as one multi-select toggle strip (exactly
 * the pre-rework chips' semantics) until/unless the slice arrives.
 *
 * Both paths persist the same thing: LineupEntry.consumables as the
 * hull's chosen FAMILY list, which is what zoneSourceOf matches — a
 * non-empty chosen list restricts the hull's zone capability to what
 * it names.
 */
import { shipLiveStats, shipConsumableLabel } from "@/features/replay/shipLiveStats";
import { buildConsumableSlots, familyIconUrl } from "@/components/ships/consumables";

/** One mountable alternative of a slot, at family granularity. */
export interface SlotOption {
  /** GameParams ability family ("RLSSearch", "SmokeGenerator", …) — the
   *  persisted choice identity and zoneSourceOf's match input. */
  family: string;
  /** Localized display name. */
  name: string;
  /** Consumable webp URL, null when no art baked. */
  iconUrl: string | null;
}

/** One consumable slot: its index, its battle key (R/T/Y/U/I), and the
 *  mountable alternatives in catalog order. */
export interface SlotGroup {
  slot: number;
  key: string | null;
  options: SlotOption[];
}

function optionOf(family: string, name?: string, iconUrl?: string | null): SlotOption {
  return {
    family,
    name: name ?? shipConsumableLabel(family),
    iconUrl: iconUrl ?? familyIconUrl(family),
  };
}

/** The baked fallback: every family the hull can mount (deduped, in
 *  first-seen slot order) — toggle options, NOT slots. */
export function bakedToggleOptions(shipId: number): SlotOption[] {
  return (shipLiveStats(shipId)?.load ?? [])
    .filter((family) => !!family)
    .map((family) => optionOf(family));
}

/** Authoritative slot groups from a GameParams slice, collapsed to family
 *  level (variant differences within one family — premium charges etc. —
 *  don't change which family a slot lights up). */
export function gameparamsSlotGroups(
  gameparams: unknown,
  dataLanguage: string,
): SlotGroup[] {
  return buildConsumableSlots(gameparams, dataLanguage).map((g) => {
    const options: SlotOption[] = [];
    const seen = new Set<string>();
    for (const entry of g.entries) {
      if (seen.has(entry.family)) continue;
      seen.add(entry.family);
      options.push({ family: entry.family, name: entry.name, iconUrl: entry.iconUrl });
    }
    // g.key is withheld for all-auto slots by the specs-tab join — keep
    // that ruling (CV auto damage control carries no battle key).
    return { slot: g.slot, key: g.key, options };
  });
}

/**
 * The families a hull effectively runs across real slot groups: per
 * slot, the first option whose family is in `chosen`, else the slot's
 * first option — an untouched (or legacy, chosen-empty) hull shows its
 * defaults, and every slot always contributes exactly one family.
 */
export function effectiveFamilies(groups: SlotGroup[], chosen: string[]): string[] {
  const set = new Set(chosen);
  return groups
    .map((g) => g.options.find((o) => set.has(o.family))?.family ?? g.options[0]?.family)
    .filter((f): f is string => !!f);
}

/** The chosen-family list after picking `family` for `slot` — the full
 *  effective set with that one slot overridden (persisting the complete
 *  loadout keeps zoneSourceOf's restriction exact). */
export function selectFamily(
  groups: SlotGroup[],
  chosen: string[],
  slot: number,
  family: string,
): string[] {
  const set = new Set(chosen);
  return groups
    .map((g) => {
      if (g.slot === slot) return family;
      return g.options.find((o) => set.has(o.family))?.family ?? g.options[0]?.family;
    })
    .filter((f): f is string => !!f);
}
