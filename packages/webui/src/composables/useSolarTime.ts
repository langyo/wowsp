/**
 * Solar altitude + time-period calculation. Ported from shittim-chest's
 * composables/useSolarTime.ts (the canonical full-precision implementation).
 *
 * Used by the theme system to auto-switch dark/light based on local sun
 * position: altitude > 6° = day (light), -6°..6° = dusk, < -6° = night
 * (dark). The math uses full Greenwich sidereal time + sun equatorial
 * coordinates (J2000 epoch), accurate to a fraction of a degree.
 */

export type TimePeriod = "day" | "dusk" | "night";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function toJulianDate(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function greenwichSiderealTime(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  let theta =
    (280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000) %
    360;
  if (theta < 0) theta += 360;
  return theta;
}

interface SunEquatorial {
  decl: number;
  ra: number;
}

function sunEquatorialCoordinates(jd: number): SunEquatorial {
  const T = (jd - 2451545.0) / 36525;
  const L0 = (280.46646 + 36000.76983 * T) % 360;
  const M = ((357.52911 + 35999.05029 * T) % 360) * DEG;
  const C =
    (1.9146 - 0.004817 * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M);
  let sunLon = (L0 + C) % 360;
  if (sunLon < 0) sunLon += 360;
  const omega = (125.04 - 1934.136 * T) * DEG;
  const lambda = sunLon * DEG - 0.00569 * DEG - 0.00478 * DEG * Math.sin(omega);
  const epsilon = (23.439291 - 0.013004 * T) * DEG;
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  return { decl, ra };
}

/** Solar altitude in degrees for a given location + time. */
export function solarAltitude(latDeg: number, lngDeg: number, date: Date): number {
  const jd = toJulianDate(date);
  const { decl, ra } = sunEquatorialCoordinates(jd);
  let haDeg = greenwichSiderealTime(jd) + lngDeg - ra * RAD;
  haDeg = (((haDeg + 180) % 360) + 360) % 360 - 180;
  const ha = haDeg * DEG;
  const lat = latDeg * DEG;
  const alt = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha));
  return alt * RAD;
}

/** Classify the current moment by sun position: day/dusk/night. */
export function getTimePeriod(latDeg: number, lngDeg: number, date: Date = new Date()): TimePeriod {
  const alt = solarAltitude(latDeg, lngDeg, date);
  if (alt > 6) return "day";
  if (alt > -6) return "dusk";
  return "night";
}

/** Default location (Shanghai) when geolocation is unavailable. */
export const DEFAULT_GEO_LOCATION = { lat: 31.23, lng: 121.47 };

const GEO_API_URL = "https://ipapi.co/json/";
const GEO_API_TIMEOUT_MS = 4000;

/** Best-effort timezone-based longitude fallback (when IP geolocation fails). */
function timezoneFallback(): { lat: number; lng: number } {
  const offsetMin = -new Date().getTimezoneOffset();
  const lng = offsetMin / 4;
  return { lat: DEFAULT_GEO_LOCATION.lat, lng };
}

/** Resolve the user's geolocation via IP (with timezone fallback). Caches to
 *  localStorage so we don't re-hit the IP API on every launch. */
export async function getGeolocation(): Promise<{ lat: number; lng: number }> {
  // Cache hit?
  const cached = localStorage.getItem("wowsp-geolocation");
  if (cached) {
    try {
      const g = JSON.parse(cached) as { lat: number; lng: number; ts: number };
      // Re-fetch at most once per day.
      if (Date.now() - g.ts < 86400000 && typeof g.lat === "number" && typeof g.lng === "number") {
        return { lat: g.lat, lng: g.lng };
      }
    } catch {
      // corrupt cache — fall through
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEO_API_TIMEOUT_MS);
    const r = await fetch(GEO_API_URL, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!r.ok) return timezoneFallback();
    const d = (await r.json()) as { latitude?: number; longitude?: number };
    if (
      d &&
      typeof d.latitude === "number" &&
      typeof d.longitude === "number" &&
      (Math.abs(d.latitude) > 0.01 || Math.abs(d.longitude) > 0.01)
    ) {
      const result = { lat: d.latitude, lng: d.longitude };
      localStorage.setItem(
        "wowsp-geolocation",
        JSON.stringify({ ...result, ts: Date.now() }),
      );
      return result;
    }
    return timezoneFallback();
  } catch {
    return timezoneFallback();
  }
}
