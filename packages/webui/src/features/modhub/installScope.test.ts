/** The catalog pane's install-scope branch matrix. Every state the
 *  footer can be in is pinned here (partial → two explicit actions,
 *  everything else → the single label chain), including the realm rule
 *  that keeps unsupported clients out of every count. */
import { describe, expect, it } from "vitest";

import type { CatalogEntry, GameInstall, ModInstallRecord } from "@/api";

import { entryClientStatusesOf, type EntryClientStatus } from "./entryClients";
import { installScopePlan } from "./installScope";

const VERSION = "2";

const entry = (servers?: string[]): CatalogEntry =>
  ({ id: "battle.panel", servers, version: VERSION }) as CatalogEntry;

const install = (
  kind: GameInstall["kind"],
  realm: string | null,
  path: string,
): GameInstall => ({ kind, realm, path }) as GameInstall;

const record = (version: string, gameRoot?: string): ModInstallRecord =>
  ({ id: "battle.panel", version, gameRoot }) as ModInstallRecord;

/** Statuses exactly as the view derives them: one record lookup per
 *  configured client root. */
function statuses(
  e: CatalogEntry,
  installs: readonly GameInstall[],
  records: Record<string, ModInstallRecord>,
): EntryClientStatus[] {
  return entryClientStatusesOf(e, installs, (_entry, path) => records[path]);
}

const EU = install("steam", "eu", "C:/EU");
const CN = install("cn360", "cn", "C:/CN");
const RU = install("lesta", "ru", "C:/RU");

describe("installScopePlan", () => {
  it("names the two ACTIONS for the reported state: installed elsewhere, missing here", () => {
    // The user's screenshot: the entry is on the CN(360) client, the
    // ACTIVE EU client lacks it. Two actions must appear:
    // install-everywhere (count 1) + install-here.
    const plan = installScopePlan(
      statuses(entry(), [EU, CN], { "C:/CN": record(VERSION, "C:/CN") }),
      EU.path,
    );
    expect(plan).toEqual({
      multi: true,
      applicable: 2,
      missing: 1,
      stale: 0,
      current: 1,
      showAllClients: true,
      allLabel: "resources.installAllClients",
      thisLabel: "resources.installThisClient",
    });
  });

  it("reads reinstall-here when the ACTIVE client is the one already current", () => {
    // The mirrored case: only the OTHER client is missing, so the
    // this-client action is a reinstall while all-clients installs.
    const plan = installScopePlan(
      statuses(entry(), [EU, CN], { "C:/EU": record(VERSION, "C:/EU") }),
      EU.path,
    );
    expect(plan.showAllClients).toBe(true);
    expect(plan.missing).toBe(1);
    expect(plan.current).toBe(1);
    expect(plan.allLabel).toBe("resources.installAllClients");
    expect(plan.thisLabel).toBe("resources.reinstallThisClient");
  });

  it("offers update-everywhere when only versions are stale", () => {
    const plan = installScopePlan(
      statuses(entry(), [EU, CN], {
        "C:/EU": record("1", "C:/EU"),
        "C:/CN": record("1", "C:/CN"),
      }),
      EU.path,
    );
    expect(plan).toMatchObject({
      multi: true,
      missing: 0,
      stale: 2,
      current: 0,
      showAllClients: true,
      allLabel: "resources.updateAllClients",
      thisLabel: "resources.updateThisClient",
    });
  });

  it("keeps the install label first when stale and missing mix", () => {
    // One current + one stale + one missing: the rollout still has an
    // INSTALL to do, so the label says install, not update.
    const plan = installScopePlan(
      statuses(entry(), [EU, CN, RU], {
        "C:/CN": record(VERSION, "C:/CN"),
        "C:/RU": record("1", "C:/RU"),
      }),
      EU.path,
    );
    expect(plan).toMatchObject({
      applicable: 3,
      missing: 1,
      stale: 1,
      current: 1,
      showAllClients: true,
      allLabel: "resources.installAllClients",
      thisLabel: "resources.installThisClient",
    });
  });

  it("excludes realm-unsupported clients from every count", () => {
    // Entry exclusive to asia+cn: the Lesta(RU) client is unsupported —
    // it must not make the machine look multi-client, must not count as
    // missing, and can never become the active-client state.
    const e = entry(["asia", "cn"]);
    const plan = installScopePlan(
      statuses(e, [CN, RU], { "C:/CN": record(VERSION, "C:/CN") }),
      RU.path,
    );
    expect(plan).toMatchObject({
      applicable: 1,
      multi: false,
      missing: 0,
      current: 1,
      showAllClients: false,
      allLabel: null,
      // The unsupported active client still gets an install action — the
      // user may switch to a supported client, and the label follows the
      // "not installed here" reading.
      thisLabel: "resources.installThisClient",
    });
  });

  it("never fans out on a single-client machine", () => {
    const plan = installScopePlan(
      statuses(entry(), [EU], { "C:/EU": record(VERSION, "C:/EU") }),
      EU.path,
    );
    expect(plan).toMatchObject({
      applicable: 1,
      multi: false,
      current: 1,
      showAllClients: false,
      allLabel: null,
      thisLabel: "resources.reinstallThisClient",
    });
  });

  it("keeps the single button when EVERY applicable client is current", () => {
    const plan = installScopePlan(
      statuses(entry(), [EU, CN], {
        "C:/EU": record(VERSION, "C:/EU"),
        "C:/CN": record(VERSION, "C:/CN"),
      }),
      EU.path,
    );
    expect(plan).toMatchObject({
      multi: true,
      missing: 0,
      stale: 0,
      current: 2,
      showAllClients: false,
      allLabel: null,
      thisLabel: "resources.reinstallThisClient",
    });
  });

  it("keeps the single button when NOTHING is installed anywhere", () => {
    // Nothing landed yet → nothing to "sync" — the lone install button
    // already says the whole action.
    const plan = installScopePlan(statuses(entry(), [EU, CN], {}), EU.path);
    expect(plan).toMatchObject({
      multi: true,
      missing: 2,
      stale: 0,
      current: 0,
      showAllClients: false,
      allLabel: null,
      thisLabel: "resources.installThisClient",
    });
  });

  it("matches the active root by path identity, not spelling", () => {
    const plan = installScopePlan(
      statuses(entry(), [EU, CN], {
        "C:/EU": record("1", "C:/EU"),
        "C:/CN": record(VERSION, "C:/CN"),
      }),
      "c:\\eu\\",
    );
    expect(plan.thisLabel).toBe("resources.updateThisClient");
  });

  it("reads the active client as missing when its root is not configured", () => {
    // The active folder is the running client's fallback root, which need
    // not be one of the configured installs — the pane can still install
    // there, so the this-client action says install.
    const plan = installScopePlan(
      statuses(entry(), [CN, RU], {
        "C:/CN": record(VERSION, "C:/CN"),
        "C:/RU": record(VERSION, "C:/RU"),
      }),
      "C:/UNCONFIGURED",
    );
    expect(plan.thisLabel).toBe("resources.installThisClient");
    // Counts stay over the CONFIGURED clients only.
    expect(plan.current).toBe(2);
    expect(plan.missing).toBe(0);
  });

  it("stays single-button on an empty status list", () => {
    const plan = installScopePlan([], "C:/EU");
    expect(plan).toEqual({
      multi: false,
      applicable: 0,
      missing: 0,
      stale: 0,
      current: 0,
      showAllClients: false,
      allLabel: null,
      thisLabel: "resources.installThisClient",
    });
  });
});
