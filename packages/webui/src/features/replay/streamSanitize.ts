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
 *  and the clean case is the norm, so the filter must not copy per open. */
function cleanHp(list: HpSample[] | null | undefined): HpSample[] | undefined {
  if (list == null) return undefined;
  const kept = list.filter(finiteHp);
  return kept.length === list.length ? list : kept;
}

/** Normalize one trajectory in place; returns false when the entry itself is
 *  unusable (nullish) and should be dropped from the stream. */
function cleanTrajectory(tr: EntityTrajectory | null | undefined): tr is EntityTrajectory {
  if (tr == null) return false;
  // A malformed payload could carry a non-array `samples` — every consumer
  // indexes it, so coerce to the empty timeline rather than trust the shape.
  if (Array.isArray(tr.samples)) {
    const kept = tr.samples.filter(finitePos);
    if (kept.length !== tr.samples.length) tr.samples = kept;
  } else {
    tr.samples = [];
  }
  tr.hpSamples = cleanHp(tr.hpSamples);
  tr.capSamples = cleanHp(tr.capSamples);
  tr.capProgress = cleanHp(tr.capProgress);
  return true;
}

/** Drop degenerate entries from a freshly decoded stream, in place. Call
 *  once at the apply() boundary — before any reactive consumer reads it. */
export function sanitizeReplayStream(stream: ReplayStream): void {
  if (Array.isArray(stream.trajectories)) {
    stream.trajectories = stream.trajectories.filter(cleanTrajectory);
  } else {
    stream.trajectories = [];
  }
}
