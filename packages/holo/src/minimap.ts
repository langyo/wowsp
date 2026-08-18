/**
 * HoloMinimap — pure canvas minimap renderer, faithful to the app's
 * holographic replay minimap: game minimap art (water+land composite)
 * with role-coloured ship glyphs, dead = grey, optional trails,
 * world→minimap projection with the z-flip the game uses.
 *
 * Ships render as VECTOR class glyphs traced from the game's own HUD
 * bitmaps (see shipGlyph.ts) — crisp at any scale/rotation, unlike the
 * raster PNGs which alias when rotated. Capture zones draw their owner
 * ring + letter, with an amber "xx s" countdown under the letter while
 * a capture is in progress (same contract as the scorebar chips).
 */
import type { HoloBounds, HoloMinimapArt, HoloShip, HoloCap } from "./types";
import { drawShipGlyph } from "./shipGlyph";

export interface MinimapDrawOpts {
  ctx: CanvasRenderingContext2D;
  size: number; // square canvas logical size
  art: HoloMinimapArt | null;
  ships: HoloShip[];
  /** Capture zones: letter rings, coloured by current owner. */
  caps?: HoloCap[];
  /** Camera frustum ground quad (world coords) — the app thumb draws it. */
  frustum?: { x: number; z: number }[];
  showTrails?: boolean;
  dpr?: number;
}

const ROLE_COLOR: Record<string, string> = {
  self: "#f5b85c",
  ally: "#38bdf8",
  enemy: "#f87171",
};

/** Sunk hulls keep a readable grey (matches the app's minimap). */
const DEAD_COLOR = "#8a97a5";

const CAP_OWNER_COLOR: Record<HoloCap["owner"], string> = {
  ally: "rgba(74, 222, 128, 0.85)",
  enemy: "rgba(248, 113, 113, 0.85)",
  neutral: "rgba(255, 255, 255, 0.55)",
};

function project(
  x: number, z: number,
  b: HoloBounds,
): { u: number; v: number } {
  const w = b.maxX - b.minX;
  const h = b.maxZ - b.minZ;
  // The game's minimap flips z; u goes left→right, v top→bottom.
  const u = (x - b.minX) / w;
  const v = 1 - (z - b.minZ) / h;
  return { u, v };
}

export function drawHoloMinimap(opts: MinimapDrawOpts): void {
  const { ctx, size, art, ships, caps = [], frustum, showTrails = false, dpr = 1 } = opts;
  const S = size;
  // Scale factor from the app's 160-unit thumb to this canvas: glyph /
  // ring / font sizes below are expressed in app units and stay legible
  // at any canvas size.
  const k = S / 160;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, S, S);

  // ── base art ──
  if (art) {
    const b = art.activeBounds ?? art.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxZ - b.minZ;
    const scale = Math.min(S / w, S / h);
    const offX = (S - w * scale) / 2;
    const offY = (S - h * scale) / 2;
    const img = artImage;
    if (img) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(img, offX, offY, w * scale, h * scale);
      ctx.globalAlpha = 1;
    }
    // subtle vignette frame
    ctx.strokeStyle = "rgba(148,180,230,0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, S - 1, S - 1);
  }

  // ── trails ──
  if (showTrails && art) {
    const b = art.activeBounds ?? art.bounds;
    ctx.lineWidth = 1;
    for (const s of ships) {
      if (s.dead || !s.trail || s.trail.length < 2) continue;
      const color = ROLE_COLOR[s.role] ?? "#94a6c2";
      ctx.strokeStyle = color + "55";
      ctx.beginPath();
      for (let i = 0; i < s.trail.length; i++) {
        const p = project(s.trail[i].x, s.trail[i].z, b);
        const px = p.u * S;
        const py = p.v * S;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  // ── capture zones — owner ring + letter, amber ETA countdown while
  //    a capture runs (mirrors the app's minimap + scorebar chips) ──
  if (art && caps.length) {
    const b = art.activeBounds ?? art.bounds;
    // Ring size from the zone REAL radius: on a 160px thumb of a 30 km
    // map even 140 m is sub-pixel, so use the app relative sqrt scale —
    // bigger radius → visibly bigger ring (clamped like the app thumb).
    const ringPx = (radius?: number) =>
      Math.max(4, Math.min(22, 3 + Math.sqrt(Math.max(radius ?? 300, 25) / 20) * 5)) * k;
    for (const c of caps) {
      const ringR = ringPx(c.radius);
      const p = project(c.x, c.z, b);
      const px = p.u * S;
      const py = p.v * S;
      const col = CAP_OWNER_COLOR[c.owner] ?? CAP_OWNER_COLOR.neutral;
      ctx.beginPath();
      ctx.arc(px, py, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2 * k;
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.font = "bold " + Math.round(8 * k) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(c.letter, px, py + 0.5);
      // Capturing countdown under the letter: "xx s" to complete.
      const eta = c.etaSeconds;
      if (eta != null && eta > 0) {
        ctx.fillStyle = "rgba(251,191,36,0.95)";
        ctx.font = "bold " + Math.round(7 * k) + "px sans-serif";
        ctx.fillText(Math.ceil(eta) + " s", px, py + ringR + 4.5 * k);
      }
    }
  }

  // ── ships — VECTOR class glyphs (traced from the game's HUD art),
  //    rotated to each ship's heading like the in-game minimap ──
  if (art) {
    const b = art.activeBounds ?? art.bounds;
    for (const s of ships) {
      const p = project(s.x, s.z, b);
      const px = p.u * S;
      const py = p.v * S;
      const color = s.dead ? DEAD_COLOR : (ROLE_COLOR[s.role] ?? "#94a6c2");
      // The glyph's bow points +x (east) at rest; the rotation value is
      // the RECORDED hull yaw when available (stable per frame — the
      // motion-derived heading is noisy for slow/stationary ships),
      // clockwise from north — subtract 90° so 0 faces up.
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((s.yaw ?? s.heading ?? 0) - Math.PI / 2);
      drawShipGlyph(ctx, s.shipType, 0, 0, (s.dead ? 11 : 13) * k, color);
      ctx.restore();
    }
    // camera frustum (world coords) — the app thumb draws the view cone
    if (frustum && frustum.length === 4) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const p0 = project(frustum[0].x, frustum[0].z, art.activeBounds ?? art.bounds);
      ctx.moveTo(p0.u * S, p0.v * S);
      for (let i = 1; i < 4; i++) {
        const p = project(frustum[i].x, frustum[i].z, art.activeBounds ?? art.bounds);
        ctx.lineTo(p.u * S, p.v * S);
      }
      ctx.closePath();
      ctx.stroke();
    }
  } else {
    // No art: dark water fallback + dots still projected onto data bounds.
    ctx.fillStyle = "rgba(6,20,32,0.85)";
    ctx.fillRect(0, 0, S, S);
    const fallback: HoloBounds = { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 };
    for (const s of ships) {
      const p = project(s.x, s.z, fallback);
      ctx.beginPath();
      ctx.arc(p.u * S, p.v * S, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = s.dead ? "#5a6678" : (ROLE_COLOR[s.role] ?? "#94a6c2");
      ctx.fill();
    }
  }

  ctx.restore();
}

/** The loaded art image lives module-level (set once per map). */
let artImage: HTMLImageElement | null = null;

export function setMinimapArtImage(img: HTMLImageElement | null): void {
  artImage = img;
}