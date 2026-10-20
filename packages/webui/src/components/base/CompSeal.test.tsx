/**
 * Tests for the square composition seal (CompSeal) — the live panel's
 * 空中小人 / 水下小人 glyph face. Assertions ride on the SVG structure
 * (frames, the veteran wash, the glyph formation) and the tier→kind
 * resolution; the zh gate and the per-kind kill switch ride the same refs
 * the real stores own.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPinia } from "pinia";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import CompSeal from "./CompSeal";
import { useLanguage } from "@/i18n/useLanguage";
import { statsPrefsState } from "@/stores/statsPrefs";

enableAutoUnmount(afterEach);

// The seal is a Chinese-community artifact — nothing renders without a zh
// UI locale (the module-singleton ref the composable hands out).
useLanguage().uiLocale.value = "zh-CN";

function mountSeal(props: Record<string, unknown>) {
  return mount(CompSeal, {
    props: { cls: "air", ...props },
    global: { plugins: [createPinia()] },
  });
}

function svgOf(wrapper: ReturnType<typeof mountSeal>) {
  return wrapper.find("svg.comp-seal");
}

describe("CompSeal", () => {
  it("presses ONE glyph inside the square frame for the minor tier", () => {
    const wrapper = mountSeal({});
    const svg = svgOf(wrapper);
    expect(svg.exists()).toBe(true);
    // The double frame (mini variant geometry) and exactly one glyph.
    expect(svg.findAll("rect.comp-seal__frame")).toHaveLength(2);
    expect(svg.findAll("path")).toHaveLength(1);
    expect(svg.find("path").attributes("d")).toContain("M12 1.5");
    // No figure row and no wash — the glyph alone is the minor tier.
    expect(svg.find("text").exists()).toBe(false);
    expect(svg.find("rect[opacity='0.1']").exists()).toBe(false);
  });

  it("presses the big-over-two triangle formation plus the wash for the veteran tier", () => {
    const wrapper = mountSeal({ cls: "sub", veteran: true });
    const svg = svgOf(wrapper);
    expect(svg.attributes("aria-label")).toBe("水下奶蛙");
    // Three glyphs — the lead above, riding OVER its two flanks (the
    // formation overlaps by design; the lead paints last, on top) — plus
    // the faint inner wash (印底) only the veteran tier carries.
    expect(svg.findAll("path")).toHaveLength(3);
    expect(svg.find("rect[opacity='0.1']").exists()).toBe(true);
    // All three glyphs are the same class silhouette.
    for (const p of svg.findAll("path")) {
      expect(p.attributes("d")).toContain("M2.4 13.5");
    }
    // The formation's transforms: one lead + two equal flanks.
    const transforms = svg
      .findAll("g[transform]")
      .map((g) => g.attributes("transform"));
    expect(transforms).toHaveLength(3);
    expect(
      transforms.filter((t) => t?.includes("scale(1.4)")),
    ).toHaveLength(2);
    expect(transforms.filter((t) => t?.includes("scale(2.6)"))).toHaveLength(1);
  });

  it("renders nothing under a non-zh UI locale", () => {
    const { uiLocale } = useLanguage();
    const prev = uiLocale.value;
    uiLocale.value = "en-US";
    try {
      expect(svgOf(mountSeal({})).exists()).toBe(false);
    } finally {
      uiLocale.value = prev;
    }
  });

  it("renders nothing when its tier's own kind is switched off", () => {
    // The minor tier keys on "air"; the veteran verdict keys on
    // "airVeteran" — each tier respects its own kill switch.
    const prev = statsPrefsState.value.sealDisabled;
    statsPrefsState.value.sealDisabled = { ...prev, airVeteran: true };
    try {
      expect(svgOf(mountSeal({})).exists()).toBe(true); // minor air
      expect(svgOf(mountSeal({ veteran: true })).exists()).toBe(false);
    } finally {
      statsPrefsState.value.sealDisabled = prev;
    }
  });

  it("presses the detailed glyph track and the wide frame on the full variant", () => {
    const wrapper = mountSeal({ variant: "full" });
    const svg = svgOf(wrapper);
    // The wide full-variant border (x=5 vs the mini's 3.5) and the moiré
    // weave only the full face carries.
    expect(svg.find('rect[x="5"]').exists()).toBe(true);
    expect(svg.find(".comp-seal__moire").exists()).toBe(true);
    // The glyph rides the 48-grid body (the mini silhouette ×2: the nose
    // moves from M12 1.5 to M24 3) with the detail layer beside it. The
    // moiré weave's own tiny pattern paths are defs content, not glyphs.
    const paths = svg.findAll("path");
    expect(paths.some((p) => p.attributes("d")?.startsWith("M24 3"))).toBe(true);
    expect(paths.some((p) => p.attributes("d")?.startsWith("M12 1.5"))).toBe(false);
    expect(svg.find(".comp-seal__detail ellipse").exists()).toBe(true);
  });
});
