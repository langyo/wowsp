// @vitest-environment node
/**
 * Corpus-gated probe for the plane-model join (user defect: enemy squadrons
 * rendered as Points dots while the installed pack carries their GLBs).
 *
 * The webui-side join is paramsId -> PLANE_TYPES[paramsId].index -> the
 * model pack's planes/<INDEX>.glb. A squadron whose paramsId misses the
 * table (or whose file the pack lacks) can never grow a model pool — it
 * stays in the Points cloud forever. This probe decodes the REFERENCE CV
 * replay the defect was reported on and asserts EVERY planeId that fires
 * squadron-state events (planesHealth / consumables — the airborne
 * squadrons) resolves both a PLANE_TYPES idx and an existing pack file
 * spelled exactly as the resolver's optimistic URL does.
 *
 * Decode route: the .wowsreplay container is decoded inline by a spawned
 * child node (blowfish-ECB needs --openssl-legacy-provider, zlib inflate,
 * then the same [u32 size][u32 type][f32 time] frame walk
 * replay_core's packets.rs documents) with the 14.5.0 avatar method pins
 * from method_tables.rs (addSquadron=107, addMinimapSquadron=93,
 * squadronPlanesHealth=87, consumableUsed=60, consumableStopWorking=64).
 * The join itself runs HERE, against the real PLANE_TYPES data module —
 * the same table planeWarfare.ts builds planeIndexById from.
 *
 * Run (skips silently without the corpus, like replay_core's WOWSP_TEST_*
 * gates):
 *   WOWSP_TEST_REPLAY=D:/SteamLibrary/steamapps/common/World of Warships/replays/14.5.0.0/20250708_192303_PJSA108-Shokaku_37_Ridge.wowsreplay
 *   pnpm --filter @wowsp/webui exec vitest run planeModelJoin.probe
 * The replay and the model pack are read-only inputs; nothing is written
 * into any game directory.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { PLANE_TYPES } from "./tactical/shellTypes";

const REPLAY = process.env.WOWSP_TEST_REPLAY ?? "";
const MODEL_PACK =
  process.env.WOWSP_TEST_MODEL_PACK ??
  join(homedir(), "AppData", "Local", "WoWSP", "models");

/** Inline decoder: container -> decrypt -> inflate -> frame walk -> per-plane
 *  aggregate. No template literals inside (it is written to a temp .cjs and
 *  spawned). */
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
  "  const byPlane = new Map();",
  "  const entry = (id) => { let e = byPlane.get(id); if (!e) { e = { paramsIds: [], numPlanes: [], planesHealth: 0, consumables: 0 }; byPlane.set(id, e); } return e; };",
  "  let p = 0;",
  "  while (p + 12 <= inflated.length) {",
  "    const size = inflated.readUInt32LE(p);",
  "    const ptype = inflated.readUInt32LE(p + 4);",
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
  "        const e = entry(a.readBigUInt64LE(5).toString());",
  "        e.paramsIds.push(a.readUInt32LE(0));",
  "        e.numPlanes.push(a[18]);",
  "      } else if (mid === 93 && a.length >= 21) {",
  "        const e = entry(a.readBigUInt64LE(0).toString());",
  "        e.paramsIds.push(a.readUInt32LE(9));",
  "      } else if (mid === 87 && a.length >= 16) {",
  "        entry(a.readBigUInt64LE(0).toString()).planesHealth++;",
  "      } else if ((mid === 60 || mid === 64) && a.length >= 9) {",
  "        entry(a.readBigUInt64LE(0).toString()).consumables++;",
  "      }",
  "    }",
  "  }",
  "  const planeIds = {};",
  "  for (const [k, v] of byPlane) planeIds[k] = v;",
  "  process.stdout.write(JSON.stringify({ avatar, planeIds }));",
  "}",
  "main(process.argv[2]);",
].join("\n");

