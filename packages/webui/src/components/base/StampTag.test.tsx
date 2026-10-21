/**
 * Tests for the secondary seal face (StampTag, 二级章) — the horizontal
 * transparent tag with the rounded cinnabar border that the four-char
 * composition / merged seals press with beside a row's score line. The
 * zh gate and the per-kind kill switch ride the same refs the real stores
 * own, the same way the retired CompSeal's suite exercised them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPinia } from "pinia";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import StampTag from "./StampTag";
import { useLanguage } from "@/i18n/useLanguage";
import { statsPrefsState } from "@/stores/statsPrefs";
import type { StampKind } from "@/utils/winrate";

enableAutoUnmount(afterEach);

// The seal is a Chinese-community artifact — nothing renders without a zh
// UI locale (the module-singleton ref the composable hands out).
useLanguage().uiLocale.value = "zh-CN";

function mountTag(kind: StampKind) {
  return mount(StampTag, {
    props: { kind },
    global: { plugins: [createPinia()] },
  });
}

describe("StampTag", () => {
  it("presses the four-char wording as the horizontal tag span", () => {
    const wrapper = mountTag("air");
    const tag = wrapper.find("span.stamp-tag");
    expect(tag.exists()).toBe(true);
    expect(tag.text()).toBe("空中小人");
    // The native tooltip carries the award criteria (the resolved
    // stats.sealAirDesc copy).
    expect(tag.attributes("title")).toContain("Awarded when carrier battles exceed 20%");
    expect(wrapper.find("img.stamp-tag").exists()).toBe(false);
  });

  it("carries the merged seal's wording through the same face", () => {
    const wrapper = mountTag("subMiracle");
    expect(wrapper.find("span.stamp-tag").text()).toBe("水下神人");
  });

  it("renders nothing under a non-zh UI locale", () => {
    const { uiLocale } = useLanguage();
    const prev = uiLocale.value;
    uiLocale.value = "en-US";
    try {
      const wrapper = mountTag("air");
      expect(wrapper.find("span.stamp-tag").exists()).toBe(false);
    } finally {
      uiLocale.value = prev;
    }
  });

  it("renders nothing when its kind is switched off", () => {
    const prev = statsPrefsState.value.sealDisabled;
    statsPrefsState.value.sealDisabled = { ...prev, air: true };
    try {
      expect(mountTag("air").find("span.stamp-tag").exists()).toBe(false);
      // A sibling kind keeps its tag (the kill switch is per-kind).
      expect(mountTag("sub").find("span.stamp-tag").exists()).toBe(true);
    } finally {
      statsPrefsState.value.sealDisabled = prev;
    }
  });
});
