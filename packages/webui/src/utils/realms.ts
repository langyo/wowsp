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
 *  module docs): the 360 CN build (observed 2026-10-07). The Lesta client
 *  was moved OFF this gate by the 2026-10-10 live capture: its rendered
 *  Tab order follows the client's OWN sort keys (the probe's `sortKeys`
 *  reproduced it row for row), and the earlier "ship-name order" reading
 *  of the 2026-10-09 capture was a misread — Bogatyr leading two
 *  St. Louis rows was Lesta's own NATION.SORT_ORDER ranking russia first,
 *  not a name collation. Only the CN build's HUD re-sorts by the
 *  localized name; the static never-re-sorts layout stays CN-only too. */
export const realmUsesShipNameOrder = (code: string): boolean =>
  code === "cn";
