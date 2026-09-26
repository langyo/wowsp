/**
 * Coverage guards for the mod-hub taxonomy.
 *
 * The strips are pure lookups, so a new mod kind, a new curated category or a
 * renamed `resources.*` key fails silently at runtime: the value simply stops
 * appearing in every list (or renders as a raw key). These tests pin the
 * mapping as total in both directions and tie every strip entry to a label
 * that exists in all nine shipped locales.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Anchor, Crosshair, MessagesSquare, Puzzle } from "@lucide/vue";

import { i18n, loadLocaleMessages, SUPPORTED_LOCALES } from "@/i18n";

import {
  BIG_CATS,
  CATALOG_CATS,
  KIND_BIG,
  KIND_META,
  KIND_ORDER,
  catBig,
  catIcon,
  isCatalogCat,
  type BigCat,
} from "./taxonomy";

// Locale messages load lazily now (one bundle per locale) — pull all nine
// in before the label-parity test reads them off the i18n instance.
beforeAll(async () => {
  await Promise.all(SUPPORTED_LOCALES.map((locale) => loadLocaleMessages(locale)));
});

describe("mod-hub taxonomy", () => {
  it("buckets every installed kind and keeps KIND_ORDER complete", () => {
    // A kind missing from KIND_ORDER never gets a chip; one missing from
    // KIND_META renders an undefined tile inside the row.
    expect([...KIND_ORDER].sort()).toEqual(Object.keys(KIND_META).sort());
    for (const kind of KIND_ORDER) {
      expect(KIND_BIG[kind], kind).toBeDefined();
    }
  });

  it("gives every big category a row source", () => {
    // A big tab that no kind and no catalog category maps into is a
    // permanently empty strip.
    for (const big of BIG_CATS) {
      const reachable =
        KIND_ORDER.some((k) => KIND_BIG[k] === big) ||
        CATALOG_CATS.some((c) => catBig(c) === big);
      expect(reachable, big).toBe(true);
    }
  });

  it("buckets unknown catalog categories with function", () => {
    // Unknown values must be visible somewhere rather than dropped.
    expect(catBig("brand-new-category")).toBe("function" satisfies BigCat);
  });

  it("separates the catalog vocabulary from the on-disk kind names", () => {
    for (const cat of CATALOG_CATS) expect(isCatalogCat(cat), cat).toBe(true);
    // Kinds are not catalog categories…
    expect(isCatalogCat("voice")).toBe(false);
    expect(isCatalogCat("skin")).toBe(false);
    expect(isCatalogCat("textures")).toBe(false);
    // …except "patch", which exists in both — the collision that makes
    // catBig unusable for installed rows.
    expect(isCatalogCat("patch")).toBe(true);
    expect(KIND_BIG.patch).toBe(catBig("patch"));
  });

  it("resolves tile glyphs and falls back to the generic one", () => {
    expect(catIcon("battle")).toBe(Crosshair);
    expect(catIcon("port")).toBe(Anchor);
    expect(catIcon("text")).toBe(MessagesSquare);
    expect(catIcon("brand-new-category")).toBe(Puzzle);
  });

  it("labels every strip entry in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale) as {
        resources?: Record<string, Record<string, string>>;
      };
      const resources = messages.resources ?? {};
      for (const cat of CATALOG_CATS) {
        expect(resources.cat?.[cat], `${locale} resources.cat.${cat}`).toBeTypeOf("string");
      }
      for (const big of BIG_CATS) {
        expect(resources.big?.[big], `${locale} resources.big.${big}`).toBeTypeOf("string");
      }
      for (const kind of KIND_ORDER) {
        expect(resources.kind?.[kind], `${locale} resources.kind.${kind}`).toBeTypeOf("string");
      }
      for (const source of ["online", "installed"]) {
        expect(resources.source?.[source], `${locale} resources.source.${source}`).toBeTypeOf(
          "string",
        );
      }
    }
  });
});
