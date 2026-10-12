/** Pure display helpers of the Mod Hub (Resources) view: localization of
 *  catalog entries/tags/presets, labels and size/url formatting. No
 *  component state — everything here reads the global locale composable
 *  or takes its input as a parameter. */
import type { CatalogEntry, CatalogPreset, CatalogTag, ModKind } from "@/api";
import { KIND_BIG } from "@/features/modhub/taxonomy";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { REPO } from "./types";

/** Localized name/description from the thread's wowsp:i18n block:
 *  UI locale first, then the game-data language, then en-US. Matching
 *  falls back to the language subtag so `zh-SG` still finds `zh-CN`. */
export function localized(entry: CatalogEntry): { name: string; desc: string } {
  const { uiLocale, dataLanguage } = useLanguage();
  const table = entry.i18n ?? {};
  const wanted = [uiLocale.value, dataLanguage.value, "en-US"];
  for (const lang of wanted) {
    const text = table[lang];
    if (text?.name || text?.description) {
      return { name: text.name, desc: text.description };
    }
  }
  for (const lang of wanted) {
    const base = lang.split("-")[0]?.toLowerCase();
    const key = base && Object.keys(table).find((k) => k.split("-")[0].toLowerCase() === base);
    const text = key ? table[key] : undefined;
    if (text?.name || text?.description) {
      return { name: text.name, desc: text.description };
    }
  }
  return { name: entry.nameZh || entry.nameEn, desc: entry.description };
}

/** A tag's localized label: exact locale, then the zh / en pair the
 *  registry guarantees, then the raw id (registry lag). */
export function tagLabel(tag: CatalogTag): string {
  const { uiLocale } = useLanguage();
  const i18n = tag.i18n ?? {};
  return (
    i18n[uiLocale.value] ??
    (uiLocale.value.toLowerCase().startsWith("zh")
      ? (i18n["zh-CN"] ?? i18n["en-US"])
      : (i18n["en-US"] ?? i18n["zh-CN"])) ??
    tag.id
  );
}

/** A preset's label: zh locales take the Chinese name, everything
 *  else the English one (presets carry just the two). */
export function presetLabel(p: CatalogPreset): string {
  const { uiLocale } = useLanguage();
  return uiLocale.value.toLowerCase().startsWith("zh")
    ? p.nameZh || p.nameEn
    : p.nameEn || p.nameZh;
}

/** Installer display name for badges/notes. */
export function installerLabel(installer: string): string {
  if (installer === "aslain") return t("resources.foreignSource.aslain");
  if (installer === "modstation") return t("resources.foreignSource.modstation");
  return installer;
}

/** Big category of an installed unit's kind (preview routing). */
export function bigOfKind(kind: string): string {
  return (KIND_BIG as Record<string, string>)[kind] ?? "function";
}

/** Query match for online entries: identity, published names and every
 *  localized variant (a user types what their UI language shows). */
export function entryMatches(entry: CatalogEntry, q: string): boolean {
  if (
    entry.id.includes(q) ||
    entry.nameEn.toLowerCase().includes(q) ||
    entry.nameZh.toLowerCase().includes(q) ||
    entry.title.toLowerCase().includes(q)
  ) {
    return true;
  }
  const text = localized(entry);
  if (text.name.toLowerCase().includes(q) || text.desc.toLowerCase().includes(q)) return true;
  return Object.values(entry.i18n ?? {}).some(
    (v) =>
      v.name?.toLowerCase().includes(q) || v.description?.toLowerCase().includes(q) || false,
  );
}

/** Human size for a catalog entry's package list (KB granularity). */
export function catalogKb(entry: CatalogEntry): number {
  return entry.packages.reduce((sum, p) => sum + p.size, 0) > 0
    ? Math.max(1, Math.round(entry.packages.reduce((s, p) => s + p.size, 0) / 1024))
    : 0;
}

/** Human size for one package (KB granularity). */
export function pkgKb(size: number): number {
  return Math.max(1, Math.round(size / 1024));
}

/** Human size for a migration plan row (KB granularity, like the package list). */
export function migKb(size: number): string {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
}

/** Discussions thread URL of a catalog entry (empty when it has none). */
export function discussionUrl(n?: number | null): string {
  return n ? `https://github.com/${REPO}/discussions/${n}` : "";
}

/** Localized label for an installed unit's kind. */
export function kindLabel(kind: ModKind): string {
  return t(`resources.kind.${kind}`);
}

/** Localized label for a texture-analysis code; falls back to the raw
 *  code when the locale has no entry (unknown nations, exotic dirs). */
export function texLabel(group: "cat" | "nation" | "species", code: string): string {
  const key = `resources.tex.${group}.${code}`;
  const label = t(key);
  return label === key ? code : label;
}
