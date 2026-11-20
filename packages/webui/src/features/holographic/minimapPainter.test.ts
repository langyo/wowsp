/**
 * ENLARGED 2D MAP — PAINT-SESSION INVARIANCE.
 *
 * User report (2026-11-20): "after enlarging the 2D minimap once, the
 * SECOND enlargement showed alive ships' markers one ring bigger; sunk
 * ships' sizes did not change."
 *
 * The enlarged overlay is a FRESH <canvas> per open (HolographicMap mounts
 * it under its minimapZoom conditional, HolographicMap.tsx:3865), painted
 * through drawMinimap -> paintEnlargedMap at ~16 Hz, and the host resets
 * the backing store + transform every frame (minimapPainter.ts:794-825).
 * The glyph loop itself is stateless: one drawShipGlyph per marker at a
 * FIXED logical size (dead ? 26 : 34) plus its heading rotation.
 *
 * These tests pin the invariant the report would violate: a paint session
 * leaves nothing behind. The same map context painted through fresh
 * canvases (open, close, open) — and again on the same canvases — must
 * produce IDENTICAL glyph geometry at the same logical scale, and must not
 * touch the markers' userData/pose. A regression that made the second
 * session stateful (a cached per-marker size, a leftover transform, a
 * second draw layered over the alive glyphs) fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComputedRef, Ref } from "vue";
import type * as THREE from "three";

import { fakeAs } from "@/test-utils/fakes";
import { drawMinimap } from "./minimapPainter";
import { TEAM_COLOR } from "./teamColors";
import { TACTICAL_SIZE } from "./tactical/render";
import type { MapInternals } from "./mapInternals";

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** this x m (canvas convention: the new transform is current * argument). */
function mul(a: Mat, m: Mat): Mat {
  return [
    a[0] * m[0] + a[2] * m[1],
    a[1] * m[0] + a[3] * m[1],
    a[0] * m[2] + a[2] * m[3],
    a[1] * m[2] + a[3] * m[3],
    a[0] * m[4] + a[2] * m[5] + a[4],
    a[1] * m[4] + a[3] * m[5] + a[5],
  ];
}

interface FillRec {
  /** Device-space (backing-store px) bounds of the filled path. */
  w: number;
  h: number;
  x: number;
  y: number;
  fill: string;
}
interface StrokeRec {
  w: number;
  h: number;
  stroke: string;
  lw: number;
  dash: string;
}

/** Recording 2D-context double: tracks the affine transform so every fill
 *  and stroke can be reported in DEVICE pixels — the unit the user sees,
 *  and the one a stale backing store / matrix leak would corrupt. */
