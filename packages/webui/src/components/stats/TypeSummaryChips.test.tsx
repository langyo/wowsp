/**
 * TypeSummaryChips — the shared per-class summary chip row. These tests pin
 * the contract both water tables rely on:
 *  - one chip per item in the given order, carrying the class briefing hint
 *    card on the chip itself (the per-view chips' behavior, preserved);
 *  - the chip content is the dashboard grammar — code, grouped battles,
 *    one-decimal winrate — with the winrate colored through winrateColor;
 *  - the grey chip body comes from the shared stylesheet (class smoke).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import TypeSummaryChips from "./TypeSummaryChips";
import { setLocale } from "@/i18n";

describe("TypeSummaryChips", () => {
  // The hint-card attribute only renders when the active locale carries the
  // class briefings — setLocale loads its bundle lazily, so the switch is
  // awaited first (the shipTypeHint suite's idiom); park en-US back after.
  beforeAll(async () => {
    await setLocale("zh-CN");
  });
  afterAll(async () => {
    await setLocale("en-US");
  });

  it("renders one chip per item with code, battles and colored winrate", () => {
    const wrapper = mount(TypeSummaryChips, {
      props: {
        items: [
          { code: "BB", battles: 5228, winrate: 48.5 },
          { code: "CV", battles: 3, winrate: 66.7 },
        ],
      },
    });
    const chips = wrapper.findAll(".type-summary-chips__chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].find(".type-summary-chips__code").text()).toBe("BB");
    expect(chips[0].find(".type-summary-chips__battles").text()).toBe("5,228");
    expect(chips[0].find(".type-summary-chips__wr").text()).toBe("48.5%");
    expect(chips[0].find(".type-summary-chips__wr").attributes("style")).toContain("color");
    expect(chips[1].find(".type-summary-chips__code").text()).toBe("CV");
    expect(chips[1].find(".type-summary-chips__battles").text()).toBe("3");
  });

  it("carries the class hint card on each chip", () => {
    const wrapper = mount(TypeSummaryChips, {
      props: { items: [{ code: "CA/CL", battles: 4318, winrate: 46.7 }] },
    });
    expect(wrapper.find(".type-summary-chips__chip").attributes("data-hint-card")).toBeDefined();
  });
});
