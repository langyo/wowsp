/**
 * Tests for the recorder ship plaque's sunk state (HoloShipCard via
 * HoloSelfCard):
 *
 *  - a sunk ship renders the localized sunk label in place of the HP
 *    numbers (the bare "—" dash read as an empty plaque);
 *  - the sunk label appears even when the HP stream never read the hull
 *    (hp/maxHp null) — the readout slot must exist for the width contract;
 *  - HoloSelfCard passes the app's own 已击沉 wording (replay.shipSunk);
 *  - afloat ships keep the numeric "hp / max" readout and never show the
 *    sunk label;
 *  - the recorder's submarine depth pill renders the localized
 *    replay.selfDepth readout between plaque and stats strip, and renders
 *    nothing for surface ships / non-submarines (depth null).
 *
 * The width half of the contract (the readout slot keeps a fixed inline
 * size so sinking can't shrink the bottom-left row) is pinned by the
 * sibling HoloSelfCard.styles.test.ts source assertions.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import { initLocaleMessages, t as i18nT } from "@/i18n";
import { HoloShipCard, type HoloShipCardData } from "@wowsp/holo";

import HoloSelfCard from "./HoloSelfCard";

beforeAll(async () => {
  await initLocaleMessages();
});

const ALIVE: HoloShipCardData = {
  shipType: "Destroyer",
  name: "杰维斯",
  hp: 12400,
  maxHp: 12400,
};

const SUNK: HoloShipCardData = { ...ALIVE, hp: 0, dead: true };

const fmt = (n: number) => `${Math.round(n).toLocaleString()}`;

describe("HoloShipCard sunk label", () => {
  it("an afloat ship keeps the numeric readout and no sunk label", () => {
    const w = mount(HoloShipCard, { props: { data: ALIVE } });
    const text = w.find(".holo-ship-card__text");
    expect(text.exists()).toBe(true);
    expect(text.text()).toBe(`${fmt(12400)} / ${fmt(12400)}`);
    expect(text.text()).not.toContain(i18nT("replay.shipSunk"));
  });

  it("a sunk ship swaps the numbers for the localized sunk label", () => {
    const label = i18nT("replay.shipSunk");
    const w = mount(HoloShipCard, { props: { data: SUNK, deadText: label } });
    const text = w.find(".holo-ship-card__text");
    expect(text.exists()).toBe(true);
    expect(text.text()).toBe(label);
    // The sunk card never renders a stale numeric readout beside it.
    expect(text.text()).not.toContain("/");
  });

  it("keeps the sunk label even when the HP stream never read the hull", () => {
    const w = mount(HoloShipCard, {
      props: { data: { name: "杰维斯", dead: true } as HoloShipCardData, deadText: "Sunk" },
    });
    // showText must be true for dead ships so the fixed-size slot exists.
    expect(w.find(".holo-ship-card__text").text()).toBe("Sunk");
  });

  it("a wreck renders no repairable segment and an empty hull fill", () => {
    // The host approximates the repairable pool from the damage taken; on a
    // sunk ship that approximation would paint most of the silhouette grey.
    const w = mount(HoloShipCard, {
      props: {
        // silhouetteUrl switches the card to the PNG branch, whose fill
        // carries an inline clip-path — the stale-HP-fill assertion reads it.
        data: { ...SUNK, repairableHp: 7440, silhouetteUrl: "sil.png" },
        deadText: "Sunk",
      },
    });
    expect(w.find(".holo-ship-card__sil-rep").exists()).toBe(false);
    expect(w.find(".holo-ship-card__hull-rep").exists()).toBe(false);
    // The label's HP lags at its last observed reading after the sink; the
    // fill must still clip to zero (inset right edge at 100%).
    const fill = w.find(".holo-ship-card__sil-fill");
    expect(fill.exists()).toBe(true);
    expect(fill.attributes("style")).toContain("inset(0 100% 0 0)");
    // An afloat card with a pool keeps the segment.
    const alive = mount(HoloShipCard, {
      props: { data: { ...ALIVE, hp: 4960, repairableHp: 4440 } },
    });
    expect(
      alive.find(".holo-ship-card__sil-rep").exists() ||
        alive.find(".holo-ship-card__hull-rep").exists(),
    ).toBe(true);
  });

  it("falls back to the English label when the host passes none", () => {
    const w = mount(HoloShipCard, { props: { data: SUNK } });
    expect(w.find(".holo-ship-card__text").text()).toBe("SUNK");
  });
});

describe("HoloSelfCard sunk plaque", () => {
  it("passes the app's own sunk wording (replay.shipSunk) to the plaque", () => {
    const w = mount(HoloSelfCard, { props: { card: SUNK, stats: null } });
    expect(w.find(".holo-ship-card__text").text()).toBe(i18nT("replay.shipSunk"));
    // The stats strip stays mounted beside the plaque.
    expect(w.find(".holo-map__shipcard").exists()).toBe(true);
  });

  it("an afloat recorder card shows the numeric readout", () => {
    const w = mount(HoloSelfCard, { props: { card: ALIVE, stats: null } });
    expect(w.find(".holo-ship-card__text").text()).toBe(
      `${fmt(12400)} / ${fmt(12400)}`,
    );
  });
});

describe("HoloSelfCard depth badge", () => {
  it("renders the localized depth pill while the recorder is submerged", () => {
    const w = mount(HoloSelfCard, {
      props: { card: ALIVE, stats: null, depth: { meters: 12 } },
    });
    const badge = w.find(".holo-map__depthbadge");
    expect(badge.exists()).toBe(true);
    // The readout is the localized replay.selfDepth message (the parent
    // rounds the meters; this test pins the rendering, not the locales).
    expect(badge.text()).toBe(i18nT("replay.selfDepth", { meters: 12 }));
    // Down-glyph rides the stat-icon pattern (a 14px lucide svg).
    expect(w.find(".holo-map__depthbadge-ico").exists()).toBe(true);
  });

  it("renders no badge for surface ships / non-submarines", () => {
    const w = mount(HoloSelfCard, {
      props: { card: ALIVE, stats: null, depth: null },
    });
    expect(w.find(".holo-map__depthbadge").exists()).toBe(false);
  });

  it("sits between the plaque and the stats strip in the shipcard row", () => {
    const w = mount(HoloSelfCard, {
      props: {
        card: ALIVE,
        stats: { hits: 1, damage: 2, frags: 0, taken: 0, planeDamage: 0 },
        depth: { meters: 7 },
      },
    });
    const kids = Array.from(w.find(".holo-map__shipcard").element.children);
    expect(kids.length).toBe(3);
    expect(kids[0].classList.contains("holo-ship-card")).toBe(true);
    expect(kids[1].classList.contains("holo-map__depthbadge")).toBe(true);
    expect(kids[2].classList.contains("holo-map__selfstats")).toBe(true);
  });
});
