/**
 * The ship-type palette AS a hikari extension token group — the seam that
 * lets the color scheme editor window (ThemeSchemeDialog →
 * HkColorSchemeEditor) host the six per-class pickers as one "extended
 * colors" panel instead of wowsp keeping a separate settings section.
 *
 * The store (theme/shipTypeColors) stays the single source of truth: this
 * module only PROJECTS it onto hikari's group registry, in both
 * directions.
 *
 *   store → registry  — syncShipTypeTokenGroup() (re-)registers the group
 *     with the CURRENT stored palettes as the per-mode slot defaults and
 *     the CURRENT locale's labels. hikari's editor seeds its draft from
 *     the registry defaults / the host's initialGroups, so a registration
 *     refresh is all a locale switch or a reset needs. Registration is
 *     idempotent by id (replace), and hikari re-emits the theme CSS vars
 *     after every registration.
 *
 *   editor → store    — applyShipGroupDraft() writes an editor draft's
 *     ship slots back into the per-mode store on save; stripShipGroupDraft()
 *     removes the group from a draft before it persists as theme data (the
 *     palette is a global preference, not per-scheme data — the panel
 *     reseeds from the store on every open, so persisting it would only
 *     fork a second copy that can drift).
 *
 * The editor edits both modes (its grammar is per-mode), which is exactly
 * the store's shape — no bridging loss in either direction.
 */
import {
  registerTokenGroup,
  type ThemeTokenGroupModes,
  type ThemeTokenGroupValues,
  type TokenGroupDefinition,
} from "@celestia-island/hikari";

import { t } from "@/i18n";

import {
  SHIP_TYPE_COLOR_LABEL_KEYS,
  SHIP_TYPE_COLOR_ORDER,
  setShipTypePalette,
  shipTypeColors,
  type ShipTypeColorKey,
  type ShipTypeRgbColor,
} from "./shipTypeColors";

/** The group's registry id — forms the `--ship-types-<key>` CSS vars
 *  hikari emits for the slots (unused by wowsp today, kept stable anyway). */
export const SHIP_TYPE_TOKEN_GROUP_ID = "ship-types";

/** Project the store onto the registry: one color slot per ship class,
 *  labels resolved through the LIVE locale (re-sync after a language
 *  switch refreshes them) and the CURRENT stored palettes as the per-mode
 *  defaults (a preset/custom theme carrying no group override resolves to
 *  these, so the chart palette survives theme switches). */
export function syncShipTypeTokenGroup(): void {
  const def: TokenGroupDefinition = {
    id: SHIP_TYPE_TOKEN_GROUP_ID,
    label: t("settings.shipTypeColors"),
    slots: SHIP_TYPE_COLOR_ORDER.map((key) => ({
      key,
      label: t(`ships.type.${SHIP_TYPE_COLOR_LABEL_KEYS[key]}`),
      defaults: {
        dark: { ...shipTypeColors.value.dark[key] },
        light: { ...shipTypeColors.value.light[key] },
      },
    })),
  };
  registerTokenGroup(def);
}

/** The store's palette for ONE mode as editor prefill values
 *  (ThemeSchemeDialog merges these over the edit target's own groups, so
 *  the ship panel always edits what the charts will read). */
export function shipGroupOverrides(mode: "dark" | "light"): ThemeTokenGroupValues {
  const palette = shipTypeColors.value[mode];
  const values: ThemeTokenGroupValues = {};
  for (const key of SHIP_TYPE_COLOR_ORDER) {
    values[key] = { ...palette[key] };
  }
  return values;
}

/** Editor draft → store: write the draft's ship slots for every mode it
 *  carries (the editor always drafts both; a missing mode is skipped, not
 *  zeroed — the store never loses a mode to a partial draft). One batched
 *  store write per mode. */
export function applyShipGroupDraft(draft: { groups?: ThemeTokenGroupModes }): void {
  for (const mode of ["dark", "light"] as const) {
    const slots = draft.groups?.[mode]?.[SHIP_TYPE_TOKEN_GROUP_ID];
    if (!slots) continue;
    const partial: Partial<Record<ShipTypeColorKey, ShipTypeRgbColor>> = {};
    for (const key of SHIP_TYPE_COLOR_ORDER) {
      const value = slots[key];
      // A foreign/stale slot of the wrong primitive is skipped, not
      // written — the store stays a complete valid palette.
      if (value != null && typeof value === "object") {
        partial[key] = value as ShipTypeRgbColor;
      }
    }
    // Nothing valid arrived for this mode — no store write, no identity
    // churn for the chart watches.
    if (Object.keys(partial).length === 0) continue;
    setShipTypePalette(mode, partial);
  }
}

/** Remove the ship group from a draft (a fresh shallow copy — the editor's
 *  reactive draft is never mutated). Returns undefined when nothing else
 *  remains, so the caller can drop the `groups` key entirely. */
export function stripShipGroupDraft(
  groups: ThemeTokenGroupModes,
): ThemeTokenGroupModes | undefined {
  const out: ThemeTokenGroupModes = {};
  for (const mode of ["dark", "light"] as const) {
    const slots: Record<string, unknown> = { ...(groups[mode] ?? {}) };
    delete slots[SHIP_TYPE_TOKEN_GROUP_ID];
    if (Object.keys(slots).length > 0) {
      out[mode] = slots as ThemeTokenGroupValues;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
