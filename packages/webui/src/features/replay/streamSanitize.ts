/**
 * Boundary normalization for decoded replay streams — the ONE place the raw
 * IPC payload is trusted, so every downstream map consumer (`sampleAt`, the
 * minimap painter, the shell/torpedo builders) can assume dense, finite
 * sample timelines.
 *
 * Why: an in-progress recording (the live `temp.wowsreplay` opened while the
 * battle runs) decodes entity timelines that never received a position
 * packet, and any payload quirk that slips a nullish or non-finite sample
 * into a timeline would otherwise resurface somewhere new as the "reading
 * 'time'" render-crash class (#956 took the whole replay view down that
 * way, and the crash also froze every later navigation — see main.ts's
 * errorHandler). Degenerate samples are dropped HERE in one place; empty
 * timelines stay, because kind/entityId joins still need them and
 * `sampleAt` already answers undefined for those.
 */
import type { EntityTrajectory, HpSample, PositionSample, ReplayStream } from "@/api";

function finitePos(s: PositionSample | null | undefined): s is PositionSample {
  return (
    s != null &&
    Number.isFinite(s.time) &&
    Number.isFinite(s.x) &&
    Number.isFinite(s.y) &&
    Number.isFinite(s.z) &&
    Number.isFinite(s.yaw)
  );
}

function finiteHp(s: HpSample | null | undefined): s is HpSample {
  return s != null && Number.isFinite(s.time) && Number.isFinite(s.value);
}

/** Keep the ORIGINAL array when nothing was dropped — the streams are large
 *  and the clean case is the norm, so the pass must not copy per open: a
 *  zero-allocation scan first, filter only when it actually finds dirt. */
function cleanHp(list: HpSample[] | null | undefined): HpSample[] | undefined {
  if (list == null) return undefined;
  for (const s of list) if (!finiteHp(s)) return list.filter(finiteHp);
  return list;
}

/** Normalize one trajectory in place; returns false when the entry itself is
 *  unusable (nullish) and should be dropped from the stream. */
function cleanTrajectory(tr: EntityTrajectory | null | undefined): tr is EntityTrajectory {
  if (tr == null) return false;
  // A malformed payload could carry a non-array `samples` — every consumer
  // indexes it, so coerce to the empty timeline rather than trust the shape.
  if (Array.isArray(tr.samples)) {
    let dirty = false;
    for (const s of tr.samples) {
      if (!finitePos(s)) {
        dirty = true;
        break;
      }
    }
    if (dirty) tr.samples = tr.samples.filter(finitePos);
  } else {
    tr.samples = [];
  }
  tr.hpSamples = cleanHp(tr.hpSamples);
  tr.capSamples = cleanHp(tr.capSamples);
  tr.capProgress = cleanHp(tr.capProgress);
  return true;
}

/** Drop degenerate entries from a freshly decoded stream, in place. Call
 *  once at the apply() boundary — before any reactive consumer reads it.
 *  Same zero-allocation rule as the per-array helpers: the top-level filter
 *  only runs when some entry actually failed. */
export function sanitizeReplayStream(stream: ReplayStream): void {
  if (Array.isArray(stream.trajectories)) {
    let dirty = false;
    for (const tr of stream.trajectories) {
      if (!cleanTrajectory(tr)) {
        dirty = true;
        break;
      }
    }
    if (dirty) {
      // Re-run every entry: the early break above skipped normalisation of
      // the tail, and the filter needs the predicate's side effects too.
      stream.trajectories = stream.trajectories.filter(cleanTrajectory);
    }
  } else {
    stream.trajectories = [];
  }
}
