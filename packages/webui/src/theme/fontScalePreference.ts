/**
 * WoWSP's five-way font-size preference (-2 smallest … 0 default … +2
 * largest), layered on top of the `--text-*` type scale:
 *
 * Every text size in the app resolves through the CSS custom properties
 * `--text-3xs … --text-display` defined on `:root` (theme/theme.scss plus
 * hikari's scale.scss). Instead of rewriting the root font-size (which must
 * stay at the browser-default 16px), a non-zero level writes an INLINE
 * `--text-*` override on `document.documentElement` — e.g.
 * `calc(0.875rem * 1.1)` for level +1. Inline element style beats every
 * stylesheet declaration (same mechanism hikari's own fontContext uses to
 * inject font-family vars), so the whole UI rescales at once without
 * touching a single component. Level 0 removes every inline override and
 * the `data-font-scale` marker, so the stylesheets rule again.
 *
 * The preference persists under `wowsp-font-scale` as a stringified
 * integer; absent or invalid values fall back to 0.
 */
import { ref } from "vue";

export type FontScaleLevel = -2 | -1 | 0 | 1 | 2;

export const FONT_SCALE_STORAGE_KEY = "wowsp-font-scale";

/** Multiplier applied to every `--text-*` token per level. */
export const FONT_SCALE_FACTORS: Record<FontScaleLevel, number> = {
  [-2]: 0.8,
  [-1]: 0.9,
  0: 1,
  1: 1.1,
  2: 1.2,
};

/** All five levels, smallest → largest (the settings segmented control's
 *  tab order). */
export const FONT_SCALE_LEVELS: readonly FontScaleLevel[] = [-2, -1, 0, 1, 2];

/** Base value of EVERY `--text-*` token defined on `:root` — the union of
 *  theme/theme.scss's Font sizes block and hikari's styles/theme/scale.scss
 *  Type block. This table MUST mirror those two files exactly: a token
 *  missing here would refuse to scale when overridden inline, and a stale
 *  value would apply the wrong size at non-zero levels. Keep in sync when
 *  either file's scale changes. */
const BASE_TEXT_TOKENS: Record<string, string> = {
  "--text-3xs": "0.5rem", // hikari scale.scss only
  "--text-2xs": "0.625rem",
  "--text-xs": "0.75rem",
  "--text-sm": "0.8125rem",
  "--text-base": "0.875rem",
  "--text-md": "1rem",
  "--text-lg": "1.125rem",
  "--text-xl": "1.25rem",
  "--text-2xl": "1.5rem",
  "--text-display": "2.5rem", // wowsp theme.scss only
};

function isFontScaleLevel(v: unknown): v is FontScaleLevel {
  return v === -2 || v === -1 || v === 0 || v === 1 || v === 2;
}

/** Parse the stored value — with the heal-write. Anything but a stringified
 *  integer in -2..2 falls back to 0 (the current-version default) and is
 *  FORCED back to disk, so an invalid value is corrected once instead of
 *  being silently re-defaulted on every boot. Non-canonical spellings of a
 *  valid level ("" for 0, "1.0" for 1) are normalized to the canonical
 *  string the app itself writes (same contract as the theme-mode
 *  preference). */
export function readStoredFontScaleLevel(): FontScaleLevel {
  try {
    const raw = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    if (raw == null) return 0;
    const parsed = Number(raw);
    if (isFontScaleLevel(parsed)) {
      if (String(parsed) !== raw) {
        localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(parsed));
      }
      return parsed;
    }
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, "0");
    return 0;
  } catch {
    return 0;
  }
}

/** Reactive current level — the settings section and the onboarding wizard
 *  bind their segmented controls to this module-level ref so both surfaces
 *  always agree. */
export const fontScaleLevel = ref<FontScaleLevel>(readStoredFontScaleLevel());

/** Write/clear the inline `--text-*` overrides for a level. Level 0 removes
 *  every override plus the `data-font-scale` marker so the stylesheets rule
 *  untouched. */
function applyFontScale(level: FontScaleLevel) {
  const el = document.documentElement;
  const factor = FONT_SCALE_FACTORS[level];
  for (const [token, base] of Object.entries(BASE_TEXT_TOKENS)) {
    if (level === 0) {
      el.style.removeProperty(token);
    } else {
      el.style.setProperty(token, `calc(${base} * ${factor})`);
    }
  }
  if (level === 0) {
    delete el.dataset.fontScale;
  } else {
    el.dataset.fontScale = String(level);
  }
}

/** Change + persist + apply immediately (settings section, onboarding
 *  wizard — both want live preview). */
export function setFontScaleLevel(level: FontScaleLevel) {
  fontScaleLevel.value = level;
  try {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(level));
  } catch {
    // storage unavailable — the preference holds for the session
  }
  applyFontScale(level);
}

/** Boot hook: re-apply the stored level over whatever the stylesheets
 *  declare (and heal a session where the inline overrides were cleared). */
export function initFontScalePreference() {
  applyFontScale(fontScaleLevel.value);
}
