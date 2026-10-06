/**
 * The shipped migration list — append-only (engine.ts carries the
 * eligibility and ledger contracts). Each entry is a historical fact
 * about one release: keep every value it writes hardcoded to the release
 * it describes, never a live default that may move again later.
 */
import { useTheme } from "@celestia-island/hikari";

import { UI_OPACITY_STORAGE_KEY, setUiOpacityPercent } from "@/theme/uiOpacityPreference";

import { runMigrations, type AppMigration } from "./engine";

export const APP_MIGRATIONS: AppMigration[] = [
  {
    id: "ui-opacity-95-on-default-theme",
    introducedIn: "0.5.2",
    run: () => {
      // Historical facts of the 0.5.2 change — deliberately hardcoded, NOT
      // read from uiOpacityPreference, whose default may move again later.
      const previousDefault = 80;
      const raisedDefault = 95;
      // Only profiles on the factory default scheme: a custom scheme is a
      // deliberately tuned look. hikari resolved currentTheme from storage
      // at module import, before any of this runs (retired preset ids fall
      // back to "default" there, so they count as the default scheme too).
      // This leans on hikari's collapsed preset table shipping "default" as
      // the ONLY builtin — if presets ever come back, factory-default
      // profiles resolve to the preset id and this guard skips them; the
      // migration is one-shot at 0.5.2, so that era is long consumed by
      // then.
      if (useTheme().currentTheme.value !== "default") return;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(UI_OPACITY_STORAGE_KEY);
      } catch {
        return;
      }
      // No stored value → the raised UI_OPACITY_DEFAULT already carries the
      // profile (and keeps following future default changes). Any other
      // stored value is an explicit dial choice. Only the OLD default
      // moves to the new one.
      if (stored !== String(previousDefault)) return;
      setUiOpacityPercent(raisedDefault);
    },
  },
];

/** Main-shell boot entry (main.ts): runs before bootstrap() — actions may
 *  rewrite stored slots the preference modules hydrate at import — and
 *  while `wowsp-last-run-version` still holds the previous run's value. */
export function runStartupMigrations(): string[] {
  return runMigrations({ migrations: APP_MIGRATIONS });
}
