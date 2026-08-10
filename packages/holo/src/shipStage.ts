/**
 * shipStage — the homepage ship turntable, packaged as a framework-free 3D
 * controller so the site AND the desktop app run the same stage.
 *
 * Responsibilities (all inside, no Vue / no i18n):
 *  - load the baked GLB, normalize it (length 10, bow = +maxZ)
 *  - anchor weapons onto the multi-mesh bake instances (main_battery_249, …)
 *    with a fractional fallback for single-mesh bakes
 *  - holographic material + the armor-viewer plate scene (armorPlates),
 *    crossfaded by the shared playhead (holo 7s / armor 7.6s, hover-pauses)
 *  - per-frame projection of the leader anchors into screen space
 *
 * The host supplies text/renderables through the events; this module only
 * owns the three.js scene.
 */
import * as THREE from "three";
import { createPlayhead } from "./playhead";
import { buildArmorPlates, type ArmorZone } from "./armorPlates";
import { makeShipHoloMaterial, tickHolo } from "./holoShader";

/** Semantic prefixes of the multi-mesh bake (bake_model.py instances keep
 *  names like `main_battery_249`, `secondary_battery_255`). */
export const MESH_PREFIXES = [
  "main_battery", "secondary_battery", "aa_mount", "torpedo", "aircraft",
  "weapon", "turret_part", "hull_body", "hull_bow", "hull_mid", "hull_stern",
  "deck_house", "superstructure", "funnel", "misc",
] as const;

export function meshCategory(name: string): string {
  return MESH_PREFIXES.find((p) => name === p || name.startsWith(`${p}_`)) ?? name;
}

/** Fallback anchor fractions from the bow when the model has no instance
 *  names (single-mesh bake). */
interface AnchorSpec { x: number; z: number; low?: boolean }
const FALLBACK_WEAPONS: Record<string, AnchorSpec[]> = {
  gun: [
    { x: 0, z: 0.22 }, { x: 0, z: 0.30 }, { x: 0, z: 0.69 }, { x: 0, z: 0.77 },
  ],
  second: [
    { x: -1, z: 0.44, low: true }, { x: 1, z: 0.54, low: true },
  ],
  aa: [
    { x: -1, z: 0.32, low: false }, { x: -1, z: 0.55, low: false },
    { x: 1, z: 0.32, low: false }, { x: 1, z: 0.55, low: false },
  ],
};

export interface ShipStageFrame {
  /** Screen-space projected anchors per chip (gun / second / aa). */
  pts: { x: number; y: number }[][];
  /** 0..1 armor crossfade. */
  armorMix: number;
  /** True once the armor plates dominate (drives the mode badge). */
  armorOn: boolean;
  /** Where the auto-cycle is heading (drives the button group). */
  armorTarget: boolean;
  width: number;
  height: number;
}

export interface ShipStageOptions {
  modelUrl: string;
  armorZones?: ArmorZone[];
  /** Start in armor mode (deep-link / debug). */
  armorFirst?: boolean;
  onReady?: () => void;
  onFrame?: (f: ShipStageFrame) => void;
}

export interface ShipStageHandle {
  readonly ready: boolean;
  setArmor(on: boolean): void;
  dispose(): void;
}

const ARMOR_CYCLE = 14.6;
const ARMOR_AT = 7;

