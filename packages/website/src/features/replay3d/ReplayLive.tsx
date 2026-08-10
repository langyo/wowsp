import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import * as THREE from "three";
import {
  HoloClock, HoloScorebar, HoloLabel, drawHoloMinimap, registerHoloShipIcons,
  setMinimapArtImage, holoShipIconUrl, captureSpeedPerSec, captureSecondsRemaining, formatEta,
  makeShipHoloMaterial, makeTerrainHoloMaterial, tickHolo,
  type HoloBounds, type HoloCap, type HoloCapZone, type HoloHudState, type HoloShip,
  type HoloLabelData,
} from "@wowsp/holo";
import { loadGlb } from "./glb";
import shipTypes from "@/data/shipTypes.json";
import { ships as SHIP_DB, shipName } from "@/data/ships";
import "./ReplayLive.scss";

/** Compact per-entity track baked by scripts/bake_site_replay.py (1 Hz). */
interface Track { x: number[]; z: number[]; yaw: number[]; hp?: number[]; die?: number }
interface RosterEntry {
  e: number; name: string; shipZh: string; shipEn: string; model: string;
  rel: number;
}
interface CapZone {
  letter: string; x: number; z: number; initial: number;
  timeline: [number, number][];
}
interface BattleBundle {
  map: string; duration: number; dt: number;
  roster: RosterEntry[]; recorder: number;
  tracks: Record<string, Track>;
  torps: [number, number, number, number, number][];
  explosions: [number, number, number][];
  caps: CapZone[];
}

const SHIP_SCALE = 5.0;
const PLAYBACK_SPEED = 8;
const ROLE_COLOR = { self: 0xf5b85c, ally: 0x38bdf8, enemy: 0xf87171 } as const;
const MAP_BOUNDS: HoloBounds = { minX: -700, maxX: 700, minZ: -700, maxZ: 700 };
const CAP_RING_R = 90;

/** The game's own HUD ship icons (bundled with the site assets). */
const ICON_BASE = `${import.meta.env.BASE_URL}icons/ships`;
const ICON_CLASSES = ["battleship", "cruiser", "destroyer", "aircarrier", "submarine"] as const;
for (const variant of ["ally", "enemy", "sunk"] as const) {
  registerHoloShipIcons(
    variant,
    Object.fromEntries(ICON_CLASSES.map((c) => [c, `${ICON_BASE}/icon_${variant}_${c}.png`])),
  );
}

function roleOf(rel: number): keyof typeof ROLE_COLOR {
  return rel === 0 ? "self" : rel === 1 ? "ally" : "enemy";
}

function shipTypeOf(model: string): string {
  return (shipTypes as Record<string, string>)[model] ?? "Battleship";
}

/** Resolve the baked roster's model/code names ("PBSB106", "Nagato") to the
 *  real localized ship name via the full game roster (ships.json). */
const SHIP_BY_ID = new Map(SHIP_DB.map((s) => [s.id, s]));
const SHIP_BY_EN = new Map(SHIP_DB.map((s) => [s.n.en, s]));
function resolveShipName(model: string, fallback: string, locale: string): string {
  const entry = SHIP_BY_ID.get(model) ?? SHIP_BY_EN.get(model) ?? SHIP_BY_EN.get(fallback);
  return entry ? shipName(entry, locale) : fallback;
}

function posAt(track: Track, t: number): { x: number; z: number; yaw: number } {
  const n = track.x.length;
  const tt = Math.min(Math.max(t, 0), n - 1.001);
  const i = Math.floor(tt);
  const f = tt - i;
  const a = i, b = Math.min(i + 1, n - 1);
  let dyaw = track.yaw[b] - track.yaw[a];
  if (dyaw > Math.PI) dyaw -= 2 * Math.PI;
  if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
  return {
    x: track.x[a] + (track.x[b] - track.x[a]) * f,
    z: track.z[a] + (track.z[b] - track.z[a]) * f,
    yaw: track.yaw[a] + dyaw * f,
  };
}

/** Hold-last 1 Hz HP lookup (the baked hp trace), null when unavailable. */
function hpAt(track: Track, t: number): number | null {
  const hp = track.hp;
  if (!hp || hp.length === 0) return null;
  const i = Math.min(Math.max(Math.floor(t), 0), hp.length - 1);
  return hp[i];
}

