/** The 3D clip's in-scene label cards: card art (name/ship/three-layer HP
 *  bar), screen-constant sizing, the alive-only lifecycle and the repaint
 *  gate. The user's rule is 「阵亡的才不显示，不是全部不显示」 — a take must
 *  card every living hull and drop a sunk one. */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";

import {
  EXPORT_LABEL_LAYER,
  SHIP_LABEL_CARD_H,
  SHIP_LABEL_CARD_W,
  SHIP_LABEL_REFRESH_FRAMES,
  ShipLabelSpriteLayer,
  exportShipCardVisible,
  labelContentSignature,
  labelHpFrac,
  labelSpriteWorldSize,
  paintShipLabelCard,
  type ShipLabelCardData,
  type ShipLabelSpriteInput,
} from "./exportShipLabels";
import { EXPORT_LOGICAL } from "./playbackExport";

interface Painted {
  text?: string;
  font?: string;
  fill?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

function fakeCtx() {
  const texts: Painted[] = [];
  const rects: Painted[] = [];
  let roundRects = 0;
  let clears = 0;
  const ctx: Record<string, unknown> = {
    font: "",
    fillStyle: "",
    textAlign: "",
    textBaseline: "",
    clearRect() {
      clears++;
    },
    beginPath() {},
    roundRect() {
      roundRects++;
    },
    fill() {},
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill: String(ctx.fillStyle) });
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, font: String(ctx.font), fill: String(ctx.fillStyle) });
    },
    measureText(text: string) {
      return { width: text.length * 6 };
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    texts,
    rects,
    roundRects: () => roundRects,
    clears: () => clears,
  };
}

function fakeCanvas() {
  const rec = fakeCtx();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => rec.ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, ...rec };
}

/** A canvas factory that counts PAINTS (one clearRect per paint), so the
 *  repaint gate is observable. */
function countingCanvasFactory() {
  const counters = { paints: 0 };
  const factory = () => {
    const rec = fakeCtx();
    const ctx = rec.ctx as unknown as { clearRect: (...args: unknown[]) => void };
    const clear = ctx.clearRect.bind(ctx);
    ctx.clearRect = (...args: unknown[]) => {
      counters.paints++;
      clear(...args);
    };
    return {
      width: 0,
      height: 0,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
  };
  return { factory, counters };
}

const data = (over: Partial<ShipLabelCardData> = {}): ShipLabelCardData => ({
  name: "Commander",
  clan: "TAG",
  tier: "X",
  shipName: "Yamato",
  role: "ally",
  hp: 5000,
  maxHp: 10000,
  recoverableFrac: 0.25,
  ...over,
});

const input = (
  entityId: number,
  over: Partial<ShipLabelSpriteInput> = {},
): ShipLabelSpriteInput => ({
  entityId,
  x: 100,
  y: 0,
  z: -200,
  data: data(),
  ...over,
});

const camera = () => {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100000);
  cam.position.set(0, 1000, 0);
  cam.updateMatrixWorld(true);
  return cam;
};

