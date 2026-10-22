/**
 * hikari runtime bootstrap for both console entries — the SAME calls the
 * website's main.ts makes (theme vars, font context, viewport policy).
 * hikari's initTheme() owns every --color-* token on the page; nothing
 * hand-rolls a palette here.
 */
import { applyViewportPolicy, initFontContext, initTheme } from "@celestia-island/hikari";

import "@/styles/hikari.scss";

export function bootHikari(locale: string): void {
  document.documentElement.lang = locale;
  initTheme();
  initFontContext();
  applyViewportPolicy();
}