class FakeCtx {
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign: CanvasTextAlign = "left";
  textBaseline: CanvasTextBaseline = "alphabetic";
  globalAlpha = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  imageSmoothingEnabled = false;
  readonly fills: FillRec[] = [];
  readonly strokes: StrokeRec[] = [];
  private m: Mat = IDENTITY;
  private stack: Mat[] = [];
  private pts: { x: number; y: number }[] = [];
  private dash: number[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {}

  reset(): void {
    this.fills.length = 0;
    this.strokes.length = 0;
    this.pts = [];
    this.dash = [];
    this.m = IDENTITY;
    this.stack = [];
  }

  save(): void {
    this.stack.push(this.m);
  }
  restore(): void {
    const prev = this.stack.pop();
    if (prev) this.m = prev;
  }
  translate(x: number, y: number): void {
    this.m = mul(this.m, [1, 0, 0, 1, x, y]);
  }
  rotate(r: number): void {
    this.m = mul(this.m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
  }
  scale(x: number, y: number): void {
    this.m = mul(this.m, [x, 0, 0, y, 0, 0]);
  }
  // Overloaded on the real type (matrix OR six numbers) — the double only
  // ever receives the six-number form the painters use.
  readonly setTransform: CanvasRenderingContext2D["setTransform"] = ((
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void => {
    this.m = [a, b, c, d, e, f];
  }) as CanvasRenderingContext2D["setTransform"];
  getTransform(): DOMMatrix {
    return fakeAs<DOMMatrix>({
      a: this.m[0],
      b: this.m[1],
      c: this.m[2],
      d: this.m[3],
      e: this.m[4],
      f: this.m[5],
    });
  }
  beginPath(): void {
    this.pts = [];
  }
  moveTo(x: number, y: number): void {
    this.pts.push({ x, y });
  }
  lineTo(x: number, y: number): void {
    this.pts.push({ x, y });
  }
  closePath(): void {}
  rect(x: number, y: number, w: number, h: number): void {
    this.pts.push({ x, y }, { x: x + w, y: y + h });
  }
  roundRect(x: number, y: number, w: number, h: number): void {
    this.pts.push({ x, y }, { x: x + w, y: y + h });
  }
  arc(cx: number, cy: number, r: number): void {
    this.pts.push({ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r });
  }
  setLineDash(dash: number[]): void {
    this.dash = dash ?? [];
  }
  measureText(text: string): TextMetrics {
    return fakeAs<TextMetrics>({ width: text.length * 6 });
  }
  fill(): void {
    const b = this.bbox();
    if (b) this.fills.push({ ...b, fill: String(this.fillStyle) });
  }
  stroke(): void {
    const b = this.bbox();
    if (b) {
      this.strokes.push({
        ...b,
        stroke: String(this.strokeStyle),
        lw: this.lineWidth,
        dash: this.dash.join(","),
      });
    }
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.pts = [{ x, y }, { x: x + w, y: y + h }];
    this.fill();
    this.pts = [];
  }
  strokeRect(): void {}
  clearRect(): void {}
  fillText(): void {}
  strokeText(): void {}
  drawImage(): void {}

  /** Device-space AABB of the current path. */
  private bbox(): { w: number; h: number; x: number; y: number } | null {
    if (this.pts.length < 2) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of this.pts) {
      const x = this.m[0] * p.x + this.m[2] * p.y + this.m[4];
      const y = this.m[1] * p.x + this.m[3] * p.y + this.m[5];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return {
      w: Math.round((maxX - minX) * 100) / 100,
      h: Math.round((maxY - minY) * 100) / 100,
      x: Math.round(minX * 100) / 100,
      y: Math.round(minY * 100) / 100,
    };
  }
}

/** Fake <canvas>: attribute-sized backing store + a CSS box, the two things
 *  the painter reads to derive its transform. */
class FakeCanvas {
  width = TACTICAL_SIZE;
  height = TACTICAL_SIZE;
  private ctx: FakeCtx | null = null;

  constructor(private readonly cssW: number) {}

  // Typed as the real overload set so the double stays assignable to
  // Partial<HTMLCanvasElement> (fakeAs' whole point) instead of needing a
  // blank cast at every call site.
  readonly getContext: HTMLCanvasElement["getContext"] = ((
    kind: string,
  ): CanvasRenderingContext2D | null => {
    if (kind !== "2d") return null;
    this.ctx ??= new FakeCtx(fakeAs<HTMLCanvasElement>(this));
    return fakeAs<CanvasRenderingContext2D>(this.ctx);
  }) as HTMLCanvasElement["getContext"];
  /** The recorder, materialized without painting. */
  rec(): FakeCtx {
    this.getContext("2d");
    return this.ctx!;
  }
  getBoundingClientRect(): DOMRect {
    return fakeAs<DOMRect>({
      width: this.cssW,
      height: this.cssW,
      left: 0,
      top: 0,
      right: this.cssW,
      bottom: this.cssW,
      x: 0,
      y: 0,
    });
  }
}

const SHIP_CLASS = "Destroyer";
const DEAD_INK = "#8a97a5";
const ALLY_INK = "#" + TEAM_COLOR.ally.toString(16).padStart(6, "0");
const SELF_INK = "#" + TEAM_COLOR.self.toString(16).padStart(6, "0");

/** Marker double: the painter only reads userData + position (never a
 *  THREE method), so a plain object is the honest double. */
function ship(
  role: "ally" | "enemy" | "self",
  x: number,
  z: number,
  deathTime: number | null,
) {
  // The painter reads userData + position only (never a THREE method), so a
  // two-field object is the honest double; the cast states that.
  return {
    userData: {
      entityId: role === "self" ? 3 : role === "ally" ? 1 : 2,
      role,
      type: SHIP_CLASS,
      firstT: 0,
      deathTime,
      yaw: 0,
      spawnX: x,
      spawnZ: z,
    },
    position: { x, z },
  } as unknown as THREE.Group;
}

const T = 30;

function makeCtx(markers: THREE.Group[]): MapInternals {
  const ref = <V>(value: V) => fakeAs<Ref<V>>({ value });
  return fakeAs<MapInternals>({
    props: fakeAs<MapInternals["props"]>({
      trajectories: [],
      wards: [],
      wardRemoves: [],
      weatherTransitions: [],
      weatherNotifications: [],
      minimapSquadronAdds: [],
      minimapSquadronRemoves: [],
    }),
    current: ref(T),
    minimapCanvas: ref<HTMLCanvasElement | null>(null),
    zoomCanvas: ref<HTMLCanvasElement | null>(null),
    minimapZoom: ref(true),
    minimapShowTrails: ref(true),
    minimapShowGrid: ref(true),
    mmRotationDeg: ref(0),
    mmView: ref({ cx: 0, cz: 0, scale: 1 }),
    minimapBounds: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 },
    bounds: null,
    minimapImage: null,
    _mmCtx: null,
    shipMarkers: markers,
    shipLabels: ref([]),
    capZones: fakeAs<ComputedRef<never[]>>({ value: [] }),
    capDisplay: ref([]),
    smokeClusters: [],
    planeTrails: [],
    planeSmoothState: new Map(),
    minimapTrailEnd: new Map(),
    planeTypesById: new Map(),
    torpedoMeshes: [],
    trajById: new Map(),
    aiAnalysisOn: ref(false),
    decisionReport: ref(null),
    debugReport: ref(null),
    selfRings: [],
  });
}

interface Session {
  glyphs: string[];
  strokes: StrokeRec[];
  scale: number;
  thumbBacking: number;
}

/** One overlay "session": a fresh thumbnail + enlarged canvas (exactly what
 *  closing and reopening the enlarged view does) painted twice — the first
 *  paint lays out the backing store, the second is a steady-state frame. */
function paint(ctx: MapInternals, thumb: FakeCanvas, zoom: FakeCanvas): Session {
  ctx.minimapCanvas.value = fakeAs<HTMLCanvasElement>(thumb);
  ctx.zoomCanvas.value = fakeAs<HTMLCanvasElement>(zoom);
  const zrec = zoom.rec();
  const trec = thumb.rec();
  zrec.reset();
  trec.reset();
  drawMinimap(ctx); // layout frame (backing store + transform land here)
  zrec.reset();
  trec.reset();
  drawMinimap(ctx); // steady-state frame — the one the tests compare
  const glyphs = zrec.fills
    .filter((f) => /^#[0-9a-f]{6}$/i.test(f.fill))
    .map((f) => f.fill + "@" + f.w + "x" + f.h)
    .sort();
  return {
    glyphs,
    strokes: [...zrec.strokes].sort((a, b) =>
      (a.stroke + "|" + a.lw + "|" + a.dash + "|" + a.w).localeCompare(
        b.stroke + "|" + b.lw + "|" + b.dash + "|" + b.w,
      ),
    ),
    scale: zrec.getTransform().a,
    thumbBacking: thumb.width,
  };
}

/** Tallest one-polygon fill of a given ink — the glyph's device height. */
function glyphHeight(s: Session, ink: string): number {
  const heights = s.glyphs
    .filter((g) => g.startsWith(ink + "@"))
    .map((g) => Number(g.split("@")[1].split("x")[1]));
  return heights.length > 0 ? Math.max(...heights) : 0;
}

let prevDpr: number;
beforeAll(() => {
  prevDpr = window.devicePixelRatio;
  Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
});
afterAll(() => {
  Object.defineProperty(window, "devicePixelRatio", { value: prevDpr, configurable: true });
});

describe("enlarged 2D map paint sessions", () => {
  it("a reopened enlarged view draws byte-identical glyph geometry", () => {
    const markers = [
      ship("self", -200, 0, null),
      ship("ally", 100, -300, null),
      ship("ally", 400, 200, 10), // sunk at t=10 (playhead is 30)
    ];
    const ctx = makeCtx(markers);

    // Session 1: open, close. Session 2: open again (fresh canvases, the
    // shared map context is the same object — that is the report's shape).
    const s1 = paint(ctx, new FakeCanvas(160), new FakeCanvas(720));
    const s2 = paint(ctx, new FakeCanvas(160), new FakeCanvas(720));

    expect(s2.glyphs).toEqual(s1.glyphs);
    expect(s2.strokes).toEqual(s1.strokes);
    expect(s2.scale).toBeCloseTo(s1.scale, 10);
  });

  it("repainting the same canvases does not layer a second glyph pass", () => {
    const markers = [ship("ally", 100, -300, null), ship("ally", 400, 200, 10)];
    const ctx = makeCtx(markers);
    const thumb = new FakeCanvas(160);
    const zoom = new FakeCanvas(720);
    const first = paint(ctx, thumb, zoom);
    const again = paint(ctx, thumb, zoom);
    expect(again.glyphs).toEqual(first.glyphs);
    expect(again.glyphs).toHaveLength(first.glyphs.length);
  });

  it("keeps the alive/sunk glyph ratio (34/26) and the backing-store scale", () => {
    const markers = [
      ship("self", -200, 0, null),
      ship("ally", 100, -300, null),
      ship("ally", 400, 200, 10),
    ];
    const ctx = makeCtx(markers);
    const zoom = new FakeCanvas(720);
    const session = paint(ctx, new FakeCanvas(160), zoom);

    // Backing store = CSS box x dpr; the drawing transform maps
    // TACTICAL_SIZE logical units onto it, so a glyph's device size is
    // size * px / 760.
    expect(session.thumbBacking).toBe(320); // 160 CSS px x dpr 2
    expect(zoom.width).toBe(1440); // 720 CSS px x dpr 2
    expect(session.scale).toBeCloseTo(1440 / TACTICAL_SIZE, 10);

    const alive = glyphHeight(session, ALLY_INK);
    const dead = glyphHeight(session, DEAD_INK);
    expect(alive).toBeGreaterThan(0);
    expect(dead).toBeGreaterThan(0);
    expect(alive / dead).toBeCloseTo(34 / 26, 2);
    // The recorder's own hull is drawn at the alive size too.
    expect(glyphHeight(session, SELF_INK)).toBe(alive);
  });

  it("leaves no state on the markers or the context between sessions", () => {
    const markers = [
      ship("self", -200, 0, null),
      ship("ally", 100, -300, null),
      ship("ally", 400, 200, 10),
    ];
    const ctx = makeCtx(markers);
    const before = markers.map((m) => ({
      userData: JSON.stringify(m.userData),
      pose: JSON.stringify(m.position),
    }));
    paint(ctx, new FakeCanvas(160), new FakeCanvas(720));
    paint(ctx, new FakeCanvas(160), new FakeCanvas(720));
    const after = markers.map((m) => ({
      userData: JSON.stringify(m.userData),
      pose: JSON.stringify(m.position),
    }));
    expect(after).toEqual(before);
  });
});

describe("thumbnail canvas context cache", () => {
  it("rebinds the cached context when the thumbnail element is replaced", () => {
    const markers = [ship("self", -200, 0, null)];
    const ctx = makeCtx(markers);
    // A context bound to a canvas that is no longer the live one (a remounted
    // map pane used to leave the painter drawing the detached canvas).
    const stale = new FakeCanvas(160);
    ctx._mmCtx = stale.getContext("2d");
    const staleRec = stale.rec();

    const fresh = new FakeCanvas(160);
    const zoom = new FakeCanvas(720);
    ctx.minimapCanvas.value = fakeAs<HTMLCanvasElement>(fresh);
    ctx.zoomCanvas.value = fakeAs<HTMLCanvasElement>(zoom);
    const freshRec = fresh.rec();
    freshRec.reset();
    staleRec.reset();
    drawMinimap(ctx);

    expect(freshRec.fills.length).toBeGreaterThan(0); // the LIVE canvas paints
    expect(staleRec.fills).toHaveLength(0); // the detached one is left alone
  });
});