let workDir: string | null = null;
let decoded: {
  avatar: number | null;
  planeIds: Record<string, { paramsIds: number[]; numPlanes: number[]; planesHealth: number; consumables: number }>;
} | null = null;

beforeAll(() => {
  if (!REPLAY) return;
  workDir = mkdtempSync(join(tmpdir(), "wowsp-plane-join-"));
  const script = join(workDir, "dump.cjs");
  writeFileSync(script, DUMP_SCRIPT);
  const out = execFileSync(
    process.execPath,
    ["--openssl-legacy-provider", "--max-old-space-size=2048", script, REPLAY],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  decoded = JSON.parse(out.toString("utf8"));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Tiny sync write helper (keeps the script above free of imports). */

describe.skipIf(!REPLAY)("plane model join on the reference replay (corpus)", () => {
  it("resolves every state-firing planeId to a plane_types idx and a pack GLB", () => {
    expect(decoded).not.toBeNull();
    expect(decoded!.avatar).not.toBeNull();
    const planeIds = decoded!.planeIds;

    // The airborne squadrons: every planeId the E27 state streams fired for.
    const firing = Object.entries(planeIds).filter(
      ([, e]) => e.planesHealth > 0 || e.consumables > 0,
    );
    // A corpus without squadrons proves nothing — fail loudly instead of
    // letting the join assertion pass vacuously.
    expect(firing.length).toBeGreaterThan(0);

    const packFiles = new Set(readdirSync(join(MODEL_PACK, "planes")));
    expect(packFiles.size).toBeGreaterThan(0);

    // The exact misses, for the failure message AND the human report.
    const missingTable: { planeId: string; paramsId: number }[] = [];
    const missingFile: { planeId: string; index: string; path: string }[] = [];
    const casedDrift: { index: string; onDisk: string }[] = [];
    const noParams: string[] = [];

    for (const [planeId, e] of firing) {
      const paramsIds = [...new Set(e.paramsIds)];
      if (paramsIds.length === 0) {
        noParams.push(planeId);
        continue;
      }
      for (const paramsId of paramsIds) {
        const info = PLANE_TYPES[String(paramsId)];
        if (!info?.index) {
          missingTable.push({ planeId, paramsId });
          continue;
        }
        const file = info.index + ".glb";
        if (!packFiles.has(file)) {
          // The pack is NTFS (case-insensitive reads) but the resolver
          // builds the URL from the index AS SPELLED — drift would 404
          // on case-sensitive caches, so spell-check against the dir.
          const ci = [...packFiles].find((f) => f.toLowerCase() === file.toLowerCase());
          if (ci) casedDrift.push({ index: info.index, onDisk: ci });
          else missingFile.push({ planeId, index: info.index, path: join(MODEL_PACK, "planes", file) });
          continue;
        }
        if (!existsSync(join(MODEL_PACK, "planes", file))) {
          missingFile.push({ planeId, index: info.index, path: join(MODEL_PACK, "planes", file) });
        }
      }
    }

    const problems: string[] = [];
    if (noParams.length > 0) {
      problems.push("planeIds firing state with NO paramsId at all: " + noParams.join(", "));
    }
    if (missingTable.length > 0) {
      const byParams = new Map<number, string[]>();
      for (const m of missingTable) {
        const list = byParams.get(m.paramsId) ?? [];
        list.push(m.planeId);
        byParams.set(m.paramsId, list);
      }
      problems.push(
        "paramsIds MISSING from plane_types.json: " +
        [...byParams]
          .map(([pid, ids]) => pid + " (planeIds " + ids.slice(0, 4).join(",") + ")")
          .join("; "),
      );
    }
    if (casedDrift.length > 0) {
      problems.push(
        "pack casing drift: " +
        casedDrift.map((d) => d.index + " -> " + d.onDisk).join(", "),
      );
    }
    if (missingFile.length > 0) {
      problems.push(
        "GLBs MISSING from the pack: " +
        [...new Set(missingFile.map((m) => m.path))].join(", "),
      );
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
