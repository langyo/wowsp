/**
 * Contract tests for the live stats-source chip (LiveStatsModeChip): its
 * trigger must be AppTag's standard face, never a hand-rolled pill — the
 * 显示列 chip used to restate HkTag-sm's anatomy 2.2 CSS px taller than
 * every AppTag beside it in the live head / post-battle toolbar
 * (2026-11-16 review). The face keys off the shared statsPrefs column
 * state: resting columns = outline/default, customized = outline/success;
 * the wrapper div stays only as the HkPopover anchor.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import { initLocaleMessages, t } from "@/i18n";
import { DEFAULT_STATS_PREFS, statsPrefsState } from "@/stores/statsPrefs";
import LiveStatsModeChip from "./LiveStatsModeChip";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  setActivePinia(createPinia());
  // The store reads this module-level ref directly, so reset it wholesale
  // (a column list left over by another case would flip the active face).
  statsPrefsState.value = {
    ...DEFAULT_STATS_PREFS,
    overlayColumns: DEFAULT_STATS_PREFS.overlayColumns.map((c) => ({ ...c })),
  };
});

describe("LiveStatsModeChip trigger face", () => {
  it("renders AppTag's outline face at the standard HkTag-sm rung", () => {
    const wrapper = mount(LiveStatsModeChip);
    // The hand-rolled pill class is gone; the wrapper is just the anchor.
    expect(wrapper.find(".live-battle__mode-btn").exists()).toBe(false);
    const btn = wrapper.find(".live-battle__mode-anchor button.app-tag-btn");
    expect(btn.exists()).toBe(true);
    const tag = btn.find("span.hk-tag");
    expect(tag.exists()).toBe(true);
    expect(tag.classes()).toContain("hk-tag-sm");
    expect(tag.classes()).toContain("app-tag");
    expect(tag.classes()).toContain("app-tag--outline");
    // Resting face: the neutral tone, and the chip's own name as the label.
    expect(tag.classes()).toContain("app-tag--default");
    expect(tag.classes()).not.toContain("app-tag--success");
    expect(btn.text()).toContain(t("replay.live.statsSourceTitle"));
    expect(btn.attributes("aria-label")).toBe(t("replay.live.statsSourceTitle"));
  });

  it("still opens the shared column editor through the AppTag button", async () => {
    const wrapper = mount(LiveStatsModeChip);
    // AppTag routes its click through the declared emit, so this pin is
    // the regression guard for the popup's ONE opening path.
    await wrapper.find("button.app-tag-btn").trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelector(".overlay-columns")).toBeTruthy();
    });
  });

  it("flips to the success tone once the columns leave their defaults", () => {
    statsPrefsState.value.overlayColumns = [{ scope: "global", metric: "winrate" }];
    const wrapper = mount(LiveStatsModeChip);
    const btn = wrapper.find(".live-battle__mode-anchor button.app-tag-btn");
    const tag = btn.find("span.hk-tag");
    expect(tag.classes()).toContain("app-tag--success");
    expect(tag.classes()).not.toContain("app-tag--default");
    // Customized, the chip names what it edits (显示列).
    expect(btn.text()).toContain(t("settings.overlayContent.columnsLabel"));
  });
});
