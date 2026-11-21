/**
 * In-scene ship label cards for the replay clip's 3D god-camera export.
 *
 * The clip's 2D map layer paints a floating card per observed hull
 * (minimapPainter's ship-label pass), but the 3D export renders the LIVE
 * WebGL scene instead — where DOM labels cannot be captured. So the 3D take
 * draws the SAME card (nickname+clan, tier+ship name, the three-layer HP bar)
 * into an offscreen canvas and hangs it over each hull as a `THREE.Sprite`.
 *
 * The user's rule (2026-11-22): 「我的意思是阵亡的才不显示，不是全部不显示」 —
 * every ALIVE hull in play gets a card; a SUNK hull gets none (the caller
 * filters them out, see HolographicMap's export feed).
 *
 * Sizing is screen-constant, not world-constant: the export camera is fixed
 * and top-down, so a sprite whose world size is `distance * 2*tan(fov/2) *
 * cardPx / EXPORT_LOGICAL` spans exactly its 2D-design pixel width in the
 * clip's map square (~92x40 logical px, the 2D card's own box) at any depth.
 *
 * Cost control: a card's texture is a small canvas and its content is
 * near-static, so it REPAINTS only when its HP fraction moves by more than
 * `SHIP_LABEL_HP_EPSILON` (0.5%) or its identity text changes, with a slow
 * full refresh every `SHIP_LABEL_REFRESH_FRAMES` frames as the safety net.
 * Everything is disposed when the take ends.
 */
import * as THREE from "three";

import { EXPORT_LOGICAL } from "./playbackExport";
import { hpBarSegments } from "./repairPool";

/** Scene layer the export-only cards live on: the export camera enables it,
 *  the live camera never does — so the cards can never leak into the running
 *  3D view while a take runs (the scene is repainted at the live camera every
 *  frame by the export's own restore path). */
export const EXPORT_LABEL_LAYER = 1;

/** Card design box in logical map px — the 2D label pass's own 92x40 pill. */
export const SHIP_LABEL_CARD_W = 92;
export const SHIP_LABEL_CARD_H = 40;

/** Canvas supersampling: the clip can be 2K+, so text is rasterized at 2x. */
const CARD_RASTER = 2;

/** Above every other transparent overlay (the rings sit at 7). */
const LABEL_RENDER_ORDER = 20;

/** Repaint threshold for the HP fraction (0.5 percentage points). */
export const SHIP_LABEL_HP_EPSILON = 0.005;
/** Safety-net full refresh cadence (identity text can resolve late). */
export const SHIP_LABEL_REFRESH_FRAMES = 60;

export type ShipLabelRole = "ally" | "enemy" | "self";

/** One hull's card content — the 2D label pass's fields, already resolved by
 *  the caller (clan tag, roman tier). */
export interface ShipLabelCardData {
  name: string;
  clan: string | null;
  tier: string | null;
  shipName: string;
  role: ShipLabelRole;
  hp: number | null;
  maxHp: number | null;
  /** Repair-Party recoverable pool as a fraction of maxHp (0..1), or null
   *  when the replay streamed no repair-party activation for this hull. */
  recoverableFrac: number | null;
}

/** Whether a hull is CARDED at battle time `t`: it must have been observed
 *  at least once, must not be sunk, and must not sit at zero HP. That is the
 *  user's rule verbatim — 「阵亡的才不显示，不是全部不显示」 — and it is the
 *  only gate the export feed applies (an unspotted hull is not carded, so a
 *  card can never announce an enemy nobody has seen). */
export function exportShipCardVisible(args: {
  t: number;
  /** First observation time (the marker's `firstT`); undefined = never. */
  firstT?: number | null;
  /** Sink instant (the marker's `deathTime`); null/undefined = alive. */
  deathTime?: number | null;
  /** The content pass's own dead flag. */
  dead?: boolean;
  hp?: number | null;
}): boolean {
  if (args.t < (args.firstT ?? Infinity)) return false;
  if (args.deathTime != null && args.t >= args.deathTime) return false;
  if (args.dead) return false;
  if (args.hp != null && args.hp <= 0) return false;
  return true;
}

/** One per-frame input: a living hull's scene position plus its card. */
export interface ShipLabelSpriteInput {
  entityId: number;
  x: number;
  y: number;
  z: number;
  data: ShipLabelCardData;
}

/** Role ink — the 2D label pass's own colours. */
const ROLE_INK: Record<ShipLabelRole, string> = {
  ally: "rgba(126, 226, 168, 0.95)",
  enemy: "rgba(255, 138, 138, 0.95)",
  self: "rgba(255, 255, 255, 0.95)",
};

