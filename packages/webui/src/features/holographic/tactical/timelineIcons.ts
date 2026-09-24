/**
 * Canvas icon painters for the tactical timeline's ship-action markers.
 * Pure (ctx, x, y, …) functions in the timeline's own pixel space; the icon
 * language follows the editor convention: green wave = accelerate, red wave =
 * decelerate, black wave = stop, dart = shell salvo (HE/AP/SAP chip), slim
 * fish = torpedo, plane = air action (green take-off / red attack) with the
 * payload sub-icon bottom-right, attack-squadron ribbon top-right, fighter
 * crosshair bottom-right.
 */

export const TL_COLORS = {
  up: "#4ade80",
  down: "#f4506a",
  stop: "#0f1220",
  stopEdge: "#a8b3c7",
  he: "#ffcc33",
  ap: "#c8d0e0",
  sap: "#9aa0a8",
  planeGo: "#4ade80",
  planeHit: "#f4506a",
  accent: "#00c3ff",
  step: "#ffc247",
  chip: "rgba(5, 8, 15, 0.78)",
} as const;

export const ICON_PX = 15;
export const ICON_SUB = 7;

function wave(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, flat: boolean): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  for (const dy of [-2, 2]) {
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const px = x - 5 + i * (10 / 8);
      const amp = flat ? 0.6 : 2;
      const py = y + dy + (i % 2 === 0 ? -amp : amp) * (flat ? 0.5 : 1) * 0.9;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Speed-up: green swell. */
export function drawWaveUp(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  wave(ctx, x, y, TL_COLORS.up, false);
}
/** Slow-down: red ebb. */
export function drawWaveDown(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  wave(ctx, x, y, TL_COLORS.down, false);
}
/** All stop: black breaker with a light edge so it reads on dark chrome. */
export function drawWaveStop(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  wave(ctx, x, y, TL_COLORS.stopEdge, true);
  wave(ctx, x, y, TL_COLORS.stop, true);
}

function chip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, fs = 6): void {
  ctx.save();
  ctx.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = TL_COLORS.chip;
  ctx.beginPath();
  ctx.roundRect(x - w / 2 - 2, y - fs * 0.85, w + 4, fs * 1.7, 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

/** Shell salvo: a dart with the ammo family lettered underneath. */
export function drawShell(ctx: CanvasRenderingContext2D, x: number, y: number, ammo: string): void {
  const color = ammo === "HE" ? TL_COLORS.he : ammo === "AP" ? TL_COLORS.ap : ammo === "SAP" ? TL_COLORS.sap : "#ffe08a";
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  // dart: nose up-right
  ctx.moveTo(x + 4, y - 4);
  ctx.lineTo(x - 3, y + 1);
  ctx.lineTo(x - 1, y + 3);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 2, y + 3);
  ctx.lineTo(x - 5, y + 6);
  ctx.stroke();
  ctx.restore();
  chip(ctx, x + 4, y + 6, ammo.slice(0, 3), color, 5.5);
}

/** Torpedo: slim fish with a tail screw. */
export function drawTorpedo(ctx: CanvasRenderingContext2D, x: number, y: number, color = "#9fd8ff"): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.ellipse(x, y, 5.4, 1.9, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 4.6, y + 2.4);
  ctx.lineTo(x - 6.6, y + 4.6);
  ctx.moveTo(x - 4.6, y + 2.4);
  ctx.lineTo(x - 2.6, y + 4.2);
  ctx.stroke();
  ctx.restore();
}

function planeSilhouette(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, hollow: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  const s = 0.55;
  const path = (): void => {
    ctx.beginPath();
    ctx.moveTo(10 * s, 0);
    ctx.lineTo(4 * s, 1.2 * s);
    ctx.lineTo(0.5 * s, 8 * s);
    ctx.lineTo(-1.4 * s, 8 * s);
    ctx.lineTo(-1 * s, 1.2 * s);
    ctx.lineTo(-7 * s, 1 * s);
    ctx.lineTo(-9 * s, 3.6 * s);
    ctx.lineTo(-10.4 * s, 3.6 * s);
    ctx.lineTo(-9.4 * s, 0);
    ctx.lineTo(-10.4 * s, -3.6 * s);
    ctx.lineTo(-9 * s, -3.6 * s);
    ctx.lineTo(-7 * s, -1 * s);
    ctx.lineTo(-1 * s, -1.2 * s);
    ctx.lineTo(-1.4 * s, -8 * s);
    ctx.lineTo(0.5 * s, -8 * s);
    ctx.lineTo(4 * s, -1.2 * s);
    ctx.lineTo(10 * s, 0);
    ctx.closePath();
  };
  if (hollow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    path();
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    path();
    ctx.fill();
  }
  ctx.restore();
}

export interface PlaneIconOpts {
  /** attack runs render red; take-offs green. */
  attack: boolean;
  role?: string;
  dropKind?: "torpedo" | "bomb";
  ammo?: string;
}

