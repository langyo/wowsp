/**
 * Ribbon icon loading for the battle HUD.
 *
 * Skin priority:
 *   1. res_mods skins — a `gui/ribbons` dir under the game's `res_mods`
 *      (queried via `ribbon_skin_dir`); served with convertFileSrc.
 *   2. Bundled fallback art — `res/images/ribbons/*.png` extracted from the
 *      stock game.
 *
 * The name parameter matches the bundled filename stem ("ribbon_crit",
 * "subribbon_burn", ...) and the res_mods equivalent ("crit.png" style names
 * vary by skin — we try a couple of common spellings).
 */
import { api } from "@/api";

import ribbonAssist from "../../res/images/ribbons/ribbon_assist.png";
import ribbonBaseCapture from "../../res/images/ribbons/ribbon_base_capture.png";
import ribbonBaseDefense from "../../res/images/ribbons/ribbon_base_defense.png";
import ribbonBomb from "../../res/images/ribbons/ribbon_bomb.png";
import ribbonBurn from "../../res/images/ribbons/ribbon_burn.png";
import ribbonCrit from "../../res/images/ribbons/ribbon_crit.png";
import ribbonDemining from "../../res/images/ribbons/ribbon_demining.png";
import ribbonFrag from "../../res/images/ribbons/ribbon_frag.png";
import ribbonMainCaliber from "../../res/images/ribbons/ribbon_main_caliber.png";
import ribbonMissile from "../../res/images/ribbons/ribbon_missile.png";
import ribbonPlane from "../../res/images/ribbons/ribbon_plane.png";
import ribbonSecondaryCaliber from "../../res/images/ribbons/ribbon_secondary_caliber.png";
import ribbonSuppressed from "../../res/images/ribbons/ribbon_suppressed.png";
import ribbonTorpedo from "../../res/images/ribbons/ribbon_torpedo.png";
import subBurn from "../../res/images/ribbons/subribbon_burn.png";
import subFlood from "../../res/images/ribbons/subribbon_flood.png";
import subFrag from "../../res/images/ribbons/subribbon_frag.png";
import subMainCaliber from "../../res/images/ribbons/subribbon_main_caliber.png";
import subTorpedo from "../../res/images/ribbons/subribbon_torpedo.png";

/** Bundled art keyed by the logical ribbon name. */
const BUNDLED: Record<string, string> = {
  assist: ribbonAssist,
  base_capture: ribbonBaseCapture,
  base_defense: ribbonBaseDefense,
  bomb: ribbonBomb,
  burn: ribbonBurn,
  crit: ribbonCrit,
  demining: ribbonDemining,
  frag: ribbonFrag,
  main_caliber: ribbonMainCaliber,
  main_caliber_shots: ribbonMainCaliber,
  secondary_caliber: ribbonSecondaryCaliber,
  hits: ribbonMainCaliber,
  aa_hits: ribbonPlane,
  plane: ribbonPlane,
  shells: ribbonMainCaliber,
  plane_losses: ribbonPlane,
  dbomb: ribbonTorpedo,
  missile: ribbonMissile,
  suppressed: ribbonSuppressed,
  torpedo: ribbonTorpedo,
  sub_burn: subBurn,
  sub_flood: subFlood,
  sub_frag: subFrag,
  sub_main_caliber: subMainCaliber,
  sub_torpedo: subTorpedo,
};

/** Logical ribbon name → res_mods candidate filenames (skins vary). */
const SKIN_NAMES: Record<string, string[]> = {
  assist: ["ribbon_assist.png", "assist.png"],
  base_capture: ["ribbon_base_capture.png", "base_capture.png"],
  base_defense: ["ribbon_base_defense.png", "base_defense.png"],
  bomb: ["ribbon_bomb.png", "bomb.png"],
  burn: ["ribbon_burn.png", "burn.png"],
  crit: ["ribbon_crit.png", "crit.png"],
  demining: ["ribbon_demining.png", "demining.png"],
  frag: ["ribbon_frag.png", "frag.png"],
  main_caliber: ["ribbon_main_caliber.png", "main_caliber.png"],
  missile: ["ribbon_missile.png", "missile.png"],
  suppressed: ["ribbon_suppressed.png", "suppressed.png"],
  torpedo: ["ribbon_torpedo.png", "torpedo.png"],
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
