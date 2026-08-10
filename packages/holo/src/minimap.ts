/**
 * HoloMinimap — pure canvas minimap renderer, faithful to the app's
 * holographic replay minimap: game minimap art (water+land composite) with
 * role-coloured ship dots, dead = grey, optional trails, world→minimap
 * projection with the z-flip the game uses.
 */
import type { HoloBounds, HoloMinimapArt, HoloShip, HoloCap } from "./types";
import { holoShipIconImage } from "./icons";

export interface MinimapDrawOpts {
  ctx: CanvasRenderingContext2D;
  size: number; // square canvas logical size
  art: HoloMinimapArt | null;
  ships: HoloShip[];
  /** Capture zones: letter rings, coloured by current owner. */
  caps?: HoloCap[];
  showTrails?: boolean;
  dpr?: number;
}

const ROLE_COLOR: Record<string, string> = {
  self: "#f5b85c",
  ally: "#38bdf8",
  enemy: "#f87171",
};

const CAP_OWNER_COLOR: Record<HoloCap["owner"], string> = {
  ally: "#4ade80",
  enemy: "#f87171",
  neutral: "rgba(220,228,240,0.9)",
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
  const { ctx, size, art, ships, caps = [], showTrails = true, dpr = 1 } = opts;
  const S = size;
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

  // ── capture zones — letter rings (same projection as ships) ──
  if (art && caps.length) {
    const b = art.activeBounds ?? art.bounds;
    ctx.font = "700 9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const c of caps) {
      const p = project(c.x, c.z, b);
      const px = p.u * S;
      const py = p.v * S;
      const col = CAP_OWNER_COLOR[c.owner] ?? CAP_OWNER_COLOR.neutral;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.85;
      ctx.fillText(c.letter, px, py + 0.5);
      ctx.globalAlpha = 1;
    }
  }

  // ── ships — the game's own HUD class icons (dots as fallback), rotated
  //    to each ship's heading like the in-game minimap ──
  if (art) {
    const b = art.activeBounds ?? art.bounds;
    for (const s of ships) {
      const p = project(s.x, s.z, b);
      const px = p.u * S;
      const py = p.v * S;
      const variant = s.dead ? "sunk" : s.role === "enemy" ? "enemy" : "ally";
      const img = holoShipIconImage(s.shipType, variant);
      if (img && img.complete && img.naturalWidth > 0) {
        const sz = s.dead ? 8 : 10;
        // The icon art points up (north); rotate to the motion heading.
        const rot = s.heading ?? 0;
        if (!s.dead && rot !== 0) {
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(rot);
          ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz);
          ctx.restore();
        } else {
          ctx.drawImage(img, px - sz / 2, py - sz / 2, sz, sz);
        }
        continue;
      }
      const color = s.dead ? "#5a6678" : (ROLE_COLOR[s.role] ?? "#94a6c2");
      ctx.beginPath();
      ctx.arc(px, py, s.dead ? 1.8 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (!s.dead) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
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
