/** Shared value types and constants of the Mod Hub (Resources) view. */
import type { CatalogEntry, ForeignModUnit, InstalledMod } from "@/api";

/** Right-hand pane content: the selected catalog entry, the selected
 *  installed unit, or the folder-install flow (which has no list row of
 *  its own — it is opened from the list's action row). */
export type Selection =
  | { mode: "catalog"; entry: CatalogEntry }
  | { mode: "installed"; mod: InstalledMod }
  | { mode: "foreign"; unit: ForeignModUnit }
  | { mode: "component"; comp: TextureComponent }
  | { mode: "local" };

/** One covered game part under the material category — the unit the list
 *  speaks in there is WHAT is overridden (a ship, a space, a folder),
 *  not which mod dropped the files (several packs can fight over the
 *  same part; only one version ever wins). */
export interface TextureComponent {
  /** `ship:<name> | space:<name> | dir:<name>` — stable row key. */
  key: string;
  label: string;
  units: InstalledMod[];
}

export const REPO = "langyo/wowsp";