describe("labelSpriteWorldSize", () => {
  it("keeps the 2D card's aspect at every depth", () => {
    for (const d of [100, 1000, 20000]) {
      const s = labelSpriteWorldSize(50, d);
      expect(s.w / s.h).toBeCloseTo(SHIP_LABEL_CARD_W / SHIP_LABEL_CARD_H, 5);
    }
  });

  it("spans the card's logical pixels across the map square", () => {
    const fov = 50;
    const d = 1500;
    const s = labelSpriteWorldSize(fov, d);
    // worldPerLogicalPx = 2*d*tan(fov/2) / EXPORT_LOGICAL
    const per = (2 * d * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / EXPORT_LOGICAL;
    expect(s.w).toBeCloseTo(SHIP_LABEL_CARD_W * per, 6);
    expect(s.h).toBeCloseTo(SHIP_LABEL_CARD_H * per, 6);
    // Grows with distance so the on-screen size stays constant.
    expect(labelSpriteWorldSize(fov, d * 2).w).toBeCloseTo(s.w * 2, 6);
  });
});

describe("paintShipLabelCard", () => {
  it("draws the two identity lines and the three-layer HP bar in order", () => {
    const { canvas, texts, rects, roundRects } = fakeCanvas();
    paintShipLabelCard(canvas, data());
    expect(roundRects()).toBe(1);
    expect(texts.map((x) => x.text)).toEqual(["[TAG] Commander", "X Yamato"]);
    // Track + green (50%) + grey (25% recoverable) + red (25% lost).
    const bars = rects.filter((r) => (r.h ?? 0) > 0);
    expect(bars).toHaveLength(4);
    const [track, green, grey, red] = bars as [Painted, Painted, Painted, Painted];
    expect(track.fill).toBe("rgba(148, 163, 184, 0.22)");
    expect(green.fill).toBe("rgba(74, 222, 128, 0.95)");
    expect(grey.fill).toBe("rgba(200, 208, 220, 0.85)");
    expect(red.fill).toBe("rgba(248, 92, 92, 0.85)");
    // Segments sit side by side, left to right: green, grey, red.
    expect(green.x).toBeCloseTo(track.x, 6);
    expect(grey.x).toBeGreaterThan(green.x);
    expect(red.x).toBeGreaterThan(grey.x);
    expect(green.w).toBeCloseTo((grey.w ?? 0) * 2, 6);
    expect(grey.w).toBeCloseTo(red.w ?? 0, 6);
    // The bar never overhangs the card.
    for (const bar of bars) {
      expect(bar.x + (bar.w ?? 0)).toBeLessThanOrEqual(SHIP_LABEL_CARD_W * 2 + 0.01);
    }
  });

  it("keeps the two-layer bar when the replay streamed no repair party", () => {
    const { canvas, rects } = fakeCanvas();
    paintShipLabelCard(canvas, data({ recoverableFrac: null, hp: 0 }));
    // Track + red only: the pool segment must not appear out of nowhere.
    expect(rects.some((r) => r.fill === "rgba(200, 208, 220, 0.85)")).toBe(false);
    expect(rects.some((r) => r.fill === "rgba(74, 222, 128, 0.95)")).toBe(false);
    expect(rects.some((r) => r.fill === "rgba(248, 92, 92, 0.85)")).toBe(true);
  });

  it("clears the canvas before every repaint (no ghosted old text)", () => {
    const { canvas, clears } = fakeCanvas();
    paintShipLabelCard(canvas, data());
    expect(clears()).toBe(1);
  });
});

describe("exportShipCardVisible (the user's rule: only the sunk are hidden)", () => {
  it("cards a living hull", () => {
    expect(exportShipCardVisible({ t: 45, firstT: 10, deathTime: null, hp: 12000 })).toBe(true);
    // A spotted-then-dark ghost keeps its card (the 2D pass does the same).
    expect(exportShipCardVisible({ t: 45, firstT: 10, deathTime: null, dead: false })).toBe(true);
  });

  it("drops a SUNK hull the instant its death time is reached", () => {
    const at = (t: number) => exportShipCardVisible({ t, firstT: 10, deathTime: 30, hp: 5000 });
    expect(at(29.9)).toBe(true);
    expect(at(30)).toBe(false);
    expect(at(45)).toBe(false);
    // The content pass's dead flag wins even without a recorded instant.
    expect(exportShipCardVisible({ t: 45, firstT: 10, dead: true })).toBe(false);
    expect(exportShipCardVisible({ t: 45, firstT: 10, hp: 0 })).toBe(false);
  });

  it("never cards a hull nobody has observed yet", () => {
    expect(exportShipCardVisible({ t: 5, firstT: 10, hp: 100 })).toBe(false);
    expect(exportShipCardVisible({ t: 5 })).toBe(false);
  });
});

describe("labelHpFrac / labelContentSignature", () => {
  it("clamps the HP fraction and treats unknown HP as empty", () => {
    expect(labelHpFrac(data())).toBe(0.5);
    expect(labelHpFrac(data({ hp: 2, maxHp: 1 }))).toBe(1);
    expect(labelHpFrac(data({ hp: -5 }))).toBe(0);
    expect(labelHpFrac(data({ hp: null }))).toBe(0);
    expect(labelHpFrac(data({ maxHp: 0 }))).toBe(0);
  });

  it("flags identity changes but not HP changes", () => {
    const base = labelContentSignature(data());
    expect(labelContentSignature(data({ hp: 1 }))).toBe(base);
    expect(labelContentSignature(data({ clan: null }))).not.toBe(base);
    expect(labelContentSignature(data({ shipName: "Musashi" }))).not.toBe(base);
  });
});

describe("ShipLabelSpriteLayer", () => {
  it("cards every alive hull on the export-only layer", () => {
    const scene = new THREE.Scene();
    const layer = new ShipLabelSpriteLayer(scene, () => fakeCanvas().canvas);
    const cam = camera();
    layer.update(cam, [input(1), input(2)], 0);
    expect(layer.count).toBe(2);
    const sprite = layer.spriteOf(1)!;
    expect(sprite).toBeTruthy();
    expect((sprite.layers.mask & (1 << EXPORT_LABEL_LAYER)) !== 0).toBe(true);
    // The card floats above the hull and spans the 2D card's map-square size.
    const size = labelSpriteWorldSize(cam.fov, cam.position.distanceTo(new THREE.Vector3(100, 0, -200)));
    expect(sprite.scale.x).toBeCloseTo(size.w, 6);
    expect(sprite.scale.y).toBeCloseTo(size.h, 6);
    expect(sprite.position.y).toBeGreaterThan(0);
    expect(scene.children).toContain(sprite.parent);
    layer.dispose();
    expect(layer.count).toBe(0);
  });

  it("repaints only when the HP fraction moves materially", () => {
    const { factory, counters } = countingCanvasFactory();
    const layer = new ShipLabelSpriteLayer(new THREE.Scene(), factory);
    const cam = camera();
    layer.update(cam, [input(1)], 0);
    expect(counters.paints).toBe(1);
    // A sub-0.5% wobble must NOT repaint the card.
    layer.update(cam, [input(1, { data: data({ hp: 5010 }) })], 1);
    expect(counters.paints).toBe(1);
    // A material drop does.
    layer.update(cam, [input(1, { data: data({ hp: 4000 }) })], 2);
    expect(counters.paints).toBe(2);
    // Identity changes repaint immediately...
    layer.update(cam, [input(1, { data: data({ hp: 4000, shipName: "Musashi" }) })], 3);
    expect(counters.paints).toBe(3);
    // ...and the slow cadence is the safety net for everything else.
    layer.update(cam, [input(1, { data: data({ hp: 4000, shipName: "Musashi" }) })], SHIP_LABEL_REFRESH_FRAMES + 3);
    expect(counters.paints).toBe(4);
    layer.dispose();
  });

  it("drops a hull's sprite (and its texture) when it leaves the alive set", () => {
    const scene = new THREE.Scene();
    const layer = new ShipLabelSpriteLayer(scene, () => fakeCanvas().canvas);
    const cam = camera();
    layer.update(cam, [input(1), input(2)], 0);
    const texture = layer.spriteOf(2)!.material.map!;
    const dispose = vi.spyOn(texture, "dispose");
    layer.update(cam, [input(1)], 1);
    expect(layer.count).toBe(1);
    expect(layer.spriteOf(2)).toBeUndefined();
    expect(dispose).toHaveBeenCalled();
    layer.dispose();
    expect(layer.count).toBe(0);
  });

  it("does nothing without a mounted scene", () => {
    const layer = new ShipLabelSpriteLayer(null, () => fakeCanvas().canvas);
    layer.update(camera(), [input(1)], 0);
    expect(layer.count).toBe(0);
    layer.dispose();
  });
});
