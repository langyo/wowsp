// @vitest-environment node
/**
 * PLANE_TYPES projection tests.
 *
 * User report: a Shokaku (VIII 翔鶴) replay showed the FIRST-launched
 * squadrons as bombers although they were torpedo bombers. Root cause is the
 * baked `plane_types.json` row, not the replay join: a torpedo squadron's
 * GameParams species is literally "Bomber", so the LEGACY rows (baked before
 * the species+ammo projection `extract_lesta_planes.plane_type()` existed)
 * carry `type: "bomber"` while the ammo-derived `role` already says
 * "torpedo" — 91 of the table's 152 torpedo airframes. shellTypes.ts
 * re-projects the coarse family from the role, and these tests pin that
 * projection against the REAL committed table.
 *
 * Evidence for the Shokaku ids: the 14.5.0.0 reference replay
 * `20250708_192303_PJSA108-Shokaku_37_Ridge.wowsreplay` opens (t = 30.7 s)
 * with paramsId 4076830416, and the decoded GameParams dump spells that
 * airframe species "Bomber" with `planeAmmoType`/`ammoType` "torpedo".
 */
import { describe, expect, it } from "vitest";

import planeTypesRaw from "@/data/plane_types.json";
import { PLANE_TYPES, planeFullStrength, planeRoleOf } from "./shellTypes";

/** VIII Shoukaku's torpedo squadrons (stock / top module). */
const SHOKAKU_TORPEDO_STOCK = 4181688016; // PJAB108_Shokaku_stock, count 8
const SHOKAKU_TORPEDO_TOP = 4076830416; // PJAB208_Shokaku_top, count 10
/** ...and its dive bomber / fighter, which must keep their own families. */
const SHOKAKU_DIVE = 4181622480; // PJAD108_Shokaku_stock
const SHOKAKU_FIGHTER = 4181556944; // PJAF108_Shokaku_stock
/** Kaga's torpedo bomber, flown from the same reference replay. */
const KAGA_TORPEDO = 3762257616; // PJAB508_Kaga_stock

const raw = planeTypesRaw as Record<string, { index: string; name: string; type: string; count?: number; role?: string }>;

describe("PLANE_TYPES torpedo family", () => {
  it("labels the Shoukaku's torpedo bombers as torpedo, not bomber", () => {
    // The reported symptom: the AP-bomber icon + the "AP bombers" hover
    // label (planeIcons `bomber`, MinimapHoverTip PLANE_TYPE_KEY `bomber`).
    expect(PLANE_TYPES[String(SHOKAKU_TORPEDO_STOCK)]?.type).toBe("torpedo");
    expect(PLANE_TYPES[String(SHOKAKU_TORPEDO_TOP)]?.type).toBe("torpedo");
    expect(PLANE_TYPES[String(KAGA_TORPEDO)]?.type).toBe("torpedo");
    // The baked ammunition role is what the projection keys on — it was
    // already right, which is why the squadron panel named 鱼雷机 while the
    // minimap icon/tooltip said bomber.
    for (const id of [SHOKAKU_TORPEDO_STOCK, SHOKAKU_TORPEDO_TOP, KAGA_TORPEDO]) {
      expect(raw[String(id)]?.role).toBe("torpedo");
    }
  });

  it("agrees with the ammo-derived role on EVERY torpedo row of the table", () => {
    const wrong = Object.entries(PLANE_TYPES)
      .filter(([, row]) => row.role === "torpedo" && row.type !== "torpedo")
      .map(([id, row]) => `${id} ${row.index} ${row.type}`);
    expect(wrong).toEqual([]);
  });

  it("leaves every non-torpedo row exactly as baked", () => {
    // The projection is scoped to the torpedo mismatch: index/name/count/role
    // (and the family of fighters, dive bombers, scouts, skip bombers, ASW
    // and minelayers) must pass through untouched.
    const drifted = Object.entries(PLANE_TYPES)
      .filter(([id, row]) => {
        const baked = raw[id];
        if (!baked) return true;
        if (row.role === "torpedo") {
          return (
            row.index !== baked.index ||
            row.name !== baked.name ||
            row.count !== baked.count ||
            row.role !== baked.role
          );
        }
        return (
          row.type !== baked.type ||
          row.index !== baked.index ||
          row.name !== baked.name ||
          row.count !== baked.count ||
          row.role !== baked.role
        );
      })
      .map(([id]) => id);
    expect(drifted).toEqual([]);
    expect(PLANE_TYPES[String(SHOKAKU_DIVE)]?.type).toBe("dive");
    expect(PLANE_TYPES[String(SHOKAKU_FIGHTER)]?.type).toBe("fighter");
  });

  it("keeps the table-wide coverage and the airframe strength", () => {
    expect(Object.keys(PLANE_TYPES)).toHaveLength(Object.keys(raw).length);
    // Torpedo count rows are the FULL squadron strength the HUD divides by.
    expect(planeFullStrength(SHOKAKU_TORPEDO_STOCK)).toBe(8);
    expect(planeFullStrength(SHOKAKU_TORPEDO_TOP)).toBe(10);
  });

  it("feeds the timeline / hover family through planeRoleOf", () => {
    // planeRoleOf returns the coarse family; the takeoff action's icon and
    // the hover tooltip both read it, so the correction must show up here.
    expect(planeRoleOf(SHOKAKU_TORPEDO_TOP)).toBe("torpedo");
    expect(planeRoleOf(SHOKAKU_DIVE)).toBe("dive");
    expect(planeRoleOf(undefined)).toBe("unknown");
    expect(planeRoleOf(1)).toBe("unknown");
  });
});
