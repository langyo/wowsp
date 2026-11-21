/** Unit tests for the squadron formation layout math (pure functions). */
import { describe, expect, it } from "vitest";
import {
  bankForTurnRate,
  formationOffsets,
  GROUP_COL_LATERAL,
  GROUP_RANK_DEPTH,
  headingDelta,
  headingRate,
  PLANE_BANK_SATURATION,
  PLANE_MAX_BANK,
  groupInnerOffsets,
  groupSizeOfParams,
  inferGrouping,
  PLANE_TRAIL_GRACE_S,
  planeTrailExpiry,
  RETURN_BORN_MIN_NET_M,
  RETURN_BORN_RECEDE_SLACK_M,
  RETURN_CONFIRM_S,
  RETURN_CLOSING_WINDOW_S,
  RETURN_DIVE_PITCH_DEG,
  RETURN_MIN_CLOSING_M,
  squadronReturningSince,
} from "./planeFormation";
import { SQUADRON_ATTACK_PITCH_DEG } from "./planeFollow";
import type { SquadronPlane } from "@/api";

const sp = (time: number, x: number, z: number): SquadronPlane => ({
  time, planeId: 1, index: 0, x, y: 20, z, yaw: 0,
});

describe("groupSizeOfParams (GameParams aerialAttack slots)", () => {
  it("reports the recorded three-plane group for a real airframe", () => {
    // PAAB001_Douglas_TBD: formations.aerialAttack slots are strict
    // three-plane groups (extract_plane_groups.py, 892/894 airframes).
    expect(groupSizeOfParams(4293885936)).toBe(3);
  });

  it("returns null for an unknown airframe so callers can fall back", () => {
    expect(groupSizeOfParams(1)).toBeNull();
    expect(groupSizeOfParams(undefined)).toBeNull();
  });

  it("has no one-plane rows left (ragged tables fall back to inference)", () => {
    // PAAB952_TBM3 / PAAD910_BTD_1 carry a flight-shaped aerialAttack table
    // whose third component is a per-plane offset, not a group id; the
    // extractor must skip them instead of answering 1 (one-plane groups
    // were the reported bug). Every committed row is a real group size.
    expect(groupSizeOfParams(3296690160)).toBeNull();
    expect(groupSizeOfParams(3340664816)).toBeNull();
  });
});

describe("planeTrailExpiry", () => {
  it("adds the shared grace window when the replay recorded no remove", () => {
    expect(planeTrailExpiry(100)).toBe(100 + PLANE_TRAIL_GRACE_S);
    expect(planeTrailExpiry(43.5, undefined)).toBe(43.5 + PLANE_TRAIL_GRACE_S);
  });

  it("caps the grace window at an earlier minimap remove (landed/shot down)", () => {
    expect(planeTrailExpiry(100, 101)).toBe(101);
    expect(planeTrailExpiry(100, 100)).toBe(100);
  });

  it("keeps the grace window when the remove lands after it", () => {
    expect(planeTrailExpiry(100, 500)).toBe(100 + PLANE_TRAIL_GRACE_S);
    expect(planeTrailExpiry(0, Infinity)).toBe(PLANE_TRAIL_GRACE_S);
  });
});

describe("groupInnerOffsets", () => {
  it("renders a single plane at the group origin", () => {
    expect(groupInnerOffsets(1)).toEqual([{ ox: 0, oz: 0 }]);
  });

  it("lays three planes in a 梯形 V (lead front, wingmen behind)", () => {
    expect(groupInnerOffsets(3)).toEqual([
      { ox: 0, oz: 0 },
      { ox: -4.5, oz: -5.5 },
      { ox: 4.5, oz: -5.5 },
    ]);
  });

  it("steps wingmen back in alternating pairs for 5 planes", () => {
    const out = groupInnerOffsets(5);
    expect(out).toHaveLength(5);
    expect(out[1]).toEqual({ ox: -4.5, oz: -5.5 });
    expect(out[2]).toEqual({ ox: 4.5, oz: -5.5 });
    expect(out[3]).toEqual({ ox: -9, oz: -11 });
    expect(out[4]).toEqual({ ox: 9, oz: -11 });
  });

  it("closes a four-plane V with a centred tail (diamond, not a stray wing)", () => {
    const out = groupInnerOffsets(4);
    expect(out).toEqual([
      { ox: 0, oz: 0 },
      { ox: -4.5, oz: -5.5 },
      { ox: 4.5, oz: -5.5 },
      { ox: 0, oz: -11 },
    ]);
  });

  it("keeps two-plane groups side by side (no tail column)", () => {
    expect(groupInnerOffsets(2)).toEqual([
      { ox: 0, oz: 0 },
      { ox: -4.5, oz: -5.5 },
    ]);
  });

  it("closes a six-plane V with a centred third-rank tail", () => {
    const out = groupInnerOffsets(6);
    expect(out).toEqual([
      { ox: 0, oz: 0 },
      { ox: -4.5, oz: -5.5 },
      { ox: 4.5, oz: -5.5 },
      { ox: -9, oz: -11 },
      { ox: 9, oz: -11 },
      { ox: 0, oz: -16.5 },
    ]);
  });
});

