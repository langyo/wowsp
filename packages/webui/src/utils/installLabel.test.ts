/**
 * Tests for the install-label vocabulary: the full label (`Steam · ASIA`),
 * the short SERVER tag (realm uppercased, kind label as the fallback, ""
 * when the install identity is unknown), and the client-menu option list the
 * playtime scope menu and the replay rail's client filter both build from.
 * Labels resolve through vue-i18n, so the message bundle is loaded up front
 * (same pattern as winrate.test's wording cases).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initLocaleMessages, t } from "@/i18n";

import {
  clientMenuOptions,
  installLabel,
  installLabelOf,
  kindLabel,
  serverTagOf,
} from "./installLabel";

beforeAll(async () => {
  await initLocaleMessages();
});

describe("serverTagOf", () => {
  it("renders the realm uppercased — the server identity wins over the kind", () => {
    // The realm is what tells two installs of the SAME kind apart, so it
    // must survive verbatim, only normalized to the tag's upper casing.
    expect(serverTagOf("steam", "asia")).toBe("ASIA");
    expect(serverTagOf("lesta", "ru")).toBe("RU");
    expect(serverTagOf("cn360", "cn")).toBe("CN");
    // Mixed casing from anywhere upstream still tags uniformly.
    expect(serverTagOf("wargaming", "Asia")).toBe("ASIA");
  });

  it("falls back to the kind's label when no realm resolved", () => {
    expect(serverTagOf("lesta", null)).toBe(t("common.game.kind.lesta"));
    expect(serverTagOf("lesta", undefined)).toBe(t("common.game.kind.lesta"));
    // An empty realm is "missing", not a tag of its own.
    expect(serverTagOf("cn360", "")).toBe(t("common.game.kind.cn360"));
  });

  it("is empty when the install identity is unknown (unowned roots)", () => {
    expect(serverTagOf(null, null)).toBe("");
    expect(serverTagOf(undefined, undefined)).toBe("");
    expect(serverTagOf(null, "")).toBe("");
    expect(serverTagOf(undefined, null)).toBe("");
  });

  it("never leaks a raw i18n key path (the bundle really resolved)", () => {
    const label = t("common.game.kind.lesta");
    expect(label).not.toContain("common.game.kind");
    expect(kindLabel("lesta")).toBe(label);
  });
});

describe("installLabel / installLabelOf", () => {
  it("joins kind and uppercased realm with the middle dot", () => {
    expect(installLabel("steam", "asia")).toBe(`${t("common.game.kind.steam")} · ASIA`);
    // Unknown realm: kind only, no dangling separator.
    expect(installLabel("steam", null)).toBe(t("common.game.kind.steam"));
    // Unknown kind: the realm still carries the server identity.
    expect(installLabel(null, "ru")).toBe("RU");
    expect(installLabel(null, null)).toBe("");
  });

  it("installLabelOf reads the same fields off a GameInstall record", () => {
    expect(installLabelOf({ kind: "lesta", path: "D:/Lesta/WoWS", realm: "ru" })).toBe(
      `${t("common.game.kind.lesta")} · RU`,
    );
    expect(installLabelOf({ kind: "manual", path: "D:/WoWS" })).toBe(
      t("common.game.kind.manual"),
    );
  });
});

describe("clientMenuOptions", () => {
  it("labels each install and keeps its path as the value", () => {
    const rows = clientMenuOptions([
      { kind: "steam", path: "D:/Steam/WoWS", realm: "asia" },
      { kind: "cn360", path: "D:/CN360", realm: "cn" },
    ]);
    expect(rows).toEqual([
      { value: "D:/Steam/WoWS", label: `${t("common.game.kind.steam")} · ASIA` },
      { value: "D:/CN360", label: `${t("common.game.kind.cn360")} · CN` },
    ]);
  });

  it("disambiguates same-labelled installs with the shortest distinguishing path tail", () => {
    // Two installs of one kind+realm both read "Steam · ASIA" — rows a user
    // cannot tell apart are unusable, so each grows the shortest path tail
    // that tells them apart.
    const rows = clientMenuOptions([
      {
        kind: "steam",
        path: "D:/SteamLibrary/steamapps/common/World of Warships",
        realm: "asia",
      },
      { kind: "steam", path: "E:\\Games\\World of Warships", realm: "asia" },
    ]);
    // One segment is NOT enough here — both leaf folders are the game folder
    // — so the tail grows until it differs instead of repeating the same
    // label twice.
    expect(rows[0]!.label).toBe(
      `${t("common.game.kind.steam")} · ASIA · common\\World of Warships`,
    );
    expect(rows[1]!.label).toBe(`${t("common.game.kind.steam")} · ASIA · Games\\World of Warships`);
    expect(rows[0]!.label).not.toBe(rows[1]!.label);
    // The VALUE stays the install's path — the identity every filter uses.
    expect(rows[0]!.value).toBe("D:/SteamLibrary/steamapps/common/World of Warships");
    // A differing leaf folder is enough on its own.
    const leaves = clientMenuOptions([
      { kind: "steam", path: "D:/Libraries/One/World of Warships", realm: "asia" },
      { kind: "steam", path: "E:/Libraries/Two/World of Warships", realm: "asia" },
    ]);
    expect(leaves[0]!.label).toBe(`${t("common.game.kind.steam")} · ASIA · One\\World of Warships`);
    expect(leaves[1]!.label).toBe(`${t("common.game.kind.steam")} · ASIA · Two\\World of Warships`);
    // A unique label stays untouched (no redundant path noise).
    const single = clientMenuOptions([
      { kind: "steam", path: "D:/Steam/WoWS", realm: "asia" },
      { kind: "lesta", path: "D:/Lesta", realm: "ru" },
    ]);
    expect(single.map((r) => r.label)).toEqual([
      `${t("common.game.kind.steam")} · ASIA`,
      `${t("common.game.kind.lesta")} · RU`,
    ]);
  });
});