const FONT_STACK = "ui-sans-serif, system-ui, sans-serif";

/** The current HP fraction the bar paints (0 when unknown — the track only). */
export function labelHpFrac(data: ShipLabelCardData): number {
  if (data.hp == null || data.maxHp == null || data.maxHp <= 0) return 0;
  return Math.min(1, Math.max(0, data.hp / data.maxHp));
}

/** Identity signature: a change here must repaint even if the HP is steady
 *  (a late-resolved ship name, a clan tag arriving with the roster batch). */
export function labelContentSignature(data: ShipLabelCardData): string {
  return [
    data.name,
    data.clan ?? "",
    data.tier ?? "",
    data.shipName,
    data.role,
    data.recoverableFrac ?? "",
  ].join("\u0001");
}

/** Paint one card — the 2D pass's drawing style, at CARD_RASTER scale (the
 *  canvas is cleared first so a repaint never ghosts the old text). */
export function paintShipLabelCard(
  canvas: HTMLCanvasElement,
  data: ShipLabelCardData,
): void {
  const g = canvas.getContext("2d");
  if (!g) return;
  const s = CARD_RASTER;
  const w = SHIP_LABEL_CARD_W * s;
  const h = SHIP_LABEL_CARD_H * s;
  g.clearRect(0, 0, w, h);
  // The card: the same dark rounded pill the 2D pass paints.
  g.fillStyle = "rgba(5, 8, 15, 0.62)";
  g.beginPath();
  g.roundRect(0, 0, w, h, 5 * s);
  g.fill();
  g.textAlign = "center";
  g.textBaseline = "middle";
  // Line 1: [clan] nickname (the 2D pass's 11px/700, centred).
  const nameLine = data.clan ? `[${data.clan}] ${data.name}` : data.name;
  g.font = `700 ${11 * s}px ${FONT_STACK}`;
  g.fillStyle = ROLE_INK[data.role];
  g.fillText(ellipsize(g, nameLine, w - 8 * s), w / 2, 9 * s);
  // Line 2: tier + ship name (10px/500).
  const shipLine = [data.tier, data.shipName].filter(Boolean).join(" ");
  g.font = `500 ${10 * s}px ${FONT_STACK}`;
  g.fillStyle = "rgba(226, 232, 240, 0.8)";
  g.fillText(ellipsize(g, shipLine, w - 8 * s), w / 2, 22 * s);
  // The three-layer HP bar: green (current) | grey (Repair-Party pool) |
  // red (lost for good) — the team roster's own segmenting (hpBarSegments).
  const barX = 6 * s;
  const barW = w - 12 * s;
  const barY = (SHIP_LABEL_CARD_H - 8) * s;
  const barH = 4 * s;
  g.fillStyle = "rgba(148, 163, 184, 0.22)";
  g.fillRect(barX, barY, barW, barH);
  const seg = hpBarSegments(labelHpFrac(data), data.recoverableFrac);
  let cursor = barX;
  if (seg.green > 0) {
    g.fillStyle = "rgba(74, 222, 128, 0.95)";
    g.fillRect(cursor, barY, barW * seg.green, barH);
    cursor += barW * seg.green;
  }
  if (seg.gray > 0) {
    g.fillStyle = "rgba(200, 208, 220, 0.85)";
    g.fillRect(cursor, barY, barW * seg.gray, barH);
    cursor += barW * seg.gray;
  }
  if (seg.red > 0) {
    g.fillStyle = "rgba(248, 92, 92, 0.85)";
    g.fillRect(cursor, barY, barW * seg.red, barH);
  }
}

/** Trim a string until it measures inside `maxW` (the card's own ellipsis;
 *  the 2D pass's helper is module-private). */
function ellipsize(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let out = text;
  while (out.length > 1 && g.measureText(out + "…").width > maxW) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

/** World size of a card for a camera distance: the sprite spans the 2D card's
 *  `SHIP_LABEL_CARD_W` x `SHIP_LABEL_CARD_H` logical px in the map square
 *  (the square is `EXPORT_LOGICAL` px across), independent of depth. */
export function labelSpriteWorldSize(
  fovDeg: number,
  distance: number,
): { w: number; h: number } {
  const worldPerLogicalPx =
    (2 * Math.max(1, distance) * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)) /
    EXPORT_LOGICAL;
  return {
    w: SHIP_LABEL_CARD_W * worldPerLogicalPx,
    h: SHIP_LABEL_CARD_H * worldPerLogicalPx,
  };
}

