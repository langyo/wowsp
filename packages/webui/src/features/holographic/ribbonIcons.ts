/**
 * Ribbon icon loading for the battle HUD.
 *
 * Skin priority:
 *   1. res_mods skins — a `gui/ribbons` dir under the game's `res_mods`
 *      (queried via `ribbon_skin_dir`); served with convertFileSrc.
 *   2. Bundled fallback art — `res/images/ribbons/*.webp` extracted from
 *      the stock game and re-encoded to WebP.
 *
 * The name parameter matches the bundled filename stem ("ribbon_crit",
 * "subribbon_burn", ...) and the res_mods equivalent ("crit.png" style names
 * vary by skin — we try a couple of common spellings).
 */
import { api } from "@/api";

// PublicDir art served at the root path (see utils/shipImages.ts) — plain
// URL constants instead of imports (same URLs, no module-graph nodes).
const ribbonAcid = "/images/ribbons/ribbon_acid.webp";
const ribbonAcousticHit = "/images/ribbons/ribbon_acoustic_hit.webp";
const ribbonAssist = "/images/ribbons/ribbon_assist.webp";
const ribbonBaseCapture = "/images/ribbons/ribbon_base_capture.webp";
const ribbonBaseCaptureAssist = "/images/ribbons/ribbon_base_capture_assist.webp";
const ribbonBaseDefense = "/images/ribbons/ribbon_base_defense.webp";
const ribbonBomb = "/images/ribbons/ribbon_bomb.webp";
const ribbonBuildingKill = "/images/ribbons/ribbon_building_kill.webp";
const ribbonBurn = "/images/ribbons/ribbon_burn.webp";
const ribbonCitadel = "/images/ribbons/ribbon_citadel.webp";
const ribbonCrit = "/images/ribbons/ribbon_crit.webp";
const ribbonDbomb = "/images/ribbons/ribbon_dbomb.webp";
const ribbonDbombMine = "/images/ribbons/ribbon_dbomb_mine.webp";
const ribbonDemining = "/images/ribbons/ribbon_demining.webp";
const ribbonDeminingMine = "/images/ribbons/ribbon_demining_mine.webp";
const ribbonDeminingMinefield = "/images/ribbons/ribbon_demining_minefield.webp";
const ribbonDetected = "/images/ribbons/ribbon_detected.webp";
const ribbonDrop = "/images/ribbons/ribbon_drop.webp";
const ribbonFlood = "/images/ribbons/ribbon_flood.webp";
const ribbonFrag = "/images/ribbons/ribbon_frag.webp";
const ribbonMainCaliber = "/images/ribbons/ribbon_main_caliber.webp";
const ribbonMine = "/images/ribbons/ribbon_mine.webp";
const ribbonMissile = "/images/ribbons/ribbon_missile.webp";
const ribbonPhaserLaser = "/images/ribbons/ribbon_phaser_laser.webp";
const ribbonPlane = "/images/ribbons/ribbon_plane.webp";
const ribbonRocket = "/images/ribbons/ribbon_rocket.webp";
const ribbonSecondaryCaliber = "/images/ribbons/ribbon_secondary_caliber.webp";
const ribbonShield = "/images/ribbons/ribbon_shield.webp";
const ribbonSplane = "/images/ribbons/ribbon_splane.webp";
const ribbonSuppressed = "/images/ribbons/ribbon_suppressed.webp";
const ribbonTorpedo = "/images/ribbons/ribbon_torpedo.webp";
const ribbonWave = "/images/ribbons/ribbon_wave.webp";
const subBurn = "/images/ribbons/subribbon_burn.webp";
const subFlood = "/images/ribbons/subribbon_flood.webp";
const subFrag = "/images/ribbons/subribbon_frag.webp";
const subMainCaliber = "/images/ribbons/subribbon_main_caliber.webp";
const subTorpedo = "/images/ribbons/subribbon_torpedo.webp";

/** Bundled art keyed by the logical ribbon name. */
const BUNDLED: Record<string, string> = {
  acid: ribbonAcid,
  acoustic_hit: ribbonAcousticHit,
  assist: ribbonAssist,
  base_capture: ribbonBaseCapture,
  base_capture_assist: ribbonBaseCaptureAssist,
  base_defense: ribbonBaseDefense,
  bomb: ribbonBomb,
  building_kill: ribbonBuildingKill,
  burn: ribbonBurn,
  citadel: ribbonCitadel,
  crit: ribbonCrit,
  dbomb: ribbonDbomb,
  dbomb_mine: ribbonDbombMine,
  demining: ribbonDemining,
  demining_mine: ribbonDeminingMine,
  demining_minefield: ribbonDeminingMinefield,
  detected: ribbonDetected,
  drop: ribbonDrop,
  flood: ribbonFlood,
  frag: ribbonFrag,
  main_caliber: ribbonMainCaliber,
  mine: ribbonMine,
  missile: ribbonMissile,
  phaser_laser: ribbonPhaserLaser,
  plane: ribbonPlane,
  rocket: ribbonRocket,
  secondary_caliber: ribbonSecondaryCaliber,
  shield: ribbonShield,
  splane: ribbonSplane,
  suppressed: ribbonSuppressed,
  torpedo: ribbonTorpedo,
  wave: ribbonWave,
  // Aggregates with no dedicated art — reuse a representative icon.
  main_caliber_shots: ribbonMainCaliber,
  hits: ribbonMainCaliber,
  salvos: ribbonMainCaliber,
  shells: ribbonMainCaliber,
  aa_hits: ribbonPlane,
  plane_losses: ribbonPlane,
  // Sub-ribbons (penetration/ricochet detail) that we still display.
  sub_burn: subBurn,
  sub_flood: subFlood,
  sub_frag: subFrag,
  sub_main_caliber: subMainCaliber,
  sub_torpedo: subTorpedo,
};