describe("formationOffsets (triangular array)", () => {
  it("puts the lead group on the centreline at the origin", () => {
    const out = formationOffsets(1, 3);
    expect(out).toHaveLength(3);
    // The V's leader is the first slot of the first group.
    expect(out[0]).toEqual({ ox: 0, oz: 0 });
  });

  it("spreads four groups as a triangle: one lead, two wing, one trail", () => {
    // Rank 0 = lead, rank 1 = left + right, rank 2 = centre trail. NOT a
    // ring: the groups must stay on one axis-aligned pyramid so the wing
    // reads as a formation from every chase angle (2026-11-12 review).
    const out = formationOffsets(4, 1);
    expect(out).toHaveLength(4);
    const [a, b, c, d] = out;
    expect(a).toEqual({ ox: 0, oz: 0 });
    expect(b.ox).toBeCloseTo(-GROUP_COL_LATERAL / 2);
    expect(b.oz).toBeCloseTo(-GROUP_RANK_DEPTH);
    expect(c.ox).toBeCloseTo(GROUP_COL_LATERAL / 2);
    expect(c.oz).toBeCloseTo(-GROUP_RANK_DEPTH);
    expect(d.ox).toBeCloseTo(0);
    expect(d.oz).toBeCloseTo(-GROUP_RANK_DEPTH * 2);
  });

  it("keeps rank r at r + 1 groups, centred, widening backwards", () => {
    const out = formationOffsets(6, 1);
    expect(out).toHaveLength(6);
    // rank 0: 1 group, rank 1: 2, rank 2: 3
    const depths = out.map((o) => o.oz);
    expect(depths.filter((d) => d === 0)).toHaveLength(1);
    expect(depths.filter((d) => d === -GROUP_RANK_DEPTH)).toHaveLength(2);
    expect(depths.filter((d) => d === -GROUP_RANK_DEPTH * 2)).toHaveLength(3);
    // Symmetric about the axis: the lateral offsets of each rank sum to 0.
    expect(out[1].ox + out[2].ox).toBeCloseTo(0);
    expect(out[3].ox + out[4].ox + out[5].ox).toBeCloseTo(0);
  });

  it("scales slot count with groups x planes", () => {
    expect(formationOffsets(4, 3)).toHaveLength(12);
    expect(formationOffsets(6, 1)).toHaveLength(6);
  });

  it("keeps every group's V intact (offsets cluster per group)", () => {
    const out = formationOffsets(4, 3);
    const g0 = out.slice(0, 3);
    for (const o of g0) {
      // Group 0 is the V at the origin: every slot sits within one V reach
      // of it (w × 1 and d × 1), far tighter than the group spacing.
      expect(Math.hypot(o.ox, o.oz)).toBeLessThan(Math.hypot(4.5, 5.5) + 0.01);
    }
  });

  it("leaves a readable channel between groups at every rank", () => {
    const out = formationOffsets(6, 3);
    // Distinct group origins (rank 1 pair) stay a full lateral step apart,
    // far wider than one group's own lateral spread (2 × w = 9).
    expect(GROUP_COL_LATERAL).toBeGreaterThan(9);
    expect(GROUP_RANK_DEPTH).toBeGreaterThan(11);
    expect(out).toHaveLength(18);
  });
});

