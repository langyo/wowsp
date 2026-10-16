/**
 * Game-original HUD art for the below-hull combat status rows — the very
 * icons the battle UI itself uses: the ammo selector's shell / torpedo
 * sprites (`/gui/ammo/`), the consumable slot art (`/gui/consumables/`) and
 * the ship state-panel fire / flood glyphs (`/gui/battle_hud/state_panel/
 * special/`). Extracted from gui_0001.pkg by scripts/extract/
 * extract_game_assets.py into `src/res/images/hud/` (lossless WebP).
 */
import ammoHe from "../../res/images/hud/ammo_he.webp";
import ammoAp from "../../res/images/hud/ammo_ap.webp";
import ammoSap from "../../res/images/hud/ammo_sap.webp";
import ammoTorpedo from "../../res/images/hud/ammo_torpedo.webp";
import consumableSmoke from "../../res/images/hud/consumable_smoke.webp";
import consumableRegen from "../../res/images/hud/consumable_regen.webp";
import stateFire from "../../res/images/hud/state_fire.webp";
import stateFlood from "../../res/images/hud/state_flood.webp";
import type { ShipActionKey } from "./shipStatusModel";

/** Shell ammo family (HE/AP/SAP/CS) → the game's ammo-selector sprite. */
export const AMMO_ICON: Record<string, string> = {
  HE: ammoHe,
  AP: ammoAp,
  SAP: ammoSap,
  CS: ammoSap,
};

/** The game's torpedo sprite (hit pills + torpedo action tiles). */
export const torpedoIconUrl = ammoTorpedo;

/** Action-tile icon. The gun tile carries the salvo's own shell family —
 *  unresolvable families fall back to HE (the most common pick). */
export function actionIconUrl(key: ShipActionKey, ammo?: string | null): string {
  switch (key) {
    case "gun":
      return (ammo != null && AMMO_ICON[ammo]) || ammoHe;
    case "torp":
      return torpedoIconUrl;
    case "smoke":
      return consumableSmoke;
    case "repair":
      return consumableRegen;
  }
}

/** Fire / flooding tile icon — the game's own state-panel glyphs. */
export function dotIconUrl(kind: "fire" | "flood"): string {
  return kind === "fire" ? stateFire : stateFlood;
}
