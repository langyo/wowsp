/**
 * Solar location basis preference — where hikari's sun clock resolves its
 * coordinates from. The theme's "solar" mode flips day/dusk/night from the
 * sun altitude, so it needs a location; this preference decides how that
 * location is obtained:
 *
 *   "timezone" (default) → hikari's own OFFLINE estimate,
 *       timezoneFallback(): a longitude derived from the computer's live
 *       UTC offset (DST included) at hikari's REFERENCE latitude (31.23°N,
 *       Shanghai) — resolved on every clock refresh, so a changed machine
 *       timezone is honored from the next refresh/reload on, and no network
 *       request or permission prompt is ever made for it. The estimate is
 *       COARSE: the fixed reference latitude can put the dawn/dusk flip
 *       1–2 h off at mid/northern latitudes and inverts the season for
 *       southern-hemisphere users — pick "coordinates" when it matters.
 *
 *   "coordinates" → hikari's standard cascade: an ALREADY-GRANTED browser
 *       geolocation fix, else an IP lookup against ipapi.co (a network
 *       request that discloses the public IP to that third-party service;
 *       a theme never provokes a permission prompt either way).
 *
 * That privacy/network trade-off is the whole point of the choice, so the
 * default is the offline basis: wiring it before initTheme() means the sun
 * clock's FIRST resolution uses the estimate and a fresh install never
 * reveals its IP just to theme the app.
 *
 * The choice persists under `wowsp-solar-location-basis` (ours,
 * authoritative; heal-on-read like the other appearance preferences) and is
 * applied to hikari through the documented host seam
 * setGeolocationProvider: "timezone" registers a provider returning
 * timezoneBasisLocation(), "coordinates" passes null so hikari's own
 * cascade runs. Every change also refreshes the live clock, so the
 * period/readout re-resolves immediately instead of at the next tick —
 * through a serialized queue (refreshClock): hikari applies every
 * resolution it is handed, so a slow in-flight coordinates lookup must not
 * land after a later switch and overwrite the clock with the stale basis.
 */
import { ref } from "vue";

import {
  refreshThemeClock,
  setGeolocationProvider,
  timezoneFallback,
  type GeoLocation,
} from "@celestia-island/hikari";

import { notifySettingsSaved } from "@/stores/settingsSavedFlash";

export type SolarLocationBasis = "timezone" | "coordinates";

export const SOLAR_LOCATION_BASIS_STORAGE_KEY = "wowsp-solar-location-basis";
/** The shipped default: the offline estimate, never the IP lookup. */
export const SOLAR_LOCATION_BASIS_DEFAULT: SolarLocationBasis = "timezone";

function isSolarLocationBasis(value: unknown): value is SolarLocationBasis {
  return value === "timezone" || value === "coordinates";
}

/** Read + HEAL. A missing key means the shipped default and stays implicit —
 *  nothing is wrong on disk, and leaving it absent lets a future default
 *  change reach existing installs. A present but unknown value is forced
 *  back to the default so the correction sticks instead of re-defaulting on
 *  every boot. When storage itself throws, the preference degrades to the
 *  default for the session. */
export function readStoredSolarLocationBasis(): SolarLocationBasis {
  try {
    const raw = localStorage.getItem(SOLAR_LOCATION_BASIS_STORAGE_KEY);
    if (raw == null) return SOLAR_LOCATION_BASIS_DEFAULT;
    if (isSolarLocationBasis(raw)) return raw;
    localStorage.setItem(
      SOLAR_LOCATION_BASIS_STORAGE_KEY,
      SOLAR_LOCATION_BASIS_DEFAULT,
    );
    return SOLAR_LOCATION_BASIS_DEFAULT;
  } catch {
    return SOLAR_LOCATION_BASIS_DEFAULT;
  }
}

/** Reactive current basis — the appearance settings group binds its
 *  segmented control to this module-level ref. */
