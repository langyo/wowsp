/**
 * Mod-hub taxonomy — the two filter layers that shape both lists.
 *
 * The marketplace column narrows by BIG category first (function / texture /
 * voice), then by the source-specific sub-division: curated catalog
 * categories for the online index, on-disk mod kinds for the installed scan.
 * Both taxonomies, their BIG mapping and the tile glyphs live here rather
 * than inside the view so taxonomy.test.ts can assert total coverage — an
 * un-bucketed kind or category would silently vanish from every strip, and a
 * missing `resources.*` label would render a raw key.
 */
import {
  Anchor,
  AudioLines,
  Crosshair,
  FileCode,
  ImageIcon,
  Map as MapIcon,
  MessagesSquare,
  PackageCheck,
  Palette,
  Puzzle,
  ScrollText,
} from "@lucide/vue";

import type { ModKind } from "@/api";

/** On-disk mod kinds, in chip order. */
export const KIND_ORDER: ModKind[] = ["voice", "skin", "script", "gui", "patch", "textures"];

/** lucide glyph + accent-hue class per installed kind (drives the row tile
 *  and the drawer header). */
export const KIND_META: Record<ModKind, { icon: typeof Puzzle; class: string }> = {
  voice: { icon: AudioLines, class: "voice" },
  skin: { icon: Palette, class: "skin" },
  script: { icon: FileCode, class: "script" },
  gui: { icon: ImageIcon, class: "gui" },
  patch: { icon: ScrollText, class: "patch" },
  textures: { icon: PackageCheck, class: "textures" },
};

/** Curated categories of the online index (scripts/mod_hub_publish.py). */
export type CatalogCat = "battle" | "minimap" | "port" | "text" | "patch";
export const CATALOG_CATS: CatalogCat[] = ["battle", "minimap", "port", "text", "patch"];

/** Catalog categories and on-disk kinds are DIFFERENT vocabularies that share
 *  one strip — "patch" happens to exist in both, which is why the two
 *  mappings below stay separate and this guard exists at all. */
export function isCatalogCat(value: string): value is CatalogCat {
  return (CATALOG_CATS as string[]).includes(value);
}

/** The big-category strip: what a mod is FOR, before any source detail. */
export type BigCat = "function" | "texture" | "voice";
export const BIG_CATS: BigCat[] = ["function", "texture", "voice"];

/** Installed kinds → big category. Total by type: every kind must bucket. */
export const KIND_BIG: Record<ModKind, BigCat> = {
  script: "function",
  gui: "function",
  patch: "function",
  skin: "texture",
  textures: "texture",
  voice: "voice",
};

/** Catalog categories → big category. Also total by type: the curated index
 *  is tool-type mods today, so every category lands in "function" — a future
 *  paint/voice entry must be bucketed here rather than fall through. */
const CAT_BIG: Record<CatalogCat, BigCat> = {
  battle: "function",
  minimap: "function",
  port: "function",
  text: "function",
  patch: "function",
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
  patch: ScrollText,
};

/** Tile glyph for a catalog entry; unknown categories fall back to Puzzle. */
export function catIcon(category: string): typeof Puzzle {
  return isCatalogCat(category) ? CAT_ICON[category] : Puzzle;
}
