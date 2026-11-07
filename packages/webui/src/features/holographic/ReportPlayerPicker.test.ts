/** ReportPlayerPicker: the head's perspective dropdown. The trigger is the
 *  report's identity head; the OPENED panel is hikari's HkSelectPanel — the
 *  standard dropdown surface, teleported to <body>, so menu queries go
 *  through the document. */
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";

import ReportPlayerPicker from "./ReportPlayerPicker";
import type { StaticReport, StaticRosterEntry } from "@/api";

enableAutoUnmount(afterEach);

function rosterEntry(overrides: Partial<StaticRosterEntry>): StaticRosterEntry {
  return {
    entityId: 1,
    shipId: 1,
    // Wire fields the head/overlay never read here, but StaticRosterEntry
    // carries them (fire applicability of the hull's class).
    shipClass: null,
    fireApplicable: true,
    torpedoApplicable: true,
    name: "me",
    playerName: "me",
    teamId: 0,
    isRecorder: false,
    diedAt: null,
    coverage: {
      aliveFrom: 0,
      aliveTo: 600,
      samples: 40,
      gapSeconds: 0,
      completeness: 0.97,
      gapSegments: [],
    },
    whole: null,
    outcome: null,
    ...overrides,
  };
}

function report(): StaticReport {
  return {
    replayPath: "replays/r.wowsreplay",
    replayId: "r",
    mapName: "spaces/15_NE_north",
    gameMode: "Domination",
    durationS: 600,
    losLoaded: false,
    modelSources: { fire: "models/fire.onnx", moveModel: "models/move.onnx", torpedoModel: null },
    entityId: 1,
    roster: [
      rosterEntry({ entityId: 1, name: "me", isRecorder: true }),
      rosterEntry({ entityId: 2, name: "mate", playerName: "mate" }),
      rosterEntry({
        entityId: 9,
        name: "foe",
        playerName: "foe",
        teamId: 1,
        coverage: {
          aliveFrom: 0,
          aliveTo: 600,
          samples: 0,
          gapSeconds: 600,
          completeness: 0,
          gapSegments: [[0, 600]],
        },
      }),
    ],
    timeline: [],
    moments: [],
  };
}

function mountPicker(props: Record<string, unknown> = {}) {
  return mount(ReportPlayerPicker, {
    props: { report: report(), capturing: false, ...props },
    attachTo: document.body,
  });
}

/** The panel content lives in the teleported hikari surface. */
function panel(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".srp-picker__menu");
}
function panelRows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(".srp-picker__row"));
}

/** Opens the dropdown and waits for the panel surface to mount. */
async function openPicker(w: VueWrapper): Promise<HTMLElement> {
  await w.find(".srp-picker__trigger").trigger("click");
  await nextTick();
  const el = panel();
  expect(el).not.toBeNull();
  return el!;
}