export const solarLocationBasis = ref<SolarLocationBasis>(
  readStoredSolarLocationBasis(),
);

/** The timezone basis's coordinates: hikari's documented offline estimate
 *  (longitude from the computer's CURRENT UTC offset at hikari's reference
 *  latitude). Delegated rather than reimplemented so the offset/DST
 *  semantics stay in hikari. */
export function timezoneBasisLocation(): GeoLocation {
  return timezoneFallback();
}

/** IANA id of the computer's configured timezone — the readout beside the
 *  basis choice. "UTC" when Intl cannot answer (a bare environment). */
export function systemTimeZoneId(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Register or clear hikari's host geolocation seam from the current basis.
 *  "timezone" installs a provider that answers from the offline estimate
 *  (no fetch, no permission prompt); "coordinates" passes null so hikari's
 *  own cascade runs (an already-granted browser fix first, then the IP
 *  lookup). */
function applySolarLocationBasis(): void {
  setGeolocationProvider(
    solarLocationBasis.value === "timezone"
      ? async () => timezoneBasisLocation()
      : null,
  );
}

/** Serialized clock refreshes — the LAST basis switch wins. hikari's
 *  refreshThemeClock() applies EVERY resolution it receives to the theme
 *  clock, and the coordinates cascade can stay in flight for seconds (the
 *  browser-permission probe then the IP lookup). Unserialized, a slow
 *  coordinates resolution started before a later timezone click would land
 *  afterwards and overwrite the clock with the stale basis — the period and
 *  the settings readout would then stay wrong until the next switch or boot.
 *  Queuing in click order costs at most the stale lookup's latency and ends
 *  on the user's last choice. The chain never rejects (getGeolocation()
 *  does not reject today) and is per module instance, i.e. per document.
 */
let refreshChain: Promise<unknown> = Promise.resolve();

/** Queue one clock refresh behind every earlier one (see refreshChain). */
function refreshClock(): void {
  refreshChain = refreshChain
    .then(() => refreshThemeClock())
    .catch(() => {
      // Keep the chain alive for the next switch even if a refresh throws.
    });
}

/** Boot settle — call it AFTER initTheme() in bootstrap(). hikari starts
 *  its own boot getGeolocation() inside initTheme(), BEFORE any host switch
 *  can exist, so that resolution is outside refreshChain. The settle task
 *  queues behind it: at this point the shared geoMemo promise is already in
 *  place (no extra network), the task awaits it, and every later basis switch
 *  queues behind BOTH. Without it a slow boot-time coordinates fix (stored
 *  basis = "coordinates", browser-permission probe → IP lookup, up to a few
 *  seconds) could land after the user has already switched to the timezone
 *  basis and overwrite the clock with the stale fix. */
export function settleSolarLocationPreference(): void {
  refreshClock();
}

/** Change + persist + apply immediately (appearance settings). A successful
 *  write gates the Saved flash (storage may be unavailable). Re-applying the
 *  seam plus the queued clock refresh makes the live period/readout
 *  re-resolve with the new basis right away. */
export function setSolarLocationBasis(basis: SolarLocationBasis): void {
  solarLocationBasis.value = basis;
  try {
    localStorage.setItem(SOLAR_LOCATION_BASIS_STORAGE_KEY, basis);
    notifySettingsSaved();
  } catch {
    // storage unavailable — the choice holds for the session
  }
  applySolarLocationBasis();
  refreshClock();
}

/** Boot hook. bootstrap.ts MUST call this BEFORE initTheme(): initTheme()
 *  starts hikari's theme clock, whose first getGeolocation() call reads
 *  whichever provider is registered at that moment. Registering the basis
 *  first means the clock's first resolution already honors it, so a fresh
 *  install (default "timezone") never triggers the IP lookup. Deliberately
 *  no refresh here: the clock is not running yet — initTheme() starts it
 *  against the freshly registered seam. */
export function initSolarLocationPreference(): void {
  applySolarLocationBasis();
}
