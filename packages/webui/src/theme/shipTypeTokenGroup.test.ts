/** The ship-palette ↔ hikari token-group seam: the store projection
 *  (registration with live-locale labels and store-backed per-mode
 *  defaults), the editor-draft write-back, and the strip-before-persist
 *  rule that keeps the palette out of saved theme data. Each case
 *  re-imports against a fresh registry (vi.resetModules also rebuilds
 *  hikari's module state, so the test's imports and the module under
 *  test always share one registry instance). */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({
  // Labels are resolved through the live locale at sync time — the key
  // itself is the cleanest assertion surface under a stubbed t().
  t: (key: string) => key,
}));

import { SHIP_TYPE_COLOR_STORAGE_KEY } from "./shipTypeColors";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function freshModule() {
  const [hikari, store, tokenGroup] = await Promise.all([
    import("@celestia-island/hikari"),
    import("./shipTypeColors"),
    import("./shipTypeTokenGroup"),
  ]);
  return {
    getTokenGroups: hikari.getTokenGroups,
    resolveGroupTokens: hikari.resolveGroupTokens,
    setShipTypeColor: store.setShipTypeColor,
    shipTypeColors: store.shipTypeColors,
    ...tokenGroup,
  };
}

const DRAFT_GROUP = "ship-types";

describe("syncShipTypeTokenGroup", () => {
  it("registers one color slot per ship class, keyed and labeled", async () => {
    const { syncShipTypeTokenGroup, getTokenGroups } = await freshModule();
    syncShipTypeTokenGroup();
    const groups = getTokenGroups().filter((g) => g.id === DRAFT_GROUP);
    expect(groups).toHaveLength(1);
    const slots = groups[0]!.slots ?? [];
    expect(slots.map((s) => s.key)).toEqual([
      "battleship",
      "aircarrier",
      "cruiser",
      "destroyer",
      "submarine",
      "auxiliary",
    ]);
    // t() is stubbed to the identity — the labels must be the i18n keys.
    expect(groups[0]!.label).toBe("settings.shipTypeColors");
    expect(slots.map((s) => s.label)).toEqual([
      "ships.type.Battleship",
      "ships.type.AirCarrier",
      "ships.type.Cruiser",
      "ships.type.Destroyer",
      "ships.type.Submarine",
      "ships.type.Auxiliary",
    ]);
    // Kind-less slots are hikari's color form (pickers, hue unclamped).
    expect(slots.every((s) => s.kind === undefined)).toBe(true);
  });

  it("seeds the per-mode slot defaults from the CURRENT store", async () => {
    localStorage.setItem(
      SHIP_TYPE_COLOR_STORAGE_KEY,
      JSON.stringify({
        dark: {
          battleship: { r: 1, g: 2, b: 3 },
          aircarrier: { r: 4, g: 5, b: 6 },
          cruiser: { r: 7, g: 8, b: 9 },
          destroyer: { r: 10, g: 11, b: 12 },
          submarine: { r: 13, g: 14, b: 15 },
          auxiliary: { r: 16, g: 17, b: 18 },
        },
      }),
    );
    const { syncShipTypeTokenGroup, resolveGroupTokens } = await freshModule();
    syncShipTypeTokenGroup();
    const dark = resolveGroupTokens("dark")[DRAFT_GROUP]!;
    expect(dark.battleship).toEqual({ r: 1, g: 2, b: 3 });
    // The untouched light mode resolves to the factory palette.
    const light = resolveGroupTokens("light")[DRAFT_GROUP]!;
    expect(light.battleship).toEqual({ r: 209, g: 72, b: 66 });
  });

  it("re-syncing REPLACES the definition (labels and defaults follow)", async () => {
    const { syncShipTypeTokenGroup, getTokenGroups, setShipTypeColor } = await freshModule();
    syncShipTypeTokenGroup();
    setShipTypeColor("dark", "cruiser", { r: 42, g: 42, b: 42 });
    syncShipTypeTokenGroup();
    const groups = getTokenGroups().filter((g) => g.id === DRAFT_GROUP);
    expect(groups).toHaveLength(1);
    const cruiser = groups[0]!.slots?.find((s) => s.key === "cruiser");
    expect(cruiser?.defaults.dark).toEqual({ r: 42, g: 42, b: 42 });
  });
});

