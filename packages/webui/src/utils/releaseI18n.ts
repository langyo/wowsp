/**
 * releaseI18n — the i18n scaffold inside GitHub release bodies.
 *
 * Every v* release body carries a language-section scaffold written by
 * scripts/release_notes_i18n.py (the FORMAT AUTHORITY — its module
 * docstring defines the grammar; this parser mirrors it structurally, and
 * the fixtures in releaseI18n.test.ts stay in agreement with the python
 * self-test). GitHub web renders en-US expanded and every other locale
 * collapsed inside <details>; the changelog renders EXACTLY ONE section —
 * the user's locale, falling back to the en-US original when the locale's
 * section is missing or still the 🚧 placeholder.
 *
 * A structurally malformed body parses as null and the caller falls back
 * to rendering the whole raw body — visible degradation beats hidden
 * content. The live lint (ci.yml) exists precisely so this never happens.
 * Two deliberate tolerances: a body with a duplicate locale section keeps
 * the LAST copy (the CI lint flags duplicates), and only format v1 bodies
 * are parsed — a future format bump degrades old apps to the raw render.
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

/** Pick the body to render for the given locale: the locale's own section
 *  when it exists and is translated, else the en-US original (with the
 *  fallback flag), else the raw body verbatim — legacy, unscaffolded or
 *  malformed bodies always render whole; nothing is ever hidden. */
export function selectReleaseBody(body: string, locale: Locale): SelectedReleaseBody {
  const parsed = parseI18nRelease(body);
  if (!parsed) return { source: body, fallback: false };
  const chosen = parsed.sections[locale];
  if (locale !== "en-US" && (!chosen || isPending(chosen))) {
    const en = parsed.sections["en-US"];
    if (en) return { source: en, fallback: true };
    return { source: body, fallback: false }; // scaffold without en-US: raw is safest
  }
  if (chosen) return { source: chosen, fallback: false };
  return { source: body, fallback: false };
}
