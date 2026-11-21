// @vitest-environment node
/**
 * Corpus-gated probe for the aircraft card's WING PICK (items B and D).
 *
 * Decodes the 14.5.0.0 Shokaku reference capture this defect was reported on
 * and answers two questions with the REAL baked tables:
 *
 *  D — every squadron the capture flies resolves a PLANE_TYPES family, and
 *      every AS-family (catapult-scout) airframe is excluded from the card.
 *      A paramsId the table misses would otherwise paint a manufactured
 *      family (the old "attack" fallback = the skip-bomber icon), which is
 *      the reported "疑似侦察机却显示为轰炸机".
 *  B — the card's wing pick is stable. The capture re-adds squadrons
 *      mid-air (survivor groups with fresh planeIds living 1.9–3.4 s); the
 *      old "newest launch wins" rule rode them, flashing a wrong family over
 *      the card for a couple of seconds. With planeWarfare.stableWingPick's
 *      3 s hysteresis NO such flash window remains, while the old rule's
 *      window is still measurable on this fixture (so the probe cannot pass
 *      vacuously).
 *
 * Decode route: the .wowsreplay container is decrypted + inflated inline by a
 * spawned child node (blowfish-ECB needs --openssl-legacy-provider) and walked
 * with the 14.5 avatar method pins from replay_core's method_tables.rs
 * (addSquadron=107, updateSquadron=132, addMinimapSquadron=93,
 * updateMinimapSquadron=86, removeMinimapSquadron=46). The joins then run
 * HERE, against the real tables.
 *
 *   WOWSP_TEST_REPLAY=D:/.../20250708_192303_PJSA108-Shokaku_37_Ridge.wowsreplay \
 *     pnpm --filter @wowsp/webui exec vitest run planeCardStability.probe
 *
 * The replay is a READ-ONLY input (static analysis; nothing is written back).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLANE_TYPES } from "./tactical/shellTypes";
import { PLANE_TRAIL_GRACE_S } from "./planeFormation";
import {
  WING_CARD_STICKY_S,
  isScoutAirframeIndex,
  isScoutParamsId,
  stableWingPick,
  type WingRideCandidate,
} from "./planeWarfare";

const REPLAY = process.env.WOWSP_TEST_REPLAY ?? "";

/** Inline decoder: container -> decrypt -> inflate -> frame walk -> the
 *  squadron streams. No template literals inside (it is written to a temp .cjs
 *  and spawned). */
const DUMP_SCRIPT = [
  "const fs = require(\"node:fs\");",
  "const zlib = require(\"node:zlib\");",
  "const crypto = require(\"node:crypto\");",
  "const KEY = Buffer.from([0x29,0xB7,0xC9,0x09,0x38,0x3F,0x84,0x88,0xFA,0x98,0xEC,0x4E,0x13,0x19,0x79,0xFB]);",
  "function decryptStream(dirty) {",
  "  const decipher = crypto.createDecipheriv('bf-ecb', KEY, null);",
  "  decipher.setAutoPadding(false);",
  "  const full = Buffer.concat([decipher.update(dirty), decipher.final()]);",
  "  const out = Buffer.alloc(Math.max(0, full.length - 8));",
  "  let prev = 0n;",
  "  for (let off = 8; off + 8 <= full.length; off += 8) {",
  "    const v = full.readBigInt64LE(off) ^ prev;",
  "    out.writeBigInt64LE(v, off - 8);",
  "    prev = v;",
  "  }",
  "  return out;",
  "}",
  "function main(path) {",
  "  const data = fs.readFileSync(path);",
  "  const nblocks = data.readUInt32LE(4);",
  "  let cur = 8;",
  "  for (let i = 0; i < nblocks; i++) cur += 4 + data.readUInt32LE(cur);",
  "  const inflated = zlib.inflateSync(decryptStream(data.slice(cur)));",
  "  const kinds = new Map();",
  "  let avatar = null;",
  "  const creates = [];",
  "  const samples = [];",
  "  const mmAdds = [];",
  "  const mmMoves = [];",
  "  const mmRemoves = [];",
  "  let p = 0;",
  "  while (p + 12 <= inflated.length) {",
  "    const size = inflated.readUInt32LE(p);",
  "    const ptype = inflated.readUInt32LE(p + 4);",
  "    const time = inflated.readFloatLE(p + 8);",
  "    const end = p + 12 + size;",
  "    if (size > 200000 || end > inflated.length) break;",
  "    const pay = inflated.slice(p + 12, end);",
  "    p = end;",
  "    if (ptype === 5 && pay.length >= 6) kinds.set(pay.readInt32LE(0), pay.readInt16LE(4));",
  "    else if (ptype === 1 && pay.length >= 4) { avatar = pay.readInt32LE(0); kinds.set(avatar, 1); }",
  "    else if (ptype === 8 && pay.length >= 12) {",
  "      const eid = pay.readInt32LE(0);",
  "      if (eid !== avatar && kinds.get(eid) !== 1) continue;",
  "      const mid = pay.readInt32LE(4);",
  "      const alen = pay.readUInt32LE(8);",
  "      const a = pay.slice(12, 12 + alen);",
  "      if (mid === 107 && a.length >= 31) {",
  "        creates.push({ t: time, planeId: a.readBigUInt64LE(5).toString(), paramsId: a.readUInt32LE(0) });",
  "      } else if (mid === 132 && a.length >= 13) {",
  "        const planeId = a.readBigUInt64LE(0).toString();",
  "        const count = a[12];",
  "        let off = 13;",
  "        for (let i = 0; i < count; i++) {",
  "          if (off + 20 > a.length) break;",
  "          samples.push({ t: time, planeId, index: i });",
  "          off += 20;",
  "        }",
  "      } else if (mid === 93 && a.length >= 22) {",
  "        const pid = a.readBigUInt64LE(0);",
  "        mmAdds.push({ t: time, planeId: pid.toString(), ownerId: Number(pid & 0xFFFFFFFFn), paramsId: a.readUInt32LE(9) });",
  "      } else if (mid === 86 && a.length >= 16) {",
  "        mmMoves.push({ t: time, planeId: a.readBigUInt64LE(0).toString() });",
  "      } else if (mid === 46 && a.length === 8) {",
  "        mmRemoves.push({ t: time, planeId: a.readBigUInt64LE(0).toString() });",
  "      }",
  "    }",
  "  }",
  "  process.stdout.write(JSON.stringify({ avatar, creates, samples, mmAdds, mmMoves, mmRemoves }));",
  "}",
  "main(process.argv[2]);",
].join("\n");

