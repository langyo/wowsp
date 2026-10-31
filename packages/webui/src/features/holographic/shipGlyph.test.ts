/**
 * The 2D minimap's trail lines terminate at the ship's projected pose —
 * the SAME anchor drawShipGlyph is centred on (painters translate to the
 * anchor, rotate to the heading, then call drawShipGlyph(ctx, type, 0, 0)).
 * The traced polygons keep their raw 28×28 atlas coordinates, so the
 * painter must re-centre them: before the atlas-centre subtraction every
 * glyph drew its body one half-cell down-right of the anchor (≈17–20 px on
 * the enlarged map), so trails always met the icon's bottom-right corner
 * instead of its centre. These suites pin the centring contract for BOTH
 * copies (the app's local one and the @wowsp/holo one the website uses).
 */
import { describe, expect, it } from "vitest";

import { fakeAs } from "@/test-utils/fakes";
import { drawShipGlyph as drawLocal } from "./shipGlyph";
import { drawShipGlyph as drawHolo } from "@wowsp/holo";

type Pt = { x: number; y: number };

/** Minimal 2D-context double recording the polygon vertices drawShipGlyph
 *  emits — everything else the painters rely on (fill/stroke/transform)
 *  is irrelevant to the centring contract. Returns the typed recorder and
 *  the same object cast to the canvas context drawShipGlyph takes. */
function recordingCtx(): { rec: { paths: Pt[][] }; ctx: CanvasRenderingContext2D } {
  const paths: Pt[][] = [];
  let cur: Pt[] | null = null;
  const rec = {
    paths,
    beginPath() { cur = []; paths.push(cur); },
    moveTo(x: number, y: number) { cur!.push({ x, y }); },
    lineTo(x: number, y: number) { cur!.push({ x, y }); },
    closePath() { /* vertices already recorded */ },
    fill() {},
    stroke() {},
    // outline mode reads the transform magnitude for hairline widths
    getTransform() {
      return fakeAs<DOMMatrix>({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    },
  };
  return { rec, ctx: fakeAs<CanvasRenderingContext2D>(rec) };
}

/** Union bounding box of every recorded polygon. */
function bbox(paths: Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = paths.flat();
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

for (const [name, draw] of [["app copy", drawLocal], ["@wowsp/holo copy", drawHolo]] as const) {
  describe(`drawShipGlyph anchor centring (${name})`, () => {
    const ANCHOR = { x: 100, y: 80 };

    it("draws every class centred on the anchor, not one atlas half-cell off", () => {
      // Half a 28-unit cell at the enlarged map's 34 px glyph ≈ 20 px —
      // the pre-fix offset that showed every trail ending at the icon's
      // bottom-right corner. The traced art itself sits within 0.5 atlas
      // units of the cell centre, so 1 px is a tight bound.
      for (const type of ["Destroyer", "Cruiser", "Battleship", "AirCarrier", "Submarine"]) {
        const { rec, ctx } = recordingCtx();
        draw(ctx, type, ANCHOR.x, ANCHOR.y, 34, 0x4ade80);
        const b = bbox(rec.paths);
        const cx = (b.minX + b.maxX) / 2 - ANCHOR.x;
        const cy = (b.minY + b.maxY) / 2 - ANCHOR.y;
        expect(Math.abs(cx), `${type} x-centre off by ${cx}`).toBeLessThanOrEqual(1);
        expect(Math.abs(cy), `${type} y-centre off by ${cy}`).toBeLessThanOrEqual(1);
      }
    });

    it("keeps the trail's anchor inside the glyph at every heading", () => {
      // The painters translate(anchor) → rotate(yaw − π/2) → draw at 0,0;
      // the trail line is welded to that anchor. Whatever the heading, the
      // anchor must stay inside the icon's outline box — under the old
      // half-cell offset it fell OUTSIDE for every heading, so trails
      // always met the icon's corner instead of its middle.
      for (const type of ["Destroyer", "Cruiser", "Battleship", "AirCarrier", "Submarine"]) {
        for (let h = 0; h < 8; h++) {
          const rot = (h * Math.PI) / 4 - Math.PI / 2;
          const { rec, ctx } = recordingCtx();
          draw(ctx, type, ANCHOR.x, ANCHOR.y, 34, 0x4ade80);
          const c = Math.cos(rot);
          const s = Math.sin(rot);
          const rotated = rec.paths.map((poly) =>
            poly.map((p) => {
              const lx = p.x - ANCHOR.x;
              const ly = p.y - ANCHOR.y;
              return { x: ANCHOR.x + lx * c - ly * s, y: ANCHOR.y + lx * s + ly * c };
            }),
          );
          const b = bbox(rotated);
          expect(b.minX, `${type} @ ${h * 45}°: anchor east of the glyph`).toBeLessThanOrEqual(ANCHOR.x);
          expect(b.maxX, `${type} @ ${h * 45}°: anchor west of the glyph`).toBeGreaterThanOrEqual(ANCHOR.x);
          expect(b.minY, `${type} @ ${h * 45}°: anchor south of the glyph`).toBeLessThanOrEqual(ANCHOR.y);
          expect(b.maxY, `${type} @ ${h * 45}°: anchor north of the glyph`).toBeGreaterThanOrEqual(ANCHOR.y);
        }
      }
    });
  });
}