describe("banking (roll into the turn)", () => {
  it("normalises the heading delta across the ±π wrap", () => {
    // 350° → 10° is a +20° turn, not −340°.
    const from = (350 * Math.PI) / 180;
    const to = (10 * Math.PI) / 180;
    expect((headingDelta(from, to) * 180) / Math.PI).toBeCloseTo(20);
    expect((headingDelta(to, from) * 180) / Math.PI).toBeCloseTo(-20);
  });

  it("banks proportionally and saturates at the clamp", () => {
    expect(bankForTurnRate(0)).toBeCloseTo(0);
    const half = bankForTurnRate(PLANE_BANK_SATURATION / 2);
    expect(half).toBeCloseTo(PLANE_MAX_BANK / 2);
    // Anything at or beyond the saturation rate keeps the clamp (never flips).
    expect(bankForTurnRate(PLANE_BANK_SATURATION)).toBeCloseTo(PLANE_MAX_BANK);
    expect(bankForTurnRate(PLANE_BANK_SATURATION * 10)).toBeCloseTo(PLANE_MAX_BANK);
    expect(bankForTurnRate(-PLANE_BANK_SATURATION * 10)).toBeCloseTo(-PLANE_MAX_BANK);
  });

  it("derives the turn rate from a sample pair, rejecting unusable dt", () => {
    // 90° over one second = π/2 rad/s.
    expect(headingRate(0, 10, Math.PI / 2, 11)).toBeCloseTo(Math.PI / 2);
    // Missing/zero/negative dt carries no rate.
    expect(headingRate(0, 10, 1, 10)).toBeNull();
    expect(headingRate(null, 10, 1, 11)).toBeNull();
    expect(headingRate(0, 10, undefined, 11)).toBeNull();
  });

  it("banks left on a left turn and right on a right turn", () => {
    expect(bankForTurnRate(0.5)).toBeGreaterThan(0);
    expect(bankForTurnRate(-0.5)).toBeLessThan(0);
  });
});

describe("inferGrouping", () => {
  const sampleFirst = (tr: { samples: SquadronPlane[] }, _t: number) =>
    tr.samples.length > 0 ? { x: tr.samples[0].x, z: tr.samples[0].z } : null;

  it("degenerates to one group for a lone plane", () => {
    const entries = [{ trail: { id: 16, samples: [sp(0, 0, 0)] } }];
    expect(inferGrouping(entries, sampleFirst)).toEqual({ groupSize: 1, groupCount: 1 });
  });

  it("keeps well-separated planes in separate groups", () => {
    const entries = [
      { trail: { id: 16, samples: [sp(0, 0, 0)] } },
      { trail: { id: 16, samples: [sp(0, 500, 0)] } },
    ];
    expect(inferGrouping(entries, sampleFirst)).toEqual({ groupSize: 1, groupCount: 2 });
  });

  it("clusters planes launched together into one group", () => {
    const entries = [
      { trail: { id: 16, samples: [sp(0, 0, 0)] } },
      { trail: { id: 17, samples: [sp(0, 10, 0)] } },
    ];
    expect(inferGrouping(entries, sampleFirst)).toEqual({ groupSize: 2, groupCount: 1 });
  });

  it("chunks a wide 10-plane launch into at most four groups", () => {
    // 10 planes spread 0..360 units — the old fixed 45-unit threshold
    // fragmented this into ten groups of 1 (the ring-of-singles report).
    const entries = Array.from({ length: 10 }, (_, i) => ({
      trail: { id: 16 + i, samples: [sp(i * 40, 0, 0)] },
    }));
    const out = inferGrouping(entries, sampleFirst);
    expect(out.groupCount).toBeLessThanOrEqual(4);
    expect(out.groupSize * out.groupCount).toBeGreaterThanOrEqual(10);
  });
});
/* ── Homeward-bound (post-strike) squadron detection ─────────────────────
 * The user requirement hides every returning wing's marker (2D) / floating
 * card (3D). No wire bit names that state, so the detector derives it from
 * the aircraft attitude byte + the wing's range to its carrier — and these
 * tests pin BOTH halves of that contract: the geometric proof, and the fact
 * that the answer is a pure function of the playhead (scrubbing never
 * flickers, never depends on where playback came from). */

/** Carrier timeline: the CV parks at the world origin (the real thing moves
 *  at ~10 m/s — an order of magnitude below the wing's speed, so a static
 *  track keeps the arithmetic readable without changing the test's meaning). */
const parkedCarrier = (until = 200) => ({
  samples: Array.from({ length: until + 1 }, (_, i) => ({ time: i, x: 0, z: 0 })),
});

/** One aircraft position sample; `pitch` is the attitude byte the 3D
 *  stream carries (undefined = a minimap centre sample / pre-attitude
 *  stream). */
