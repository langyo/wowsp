/**
 * Display formatting helpers shared across the webui.
 */

const BYTES_PER_MIB = 1_048_576;

/**
 * Formats a download speed for the update banner: megabytes per second
 * with one decimal. Absent / zero / non-finite speeds render as an
 * em-dash (the mirror race hasn't produced a sample yet).
 */
export function formatSpeed(bps?: number | null): string {
  if (bps === undefined || bps === null || !Number.isFinite(bps) || bps <= 0) {
    return "—";
  }
  return `${(bps / BYTES_PER_MIB).toFixed(1)} MB/s`;
}

/**
 * Renders a backend UTC stamp (RFC3339: the mod-catalog `fetchedAt`, the
 * ship-data pack manifest `version`, …) as the machine-local wall clock in
 * the stable `YYYY-MM-DD HH:MM` shape — or `YYYY-MM-DD` with `dateOnly`.
 * The backend stays UTC; conversion happens here because only this side
 * knows the user's timezone. Input that fails to parse keeps the legacy
 * raw-slice rendering so an unexpected format still shows something.
 */
export function formatLocalStamp(stamp: string | null | undefined, dateOnly = false): string {
  if (!stamp) return "";
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) {
    return dateOnly ? stamp.slice(0, 10) : stamp.replace("T", " ").slice(0, 16);
  }
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return dateOnly ? day : `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * Formats a download ETA as a compact digital-clock duration (MM:SS,
 * or H:MM:SS past an hour) — locale-neutral, so no plural forms are
 * needed. Non-positive / non-finite inputs render as an empty string;
 * callers simply drop the part.
 */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
