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