const pt = (
  time: number,
  x: number,
  z = 0,
  pitch?: number,
): { time: number; x: number; z: number; pitch?: number } =>
  pitch == null ? { time, x, z } : { time, x, z, pitch };

const WING_SPEED = 60; // m/s — a WoWS strike wing's cruise
const OUTBOUND_S = 20; // cruise out to the target
const DIVE_S = 3; // attack-run dive (pitch −35°)
const OUT_X = WING_SPEED * OUTBOUND_S;

/** A full sortie trail at 1 Hz: out, optional attack dive, optional return.
 *  `home` false keeps the wing outbound (the strike-bound control). */
function sortie(opts: { dive: boolean; home: boolean; until?: number }) {
  const until = opts.until ?? 48;
  const out: ReturnType<typeof pt>[] = [];
  for (let t = 0; t <= until; t++) {
    if (t <= OUTBOUND_S) {
      out.push(pt(t, WING_SPEED * t));
    } else if (opts.dive && t < OUTBOUND_S + DIVE_S) {
      // The dive: the wing drops its ordnance nearly on the spot.
      out.push(pt(t, OUT_X + 5 * (t - OUTBOUND_S), 0, -35));
    } else if (opts.home) {
      const t0 = OUTBOUND_S + (opts.dive ? DIVE_S : 0);
      out.push(pt(t, OUT_X - WING_SPEED * (t - t0)));
    } else {
      out.push(pt(t, WING_SPEED * t));
    }
  }
  return out;
}

