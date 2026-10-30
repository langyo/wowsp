/**
 * Tests for the stats card's karma (业力) superscript — the WG net
 * like/report count pressed to the nickname's top-right on the identity
 * head. The badge rides the stats prefs' own switch (independent of the
 * PR master), and a player whose answer carries no figure (hidden
 * profiles, older cache blobs) renders nothing instead of a fake 0.
 *
 * i18n messages are not loaded in tests, so assertions ride on classes,
 * not label text.
 */
import { describe, expect, it, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import StatsCard from "./StatsCard";
import { statsPrefsState } from "@/stores/statsPrefs";
import type { PlayerStats } from "@/api";

enableAutoUnmount(afterEach);

const STATS = {
  accountId: 7,
  name: "KarmaProbe",
  realm: "asia",
  battles: 1000,
  winrate: 52.5,
  pr: 1550,
  karma: 12,
} as PlayerStats;

function mountCard(stats: PlayerStats = STATS) {
  // A fresh pinia per mount: the card's prefs store must bind to an active
  // instance even though the karma switch itself rides the shared
  // module-level statsPrefsState ref.
  setActivePinia(createPinia());
  return mount(StatsCard, {
    props: { stats },
    global: { plugins: [createPinia()] },
  });
}

describe("StatsCard karma superscript", () => {
  it("renders the raised badge beside the nickname while the pref is on", () => {
    statsPrefsState.value.cardKarmaEnabled = true;
    const badge = mountCard().find(".id-head__karma");
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).toContain("karma-sup");
    expect(badge.classes()).toContain("karma-sup--pos");
    expect(badge.text()).toBe("+12");
  });

  it("hides the badge when the card-karma pref is off", () => {
    statsPrefsState.value.cardKarmaEnabled = false;
    expect(mountCard().find(".id-head__karma").exists()).toBe(false);
  });

  it("renders nothing when the answer carries no karma figure", () => {
    statsPrefsState.value.cardKarmaEnabled = true;
    const wrapper = mountCard({ ...STATS, karma: null } as PlayerStats);
    expect(wrapper.find(".id-head__karma").exists()).toBe(false);
  });

  it("keeps zero and negative figures visible with their sign classes", () => {
    statsPrefsState.value.cardKarmaEnabled = true;
    const zero = mountCard({ ...STATS, karma: 0 } as PlayerStats).find(".id-head__karma");
    expect(zero.classes()).toContain("karma-sup--zero");
    expect(zero.text()).toBe("0");
    const neg = mountCard({ ...STATS, karma: -3 } as PlayerStats).find(".id-head__karma");
    expect(neg.classes()).toContain("karma-sup--neg");
    expect(neg.text()).toBe("-3");
  });
});
