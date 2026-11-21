/**
 * Item A: the ward deployment countdown says ARRIVES (抵达), not COMING (来临).
 *
 * The deploying fighter card reused the weather feature's
 * replay.weather.incomingIn ("{s} 后来临" / "arrives in {s}") — the storm is
 * coming — for a wing flying out to its patrol circle (user report:
 * "应该叫抵达，什么来临？"). It now has its own replay.ward.arrivesIn key in
 * every locale, and the weather key keeps its own wording because the weather
 * badge still reads it.
 *
 * Both halves are pinned here: every locale must RESOLVE the new key through
 * the real i18n instance (a missing key echoes the dotted path), and the
 * weather key must stay untouched.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { initLocaleMessages, setLocale, t } from "@/i18n";
import { fmtCountdown, wardDeployCountdown } from "./markerUpdate";

const LOCALES = [
  "en-US",
  "es-ES",
  "fr-FR",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "zh-CN",
  "zh-TW",
] as const;

const WARD_KEY = "replay.ward.arrivesIn";
const WEATHER_KEY = "replay.weather.incomingIn";

describe("ward countdown wording", () => {
  beforeEach(async () => {
    await initLocaleMessages();
  });

  for (const locale of LOCALES) {
    it(`resolves ${WARD_KEY} in ${locale}`, async () => {
      await setLocale(locale);
      const text = t(WARD_KEY, { s: "0:15" });
      // A missing key echoes the dotted path — exactly the untranslated
      // string the user would see on the card.
      expect(text).not.toBe(WARD_KEY);
      expect(text).toContain("0:15");
    });
  }

  it("keeps the weather wording untouched (the badge still uses it)", async () => {
    await setLocale("zh-CN");
    expect(t(WEATHER_KEY, { s: "0:15" })).toBe("0:15 后来临");
    expect(t(WARD_KEY, { s: "0:15" })).toBe("0:15 后抵达");
    await setLocale("en-US");
    expect(t(WARD_KEY, { s: "0:15" })).toBe("arrives in 0:15");
  });

  it("prints the deployment countdown through the ward key", async () => {
    await setLocale("zh-CN");
    expect(wardDeployCountdown(0, 15)).toBe("0:15 后抵达");
    await setLocale("en-US");
    expect(wardDeployCountdown(0, 15)).toBe("arrives in 0:15");
    // The MM:SS shape is unchanged (the map's one countdown chrome).
    expect(fmtCountdown(75)).toBe("1:15");
    expect(wardDeployCountdown(0, 75)).toBe("arrives in 1:15");
  });
});
