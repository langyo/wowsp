/**
 * The realm codes the app knows (ru/eu/na/asia/cn — mirrors the Rust
 * wg_realm host table). One shared list so the probe-identity validators,
 * the account store and the overlay window (a bare page that cannot load
 * Pinia stores) can never drift apart.
 */
export const KNOWN_REALMS = ["ru", "eu", "na", "asia", "cn"] as const;

export const isKnownRealm = (code: string): boolean =>
  (KNOWN_REALMS as readonly string[]).includes(code);

/** Realms whose client orders same-(class, tier) Tab rows by the LOCALIZED
 *  ship name instead of the decompiled nation rank (utils/shipClass's
 *  module docs): the 360 CN build (observed 2026-10-07) and the Lesta
 *  client (observed 2026-10-09 — one 博加特里/Bogatyr row led two
 *  圣路易斯/St. Louis rows inside a tier-III cruiser group, against the
 *  usa < russia nation rank). Only the row ORDER is shared; the
 *  never-re-sorts static layout stays CN-only. */
export const realmUsesShipNameOrder = (code: string): boolean =>
  code === "cn" || code === "ru";