describe("ReportPlayerPicker", () => {
  it("shows only the selected player on the trigger", async () => {
    const w = mountPicker();
    const trigger = w.find(".srp-picker__trigger");
    expect(trigger.exists()).toBe(true);
    expect(trigger.text()).toContain("me");
    expect(trigger.text()).not.toContain("mate");
    expect(trigger.text()).not.toContain("foe");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    await openPicker(w);
    expect(trigger.attributes("aria-expanded")).toBe("true");
  });

  it("renders the roster groups inside hikari's dropdown panel", async () => {
    const w = mountPicker();
    await openPicker(w);
    const menu = panel()!;
    expect(menu.textContent).toContain("replay.report.allies");
    expect(menu.textContent).toContain("replay.report.enemies");
    expect(menu.textContent).toContain("mate");
    expect(menu.textContent).toContain("foe");
    // The surface is HkSelectPanel's (the standard dropdown chrome).
    expect(document.body.querySelector(".hk-select-popover, .hk-select-popout, .hk-select-sheet-panel")).not.toBeNull();
  });

  it("emits the picked perspective and closes", async () => {
    const w = mountPicker();
    await openPicker(w);
    const mate = panelRows().find((row) => row.textContent?.includes("mate"));
    expect(mate).toBeTruthy();
    mate!.click();
    await nextTick();
    expect(w.emitted("pick")).toEqual([[2]]);
    expect(w.find(".srp-picker__trigger").attributes("aria-expanded")).toBe("false");
  });

  it("keeps unscoreable hulls listed but disabled", async () => {
    const w = mountPicker();
    await openPicker(w);
    const foe = panelRows().find((row) => row.textContent?.includes("foe"));
    expect(foe).toBeTruthy();
    expect(foe!.hasAttribute("disabled")).toBe(true);
    foe!.click();
    await nextTick();
    expect(w.emitted("pick")).toBeUndefined();
    expect(w.find(".srp-picker__trigger").attributes("aria-expanded")).toBe("true");
  });

  it("closes on Escape without emitting", async () => {
    const w = mountPicker();
    await openPicker(w);
    // The panel forwards keys to its owner; the trigger's handler consumes
    // the Escape so the hosting dialog stays open.
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    w.find(".srp-picker__trigger").element.dispatchEvent(escape);
    await nextTick();
    expect(w.find(".srp-picker__trigger").attributes("aria-expanded")).toBe("false");
    expect(w.emitted("pick")).toBeUndefined();
  });

  it("returns focus to the trigger after a selection", async () => {
    const w = mountPicker();
    await openPicker(w);
    const mate = panelRows().find((row) => row.textContent?.includes("mate"));
    mate!.click();
    await nextTick();
    expect(document.activeElement).toBe(w.find(".srp-picker__trigger").element);
  });

  it("opens from the keyboard and walks the enabled rows", async () => {
    const w = mountPicker();
    await w.find(".srp-picker__trigger").trigger("keydown", { key: "ArrowDown" });
    await nextTick();
    expect(panel()).not.toBeNull();
    const rows = panelRows().filter((row) => !row.hasAttribute("disabled"));
    expect(rows.length).toBe(2);
    expect(document.activeElement).toBe(rows[0]);
    panel()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await nextTick();
    expect(document.activeElement).toBe(rows[1]);
  });

  it("renders the host-resolved identity faces on trigger and rows", async () => {
    const w = mountPicker({
      identity: {
        name: "me",
        clanTag: "HOOD",
        dogTag: null,
        shipType: "Destroyer",
        shipName: "Shimakaze",
        tier: 10,
      },
      roster: new Map([
        [
          2,
          {
            clanTag: "ABC",
            shipType: "Cruiser",
            shipName: "Des Moines",
            tier: 10,
          },
        ],
        [
          9,
          {
            clanTag: null,
            shipType: "Battleship",
            shipName: "Yamato",
            tier: 10,
          },
        ],
      ]),
    });
    const trigger = w.find(".srp-picker__trigger");
    expect(trigger.find(".srp-picker__clan").text()).toBe("[HOOD]");
    expect(trigger.find(".srp-picker__name").text()).toBe("me");
    expect(trigger.find(".srp-picker__name-line .srp-picker__dot").exists()).toBe(
      false,
    );
    expect(trigger.find(".srp-picker__ship").text()).toContain("Shimakaze");
    expect(trigger.find(".srp-picker__ship img").attributes("src")).toContain(
      "icon_ally_destroyer",
    );
    expect(trigger.find(".srp-picker__avatar-initial").text()).toBe("M");

    await openPicker(w);
    const rows = panelRows();
    const mate = rows.find((row) => row.textContent?.includes("mate"))!;
    // Far left is the SHIP column: class glyph, tier numeral, ship name —
    // the first child of the row, so the identity starts after it.
    expect(
      mate.firstElementChild?.classList.contains("srp-picker__row-ship"),
    ).toBe(true);
    expect(
      mate.querySelector(".srp-picker__row-icon img")?.getAttribute("src"),
    ).toContain("icon_ally_cruiser");
    expect(mate.querySelector(".srp-picker__row-tier")?.textContent).toBe("X");
    expect(mate.querySelector(".srp-picker__row-shipname")?.textContent).toBe(
      "Des Moines",
    );
    // Then the player identity: [clan] nickname on one line.
    const mateId = mate.querySelector(".srp-picker__row-id")?.textContent ?? "";
    expect(mateId).toContain("[ABC]");
    expect(mateId).toContain("mate");
    expect(rows[0].querySelector(".srp-picker__check")).not.toBeNull();
    expect(mate.querySelector(".srp-picker__check")).toBeNull();
    // Enemy rows keep the enemy plate variant of the class glyph.
    const foe = rows.find((row) => row.textContent?.includes("foe"))!;
    expect(
      foe.querySelector(".srp-picker__row-icon img")?.getAttribute("src"),
    ).toContain("icon_enemy_battleship");
    // The old team-dot fallback is gone from every row.
    expect(document.body.querySelector(".srp-picker__row-dot")).toBeNull();
  });

  it("renders a neutral dash for hulls no ship source resolves", async () => {
    const w = mountPicker();
    await openPicker(w);
    const rows = panelRows();
    expect(rows.length).toBe(3);
    for (const row of rows) {
      // Never the old team dot, even with no host-resolved face at all.
      expect(row.querySelector(".srp-picker__row-dot")).toBeNull();
      expect(row.querySelector(".srp-picker__row-shipname")?.textContent).toBe(
        "—",
      );
      // The glyph slot stays reserved (empty, no image) so the fixed-width
      // ship column does not collapse.
      expect(row.querySelector(".srp-picker__row-icon img")).toBeNull();
      expect(
        row.querySelector(".srp-picker__row-icon")?.textContent ?? "",
      ).toBe("");
    }
  });

  it("shows the player nickname on the identity line, not the display name", async () => {
    // The report roster's name field is ship-name-preferred; the row identity
    // must read the PLAYER nickname or the ship column and the name would
    // repeat the hull.
    const rep = report();
    rep.roster[1] = { ...rep.roster[1], name: "Shimakaze", playerName: "kirov" };
    const w = mountPicker({ report: rep });
    await openPicker(w);
    const mate = panelRows().find((row) => row.textContent?.includes("kirov"))!;
    const idText = mate.querySelector(".srp-picker__row-id")?.textContent ?? "";
    expect(idText).toContain("kirov");
    expect(idText).not.toContain("Shimakaze");
  });

  it("shows the real emblem badge when the lookup carries a dog tag", () => {
    const w = mountPicker({
      identity: {
        name: "me",
        clanTag: "HOOD",
        dogTag: {
          textureId: 1,
          symbolId: 2,
          borderColor: 0xff000000,
          backgroundColor: 0xff001122,
          backgroundId: 3,
        },
        shipType: "Destroyer",
        shipName: "Shimakaze",
        tier: 10,
      },
    });
    expect(w.find(".srp-picker__avatar .player-badge").exists()).toBe(true);
    expect(w.find(".srp-picker__avatar-initial").exists()).toBe(false);
  });

  it("is a chrome-less static name plate while the long image is captured", async () => {
    const w = mountPicker({ capturing: true });
    const trigger = w.find(".srp-picker__trigger");
    expect(trigger.attributes("disabled")).toBeDefined();
    expect(trigger.classes()).toContain("srp-picker__trigger--static");
    expect(w.find(".srp-picker__chevron").exists()).toBe(false);
    await trigger.trigger("click");
    await nextTick();
    expect(panel()).toBeNull();
  });
});
