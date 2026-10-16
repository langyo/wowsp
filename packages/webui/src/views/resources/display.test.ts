import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/useLanguage", () => ({
  useLanguage: () => ({ uiLocale: { value: "en" }, dataLanguage: { value: "en" } }),
}));

import { presetSwitched } from "./display";
import type { CatalogEntry, ModInstallRecord } from "@/api";

const entry = (presetIds: string[]): CatalogEntry =>
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
});