/** Plane action marker: silhouette + role/payload sub-icon. */
export function drawPlane(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  opts: PlaneIconOpts,
): void {
  const color = opts.attack ? TL_COLORS.planeHit : TL_COLORS.planeGo;
  planeSilhouette(ctx, x, y, color, false);
  const role = opts.role ?? "";
  if (opts.dropKind === "torpedo" || (!opts.attack && role === "torpedo")) {
    drawTorpedo(ctx, x + 5, y + 5, color);
    return;
  }
  if (role === "attack") {
    // 战术机: green diagonal ribbon top-right
    ctx.save();
    ctx.strokeStyle = TL_COLORS.up;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 2, y - 7.5);
    ctx.lineTo(x + 7.5, y - 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (role === "fighter") {
    // fighter: targeting crosshair bottom-right
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    const cx = x + 5;
    const cy = y + 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.moveTo(cx - 4.4, cy);
    ctx.lineTo(cx + 4.4, cy);
    ctx.moveTo(cx, cy - 4.4);
    ctx.lineTo(cx, cy + 4.4);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (opts.attack && opts.dropKind === "bomb") {
    // bomb: filled capsule in the ammo family colour
    const c = opts.ammo === "HE" ? TL_COLORS.he : opts.ammo === "AP" ? TL_COLORS.ap : opts.ammo === "SAP" ? TL_COLORS.sap : TL_COLORS.he;
    ctx.save();
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x + 5, y + 5, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x + 4.2, y + 0.6, 1.6, 2.4);
    ctx.restore();
  }
}

/** User-placed virtual ship: filled (standalone) or hollow (replay) hull. */
export function drawUserShip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  solid: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  const s = 0.5;
  const path = (): void => {
    ctx.beginPath();
    ctx.moveTo(7 * s, 0);
    ctx.lineTo(-5 * s, 4.2 * s);
    ctx.lineTo(-3 * s, 0);
    ctx.lineTo(-5 * s, -4.2 * s);
    ctx.closePath();
  };
  if (solid) {
    ctx.fillStyle = color;
    path();
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    path();
    ctx.stroke();
  }
  ctx.restore();
}

/** Pinned real-ship path marker: ring + centre dot. */
export function drawUserPin(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(x, y, 4.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Presentation-step pennant. */
export function drawStepFlag(ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean): void {
  ctx.save();
  ctx.strokeStyle = active ? "#ffe08a" : TL_COLORS.step;
  ctx.fillStyle = active ? "#ffe08a" : TL_COLORS.step;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y + 6);
  ctx.lineTo(x, y - 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x + 7, y - 2.5);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── Plan tracks: keyframes and tweens ──────────────────────────────────────
// The editor convention (After Effects / Flash): a keyframe is a shape on the
// property row, and the span between two interpolated keyframes is a bar with
// an arrowhead — "the value travels this way between these seconds".

export const PLAN_TRACK_COLORS = {
  headerBg: "rgba(148, 163, 184, 0.10)",
  headerText: "rgba(203, 213, 225, 0.85)",
  tweenBar: 0.32,
} as const;

/** One plan keyframe. `move` = diamond (position keyframe), `attack` = solid
 *  down-triangle, `spot` = ring — readable at 8 px and distinguishable in
 *  grayscale, so colour never has to carry the meaning alone. */
export function drawPlanKeyframe(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  kind: "move" | "attack" | "spot",
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  if (kind === "move") {
    ctx.beginPath();
    ctx.moveTo(0, -4.6);
    ctx.lineTo(4.6, 0);
    ctx.lineTo(0, 4.6);
    ctx.lineTo(-4.6, 0);
    ctx.closePath();
    ctx.fill();
  } else if (kind === "attack") {
    ctx.beginPath();
    ctx.moveTo(-4.4, -4);
    ctx.lineTo(4.4, -4);
    ctx.lineTo(0, 4.4);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, 3.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Tween span: a translucent bar from the source keyframe to the target with
 *  an arrowhead landing on the target (and a tail notch on the source), plus
 *  the interpolated position of the playhead when it is inside the span. */
export function drawPlanTween(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  color: string,
  head: number | null,
): void {
  const dir = x1 >= x0 ? 1 : -1;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  ctx.save();
  ctx.globalAlpha = PLAN_TRACK_COLORS.tweenBar;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(left, y - 3.5, Math.max(2, right - left), 7, 3.5);
  ctx.fill();
  ctx.globalAlpha = 1;
  const size = 5.4;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x1 - dir * size, y - size * 0.72);
  ctx.lineTo(x1 - dir * size, y + size * 0.72);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x0 + dir * size * 0.9, y - size * 0.6);
  ctx.lineTo(x0 + dir * size * 0.9, y + size * 0.6);
  ctx.closePath();
  ctx.fill();
  if (head != null) {
    const hx = Math.max(left, Math.min(right, head));
    ctx.strokeStyle = "#00c3ff";
    ctx.fillStyle = "rgba(5, 8, 15, 0.9)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(hx, y, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Collapsed-row sparkline: every keyframe as a tick over a hairline span —
 *  enough to see where a unit's work sits without expanding the row. */
export function drawPlanTicks(
  ctx: CanvasRenderingContext2D,
  xs: number[],
  y: number,
  color: string,
): void {
  if (xs.length === 0) return;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = color;
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  if (right - left > 1) ctx.fillRect(left, y - 0.5, right - left, 1);
  for (const x of xs) ctx.fillRect(x - 0.5, y - 3.5, 1.6, 7);
  ctx.restore();
}
