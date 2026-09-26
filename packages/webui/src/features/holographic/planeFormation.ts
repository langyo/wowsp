/**
 * Squadron formation layout math for the holographic map's aircraft layer.
 *
 * Three pure helpers, extracted verbatim from HolographicMap.tsx: the
 * per-plane offsets inside ONE flight group, the filled-wedge layout over
 * flight GROUPS, and the greedy clustering that infers a squadron's group
 * layout from its launch positions. No three.js / DOM / reactive state —
 * consumed by rebuildActors (model placement) and the per-frame formation
 * orbit in updateMarkersAt.
 */
import type { SquadronPlane } from "@/api";

/** Per-plane local offsets inside ONE flight group (the group's own wedge):
 *  1 → single, 2 → side by side, 3 → arrow (1 lead + 2 wing), 4+ → 2 up front
 *  and the rest trailing. Positive oz is BACKWARD along the heading (the
 *  leader flies at the front of the formation). */
export function groupInnerOffsets(n: number): { ox: number; oz: number }[] {
  const p = 9;
  if (n <= 1) return [{ ox: 0, oz: 0 }];
  if (n === 2) return [{ ox: -p, oz: 0 }, { ox: p, oz: 0 }];
  if (n === 3) return [{ ox: 0, oz: -p }, { ox: -p, oz: p }, { ox: p, oz: p }];
  const out: { ox: number; oz: number }[] = [
    { ox: -p, oz: -p },
    { ox: p, oz: -p },
  ];
  for (let i = 2; i < n; i++) {
    out.push({ ox: (i % 2 === 0 ? -1 : 1) * p, oz: p });
  }
  return out;
}

/** Filled-wedge layout over flight GROUPS: row r holds r+1 groups (1, 2, 3,
 *  …); a leftover group that cannot fill the next row sits centered in it.
 *  Examples: 6 groups → rows 1,2,3; 4 groups → 1,2,1; 7 → 1,2,3,1. */
export function formationOffsets(groupCount: number, groupSize: number): { ox: number; oz: number }[] {
  const out: { ox: number; oz: number }[] = [];
  let rem = groupCount;
  const rows: number[] = [];
  for (let r = 0; rem > 0; r++) {
    const n = Math.min(r + 1, rem);
    rows.push(n);
    rem -= n;
  }
  const gSpacing = 20;
  const gDepth = 15;
  rows.forEach((n, r) => {
    for (let k = 0; k < n; k++) {
      const gx = (k - (n - 1) / 2) * gSpacing;
      const gz = -r * gDepth;
      for (const it of groupInnerOffsets(groupSize)) {
        out.push({ ox: gx + it.ox, oz: gz + it.oz });
      }
    }
  });
  return out;
}

/** Infer the squadron's group layout by greedy-clustering the aircraft
 *  positions right after launch: planes spawn in groups (2/group, 3/group,
 *  …), so the median cluster size is the per-group count and the cluster
 *  count is the number of flight groups. */
export function inferGrouping(
  entries: { trail: { id: number; samples: SquadronPlane[] } }[],
  sampleAtFn: (tr: { samples: SquadronPlane[] }, t: number) => { x: number; z: number } | null,
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
