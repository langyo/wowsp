import {
  defineComponent,
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { computeSmoothNormals } from "@/features/holographic/smoothNormals";
import { Pause, Play, RotateCcw, X } from "@lucide/vue";

import { HSpinner, HTabs, useBreakpoint, useToast } from "@celestia-island/hikari";
import { useImage } from "@wowsp/holo";
import { isModelPackReady, initModelPack, resolveShipModelByShipId, resolveFallbackModel, loadGlbModel, type ShipModelSpec } from "@/features/holographic/modelLoader";
import { api } from "@/api";
import { makeHoloMaterial as sharedMakeHoloMaterial, makeHoloDepthMaterial, tickHoloUniforms, type HoloUniforms } from "@/features/holographic/holoShader";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { isMobileApp } from "@/utils/platform";
import { resolveShipImage } from "@/utils/shipImages";
import { t, i18n } from "@/i18n";
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

// ── Armor thickness scale ────────────────────────────────────────────────
// Mirrors the exporter's ARMOR_COLOR_SCALE (wowsunpack gltf_export.rs) —
// the authoritative table baked into the *_armor.glb vertex colors. Each
// entry: (maxThickness_mm, r, g, b); assignment uses bisect_left.
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
const ARMOR_UNKNOWN_COLOR = 0xcccccc; // light grey for unknown thickness

function armorColor(mm: number): number {
  if (mm <= 0) return ARMOR_UNKNOWN_COLOR;
  const [r, g, b] = ARMOR_SCALE.find(([bp]) => mm <= bp) ?? ARMOR_SCALE[ARMOR_SCALE.length - 1];
  return (r << 16) | (g << 8) | b;
}

/** Legend rows for the color axis — one per bucket, evenly divided. */
const ARMOR_LEGEND = ARMOR_SCALE.map(([max, r, g, b], i) => {
  const min = i === 0 ? null : ARMOR_SCALE[i - 1][0];
  const hex = (r << 16) | (g << 8) | b;
  return {
    hex,
    css: legendCss(hex),
    label: min == null ? `≤ ${max}` : i === ARMOR_SCALE.length - 1 ? `${min}+` : `${min} – ${max}`,
    range: `${min ?? 1} – ${max} mm`,
  };
});

/** CSS color matching how a baked vertex color RENDERS: three treats vertex
 *  colors as linear-sRGB and the renderer encodes output to sRGB, so raw
 *  palette values would read visibly darker than the plates on screen. */
function legendCss(hex: number): string {
  const ch = (c: number) => {
    const v = c / 255;
    const enc = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(255 * enc);
  };
  return `rgb(${ch((hex >> 16) & 255)} ${ch((hex >> 8) & 255)} ${ch(hex & 255)})`;
}

/** Bucket index (into ARMOR_SCALE) for a baked 0xRRGGBB vertex color. */
const armorBucketByRgb = new Map<number, number>(ARMOR_LEGEND.map((s, i) => [s.hex, i]));
/** Sentinel bucket for plates with no game thickness (exporter bakes them
 *  light grey) — kept out of the legend and not class-hideable. */
const ARMOR_BUCKET_UNKNOWN = 0xffff;
function armorBucketForRgb(rgb: number): number {
  if (rgb === ARMOR_UNKNOWN_COLOR) return ARMOR_BUCKET_UNKNOWN;
  const hit = armorBucketByRgb.get(rgb);
  if (hit != null) return hit;
  // Off-palette color: nearest bucket by channel distance.
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  let best = ARMOR_LEGEND.length - 1;
  let bestD = Infinity;
  ARMOR_LEGEND.forEach((s, i) => {
    const d = (((s.hex >> 16) & 255) - r) ** 2 + (((s.hex >> 8) & 255) - g) ** 2 + ((s.hex & 255) - b) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** Invisible depth anchor shared by every holographic mesh: colorWrite off,
 *  so it renders in the opaque queue first and only fills the depth buffer.
 *  The transparent holo pass then depth-tests against it. It MUST share the
 *  holo material's vertex shader — a different vertex pipeline (e.g. a
 *  MeshBasicMaterial's CPU-premultiplied modelViewMatrix) rounds depth
 *  differently, and the depth test then rejects arbitrary whole triangles
 *  ("half the hull missing"). See makeHoloDepthMaterial. */
const ShipStageDepthMaterial = makeHoloDepthMaterial();

/** userData bookkeeping written onto armor overlay meshes. */
interface ArmorMeshUserData {
  /** Heuristic zone boxes: raw zone name ("deck"). */
  zone?: string;
  /** Heuristic zone boxes: zone thickness in mm (0 if unknown). */
  thickness?: number;
  /** Baked GLBs: draw-group slot → ARMOR_SCALE bucket index. */
  armorBuckets?: number[];
  /** Baked GLBs: triangle index → bucket index (raycast lookup). */
  armorTriBucket?: Uint16Array;
  /** Heuristic zone boxes: stable key ("z:deck"). */
  armorZoneKey?: string;
  /** Material(s) to restore on un-hide. */
  armorBaseMat?: THREE.Material | THREE.Material[];
}

/** Shared "hidden" look for armor parts toggled off (grey ghost). */
const armorHiddenMat = new THREE.MeshBasicMaterial({
  color: 0x9aa3ae,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
});

/** Regroup a baked armor mesh's triangles by thickness bucket: the index
 *  buffer is reordered bucket-ascending and one draw group (material slot)
 *  is declared per bucket, so each thickness class can be swapped to the
 *  hidden material independently. Returns the raycast/lookup tables. */
function splitArmorMeshByBucket(
  mesh: THREE.Mesh,
): { triBucket: Uint16Array; buckets: number[] } | null {
  const geo = mesh.geometry;
  const color = geo.getAttribute("color");
  const index = geo.getIndex();
  if (!color || !index || index.count % 3 !== 0) return null;

  const triCount = index.count / 3;
  const triBucket = new Uint16Array(triCount);
  const bucketSet = new Set<number>();
  for (let f = 0; f < triCount; f++) {
    const v = index.getX(f * 3);
    const rgb =
      (Math.round(color.getX(v) * 255) << 16) |
      (Math.round(color.getY(v) * 255) << 8) |
      Math.round(color.getZ(v) * 255);
    const bucket = armorBucketForRgb(rgb);
    triBucket[f] = bucket;
    bucketSet.add(bucket);
  }

  const buckets = [...bucketSet].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (const bucket of triBucket) counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  const slotOf = new Map<number, number>(buckets.map((b, i) => [b, i]));
  // Per-slot write cursors and group start offsets.
  const cursor = buckets.map(() => 0);
  const startAt: number[] = [];
  let acc = 0;
  for (const b of buckets) { startAt.push(acc); acc += counts.get(b) ?? 0; }

  const srcIndex = index;
  // Reorder the index buffer bucket-ascending; the per-triangle bucket table
  // must be reordered alongside it so raycast faceIndex (which addresses the
  // NEW triangle order) maps back to the right class.
  const newTriBucket = new Uint16Array(triCount);
  const newIndex = new (srcIndex.array.constructor as new (n: number) => typeof srcIndex.array)(srcIndex.count);
  for (let f = 0; f < triCount; f++) {
    const slot = slotOf.get(triBucket[f])!;
    const w = startAt[slot] + cursor[slot]++;
    newTriBucket[w] = triBucket[f];
    newIndex[w * 3] = srcIndex.getX(f * 3);
    newIndex[w * 3 + 1] = srcIndex.getX(f * 3 + 1);
    newIndex[w * 3 + 2] = srcIndex.getX(f * 3 + 2);
  }
  // Release the replaced index's GPU buffer (geometry.dispose only frees the
  // CURRENT index attribute, so the old one would leak across rebuilds).
  srcIndex.dispose();
  geo.setIndex(new THREE.BufferAttribute(newIndex, 1));
  geo.clearGroups();
  for (let i = 0; i < buckets.length; i++) {
    geo.addGroup(startAt[i] * 3, (counts.get(buckets[i]) ?? 0) * 3, i);
  }
  return { triBucket: newTriBucket, buckets };
}

export default defineComponent({
  name: "ShipStage",
  props: {
    ship: { type: Object as () => ShipInfo | null, required: true },
    armorZones: { type: Array as () => ArmorZone[], default: () => [] },
    waterlineDraft: { type: Number as () => number | null, default: null },
    /** Collapse the stage (water-table contexts open the modal with the
     *  hologram hidden): the canvas unmounts and only the control row —
     *  3D/2D toggle + this visibility switch — remains. */
    hidden: { type: Boolean, default: false },
  },
  emits: {
    // Underscore param keeps the payload type in Vue's TSX inference while
    // satisfying the unused-param lint.
    "update:hidden": (_v: boolean) => true,
  },
  // `focusZone` is stashed on the instance from inside setup() and surfaced
  // here via `exposed` so parents can call stageRef.value?.focusZone(...).
  // (setup() returns a render fn, not a state object, so this is the route.)
  exposed: {} as { focusZone?: (zone: FocusZone) => void },
  setup(props, { emit }) {
    const inst = getCurrentInstance();
    const toast = useToast();
    const containerRef = ref<HTMLElement | null>(null);
    const viewMode = ref<"2d" | "3d">("3d");
    const loading = ref(false);
    /** Set while the model pack downloads after a 3D toggle on a lite install. */
    const modelPackDownloading = ref(false);
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
    // Layout-aware gesture hint: the desktop hint names mouse-only affordances
    // (scroll zoom, right-drag pan) — touch users get the touch wording.
    const { isMobile } = useBreakpoint();
    /** Generation token for syncArmorOverlay: the async GLB load must not
     *  commit state if a newer sync (or a teardown) superseded it. */
    let armorSyncGen = 0;
    let gridRef: THREE.GridHelper | null = null;
    const _waterlinePlane: THREE.Mesh | null = null;

    // 2D fallback portrait: tracked via the shared useImage hook so a failed
    // CDN image lands in the same graceful noimg block as a missing one.
    const img2d = useImage(() =>
      props.ship ? resolveShipImage(props.ship.shipId, props.ship.images?.large) : null,
    );

    /** Whether the camera turntable is running. Single source of truth for the
     *  toolbar's play/pause button: OrbitControls' own "start" listener clears
     *  it when the user grabs the view, and a weapon focus parks it, so the
     *  icon always matches what the camera is actually doing. */
    const autoRotate = ref(true);
    function setAutoRotate(on: boolean) {
      autoRotate.value = on;
      const c = controls.value;
      if (c) c.autoRotate = on;
    }

    // No holo↔armor auto-cycle here. In a detail modal an unprompted flip
    // every ~15s reads as "the mode I picked reverted" — and while the armor
    // rebuild is in flight the toggle no longer matches the scene. Both modes
    // are strictly user-driven through the 全息/装甲 switch.

    /** Deep-dispose a detached group's geometries + materials. */
    function disposeGroupDeep(g: THREE.Group) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
      });
    }

    function disposeArmorScene() {
      // Any in-flight sync is now stale — including the "armour off" path,
      // where a late GLB load must not commit against showArmor=false.
      armorSyncGen++;
      const g = armorGroup.value;
      const sc = scene.value;
      if (g && sc) sc.remove(g);
      if (g) disposeGroupDeep(g);
      armorGroup.value = null;
      armorReady.value = false;
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
      // coloured armour boxes, and a waterline plane. disposeArmorScene
      // bumps the generation (invalidating any in-flight sync); claim the
      // NEW generation after it.
      disposeArmorScene();
      const gen = ++armorSyncGen;

      // Hide the main model — the armour group replaces it visually.
      model.visible = false;

      const armorSc = new THREE.Group();
      armorSc.name = "armor-scene";

      // Load the pre-baked armor GLB (per-vertex coloured from game data).
      if (props.ship) {
        const armorUrl = resolveShipModelByShipId(props.ship.shipId, undefined)?.replace(/\.glb$/, "_armor.glb") ?? null;
        if (armorUrl) {
          try {
            const armorModel = await loadGlbModel(armorUrl);
            // Superseded mid-load (toggle / rebuild / teardown): the newer
            // sync owns the scene — drop this load, touching nothing.
            if (gen !== armorSyncGen) {
              armorModel.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) mesh.geometry?.dispose();
              });
              return;
            }
            if (armorModel) {
              armorModel.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) {
                  const geo = mesh.geometry;
                  const mat = new THREE.MeshBasicMaterial({
                    vertexColors: (geo.getAttribute('color') != null),
                    side: THREE.DoubleSide,
                    transparent: true,
                    opacity: 0.85,
                    // Opaque-like compositing: nearer plates must occlude
                    // farther ones (the game's own armor view does the same).
                    // With depthWrite off, every interior face blends through
                    // and the wash of summed layers hides the real thickness.
                    depthWrite: true,
                  });
                  mesh.material = mat;
                  mesh.renderOrder = 1;
                  // Split the mesh into thickness classes so each bucket can
                  // be hidden independently (and hit-tested via raycast).
                  const split = splitArmorMeshByBucket(mesh);
                  if (split) {
                    const ud = mesh.userData as ArmorMeshUserData;
                    ud.armorBuckets = split.buckets;
                    ud.armorTriBucket = split.triBucket;
                    ud.armorBaseMat = mat;
                    mesh.material = split.buckets.map(() => mat);
                  }
                  // Armor GLBs come from wowsunpack in the game's own
                  // orientation (bow at -Z), while visual GLBs from
                  // wows-gltf-exporter face bow at +Z — rotate 180° about Y so
                  // the two models face the same way. The rotation must live
                  // on the mesh node: the reparent below keeps only the local
                  // transform, and any group-level transform would be dropped.
                  mesh.rotation.y = Math.PI;
                  armorSc.add(mesh);
                }
              });
              // Match the main model's normalized frame (200-unit box centred
              // on the origin) so holo ↔ armor toggling doesn't rescale the
              // camera subject.
              const box = new THREE.Box3().setFromObject(armorSc);
              const size = box.getSize(new THREE.Vector3());
              const maxDim = Math.max(size.x, size.y, size.z, 1);
              const scale = 200 / maxDim;
              armorSc.scale.setScalar(scale);
              armorSc.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(scale));
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

      if (armorSc.children.length === 0) {
        // Nothing resolvable (no baked GLB, no zones): nothing to legend or pick.
        for (const key of hiddenArmorKeys.value) if (key.startsWith("z:")) hiddenArmorKeys.value.delete(key);
        armorReady.value = false;
        // ...and no class to solo, so drop any isolation the caller had on.
        soloBucket.value = null;
        // Keep the plain hologram visible instead of an empty stage.
        model.visible = true;
        return;
      }

      // Superseded while the fallback path built (or a newer rebuild started):
      // drop this group untouched.
      if (gen !== armorSyncGen) {
        disposeGroupDeep(armorSc);
        return;
      }

      sc.add(armorSc);
      armorGroup.value = armorSc;
      armorReady.value = true;
      // Re-apply the hide/solo state after the rebuild (rebuilds happen on a
      // manual holo↔armor switch and on ship-zone changes).
      applyArmorVisibility();
    }

    function setArmor(on: boolean) {
      if (showArmor.value === on) return;
      showArmor.value = on;
      syncArmorOverlay();
    }

    watch(
      () => [props.armorZones?.length ?? 0, modelGroup.value != null] as const,
      () => { if (showArmor.value) syncArmorOverlay(); },
    );

    // ── Armor color axis + class isolation ────────────────────────────────
    /** Whether the armor overlay actually has content to show (baked GLB or
     *  heuristic zones) — gates the legend and the hidden-parts panel. */
    const armorReady = ref(false);
    /** Thickness classes / zone boxes currently toggled off. Keys: "b3"
     *  (ARMOR_SCALE bucket) or "z:deck" (heuristic zone box). Re-applied on
     *  every overlay rebuild; cleared on ship change and scene teardown. */
    const hiddenArmorKeys = ref<Set<string>>(new Set());
    /** Soloed thickness class ("只看该厚度"): clicking a legend swatch shows
     *  that class alone, clicking it again shows everything. Independent of
     *  the per-class hides above — both feed applyArmorVisibility(). */
    const soloBucket = ref<number | null>(null);

    const hiddenArmorChips = computed(() => {
      const chips: { key: string; label: string; css: string }[] = [];
      for (const key of hiddenArmorKeys.value) {
        const chip = resolveArmorChip(key);
        if (chip) chips.push(chip);
      }
      return chips;
    });
    /** The soloed class as a chip, so the state is visible and clearable next
     *  to the hidden ones (a solo has no entry in hiddenArmorKeys). */
    const soloChip = computed(() => {
      const i = soloBucket.value;
      const entry = i == null ? null : ARMOR_LEGEND[i];
      return entry ? { label: `${t("ships.detail.armor.solo")} ${entry.label}`, css: entry.css } : null;
    });
    /** Classes effectively hidden right now (explicit hides + solo's dump) —
     *  drives the restore button's count. */
    const armorHiddenCount = computed(
      () => hiddenArmorChips.value.length + (soloChip.value ? ARMOR_LEGEND.length - 1 : 0),
    );

    /** Chip metadata for a hidden-part key, derived from the legend table or
     *  the zone boxes currently in the overlay. */
    function resolveArmorChip(key: string): { key: string; label: string; css: string } | null {
      if (key.startsWith("b")) {
        const entry = ARMOR_LEGEND[Number(key.slice(1))];
        return entry ? { key, label: entry.label, css: entry.css } : null;
      }
      if (key.startsWith("z:")) {
        const zone = key.slice(2);
        let thickness = 0;
        armorGroup.value?.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && (m.userData as ArmorMeshUserData).armorZoneKey === key) {
            thickness = (m.userData as { thickness?: number }).thickness ?? 0;
          }
        });
        const nameKey = `ships.detail.armor.zone.${zone}`;
        // Dynamic key paths blow up vue-i18n's schema inference — go through
        // plain signatures.
        const hasZone = (i18n.global.te as (k: string) => boolean)(nameKey);
        const label = hasZone ? (t as (k: string) => string)(nameKey) : zone;
        return { key, label, css: legendCss(armorColor(thickness)) };
      }
      return null;
    }

    /** Whether a class/zone renders greyed out: explicitly hidden, or excluded
     *  by the soloed thickness class. */
    function isArmorHidden(key: string, bucket: number): boolean {
      if (hiddenArmorKeys.value.has(key)) return true;
      return soloBucket.value != null && bucket !== soloBucket.value;
    }

    /** Push the current hide/solo state onto every armor mesh — the single
     *  place that decides what is grey, so a hide toggle and a solo can never
     *  disagree about a slot. Baked GLBs carry one material slot per thickness
     *  class; the heuristic fallback carries one mesh per zone box. */
    function applyArmorVisibility() {
      armorGroup.value?.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const ud = mesh.userData as ArmorMeshUserData;
        if (ud.armorBuckets && Array.isArray(mesh.material)) {
          const mats = mesh.material as THREE.Material[];
          ud.armorBuckets.forEach((bucket, slot) => {
            mats[slot] = isArmorHidden(`b${bucket}`, bucket)
              ? armorHiddenMat
              : (ud.armorBaseMat as THREE.Material);
          });
        } else if (ud.armorZoneKey) {
          // Zone boxes have no draw-group slot: their thickness maps back to a
          // class so solo isolates them the same way.
          const bucket = armorBucketForRgb(armorColor(ud.thickness ?? 0));
          const hidden = isArmorHidden(ud.armorZoneKey, bucket);
          mesh.material = hidden ? armorHiddenMat : (ud.armorBaseMat as THREE.Material);
          // The highlight edges are children of the box — fade them with it.
          for (const child of mesh.children) {
            if ((child as THREE.LineSegments).isLineSegments) child.visible = !hidden;
          }
        }
      });
    }

    /** Click on a legend swatch: show only that thickness class; clicking the
     *  same swatch again (or 还原) brings every class back. */
    function toggleArmorSolo(index: number) {
      soloBucket.value = soloBucket.value === index ? null : index;
      applyArmorVisibility();
    }

    function toggleArmorPart(key: string) {
      const on = !hiddenArmorKeys.value.has(key);
      if (on) hiddenArmorKeys.value.add(key);
      else hiddenArmorKeys.value.delete(key);
      // New Set identity so the computed chip list re-runs.
      hiddenArmorKeys.value = new Set(hiddenArmorKeys.value);
      applyArmorVisibility();
    }

    function restoreArmorParts() {
      hiddenArmorKeys.value = new Set();
      soloBucket.value = null;
      applyArmorVisibility();
    }

    // ── Canvas picking (click to hide, hover cursor) ──────────────────────
    const _raycaster = new THREE.Raycaster();
    const _ndc = new THREE.Vector2();

    /** Topmost armor part under the pointer, or null. */
    function pickArmorPart(clientX: number, clientY: number): string | null {
      const g = armorGroup.value;
      const cam = camera.value;
      const rnd = renderer.value;
      if (!g || !cam || !rnd) return null;
      const rect = rnd.domElement.getBoundingClientRect();
      _ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_ndc, cam);
      const hits = _raycaster.intersectObjects(g.children, true);
      for (const hit of hits) {
        const mesh = hit.object as THREE.Mesh;
        if (!mesh.isMesh) continue;
        const ud = mesh.userData as ArmorMeshUserData;
        if (ud.armorTriBucket && hit.faceIndex != null) {
          const bucket = ud.armorTriBucket[hit.faceIndex];
          // No-thickness plates carry no legend color — let the pick fall
          // through to whatever is behind them.
          if (bucket === ARMOR_BUCKET_UNKNOWN) continue;
          return `b${bucket}`;
        }
        if (ud.armorZoneKey) return ud.armorZoneKey;
      }
      return null;
    }

    // Click-vs-drag: OrbitControls consumes drags, so only treat a press /
    // release pair that stayed within a few pixels as a pick.
    let downAt: { x: number; y: number } | null = null;
    let hoverRaf = 0;

    function onCanvasPointerDown(e: PointerEvent) {
      downAt = { x: e.clientX, y: e.clientY };
    }

    function onCanvasPointerUp(e: PointerEvent) {
      const down = downAt;
      downAt = null;
      if (!down || !showArmor.value || e.button !== 0) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const key = pickArmorPart(e.clientX, e.clientY);
      if (key) toggleArmorPart(key);
    }

    function onCanvasPointerMove(e: PointerEvent) {
      const rnd = renderer.value;
      if (!rnd) return;
      const setCursor = (c: string) => {
        if (rnd.domElement.style.cursor !== c) rnd.domElement.style.cursor = c;
      };
      if (!showArmor.value || e.buttons !== 0) {
        setCursor("");
        return;
      }
      if (hoverRaf) return;
      const { clientX, clientY } = e;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        setCursor(pickArmorPart(clientX, clientY) ? "pointer" : "");
      });
    }

    function detachCanvasListeners() {
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
      downAt = null;
      const dom = renderer.value?.domElement;
      if (dom) {
        dom.removeEventListener("pointerdown", onCanvasPointerDown);
        dom.removeEventListener("pointerup", onCanvasPointerUp);
        dom.removeEventListener("pointermove", onCanvasPointerMove);
      }
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
        box.userData = { zone: zoneName, thickness: mm, armorZoneKey: `z:${zoneName}`, armorBaseMat: mat } satisfies ArmorMeshUserData;
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
        box.userData = { zone: zoneName, thickness: mm, armorZoneKey: `z:${zoneName}`, armorBaseMat: mat } satisfies ArmorMeshUserData;
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
    /** Stops the applied-DPI watcher armed by initScene (null before). */
    let stopDpiWatch: (() => void) | null = null;
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
      // The root's CSS `zoom` (theme/dpiPrefs DPI preference) enlarges the
      // canvas element visually WITHOUT adding backing-store pixels — scale
      // the pixel ratio by the applied zoom so the stage stays crisp at
      // non-Auto scales; stopDpiWatch below re-runs this on changes
      // (setPixelRatio re-applies the current buffer size internally).
      const dpiZoom = useAppliedDpiScale();
      rnd.setPixelRatio(Math.min(window.devicePixelRatio, 2) * dpiZoom.value);
      stopDpiWatch = watch(dpiZoom, (zoom) => {
        rnd.setPixelRatio(Math.min(window.devicePixelRatio, 2) * zoom);
      });
      rnd.setSize(w, h);
      el.appendChild(rnd.domElement);
      // Armor-mode picking: click to toggle a thickness class, hover to hint.
      rnd.domElement.addEventListener("pointerdown", onCanvasPointerDown);
      rnd.domElement.addEventListener("pointerup", onCanvasPointerUp);
      rnd.domElement.addEventListener("pointermove", onCanvasPointerMove);

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
      // The user's last choice survives scene rebuilds (2D↔3D, hide/show).
      ctrl.autoRotate = autoRotate.value;
      ctrl.autoRotateSpeed = 0.5;
      // Grabbing the view stops the turntable — and the toolbar button follows,
      // because the ref is the single source of truth for the button's state.
      ctrl.addEventListener("start", () => {
        autoRotate.value = false;
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

    // Wire the model-pack cache root locally before model URLs can resolve.
    // The production dist prunes bundled GLBs, and the shell's startup
    // wiring is gated behind the updater's delayed probe — an early-opened
    // stage would otherwise commit the no-model placeholder for a pack
    // that is sitting on disk. Falls through silently when the pack is
    // genuinely absent (setViewMode offers the download flow then).
    async function ensurePackWired(): Promise<void> {
      if (isModelPackReady()) return;
      try {
        const root = await api.resCacheRoot();
        if (root) await initModelPack(async () => root);
      } catch {
        // Older shell without the command / IPC unavailable.
      }
    }

    async function loadModel() {
      const ship = props.ship;
      if (!ship) return;
      await ensurePackWired();
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
            // The baked collision shells ship POSITION only and their triangle
            // winding is essentially random (~72% of shared edges disagree),
            // so any winding-trusting normal shades the hull as per-triangle
            // patches under the holographic lighting. Rebuild winding-agnostic
            // crease-aware normals for EVERY mesh: continuous panel runs share
            // a normal, hard chines stay split. The crease angle must sit
            // ABOVE the mesh's quantization step (~30–50° between adjacent
            // faces on a curved region) and BELOW the real edges (~90° chine,
            // deck-to-side, box corners); at 80° curved runs merge into one
            // smooth cluster. Attributes other than position are stripped
            // BEFORE the weld — mergeVertices only fuses vertices whose
            // attributes all match — except the armour thickness vertex
            // colours, which must survive for the armor overlay.
            const welded = mesh.geometry.clone();
            for (const attr of Object.keys(welded.attributes)) {
              if (attr !== "position" && attr !== "color") welded.deleteAttribute(attr);
            }
            welded.morphAttributes = {};
            mesh.geometry = computeSmoothNormals(mergeVertices(welded, 1e-4), 80);
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

        /** Instance-suffixed bake names ("main_battery_249") still colour by
         *  their category prefix, so every turret looks the same while
         *  remaining individually addressable. */
        function categoryBase(name: string): string {
          for (const key of Object.keys(PRESET_HUES)) {
            if (name === key || name.startsWith(`${key}_`)) return key;
          }
          return name;
        }

        function colorForCategory(name: string): { base: THREE.Color; fresnel: THREE.Color } {
          name = categoryBase(name);
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
          return {
            base: new THREE.Color().setHSL(hue / 360, sat, lit),
            fresnel: new THREE.Color().setHSL(hue / 360, sat * 0.85, Math.min(lit * 2.0, 0.85)),
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

          // Depth anchor: the holo material is transparent and writes no
          // depth, so without an opaque anchor every interior / far-side face
          // paints over the near hull (draw order decides — the classic
          // "faces poking through the hull" artifact). An invisible
          // colorWrite-off twin renders in the opaque queue first, and the
          // transparent pass depth-tests against it: nearer surfaces now
          // occlude farther ones while the ghost layering is preserved.
          const depthAnchor = new THREE.Mesh(
            mesh.geometry,
            ShipStageDepthMaterial,
          );
          depthAnchor.renderOrder = WEAPON_NAMES.has(name) ? 1 : 0;
          mesh.add(depthAnchor);

          // No structural-edge overlay: the baked hull is a coarse mesh, so an
          // 8° crease threshold catches nearly every plate boundary and the
          // line network reads as bright triangle edges drawn over the faces.
          // Recolouring it to the part's own hue does not hide it either — the
          // faces vary with Fresnel, so a constant-colour line still stands out.
          // The shader's rim light already carries the shape; the silhouette
          // comes from the geometry itself.
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
      stopDpiWatch?.();
      stopDpiWatch = null;
      resizeObs?.disconnect();
      resizeObs = null;
      detachCanvasListeners();
      disposeArmorScene();
      hiddenArmorKeys.value = new Set();
      soloBucket.value = null;
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
      // 3D is the default; init immediately. (2D needs no scene.) A hidden
      // stage skips the scene entirely — it initializes on re-show.
      if (!props.hidden && viewMode.value === "3d") {
        initScene();
        void loadModel();
      }
    });

    // Re-show initialization frame handle — cancelled on unmount/re-hide so a
    // late callback can't init a scene (or start a model download) against a
    // dead or re-hidden stage.
    let showRafId = 0;

    onBeforeUnmount(() => {
      cancelAnimationFrame(showRafId);
      disposeScene();
    });

    // Reload the model when the ship changes.
    watch(
      () => props.ship?.shipId,
      () => {
        // Hidden thickness classes are per-ship — a new hull starts clean.
        restoreArmorParts();
        if (viewMode.value === "3d" && !props.hidden) {
          // Remove the old model, then load the new one.
          if (modelGroup.value && scene.value) {
            scene.value.remove(modelGroup.value);
            modelGroup.value = null;
          }
          void loadModel();
        }
      },
    );

    // Collapse/expand: hiding tears the WebGL scene down (no hidden RAF loop,
    // no GPU cost); re-showing re-creates it. The 2D portrait needs nothing —
    // it lives in the template.
    watch(
      () => props.hidden,
      (hidden) => {
        cancelAnimationFrame(showRafId);
        if (hidden) {
          disposeScene();
        } else if (viewMode.value === "3d") {
          showRafId = requestAnimationFrame(() => {
            if (props.hidden || viewMode.value !== "3d") return;
            initScene();
            void loadModel();
          });
        }
      },
    );


    function focusZone(zone: FocusZone): void {
      const cam = camera.value;
      const ctrl = controls.value;
      const box = modelBox.value;
      if (!cam || !ctrl || !box) return;
      // Park the turntable for the flight. The ref (the toolbar's state) is
      // left alone here: the default hero reveal resumes it after the tween,
      // a region focus clears it below.
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
      // soon as the user grabs the view; the toolbar's play/pause button puts
      // it back. Explicit weapon-focus zones stay parked.
      if (zone === "default") {
        const ctrlLocal = ctrl;
        window.setTimeout(() => {
          // Stay parked if the turntable was paused meanwhile (a drag or the
          // toolbar button) — the ref records that intent.
          if (autoRotate.value) ctrlLocal.autoRotate = true;
        }, 750);
      } else {
        // Region focus: parked for good, and the toolbar says so.
        setAutoRotate(false);
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
    async function setViewMode(mode: "2d" | "3d") {
      if (mode === viewMode.value) return;
      if (mode === "3d") {
        // Hidden stage: just record the mode — the scene (and any on-demand
        // model-pack download) initializes when the stage is re-shown.
        if (props.hidden) {
          viewMode.value = "3d";
          return;
        }
        // An on-disk pack wires silently via the same local probe loadModel
        // uses; only a genuinely missing pack falls through to the on-demand
        // download (lite installs — the installer's done pane offers the same
        // download up front). The phone build never reaches the download:
        // its pack ships in the APK and loads same-origin without wiring a
        // cache root (Settings → updates is the only mobile download path).
        if (!isModelPackReady() && !isMobileApp()) await ensurePackWired();
        if (!isModelPackReady() && !isMobileApp()) {
          if (modelPackDownloading.value) return;
          modelPackDownloading.value = true;
          toast.show(t("ships.model3d.downloadStart"));
          try {
            await initModelPack(() => api.ensureResPack());
            toast.success(t("ships.model3d.ready"));
          } catch {
            toast.error(t("ships.model3d.failed"));
            modelPackDownloading.value = false;
            return;
          }
          modelPackDownloading.value = false;
        }
        viewMode.value = "3d";
        // Wait for the container to render, then init. Routed through
        // showRafId (cancelled by the hidden-watch) and guarded against
        // re-entry so a double toggle can't create two GL contexts.
        showRafId = requestAnimationFrame(() => {
          if (props.hidden || viewMode.value !== "3d" || renderer.value) return;
          initScene();
          void loadModel();
        });
      } else {
        // 2D has no scene: tear the WebGL side down (disposeScene also resets
        // showArmor, so the next 3D session starts on the hologram).
        disposeScene();
        viewMode.value = "2d";
      }
    }

    return () => {
      const ship = props.ship;
      return (
        <div class={["ship-stage", props.hidden ? "ship-stage--hidden" : ""]}>
          {props.hidden ? null : (
            <div
              class={["ship-stage__canvas", viewMode.value === "2d" ? "ship-stage__canvas--2d" : ""]}
              ref={containerRef}
            >
              {viewMode.value === "2d" && img2d.src.value && img2d.status.value !== "error" ? (
                <img
                  class={["ship-stage__2d-img", "image-asset__img", img2d.status.value === "loaded" ? "is-loaded" : ""].join(" ")}
                  key={img2d.key.value}
                  src={img2d.src.value}
                  alt={ship?.name ?? ""}
                  onLoad={img2d.onLoad}
                  onError={img2d.onError}
                />
              ) : viewMode.value === "2d" ? (
                <div class="ship-stage__noimg">{t("ships.detail.noImage")}</div>
              ) : null}
              {loading.value ? (
                <div class="ship-stage__overlay">
                  <HSpinner center size="md" />
                </div>
              ) : null}
              {errorMsg.value ? (
                <div class="ship-stage__overlay ship-stage__overlay--error">{errorMsg.value}</div>
              ) : null}
              {viewMode.value === "3d" && showArmor.value && armorReady.value ? (
                <>
                  {/* Armor thickness color axis — one evenly divided segment
                      per game color bucket. Clicking a swatch isolates that
                      thickness class ("只看"); the ruler numbers below sit at
                      the seams between classes. */}
                  <div class="ship-stage__armor-axis">
                    <span class="ship-stage__armor-axis-title">
                      {t("ships.detail.armor.legend")}
                      <span class="ship-stage__armor-axis-hint"> · {t("ships.detail.armor.pickHint")}</span>
                    </span>
                    <div class="ship-stage__armor-axis-band" role="group" aria-label={t("ships.detail.armor.legend")}>
                      {ARMOR_LEGEND.map((s, i) => (
                        <button
                          type="button"
                          key={s.label}
                          class={["ship-stage__armor-swatch", soloBucket.value === i ? "is-solo" : ""].join(" ")}
                          style={{ background: s.css }}
                          title={`${s.range} · ${t("ships.detail.armor.solo")}`}
                          aria-pressed={soloBucket.value === i}
                          onClick={() => toggleArmorSolo(i)}
                        />
                      ))}
                    </div>
                    {/* Ruler-style: one number at each swatch boundary — a
                        color spans the gap between its neighbours' numbers. */}
                    <div class="ship-stage__armor-axis-ticks">
                      {ARMOR_SCALE.slice(0, -1).map(([bp], i) => (
                        <span
                          key={bp}
                          title={String(bp)}
                          style={{ left: `${(((i + 1) / ARMOR_SCALE.length) * 100).toFixed(2)}%` }}
                        >
                          {bp}
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* Hidden classes (chips, click to restore one) + the soloed
                      class, above a restore-all button, bottom right. */}
                  {hiddenArmorChips.value.length > 0 || soloChip.value ? (
                    <div class="ship-stage__armor-hidden">
                      <div class="ship-stage__armor-hidden-chips">
                        {soloChip.value ? (
                          <button
                            type="button"
                            class="ship-stage__armor-chip is-solo"
                            title={soloChip.value.label}
                            onClick={() => toggleArmorSolo(soloBucket.value ?? 0)}
                          >
                            <span class="ship-stage__armor-chip-swatch" style={{ background: soloChip.value.css }} />
                            <span>{soloChip.value.label}</span>
                            <X size={11} strokeWidth={2.4} />
                          </button>
                        ) : null}
                        {hiddenArmorChips.value.map((c) => (
                          <button
                            type="button"
                            key={c.key}
                            class="ship-stage__armor-chip"
                            title={c.label}
                            onClick={() => toggleArmorPart(c.key)}
                          >
                            <span class="ship-stage__armor-chip-swatch" style={{ background: c.css }} />
                            <span>{c.label}</span>
                            <X size={11} strokeWidth={2.4} />
                          </button>
                        ))}
                      </div>
                      <button type="button" class="ship-stage__armor-restore" onClick={restoreArmorParts}>
                        <RotateCcw size={12} strokeWidth={2.2} />
                        <span>{t("ships.detail.armor.restore")}</span>
                        <span class="ship-stage__armor-restore-count">{armorHiddenCount.value}</span>
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          )}

          <div class="ship-stage__controls">
            {/* While collapsed, everything but the visibility switch hides:
                with a dedicated show/hide button the 3D/2D group would just
                be noise on the slim bar. */}
            {!props.hidden ? (
              <>
                {viewMode.value === "3d" ? (
                  <span class="ship-stage__hint">
                    {t(isMobile.value ? "ships.detail.stage.hint3dTouch" : "ships.detail.stage.hint3d")}
                  </span>
                ) : null}
                {viewMode.value === "3d" ? (
                  <div class="ship-stage__rotate" role="group">
                    <button
                      type="button"
                      class={["ship-stage__rotate-btn", autoRotate.value ? "is-active" : ""].join(" ")}
                      title={autoRotate.value ? t("ships.detail.stage.rotateOn") : t("ships.detail.stage.rotateOff")}
                      aria-label={t("ships.detail.stage.rotate")}
                      aria-pressed={autoRotate.value}
                      onClick={() => setAutoRotate(!autoRotate.value)}
                    >
                      {autoRotate.value ? <Pause size={13} strokeWidth={2.2} /> : <Play size={13} strokeWidth={2.2} />}
                    </button>
                  </div>
                ) : null}
                {viewMode.value === "3d" ? (
                  <div class="ship-stage__armor-modes" role="group" aria-label={t("ships.detail.armor.toggle")}>
                    <button
                      type="button"
                      class={["ship-stage__armor-mode", !showArmor.value ? "is-active" : ""].join(" ")}
                      onClick={() => setArmor(false)}
                    >
                      {t("ships.detail.stage.holo")}
                    </button>
                    <button
                      type="button"
                      class={["ship-stage__armor-mode", showArmor.value ? "is-active" : ""].join(" ")}
                      onClick={() => setArmor(true)}
                    >
                      {t("ships.detail.armor.short")}
                    </button>
                  </div>
                ) : null}
                <HTabs
                  variant="segmented"
                  modelValue={viewMode.value}
                  onUpdate:modelValue={(v: string) => setViewMode(v as "2d" | "3d")}
                  tabs={[
                    { key: "3d", label: "3D" },
                    { key: "2d", label: "2D" },
                  ]}
                />
              </>
            ) : null}
            {/* Stage visibility switch — stays available even while hidden so
                the hologram can be brought back from the collapsed bar. */}
            <div class="ship-stage__vis" role="group">
              <button
                type="button"
                class={["ship-stage__vis-btn", props.hidden ? "" : "is-active"].join(" ")}
                onClick={() => emit("update:hidden", !props.hidden)}
                aria-pressed={!props.hidden}
              >
                {props.hidden ? t("ships.detail.stage.show") : t("ships.detail.stage.hide")}
              </button>
            </div>
          </div>
        </div>
      );
    };
  },
});