/** Logical ribbon name → res_mods candidate filenames (skins vary). */
const SKIN_NAMES: Record<string, string[]> = {
  acid: ["ribbon_acid.png", "acid.png"],
  acoustic_hit: ["ribbon_acoustic_hit.png", "acoustic_hit.png"],
  assist: ["ribbon_assist.png", "assist.png"],
  base_capture: ["ribbon_base_capture.png", "base_capture.png"],
  base_capture_assist: ["ribbon_base_capture_assist.png", "base_capture_assist.png"],
  base_defense: ["ribbon_base_defense.png", "base_defense.png"],
  bomb: ["ribbon_bomb.png", "bomb.png"],
  building_kill: ["ribbon_building_kill.png", "building_kill.png"],
  burn: ["ribbon_burn.png", "burn.png"],
  citadel: ["ribbon_citadel.png", "citadel.png"],
  crit: ["ribbon_crit.png", "crit.png"],
  dbomb: ["ribbon_dbomb.png", "dbomb.png"],
  dbomb_mine: ["ribbon_dbomb_mine.png", "dbomb_mine.png"],
  demining: ["ribbon_demining.png", "demining.png"],
  demining_mine: ["ribbon_demining_mine.png", "demining_mine.png"],
  demining_minefield: ["ribbon_demining_minefield.png", "demining_minefield.png"],
  detected: ["ribbon_detected.png", "detected.png"],
  drop: ["ribbon_drop.png", "drop.png"],
  flood: ["ribbon_flood.png", "flood.png"],
  frag: ["ribbon_frag.png", "frag.png"],
  main_caliber: ["ribbon_main_caliber.png", "main_caliber.png"],
  mine: ["ribbon_mine.png", "mine.png"],
  missile: ["ribbon_missile.png", "missile.png"],
  phaser_laser: ["ribbon_phaser_laser.png", "phaser_laser.png"],
  plane: ["ribbon_plane.png", "plane.png"],
  rocket: ["ribbon_rocket.png", "rocket.png"],
  secondary_caliber: ["ribbon_secondary_caliber.png", "secondary_caliber.png"],
  shield: ["ribbon_shield.png", "shield.png"],
  splane: ["ribbon_splane.png", "splane.png"],
  suppressed: ["ribbon_suppressed.png", "suppressed.png"],
  torpedo: ["ribbon_torpedo.png", "torpedo.png"],
  wave: ["ribbon_wave.png", "wave.png"],
  sub_burn: ["subribbon_burn.png", "sub_burn.png"],
  sub_flood: ["subribbon_flood.png", "sub_flood.png"],
  sub_frag: ["subribbon_frag.png", "sub_frag.png"],
  sub_main_caliber: ["subribbon_main_caliber.png", "sub_main_caliber.png"],
  sub_torpedo: ["subribbon_torpedo.png", "sub_torpedo.png"],
};

let _skinDir: string | null | undefined;
let _skinDirResolving: Promise<string | null> | null = null;

/** Lazily resolve the res_mods ribbons dir (once per session). */
export function resolveRibbonSkinDir(gamePath?: string): Promise<string | null> {
  if (_skinDir !== undefined) return Promise.resolve(_skinDir);
  if (!gamePath) return Promise.resolve(null);
  if (!_skinDirResolving) {
    _skinDirResolving = api
      .ribbonSkinDir(gamePath)
      .then((d) => {
        _skinDir = d ?? null;
        return _skinDir;
      })
      .catch(() => {
        _skinDir = null;
        return null;
      });
  }
  return _skinDirResolving;
}

/** URL for a ribbon by logical name, preferring res_mods skins. */
export async function ribbonUrl(
  name: string,
  gamePath?: string,
): Promise<string | null> {
  const dir = await resolveRibbonSkinDir(gamePath);
  if (dir) {
    try {
      const mod = await import("@tauri-apps/api/core");
      for (const fn of SKIN_NAMES[name] ?? []) {
        // convertFileSrc serves local files to the webview; existence is
        // best-effort (fetch would fail for non-existent files).
        return mod.convertFileSrc(`${dir}/${fn}`);
      }
    } catch {
      /* fall through to bundled */
    }
  }
  return BUNDLED[name] ?? null;
}

/** Synchronous bundled URL (no res_mods check) — for tests/fallback UI. */
export function bundledRibbonUrl(name: string): string | null {
  return BUNDLED[name] ?? null;
}
