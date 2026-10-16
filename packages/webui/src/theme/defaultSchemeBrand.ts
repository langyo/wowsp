/**
 * Factory-default scheme brand override — the light palette of hikari's
 * collapsed `default` preset is inherited synthwave84.light, whose
 * secondary slot is violet (rgb(156, 106, 222)). WoWSP's chrome brand is
 * pink, so the scheme read as pink-violet: the settings swatch split the
 * two colors diagonally and every secondary-driven surface (HkSwitch's
 * checked track, the secondary icon tint, the about-modal gradient) kept
 * the violet in light mode. Re-pointing that one slot at pink makes the
 * whole light scheme read as pure pink; the primary, the remaining slots
 * and the entire dark (Nord) palette stay exactly as hikari ships them.
 *
 * The preset table is hikari's documented consumer seam — tokens resolve
 * through it live on every read — so the swap is a single assignment
 * before initTheme() in bootstrap: the mode-token bridge, the settings
 * swatch and the onboarding picker all pick it up with no extra plumbing.
 * Idempotent by construction (constant re-assigned); a consumer-table
 * without the default preset (hikari warns the table may be replaced) is
 * skipped, not created.
 */
import { themePresets } from "@celestia-island/hikari";

/** The pink the light secondary slot is re-pointed at (#EC4899) — same
 *  weight as the shipped primary (#D63384), one step brighter so the
 *  swatch's two halves still read as a gradient, not a flat disk. */
export const DEFAULT_SCHEME_LIGHT_SECONDARY = { r: 236, g: 72, b: 153 };

export function applyDefaultSchemeBrand(): void {
  const light = themePresets.default?.light;
  if (light) light.secondary = { ...DEFAULT_SCHEME_LIGHT_SECONDARY };
}
