/** Regression tests for the 素材翻译 (data-language) mapping layer.
 *  The WG API rejects "zh-sg" (407 INVALID_LANGUAGE on every realm) — the
 *  亚服简体 option must map onto the API's single simplified-Chinese code
 *  "zh-cn", while the realm-distinct ship/nation names come from the offline
 *  game-file DBs. See fix/data-language-mismatch. */
import { describe, expect, it } from "vitest";

import { determineDataLanguage, gettextDir, wgApiLanguage } from "./useLanguage";
import { nationNameFromDb } from "@/features/holographic/modelLoader";

describe("wgApiLanguage", () => {
  it("maps both simplified-Chinese options onto the API's zh-cn", () => {
    expect(wgApiLanguage("zh-CN")).toBe("zh-cn");
    // "zh-sg" is not a WG API language — sending it 407s and used to degrade
    // the whole encyclopedia to English (romanized IJN names).
    expect(wgApiLanguage("zh-SG")).toBe("zh-cn");
  });

  it("maps the remaining lang-locs to their WG codes", () => {
    expect(wgApiLanguage("zh-TW")).toBe("zh-tw");
    expect(wgApiLanguage("en-US")).toBe("en");
    expect(wgApiLanguage("ja-JP")).toBe("ja");
  });
});

describe("gettextDir", () => {
  it("keeps the regional game text dirs distinct", () => {
    expect(gettextDir("zh-CN")).toBe("zh");
    expect(gettextDir("zh-SG")).toBe("zh_sg");
    expect(gettextDir("zh-TW")).toBe("zh_tw");
  });
});

describe("determineDataLanguage", () => {
  it("picks 国服简体 only for the CN realm", () => {
    expect(determineDataLanguage("zh-CN", "cn")).toBe("zh-CN");
    expect(determineDataLanguage("zh-CN", "asia")).toBe("zh-SG");
  });
});

describe("nationNameFromDb", () => {
  it("serves the harmonized X-系 names for 国服简体", () => {
    expect(nationNameFromDb("japan", "zh-CN")).toBe("R系");
    expect(nationNameFromDb("usa", "zh-CN")).toBe("M系");
  });

  it("serves regular country names for 亚服简体", () => {
    expect(nationNameFromDb("japan", "zh-SG")).toBe("日本");
    expect(nationNameFromDb("pan_asia", "zh-SG")).toBe("泛亚");
  });

  it("resolves both WG API and GameParams nation codes", () => {
    expect(nationNameFromDb("uk", "zh-SG")).toBe(nationNameFromDb("united_kingdom", "zh-SG"));
    expect(nationNameFromDb("ussr", "zh-SG")).toBe(nationNameFromDb("russia", "zh-SG"));
  });

  it("falls back to English then null", () => {
    expect(nationNameFromDb("japan")).toBe("Japan");
    expect(nationNameFromDb("japan", "xx-XX")).toBe("Japan");
    expect(nationNameFromDb("sweden", "zh-CN")).toBeNull();
    expect(nationNameFromDb(undefined)).toBeNull();
  });
});