interface Decoded {
  avatar: number | null;
  creates: { t: number; planeId: string; paramsId: number }[];
  samples: { t: number; planeId: string; index: number }[];
  mmAdds: { t: number; planeId: string; ownerId: number; paramsId: number }[];
  mmMoves: { t: number; planeId: string }[];
  mmRemoves: { t: number; planeId: string }[];
}

/** One airborne sortie of one hull, as the trail build would present it. */
interface Wing extends WingRideCandidate {
  planeId: number;
  owner: number;
  paramsId: number;
  family: string;
  expiry: number;
  scout: boolean;
}

/** Fold the decoded streams into per-wing spans exactly like
 *  planeWarfare.buildPlaneTrails: the 3D (planeId,index) trails are the
 *  anchor and the minimap centre track pads them at both ends; expiry is
 *  planeTrailExpiry (last sample + grace, capped by the remove event). */
function buildWings(d: Decoded): Wing[] {
  const firstCreate = new Map<string, number>();
  for (const c of d.creates) if (!firstCreate.has(c.planeId)) firstCreate.set(c.planeId, c.paramsId);
  const mmFirst = new Map<string, Decoded["mmAdds"][number]>();
  for (const a of d.mmAdds) if (!mmFirst.has(a.planeId)) mmFirst.set(a.planeId, a);
  const paramsOf = new Map<string, number>();
  for (const [planeId, paramsId] of firstCreate) paramsOf.set(planeId, paramsId);
  for (const [planeId, a] of mmFirst) if (!paramsOf.has(planeId)) paramsOf.set(planeId, a.paramsId);
  const ownerOf = new Map<string, number>();
  for (const [planeId, a] of mmFirst) ownerOf.set(planeId, a.ownerId);
  const removeAt = new Map<string, number>();
  for (const r of d.mmRemoves) {
    const prev = removeAt.get(r.planeId);
    if (prev == null || r.t < prev) removeAt.set(r.planeId, r.t);
  }
  // 3D trails: (planeId,index) -> sorted sample times.
  const trails = new Map<string, number[]>();
  for (const s of d.samples) {
    const key = s.planeId + ":" + s.index;
    const list = trails.get(key) ?? [];
    list.push(s.t);
    trails.set(key, list);
  }
  const anchorTimes = new Map<string, number[]>();
  for (const [key, times] of trails) {
    if (!key.endsWith(":0")) continue;
    anchorTimes.set(key.slice(0, -2), times.slice().sort((a, b) => a - b));
  }
  // Minimap centre track per planeId (moves + adds), bounded by the remove.
  const mmTimes = new Map<string, number[]>();
  const pushMm = (planeId: string, t: number) => {
    const end = removeAt.get(planeId);
    if (end != null && t > end) return;
    const list = mmTimes.get(planeId) ?? [];
    list.push(t);
    mmTimes.set(planeId, list);
  };
  for (const a of d.mmAdds) pushMm(a.planeId, a.t);
  for (const m of d.mmMoves) pushMm(m.planeId, m.t);
  for (const [planeId, times] of mmTimes) {
    times.sort((a, b) => a - b);
    const anchor = anchorTimes.get(planeId);
    if (!anchor) {
      anchorTimes.set(planeId, times);
      continue;
    }
    const before = times.filter((t) => t < anchor[0]);
    const after = times.filter((t) => t > anchor[anchor.length - 1]);
    if (before.length > 0 || after.length > 0) {
      anchorTimes.set(planeId, [...before, ...anchor, ...after]);
    }
  }
  const out: Wing[] = [];
  for (const [planeIdStr, times] of anchorTimes) {
    if (times.length === 0) continue;
    const paramsId = paramsOf.get(planeIdStr);
    if (paramsId == null) continue;
    const owner = ownerOf.get(planeIdStr);
    if (owner == null) continue;
    const born = times[0];
    const last = times[times.length - 1];
    const expiry = Math.min(last + PLANE_TRAIL_GRACE_S, removeAt.get(planeIdStr) ?? Infinity);
    const family = PLANE_TYPES[String(paramsId)]?.type ?? "(miss)";
    out.push({
      planeId: Number(planeIdStr),
      owner,
      paramsId,
      family,
      born,
      lastSample: last,
      expiry,
      scout: isScoutParamsId(paramsId),
    });
  }
  return out.sort((a, b) => a.born - b.born);
}