interface CapTag { letter: string; x: number; y: number; owner: string; eta: string; etaClass: string }

export default defineComponent({
  name: "ReplayLive",
  setup() {
    const { t, locale } = useI18n();
    const host = ref<HTMLElement | null>(null);
    const loading = ref(true);
    const failed = ref(false);
    const clockMode = ref<0 | 1 | 2>(0);
    const hud = ref<HoloHudState>({
      scoreAlly: 0, scoreEnemy: 0, aliveAlly: 11, aliveEnemy: 11,
      time: 0, duration: 1, caps: [], ships: [],
    });
    const nameTags = ref<HoloLabelData[]>([]);
    const capTags = ref<CapTag[]>([]);
    /** Alt held → show the in-game point timers (reach / capture ETA). */
    const altDown = ref(false);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Alt") altDown.value = true;
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "Alt") altDown.value = false;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const base = `${import.meta.env.BASE_URL}replay/conquest-nagato`;
    const isZh = () => locale.value.startsWith("zh");

    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let raf = 0;
    let battleT = 0;
    let lastNow = 0;
    let visible = true; // IntersectionObserver tightens this once it fires
    let disposed = false;
    let io: IntersectionObserver | null = null;
    let ro: ResizeObserver | null = null;
    let stageW = 0;
    let stageH = 0;
    const materials: THREE.Material[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const textures: THREE.Texture[] = [];
    let minimapCtx: CanvasRenderingContext2D | null = null;
    let minimapCanvas: HTMLCanvasElement | null = null;
    let seaMat: THREE.MeshBasicMaterial | null = null;
    let gridMat: THREE.LineBasicMaterial | null = null;
    let themeMq: MediaQueryList | null = null;

    interface ShipNode {
      root: THREE.Group; rel: number; track: Track; die?: number;
      type: string; nameZh: string; nameEn: string; playerName: string; tier: number | null; key: number;
    }
    let ships: ShipNode[] = [];
    let boomPool: { mesh: THREE.Mesh; t0: number }[] = [];
    let boomCursor = 0;
    let boomEvents: BattleBundle["explosions"] = [];
    let capZones: CapZone[] = [];
    let capRingMats: { ring: THREE.MeshBasicMaterial; fill: THREE.MeshBasicMaterial }[] = [];
    let reduced = false;
    let currentDuration = 100;

    const projV = new THREE.Vector3();

    function projectToStage(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
      if (!camera) return { x: 0, y: 0, visible: false };
      projV.set(x, y, z).project(camera);
      if (projV.z > 1) return { x: 0, y: 0, visible: false };
      return {
        x: (projV.x * 0.5 + 0.5) * stageW,
        y: (-projV.y * 0.5 + 0.5) * stageH,
        visible: true,
      };
    }

    function applyTheme() {
      const light = themeMq?.matches ?? false;
      // Sea + grid follow the site theme: light frosted sea in light mode,
      // deep abyss in dark mode — never a black pool on a white page.
      if (seaMat) {
        seaMat.color.setHex(light ? 0xbdd0e4 : 0x0a1626);
        seaMat.opacity = light ? 0.96 : 0.9;
      }
      if (gridMat) {
        gridMat.color.setHex(light ? 0x35507a : 0xffffff);
        gridMat.opacity = light ? 0.10 : 0.055;
      }
    }

    function trackResize() {
      if (!host.value || !renderer || !camera) return;
      const w = host.value.clientWidth, h = host.value.clientHeight;
      if (w === 0 || h === 0) return;
      stageW = w; stageH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function drawMinimap() {
      if (!minimapCtx || !minimapCanvas) return;
      const shipsForMap: HoloShip[] = ships.map((s) => {
        const t0 = Math.min(battleT, s.die ?? battleT);
        const p = posAt(s.track, t0);
        // heading from motion (screen space: x right, -z up)
        const p2 = posAt(s.track, Math.min(t0 + 1.5, s.track.x.length - 1.001));
        const heading = Math.atan2(p2.x - p.x, p2.z - p.z);
        return {
          x: p.x, z: p.z, yaw: p.yaw, role: roleOf(s.rel),
          dead: s.die !== undefined && battleT > s.die,
          shipType: s.type,
          heading,
        };
      });
      const capsForMap: HoloCap[] = capZones.map((c) => {
        const st = capStateAt(battleT).find((s) => s.letter === c.letter);
        return { letter: c.letter, x: c.x, z: c.z, owner: st?.owner ?? "neutral" };
      });
      drawHoloMinimap({
        ctx: minimapCtx,
        size: 128,
        art: { url: `${base}/minimap.png`, bounds: MAP_BOUNDS },
        ships: shipsForMap,
        caps: capsForMap,
        dpr: minimapCanvas.width / 128,
      });
    }

    /** Ships inside a cap ring right now (alive, within CAP_RING_R). */
    function shipsInZone(c: CapZone, time: number): { allies: number; enemies: number } {
      let allies = 0, enemies = 0;
      for (const s of ships) {
        if (s.die !== undefined && time > s.die) continue;
        const p = posAt(s.track, Math.min(time, s.die ?? time));
        if (Math.hypot(p.x - c.x, p.z - c.z) > CAP_RING_R) continue;
        if (s.rel === 2) enemies++; else allies++;
      }
      return { allies, enemies };
    }

    function capStateAt(time: number): (HoloCapZone & {
      captureTeam?: "ally" | "enemy";
      alliesIn: number;
      enemiesIn: number;
      seconds: number | null;
    })[] {
      return capZones.map((c) => {
        let owner: HoloCapZone["owner"] = "neutral";
        for (const [tt, v] of c.timeline) {
          if (tt <= time) { owner = v === 1 ? "ally" : v === 2 ? "enemy" : "neutral"; }
          else break;
        }
        const next = c.timeline.find(([tt]) => tt > time);
        // live ships inside the ring drive the capture speed (shared rules)
        const { allies, enemies } = shipsInZone(c, time);
        const contested = allies > 0 && enemies > 0;
        let capturing = false;
        let progress = owner !== "neutral" ? 1 : 0;
        let captureTeam: "ally" | "enemy" | undefined;
        let seconds: number | null = null;
        if (next && next[1] !== 0) {
          captureTeam = next[1] === 1 ? "ally" : "enemy";
          const teamShips = captureTeam === "ally" ? allies : enemies;
          const speed = captureSpeedPerSec(teamShips);
          const start = next[0] - 1 / speed;
          if (time >= start && time < next[0]) {
            capturing = true;
            progress = Math.min(1, Math.max(0, (time - start) / (1 / speed)));
            seconds = captureSecondsRemaining(progress, teamShips, contested).seconds;
          }
        }
        return {
          letter: c.letter, owner, progress,
          capturing, contested,
          captureTeam, alliesIn: allies, enemiesIn: enemies, seconds,
          hint: contested
            ? t("showcase.replay.live.cap.contested")
            : capturing
              ? t("showcase.replay.live.cap.capturing")
              : t(`showcase.replay.live.cap.${owner}`),
        };
      });
    }

    function frame(now: number) {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      if (!renderer || !scene || !camera) return;
      const dt = Math.min((now - lastNow) / 1000, 0.1);
      lastNow = now;
      if (!visible) return;

      if (!reduced) battleT += dt * PLAYBACK_SPEED;
      if (battleT > currentDuration) {
        battleT = 0;
        boomCursor = 0;
        for (const b of boomPool) b.mesh.visible = false;
      }

      let allies = 0, enemies = 0, scoreA = 0, scoreE = 0;
      const shipStates: HoloShip[] = [];
      const tags: HoloLabelData[] = [];
      for (const s of ships) {
        const dead = s.die !== undefined && battleT > s.die;
        const p = posAt(s.track, Math.min(battleT, s.die ?? battleT));
        s.root.position.set(p.x, 0, -p.z);
        s.root.rotation.y = Math.PI - p.yaw;
        const ghost = s.root.userData.ghostMat as THREE.ShaderMaterial | undefined;
        if (ghost) ghost.uniforms.ghostAlpha.value = dead ? 0.15 : 1;
        if (s.rel === 2) { if (dead) scoreE += 100; else enemies++; }
        else { if (dead) scoreA += 100; else allies++; }
        shipStates.push({ x: 0, z: 0, yaw: 0, role: roleOf(s.rel), dead, shipType: s.type });

        const pr = projectToStage(p.x, 20, -p.z);
        const role = roleOf(s.rel);
        const cur = Math.min(battleT, s.die ?? battleT);
        const hp = dead ? null : hpAt(s.track, cur);
        const maxHp = s.track.hp ? Math.max(...s.track.hp) : null;
        tags.push({
          key: s.key,
          role,
          name: s.playerName,
          shipName: isZh() ? s.nameZh : s.nameEn,
          tier: s.tier,
          x: pr.x, y: pr.y, dead, visible: pr.visible,
          iconUrl: holoShipIconUrl(s.type, dead ? "sunk" : role === "enemy" ? "enemy" : "ally"),
          hp: hp ?? null,
          maxHp: maxHp ?? null,
        });
      }
      nameTags.value = tags;

      // explosions
      while (boomCursor < boomEvents.length && boomEvents[boomCursor][0] <= battleT) {
        const [, x, z] = boomEvents[boomCursor++];
        const slot = boomPool.find((b) => !b.mesh.visible) ?? boomPool[0];
        if (slot) { slot.t0 = battleT; slot.mesh.position.set(x, 1, -z); slot.mesh.visible = true; }
      }
      for (const b of boomPool) {
        if (!b.mesh.visible) continue;
        const age = battleT - b.t0;
        if (age > 3) { b.mesh.visible = false; continue; }
        b.mesh.scale.setScalar(4 + age * 22);
        (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - age / 3);
      }

      for (const m of materials) {
        if ((m as THREE.ShaderMaterial).uniforms?.time) tickHolo(m as THREE.ShaderMaterial, dt);
      }

      // ── top-down overview camera: close-ish, slow drift, slight tilt ──
      const ang = now / 1000 * 0.03;
      const r = 300;
      camera.position.set(Math.cos(ang) * r, 1250 + Math.sin(now / 1000 * 0.07) * 35, Math.sin(ang) * r);
      camera.lookAt(0, 0, 0);

      // cap zones: ring colours + projected letters (+ Alt-hold capture ETA)
      const caps = capStateAt(battleT);
      const cTags: CapTag[] = [];
      for (let i = 0; i < caps.length; i++) {
        const c = caps[i];
        const zone = capZones[i];
        const mats = capRingMats[i];
        if (mats) {
          const color = c.owner === "ally" ? 0x38bdf8 : c.owner === "enemy" ? 0xf87171 : 0xffffff;
          mats.ring.color.setHex(color);
          mats.ring.opacity = c.owner === "neutral" ? 0.55 : 0.8;
          mats.fill.color.setHex(color);
          mats.fill.opacity = c.owner === "neutral" ? 0.05 : 0.14;
        }
        const pr = projectToStage(zone.x, 2, -zone.z);
        // Only a point UNDER CAPTURE shows a timer (remaining seconds) —
        // idle neutral points stay clean.
        const eta = altDown.value && c.capturing && c.seconds != null ? formatEta(c.seconds) : "";
        cTags.push({
          letter: c.letter, x: pr.x, y: pr.y, owner: c.owner,
          eta, etaClass: eta ? "is-capture" : "",
        });
      }
      capTags.value = cTags;

      hud.value = {
        scoreAlly: scoreA, scoreEnemy: scoreE,
        aliveAlly: allies, aliveEnemy: enemies,
        time: battleT, duration: currentDuration,
        caps,
        ships: shipStates,
      };
      drawMinimap();
      renderer.render(scene, camera);
    }

    async function boot() {
      if (!host.value) return;
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      themeMq = window.matchMedia("(prefers-color-scheme: light)");
      themeMq.addEventListener("change", applyTheme);

      let bundle: BattleBundle;
      try {
        const resp = await fetch(`${base}/battle.json`);
        bundle = await resp.json();
      } catch {
        failed.value = true;
        loading.value = false;
        return;
      }
      currentDuration = bundle.duration;
      boomEvents = bundle.explosions;
      capZones = bundle.caps;

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.classList.add("replay-live__gl");
      host.value.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(60, 1, 1, 9000);
      camera.position.set(0, 1500, 380);
      camera.lookAt(0, 0, 0);

      // sea surface — oversized so it always covers the stage, theme-tinted
      const seaGeom = new THREE.PlaneGeometry(6000, 6000);
      seaMat = new THREE.MeshBasicMaterial({
        color: 0x0a1626, transparent: true, opacity: 0.9, depthWrite: true,
      });
      const sea = new THREE.Mesh(seaGeom, seaMat);
      sea.rotation.x = -Math.PI / 2;
      sea.position.y = -0.5;
      scene.add(sea);
      geometries.push(seaGeom); materials.push(seaMat);

      // 10×10 map grid (the in-game coordinate helper lines)
      {
        const pts: number[] = [];
        const min = MAP_BOUNDS.minX, max = MAP_BOUNDS.maxX;
        const step = (max - min) / 10;
        for (let i = 0; i <= 10; i++) {
          const c = min + i * step;
          pts.push(c, 0, min, c, 0, max);
          pts.push(min, 0, c, max, 0, c);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        gridMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.055, depthWrite: false });
        const grid = new THREE.LineSegments(g, gridMat);
        grid.position.y = 0.1;
        scene.add(grid);
        geometries.push(g); materials.push(gridMat);
      }

      applyTheme();

      // terrain
      try {
        const terrain = await loadGlb(`${base}/models/41_Conquest.glb`);
        if (disposed) return;
        const mat = makeTerrainHoloMaterial();
        materials.push(mat);
        terrain.traverse((c) => {
          const mesh = c as THREE.Mesh;
          if (mesh.isMesh) { mesh.material = mat; if (mesh.geometry) geometries.push(mesh.geometry); }
        });
        scene.add(terrain);
      } catch (e) {
        console.warn("[ReplayLive] terrain failed", e);
      }

      // cap zone rings (the in-game circle at each letter point).
      // depthTest off so the rings never hide behind terrain (cap points
      // sit on islands in some maps) — they behave like HUD callouts.
      {
        const ringGeom = new THREE.RingGeometry(CAP_RING_R - 4, CAP_RING_R, 64);
        const fillGeom = new THREE.CircleGeometry(CAP_RING_R - 4, 48);
        geometries.push(ringGeom, fillGeom);
        for (const c of capZones) {
          const ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
            depthWrite: false, depthTest: false,
          });
          const fillMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.03, side: THREE.DoubleSide,
            depthWrite: false, depthTest: false,
          });
          const ring = new THREE.Mesh(ringGeom, ringMat);
          const fill = new THREE.Mesh(fillGeom, fillMat);
          ring.rotation.x = -Math.PI / 2;
          fill.rotation.x = -Math.PI / 2;
          ring.position.set(c.x, 2.2, -c.z);
          fill.position.set(c.x, 2.0, -c.z);
          scene.add(ring, fill);
          materials.push(ringMat, fillMat);
          capRingMats.push({ ring: ringMat, fill: fillMat });
        }
      }

      // minimap art
      const mmImg = new Image();
      mmImg.onload = () => { setMinimapArtImage(mmImg); drawMinimap(); };
      mmImg.src = `${base}/minimap.png`;

      // ships
      const uniqueModels = [...new Set(bundle.roster.map((r) => r.model))];
      const lib = new Map<string, THREE.Group>();
      await Promise.all(uniqueModels.map(async (m) => {
        try { lib.set(m, await loadGlb(`${base}/models/${m}.glb`)); }
        catch (e) { console.warn("[ReplayLive] ship model failed", m, e); }
      }));
      if (disposed) return;

      for (const r of bundle.roster) {
        const track = bundle.tracks[String(r.e)];
        const src = lib.get(r.model);
        if (!track || !src) continue;
        const role = roleOf(r.rel);
        const color = ROLE_COLOR[role];

        const clone = src.clone(true);
        const holo = makeShipHoloMaterial();
        holo.uniforms.baseColor.value.setHex(color);
        holo.uniforms.fresnelColor.value.setHex(color);
        materials.push(holo);
        const meshes: THREE.Mesh[] = [];
        clone.traverse((c) => { if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh); });
        for (const mesh of meshes) {
          mesh.material = holo;
          mesh.geometry.computeBoundingBox();
          mesh.geometry.computeBoundingSphere();
          if (!geometries.includes(mesh.geometry)) geometries.push(mesh.geometry);
        }
        const root = new THREE.Group();
        root.add(clone);
        root.userData.ghostMat = holo;
        const box = new THREE.Box3().setFromObject(clone);
        clone.scale.setScalar(SHIP_SCALE);
        const center = box.getCenter(new THREE.Vector3()).multiplyScalar(SHIP_SCALE);
        clone.position.sub(center);
        clone.position.y += -box.min.y * SHIP_SCALE;

        ships.push({
          root, rel: r.rel, track, die: track.die,
          type: shipTypeOf(r.model),
          nameZh: resolveShipName(r.model, r.shipZh, "zh-Hans"),
          nameEn: resolveShipName(r.model, r.shipEn, "en"),
          playerName: r.name,
          tier: SHIP_BY_ID.get(r.model)?.tier ?? SHIP_BY_EN.get(r.model)?.tier ?? SHIP_BY_EN.get(r.shipEn)?.tier ?? null,
          key: r.e,
        });
        scene.add(root);
      }

      // explosion ring pool
      const ringGeom = new THREE.RingGeometry(0.86, 1, 48);
      geometries.push(ringGeom);
      for (let i = 0; i < 12; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffc36b, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
        });
        const mesh = new THREE.Mesh(ringGeom, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.visible = false;
        materials.push(mat);
        scene.add(mesh);
        boomPool.push({ mesh, t0: 0 });
      }

      // minimap canvas (bottom-right HUD) — 2× backing store
      minimapCanvas = document.createElement("canvas");
      minimapCanvas.width = 256;
      minimapCanvas.height = 256;
      minimapCanvas.className = "replay-live__minimap";
      host.value.appendChild(minimapCanvas);
      minimapCtx = minimapCanvas.getContext("2d");

      loading.value = false;
      trackResize();

      battleT = reduced ? bundle.duration * 0.4 : 0;
      lastNow = performance.now();
      raf = requestAnimationFrame(frame);

      io = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) visible = true; }, { threshold: 0.1 });
      io.observe(host.value);
      ro = new ResizeObserver(trackResize);
      ro.observe(host.value);
    }

    onMounted(boot);
    onBeforeUnmount(() => {
      disposed = true;
      cancelAnimationFrame(raf);
      io?.disconnect();
      ro?.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      themeMq?.removeEventListener("change", applyTheme);
      for (const m of materials) m.dispose();
      for (const g of geometries) g.dispose();
      for (const tx of textures) tx.dispose();
      renderer?.dispose();
      renderer?.domElement.remove();
      minimapCanvas?.remove();
      ships = [];
      boomPool = [];
      capRingMats = [];
    });

    return () => (
      <div class="replay-live">
        <div class="replay-live__stage" ref={host} />
        {/* ship labels — shared HoloLabel (app's floating card) */}
        {!loading.value && !failed.value ? (
          <div class="replay-live__tags" aria-hidden="true">
            {nameTags.value.map((tag) => (
              <HoloLabel key={tag.key} label={tag} deadText={t("showcase.replay.live.dead")} />
            ))}
            {capTags.value.map((tag) => (
              <span
                key={tag.letter}
                class={`replay-live__capletter replay-live__capletter--${tag.owner}`}
                style={{ transform: `translate(-50%, -50%) translate(${tag.x}px, ${tag.y}px)` }}
              >
                {tag.letter}
                {tag.eta ? (
                  <span class={`replay-live__capeta ${tag.etaClass}`}>{tag.eta}</span>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
        {loading.value ? (
          <div class="replay-live__loading">
            <span class="replay-live__spinner" />
            {t("showcase.replay.live.loading")}
          </div>
        ) : null}
        {failed.value ? (
          <div class="replay-live__loading">{t("showcase.replay.live.failed")}</div>
        ) : null}
        {!loading.value && !failed.value ? (
          <>
            <div class="replay-live__hud replay-live__hud--top">
              <HoloScorebar state={hud.value} />
            </div>
            <div class="replay-live__hud replay-live__hud--tr">
              <span class="replay-live__live-dot">{t("showcase.replay.live.badge")}</span>
            </div>
            <div class="replay-live__hud replay-live__hud--bl">
              <HoloClock
                state={hud.value}
                mode={clockMode.value}
                interactive
                onCycle={() => { clockMode.value = ((clockMode.value + 1) % 3) as 0 | 1 | 2; }}
              />
            </div>
            <div class="replay-live__hud replay-live__hud--br">
              <span class="replay-live__caption">{t("showcase.replay.live.caption")}</span>
            </div>
          </>
        ) : null}
      </div>
    );
  },
});