/**
 * The 2D minimap painter, extracted verbatim from HolographicMap.tsx:
 * the small battle thumbnail AND the enlarged pan/zoom overlay canvas,
 * sharing the world-rect projection helpers in mapInternals.ts. Pure
 * canvas-2D drawing over the shared map context — no state of its own.
 */
import { drawShipGlyph } from "./shipGlyph";
import { planeIcon } from "./planeIcons";
import { sampleAt } from "./trajectoryMath";
import { TEAM_COLOR, type TeamRole } from "./teamColors";
import { frustumCorners } from "./sceneUtils";
import { gridEdgeLabels, MAP_GRID_COLUMNS } from "./tactical/mapGrid";
import { TACTICAL_SIZE } from "./tactical/render";
import type { MapBounds } from "./modelLoader";
import type { SquadronPlane } from "@/api";
import {
  computeFullMapBounds,
  computeViewBounds,
  resolveRoleQuick,
  type MapInternals,
} from "./mapInternals";

/** Logical (CSS-px) edge length of the small minimap canvas. All thumb
 *  drawing happens in these units; the backing store is scaled by dpr. */
export const MINIMAP_SIZE = 160;

export function drawMinimap(ctx: MapInternals) {
  const full: MapBounds | null = computeFullMapBounds(ctx);
  if (!full) return;
  // Crop to the active battle area when the match plays out in a small
  // region of the map (brawls/events with a restricted border): the
  // in-game minimap shows only that region, and a full-map view would
  // compress every ship dot into one corner. `bounds` already holds the
  // active area in scene coords (z mirrored back to world here).
  let db = full;
  if (ctx.minimapBounds && ctx.bounds) {
    const active: MapBounds = {
      minX: ctx.bounds.minX,
      maxX: ctx.bounds.maxX,
      minZ: -ctx.bounds.maxZ,
      maxZ: -ctx.bounds.minZ,
    };
    const mapArea = (full.maxX - full.minX) * (full.maxZ - full.minZ);
    const activeArea =
      (active.maxX - active.minX) * (active.maxZ - active.minZ);
    // Crop whenever the active area is smaller than the full map —
    // mode-restricted matches (duels/brawls on one side of a ridge)
    // must not render as full-map thumbnails.
    if (activeArea > 0 && activeArea < 0.95 * mapArea) {
      db = {
        minX: Math.max(active.minX, full.minX),
        maxX: Math.min(active.maxX, full.maxX),
        minZ: Math.max(active.minZ, full.minZ),
        maxZ: Math.min(active.maxZ, full.maxZ),
      };
    }
  }
  const cvs = ctx.minimapCanvas.value;
  if (!cvs) return;
  if (!ctx._mmCtx) ctx._mmCtx = cvs.getContext("2d");
  const c2d = ctx._mmCtx!;
  // HiDPI backing store EXACTLY matching the displayed element size
  // (rect × devicePixelRatio) — a 1:1 buffer↔element mapping avoids the
  // browser resampling the canvas and softening vector edges. The base
  // transform below keeps every drawing call in 160-unit logical coords.
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const dispMm = Math.round(Math.max(1, cvs.getBoundingClientRect().width));
  const px = Math.round(dispMm * dpr);
  if (cvs.width !== px) cvs.width = px;
  if (cvs.height !== px) cvs.height = px;
  c2d.setTransform(px / MINIMAP_SIZE, 0, 0, px / MINIMAP_SIZE, 0, 0);
  const w = MINIMAP_SIZE;
  const h = MINIMAP_SIZE;

  const dbW = db.maxX - db.minX;
  const dbH = db.maxZ - db.minZ;

  // Markers/camera live in three.js space (z = -worldZ); convert back to
  // world coordinates for the map projection. North (+worldZ) is up on
  // the game's minimap (world_to_minimap flips z).
  function wx(x: number) { return ((x - db.minX) / (dbW || 1)) * w; }
  function wz(zScene: number) { return ((db.maxZ + zScene) / (dbH || 1)) * h; }

  c2d.clearRect(0, 0, w, h);
  // The minimap art NEVER changes with the theme: it is the game's own
  // map bitmap, shown as-is in both modes (like a photo). Only the
  // surrounding HUD chrome (frame, scrims, panels) follows the theme.
  if (ctx.minimapImage) {
    if (db === full) {
      c2d.drawImage(ctx.minimapImage, 0, 0, w, h);
    } else {
      // Cropped: draw only the active-area slice of the art, scaled up.
      const img = ctx.minimapImage;
      const fullW = full.maxX - full.minX;
      const fullH = full.maxZ - full.minZ;
      const sx = ((db.minX - full.minX) / (fullW || 1)) * img.width;
      const sw = ((db.maxX - db.minX) / (fullW || 1)) * img.width;
      const sy = ((full.maxZ - db.maxZ) / (fullH || 1)) * img.height;
      const sh = ((db.maxZ - db.minZ) / (fullH || 1)) * img.height;
      c2d.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    }
  } else {
    c2d.fillStyle = "rgba(5, 8, 15, 0.85)";
    c2d.fillRect(0, 0, w, h);
  }
  c2d.strokeStyle = "rgba(0, 170, 255, 0.3)";
  c2d.lineWidth = 1;
  c2d.strokeRect(0.5, 0.5, w - 1, h - 1);

  // Capture zones: rings at the zone's TRUE world radius, projected
  // through the same rect as the dots (a 100 m ring on a 1400 m map
  // spans ~1/14 of the thumb). Floored so a missing radius still shows
  // a visible marker — tinted by owner, letter inside.
  const capRadiusPx = (radius: number) =>
    Math.max(3, (radius / (dbW || 1)) * w);
  ctx.capZones.value.forEach((z, i) => {
    const cx = wx(z.kind!.initialX);
    const cz = wz(-z.kind!.initialZ);
    const owner = ctx.capDisplay.value[i]?.owner ?? 0;
    const radiusPx = capRadiusPx(z.kind?.radius ?? 0);
    c2d.strokeStyle =
      owner === 1 ? "rgba(74, 222, 128, 0.8)" : owner === 2 ? "rgba(204, 51, 51, 0.8)" : "rgba(255, 255, 255, 0.5)";
    c2d.lineWidth = 1.2;
    c2d.beginPath();
    c2d.arc(cx, cz, radiusPx, 0, Math.PI * 2);
    c2d.stroke();
    c2d.fillStyle = c2d.strokeStyle;
    c2d.font = "bold 8px sans-serif";
    c2d.textAlign = "center";
    c2d.textBaseline = "middle";
    c2d.fillText(String.fromCharCode(65 + i), cx, cz + 0.5);
    // Capturing countdown under the letter: "xx s" to complete.
    const eta = ctx.capDisplay.value[i]?.etaSeconds;
    if (eta != null && eta > 0) {
      c2d.fillStyle = "rgba(251,191,36,0.95)";
      c2d.font = "bold 7px sans-serif";
      c2d.fillText(Math.ceil(eta) + " s", cx, cz + radiusPx + 5);
    }
  });

  // Ship markers: the game's own HUD class icons, tinted by team via the
  // variant (ally/enemy/sunk). Falls back to a plain dot until the icon
  // image decodes.
  const t = ctx.current.value;
  for (const m of ctx.shipMarkers) {
    const role = m.userData.role as TeamRole | undefined;
    const firstT = m.userData.firstT as number | undefined;
    // Unobserved ships: enemies are NOT shown at all; allies show a
    // GREEN outline glyph (class engraving kept via the polygon gaps)
    // at their spawn — white stays reserved for the recorder.
    if (t < (firstT ?? Infinity)) {
      if (role === "enemy") continue;
      const gx = wx(m.userData.spawnX as number);
      const gz = wz(-(m.userData.spawnZ as number));
      c2d.save();
      c2d.translate(gx, gz);
      c2d.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
      drawShipGlyph(c2d, m.userData.type as string | undefined, 0, 0, 14, TEAM_COLOR.ally, {
        outline: true,
      });
      c2d.restore();
      continue;
    }
    const dead =
      (m.userData.deathTime as number | null) != null &&
      t >= (m.userData.deathTime as number);
    const cx = wx(m.position.x);
    const cz = wz(m.position.z);
    // Solid vector class glyph (traced from the game's HUD bitmap —
    // original shape, crisp at any scale/rotation), rotated to the
    // ship's heading: rotation 0 points the glyph UP (north), yaw is
    // clockwise from north; the glyph's pointy end faces RIGHT (+x) at
    // rest, so subtract 90° for 0° = north (matching the 3D marker's
    // rotation.y = PI - yaw on the mirrored frame).
    const color = dead ? 0x8a97a5 : role ? TEAM_COLOR[role] : 0x9aa7b5;
    c2d.save();
    c2d.translate(cx, cz);
    c2d.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
    drawShipGlyph(c2d, m.userData.type as string | undefined, 0, 0, dead ? 11 : 13, color);
    c2d.restore();
  }

  // Smoke screens (entityType 4): white start/end rings + remaining
  // seconds, fading out after each puff's lifetime (90s past its last
  // update, or the recorded leave time).
  {
    c2d.strokeStyle = "rgba(255,255,255,0.85)";
    c2d.fillStyle = "rgba(255,255,255,0.95)";
    c2d.lineWidth = 1;
    for (const cl of ctx.smokeClusters) {
      if (t < cl.t0 || t > cl.endT) continue;
      let cur = t;
      if (t > cl.lastT) {
        const span = Math.max(1, cl.lastT - cl.t0);
        cur = cl.t0 + ((t - cl.lastT) * span) / Math.max(1, cl.endT - cl.lastT);
        if (cur > cl.lastT) cur = cl.lastT;
      }
      const pStart = sampleAt(cl.traj, cur);
      if (!pStart) continue;
      const pEnd = sampleAt(cl.traj, cl.lastT);
      const drift =
        pEnd != null ? Math.hypot(pStart.x - pEnd.x, pStart.z - pEnd.z) : 0;
      const showBoth = pEnd != null && drift >= 1000;
      c2d.beginPath();
      c2d.arc(wx(pStart.x), wz(-pStart.z), 3, 0, Math.PI * 2);
      c2d.stroke();
      if (showBoth && pEnd) {
        c2d.beginPath();
        c2d.arc(wx(pEnd.x), wz(-pEnd.z), 3, 0, Math.PI * 2);
        c2d.stroke();
      }
      c2d.font = "bold 8px sans-serif";
      c2d.textAlign = "center";
      c2d.textBaseline = "bottom";
      c2d.fillText(`${Math.ceil(cl.endT - t)}s`, wx(pStart.x), wz(-pStart.z) - 4);
    }
  }
  // Aircraft — one in-game type icon per FORMATION (squadron centre),
  // not per plane: a full 8-plane group reads as a single moving marker.
  {
    const drawn = new Set<number>();
    for (const trail of ctx.planeTrails) {
      const planeId = Math.floor(trail.id / 16);
      if (trail.id % 16 !== 0 || drawn.has(planeId)) continue;
      const samples = trail.samples;
      let s: SquadronPlane | null = null;
      for (const sp of samples) {
        if (sp.time > t) break;
        s = sp;
      }
      if (s == null) continue;
      if (t < samples[0].time || t > samples[samples.length - 1].time + 5) continue;
      drawn.add(planeId);
      const icon = planeIcon(ctx.planeTypesById.get(trail.id) ?? "attack");
      if (icon && icon.complete && icon.naturalWidth > 0) {
        const sz = 10;
        c2d.save();
        c2d.translate(wx(s.x), wz(-s.z));
        // Aircraft icons stay upright on the minimap (no rotation).
        c2d.drawImage(icon, -sz / 2, -sz / 2, sz, sz);
        c2d.restore();
      } else {
        c2d.fillStyle = "rgba(120, 210, 255, 0.95)";
        c2d.beginPath();
        c2d.arc(wx(s.x), wz(-s.z), 1.4, 0, Math.PI * 2);
        c2d.fill();
      }
    }
  }

  // Camera frustum — hidden while the enlarged 2D view covers the
  // scene: the 3D camera is not what the user is looking at (and the
  // thumb gets burned into exports, where a stale frustum is noise).
  const cam = !ctx.minimapZoom.value ? ctx.api.value?.camera : null;
  if (cam) {
    const corners = frustumCorners(cam);
    c2d.strokeStyle = "rgba(255, 255, 255, 0.45)";
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(wx(corners[0].x), wz(corners[0].z));
    for (let i = 1; i < 4; i++) c2d.lineTo(wx(corners[i].x), wz(corners[i].z));
    c2d.closePath();
    c2d.stroke();
  }

  // Enlarged 2D view window, boxed on the thumb: the exporters burn
  // this canvas into the corner of recordings/screenshots, so the chip
  // must say where the zoomed view is looking. The window is clamped to
  // the FULL map but the thumb may show a cropped active area (db), so
  // the box is intersected with the canvas — panned outside db it just
  // clips instead of vanishing off-thumb.
  if (ctx.minimapZoom.value) {
    const vb = computeViewBounds(ctx, full);
    const x0 = Math.max(0, wx(vb.minX));
    const y0 = Math.max(0, wz(-vb.maxZ));
    const x1 = Math.min(w, wx(vb.maxX));
    const y1 = Math.min(h, wz(-vb.minZ));
    if (x1 - x0 > 1 && y1 - y0 > 1) {
      c2d.strokeStyle = "rgba(0, 195, 255, 0.95)";
      c2d.lineWidth = 1.5;
      c2d.setLineDash([4, 3]);
      c2d.strokeRect(x0, y0, x1 - x0, y1 - y0);
      c2d.setLineDash([]);
    }
  }

  // Enlarged minimap overlay: full-map view with ship trails + glyphs.
  const zc = ctx.zoomCanvas.value;
  if (zc) {
    const zctx = zc.getContext("2d");
    if (zctx) {
      // HiDPI backing store EXACTLY matching the displayed element
      // size: rect × devicePixelRatio device px. Matching 1:1 avoids the
      // browser's own box resampling of the canvas (a 760·dpr buffer on
      // a differently-sized element reintroduced ~3px edge softening at
      // 150% scaling). All zwx/zwz math stays in 760 logical units.
      const dprZ = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const rectZ = zc.getBoundingClientRect();
      const dispZ = Math.round(Math.max(1, rectZ.width));
      const pxZ = Math.round(dispZ * dprZ);
      if (zc.width !== pxZ) { zc.width = pxZ; zc.height = pxZ; }
      zctx.setTransform(pxZ / TACTICAL_SIZE, 0, 0, pxZ / TACTICAL_SIZE, 0, 0);
      const zw = TACTICAL_SIZE;
      // Pan/zoom viewport: everything below projects through the view
      // window (a sub-rect of the full map with the same aspect), so
      // zooming magnifies terrain while ship glyphs/text keep their
      // logical sizes — the tactical layer projects through the SAME
      // window (computeTacticalBounds).
      const vfull = computeViewBounds(ctx, full);
      // The 2D map art NEVER changes with the theme (the game's own
      // bitmap, shown as-is in both modes); only the overlay chrome —
      // scrim, head pill, frame — follows the app theme.
      zctx.clearRect(0, 0, zw, zw);
      if (ctx.minimapImage) {
        zctx.imageSmoothingEnabled = true;
        // Crop the art to the view window (source rect in image px).
        const img = ctx.minimapImage;
        const fx = ((vfull.minX - full.minX) / (full.maxX - full.minX || 1)) * img.width;
        const fw = ((vfull.maxX - vfull.minX) / (full.maxX - full.minX || 1)) * img.width;
        const fy = ((full.maxZ - vfull.maxZ) / (full.maxZ - full.minZ || 1)) * img.height;
        const fh = ((vfull.maxZ - vfull.minZ) / (full.maxZ - full.minZ || 1)) * img.height;
        zctx.drawImage(img, fx, fy, fw, fh, 0, 0, zw, zw);
      } else {
        zctx.fillStyle = "rgba(5, 8, 15, 0.9)";
        zctx.fillRect(0, 0, zw, zw);
      }
      const zwx = (x: number) => ((x - vfull.minX) / (vfull.maxX - vfull.minX || 1)) * zw;
      const zwz = (zScene: number) => ((vfull.maxZ + zScene) / (vfull.maxZ - vfull.minZ || 1)) * zw;
      // The game's A–J / 1–10 grid, world-anchored (full map rect, so it
      // stays put under pan/zoom).
      if (ctx.minimapShowGrid.value) {
        zctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        zctx.lineWidth = 1;
        zctx.beginPath();
        for (let i = 1; i < MAP_GRID_COLUMNS; i++) {
          const x = zwx(full.minX + ((full.maxX - full.minX) * i) / MAP_GRID_COLUMNS);
          zctx.moveTo(x, 0);
          zctx.lineTo(x, zw);
        }
        for (let j = 1; j < MAP_GRID_COLUMNS; j++) {
          const y = zwz(-(full.minZ + ((full.maxZ - full.minZ) * j) / MAP_GRID_COLUMNS));
          zctx.moveTo(0, y);
          zctx.lineTo(zw, y);
        }
        zctx.stroke();
      }
      // Capture rings + letters (same rendering as the small thumb, at
      // the enlarged scale — true world radius through the view window).
      const zcapR = (radius: number) =>
        Math.max(6, (radius / (vfull.maxX - vfull.minX || 1)) * zw);
      ctx.capZones.value.forEach((z, i) => {
        const cx = zwx(z.kind!.initialX);
        const cz = zwz(-z.kind!.initialZ);
        const owner = ctx.capDisplay.value[i]?.owner ?? 0;
        const rPx = zcapR(z.kind?.radius ?? 0);
        zctx.strokeStyle =
          owner === 1 ? "rgba(74, 222, 128, 0.85)" : owner === 2 ? "rgba(204, 51, 51, 0.85)" : "rgba(255, 255, 255, 0.55)";
        zctx.lineWidth = 2;
        zctx.beginPath();
        zctx.arc(cx, cz, rPx, 0, Math.PI * 2);
        zctx.stroke();
        zctx.save();
        zctx.translate(cx, cz);
        zctx.fillStyle = zctx.strokeStyle;
        zctx.font = "bold 16px sans-serif";
        zctx.textAlign = "center";
        zctx.textBaseline = "middle";
        zctx.fillText(String.fromCharCode(65 + i), 0, 0.5);
        // Capturing countdown under the letter: "xx s" to complete.
        const eta = ctx.capDisplay.value[i]?.etaSeconds;
        if (eta != null && eta > 0) {
          zctx.fillStyle = "rgba(251,191,36,0.95)";
          zctx.font = "bold 12px sans-serif";
          zctx.fillText(Math.ceil(eta) + " s", 0, rPx + 9);
        }
        zctx.restore();
      });
      if (ctx.minimapShowTrails.value) {
        for (const tr of ctx.props.trajectories) {
          if (tr.kind?.entityType !== 2 || tr.samples.length < 2) continue;
          const role = resolveRoleQuick(ctx, tr);
          zctx.strokeStyle =
            role === "enemy"
              ? "rgba(204, 51, 51, 0.5)"
              : role === "self"
                ? "rgba(255, 255, 255, 0.6)"
                : "rgba(60, 180, 120, 0.5)";
          zctx.lineWidth = 1.5;
          zctx.beginPath();
          // FULL recorded path, independent of the playhead — the trails
          // toggle exists to review the whole battle's manoeuvres. (A
          // playhead-clipped variant shipped once and hid the trails
          // entirely at early battle times.)
          for (let i = 0; i < tr.samples.length; i++) {
            const s = tr.samples[i];
            const px = zwx(s.x);
            const py = zwz(-s.z);
            if (i === 0) zctx.moveTo(px, py);
            else zctx.lineTo(px, py);
          }
          zctx.stroke();
        }
      }
      for (const m of ctx.shipMarkers) {
        const role = m.userData.role as TeamRole | undefined;
        const firstT = m.userData.firstT as number | undefined;
        // Unobserved ships: enemies not shown; allies get a white glyph
        // outline at spawn — the game's "last known position" marker.
        if (t < (firstT ?? Infinity)) {
          if (role === "enemy") continue;
          const gx = zwx(m.userData.spawnX as number);
          const gz = zwz(-(m.userData.spawnZ as number));
          zctx.save();
          zctx.translate(gx, gz);
          zctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
          drawShipGlyph(zctx, m.userData.type as string | undefined, 0, 0, 30, TEAM_COLOR.ally, {
            outline: true,
          });
          zctx.restore();
          continue;
        }
        const dead =
          (m.userData.deathTime as number | null) != null &&
          t >= (m.userData.deathTime as number);
        const cx = zwx(m.position.x);
        const cz = zwz(m.position.z);
        // Solid traced vector glyph (original HUD shape, crisp at any
        // zoom/rotation); sunk ships render greyed-out, live ships in
        // their team colour.
        const color = dead ? 0x8a97a5 : role ? TEAM_COLOR[role] : 0x9aa7b5;
        zctx.save();
        zctx.translate(cx, cz);
        zctx.rotate((m.userData.yaw as number ?? 0) - Math.PI / 2);
        drawShipGlyph(zctx, m.userData.type as string | undefined, 0, 0, dead ? 26 : 34, color);
        zctx.restore();
      }
      // Smoke screens — white start/end rings + remaining seconds on
      // the enlarged map (same lifetime/dissipation rules as minimap).
      zctx.strokeStyle = "rgba(255,255,255,0.85)";
      zctx.fillStyle = "rgba(255,255,255,0.95)";
      zctx.lineWidth = 1.4;
      for (const cl of ctx.smokeClusters) {
        if (t < cl.t0 || t > cl.endT) continue;
        let cur = t;
        if (t > cl.lastT) {
          const span = Math.max(1, cl.lastT - cl.t0);
          cur = cl.t0 + ((t - cl.lastT) * span) / Math.max(1, cl.endT - cl.lastT);
          if (cur > cl.lastT) cur = cl.lastT;
        }
        const pStart = sampleAt(cl.traj, cur);
        if (!pStart) continue;
        const pEnd = sampleAt(cl.traj, cl.lastT);
        const drift =
          pEnd != null ? Math.hypot(pStart.x - pEnd.x, pStart.z - pEnd.z) : 0;
        const showBoth = pEnd != null && drift >= 1000;
        zctx.beginPath();
        zctx.arc(zwx(pStart.x), zwz(-pStart.z), 6, 0, Math.PI * 2);
        zctx.stroke();
        if (showBoth && pEnd) {
          zctx.beginPath();
          zctx.arc(zwx(pEnd.x), zwz(-pEnd.z), 6, 0, Math.PI * 2);
          zctx.stroke();
        }
        zctx.font = "bold 12px sans-serif";
        zctx.textAlign = "center";
        zctx.textBaseline = "bottom";
        zctx.save();
        zctx.translate(zwx(pStart.x), zwz(-pStart.z));
        zctx.fillText(`${Math.ceil(cl.endT - t)}s`, 0, -7);
        zctx.restore();
      }
      // Aircraft — one icon per formation (squadron centre).
      {
        const drawn = new Set<number>();
        for (const trail of ctx.planeTrails) {
          const planeId = Math.floor(trail.id / 16);
          if (trail.id % 16 !== 0 || drawn.has(planeId)) continue;
          const samples = trail.samples;
          let s: SquadronPlane | null = null;
          for (const sp of samples) {
            if (sp.time > t) break;
            s = sp;
          }
          if (s == null) continue;
          if (t < samples[0].time || t > samples[samples.length - 1].time + 5) continue;
          drawn.add(planeId);
          const icon = planeIcon(ctx.planeTypesById.get(trail.id) ?? "attack");
          if (icon && icon.complete && icon.naturalWidth > 0) {
            const sz = 22;
            zctx.save();
            zctx.translate(zwx(s.x), zwz(-s.z));
            zctx.drawImage(icon, -sz / 2, -sz / 2, sz, sz);
            zctx.restore();
          } else {
            zctx.fillStyle = "rgba(120, 210, 255, 0.95)";
            zctx.beginPath();
            zctx.arc(zwx(s.x), zwz(-s.z), 3.5, 0, Math.PI * 2);
            zctx.fill();
          }
        }
      }
      // Grid coordinate labels live in the SCREEN frame: pinned to the
      // top / left edges. Each label is projected through the view
      // window like the grid lines it names, so it rides its square
      // under pan/zoom.
      if (ctx.minimapShowGrid.value) {
        const colCenters: number[] = [];
        const rowCenters: number[] = [];
        for (let i = 0; i < MAP_GRID_COLUMNS; i++) {
          colCenters.push(
            zwx(full.minX + ((full.maxX - full.minX) * (i + 0.5)) / MAP_GRID_COLUMNS),
          );
          // Row 1 is the NORTHERNMOST band (+worldZ is up), so count the
          // row centres off maxZ — minZ-first would mirror 1–10 south.
          rowCenters.push(
            zwz(-(full.maxZ - ((full.maxZ - full.minZ) * (i + 0.5)) / MAP_GRID_COLUMNS)),
          );
        }
        const { top, left } = gridEdgeLabels(zw, colCenters, rowCenters);
        for (const l of [...top, ...left]) {
          zctx.save();
          zctx.translate(l.x, l.y);
          // Clamped = its square is off-canvas (deep zoom); it names the
          // nearest square THAT way, so it steps back visually.
          zctx.globalAlpha = l.clamped ? 0.45 : 1;
          zctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
          zctx.textAlign = "center";
          zctx.textBaseline = l.y === 0 ? "top" : "middle";
          const w = zctx.measureText(l.text).width + 8;
          zctx.fillStyle = "rgba(5, 8, 15, 0.6)";
          zctx.beginPath();
          zctx.roundRect(
            l.x === 0 ? 1 : -w / 2,
            l.y === 0 ? 1 : -7,
            w,
            14,
            4,
          );
          zctx.fill();
          zctx.fillStyle = "rgba(226, 232, 240, 0.92)";
          zctx.fillText(l.text, l.x === 0 ? 1 + w / 2 : 0, l.y === 0 ? 2 : 0);
          zctx.restore();
        }
      }
    }
  }
}
