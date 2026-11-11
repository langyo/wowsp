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
  for (let i = 1; i < n; i++) {
    const rank = Math.ceil(i / 2);
    const side = i % 2 === 1 ? -1 : 1;
    out.push({ ox: side * (w * rank), oz: d * rank });
  }
  return out;
}

/** Layout over flight GROUPS: every group sits ON A RING around the
 *  formation centre (group 0 at the front, then counter-clockwise — for 4
 *  groups that reads as front/right/back/left), each flying its own tight V
 *  (user spec: "前后左右各一组、每组一个梯形三机编队"). The old filled
 *  wedge (rows 1,2,3…) scattered the groups into an indistinct blob at
 *  orbit angles. */
export function formationOffsets(groupCount: number, groupSize: number): { ox: number; oz: number }[] {
  const out: { ox: number; oz: number }[] = [];
  const groups = Math.max(1, groupCount);
  const ring = 16;
  for (let g = 0; g < groups; g++) {
    const th = (2 * Math.PI * g) / groups;
    const gx = Math.sin(th) * ring;
    const gz = -Math.cos(th) * ring;
    for (const it of groupInnerOffsets(groupSize)) {
      out.push({ ox: gx + it.ox, oz: gz + it.oz });
    }
  }
  return out;
}

/** Infer the squadron's group layout by greedy-clustering the aircraft
 *  positions right after launch: planes spawn in groups (2/group, 3/group,
 *  …), so the median cluster size is the per-group count and the cluster
 *  count is the number of flight groups. */
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
  const clusters: { members: { x: number; z: number }[]; cx: number; cz: number }[] = [];
  for (const p of pts) {
    let best: (typeof clusters)[number] | null = null;
    let bestD = 45;
    for (const c of clusters) {
      const d = Math.hypot(c.cx - p.x, c.cz - p.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) {
      best.members.push(p);
      best.cx = best.members.reduce((a, q) => a + q.x, 0) / best.members.length;
      best.cz = best.members.reduce((a, q) => a + q.z, 0) / best.members.length;
    } else {
      clusters.push({ members: [p], cx: p.x, cz: p.z });
    }
  }
  const sizes = clusters.map((c) => c.members.length).sort((a, b) => a - b);
  return {
    groupSize: sizes[Math.floor(sizes.length / 2)] || 1,
    groupCount: clusters.length,
  };
}
