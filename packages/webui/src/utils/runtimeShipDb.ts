/**
 * Runtime supplement to the offline ship-name DB (`data/ship_names.json`).
 *
 * The baked DB is a build-time snapshot: ships added (or re-introduced as
 * collaboration/event clones) AFTER the bake are invisible to it, and every
 * consumer — the Tab sort key, the class icons, the live panel's identity
 * strip, the ship-name line — degrades to "unknown" for them. This module is
 * the runtime escape hatch: the App side resolves a missing ship against the
 * player's OWN client GameParams (via `get_ship_gameparams`) and registers
 * the derived identity here, so the same consumers pick it up through their
 * regular fallback chain. The baked DB always wins — a registration only
 * fills a hole, it never overrides a baked entry.
 *
 * The store itself is deliberately NON-reactive plain state; Vue surfaces
 * that need re-render-on-register use `features/replay/runtimeShipIdentity`'s
 * epoch counter as the reactive trigger instead.
 *
 * This module MUST stay dependency-free (zero imports): it is consumed by
 * `utils/shipClass.ts`, which the bare-DOM overlay entry (`src/overlay/main.ts`)
 * pulls in, and that entry must not drag any runtime into its bundle — the
 * same lightness constraint shipClass.ts's module header documents.
 */

/** Ship identity as derived from a runtime GameParams subtree — the same
 *  shape the baked DB entries carry, everything optional (a subtree may
 *  answer tier but not names, and the consumers tolerate partials). */
export interface RuntimeShipEntry {
  index?: string | null;
  tier?: number | null;
  type?: string | null;
  nation?: string | null;
  names?: Record<string, string> | null;
}

const entries = new Map<string, RuntimeShipEntry>();

/** Register (or replace) the runtime identity for one shipId. Idempotent:
 *  a later registration for the same id simply overwrites. */
export function registerRuntimeShipEntry(
  shipId: number | string,
  entry: RuntimeShipEntry,
): void {
  entries.set(String(shipId), { ...entry });
}

/** The runtime identity registered for a shipId, if any (null = the baked
 *  DB's own miss stands). */
export function runtimeShipEntry(
  shipId: number | string | null | undefined,
): RuntimeShipEntry | null {
  if (shipId == null) return null;
  return entries.get(String(shipId)) ?? null;
}

/** Test hook: drop every runtime registration (the baked DB is untouched). */
export function resetRuntimeShipEntries(): void {
  entries.clear();
}
