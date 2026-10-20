/**
 * Tests for the square composition seal (CompSeal) — the live panel's
 * 空中小人 / 水下小人 glyph+share face. Assertions ride on the SVG
 * structure (frames, the veteran wash, the glyph path, the figure text)
 * and the tier→kind resolution; the zh gate and the per-kind kill switch
 * ride the same refs the real stores own.
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
    props: { cls: "air", share: 34, ...props },
    global: { plugins: [createPinia()] },
  });
}

function svgOf(wrapper: ReturnType<typeof mountSeal>) {
  return wrapper.find("svg.comp-seal");
}

describe("CompSeal", () => {
  it("presses the glyph and the rounded share figure inside the square frame", () => {
    const wrapper = mountSeal({ share: 34.4 });
    const svg = svgOf(wrapper);
    expect(svg.exists()).toBe(true);
    // The double frame (mini variant geometry) and the glyph path.
    expect(svg.findAll("rect.comp-seal__frame")).toHaveLength(2);
    expect(svg.find("path").attributes("d")).toContain("M12 1.5");
    // 34.4 rounds to 34 — the figure is the seal's second character row.
    expect(svg.find("text.comp-seal__pct").text()).toBe("34%");
    // Minor tier: no wash.
    expect(svg.find("rect[opacity='0.1']").exists()).toBe(false);
  });

  it("presses the veteran tier harder — the kind, the wash and the label", () => {
    const wrapper = mountSeal({ cls: "sub", veteran: true, share: 61 });
    const svg = svgOf(wrapper);
    expect(svg.attributes("aria-label")).toBe("水下奶蛙");
    expect(svg.find("text.comp-seal__pct").text()).toBe("61%");
    // The faint inner wash (印底) only the veteran tier carries.
    expect(svg.find("rect[opacity='0.1']").exists()).toBe(true);
    expect(svg.find("path").attributes("d")).toContain("M2.4 13.5");
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
      expect(svgOf(mountSeal({ share: 61 })).exists()).toBe(true); // minor air
      expect(svgOf(mountSeal({ veteran: true, share: 61 })).exists()).toBe(false);
    } finally {
      statsPrefsState.value.sealDisabled = prev;
    }
  });

  it("keeps the seal face without the figure when the share is absent", () => {
    const wrapper = mountSeal({ share: null });
    const svg = svgOf(wrapper);
    expect(svg.exists()).toBe(true);
    expect(svg.find("text.comp-seal__pct").exists()).toBe(false);
  });

  it("presses the detailed glyph track and the wide frame on the full variant", () => {
    const wrapper = mountSeal({ variant: "full", share: 34 });
    const svg = svgOf(wrapper);
    // The wide full-variant border (x=5 vs the mini's 3.5) and the moiré
    // weave only the full face carries.
    expect(svg.find('rect[x="5"]').exists()).toBe(true);
    expect(svg.find(".comp-seal__moire").exists()).toBe(true);
    // The glyph rides the 48-grid body (the mini silhouette ×2: the nose
    // moves from M12 1.5 to M24 3) with the detail layer beside it.
    const paths = svg.findAll("path");
    expect(paths.some((p) => p.attributes("d")?.startsWith("M24 3"))).toBe(true);
    expect(svg.find(".comp-seal__detail ellipse").exists()).toBe(true);
  });
});
