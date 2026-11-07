/**
 * The 2D minimap's trail lines terminate at the ship's projected pose —
 * the SAME anchor drawShipGlyph is centred on (painters translate to the
 * anchor, rotate to the heading, then call drawShipGlyph(ctx, type, 0, 0)).
 * The traced polygons keep their raw 28×28 atlas coordinates, so the painter
 * must re-centre them: before the atlas-centre subtraction every glyph drew
 * its body one half-cell down-right of the anchor (≈17–20 px on the enlarged
 * map), so trails always met the icon's bottom-right corner instead of its
 * centre.
 *
 * The app's `./shipGlyph` module re-exports the @wowsp/holo painter (one
 * table for the app, the site and the tactical board); the suites below run
 * that single face and pin the atlas entries themselves.
 */
import { describe, expect, it } from "vitest";

import { fakeAs } from "@/test-utils/fakes";
import { drawShipGlyph as drawApp } from "./shipGlyph";
import { drawShipGlyph as drawHolo, glyphClassOf, SHIP_GLYPH_POLYS } from "@wowsp/holo";

type Pt = { x: number; y: number };

const GLYPH_CLASSES = ["Destroyer", "Cruiser", "Battleship", "AirCarrier", "Submarine", "Auxiliary"];

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

describe("ship-class atlas", () => {
  it("re-exports the shared @wowsp/holo painter", () => {
    // One art source: the app minimap, the site's minimap and the tactical
    // board draw the same table (the app used to carry a verbatim copy).
    expect(drawApp).toBe(drawHolo);
  });

  it("pins the shared atlas (the one art source the app and the site draw)", () => {
    // The atlas IS the art contract: @wowsp/holo is the only copy (the app
    // and the site re-export/consume it), and the package ships no test
    // runner of its own — so the entries are pinned here, literally. The
    // five engraved classes are raster-traced; the auxiliary marker carries
    // no engraving, so its single polygon is authored from the same hull +
    // bow geometry the SVG faces use.
    expect(SHIP_GLYPH_POLYS).toEqual({
      destroyer: [[[5.5, 9.5], [21.5, 13.5], [5.5, 17.5]]],
      cruiser: [
        [[16.5, 9.5], [18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [11.5, 17.5], [15.5, 10.5]],
        [[5.5, 9.5], [13.5, 9.5], [8.5, 17.5], [5.5, 17.5]],
      ],
      battleship: [
        [[5.5, 9.5], [11.5, 9.5], [6.5, 17.5], [5.5, 17.5]],
        [[14.5, 9.5], [15.5, 9.5], [11.5, 16.5], [9.5, 17.5], [13.5, 10.5]],
        [[18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [13.5, 17.5], [17.5, 10.5]],
      ],
      aircarrier: [
        [[16.5, 9.5], [18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [16.5, 17.5]],
        [[5.5, 9.5], [14.5, 9.5], [14.5, 12.5], [5.5, 12.5]],
        [[5.5, 14.5], [14.5, 14.5], [14.5, 17.5], [5.5, 17.5]],
      ],
      submarine: [
        [[5.5, 9.5], [6.5, 9.5], [6.5, 17.5], [5.5, 17.5]],
        [[9.5, 10.5], [21.5, 13.5], [9.5, 16.5]],
      ],
      auxiliary: [[[5.5, 9.5], [18.5, 9.5], [22.5, 13.5], [18.5, 17.5], [5.5, 17.5]]],
    });
  });

  it("draws auxiliary hulls with their own glyph, not the cruiser fallback", () => {
    expect(glyphClassOf("Auxiliary")).toBe("auxiliary");
    expect(glyphClassOf("auxiliary")).toBe("auxiliary");
    expect(glyphClassOf("UnknownHull")).toBe("cruiser");

    // One pentagon — the cruiser fallback would record two polygons.
    const { rec, ctx } = recordingCtx();
    drawApp(ctx, "Auxiliary", 100, 80, 34, 0x4ade80);
    expect(rec.paths).toHaveLength(1);
    expect(rec.paths[0]).toHaveLength(5);
  });
});

describe("drawShipGlyph anchor centring", () => {
  const ANCHOR = { x: 100, y: 80 };

  it("draws every class centred on the anchor, not one atlas half-cell off", () => {
    // Half a 28-unit cell at the enlarged map's 34 px glyph ≈ 20 px —
    // the pre-fix offset that showed every trail ending at the icon's
    // bottom-right corner. The traced art itself sits within 0.5 atlas
    // units of the cell centre, so 1 px is a tight bound.
    for (const type of GLYPH_CLASSES) {
      const { rec, ctx } = recordingCtx();
      drawApp(ctx, type, ANCHOR.x, ANCHOR.y, 34, 0x4ade80);
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
    for (const type of GLYPH_CLASSES) {
      for (let h = 0; h < 8; h++) {
        const rot = (h * Math.PI) / 4 - Math.PI / 2;
        const { rec, ctx } = recordingCtx();
        drawApp(ctx, type, ANCHOR.x, ANCHOR.y, 34, 0x4ade80);
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
