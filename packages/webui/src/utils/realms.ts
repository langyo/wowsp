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
 *  localized name; the static never-re-sorts layout stays CN-only too.
 *  Both CN quirks were calibrated on the SINGLE-team (co-op/operation)
 *  table and are gated to that LAYOUT by the callers (issue #1360: the
 *  2026-10-23 two-team capture renders the decompiled nation rank) —
 *  this flag answers "could this client?", the anchor's team_split
 *  answers "is this the calibrated table?". */
export const realmUsesShipNameOrder = (code: string): boolean =>
  code === "cn";

/** Which client's GameParams slice a ship lookup renders ("wg" | "lesta" —
 *  the shipsUi store's branch-realm vocabulary). The WG and Lesta clients
 *  share most ship ids but their data has diverged (Lesta rebalanced
 *  independently — their U-2501 lists an Engine Boost consumable WG's never
 *  carries), so the hot ship-data bundle resolves a shared id per realm and
 *  every lookup names the realm it renders.
 *
 *  A WG API player realm of "ru" IS the Lesta-operated cluster (the split
 *  left Wargaming with eu/na/asia; Lesta runs ru) — accounts there sail
 *  Lesta-realm data — and every other cluster is WG. Nothing derivable
 *  (unknown/null realm) degrades to WG: the encyclopedia's primary realm,
 *  and Lesta-only ships still answer from the backend's bundled Lesta
 *  snapshot. One shared rule so the water tables, the dashboard, the
 *  about-modal trivia and the live battle panel can never drift apart. */
export type ShipDataBranch = "wg" | "lesta";

export const branchFromPlayerRealm = (realm?: string | null): ShipDataBranch =>
  realm === "ru" ? "lesta" : "wg";