interface Segment {
  planeId: number | null;
  family: string | null;
  from: number;
  to: number;
}

/** Second-by-second card-wings timeline for one hull's wings under a picker. */
function timeline(
  wings: readonly Wing[],
  picker: (live: readonly Wing[], t: number) => Wing | null,
): Segment[] {
  if (wings.length === 0) return [];
  const t0 = Math.min(...wings.map((w) => w.born));
  const t1 = Math.max(...wings.map((w) => w.expiry));
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (let t = Math.ceil(t0); t <= Math.ceil(t1); t++) {
    const live = wings.filter((w) => w.born <= t && t <= w.expiry);
    const pick = live.length > 0 ? picker(live, t) : null;
    const family = pick ? pick.family : null;
    const planeId = pick ? pick.planeId : null;
    if (!cur || cur.family !== family || cur.planeId !== planeId) {
      if (cur) segs.push(cur);
      cur = { planeId, family, from: t, to: t };
    }
    cur.to = t;
  }
  if (cur) segs.push(cur);
  return segs;
}

/** The 14.5-era rule: the newest launch still inside its window wins. */
function newestLaunch(live: readonly Wing[]): Wing {
  return live.reduce((best, w) => (w.born > best.born ? w : best));
}

/** The shipped rule: planeWarfare.stableWingPick over the same candidates. */
function hysteresis(live: readonly Wing[], t: number): Wing {
  const pick = stableWingPick(live, t);
  return live.find((w) => w.planeId === pick) ?? live[0];
}

/** Wrong-family CARD flips: a pick segment shorter than the hysteresis
 *  window whose family differs from BOTH neighbours while those neighbours
 *  agree with each other — i.e. the card showed a different family for a
 *  couple of seconds and then went back. */
function wrongFamilyFlashes(segs: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i + 1 < segs.length; i++) {
    const prev = segs[i - 1];
    const seg = segs[i];
    const next = segs[i + 1];
    const dur = seg.to - seg.from + 1;
    if (dur >= WING_CARD_STICKY_S) continue;
    if (prev.family == null || seg.family == null || next.family == null) continue;
    if (prev.family === next.family && seg.family !== prev.family) out.push(seg);
  }
  return out;
}

let workDir: string | null = null;
let decoded: Decoded | null = null;
let wings: Wing[] = [];

