/**
 * Squadron formation math + the shared aircraft-trail lifetime for the
 * holographic map's aircraft layer.
 *
 * The layout helpers were extracted verbatim from HolographicMap.tsx: the
 * per-plane offsets inside ONE flight group, the filled-wedge layout over
 * flight GROUPS, and the greedy clustering that infers a squadron's group
 * layout from its launch positions. planeTrailExpiry pins the ONE lifetime
 * rule every aircraft surface reads (3D anchors, follow camera, 2D painter,
 * minimap hover). No three.js / DOM / reactive state — consumed by
 * rebuildActors (model placement), updateMarkersAt (formation orbit) and the
 * follow/painter paths.
 */
import type { SquadronPlane } from "@/api";
import planeGroupsRaw from "@/data/plane_groups.json";

const PLANE_GROUPS = planeGroupsRaw as Record<string, number>;

/** Extra seconds a squadron keeps rendering (and stays followable) after its
 *  last observed position sample — the last packet trails the visible patrol
 *  by a beat. Shared by the per-frame formation anchor pass (markerUpdate)
 *  and the follow-camera target resolver (followTargets), so the two never
 *  drift apart. */
export const PLANE_TRAIL_GRACE_S = 5;

/** Last time a formation trail is still visible/followable: one grace window
 *  after its last observed sample, capped by the minimap remove event
 *  (landed / shot down / recalled). Shared by the 3D anchor pass, the camera
 *  target resolver, the 2D painter and the minimap hover pick, so every
 *  aircraft surface disappears on the same tick instead of the 2D side
 *  lingering for its own hard-coded window. */
export function planeTrailExpiry(
  lastSampleTime: number,
  removeAt?: number,
): number {
  return Math.min(lastSampleTime + PLANE_TRAIL_GRACE_S, removeAt ?? Infinity);
}

/** Per-plane local offsets inside ONE flight group: a 梯形 V — the leader at
 *  the point, wingmen stepping BACK in alternating pairs (user spec: every
 *  group reads as a tight three-plane V, not a scattered row). Positive oz
 *  is BACKWARD along the heading. */
export function groupInnerOffsets(n: number): { ox: number; oz: number }[] {
  const w = 4.5;
  const d = 5.5;
  const out: { ox: number; oz: number }[] = [{ ox: 0, oz: 0 }];
  // +oz is the NOSE direction in the placement basis (slot = ox·right +
  // oz·fwd, fwd = (sin yaw, −cos yaw)), so wingmen step back with NEGATIVE oz.
  for (let i = 1; i < n; i++) {
    const rank = Math.ceil(i / 2);
    const side = i % 2 === 1 ? -1 : 1;
    // Even squadrons close the V with a CENTRED tail plane instead of a
    // one-sided rank: the alternating spiral hung the last plane off the
    // right wing (rank 2, side +1 on a four-plane group) with nothing
    // balancing it on the left — the lopsided arc the user flagged as
    // "still looks weird". Two-plane groups keep their side-by-side pair.
    const tail = n >= 4 && n % 2 === 0 && i === n - 1;
    out.push(tail ? { ox: 0, oz: -rank * d } : { ox: side * (w * rank), oz: -d * rank });
  }
  return out;
}

/** Lateral spacing between neighbouring flight groups (scene units). Must
 *  clear a whole group: the V inside one group spans 2 × w = 9 laterally
 *  (groupInnerOffsets), and the aircraft model is 4.6 long, so 26 leaves a
 *  readable channel between groups instead of one braided mass. */
export const GROUP_COL_LATERAL = 26;
/** Backward step per rank (scene units). The V's own deepest rank sits
 *  5.5 × 2 = 11 back (four-plane groups), so 22 keeps consecutive ranks
 *  visually separate. */
export const GROUP_RANK_DEPTH = 22;

/** Layout over flight GROUPS: a TRIANGULAR ARRAY (雁阵 / triangle), not a
 *  ring. Rank 0 holds the lead group on the centreline, rank 1 holds two
 *  groups left/right of it, rank 2 three, and so on — each rank is centred
 *  on the formation axis and steps back one GROUP_RANK_DEPTH
 *  (+oz is the nose direction in the placement basis, so negative oz steps
 *  back). Every group keeps its own tight V from groupInnerOffsets.
 *
 *  The layout used to place the groups ON A RING (sin/cos at radius 16), which
 *  from any chase angle read as one braided mass — "你这飞机缠绕的跟麻花一样"
 *  and "编组仍然不明显" (2026-11-12 review). A triangle keeps the groups
 *  separated along a consistent axis, so the wing reads as a formation from
 *  the front, the side and above alike. */
export function formationOffsets(groupCount: number, groupSize: number): { ox: number; oz: number }[] {
  const out: { ox: number; oz: number }[] = [];
  const groups = Math.max(1, groupCount);
  let placed = 0;
  let rank = 0;
  while (placed < groups) {
    // Rank r holds up to r + 1 groups, centred on the axis.
    const inRank = Math.min(rank + 1, groups - placed);
    const depth = -GROUP_RANK_DEPTH * rank;
    for (let i = 0; i < inRank; i++) {
      const lateral = (i - (inRank - 1) / 2) * GROUP_COL_LATERAL;
      for (const it of groupInnerOffsets(groupSize)) {
        out.push({ ox: lateral + it.ox, oz: depth + it.oz });
      }
      placed++;
    }
    rank++;
  }
  return out;
}

/** Shortest signed difference between two headings (radians), in (−π, π].
 *  Yaw samples wrap at ±π, so a plain subtraction reads a 350°→10° turn as
 *  −340° and would bank the model the wrong way. */
