/**
 * One-time migration onto hikari's solar-location STRATEGY storage.
 *
 * WoWSP 0.6.8 shipped its own two-way basis preference under
 * `wowsp-solar-location-basis` ("timezone" | "coordinates"), layered on
 * hikari's geolocation-provider seam. hikari 0.55.241 owns the concept
 * natively (`hikari-solar-strategy`: "timezone" | "ip" | "manual", plus a
 * manual zone/hemisphere config in `hikari-solar-manual`), so the local
 * layer is retired. This module maps the stored choice ONCE — only when
 * hikari's key is absent (never over something the engine already healed
 * or the user already set on the new API) — and drops the old key:
 *
 *   "coordinates" → "ip"     (the real-fix cascade the old basis ran)
 *   "timezone"    → nothing  (hikari's default is already "timezone")
 *
 * bootstrap() runs it BEFORE initTheme(), so the engine's first hydration
 * already observes the mapped strategy and the boot resolution stays
 * offline unless the user explicitly picked otherwise.
 */
import {
  SOLAR_LOCATION_STRATEGY_STORAGE_KEY,
  setSolarLocationStrategy,
} from "@celestia-island/hikari";

const LEGACY_BASIS_STORAGE_KEY = "wowsp-solar-location-basis";

/** Map the retired local basis onto hikari's strategy storage.
 *  @returns "ip" when the legacy choice mapped, null when the engine
 *  should stay untouched (nothing legacy, already migrated, or storage
 *  unavailable — hikari's defaults then apply for the session). */
export function migrateSolarLocationBasis(): "ip" | null {
  try {
    const legacy = localStorage.getItem(LEGACY_BASIS_STORAGE_KEY);
    if (legacy == null) return null;
    localStorage.removeItem(LEGACY_BASIS_STORAGE_KEY);
    // Never over an explicit hikari-side choice.
    if (localStorage.getItem(SOLAR_LOCATION_STRATEGY_STORAGE_KEY) != null) {
      return null;
    }
    if (legacy === "coordinates") {
      setSolarLocationStrategy("ip"); // persists via the engine's own setter
      return "ip";
    }
    return null;
  } catch {
    return null;
  }
}
