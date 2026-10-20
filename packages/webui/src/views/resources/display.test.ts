import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/useLanguage", () => ({
  useLanguage: () => ({ uiLocale: { value: "en" }, dataLanguage: { value: "en" } }),
}));

import { installedPresetOf, presetSwitched } from "./display";
import type { CatalogEntry, ModInstallRecord } from "@/api";

const entry = (presetIds: string[], supersedes?: Record<string, string>): CatalogEntry =>
  ({
    id: "smi",
    category: "battle",
    version: "1",
    game: "*",
    title: "t",
    nameZh: "",
    nameEn: "e",
    description: "",
    authors: [],
    packages: [],
    i18n: {},
    presets: presetIds.map((id) => ({ id, nameZh: id, nameEn: id, packages: [] })),
    ...(supersedes ? { supersedes } : {}),
  }) as unknown as CatalogEntry;

const record = (preset?: string | null): ModInstallRecord =>
  ({ id: "smi", version: "1", gameRoot: "C:/G", preset: preset ?? null }) as ModInstallRecord;

describe("presetSwitched", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags a scheme change on an installed preset entry", () => {
    expect(presetSwitched(entry(["classic", "sasagcy"]), record("classic"), "sasagcy")).toBe(true);
    expect(presetSwitched(entry(["classic", "sasagcy"]), record("classic"), "classic")).toBe(false);
  });

  it("treats a preset-less record as sitting on the default scheme", () => {
    expect(presetSwitched(entry(["classic", "sasagcy"]), record(null), "classic")).toBe(false);
    expect(presetSwitched(entry(["classic", "sasagcy"]), record(null), "sasagcy")).toBe(true);
    expect(presetSwitched(entry(["classic", "sasagcy"]), record(undefined), "sasagcy")).toBe(true);
  });

  it("never flags entries without presets or without a record", () => {
    expect(presetSwitched(entry([]), record("classic"), "classic")).toBe(false);
    expect(presetSwitched(entry(["classic", "sasagcy"]), null, "sasagcy")).toBe(false);
    expect(presetSwitched(entry(["classic", "sasagcy"]), undefined, "other")).toBe(false);
  });

  it("maps a superseded legacy record onto its folded scheme", () => {
    // A folded style family: the record was written under the legacy
    // one-entry-per-variant id and carries no preset — its scheme is
    // the one the old id folded into, not the default first one.
    const folded = entry(["classic", "ttaro", "deceased"], {
      "battle.panel.ttaro": "ttaro",
      "battle.panel.deceased": "deceased",
    });
    const legacy = {
      id: "battle.panel.ttaro",
      version: "1",
      gameRoot: "C:/G",
      preset: null,
    } as ModInstallRecord;
    expect(installedPresetOf(folded, legacy)).toBe("ttaro");
    expect(presetSwitched(folded, legacy, "ttaro")).toBe(false);
    expect(presetSwitched(folded, legacy, "classic")).toBe(true);
    // An explicit preset on the record still wins over the mapping.
    expect(installedPresetOf(folded, { ...legacy, preset: "deceased" })).toBe("deceased");
    // No record → the default scheme; no mapping → the default too.
    expect(installedPresetOf(folded, null)).toBe("classic");
    expect(installedPresetOf(entry(["classic", "sasagcy"]), record(null))).toBe("classic");
  });
});