interface LabelEntry {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  sprite: THREE.Sprite;
  hpFrac: number;
  signature: string;
  lastPaint: number;
}

/** Owns the export-only sprites: create/refresh/remove them and dispose every
 *  GPU resource when the take ends. */
export class ShipLabelSpriteLayer {
  private readonly group = new THREE.Group();
  private readonly entries = new Map<number, LabelEntry>();
  private readonly scene: THREE.Scene | null;
  private readonly tmp = new THREE.Vector3();
  private readonly canvasFactory: () => HTMLCanvasElement;

  constructor(
    scene: THREE.Scene | null,
    canvasFactory: () => HTMLCanvasElement = () => document.createElement("canvas"),
  ) {
    this.scene = scene;
    this.canvasFactory = canvasFactory;
    if (scene) scene.add(this.group);
  }

  /** Sprites currently alive (test/debug hook). */
  get count(): number {
    return this.entries.size;
  }

  /** The sprite carding one entity, if any (test/debug hook). */
  spriteOf(entityId: number): THREE.Sprite | undefined {
    return this.entries.get(entityId)?.sprite;
  }

  /** One frame: `inputs` are the ALIVE hulls to card. A hull absent from the
   *  list (sunk, or no longer carded) loses its sprite and its resources. */
  update(
    camera: THREE.PerspectiveCamera,
    inputs: readonly ShipLabelSpriteInput[],
    frame: number,
  ): void {
    // No scene mounted (a map still loading): there is nothing to hang the
    // cards on, and creating sprites would only leak between takes.
    if (!this.scene) return;
    const seen = new Set<number>();
    for (const input of inputs) {
      seen.add(input.entityId);
      const entry = this.entries.get(input.entityId) ?? this.create(input.entityId);
      const { sprite } = entry;
      const dist = camera.position.distanceTo(
        this.tmp.set(input.x, input.y, input.z),
      );
      const size = labelSpriteWorldSize(camera.fov, dist);
      sprite.scale.set(size.w, size.h, 1);
      // Float the card above the hull: half its own height plus a little.
      sprite.position.set(input.x, input.y + size.h * 0.7, input.z);
      sprite.visible = true;
      const hpFrac = labelHpFrac(input.data);
      const signature = labelContentSignature(input.data);
      const hpMoved = Math.abs(hpFrac - entry.hpFrac) > SHIP_LABEL_HP_EPSILON;
      const identityChanged = signature !== entry.signature;
      const stale = frame - entry.lastPaint >= SHIP_LABEL_REFRESH_FRAMES;
      if (hpMoved || identityChanged || stale) {
        paintShipLabelCard(entry.canvas, input.data);
        entry.texture.needsUpdate = true;
        entry.hpFrac = hpFrac;
        entry.signature = signature;
        entry.lastPaint = frame;
      }
    }
    for (const [entityId, entry] of this.entries) {
      if (seen.has(entityId)) continue;
      this.destroy(entityId, entry);
    }
  }

  /** Drop every sprite and its GPU resources (take end / teardown). */
  dispose(): void {
    for (const [entityId, entry] of this.entries) this.destroy(entityId, entry);
    this.entries.clear();
    this.scene?.remove(this.group);
  }

  private create(entityId: number): LabelEntry {
    const canvas = this.canvasFactory();
    canvas.width = SHIP_LABEL_CARD_W * CARD_RASTER;
    canvas.height = SHIP_LABEL_CARD_H * CARD_RASTER;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Small, screen-constant art: linear filtering, no mip chain (the card is
    // never minified far enough for mips to matter, and they cost a bake).
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      // The card is an overlay: it must never be swallowed by the hull it
      // names (or by the sea plane) — the 2D pass draws labels above hulls.
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.layers.set(EXPORT_LABEL_LAYER);
    sprite.renderOrder = LABEL_RENDER_ORDER;
    sprite.visible = false;
    this.group.add(sprite);
    const entry: LabelEntry = {
      canvas,
      texture,
      material,
      sprite,
      hpFrac: Number.NaN,
      signature: "",
      lastPaint: -Infinity,
    };
    this.entries.set(entityId, entry);
    return entry;
  }

  private destroy(entityId: number, entry: LabelEntry): void {
    this.group.remove(entry.sprite);
    entry.material.dispose();
    entry.texture.dispose();
    this.entries.delete(entityId);
  }
}
