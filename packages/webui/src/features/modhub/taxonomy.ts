/**
 * Mod-hub taxonomy — the two filter layers that shape both lists.
 *
 * The marketplace column narrows by BIG category first (function / beautify),
 * then by the source-specific sub-division: curated catalog categories for
 * the online index, on-disk mod kinds for the installed scan. Both
 * taxonomies, their BIG mapping and the tile glyphs live here rather than
 * inside the view so taxonomy.test.ts can assert total coverage — an
 * un-bucketed kind or category would silently vanish from every strip, and a
 * missing `resources.*` label would render a raw key.
 *
 * "beautify" is the merged material/audio big category: the Minecraft-style
 * layered resource-pack swimlane owns the installed side, while the online
 * index keeps its curated categories (now including video / audio / model).
 */
import {
  Anchor,
  AudioLines,
  Boxes,
  Clapperboard,
  Crosshair,
  FileCode,
  ImageIcon,
  Map as MapIcon,
  MessagesSquare,
  PackageCheck,
  Palette,
  Puzzle,
  ScrollText,
  Sparkles,
  Volume2,
} from "@lucide/vue";

import type { ModKind } from "@/api";

/** On-disk mod kinds, in chip order. */
export const KIND_ORDER: ModKind[] = ["voice", "skin", "script", "gui", "patch", "textures"];

/** lucide glyph + accent-hue class per installed kind (drives the row tile
 *  and the pane head tile). */
export const KIND_META: Record<ModKind, { icon: typeof Puzzle; class: string }> = {
  voice: { icon: AudioLines, class: "voice" },
  skin: { icon: Palette, class: "skin" },
  script: { icon: FileCode, class: "script" },
  gui: { icon: ImageIcon, class: "gui" },
  patch: { icon: ScrollText, class: "patch" },
  textures: { icon: PackageCheck, class: "textures" },
};

/** Curated categories of the online index (scripts/mod_hub_publish.py).
 * The one-off `patch` bucket is gone — its only resident (patch.ime.compat)
 * lives under `text` now; on-disk `kind: "patch"` is a DIFFERENT vocabulary
 * and is unaffected. The material/audio family grew video, audio and model
 * packs, all of which bucket with "beautify". */
export type CatalogCat =
  | "battle"
  | "minimap"
  | "port"
  | "text"
  | "skin"
  | "ui"
  | "voice"
  | "video"
  | "audio"
  | "model";
export const CATALOG_CATS: CatalogCat[] = [
  "battle",
  "minimap",
  "port",
  "text",
  "skin",
  "ui",
  "voice",
  "video",
  "audio",
  "model",
];

/** Catalog categories and on-disk kinds are DIFFERENT vocabularies that share
 *  one strip — "patch" survives as an on-disk kind only, which is why the
 *  two mappings below stay separate and this guard exists at all. */
export function isCatalogCat(value: string): value is CatalogCat {
  return (CATALOG_CATS as string[]).includes(value);
}

/** The big-category strip: what a mod is FOR, before any source detail.
 *  The old texture / voice split is gone — both now live under "beautify",
 *  whose installed side is the layered resource-pack stack. */
export type BigCat = "function" | "beautify";
export const BIG_CATS: BigCat[] = ["function", "beautify"];

/** Installed kinds → big category. Total by type: every kind must bucket. */
export const KIND_BIG: Record<ModKind, BigCat> = {
  script: "function",
  // gui = icon sets, unbound views, space overlays — visual payloads, not
  // behavior: they sort with the beautify category, leaving "function" to
  // scripts and patches that change how the game plays.
  gui: "beautify",
  patch: "function",
  skin: "beautify",
  textures: "beautify",
  voice: "beautify",
};

/** Catalog categories → big category. Also total by type: the curated index
 *  is tool-type mods plus the material/audio family, so every category must
 *  bucket here rather than fall through. */
const CAT_BIG: Record<CatalogCat, BigCat> = {
  battle: "function",
  minimap: "function",
  port: "function",
  text: "function",
  // Material and voice packs — the visual/audio half of the catalog. They
  // land in the beautify category so the layered stack and the voice
  // preview can own them. `ui` is the interface-skin half of the material
  // world (ribbon/icon themes, HUD reskins): visual payloads over game UI,
  // not ship paint. Video / audio / model packs join the same family.
  skin: "beautify",
  ui: "beautify",
  voice: "beautify",
  video: "beautify",
  audio: "beautify",
  model: "beautify",
};

/** Big category of a catalog entry. Unknown categories bucket with
 *  "function" so a future index entry can never lose its row entirely. */
export function catBig(category: string): BigCat {
  return isCatalogCat(category) ? CAT_BIG[category] : "function";
}

/** Tile glyph per catalog category. */
const CAT_ICON: Record<CatalogCat, typeof Puzzle> = {
  battle: Crosshair,
  minimap: MapIcon,
  port: Anchor,
  text: MessagesSquare,
  skin: ImageIcon,
  ui: Sparkles,
  voice: AudioLines,
  video: Clapperboard,
  audio: Volume2,
  model: Boxes,
};

/** Tile glyph for a catalog entry; unknown categories fall back to Puzzle. */
export function catIcon(category: string): typeof Puzzle {
  return isCatalogCat(category) ? CAT_ICON[category] : Puzzle;
}
