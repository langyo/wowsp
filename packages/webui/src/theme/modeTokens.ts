/**
 * Mode token bridge — WoWSP's side of hikari's documented consumer
 * contract ("color tokens come from the consumer's theme bridge"):
 *
 *   initTheme() overrides the static :root light table at runtime — but
 *   the override travels as a deltas-only managed <style> block, and in
 *   the dark mode that block has been observed to lose the cascade on
 *   some boots (the static light table in hikari's channels.scss then
 *   shows through: dark background, LIGHT surfaces — the "dark mode
 *   renders light content" report). Inline styles on documentElement
 *   beat every stylesheet rule, so the bridge writes the resolved
 *   palette there directly and keeps it in sync with theme + mode.
 *
 * Scope: the CORE color tokens of the resolved theme only. Extension
 * token groups (ship-type palette) keep hikari's own managed block —
 * their vars are namespaced and re-applied by the registry.
 */
import { getThemeTokens, tokensToCSSVars, useTheme } from "@celestia-island/hikari";
import { watch } from "vue";

let stopWatch: (() => void) | null = null;

/** Write the resolved theme/mode palette as inline custom properties on
 *  <html>. Inline beats every stylesheet rule, so the mode always shows. */
export function applyModeTokens(): void {
  const theme = useTheme();
  const id = theme.currentTheme.value;
  const mode = theme.effectiveMode.value;
  if (!id) return;
  try {
    const tokens = getThemeTokens(id, mode);
    if (!tokens) return;
    const vars = tokensToCSSVars(tokens);
    const el = document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
      el.style.setProperty(key, value);
    }
  } catch {
    // A failed bridge write degrades to hikari's own application path.
  }
}

/** Start the bridge: apply now and follow every theme/mode change.
 *  Idempotent; the returned stop is only used by tests. */
export function startModeTokenBridge(): void {
  if (stopWatch) return;
  applyModeTokens();
  const theme = useTheme();
  stopWatch = watch(
    () => [theme.currentTheme.value, theme.effectiveMode.value] as const,
    () => applyModeTokens(),
  );
}

export function stopModeTokenBridge(): void {
  stopWatch?.();
  stopWatch = null;
}
