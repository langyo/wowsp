import {
  defineComponent,
  getCurrentInstance,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import SSegmented from "@/components/base/SSegmented";
import SSpinner from "@/components/base/SSpinner";
import { resolveShipModelByShipId, resolveFallbackModel, loadGlbModel, type ShipModelSpec } from "@/features/holographic/modelLoader";
import { makeHoloMaterial as sharedMakeHoloMaterial, tickHoloUniforms, type HoloUniforms } from "@/features/holographic/holoShader";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { resolveShipImage } from "@/utils/shipImages";
import { t } from "@/i18n";
import { useToast } from "@/composables/useToast";
import type { ShipInfo } from "@/api";
import "./ShipStage.scss";

/** Armor-zone data fed from GameParams via the parent. */
export interface ArmorZone {
  name: string;       /** "citadel", "mainBelt", "deck", "bow", "stern", … */
  thickness: number;  /** mm — 0 if unknown */
}

/**
 * Holographic ship viewer — the big interactive 3D stage at the top of the
 * ship detail modal.
 *
 * Replaces the old inline `init3dViewer` (fixed 150px, no interaction). This
 * stage renders the ship as a cyan hologram with Fresnel rim lighting +
 * scanlines + a faint wireframe overlay, and is fully orbit-controlled:
 * left-drag to rotate, wheel to zoom, right-drag to pan. Auto-rotates gently
 * until the user grabs it.
 *
 * `focusZone(zone)` flies the camera to a preset view of a ship region
 * (bow / midship / stern / deck / waterline), used by the WeaponBar to focus
 * a weapon module. The transition is a hand-rolled eased tween (no GSAP).
 *
 * The ship GLB is resolved via `resolveShipModelByShipId`, which follows the
 * skin→base redirect in `ship_models.json` — so ARP/AZUR/Black variants reuse
 * their base ship's model.
 */

/** Ship regions the camera can focus on (relative to model bbox). */
export type FocusZone = "default" | "bow" | "midship" | "stern" | "deck" | "waterline";

export default defineComponent({
  name: "ShipStage",
  props: {
    ship: { type: Object as () => ShipInfo | null, required: true },
    armorZones: { type: Array as () => ArmorZone[], default: () => [] },
    waterlineDraft: { type: Number as () => number | null, default: null },
  },
  // `focusZone` is stashed on the instance from inside setup() and surfaced
  // here via `exposed` so parents can call stageRef.value?.focusZone(...).
  // (setup() returns a render fn, not a state object, so this is the route.)
  exposed: {} as { focusZone?: (zone: FocusZone) => void },
  setup(props) {
    const inst = getCurrentInstance();
    const toast = useToast();
    const containerRef = ref<HTMLElement | null>(null);
    const viewMode = ref<"2d" | "3d">("3d");
    const loading = ref(false);
    const errorMsg = ref<string | null>(null);
    /** Whether a baked 3D model resolves for this ship. */
    const hasModel = ref(true);

    // Three.js state (kept in shallowRefs / closure vars; not reactive).
    const scene = shallowRef<THREE.Scene | null>(null);
    const camera = shallowRef<THREE.PerspectiveCamera | null>(null);
    const renderer = shallowRef<THREE.WebGLRenderer | null>(null);
    const controls = shallowRef<OrbitControls | null>(null);
    const modelGroup = shallowRef<THREE.Group | null>(null);
    /** Uniforms for the animated holographic shader (time + scan offset). */
    const uniforms = shallowRef<HoloUniforms | null>(null);
    /** Bounding box of the loaded model (for focus-zone camera placement). */
    const modelBox = shallowRef<THREE.Box3 | null>(null);
    /** Armor-zone overlay group (visible when showArmor is true). */
    const armorGroup = shallowRef<THREE.Group | null>(null);
    const showArmor = ref(false);
    let gridRef: THREE.GridHelper | null = null;
    let _waterlinePlane: THREE.Mesh | null = null;

    function disposeArmorScene() {
      const g = armorGroup.value;
      const sc = scene.value;
      if (g && sc) sc.remove(g);
      if (g) {
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else if (mat) mat.dispose();
        });
      }
      armorGroup.value = null;
      // Restore main model visibility.
      const model = modelGroup.value;
      if (model) {
        model.visible = true;
        model.traverse((c) => ((c as THREE.Mesh).visible = true));
      }
    }

    async function syncArmorOverlay() {
      const sc = scene.value;
      const model = modelGroup.value;
      if (!showArmor.value || !sc || !model) {
        disposeArmorScene();
        return;
      }
      // Build a fresh armour-scene group: uniform-dark hull clones,
      // coloured armour boxes, and a waterline plane.
      disposeArmorScene();

      // Hide the main model — the armour group replaces it visually.
      model.visible = false;

      const armorSc = new THREE.Group();
      armorSc.name = "armor-scene";

      // Load the pre-baked armor GLB (per-vertex coloured from game data).
      const prefix = props.ship?.name ? "" : ""; // derive from shipId via modelLoader
      if (props.ship) {
        const armorUrl = resolveShipModelByShipId(props.ship.shipId, undefined)?.replace(/\.glb$/, "_armor.glb") ?? null;
        if (armorUrl) {
          try {
            const armorModel = await loadGlbModel(armorUrl);
            if (armorModel) {
              // Debug: compare bounding boxes.
              const aBox = new THREE.Box3().setFromObject(armorModel);
              const aSize = aBox.getSize(new THREE.Vector3());
              const mBox = new THREE.Box3().setFromObject(model);
              const mSize = mBox.getSize(new THREE.Vector3());
              console.log("[armor] raw armor box:", aSize.toArray().map(v => v.toFixed(0)),
                "model box (pre-norm):", mSize.toArray().map(v => v.toFixed(0)));

              // Match the visual model's transform (same scale + offset).
              armorModel.scale.copy(model.scale);
              armorModel.position.copy(model.position);

              armorModel.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) {
                  const geo = mesh.geometry;
                  const mat = new THREE.MeshBasicMaterial({
                    vertexColors: (geo.getAttribute('color') != null),
                    side: THREE.DoubleSide,
                    transparent: true,
                    opacity: 0.75,
                    depthWrite: false,
                  });
                  mesh.material = mat;
                  mesh.renderOrder = 1;
                  armorSc.add(mesh);
                }
              });
            }
          } catch { /* fall back to heuristic */ }
        }
      }

      // Fall back: hull clones + heuristic plates if no armor GLB.
      if (armorSc.children.length === 0) {

      // Clone hull meshes with a uniform dark material.
      const hullNames = new Set(["hull_body","hull_bow","hull_mid","hull_stern","deck_house","funnel","superstructure"]);
      const sections = new Map<string, THREE.Box3>();
      const cloneMat = new THREE.MeshBasicMaterial({
        color: 0x0d4a6a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
      });
      let cloneCount = 0;
      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !hullNames.has(mesh.name)) return;
        mesh.updateWorldMatrix(true, false);
        const clone = new THREE.Mesh(mesh.geometry, cloneMat);
        clone.position.copy(mesh.getWorldPosition(new THREE.Vector3()));
        clone.quaternion.copy(mesh.getWorldQuaternion(new THREE.Quaternion()));
        clone.scale.copy(mesh.getWorldScale(new THREE.Vector3()));
        clone.renderOrder = -1;
        armorSc.add(clone);
        cloneCount++;
        // Accumulate section bounding boxes.
        let b = sections.get(mesh.name);
        if (!b) { b = new THREE.Box3(); sections.set(mesh.name, b); }
        mesh.geometry.computeBoundingBox();
        const mb = new THREE.Box3().setFromObject(mesh);
        b.expandByPoint(mb.min).expandByPoint(mb.max);
      });
      console.log("[armor] cloned", cloneCount, "hull meshes, sections:", [...sections.keys()]);

      // Armour zone boxes.
      const boxes = buildArmorOverlay(sections, props.armorZones ?? []);
      console.log("[armor] boxes:", boxes ? boxes.children.length : "null", "zones:", props.armorZones?.map(z => `${z.name}=${z.thickness}mm`) ?? []);
      if (boxes) armorSc.add(boxes);

      // Waterline plane + grid.
      const midBox = sections.get("hull_mid");
      if (midBox) {
        const midH = midBox.max.y - midBox.min.y;
        const wlY = midBox.min.y + midH * 0.12;
        const wlGeo = new THREE.PlaneGeometry(600, 600);
        const wlMat = new THREE.MeshBasicMaterial({
          color: 0x0a3a5a, side: THREE.DoubleSide,
          transparent: true, opacity: 0.30, depthWrite: false,
        });
        const plane = new THREE.Mesh(wlGeo, wlMat);
        plane.rotation.x = -Math.PI / 2;
        plane.position.y = wlY;
        plane.renderOrder = -2;
        armorSc.add(plane);
        if (gridRef) gridRef.position.y = wlY;
      }
      } // end fallback block

      sc.add(armorSc);
      armorGroup.value = armorSc;
    }

    function toggleArmor() {
      showArmor.value = !showArmor.value;
      syncArmorOverlay();
    }

    watch(
      () => [props.armorZones?.length ?? 0, modelGroup.value != null] as const,
      () => { if (showArmor.value) syncArmorOverlay(); },
    );
    /** Standardised zone positions relative to the hull bounding box.
     *  X = bow→stern, Y = keel→mast, Z = port→starboard.
     *  Values are conservative so boxes sit INSIDE the hull silhouette. */
    const ARMOR_ZONE_POSITIONS: Record<string, {
      x: [number, number]; y: [number, number]; z: [number, number];
    }> = {
      bow:        { x: [0.00, 0.22], y: [0.00, 0.48], z: [-0.25, 0.25] },
      bowBelt:    { x: [0.14, 0.28], y: [0.04, 0.36], z: [-0.30, 0.30] },
      forwardBelt:{ x: [0.26, 0.48], y: [0.06, 0.40], z: [-0.34, 0.34] },
      citadel:    { x: [0.30, 0.74], y: [0.03, 0.38], z: [-0.14, 0.14] },
      mainBelt:   { x: [0.24, 0.84], y: [0.06, 0.42], z: [-0.36, 0.36] },
      aftBelt:    { x: [0.58, 0.80], y: [0.06, 0.40], z: [-0.34, 0.34] },
      casemate:   { x: [0.28, 0.84], y: [0.40, 0.56], z: [-0.26, 0.26] },
      deck:       { x: [0.20, 0.80], y: [0.42, 0.48], z: [-0.24, 0.24] },
      stern:      { x: [0.84, 1.00], y: [0.00, 0.44], z: [-0.25, 0.25] },
      sternBelt:  { x: [0.74, 0.86], y: [0.04, 0.36], z: [-0.30, 0.30] },
      torpedoBelt:{ x: [0.26, 0.80], y: [0.00, 0.18], z: [-0.38, 0.38] },
      superstructure:{ x: [0.30, 0.86], y: [0.46, 0.76], z: [-0.12, 0.12] },
    };

    /** Exact 10-bucket colour scale from the game's ArmorConstants.py.
     *  Each entry: (maxThickness_mm, r, g, b). bisect_left. */
    const ARMOR_SCALE: [number, number, number, number][] = [
      [14,  110, 209, 176], // teal
      [16,  149, 210, 127], // light green
      [24,  170, 201, 102], // yellow-green
      [26,  192, 193,  80], // olive
      [28,  226, 195,  62], // gold
      [33,  225, 171,  54], // orange-gold
      [75,  227, 144,  49], // orange
      [160, 230, 115,  49], // dark orange
      [399, 220,  78,  48], // red-orange
      [999, 185,  47,  48], // dark red
    ];
    function armorColor(mm: number): number {
      if (mm <= 0) return 0xcccccc; // light grey for unknown
      const [r, g, b] = ARMOR_SCALE.find(([bp]) => mm <= bp) ?? ARMOR_SCALE[ARMOR_SCALE.length - 1];
      return (r << 16) | (g << 8) | b;
    }

    /** Collect per-section hull bounding boxes (bow / mid / stern / deck_house). */
    function collectHullSections(model: THREE.Group): Map<string, THREE.Box3> {
      const map = new Map<string, THREE.Box3>();
      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const n = mesh.name;
        if (!n.startsWith("hull_") && n !== "deck_house" && n !== "funnel") return;
        let b = map.get(n);
        if (!b) { b = new THREE.Box3(); map.set(n, b); }
        mesh.geometry.computeBoundingBox();
        const mb = new THREE.Box3().setFromObject(mesh);
        b.expandByPoint(mb.min).expandByPoint(mb.max);
      });
      // Merge into a unified hull box for sections that span the full length.
      const full = new THREE.Box3();
      for (const b of map.values()) full.expandByPoint(b.min).expandByPoint(b.max);
      map.set("full", full);
      return map;
    }

    function buildArmorOverlay(
      hullSectionBoxes: Map<string, THREE.Box3>,
      zones: ArmorZone[],
    ): THREE.Group | null {
      if (!zones.length) return null;
      const group = new THREE.Group();
      group.name = "armor-overlay";
      group.renderOrder = 2;

      const bowBox = hullSectionBoxes.get("hull_bow");
      const midBox = hullSectionBoxes.get("hull_mid");
      const sternBox = hullSectionBoxes.get("hull_stern");
      if (!bowBox || !midBox || !sternBox) return null;

      // The ship model is oriented along Z (bow=+Z, stern=-Z).
      // Use Z as the length axis, X as beam (width), Y as height.
      const bowZ = bowBox.max.z;  // bow tip
      const sternZ = sternBox.min.z; // stern tip
      // Split points between sections along Z.
      const b2mSplit = (bowBox.min.z + midBox.max.z) * 0.5;
      const m2sSplit = (midBox.min.z + sternBox.max.z) * 0.5;
      const hullZLen = bowZ - sternZ;
      if (hullZLen <= 0) return null;

      // X / Y extents: envelope of all hull sections.
      const hullXMin = Math.min(bowBox.min.x, midBox.min.x, sternBox.min.x);
      const hullXMax = Math.max(bowBox.max.x, midBox.max.x, sternBox.max.x);
      const hullXLen = hullXMax - hullXMin;
      const hullXCtr = (hullXMin + hullXMax) * 0.5;
      const hullYMin = Math.min(bowBox.min.y, midBox.min.y, sternBox.min.y);
      const hullYMax = Math.max(bowBox.max.y, midBox.max.y, sternBox.max.y);
      const hullYLen = hullYMax - hullYMin;
      const hullYCtr = (hullYMin + hullYMax) * 0.5;

      const byName = new Map<string, number>();
      for (const z of zones) byName.set(z.name, z.thickness);

      // Z ratio: 0→stern, 1→bow.
      function zRel(zr: [number, number]): [number, number] {
        return [sternZ + hullZLen * zr[0], sternZ + hullZLen * zr[1]];
      }
      // X ratio:  centred around hullXCtr, positive→starboard.
      function xRel(xr: [number, number]): [number, number] {
        const half = hullXLen * 0.5;
        return [hullXCtr + half * xr[0], hullXCtr + half * xr[1]];
      }
      // Y ratio:  0→keel, 1→mast (hullYMin is keel).
      function yRel(yr: [number, number]): [number, number] {
        return [hullYMin + hullYLen * yr[0], hullYMin + hullYLen * yr[1]];
      }

      const b2mR = (b2mSplit - sternZ) / hullZLen;
      const m2sR = (m2sSplit - sternZ) / hullZLen;

      function add(
        zoneName: string,
        zr: [number, number], yr: [number, number], xr: [number, number],
      ) {
        const [z1, z2] = zRel(zr);
        const [y1, y2] = yRel(yr);
        const [x1, x2] = xRel(xr);
        const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
        if (dx <= 0 || dy <= 0 || dz <= 0) return;
        const mm = byName.get(zoneName) ?? 0;
        const color = armorColor(mm);
        const geo = new THREE.BoxGeometry(dx, dy, dz);
        const mat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
        });
        const box = new THREE.Mesh(geo, mat);
        box.position.set(x1 + dx / 2, y1 + dy / 2, z1 + dz / 2);
        box.userData = { zone: zoneName, thickness: mm };
        group.add(box);
        const edge = new THREE.EdgesGeometry(geo);
        const line = new THREE.LineSegments(
          edge,
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false }),
        );
        line.raycast = () => {};
        box.add(line);
      }

      // Stern section (Z: 0 → b2mR)
      add("stern",     [0.00, b2mR], [0.00, 0.40], [-1.0, 1.0]);
      add("sternBelt", [0.00, b2mR * 0.85], [0.04, 0.30], [-1.0, 1.0]);
      const PLATE_THICKNESS = 2.0; // thin shell, visible from any angle

      function addPlate(
        zoneName: string,
        width: number, height: number, depth: number,
        cx: number, cy: number, cz: number,
        rotY: number,
      ) {
        const mm = byName.get(zoneName) ?? 0;
        const color = armorColor(mm);
        const geo = new THREE.BoxGeometry(width, height, depth);
        const mat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.35, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
        });
        const box = new THREE.Mesh(geo, mat);
        box.position.set(cx, cy, cz);
        box.rotation.y = rotY;
        box.userData = { zone: zoneName, thickness: mm };
        group.add(box);
        const edge = new THREE.EdgesGeometry(geo);
        const line = new THREE.LineSegments(
          edge,
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false }),
        );
        line.raycast = () => {};
        box.add(line);
      }

      function addVerticalBelt(zoneName: string, zr: [number, number], yr: [number, number]) {
        const [z1, z2] = zRel(zr);
        const [y1, y2] = yRel(yr);
        const dz = z2 - z1, dy = y2 - y1;
        if (dz <= 0 || dy <= 0) return;
        const cy = (y1 + y2) * 0.5;
        const cz = (z1 + z2) * 0.5;
        // Port plate
        const portX = xRelPort();
        addPlate(zoneName, PLATE_THICKNESS, dy, dz, portX, cy, cz, 0);
        // Starboard plate
        const stbdX = xRelStbd();
        addPlate(zoneName, PLATE_THICKNESS, dy, dz, stbdX, cy, cz, 0);
      }

      function addHorizontal(zoneName: string, zr: [number, number], xr: [number, number]) {
        const [z1, z2] = zRel(zr);
        const [x1, x2] = xRel(xr);
        const dz = z2 - z1, dx = x2 - x1;
        if (dz <= 0 || dx <= 0) return;
        const cy = hullYCtr + hullYLen * 0.48; // near top of mid section
        const cz = (z1 + z2) * 0.5;
        const cx = (x1 + x2) * 0.5;
        addPlate(zoneName, dx, PLATE_THICKNESS, dz, cx, cy, cz, 0);
      }

      // Hull outline ports: where the vertical belt plates sit (outer hull surface).
      const hullXHalf = hullXLen * 0.5;
      function xRelPort() { return hullXCtr - hullXHalf * 0.85; }
      function xRelStbd() { return hullXCtr + hullXHalf * 0.85; }

      const GAP = 0.4;
      const m0 = b2mR, m1 = m2sR;
      const THIRD = (m1 - m0) / 3;
      const bLen = 1.0 - m1;

      // Stern
      addVerticalBelt("stern",     [0.00, b2mR], [0.00, 0.40]);
      addVerticalBelt("sternBelt", [0.00, b2mR - GAP], [0.04, 0.30]);
      // Midsection belts
      addVerticalBelt("forwardBelt", [m0, m0 + THIRD - GAP],  [0.04, 0.38]);
      addVerticalBelt("mainBelt",    [m0 + THIRD, m1 - THIRD], [0.04, 0.38]);
      addVerticalBelt("aftBelt",     [m1 - THIRD + GAP, m1],  [0.04, 0.38]);
      addVerticalBelt("casemate",    [m0, m1], [0.36, 0.50]);
      // Citadel: 4 thin walls (not a solid block)
      const citZr: [number, number] = [m0 + THIRD * 0.5, m1 - THIRD * 0.5];
      const citYr: [number, number] = [0.02, 0.34];
      function _czr() { const [z1,z2]=zRel(citZr); const [y1,y2]=yRel(citYr); const cy=(y1+y2)*0.5; const cz=(z1+z2)*0.5; const dy=y2-y1, dz=z2-z1;
        addPlate("citadel", PLATE_THICKNESS, dy, dz, hullXCtr - hullXHalf*0.28, cy, cz, 0);
        addPlate("citadel", PLATE_THICKNESS, dy, dz, hullXCtr + hullXHalf*0.28, cy, cz, 0);
        addPlate("citadel", dz, dy, PLATE_THICKNESS, hullXCtr, cy, z1, Math.PI/2);
        addPlate("citadel", dz, dy, PLATE_THICKNESS, hullXCtr, cy, z2, Math.PI/2);
      }
      _czr();
      addHorizontal("deck", [m0, m1], [-0.55, 0.55]);
      // Torpedo belt — low vertical plates
      addVerticalBelt("torpedoBelt", [m0, m1], [0.00, 0.14]);
      // Bow
      addVerticalBelt("bow", [m1, 1.00], [0.00, 0.40]);
      addVerticalBelt("bowBelt", [m1 + bLen * 0.15, 1.00], [0.04, 0.30]);
      // Superstructure
      addHorizontal("superstructure", [m0 + 0.02, m1 - 0.02], [-0.20, 0.20]);

      return group;
    }

    let rafId = 0;
    let resizeObs: ResizeObserver | null = null;
    /** Active focus tween; cancelled if a new focus starts mid-flight. */
    let focusTween: (() => void) | null = null;
    const _allHoloUniforms: HoloUniforms[] = [];

    // ── Holographic shader ────────────────────────────────────────────────
    // The shader source + material factory live in the shared `holoShader`
    // module (also used by the replay's recorder-ship panel). This thin wrapper
    // also stashes the uniforms on the component ref so the render loop can
    // drive the scanline animation each frame via `tickHoloUniforms`.
    function makeHoloMaterial(): THREE.ShaderMaterial {
      const mat = sharedMakeHoloMaterial();
      _allHoloUniforms.push(mat.uniforms as unknown as HoloUniforms);
      if (!uniforms.value) uniforms.value = mat.uniforms as unknown as HoloUniforms;
      return mat;
    }

    // ── Scene lifecycle ───────────────────────────────────────────────────
    function initScene() {
      const el = containerRef.value;
      if (!el) return;
      const w = el.clientWidth || 600;
      const h = el.clientHeight || 320;

      const sc = new THREE.Scene();
      const isDark = document.documentElement.dataset.mode === "dark";
      const bg = isDark ? 0x0c121e : 0xf5f8fc;
      sc.background = new THREE.Color(bg);
      // Subtle radial fog for depth.
      sc.fog = new THREE.Fog(bg, 400, 1400);

      const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
      // Initial view before a model loads — matches the `default` focus-zone
      // framing (starboard-bow ~2 o'clock, elevated). focusZone("default")
      // re-positions precisely once the model bounds are known.
      cam.position.set(230, 215, 400);

      const rnd = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      rnd.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      rnd.setSize(w, h);
      el.appendChild(rnd.domElement);

      // Lights — mostly for the wireframe overlay (the holo shader is unlit).
      sc.add(new THREE.AmbientLight(0x335577, 0.8));
      const key = new THREE.DirectionalLight(0x66bbff, 0.7);
      key.position.set(120, 200, 120);
      sc.add(key);

      // A faint ground grid at the ship's waterline (placed after model loads).
      const grid = new THREE.GridHelper(1200, 40, 0x1a3a55, 0x0e1f30);
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.4;
      (grid as any).position.y = -25; // default below ship; fixed after model loads
      sc.add(grid);
      gridRef = grid;

      const ctrl = new OrbitControls(cam, rnd.domElement);
      ctrl.enableDamping = true;
      ctrl.dampingFactor = 0.08;
      ctrl.rotateSpeed = 0.8;
      ctrl.zoomSpeed = 0.9;
      ctrl.minDistance = 80;
      ctrl.maxDistance = 800;
      ctrl.maxPolarAngle = Math.PI * 0.85; // don't go under the grid floor
      ctrl.autoRotate = true;
      ctrl.autoRotateSpeed = 0.5;
      // Stop auto-rotate as soon as the user touches it.
      ctrl.addEventListener("start", () => {
        ctrl.autoRotate = false;
      });

      scene.value = sc;
      camera.value = cam;
      renderer.value = rnd;
      controls.value = ctrl;

      const clock = new THREE.Clock();
      const tick = () => {
        const dt = clock.getDelta();
        for (const u of _allHoloUniforms) tickHoloUniforms(u, dt);
        ctrl.update();
        rnd.render(sc, cam);
        rafId = requestAnimationFrame(tick);
      };
      tick();

      resizeObs = new ResizeObserver(() => {
        const cw = el.clientWidth;
        const ch = el.clientHeight;
        if (cw === 0 || ch === 0) return;
        cam.aspect = cw / ch;
        cam.updateProjectionMatrix();
        rnd.setSize(cw, ch);
      });
      resizeObs.observe(el);
    }

    async function loadModel() {
      const ship = props.ship;
      if (!ship) return;
      loading.value = true;
      errorMsg.value = null;
      try {
        let url = resolveShipModelByShipId(ship.shipId, ship.name);
        // Fallback: try to match a model of the same tier/nation/type if no
        // exact model exists for this ship. This lets the holographic stage
        // show a similar hull rather than a blank viewport.
        if (!url) {
          const encyclopedia = useEncyclopediaStore();
          const spec: ShipModelSpec = {
            shipId: ship.shipId,
            tier: ship.tier,
            nation: ship.nation,
            type: ship.type,
          };
          const pool: ShipModelSpec[] = encyclopedia.ships.map((s) => ({
            shipId: s.shipId,
            tier: s.tier,
            nation: s.nation,
            type: s.type,
          }));
          url = resolveFallbackModel(spec, pool);
        }
        if (!url) {
          hasModel.value = false;
          errorMsg.value = t("ships.detail.noModel");
          return;
        }
        hasModel.value = true;
        const model = await loadGlbModel(url);
        // The baked GLBs drop POSITION accessor min/max (smaller files), so
        // Box3.setFromObject can't infer bounds — compute them per-geometry first.
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry && mesh.geometry.attributes.position) {
            mesh.geometry.computeBoundingBox();
            mesh.geometry.computeBoundingSphere();
          }
        });
        modelGroup.value = model;

        // ── Per-mesh-group holographic materials with deterministic colour ──
        // Each mesh is named after its semantic category and gets a distinct hue
        // drawn from pre-defined pools so the same part type is always the same
        // colour across every ship, but different types are clearly separable.
        const WEAPON_NAMES = new Set([
          "main_battery", "secondary_battery", "aa_mount", "torpedo",
          "weapon", "turret_part", "aircraft",
        ]);

        /** Pre-defined base hues (0-360) for known category names.  Each
         *  category name always maps to the same hue — no hash drift. */
        const PRESET_HUES: Record<string, number> = {
          // Hull armour belts — cool spectrum (185°–230°, visible separation)
          hull_bow:    185,
          hull_mid:    205,
          hull_stern:  170,
          hull_body:   195,
          deck_house:  220,
          // Superstructure — green-cyan, distinct from blue hull body
          superstructure: 148,
          funnel:      240,
          // Weapons — warm spectrum with 30–40° gaps
          main_battery:      22,   // orange
          secondary_battery: 55,   // amber
          aa_mount:          6,    // red
          torpedo:          172,   // teal
          aircraft:         280,   // purple
          weapon:            36,   // gold (generic)
          turret_part:       44,   // darker gold
          misc:             200,
        };

        function colorForCategory(name: string): { base: THREE.Color; fresnel: THREE.Color; edge: number } {
          let hue: number, sat: number, lit: number;
          if (PRESET_HUES[name] != null) {
            hue = PRESET_HUES[name];
          } else {
            let h = 0;
            for (let i = 0; i < name.length; i++) {
              h = ((h << 5) - h) + name.charCodeAt(i);
              h |= 0;
            }
            hue = (h >>> 0) % 360;
          }
          if (WEAPON_NAMES.has(name)) {
            sat = 0.72;
            lit = 0.35;
          } else if (name.startsWith("hull_") || name === "deck_house" || name === "superstructure") {
            sat = 0.48;
            lit = 0.30;
          } else if (name === "funnel") {
            sat = 0.15; lit = 0.22;
          } else {
            sat = 0.50; lit = 0.32;
          }
          const edgeHue = (hue + 18) % 360;
          return {
            base: new THREE.Color().setHSL(hue / 360, sat, lit),
            fresnel: new THREE.Color().setHSL(hue / 360, sat * 0.85, Math.min(lit * 2.0, 0.85)),
            edge: edgeHue,
          };
        }

        const materialCache = new Map<string, THREE.ShaderMaterial>();

        const meshes: THREE.Mesh[] = [];
        model.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
        console.log("[loadModel] meshes:", meshes.length, "names:", meshes.map(m => m.name));

        for (const mesh of meshes) {
          const name = mesh.name || "misc";
          let mat = materialCache.get(name);
          if (!mat) {
            mat = makeHoloMaterial();
            const c = colorForCategory(name);
            mat.uniforms.baseColor.value.copy(c.base);
            mat.uniforms.fresnelColor.value.copy(c.fresnel);
            materialCache.set(name, mat);
          }
          mesh.material = mat;
          mesh.renderOrder = WEAPON_NAMES.has(name) ? 1 : 0;

          // Faint structural-edge overlay — matches the part's hue.
          const c = colorForCategory(name);
          const edgeHex = new THREE.Color().setHSL(c.edge / 360, 0.5, 0.55).getHex();
          const edgeGeo = new THREE.EdgesGeometry(mesh.geometry, 8);
          const line = new THREE.LineSegments(
            edgeGeo,
            new THREE.LineBasicMaterial({
              color: edgeHex,
              transparent: true,
              opacity: 0.18,
              depthWrite: false,
            }),
          );
          line.raycast = () => {};
          mesh.add(line);
        }

        if (scene.value) scene.value.add(model);
        modelGroup.value = model;
        // Normalize: center + uniform-scale to a 200-unit box.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const scale = 200 / maxDim;
        model.scale.setScalar(scale);
        const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
        model.position.sub(center);
        // Re-measure the normalized box for focus-zone placement.
        const normBox = new THREE.Box3().setFromObject(model);
        modelBox.value = normBox;

        focusZone("default");
      } catch (e) {
        errorMsg.value = (e as Error).message || String(e);
        toast.error(`3D model failed: ${errorMsg.value}`);
      } finally {
        loading.value = false;
      }
    }

    function disposeScene() {
      cancelAnimationFrame(rafId);
      focusTween = null;
      resizeObs?.disconnect();
      resizeObs = null;
      disposeArmorScene();
      const c = controls.value;
      const r = renderer.value;
      const sc = scene.value;
      c?.dispose();
      if (sc) {
        sc.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else if (mat) mat.dispose();
        });
      }
      if (r) {
        r.dispose();
        r.domElement.remove();
      }
      scene.value = camera.value = renderer.value = controls.value = null;
      modelGroup.value = null;
      modelBox.value = null;
      uniforms.value = null;
      armorGroup.value = null;
      showArmor.value = false;
      disposeArmorScene();
    }

    onMounted(() => {
      // 3D is the default; init immediately. (2D needs no scene.)
      if (viewMode.value === "3d") {
        initScene();
        void loadModel();
      }
    });

    onBeforeUnmount(() => disposeScene());

    // Reload the model when the ship changes.
    watch(
      () => props.ship?.shipId,
      () => {
        if (viewMode.value === "3d") {
          // Remove the old model, then load the new one.
          if (modelGroup.value && scene.value) {
            scene.value.remove(modelGroup.value);
            modelGroup.value = null;
          }
          void loadModel();
        }
      },
    );

    // ── Focus zone highlight ─────────────────────────────────────────────
    let _activeGlows: THREE.Mesh[] = [];

    function clearGlows() {
      const sc = scene.value;
      for (const m of _activeGlows) {
        if (sc) sc.remove(m);
        (m.geometry as THREE.BufferGeometry).dispose();
        (m.material as THREE.Material).dispose();
      }
      _activeGlows = [];
    }

    function spawnGlow(pos: THREE.Vector3, radius: number, sc: THREE.Scene): THREE.Mesh {
      const geo = new THREE.SphereGeometry(radius, 16, 16);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec3 vNormal;
          uniform float uTime;
          void main() {
            float rim = 1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0)));
            rim = pow(rim, 1.8);
            float pulse = 0.55 + 0.45 * sin(uTime * 5.0);
            float alpha = rim * pulse * 0.55;
            gl_FragColor = vec4(0.35, 0.88, 1.0, alpha);
          }`,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      sc.add(mesh);
      return mesh;
    }

    function focusZone(zone: FocusZone, count = 1): void {
      const cam = camera.value;
      const ctrl = controls.value;
      const box = modelBox.value;
      if (!cam || !ctrl || !box) return;
      ctrl.autoRotate = false;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const len = size.x; // ship length (after normalize, ≈ up to 200)
      const half = len / 2;
      // Camera distance — closer than the default hero shot so weapon
      // details are visible. Scales with ship size.
      const dist = Math.max(size.x * 0.5, 120);
      const target = new THREE.Vector3(center.x, center.y, center.z);
      let camPos: THREE.Vector3;
      // View from starboard side, elevated ~35°, so turrets/guns on the
      // deck read clearly against the holographic hull.
      const el = 0.55; // ~32° elevation
      const az = 0.4;  // ~23° toward starboard
      switch (zone) {
        case "bow":
          // Focus on the forward third — main turrets live here.
          target.set(center.x + half * 0.55, center.y + size.y * 0.18, center.z);
          camPos = new THREE.Vector3(
            target.x + dist * 0.35,
            target.y + dist * el,
            target.z + dist * az,
          );
          break;
        case "stern":
          // Rear third — aft turrets, engine exhaust.
          target.set(center.x - half * 0.55, center.y + size.y * 0.18, center.z);
          camPos = new THREE.Vector3(
            target.x - dist * 0.35,
            target.y + dist * el,
            target.z + dist * az,
          );
          break;
        case "midship":
          // Center — secondaries, torpedo tubes, superstructure.
          target.set(center.x, center.y + size.y * 0.2, center.z);
          camPos = new THREE.Vector3(
            center.x,
            center.y + dist * el,
            center.z + dist * (az + 0.25),
          );
          break;
        case "deck":
          // Top-down-ish — AA mounts, rangefinders across the whole deck.
          target.set(center.x, center.y + size.y * 0.3, center.z);
          camPos = new THREE.Vector3(center.x, center.y + dist * 1.1, center.z + dist * 0.08);
          break;
        case "waterline":
          // Low-angle side view — torpedo belt, hull details.
          target.set(center.x - half * 0.3, center.y - size.y * 0.2, center.z);
          camPos = new THREE.Vector3(
            target.x - dist * 0.4,
            target.y + dist * 0.15,
            target.z + dist * 0.7,
          );
          break;
        default:
          // Starboard-bow "2 o'clock" vantage: ~60° azimuth from the bow
          // (the +X axis), elevated ~50° above the waterline so the deck
          // and superstructure both read. A high hero angle for the initial
          // holographic reveal. Spherical coords, X = bow, Z = starboard.
          {
            const az = Math.PI / 3; // 60° azimuth toward starboard (2 o'clock)
            const el = Math.PI * 0.28; // ~50° elevation (high vantage)
            const R = dist * 1.15;
            camPos = new THREE.Vector3(
              center.x + R * Math.cos(el) * Math.cos(az),
              center.y + R * Math.sin(el),
              center.z + R * Math.cos(el) * Math.sin(az),
            );
          }
      }
      tweenCamera(cam, ctrl, camPos, target, 700);
      // The `default` framing is the initial hero reveal — resume gentle
      // auto-rotation once the camera settles so the ship slowly turns. The
      // "start" listener on OrbitControls (set up in initScene) stops it as
      // soon as the user grabs the view. Explicit weapon-focus zones stay
      // non-rotating (autoRotate left off above).
      if (zone === "default") {
        const ctrlLocal = ctrl;
        window.setTimeout(() => {
          ctrlLocal.autoRotate = true;
        }, 750);
      }
    }

    function tweenCamera(
      cam: THREE.PerspectiveCamera,
      ctrl: OrbitControls,
      toPos: THREE.Vector3,
      toTarget: THREE.Vector3,
      ms: number,
    ) {
      const fromPos = cam.position.clone();
      const fromTarget = ctrl.target.clone();
      const start = performance.now();
      // Cancel any in-flight tween.
      focusTween = null;
      const step = (now: number) => {
        if (focusTween === null) return; // cancelled
        const k = Math.min(1, (now - start) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
        cam.position.lerpVectors(fromPos, toPos, e);
        ctrl.target.lerpVectors(fromTarget, toTarget, e);
        ctrl.update();
        if (k < 1) {
          focusTween = () => requestAnimationFrame(step);
          requestAnimationFrame(step);
        } else {
          focusTween = null;
        }
      };
      focusTween = () => requestAnimationFrame(step);
      requestAnimationFrame(step);
    }

    // Surface focusZone to the parent via the component's exposed object.
    if (inst) {
      (inst.exposed as { focusZone?: (zone: FocusZone) => void }) = { focusZone };
    }

    // ── View mode switch ──────────────────────────────────────────────────
    function setViewMode(mode: "2d" | "3d") {
      if (mode === viewMode.value) return;
      if (mode === "3d") {
        viewMode.value = "3d";
        // Wait for the container to render, then init.
        requestAnimationFrame(() => {
          initScene();
          void loadModel();
        });
      } else {
        disposeScene();
        viewMode.value = "2d";
      }
    }

    return () => {
      const ship = props.ship;
      return (
        <div class="ship-stage">
          <div
            class={["ship-stage__canvas", viewMode.value === "2d" ? "ship-stage__canvas--2d" : ""]}
            ref={containerRef}
          >
            {viewMode.value === "2d" ? (
              (() => {
                const img = ship ? resolveShipImage(ship.shipId, ship.images?.large) : null;
                return img ? (
                  <img class="ship-stage__2d-img" src={img} alt={ship?.name ?? ""} />
                ) : (
                  <div class="ship-stage__noimg">{t("ships.detail.noImage")}</div>
                );
              })()
            ) : null}
            {loading.value ? (
              <div class="ship-stage__overlay">
                <SSpinner center size="md" />
              </div>
            ) : null}
            {errorMsg.value ? (
              <div class="ship-stage__overlay ship-stage__overlay--error">{errorMsg.value}</div>
            ) : null}
          </div>

          <div class="ship-stage__controls">
            <span class="ship-stage__hint">
              {viewMode.value === "3d" ? t("ships.detail.stage.hint3d") : ""}
            </span>
            <label
              class={["ship-stage__armor-toggle", showArmor.value ? "ship-stage__armor-toggle--on" : ""]}
              onClick={toggleArmor}
              title={t("ships.detail.armor.toggle")}
            >
              <span class="ship-stage__armor-icon">&#x1f6e1;</span>
              <span class="ship-stage__armor-label">{t("ships.detail.armor.short")}</span>
            </label>
            <SSegmented
              modelValue={viewMode.value}
              onUpdate:modelValue={(v: string) => setViewMode(v as "2d" | "3d")}
              options={[
                { value: "3d", label: "3D" },
                { value: "2d", label: "2D" },
              ]}
            />
          </div>
        </div>
      );
    };
  },
});