describe("squadronReturningSince (derived homeward-bound state)", () => {
  it("keeps the −25° dive threshold in step with the follow card's badge", () => {
    // Same literal, two modules (planeFollow imports this one, so sharing the
    // constant itself would mean a module cycle).
    expect(RETURN_DIVE_PITCH_DEG).toBe(SQUADRON_ATTACK_PITCH_DEG);
  });

  it("is not returning before any attack has been flown", () => {
    const track = parkedCarrier();
    expect(squadronReturningSince(sortie({ dive: false, home: true }), track, 15)).toBeNull();
    // A wing that closes on the carrier WITHOUT ever diving (a ferry flight, a
    // recce run) is not a "returning strike wing" — no attack, no proof.
    expect(squadronReturningSince(sortie({ dive: false, home: true }), track, 40)).toBeNull();
    expect(squadronReturningSince(sortie({ dive: false, home: false }), track, 45)).toBeNull();
  });

  it("confirms a post-strike return leg once the closing run is long enough", () => {
    const track = parkedCarrier();
    const trail = sortie({ dive: true, home: true });
    // The LAST dive sample is t = 22, so the earliest sample that can measure
    // an 8 s closing window is 30; the run must then hold RETURN_CONFIRM_S —
    // the very first provable sample is 40.
    const expected = OUTBOUND_S + DIVE_S - 1 + RETURN_CLOSING_WINDOW_S + RETURN_CONFIRM_S;
    expect(expected).toBe(40);
    expect(squadronReturningSince(trail, track, expected - 1)).toBeNull();
    expect(squadronReturningSince(trail, track, expected)).toBe(expected);
    // The proof is a latch: everything after it stays "returning".
    expect(squadronReturningSince(trail, track, 45)).toBe(expected);
    expect(squadronReturningSince(trail, track, 48)).toBe(expected);
  });

  it("proves the leg with a MOVING carrier, measured at each sample's time", () => {
    // The carrier steams away from the wing at 10 m/s: the wing must still
    // close on the carrier's pose AT THAT SAMPLE, not on its launch position.
    const track = {
      samples: Array.from({ length: 121 }, (_, i) => ({ time: i, x: 0, z: 10 * i })),
    };
    const trail = sortie({ dive: true, home: true });
    const since = squadronReturningSince(trail, track, 48);
    expect(since).not.toBeNull();
    expect(since!).toBeGreaterThanOrEqual(23 + RETURN_CLOSING_WINDOW_S);
  });

  it("never confirms a wing that crosses the map instead of flying home", () => {
    // Perpendicular leg: the range to the carrier grows, not shrinks.
    const track = parkedCarrier();
    const trail: ReturnType<typeof pt>[] = [];
    for (let t = 0; t <= 48; t++) {
      if (t <= OUTBOUND_S) trail.push(pt(t, WING_SPEED * t));
      else if (t < OUTBOUND_S + DIVE_S) trail.push(pt(t, OUT_X, 0, -35));
      else trail.push(pt(t, OUT_X, 10 * (t - OUTBOUND_S - DIVE_S)));
    }
    expect(squadronReturningSince(trail, track, 48)).toBeNull();
  });

  it("re-arms the proof when the wing dives into a SECOND attack run", () => {
    // A second strike run means the wing is attacking again, not going home —
    // the marker must come back, and a fresh closing run must re-prove.
    const track = parkedCarrier();
    const trail: ReturnType<typeof pt>[] = [];
    for (let t = 0; t <= 70; t++) {
      if (t <= OUTBOUND_S) trail.push(pt(t, WING_SPEED * t));
      else if (t <= 23) trail.push(pt(t, OUT_X, 0, -35)); // strike run 1
      else if (t <= 31) trail.push(pt(t, OUT_X - 25 * (t - 24))); // home leg 1
      else if (t <= 34) trail.push(pt(t, OUT_X - 25 * 7, 0, -40)); // strike run 2
      else trail.push(pt(t, OUT_X - 175 - 25 * (t - 35))); // home leg 2
    }
    // The second dive is at t = 34, so the re-proof lands 8 + 10 s later.
    const expected = 34 + RETURN_CLOSING_WINDOW_S + RETURN_CONFIRM_S;
    expect(squadronReturningSince(trail, track, 31)).toBeNull(); // run 1 not yet proven
    expect(squadronReturningSince(trail, track, 45)).toBeNull(); // re-armed by the dive
    expect(squadronReturningSince(trail, track, expected - 1)).toBeNull();
    expect(squadronReturningSince(trail, track, expected)).toBe(expected);
    expect(expected).toBe(52);
  });

  it("answers identically at any scrub position, in any order", () => {
    // THE scrub-stability contract: the fold reads only samples at or before
    // t, so evaluating t directly (backwards, shuffled, on a fresh array that
    // cannot hit the memo) must equal a forward playback sweep.
    const track = parkedCarrier();
    const trail = sortie({ dive: true, home: true });
    const probes = [0, 5, 20, 22, 23, 30, 40, 41, 44, 48];
    const forward = new Map<number, number | null>();
    for (const t of probes) forward.set(t, squadronReturningSince(trail, track, t));
    // Backwards over a FRESH copy of the same trail (defeats the memo cache).
    for (const t of [...probes].reverse()) {
      expect(squadronReturningSince(sortie({ dive: true, home: true }), track, t)).toBe(
        forward.get(t),
      );
      // ...and on the very same array, out of order.
      expect(squadronReturningSince(trail, track, t)).toBe(forward.get(t));
    }
    // The transition is monotone: once proven, never unproven.
    let seen = false;
    for (let t = 0; t <= 48; t++) {
      const since = squadronReturningSince(trail, track, t);
      if (since != null) seen = true;
      if (seen) expect(since).toBe(forward.get(41));
    }
    expect(forward.get(41)).not.toBeNull();
  });

  it("treats an unknown wing as 'not returning' (today's rendering)", () => {
    const track = parkedCarrier();
    // No carrier join.
    expect(squadronReturningSince(sortie({ dive: true, home: true }), null, 45)).toBeNull();
    expect(squadronReturningSince(sortie({ dive: true, home: true }), undefined, 45)).toBeNull();
    expect(squadronReturningSince(sortie({ dive: true, home: true }), { samples: [] }, 45)).toBeNull();
    // No trail at all / before the first sample.
    expect(squadronReturningSince([], track, 45)).toBeNull();
    expect(squadronReturningSince(sortie({ dive: true, home: true }), track, -1)).toBeNull();
    // A pre-attitude stream (every pitch undefined): never an attack, never a
    // return — the marker must render exactly as before.
    const noPitch = sortie({ dive: true, home: true }).map((s) => pt(s.time, s.x, s.z));
    expect(squadronReturningSince(noPitch, track, 48)).toBeNull();
    // A dive the range test cannot follow (the window never elapses).
    expect(
      squadronReturningSince(sortie({ dive: true, home: true, until: 26 }), track, 26),
    ).toBeNull();
  });

  it("only hides once the leg is PROVEN (the constants are the contract)", () => {
    // Guard the three numbers the behaviour leans on: a shorter window, a
    // smaller closing threshold or a shorter run would prove legs the module's
    // header says are NOT proven.
    expect(RETURN_CLOSING_WINDOW_S).toBe(8);
    expect(RETURN_MIN_CLOSING_M).toBe(120);
    expect(RETURN_CONFIRM_S).toBe(10);
  });
});

