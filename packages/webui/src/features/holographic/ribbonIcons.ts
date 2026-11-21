/**
 * Ribbon icon loading for the battle HUD.
 *
 * Skin priority:
 *   1. res_mods skins — a `gui/ribbons` dir under the game's `res_mods`
 *      (queried via `ribbon_skin_dir`); served with convertFileSrc.
 *   2. Bundled fallback art — `res/images/ribbons/*.webp` extracted from
 *      the stock game and re-encoded to WebP.
 *
 * The name parameter is the LOGICAL ribbon kind (the post-battle parser's
 * key: "frag", "main_caliber", "sub_torpedo", ...); the map below resolves it
 * to a bundled file stem ("ribbon_frag", "subribbon_torpedo", ...) and to the
 * res_mods equivalent ("crit.png" style names vary by skin — we try a couple
 * of common spellings).
 */
import { api } from "@/api";

/** The shipped ribbon art, keyed by FILE STEM. A Vite `?url` import keeps
 *  every URL in the module graph: the file is emitted (content-hashed) into
 *  the build and the URL is resolved against the app's base — so a ribbon
 *  face cannot 404 because the publicDir copy is missing, stale, or the app
 *  is served from a sub-path. That silent 404 is exactly what left the clip's
 *  勋带 strip as bare counts; the parser's keys are pinned to these stems by
 *  ribbonIcons.test.ts, so a rename on either side fails the suite instead of
 *  quietly dropping the art. */
const ART_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../res/images/ribbons/*.webp", {
      eager: true,
      query: "?url",
      import: "default",
    }),
  ).map(([path, url]) => {
    const file = path.slice(path.lastIndexOf("/") + 1);
    return [file.slice(0, file.lastIndexOf(".")), url];
  }),
);

/** One art stem -> its built URL ("" when no such file ships: bundledRibbonUrl
 *  then answers null and the painter keeps a plain count beside the cell). */
function art(stem: string): string {
  return ART_URLS[stem] ?? "";
}

/** Bundled art keyed by the logical ribbon name. */
const BUNDLED: Record<string, string> = {
  acid: art("ribbon_acid"),
  acoustic_hit: art("ribbon_acoustic_hit"),
  assist: art("ribbon_assist"),
  base_capture: art("ribbon_base_capture"),
  base_capture_assist: art("ribbon_base_capture_assist"),
  base_defense: art("ribbon_base_defense"),
  bomb: art("ribbon_bomb"),
  building_kill: art("ribbon_building_kill"),
  burn: art("ribbon_burn"),
  citadel: art("ribbon_citadel"),
  crit: art("ribbon_crit"),
  dbomb: art("ribbon_dbomb"),
  dbomb_mine: art("ribbon_dbomb_mine"),
  demining: art("ribbon_demining"),
  demining_mine: art("ribbon_demining_mine"),
  demining_minefield: art("ribbon_demining_minefield"),
  detected: art("ribbon_detected"),
  drop: art("ribbon_drop"),
  flood: art("ribbon_flood"),
  frag: art("ribbon_frag"),
  main_caliber: art("ribbon_main_caliber"),
  mine: art("ribbon_mine"),
  missile: art("ribbon_missile"),
  phaser_laser: art("ribbon_phaser_laser"),
  plane: art("ribbon_plane"),
  rocket: art("ribbon_rocket"),
  secondary_caliber: art("ribbon_secondary_caliber"),
  shield: art("ribbon_shield"),
  splane: art("ribbon_splane"),
  suppressed: art("ribbon_suppressed"),
  torpedo: art("ribbon_torpedo"),
  wave: art("ribbon_wave"),
  // Aggregates with no dedicated art — reuse a representative icon.
  main_caliber_shots: art("ribbon_main_caliber"),
  hits: art("ribbon_main_caliber"),
  salvos: art("ribbon_main_caliber"),
  shells: art("ribbon_main_caliber"),
  aa_hits: art("ribbon_plane"),
  plane_losses: art("ribbon_plane"),
  // Sub-ribbons (penetration/ricochet detail) that we still display.
  sub_burn: art("subribbon_burn"),
  sub_flood: art("subribbon_flood"),
  sub_frag: art("subribbon_frag"),
  sub_main_caliber: art("subribbon_main_caliber"),
  sub_torpedo: art("subribbon_torpedo"),
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
  return BUNDLED[name] || null;
}

/** Synchronous bundled URL (no res_mods check) — for tests/fallback UI. */
export function bundledRibbonUrl(name: string): string | null {
  return BUNDLED[name] || null;
}