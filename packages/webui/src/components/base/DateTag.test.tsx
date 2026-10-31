/**
 * DateTag — the locale-ordered date/time capsule. These tests pin the
 * contract the water tables rely on:
 *  - one row per date field (year / month / day), ordered by the ACTIVE
 *    app locale straight from Intl's formatToParts — zh-CN stacks
 *    year→month→day while en-US puts the year LAST (month/day/year);
 *  - a live locale switch re-orders the rows without a remount (the
 *    computed tracks i18n.global.locale);
 *  - the optional time row appends the locale time, muted;
 *  - unparseable input renders an empty capsule (no rows) — the caller
 *    owns the empty state;
 *  - the class names match hikari's HkDateTag so the upgrade that swaps
 *    this local stopgap onto the kit export changes import paths only.
 *
 * The fixture timestamp is fixed local-noon UTC: it stays on the same
 * calendar day for every offset the test machines run (UTC CI, +8 dev).
 */
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import DateTag from "./DateTag";
import { setLocale } from "@/i18n";

enableAutoUnmount(afterEach);

// 2024-10-06 12:00Z — midday UTC keeps Oct 6 under every realistic TZ.
const NOON = Date.UTC(2024, 9, 6, 12, 0, 0);

function rowsOf(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll(".hk-date-tag__row").map((r) => ({
    cls: r.classes(),
    text: r.text(),
  }));
}

describe("DateTag", () => {
  afterEach(async () => {
    // setLocale mutates the shared i18n singleton — park it back.
    await setLocale("en-US");
  });

  it("stacks year/month/day in zh order under zh-CN", async () => {
    await setLocale("zh-CN");
    const wrapper = mount(DateTag, { props: { value: NOON } });
    const rows = rowsOf(wrapper);
    expect(rows.map((r) => r.text)).toEqual(["2024", "10", "06"]);
    expect(rows[0].cls).toContain("hk-date-tag__row--year");
    expect(wrapper.classes()).toContain("hk-date-tag");
  });

  it("puts the year last under en-US", async () => {
    await setLocale("en-US");
    const wrapper = mount(DateTag, { props: { value: NOON } });
    expect(rowsOf(wrapper).map((r) => r.text)).toEqual(["10", "06", "2024"]);
  });

  it("re-orders live when the locale switches mid-flight", async () => {
    await setLocale("en-US");
    const wrapper = mount(DateTag, { props: { value: NOON } });
    expect(rowsOf(wrapper).map((r) => r.text)).toEqual(["10", "06", "2024"]);
    await setLocale("zh-CN");
    expect(rowsOf(wrapper).map((r) => r.text)).toEqual(["2024", "10", "06"]);
  });

  it("appends the muted time row only when asked", async () => {
    await setLocale("en-US");
    const plain = mount(DateTag, { props: { value: NOON } });
    expect(plain.findAll(".hk-date-tag__row--time")).toHaveLength(0);
    const withTime = mount(DateTag, { props: { value: NOON, time: true } });
    const timeRows = withTime.findAll(".hk-date-tag__row--time");
    expect(timeRows).toHaveLength(1);
    expect(timeRows[0].text()).toMatch(/^\d{1,2}:\d{2}/);
  });

  it("renders an empty capsule for unparseable input", () => {
    const wrapper = mount(DateTag, { props: { value: "not-a-date" } });
    expect(wrapper.classes()).toContain("hk-date-tag");
    expect(wrapper.findAll(".hk-date-tag__row")).toHaveLength(0);
  });
});