export function createShipStage(
  host: HTMLElement,
  opts: ShipStageOptions,
): ShipStageHandle {
  let ready = false;
  let disposed = false;
  let raf = 0;
  let io: IntersectionObserver | null = null;
  let ro: ResizeObserver | null = null;
  let visible = true;
  const disposables: { dispose(): void }[] = [];

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 500);
  const dims = { w: 0, h: 0 };

  const weaponAnchors: Record<string, THREE.Object3D[]> = {
    gun: [], second: [], aa: [],
  };

  const armorPh = createPlayhead(opts.armorFirst ? ARMOR_AT + 0.1 : 0);

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    dims.w = w; dims.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  async function boot() {
    let model: THREE.Group;
    try {
      model = await loadGlb(opts.modelUrl);
    } catch {
      return;
    }
    if (disposed) return;

    const meshes: THREE.Mesh[] = [];
    model.traverse((c) => { if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh); });
    for (const mesh of meshes) {
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      disposables.push(mesh.geometry);
    }

    // Normalize: hull length 10 world units along +Z (bow = +maxZ).
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = 10 / Math.max(size.x, size.z);
    model.scale.setScalar(scale);
    model.position.sub(center.multiplyScalar(scale));
    model.position.y += 1.2;

    const turntable = new THREE.Group();
    turntable.add(model);
    turntable.updateMatrixWorld(true);

    // ── Geometry-derived helpers (bow detection, side heights) ──
    const verts: THREE.Vector3[] = [];
    {
      const v = new THREE.Vector3();
      for (const mesh of meshes) {
        const pos = mesh.geometry.getAttribute("position");
        const step = Math.max(1, Math.floor(pos.count / 20000));
        for (let i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          verts.push(v.clone());
        }
      }
    }
    let zMin = Infinity, zMax = -Infinity, maxY = 0;
    for (const v of verts) {
      if (v.z < zMin) zMin = v.z;
      if (v.z > zMax) zMax = v.z;
      if (v.y > maxY) maxY = v.y;
    }
    const zSpan = zMax - zMin;
    const sliceW = zSpan / 40;
    const halfWidthAt = (z: number): number => {
      let hw = 0.3;
      for (const v of verts) {
        if (Math.abs(v.z - z) < sliceW && Math.abs(v.x) > hw) hw = Math.abs(v.x);
      }
      return hw;
    };
    const wLow = halfWidthAt(zMin + zSpan * 0.04);
    const wHigh = halfWidthAt(zMax - zSpan * 0.04);
    const bowAtMaxZ = wHigh <= wLow;
    const zFromBow = (f: number) => (bowAtMaxZ ? zMax - f * zSpan : zMin + f * zSpan);

    const raycaster = new THREE.Raycaster();
    const rayDir = new THREE.Vector3(0, -1, 0);
    const rayOrigin = new THREE.Vector3();
    const snapY = (x: number, z: number): number => {
      rayOrigin.set(x, maxY + 2, z);
      raycaster.set(rayOrigin, rayDir);
      const hits = raycaster.intersectObjects(meshes, false);
      return hits.length ? hits[0].point.y + 0.12 : maxY * 0.55;
    };
    const ys = verts.map((v) => v.y).sort((a, b) => a - b);
    const yAt = (q: number) => ys[Math.max(0, Math.min(ys.length - 1, Math.floor(q * (ys.length - 1))))];
    const sideDir = new THREE.Vector3();
    const snapSideX = (sign: number, y: number, z: number): number => {
      const hw = halfWidthAt(z);
      rayOrigin.set(sign * (hw + 2), y, z);
      sideDir.set(-sign, 0, 0);
      raycaster.set(rayOrigin, sideDir);
      const hits = raycaster.intersectObjects(meshes, false);
      return hits.length ? hits[0].point.x + sign * 0.06 : sign * hw;
    };
    /** Side heights from the OUTER HULL PLATING only (verts near max beam) —
     *  superstructure never skews the deck edge / waterline band. */
    const sideY = (z: number, low: boolean): number => {
      const hw = halfWidthAt(z);
      let lo = Infinity, hi = -Infinity;
      let any = false;
      for (const v of verts) {
        if (Math.abs(v.z - z) < sliceW && Math.abs(v.x) > 0.8 * hw) {
          any = true;
          if (v.y < lo) lo = v.y;
          if (v.y > hi) hi = v.y;
        }
      }
      if (!any) return low ? yAt(0.15) : yAt(0.72);
      const span = hi - lo;
      return low ? lo + span * 0.40 : lo + span * 0.86;
    };

    // ── Anchors: multi-mesh bake instances first, fraction fallback ──
    const instBox = (m: THREE.Mesh): { c: THREE.Vector3; top: number } => {
      const b = new THREE.Box3().setFromObject(m);
      return { c: b.getCenter(new THREE.Vector3()), top: b.max.y };
    };
    const turrets = meshes
      .filter((m) => meshCategory(m.name) === "main_battery")
      .map((m) => instBox(m))
      .sort((a, b) => b.c.z - a.c.z);
    const secs = meshes
      .filter((m) => meshCategory(m.name) === "secondary_battery")
      .map((m) => instBox(m));
    const secLeft = secs.filter((s) => s.c.x < 0).sort((a, b) => b.c.z - a.c.z);
    const secRight = secs.filter((s) => s.c.x >= 0).sort((a, b) => b.c.z - a.c.z);

    const instAnchor = (p: { x: number; y: number; z: number }): THREE.Object3D => {
      const a = new THREE.Object3D();
      a.position.set(p.x, p.y, p.z);
      turntable.add(a);
      return a;
    };
    if (turrets.length >= 4) {
      weaponAnchors.gun = turrets.map((t) => instAnchor({ x: t.c.x, y: t.top + 0.12, z: t.c.z }));
    } else {
      weaponAnchors.gun = (FALLBACK_WEAPONS.gun ?? []).map((p) => {
        const wz = zFromBow(p.z);
        return instAnchor({ x: 0, y: snapY(0, wz), z: wz });
      });
    }
    if (secLeft.length >= 1 && secRight.length >= 1) {
      weaponAnchors.aa = [
        instAnchor({ x: secLeft[0].c.x, y: secLeft[0].top + 0.12, z: secLeft[0].c.z }),
        instAnchor({ x: secLeft[secLeft.length - 1].c.x, y: secLeft[secLeft.length - 1].top + 0.12, z: secLeft[secLeft.length - 1].c.z }),
        instAnchor({ x: secRight[0].c.x, y: secRight[0].top + 0.12, z: secRight[0].c.z }),
        instAnchor({ x: secRight[secRight.length - 1].c.x, y: secRight[secRight.length - 1].top + 0.12, z: secRight[secRight.length - 1].c.z }),
      ];
    } else {
      weaponAnchors.aa = (FALLBACK_WEAPONS.aa ?? []).map((p) => {
        const wz = zFromBow(p.z);
        const y = sideY(wz, !!p.low);
        return instAnchor({ x: snapSideX(Math.sign(p.x), y, wz), y, z: wz });
      });
    }
    weaponAnchors.second = (FALLBACK_WEAPONS.second ?? []).map((p) => {
      const wz = zFromBow(p.z);
      const y = sideY(wz, !!p.low);
      return instAnchor({ x: snapSideX(Math.sign(p.x), y, wz), y, z: wz });
    });

    // ── Materials: one holo shader for everything + a faint wire overlay ──
    const holo = makeShipHoloMaterial();
    disposables.push(holo);
    const wire = new THREE.MeshBasicMaterial({
      color: 0x33ccff, wireframe: true, transparent: true, opacity: 0.07, depthWrite: false,
    });
    disposables.push(wire);
    for (const mesh of meshes) {
      mesh.material = holo;
      mesh.renderOrder = 1;
      mesh.add(new THREE.Mesh(mesh.geometry, wire));
    }

    // ── Armor-viewer scene (plates + dark hull clone, crossfaded) ──
    const armorFades: { mat: THREE.Material; base: number }[] = [];
    {
      const hullBox = new THREE.Box3();
      for (const mesh of meshes) hullBox.union(new THREE.Box3().setFromObject(mesh));
      const spec = {
        sternZ: bowAtMaxZ ? zMin : zMax,
        bowZ: bowAtMaxZ ? zMax : zMin,
        hullXMin: hullBox.min.x,
        hullXMax: hullBox.max.x,
        hullYMin: hullBox.min.y,
        hullYMax: hullBox.max.y,
        b2mR: 0.35,
        m2sR: 0.68,
      };
      const { group, fades } = buildArmorPlates(spec, opts.armorZones ?? []);
      const armorScene = new THREE.Group();
      armorScene.add(group);
      armorFades.push(...fades);
      const cloneMat = new THREE.MeshBasicMaterial({
        color: 0x0d4a6a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      });
      for (const mesh of meshes) {
        const clone = new THREE.Mesh(mesh.geometry, cloneMat);
        clone.position.copy(mesh.getWorldPosition(new THREE.Vector3()));
        clone.quaternion.copy(mesh.getWorldQuaternion(new THREE.Quaternion()));
        clone.scale.copy(mesh.getWorldScale(new THREE.Vector3()));
        clone.renderOrder = -1;
        armorScene.add(clone);
      }
      armorFades.push({ mat: cloneMat, base: 0.55 });
      disposables.push(cloneMat);
      turntable.add(armorScene);
    }

    const grid = new THREE.GridHelper(26, 26, 0x9aa7b8, 0xc8d2de);
    const gridMat = grid.material as THREE.LineBasicMaterial;
    gridMat.transparent = true;
    gridMat.opacity = 0;
    grid.position.y = ys[0] - 0.5;
    scene.add(grid);
    disposables.push(gridMat);

    scene.add(turntable);
    camera.position.set(0, 4.2, 13.5);
    camera.lookAt(0, 1.6, 0);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const worldPt = new THREE.Vector3();
    let last = performance.now();
    let angle = 0.6;
    let armorMix = 0;

    const onHoverEnter = () => armorPh.pause();
    const onHoverLeave = () => armorPh.resume();
    host.addEventListener("mouseenter", onHoverEnter);
    host.addEventListener("mouseleave", onHoverLeave);

    const frame = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (!visible) return;

      if (!reduced) angle += dt * 0.22;
      turntable.rotation.y = angle;
      turntable.updateMatrixWorld(true);

      // armor alternation on the shared playhead (hover pauses it)
      const armorPhase = armorPh.advance(reduced ? 0 : dt);
      const target = (armorPhase % ARMOR_CYCLE) > ARMOR_AT ? 1 : 0;
      armorMix += (target - armorMix) * Math.min(1, dt * 2.2);
      model.visible = armorMix < 0.5;
      wire.opacity = 0.07 * (1 - armorMix * 0.85);
      for (const f of armorFades) f.mat.opacity = armorMix * f.base;
      gridMat.opacity = armorMix * 0.4;

      // Leader anchors: guns + secondaries in holo mode, the main belt in
      // armor mode (pointing at the thickest side plating).
      const next: { x: number; y: number }[][] = [];
      for (const key of ["gun", "second", "aa"] as const) {
        const show = key === "second" ? armorMix >= 0.5 : armorMix < 0.5;
        const arr: { x: number; y: number }[] = [];
        if (show) {
          for (const a of weaponAnchors[key]) {
            a.getWorldPosition(worldPt);
            worldPt.project(camera);
            arr.push({
              x: (worldPt.x * 0.5 + 0.5) * dims.w,
              y: (-worldPt.y * 0.5 + 0.5) * dims.h,
            });
          }
        }
        next.push(arr);
      }

      tickHolo(holo, dt);
      renderer.render(scene, camera);
      opts.onFrame?.({
        pts: next,
        armorMix,
        armorOn: armorMix > 0.5,
        armorTarget: target === 1,
        width: dims.w,
        height: dims.h,
      });
    };
    raf = requestAnimationFrame(frame);

    io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0.05 });
    io.observe(host);
    ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    ready = true;
    opts.onReady?.();
  }

  void boot();

  return {
    get ready() { return ready; },
    setArmor(on: boolean) {
      armorPh.seek(on ? ARMOR_AT + 0.1 : ARMOR_AT - 0.1);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      io?.disconnect();
      ro?.disconnect();
      host.removeEventListener("mouseenter", onHoverEnter);
      host.removeEventListener("mouseleave", onHoverLeave);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

// loadGlb lives here too so hosts never need their own GLB fetch pipeline.
import { loadGlb } from "./glbLoader";