describe("shipGroupOverrides", () => {
  it("projects the store's palette for one mode as editor prefill values", async () => {
    const { shipGroupOverrides, setShipTypeColor } = await freshModule();
    setShipTypeColor("light", "destroyer", { r: 5, g: 6, b: 7 });
    const light = shipGroupOverrides("light");
    expect(light.destroyer).toEqual({ r: 5, g: 6, b: 7 });
    // The other mode is untouched — overrides are per mode.
    expect(shipGroupOverrides("dark").destroyer).toEqual({ r: 207, g: 212, b: 216 });
  });
});

describe("applyShipGroupDraft", () => {
  it("writes the draft's ship slots back into the per-mode store", async () => {
    const { applyShipGroupDraft, shipTypeColors } = await freshModule();
    applyShipGroupDraft({
      groups: {
        dark: { [DRAFT_GROUP]: { battleship: { r: 1, g: 1, b: 1 }, cruiser: { r: 2, g: 2, b: 2 } } },
        light: { [DRAFT_GROUP]: { battleship: { r: 3, g: 3, b: 3 } } },
      },
    });
    expect(shipTypeColors.value.dark.battleship).toEqual({ r: 1, g: 1, b: 1 });
    expect(shipTypeColors.value.dark.cruiser).toEqual({ r: 2, g: 2, b: 2 });
    expect(shipTypeColors.value.light.battleship).toEqual({ r: 3, g: 3, b: 3 });
    // A partial draft never zeroes the store's missing mode entries.
    expect(shipTypeColors.value.light.cruiser).toEqual({ r: 52, g: 151, b: 218 });
    expect(localStorage.getItem(SHIP_TYPE_COLOR_STORAGE_KEY)).not.toBeNull();
  });

  it("skips foreign slot values of the wrong primitive", async () => {
    const { applyShipGroupDraft, shipTypeColors } = await freshModule();
    applyShipGroupDraft({
      groups: {
        dark: { [DRAFT_GROUP]: { battleship: "not-a-color", cruiser: { r: 9, g: 9, b: 9 } } },
      },
    });
    expect(shipTypeColors.value.dark.battleship).toEqual({ r: 209, g: 72, b: 66 });
    expect(shipTypeColors.value.dark.cruiser).toEqual({ r: 9, g: 9, b: 9 });
  });

  it("ignores drafts without the ship group", async () => {
    const { applyShipGroupDraft, shipTypeColors } = await freshModule();
    const before = shipTypeColors.value;
    applyShipGroupDraft({ groups: { dark: { scada: { wireA: { r: 0, g: 0, b: 0 } } } } });
    applyShipGroupDraft({});
    expect(shipTypeColors.value).toBe(before);
  });
});

describe("stripShipGroupDraft", () => {
  it("removes the ship group and keeps every other group's slots", async () => {
    const { stripShipGroupDraft } = await freshModule();
    const input = {
      dark: {
        [DRAFT_GROUP]: { battleship: { r: 1, g: 1, b: 1 } },
        scada: { wireA: { r: 0, g: 0, b: 0 } },
      },
      light: { [DRAFT_GROUP]: { battleship: { r: 2, g: 2, b: 2 } } },
    };
    const out = stripShipGroupDraft(input);
    expect(out).toEqual({ dark: { scada: { wireA: { r: 0, g: 0, b: 0 } } } });
    // The (editor-owned, reactive) input draft is never mutated.
    expect(input.dark[DRAFT_GROUP]).toBeDefined();
    expect(input.light[DRAFT_GROUP]).toBeDefined();
  });

  it("returns undefined when nothing remains, so callers can drop the key", async () => {
    const { stripShipGroupDraft } = await freshModule();
    expect(stripShipGroupDraft({ dark: { [DRAFT_GROUP]: {} }, light: {} })).toBeUndefined();
    expect(stripShipGroupDraft({})).toBeUndefined();
  });
});
