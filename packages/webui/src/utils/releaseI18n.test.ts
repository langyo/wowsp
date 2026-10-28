/** Fixtures mirror scripts/release_notes_i18n.py's SAMPLE_EN scaffold
 *  (truncated after the zh-CN section — the parser tolerates missing
 *  locales) — the python self-test and these cases must stay in
 *  agreement (AGENTS.md §10). */
import { describe, expect, it } from "vitest";

import { parseI18nRelease, selectReleaseBody } from "./releaseI18n";

const EN_CONTENT = [
  "## What's Changed",
  "",
  "### ✨ Features",
  "",
  "- [#1413](https://github.com/langyo/wowsp/pull/1413) ✨ Add an optional K/D column to the water-table surfaces.",
  "",
  "### 🐛 Fixes",
  "",
  "- [#1409](https://github.com/langyo/wowsp/pull/1409) 🐛 Fit calibration editor stage inside the modal body cap.",
  "",
  "**Full Changelog**: https://github.com/langyo/wowsp/compare/v0.6.6...v0.6.7",
].join("\n");

const PENDING_ZH = "🚧 本版本的更新说明尚未翻译，请展开 English (en-US) 一节阅读英文原文。";

const ZH_CONTENT = [
  "## 更新内容",
  "",
  "### ✨ 新功能",
  "",
  "- [#1413](https://github.com/langyo/wowsp/pull/1413) ✨ 为水面舰艇表格新增可选的 K/D 列。",
  "- [#1409](https://github.com/langyo/wowsp/pull/1409) 🐛 让校准编辑器舞台收进弹窗主体的高度上限内。",
  "",
  "**完整变更日志**: https://github.com/langyo/wowsp/compare/v0.6.6...v0.6.7",
].join("\n");

function scaffold(zhSection: string): string {
  return [
    "<!-- wowsp:i18n v1 -->",
    "<details open>",
    "<summary>🌐 English (en-US)</summary>",
    "",
    "<!-- wowsp:lang en-US -->",
    "",
    ...EN_CONTENT.split("\n"),
    "",
    "</details>",
    "<details>",
    "<summary>🌐 简体中文 (zh-CN)</summary>",
    "",
    "<!-- wowsp:lang zh-CN -->",
    "",
    ...zhSection.split("\n"),
    "",
    "</details>",
  ].join("\n");
}

const LEGACY_BODY = "## What's Changed\n\n- [#1](https://example.com/pull/1) old shape.";

describe("parseI18nRelease", () => {
  it("parses the scaffold sections in agreement with the python builder", () => {
    const parsed = parseI18nRelease(scaffold(PENDING_ZH));
    expect(parsed).not.toBeNull();
    expect(parsed?.formatVersion).toBe(1);
    expect(parsed?.sections["en-US"]).toBe(EN_CONTENT);
    expect(parsed?.sections["zh-CN"]).toBe(PENDING_ZH);
  });

  it("returns null for legacy bodies", () => {
    expect(parseI18nRelease(LEGACY_BODY)).toBeNull();
    expect(parseI18nRelease("")).toBeNull();
  });

  it("returns null on a future format version (safe raw render)", () => {
    expect(parseI18nRelease(scaffold(PENDING_ZH).replace("wowsp:i18n v1", "wowsp:i18n v2"))).toBeNull();
  });

  it("returns null on structural deviations (unterminated section)", () => {
    const broken = scaffold(PENDING_ZH).split("\n").slice(0, -1).join("\n");
    expect(parseI18nRelease(broken)).toBeNull();
  });

  it("returns null when the summary locale and the marker disagree", () => {
    const flipped = scaffold(PENDING_ZH).replace("<!-- wowsp:lang zh-CN -->", "<!-- wowsp:lang zh-TW -->");
    expect(parseI18nRelease(flipped)).toBeNull();
  });

  it("returns null on a nested details opener inside a section", () => {
    const nested = scaffold(PENDING_ZH).replace(
      "## What's Changed",
      "<details>\n## What's Changed",
    );
    expect(parseI18nRelease(nested)).toBeNull();
  });
});

describe("selectReleaseBody", () => {
  it("renders legacy bodies verbatim for every locale", () => {
    expect(selectReleaseBody(LEGACY_BODY, "en-US")).toEqual({ source: LEGACY_BODY, fallback: false });
    expect(selectReleaseBody(LEGACY_BODY, "zh-CN")).toEqual({ source: LEGACY_BODY, fallback: false });
  });

  it("serves the en-US section to en-US users", () => {
    expect(selectReleaseBody(scaffold(PENDING_ZH), "en-US")).toEqual({
      source: EN_CONTENT,
      fallback: false,
    });
  });

  it("falls back to en-US with the hint flag while zh-CN is pending", () => {
    expect(selectReleaseBody(scaffold(PENDING_ZH), "zh-CN")).toEqual({
      source: EN_CONTENT,
      fallback: true,
    });
  });

  it("falls back to en-US when the locale has no section at all", () => {
    expect(selectReleaseBody(scaffold(PENDING_ZH), "ja-JP")).toEqual({
      source: EN_CONTENT,
      fallback: true,
    });
  });

  it("serves the translated section once it lands", () => {
    expect(selectReleaseBody(scaffold(ZH_CONTENT), "zh-CN")).toEqual({
      source: ZH_CONTENT,
      fallback: false,
    });
  });

  it("renders a malformed scaffold verbatim instead of hiding content", () => {
    const broken = scaffold(PENDING_ZH).split("\n").slice(0, -1).join("\n");
    expect(selectReleaseBody(broken, "zh-CN")).toEqual({ source: broken, fallback: false });
  });
});
