# receive_squadronPlanesHealth u64 — packing cracked

**Status: SOLVED.** Validated on the reference capture
`D:\SteamLibrary\...\replays\14.5.0.0\20250708_192303_PJSA108-Shokaku_37_Ridge.wowsreplay`
(client 14.5.0, Shokaku CV recorder, full 20-min battle): **815 synchronized
(packed u64, hp float) samples across 167 squadrons — 0 violations**; 155
fresh death transitions all consistent; 3,825 digit instances use only
{1, 2, 4}.

Reproducer: `cargo test -p wowsp_replay_core dump_sq_planes_health_series`
(corpus probe added in `packages/app/replay_core/src/packets/tests.rs`, writes
`scripts/experiments/out/sq_planes_health_dump.jsonl`), then
`python scripts/experiments/sq_planes_health_analyze.py`.

## The formula

The u64 is a **per-plane health-band bitfield: 3 bits (one octal digit) per
flying plane, plane 0 = least significant digit.**

| 3-bit digit | meaning (plane HP as fraction of its own max) |
|---|---|
| `0` | slot not flying (only ever the implicit trailing zeros) |
| `1` = 2⁰ | **full** — HP > 3/4 |
| `2` = 2¹ | **damaged** — 1/4 < HP ≤ 3/4 |
| `4` = 2² | **critical** — HP ≤ 1/4 |

- **Digit count = number of currently flying planes.** The server packs ONLY
  the flying planes, so leading zero slots are truncated away by integer
  storage. No other digit value occurs on the capture (no 0 digits interior,
  never 3/5/6/7).
- **A plane death removes the TOP digit.** All 180 dead-plane indexes across
  the capture equal `digit_count − 1` at the moment of death; the packed value
  after the death is exactly `before` with that digit dropped (151/155
  transitions byte-exact, the other 4 also carry concurrent AA escalation
  1→2/2→4 on other planes; 0 contradictions). The `planeDeath` dead-plane
  indexes therefore line up with digit indexes directly.
- **The companion float** `receive_squadronHealth` = Σ(plane HP) /
  `numPlanes` **at spawn** — `addSquadron` args byte 18, NOT
  `totalNumPlanes` (args byte 4): 23 of 224 squadrons on the capture launch
  partial (depleted hangar, e.g. 6/10) and their floats are x/6, proven by
  hp = 1.0 at 6 planes and hp = 0.6667 = 4/6 later.
