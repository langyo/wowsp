/**
 * The 3D storm mask: the global cyclone's drifting dark core drawn as a
 * soft radial disc on the sea surface — the scene twin of the 2D minimap's
 * weather overlay. Both surfaces derive the disc from the same
 * `cycloneZoneAt` geometry and the same per-match drift seed, so the dark
 * zone moves in lockstep across the two views.
 *
 * The mask is a translucent film: every 3D actor is a transparent
 * depthWrite:false holo material, so the disc alpha-blends over whatever
 * it covers — sea and terrain darken, and ships, shells and aircraft read
 * as dimmed silhouettes inside the storm (the DOM ship labels are
 * unaffected). The gameplay rings and their letters sit at
 * [`OVERLAY_RING_ORDER`], above the mask, keeping the range readouts
 * crisp under the darkening.
 */
import * as THREE from "three";
import { computeFullMapBounds, type MapInternals } from "./mapInternals";
import {
  cycloneDriftSeed,
  cycloneZoneAt,
  STORM_CORE_HEX,
  weatherStateAt,
} from "./weather";

/** Soft radial falloff baked into the mask texture (centre → rim): heavy
 *  at the core, fading cleanly to nothing at the disc edge so the zone
 *  reads as weather, not a pasted circle. */
const MASK_CORE_ALPHA = 0.75;
const MASK_MID_ALPHA = 0.46;
/** Mask altitude: just above the sea surface (y 0.6), below the range
 *  rings (y 1.2) — the transparent pass orders the layers explicitly, so
 *  the altitude only keeps the flat mask from z-fighting the sea. */
const STORM_Y = 1.0;
/** Transparent-pass slot: after the sea surface (order 5), before the
 *  gameplay rings and their letters (order 7, see screenOverlays /
 *  actorBuild / rangeRings) — so the darkening sits on the water and the
 *  rings stay crisp above it, matching the 2D painter's layer order. */
const STORM_ORDER = 6;

/** Radial-gradient mask texture (dark core, transparent rim). */
function paintStormTexture(): THREE.CanvasTexture {
  const size = 256;
  const cvs = document.createElement("canvas");
  cvs.width = size;
  cvs.height = size;
  const g = cvs.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const [r, gr, b] = [(STORM_CORE_HEX >> 16) & 0xff, (STORM_CORE_HEX >> 8) & 0xff, STORM_CORE_HEX & 0xff];
  grad.addColorStop(0, `rgba(${r}, ${gr}, ${b}, ${MASK_CORE_ALPHA})`);
  grad.addColorStop(0.55, `rgba(${r}, ${gr}, ${b}, ${MASK_MID_ALPHA})`);
  grad.addColorStop(1, `rgba(${r}, ${gr}, ${b}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cvs);
  // The canvas bytes are sRGB-encoded; without this tag three.js samples
  // them as linear and the linear→sRGB output conversion turns the mask
  // into a LIGHT film instead of a darkening one.
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Lazily create the mask mesh — a unit plane the update scales to the
 *  zone radius (geometry never rebuilds). */
function ensureStormZone(ctx: MapInternals): THREE.Mesh | null {
  if (ctx.stormZone) return ctx.stormZone;
  const scene = ctx.api.value?.scene;
  if (!scene) return null;
  const mat = new THREE.MeshBasicMaterial({
    map: paintStormTexture(),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = STORM_ORDER;
  mesh.visible = false;
  mesh.raycast = () => {}; // never intercept canvas picks
  scene.add(mesh);
  ctx.stormZone = mesh;
  return mesh;
}

/** Show/hide + place the storm mask for battle second `t`. Cheap enough to
 *  run every playhead tick (weather state is a pure function of `t`). */
export function updateStormZone(ctx: MapInternals, t: number): void {
  const mesh = ensureStormZone(ctx);
  if (!mesh) return;
  const view = weatherStateAt(
    ctx.props.weatherTransitions,
    ctx.props.weatherNotifications,
    t,
  );
  const bounds = computeFullMapBounds(ctx);
  if (!view || view.badness <= 0.02 || !bounds) {
    mesh.visible = false;
    return;
  }
  const geo = cycloneZoneAt(
    bounds.minX,
    bounds.maxX,
    bounds.minZ,
    bounds.maxZ,
    view.badness,
    t,
    cycloneDriftSeed(ctx.props.weatherTransitions),
  );
  mesh.visible = true;
  // Scene z mirrors world z; the plane's local XY spans the gradient disc.
  mesh.position.set(geo.cx, STORM_Y, -geo.cz);
  mesh.scale.set(geo.radius, geo.radius, 1);
  (mesh.material as THREE.MeshBasicMaterial).opacity = view.badness;
}

/** Free the mask's GPU objects. Scene furniture like the water planes —
 *  it survives clearActors and is disposed on component unmount. */
export function disposeStormZone(ctx: MapInternals): void {
  if (!ctx.stormZone) return;
  ctx.api.value?.scene.remove(ctx.stormZone);
  ctx.stormZone.geometry.dispose();
  const mat = ctx.stormZone.material as THREE.MeshBasicMaterial;
  mat.map?.dispose();
  mat.dispose();
  ctx.stormZone = null;
}