beforeAll(() => {
  if (!REPLAY) return;
  workDir = mkdtempSync(join(tmpdir(), "wowsp-plane-card-"));
  const script = join(workDir, "dump.cjs");
  writeFileSync(script, DUMP_SCRIPT);
  const out = execFileSync(
    process.execPath,
    ["--openssl-legacy-provider", "--max-old-space-size=2048", script, REPLAY],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  decoded = JSON.parse(out.toString("utf8")) as Decoded;
  wings = buildWings(decoded);
  if (process.env.WOWSP_PROBE_VERBOSE === "1") {
    for (const w of wings) {
      console.error(
        `wing ${w.planeId} owner=${w.owner} params=${w.paramsId} fam=${w.family} ${w.born.toFixed(2)}..${w.expiry.toFixed(2)} posGrace=${(w.expiry - w.born).toFixed(2)}s${w.scout ? " SCOUT" : ""}`,
      );
    }
  }
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!REPLAY)("aircraft card probe on the reference replay (corpus)", () => {
  it("decodes the capture's squadrons", () => {
    expect(decoded).not.toBeNull();
    expect(wings.length).toBeGreaterThan(100);
    // The capture is a CV match: at least one hull launches far more wings
    // than a catapult spotter ever could.
    const perOwner = new Map<number, number>();
    for (const w of wings) perOwner.set(w.owner, (perOwner.get(w.owner) ?? 0) + 1);
    expect(Math.max(...perOwner.values())).toBeGreaterThan(20);
  });

  it("resolves a PLANE_TYPES family for EVERY wing (item D)", () => {
    const misses = wings.filter((w) => PLANE_TYPES[String(w.paramsId)] == null);
    expect(
      misses.map((w) => `${w.planeId}:${w.paramsId}`),
      "paramsIds missing from plane_types.json",
    ).toEqual([]);
    // And the families are the behavioural ones, never the manufactured
    // "attack" fallback (a real family only).
    const families = new Set(wings.map((w) => w.family));
    expect([...families].sort()).toEqual(
      [...families].filter((f) => f !== "(miss)").sort(),
    );
  });

  it("classifies every AS-family airframe as a scout and keeps it off the card (item D)", () => {
    const asFamily = wings.filter((w) => {
      const idx = PLANE_TYPES[String(w.paramsId)]?.index ?? "";
      return isScoutAirframeIndex(idx);
    });
    // The capture carries catapult spotters — otherwise this assertion is
    // vacuous.
    expect(asFamily.length).toBeGreaterThan(0);
    const leaked = asFamily.filter((w) => !w.scout);
    expect(leaked.map((w) => w.planeId)).toEqual([]);
    // Scout-only hulls therefore own no cardable wing at all.
    const perOwner = new Map<number, Wing[]>();
    for (const w of wings) {
      const list = perOwner.get(w.owner) ?? [];
      list.push(w);
      perOwner.set(w.owner, list);
    }
    for (const [owner, list] of perOwner) {
      if (list.every((w) => w.scout)) {
        expect(list.some((w) => !w.scout), `hull ${owner} owns only scouts`).toBe(false);
      }
    }
  });

  it("has NO wrong-family card flash left under the 3 s hysteresis (item B)", () => {
    const perOwner = new Map<number, Wing[]>();
    for (const w of wings) {
      if (w.scout) continue; // scouts never carry a card
      const list = perOwner.get(w.owner) ?? [];
      list.push(w);
      perOwner.set(w.owner, list);
    }
    let oldFlashes = 0;
    const newFlashes: string[] = [];
    for (const [owner, list] of perOwner) {
      if (list.length === 0) continue;
      oldFlashes += wrongFamilyFlashes(timeline(list, newestLaunch)).length;
      for (const f of wrongFamilyFlashes(timeline(list, hysteresis))) {
        newFlashes.push(`NEW hull ${owner}: ${f.from}..${f.to}s ${f.family}`);
      }
    }
    expect(newFlashes, newFlashes.join("\n")).toEqual([]);
    // The probe cannot pass vacuously: the OLD rule really did flash a
    // wrong-family card on this capture (a 2 s fighter card between torpedo
    // cards on the enemy Shokaku).
    expect(oldFlashes).toBeGreaterThan(0);
  });

  it("rides no wing younger than the window while an older one is airborne (item B)", () => {
    const perOwner = new Map<number, Wing[]>();
    for (const w of wings) {
      if (w.scout) continue;
      const list = perOwner.get(w.owner) ?? [];
      list.push(w);
      perOwner.set(w.owner, list);
    }
    const violations: string[] = [];
    for (const [owner, list] of perOwner) {
      if (list.length === 0) continue;
      const t1 = Math.max(...list.map((w) => w.expiry));
      for (let t = Math.ceil(Math.min(...list.map((w) => w.born))); t <= Math.ceil(t1); t++) {
        const live = list.filter((w) => w.born <= t && t <= w.expiry);
        if (live.length === 0) continue;
        const pick = hysteresis(live, t);
        const oldest = live.reduce((a, b) => (b.born < a.born ? b : a));
        if (pick.planeId === oldest.planeId) continue;
        // A newer wing may only hold the card once it has flown the window.
        if (t - pick.born < WING_CARD_STICKY_S) {
          violations.push(`hull ${owner} t=${t}: riding ${pick.planeId} (age ${(t - pick.born).toFixed(1)}s)`);
        }
      }
    }
    expect(violations, violations.slice(0, 10).join("\n")).toEqual([]);
  });
});
