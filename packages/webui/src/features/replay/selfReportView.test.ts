/**
 * Tests for the shared 我的战绩 display layer behind the combined post-battle
 * shot: the summary-tile list (the two server-stream-only stats stay hidden
 * when a capture never decoded their category) and the personal banner model
 * (masked identity, headline formatting, ribbon pass-through, the one-line
 * secondary stats).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { loadLocaleMessages, t } from "@/i18n";
import { damageColor } from "@/utils/winrate";
import type { SelfFinalStats, SelfStatsModel } from "./liveSelfStats";
import { selfShotBannerOf, selfTilesOf } from "./selfReportView";

/** A complete-enough self model; overrides cover each scenario. */
function model(over: Partial<SelfStatsModel> = {}): SelfStatsModel {
  return {
    selfName: "Me",
    selfShipId: null,
    selfEntityId: 10,
    selfPlayerId: 77,
    battleTime: 60,
    damageSource: "server",
    damage: 12345,
    planeDamage: 0,
    hits: 12,
    spotDamage: null,
    potentialDamage: null,
    taken: 1000,
    hpRatio: 50,
    sunk: false,
    frags: 3,
    dealt: [],
    received: [],
    damageComp: [],
    achievements: [],
    final: null,
    ...over,
  };
}

function finalStats(over: Partial<SelfFinalStats> = {}): SelfFinalStats {
  return {
    exp: 2103,
    ribbons: [
      { key: "frag", value: 3 },
      { key: "main_caliber", value: 87 },
    ],
    killerName: null,
    killerShipId: null,
    myKills: [],
    ...over,
  };
}

const bannerOpts = {
  title: "我的战绩",
  lang: "en-US",
  maskOf: (name: string) => `mask(${name})`,
  clanTag: "TAG",
};

// Load the real en-US namespace tables so t() resolves the labels the
// assertions compare against (and the missing-key warnings stay silent).
beforeAll(async () => {
  await loadLocaleMessages("en-US");
});

describe("selfTilesOf", () => {
  it("inserts spotting/potential tiles only when the stream reported them", () => {
    const plain = selfTilesOf(model());
    const plainLabels = plain.map((x) => x.label);
    expect(plainLabels).not.toContain(t("replay.live.selfSpot"));
    expect(plainLabels).not.toContain(t("replay.live.selfPotential"));
    expect(plainLabels[0]).toBe(t("replay.live.selfDamage"));

    const withStats = selfTilesOf(model({ spotDamage: 4567, potentialDamage: 1234567 }));
    const labels = withStats.map((x) => x.label);
    expect(labels[1]).toBe(t("replay.live.selfPotential"));
    expect(labels[2]).toBe(t("replay.live.selfSpot"));
    expect(withStats[1].value).toBe("1,234,567");
    expect(withStats[2].value).toBe("4,567");
  });

  it("appends the settlement exp tile only once the results payload landed", () => {
    expect(selfTilesOf(model()).map((x) => x.label)).not.toContain(t("replay.live.selfExp"));
    const settled = selfTilesOf(model({ final: finalStats() }));
    expect(settled[settled.length - 1]).toEqual({
      label: t("replay.live.selfExp"),
      value: "2,103",
    });
  });
});

describe("selfShotBannerOf", () => {
  it("returns null without a self model (the shot then renders the roster alone)", () => {
    expect(selfShotBannerOf(null, bannerOpts)).toBeNull();
  });

  it("builds the masked identity, the headline and the one-line secondary stats", () => {
    const banner = selfShotBannerOf(
      model({
        spotDamage: 4567,
        potentialDamage: 1234567,
        final: finalStats(),
      }),
      bannerOpts,
    )!;
    expect(banner.title).toBe("我的战绩");
    expect(banner.nick).toBe("mask(Me)");
    expect(banner.clanTag).toBe("TAG");
    expect(banner.damage).toBe("12,345");
    expect(banner.damageColor).toBe(damageColor(12345));
    expect(banner.frags).toEqual({ label: t("replay.live.selfFrags"), value: "3" });
    expect(banner.ribbons).toEqual([
      { key: "frag", value: 3 },
      { key: "main_caliber", value: 87 },
    ]);
    // 潜在伤害 leads the muted line when the stream reported it; 飞机伤害
    // stays out at zero; hits / taken and the settlement exp always ride.
    expect(banner.aux[0].label).toBe(t("replay.live.selfPotential"));
    expect(banner.aux[0].value).toBe("1,234,567");
    expect(banner.aux[1].label).toBe(t("replay.live.selfSpot"));
    expect(banner.aux.map((x) => x.label)).not.toContain(t("replay.live.selfPlaneDamage"));
    expect(banner.aux.map((x) => x.label)).toContain(t("replay.live.selfHits"));
    expect(banner.aux.map((x) => x.label)).toContain(t("replay.live.selfTaken"));
    expect(banner.aux[banner.aux.length - 1]).toEqual({
      label: t("replay.live.selfExp"),
      value: "2,103",
    });
  });

  it("marks a sunk self and drops the exp until the results payload lands", () => {
    const banner = selfShotBannerOf(model({ sunk: true }), bannerOpts)!;
    expect(banner.sunk).toBe(true);
    expect(banner.sunkLabel).toBe(t("replay.live.selfSunk"));
    expect(banner.iconVariant).toBe("sunk");
    expect(banner.aux.map((x) => x.label)).not.toContain(t("replay.live.selfExp"));
    expect(banner.ribbons).toEqual([]);
  });
});
