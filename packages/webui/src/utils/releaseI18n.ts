/**
 * releaseI18n — release-note bodies and their per-release translation asset.
 *
 * Two formats are supported, both authored by scripts/release_notes_i18n.py
 * (the FORMAT AUTHORITY — its module docstring defines them and this parser
 * mirrors it; the fixtures in releaseI18n.test.ts stay in agreement with the
 * python self-test):
 *
 * 1. Canonical (since the 2026-11 migration): the release BODY is plain
 *    English markdown and the seven translations live in the release asset
 *    release-notes-i18n-<tag>.json (fetched Rust-side by
 *    commands/changelog.rs::changelog_i18n and handed here as the
 *    translations map). The changelog renders the user's locale from the
 *    asset, falling back to the English body with a hint while the locale
 *    is still the 🚧 placeholder or the asset is unavailable.
 * 2. Legacy v1 scaffold bodies (older releases/clients): language sections
 *    wrapped in <details> elements; rendered exactly as before, with the
 *    en-US fallback while a section is still the placeholder.
 *
 * A structurally malformed scaffold parses as null and the caller falls
 * back to rendering the whole raw body — visible degradation beats hidden
 * content. Two deliberate tolerances: a duplicate locale section keeps the
 * LAST copy (the live lint flags duplicates), and only format v1 bodies are
 * parsed — a future format bump degrades old apps to the raw render.
 */

import type { Locale } from "@/i18n";

const HEADER_RE = /^<!-- wowsp:i18n v(\d+) -->$/;
const DETAILS_OPEN_RE = /^<details( open)?>$/;
const SUMMARY_RE = /^<summary>🌐 (.+) \(([A-Za-z-]+)\)<\/summary>$/;
const LANG_MARKER_RE = /^<!-- wowsp:lang ([A-Za-z-]+) -->$/;

/** One parsed scaffold: locale → section content (markers and the HTML
 *  wrapper stripped; only the markdown subset remains). */
export interface ParsedReleaseI18n {
  formatVersion: number;
  sections: Partial<Record<Locale, string>>;
}

/** Parse a release body under the scaffold grammar. Returns null when the
 *  body is not scaffolded at all (legacy) or structurally malformed — the
 *  caller's safe fallback is rendering the raw body verbatim. */
export function parseI18nRelease(body: string): ParsedReleaseI18n | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  const header = HEADER_RE.exec(lines[i] ?? "");
  if (!header || Number(header[1]) !== 1) return null;
  i += 1;
  const sections: Partial<Record<Locale, string>> = {};
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i += 1;
      continue;
    }
    const sumMatch = SUMMARY_RE.exec((lines[i + 1] ?? "").trim());
    if (!DETAILS_OPEN_RE.test(lines[i].trim()) || !sumMatch) return null;
    const locale = sumMatch[2];
    i += 2;
    if ((lines[i] ?? "").trim()) return null; // blank line after the summary
    i += 1;
    const marker = LANG_MARKER_RE.exec((lines[i] ?? "").trim());
    if (!marker || marker[1] !== locale) return null;
    i += 1;
    if ((lines[i] ?? "").trim()) return null; // blank line after the marker
    i += 1;
    const content: string[] = [];
    while (i < lines.length && lines[i].trim() !== "</details>") {
      if (DETAILS_OPEN_RE.test(lines[i].trim())) return null; // nested opener
      content.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) return null; // unterminated section
    i += 1; // the closer
    let end = content.length;
    while (end > 0 && !content[end - 1].trim()) end -= 1;
    sections[locale as Locale] = content.slice(0, end).join("\n");
  }
  return { formatVersion: Number(header[1]), sections };
}

/** The canonical placeholder's marker char (the PENDING table in
 *  scripts/release_notes_i18n.py) — any 🚧-leading first line counts as
 *  untranslated. */
const PENDING_PREFIX = "🚧";

function isPending(content: string): boolean {
  const first = content.split("\n").find((line) => line.trim());
  return !!first && first.trim().startsWith(PENDING_PREFIX);
}

export interface SelectedReleaseBody {
  source: string;
  /** The user's locale had no section (or a pending placeholder) and the
   *  en-US original is shown instead — callers surface a hint. */
  fallback: boolean;
}

/** The locale sections of one release's release-notes-i18n-<tag>.json
 *  asset (the Rust changelog_i18n payload's map). */
export type ReleaseTranslations = Partial<Record<Locale, string>>;

/** Pick the body to render for the given locale.
 *
 *  Order: a legacy scaffold's own section (old clients/releases), else the
 *  JSON-asset translation for the locale, else the en-US original (with the
 *  fallback flag) / raw body. "translations" being undefined means the
 *  asset has not loaded yet: the English body renders without a hint and
 *  the next render picks the translation up once it lands; a loaded asset
 *  that lacks the locale (or carries the 🚧 placeholder) surfaces the hint. */
export function selectReleaseBody(
  body: string,
  locale: Locale,
  translations?: ReleaseTranslations | null,
): SelectedReleaseBody {
  const parsed = parseI18nRelease(body);
  const english = parsed?.sections["en-US"] ?? body;
  if (locale === "en-US") return { source: english, fallback: false };
  // The JSON asset is the translation channel and wins over a legacy body
  // scaffold (an old body may still carry a stale inline section).
  const translated = translations?.[locale];
  if (translated && translated.trim() && !isPending(translated)) {
    return { source: translated, fallback: false };
  }
  if (translations) {
    // Asset loaded but this locale is missing or still the placeholder:
    // render the English original with the fallback hint.
    return { source: english, fallback: true };
  }
  // Asset not loaded yet: consume the legacy v1 scaffold section when the
  // body still carries one (old clients/releases), else render English.
  if (parsed) {
    const chosen = parsed.sections[locale];
    if (chosen && !isPending(chosen)) return { source: chosen, fallback: false };
    return { source: english, fallback: true };
  }
  return { source: body, fallback: false };
}