- **addSquadron's trailing u64 `planeHealth`** uses the identical encoding
  (byte-verified: 42950518598's add tail = `0x289` = its first
  planesHealth value; 214749210410's tail = `1`).

Unpack: repeat `packed >> (3*k) & 7` for k = 0.. while nonzero; map
1→Full, 2→Damaged, 4→Critical. A 21-plane squadron (63 bits) still fits u64.

## Why the hex looks like `…249249`

A flight of n full planes is n octal ones = `(8^n − 1)/7`, whose hex is the
repeating `249` pattern: 2 planes full = `0x9` (`0o11`), 4 = `0x249`
(`0o1111`), 10 = `0x09249249` (`0o1111111111`), 12 = `0x249249249`
(`0o111111111111`). One damaged top plane adds one octal `2` at the top:
12 planes with plane 11 damaged = `0x449249249` = `0o211111111111`.
This is also why updateSquadron's f32 `dt` shows 0.142857 (= 1/7) —
unrelated coincidence of the same identity, not a link between the streams.

## Hypotheses from the brief — dispositions

- **H1 nibble k = plane k HP×9: DEAD.** Fields are 3-bit, not 4-bit; the
  `[9,4,2]` nibble pattern is octal-111 aliasing in hex.
- **H2 12-bit fields, 0x249 = 4095/7 share: DEAD.** 0x249 = 585 = four octal
  ones = 4 healthy planes; `(8^n−1)/7` explains every appearance of the /7.
- **H3 fixed-point of the total fraction: DEAD.** The spawn value is
  all-octal-ones for EVERY squadron size (2 planes → 0x9, 12 → 0x249249249),
  and mixed digits (`[1,2]`, `[2,1,2,1,2]`) occur at one timestamp, which no
  single-fraction encoding can produce. The float is exact only under the
  per-plane band model with the numPlanes denominator.
- **H4 BCD: DEAD.** Base 8, not 10.
- **H5 plane ordering: plane 0 = LSB, confirmed.** planeDeath indexes match
  the escalating slot (e.g. 4410932258630: slot5 walks 1→2→4 across
  977.9→980.3, then planeDeath[5] at 981.6 drops exactly that digit).

## Boundary evidence (why 3/4 and 1/4 exactly)

Interval feasibility over all 815 synchronized samples (each sample: Σ band
low-bounds ≤ hp·numPlanes ≤ Σ band high-bounds):

| bands (B12 / B24) | violations |
|---|---|
| **0.75 / 0.25** | **0 / 815** |
| 0.80 / 0.25 | 9 |
| 0.85 / 0.35 | 20 |
| 0.75 / 0.20 | 97 |
| 0.70 / 0.25 | 134 |
| 2/3, 1/3 | 205 |

- Feasible grid (0.005 step) pins **B12 to exactly 0.75**: tightest samples —
  single-plane digit-1 at hp 0.755 (B12 ≤ 0.755; sq 5540508657478 t=750.91,
  sq 1687922992952 t=536.51) vs 12-plane sample with damaged plane at hp
  0.7456 carrying digit 2 (B12 > 0.746; sq 8590780230 t=104.49).
- **B24 ∈ [0.2482, 0.30]** by data (a digit-4 sample forces the critical
  plane ≥ 0.2482: sq 3311420630854 t=822.79, y = 5.248 = 5×1.0 + 0.248);
  1/4 is the natural symmetric value, and f32/tick skew (hp ticks are
  ~0.003–0.05 apart) explains both bracket edges.
- Band model is on CURRENT hp, not max damage taken: heal-consumable windows
  (ctype 22) flip digits back 4→1 and 2↔1 (see squadron C below).

## Evidence squadrons (every sample explained)

**A. 8590780230 — recorder's own 12-plane attack squadron** (paramsId
3762257616, numPlanes 12, spawn t=58.1; the lead's mystery samples):

| t | packed | octal digits | hp float | check |
|---|---|---|---|---|
| 104.49 | 0x449249249 | [1×11, 2] | 0.9788 | 11.746 = 11 + 0.746 → plane 11 ≤ 0.75 ✓ (pins B12) |
| 107.65 | 0x449249289 | [1,1,2,1×8,2] | 0.9183 | 11.02 = 10 + 0.746 + 0.27 ✓ |
| 108.49 | 0x449249 | [1×7, 2] | 0.6217 | 12→8 planes: 4-plane flight split off at 108.2 (child addSquadron 42950518598, parentID = this planeId, its own packed 0x289 = [1,1,2,1]); survivors keep relative order, damaged plane now top |
| 113.93 | 0x849249 | [1×7, 4] | 0.5996 | top plane 0.46 → crossed 0.25 ✓ |
| 123.24–134.12 | 0x49249→0x289 | melt | | planeDeath[7],[6],[5],[4] each drops exactly the top digit |
| 134.22 | 0x489 | [1,1,2,2] | 0.2489 | 2.99 = 1 + 0.99 + 0.7 + 0.3 ✓ |

The lead's "t=104.49 right after a planeDeath at 104.09" was a coincidence:
the 104.09 planeDeath belongs to single-plane squadron 214749210408
(spawning that instant, packed 0x1 = its own full plane, hp 1.0).

**B. 1108102407996 — partial-hangar launch (6 of 10), full melt under AA:**
spawn add total=10 num=6 → packed 0x9249 = [1×6] with hp 1.0 (6/6!) →
[1×4] hp 0.6667 = 4/6 (**denominator proof**) → [1,1,1,2]
0.6211·6 = 3.73 = 3 + 0.73 ✓ → [2,1,1,4] → death[3] → [2,2,1] → [2,2,2] →
[4,2,2] → [4,4,2] → [4,4,4] → death[2] → [4,4] → death[1] → [4] → death[0]
→ deactivate. Every step is band-consistent with hp·6.

**C. 2207614035772 — partial damage, heal tug-of-war, no death until 689:**
[1×9,2] 0.9784 → [1×9,4] 0.8941 → [1×7,4] 0.8744 (2-plane flight split) →
consUsed ctype 22 (heal) at 681.10 → **[1×8]/[1×7,2] alternating six times
(682.2–686.9) while the float hovers 0.707–0.781** = the plane's hp ~0.75
straddling B12 under heal-vs-AA — the smoking gun that digits track CURRENT
hp with threshold 3/4 → consStop 686.10 → [1×7,4] → death[7] → melt.

**D. Single-plane / small squadrons:** 214749210410 (total=1, num=1,
patrol fighter): spawn [1] hp 1.0, deactivate reason 1 — a healthy lone
plane is digit 1, NOT a damage level. 42950518588 (catapult fighter,
total=2 num=2 — the "single-plane" from the lead's notes is actually a
pair): spawn [1,1] hp 1.0. 120259929916 (4-plane patrol): [1,1,1,1] hp 1.0
for its whole 158-s flight, deactivated reason 4 untouched.

## Open edges

1. **B24's exact value**: data brackets [0.2482, 0.30]; 1/4 assumed
   (symmetry with 3/4; bracket slack = hp-tick skew). A capture with a plane
   parking mid-band would tighten it.
2. **Digits 3/5/6/7 never observed** (3,825 instances): the helper treats
   them as unknown (`None`) rather than guessing.
3. **Squadron splits** (attack-flight peel-off) spawn a child entity via
   addSquadron with parentID = parent squadron's planeId; survivors keep
   relative digit order (one observed case, A@108.49). If the frontend needs
   stable plane identity across a split, join on the child addSquadron.
4. **Death = top slot** held 180/180 here; if a future capture shows an
   interior death index, the invariant is "dead slots are dropped and
   survivors re-compacted", which is what the helper assumes anyway.
5. addSquadron tail layout (`… position … i64 parentID, u32 maxHealth,
   f32 squadronHealthPart, u64 planeHealth`) confirmed on 3 hex dumps;
   exact byte offsets for the tail still need pinning if consumed — that is
   sq-decode's file territory.

## Deliverable

`scripts/experiments/sq_planes_health_unpack.rs` — dependency-free
`unpack_squadron_planes_health` + fixtures (this note's samples as unit
tests), ready for the lead to place into `tauri_shared::stream` (serde
derives to taste).