export function headingDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Maximum bank (radians) the aircraft rolls into a turn. Real wings bank
 *  hard, but at marker scale an extreme roll reads as a glitch — 40° keeps
 *  the turn legible without looking broken. */
export const PLANE_MAX_BANK = (40 * Math.PI) / 180;

/** Heading rate (rad/s) that saturates the bank: a wing at or above this
 *  turn rate flies at PLANE_MAX_BANK. */
export const PLANE_BANK_SATURATION = 0.9;

/** Roll (radians, +left / −right as yaw increases) for a wing turning at
 *  `rate` rad/s: proportional until PLANE_BANK_SATURATION, then clamped.
 *  A left turn (positive rate, since yaw grows counter-clockwise seen from
 *  above) rolls the model LEFT — the wing banks INTO the turn, which is what
 *  the camera-side lean makes the eye expect (2026-11-12 review: the turn
 *  leaned the view while the aircraft stayed flat). */
export function bankForTurnRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  const norm = Math.max(-1, Math.min(1, rate / PLANE_BANK_SATURATION));
  return norm * PLANE_MAX_BANK;
}

/** Heading rate (rad/s) between two samples, or null when the pair carries
 *  no usable dt. Used per formation slot to derive the bank. */
export function headingRate(
  prevYaw: number | null | undefined,
  prevT: number | null | undefined,
  yaw: number | null | undefined,
  t: number | null | undefined,
): number | null {
  if (prevYaw == null || prevT == null || yaw == null || t == null) return null;
  const dt = t - prevT;
  if (!(dt > 1e-3)) return null;
  return headingDelta(prevYaw, yaw) / dt;
}

/** Planes per flight GROUP, straight off the airframe's GameParams
 *  `formations.aerialAttack` slot table (extract_plane_groups.py). This is
 *  the AUTHORITATIVE grouping — the same table the game's HUD reads to
 *  draw one segmented bar per group — not a heuristic: 892 of 894
 *  airframes lay their slots out in strict three-plane groups, so a
 *  T10 squadron is three groups of three, not nine singles.
 *
 *  Returns null for a paramsId the table does not know (a modded or
 *  brand-new airframe), which lets callers fall back to the positional
 *  inference below. */
export function groupSizeOfParams(paramsId: number | undefined): number | null {
  if (paramsId == null) return null;
  const v = PLANE_GROUPS[String(paramsId)];
  return typeof v === "number" && v >= 1 ? v : null;
}

/** Infer the squadron's group layout by greedy-clustering the aircraft
 *  positions right after launch — the FALLBACK for airframes the grouping
 *  table does not cover. Prefer `groupSizeOfParams` when a paramsId is
 *  available: clustering only ever guesses at what GameParams records
 *  exactly, and it mis-reads wide launches as many single-plane groups. */
export function inferGrouping(
  entries: { trail: { id: number; samples: SquadronPlane[] } }[],
  sampleAtFn: (
    tr: { id: number; samples: SquadronPlane[] },
    t: number,
  ) => { x: number; z: number } | null | undefined,
): { groupSize: number; groupCount: number } {
  const t0 = Math.min(...entries.map((e) => e.trail.samples[0]?.time ?? 0));
  const pts: { x: number; z: number }[] = [];
  for (const e of entries) {
    const s = sampleAtFn(e.trail, t0 + 0.05);
    if (s) pts.push(s);
  }
  if (pts.length < 2) return { groupSize: 1, groupCount: Math.max(1, pts.length) };
  // The launch spread varies with the squadron size and the carrier's deck
  // layout — a fixed 45-unit threshold mis-clustered wide 10-plane launches
  // into N groups of 1 (user report: a ring of singles). Grow the threshold
  // until the clusters collapse into a plausible flight structure (the game
  // flies at most ~4 attack groups per squadron), preferring BALANCED
  // groups (all the same size) — an unbalanced split means the threshold is
  // still fragmenting real groups.
  let best: { groupSize: number; groupCount: number } | null = null;
  for (const threshold of [45, 90, 180, 360, 720]) {
    const clusters: { members: { x: number; z: number }[]; cx: number; cz: number }[] = [];
    for (const p of pts) {
      let hit: (typeof clusters)[number] | null = null;
      let bestD = threshold;
      for (const c of clusters) {
        const d = Math.hypot(c.cx - p.x, c.cz - p.z);
        if (d < bestD) {
          bestD = d;
          hit = c;
        }
      }
      if (hit) {
        hit.members.push(p);
        hit.cx = hit.members.reduce((a, q) => a + q.x, 0) / hit.members.length;
        hit.cz = hit.members.reduce((a, q) => a + q.z, 0) / hit.members.length;
      } else {
        clusters.push({ members: [p], cx: p.x, cz: p.z });
      }
    }
    const sizes = clusters.map((c) => c.members.length).sort((a, b) => a - b);
    const candidate = {
      groupSize: sizes[Math.floor(sizes.length / 2)] || 1,
      groupCount: clusters.length,
    };
    // Balanced (all clusters exactly equal) at a plausible group count wins
    // immediately; a 3/3/4 launch is rejected here and a later threshold
    // may win with a different split — visual only, still a valid read.
    if (candidate.groupCount <= 4 && new Set(sizes).size === 1) {
      return candidate;
    }
    if (best === null || candidate.groupCount < best.groupCount) best = candidate;
  }
  // Clamp the least-fragmented fallback: the game flies at most ~4 attack
  // groups, and an unbounded count re-creates the ring-of-singles look.
  const fallbackSize = Math.max(1, Math.ceil(pts.length / 4));
  return best ?? { groupSize: fallbackSize, groupCount: Math.ceil(pts.length / fallbackSize) };
}
