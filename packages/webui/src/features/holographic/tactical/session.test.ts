/**
 * Session-blob persistence tests — the lineup's LIVE storage path. The
 * per-hull build must survive reloads and profile imports (the session
 * sanitizer is the only gate; lineup.ts's own store is the legacy path),
 * and pre-rework short consumable codes normalize to family names.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadSession,
  saveSession,
  sessionFromProfileMeta,
  type TacticalSession,
} from "./session";
import type { Lineup } from "./lineup";

const BUILD = {
  skills: { GmShellReload: 1 as const },
  signals: ["PCEF016"],
  upgrades: { 2: "PCM027_ConcealmentMeasures_Mod_I" },
  commander: "PAW102_Halsey",
  healthPct: 1,
};

function sessionWith(lineup: Lineup): TacticalSession {
  return {
    modeId: "clan_7v7",
    modeGroup: "clan",
    caps: [],
    lineup,
    mirror: false,
    heat: "off",
    profileName: "",
    profilePath: null,
    fileName: null,
  };
}

describe("session lineup persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps each hull's build across a save/load round trip", () => {
    saveSession(
      "20_NE",
      sessionWith({
        ally: [{ id: "lu-1", shipId: 4290883632, label: "", torpedo: 0, consumables: [], build: BUILD }],
        enemy: [],
      }),
    );
    const back = loadSession("20_NE");
    expect(back.lineup.ally[0].build).toEqual(BUILD);
  });

  it("rebuilds builds from an imported profile's meta block", () => {
    const meta = {
      modeId: "clan_7v7",
      lineup: {
        ally: [
          { id: "lu-1", shipId: 1, label: "", torpedo: 0, consumables: [], build: BUILD },
        ],
        enemy: [],
      },
    };
    expect(sessionFromProfileMeta(meta).lineup.ally[0].build).toEqual(BUILD);
  });

  it("normalizes legacy short consumable codes to family names", () => {
    saveSession(
      "20_NE",
      sessionWith({
        ally: [
          {
            id: "lu-1",
            shipId: 1,
            label: "",
            torpedo: 0,
            consumables: ["rls", "sonar", "smoke"],
          },
        ],
        enemy: [],
      }),
    );
    expect(loadSession("20_NE").lineup.ally[0].consumables).toEqual([
      "RLSSearch",
      "SonarSearch",
      "SmokeGenerator",
    ]);
  });

  it("drops corrupt entries without bricking the session", () => {
    saveSession("20_NE", sessionWith({ ally: [], enemy: [] }));
    window.localStorage.setItem(
      "wowsp:tactics:session:v1:20_NE",
      JSON.stringify({ ...sessionWith({ ally: [], enemy: [] }), lineup: { ally: [{ shipId: "x" }], enemy: [] } }),
    );
    expect(loadSession("20_NE").lineup.ally).toEqual([]);
  });
});
