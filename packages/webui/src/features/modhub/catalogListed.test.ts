import { describe, expect, it } from "vitest";

import type { CatalogEntry } from "@/api";
import { isListed, listedEntries } from "@/features/modhub/catalogListed";

const mk = (id: string, delisted?: boolean): CatalogEntry =>
  ({
    id,
    category: "battle",
    version: "1",
    game: "*",
    bundled: false,
    delisted,
    title: id,
    nameZh: "",
    nameEn: id,
    description: "",
    authorUrl: "",
    packages: [],
    i18n: {},
  }) as CatalogEntry;

describe("catalogListed", () => {
  it("keeps entries without the flag and entries flagged false", () => {
    expect(isListed(mk("a"))).toBe(true);
    expect(isListed(mk("b", false))).toBe(true);
  });

  it("drops entries flagged delisted", () => {
    expect(isListed(mk("c", true))).toBe(false);
    expect(listedEntries([mk("a"), mk("c", true), mk("d", false)])).toEqual([
      mk("a"),
      mk("d", false),
    ]);
  });
});