/* ── The dive-free proof: a trail whose whole life is one homeward leg ────
 * Torpedo bombers fly a LEVEL torpedo run, so the −25° attitude latch can
 * never answer for a TB sortie's return leg — and TB wings are exactly what
 * the recorder's own CV keeps in the air. The stream still records the fact:
 * after an attack the game re-creates the survivors as a FRESH squadron
 * object in mid-air, hundreds of metres out, and that object only ever flies
 * home (measured on the 14.5.0.0 Shokaku 37_Ridge capture: every mid-air
 * create of the CV's TB/dive airframes closed on its carrier and ended on the
 * deck). The fold therefore proves a wing whose trail BEGAN far out and never
 * receded. */

/** A trail that starts `fromX` metres out and moves toward (direction −1) or
 *  away from (+1) a parked carrier at cruise speed — the returning group's
 *  shape. Level flight: no pitch byte at all, so the attitude latch is out of
 *  the picture. */
function bornHomeward(fromX = 900, until = 48, direction = -1) {
  const out: ReturnType<typeof pt>[] = [];
  for (let t = 0; t <= until; t++) {
    out.push(pt(t, fromX + direction * WING_SPEED * t));
  }
  return out;
}

describe("squadronReturningSince (dive-free: born on a homeward leg)", () => {
  it("proves a level torpedo wing's return leg with no attitude byte", () => {
    const track = parkedCarrier();
    const trail = bornHomeward(900);
    // 900 m out at t=0: the net-closing threshold lands at t=5, the confirm
    // window at t=10 → the first provable sample is 10.
    expect(squadronReturningSince(trail, track, 9)).toBeNull();
    expect(squadronReturningSince(trail, track, 10)).toBe(10);
    // Latch: the rest of the trail stays returning, and the wing ends on deck.
    expect(squadronReturningSince(trail, track, 15)).toBe(10);
    expect(squadronReturningSince(trail, track, 48)).toBe(10);
  });

  it("never flags a wing born on the deck (it must fly OUT before coming home)", () => {
    const track = parkedCarrier();
    // Launched and recovered: the classic out-and-back sortie, no dive.
    expect(squadronReturningSince(sortie({ dive: false, home: true }), track, 45)).toBeNull();
    expect(squadronReturningSince(sortie({ dive: false, home: false }), track, 45)).toBeNull();
  });

  it("never flags a wing that receded from its carrier at any point", () => {
    const track = parkedCarrier();
    // Born 900 m out, flies FURTHER out — an outbound sortie, not a return.
    expect(squadronReturningSince(bornHomeward(900, 48, +1), track, 48)).toBeNull();
    // Born far out but its first leg pushes out past the slack, then it turns
    // home: the trail is not a born return leg, and with no dive there is no
    // other proof — deliberately unknown rather than guessed.
    const outThenHome: ReturnType<typeof pt>[] = [];
    for (let t = 0; t <= 48; t++) {
      outThenHome.push(
        t <= 10 ? pt(t, 900 + WING_SPEED * t) : pt(t, 1500 - WING_SPEED * (t - 10)),
      );
    }
    expect(squadronReturningSince(outThenHome, track, 48)).toBeNull();
  });

  it("needs both the net closing distance and the confirm window", () => {
    const track = parkedCarrier();
    // Under the floor a trail is a short hop, never a proven return.
    expect(
      squadronReturningSince(bornHomeward(RETURN_BORN_MIN_NET_M - 1), track, 45),
    ).toBeNull();
    // A leg too young to confirm stays unproven even though it closes.
    expect(squadronReturningSince(bornHomeward(900, 8), track, 8)).toBeNull();
  });

  it("keeps the born-homeward thresholds as the contract", () => {
    expect(RETURN_BORN_MIN_NET_M).toBe(300);
    expect(RETURN_BORN_RECEDE_SLACK_M).toBe(150);
    // The slack must stay far below the net closing it guards, or a slow
    // outbound leg could hide inside it.
    expect(RETURN_BORN_RECEDE_SLACK_M).toBeLessThan(RETURN_BORN_MIN_NET_M);
  });
});
