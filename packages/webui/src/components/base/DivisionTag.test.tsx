/**
 * Tests for the division tag face (DivisionTag, 组队标签) — the yellow
 * sibling of StampTag's small-tag seal face. Divisions are battle facts,
 * not the seals' zh-community artifact, so there is no locale gate and no
 * prefs kill switch to exercise: the suite pins the en-US fallback face
 * for the label assertions (the module-singleton ref the composable hands
 * out) and the mount pattern mirrors StampTag.test.tsx's.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPinia } from "pinia";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import { initLocaleMessages } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import DivisionTag from "./DivisionTag";

enableAutoUnmount(afterEach);

useLanguage().uiLocale.value = "en-US";

beforeAll(async () => {
  // The locale bundles are lazy — the label assertions read the loaded
  // en-US message table.
  await initLocaleMessages();
});

function mountTag(letter: string) {
  return mount(DivisionTag, {
    props: { letter },
    global: { plugins: [createPinia()] },
  });
}

describe("DivisionTag", () => {
  it("presses the localized division wording as the horizontal tag span", () => {
    const wrapper = mountTag("A");
    const tag = wrapper.find("span.division-tag");
    expect(tag.exists()).toBe(true);
    expect(tag.text()).toBe("Div. A");
    expect(tag.attributes("aria-label")).toBe("Div. A");
    expect(tag.attributes("role")).toBe("img");
  });

  it("carries a second team's letter through the same face", () => {
    const tag = mountTag("B").find("span.division-tag");
    expect(tag.text()).toBe("Div. B");
  });
});
