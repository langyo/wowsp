/** The per-client state derivation the merged install tag and the
 *  clients window share — pinned against the 2026-11-03 report: a
 *  ledger record on a Lesta client the entry no longer applies to
 *  must read UNSUPPORTED (not installed), and a version-drifted
 *  record must read NEEDS UPDATE (not installed). */
import { describe, expect, it } from "vitest";

import type { CatalogEntry, GameInstall, ModInstallRecord } from "@/api";

import { entryClientStateOf, entryClientStatusesOf } from "./entryClients";

const entry = (servers?: string[], version = "15.9.0.05"): CatalogEntry =>
  ({ id: "battle.cv.consumables", servers, version }) as CatalogEntry;

const install = (kind: GameInstall["kind"], realm: string | null, path: string): GameInstall =>
  ({ kind, realm, path }) as GameInstall;

const record = (version: string, gameRoot?: string): ModInstallRecord =>
  ({ id: "battle.cv.consumables", version, gameRoot }) as ModInstallRecord;

const korabli = install("lesta", "ru", "D:/WoWS_Korabli");
const cn360 = install("cn360", "cn", "D:/World_of_Warships_CN360");
const steam = install("steam", "asia", "D:/SteamLibrary/steamapps/common/World of Warships");

describe("entryClientStateOf", () => {
  it("reads unsupported over everything on an excluded realm", () => {
    // The live report: a record on the RU/Lesta client for an entry
    // whose servers exclude ru — residue, never an install.
    const e = entry(["asia", "cn"]);
    expect(
      entryClientStateOf(e, korabli, record("15.9.0.05", "D:/WoWS_Korabli")),
    ).toBe("unsupported");
    // Even a CURRENT-version record stays unsupported there.
    expect(entryClientStateOf(e, korabli, undefined)).toBe("unsupported");
  });

  it("splits installed / needsUpdate / notInstalled on applicable realms", () => {
    const e = entry(["asia", "cn"]);
    expect(
      entryClientStateOf(e, cn360, record("15.9.0.05", "D:/World_of_Warships_CN360")),
    ).toBe("installed");
    expect(
      entryClientStateOf(e, cn360, record("15.7.0.10", "D:/World_of_Warships_CN360")),
    ).toBe("needsUpdate");
    expect(entryClientStateOf(e, steam, undefined)).toBe("notInstalled");
  });

  it("never filters an unknown-realm client (universal vocabulary)", () => {
    // A steam install whose realm never resolved: ambiguous clients see
    // everything rather than an over-filtered list (servers.ts rule).
    const unknown = install("steam", null, "D:/steam2");
    const e = entry(["ru"]);
    expect(entryClientStateOf(e, unknown, undefined)).toBe("notInstalled");
  });
});

describe("entryClientStatusesOf", () => {
  it("derives every configured client in detection order", () => {
    const e = entry(["asia", "cn"]);
    const installs = [cn360, korabli, steam];
    const records: Record<string, ModInstallRecord> = {
      "D:/World_of_Warships_CN360": record("15.9.0.05"),
      "D:/WoWS_Korabli": record("15.9.0.05"),
    };
    const statuses = entryClientStatusesOf(
      e,
      installs,
      (ent, root) => records[root],
    );
    expect(statuses.map((s) => s.state)).toEqual([
      "installed",
      "unsupported",
      "notInstalled",
    ]);
  });
});