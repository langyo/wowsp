/** Known-mod relation derivation: whose files a res_mods unit's tree
 *  really carries. Pinned around the shapes the Resources page shows —
 *  an install's own record, a catch-all tree shared by several packs, a
 *  `shared.*` runtime component plus its `sharedRoots` consumers, the
 *  Aslain pairing, the unpaired catalog identity, and the normalization
 *  rules the ledger itself compares paths with. */
import { describe, expect, it } from "vitest";

import type {
  CatalogEntry,
  ForeignModUnit,
  InstalledMod,
  ModInstallRecord,
} from "@/api";

import { relationPathKey, relationsByUnit, unitRelationCount } from "./unitRelations";

const GAME = "C:/TestGame";

type UnitInit = Partial<InstalledMod> & { relPath: string };
const unit = (init: UnitInit): InstalledMod =>
  ({
    kind: "script",
    name: init.relPath,
    disabled: false,
    paths: [init.relPath],
    ...init,
  }) as InstalledMod;

type RecordInit = Partial<ModInstallRecord> & { id: string };
const record = (init: RecordInit): ModInstallRecord =>
  ({
    name: init.id,
    version: "1",
    category: "battle",
    source: "mod-hub",
    binVersion: "1",
    installedAt: "2026-11-01T00:00:00Z",
    files: [],
    gameRoot: GAME,
    ...init,
  }) as ModInstallRecord;

const entry = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({
    id,
    version: "1.0",
    category: "battle",
    game: "*",
    title: id,
    nameZh: id,
    nameEn: id,
    description: "",
    authors: [],
    packages: [],
    i18n: {},
    ...extra,
  }) as CatalogEntry;

const foreign = (init: Partial<ForeignModUnit> & { key: string }): ForeignModUnit =>
  ({ installer: "aslain", name: init.key, ...init }) as ForeignModUnit;

const relationsOf = (
  u: InstalledMod,
  records: ModInstallRecord[] = [],
  foreignUnits: ForeignModUnit[] = [],
  catalog: CatalogEntry[] = [],
  gameRoot = GAME,
) => relationsByUnit([u], records, foreignUnits, catalog, gameRoot).get(u.relPath) ?? [];

describe("relationPathKey", () => {
  it("normalizes separators, case, trailing slashes and the .bak twin", () => {
    expect(relationPathKey("PnFMods\\Sub\\File.DDS.BAK")).toBe("pnfmods/sub/file.dds");
    expect(relationPathKey("./PnFMods/Sub/")).toBe("pnfmods/sub");
    expect(relationPathKey("")).toBe("");
  });
});

describe("relationsByUnit", () => {
  it("marks a unit's own ledger record (count 1)", () => {
    const u = unit({ relPath: "PnFMods/ModA", name: "Mod A", identity: "mod-a" });
    const rows = relationsOf(u, [
      record({ id: "mod-a", name: "Mod A", files: ["PnFMods/ModA/main.py", "PnFMods/ModA/tex.dds"] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "record",
      recordId: "mod-a",
      name: "Mod A",
      source: "mod-hub",
      own: true,
      shared: false,
      dependency: false,
      files: 2,
      totalFiles: 2,
      removable: true,
    });
    expect(unitRelationCount([u], [record({ id: "mod-a", files: ["PnFMods/ModA/x"] })], [], [], GAME, u.relPath)).toBe(1);
  });

  it("lists two pack records sharing one catch-all tree", () => {
    const u = unit({ relPath: "PnFMods/content", name: "content" });
    const rows = relationsOf(u, [
      record({ id: "pack.one", name: "Pack One", files: ["PnFMods/content/a.txt"] }),
      record({ id: "pack.two", name: "Pack Two", files: ["PnFMods/content/b.txt"] }),
    ]);
    expect(rows.map((row) => row.recordId)).toEqual(["pack.one", "pack.two"]);
    expect(rows.every((row) => !row.own && !row.shared && !row.dependency && row.removable)).toBe(true);
  });

  it("surfaces a shared component plus its dependency consumers", () => {
    const u = unit({ relPath: "PnFMods/TTaroModUtils", name: "TTaroModUtils" });
    const rows = relationsOf(
      u,
      [
        record({
          id: "shared.pnfmods.ttaromodutils",
          name: "Shared TTaro runtime (TTaroModUtils)",
          files: ["PnFMods/TTaroModUtils/lib.lua", "PnFMods/TTaroModUtils/init.lua"],
        }),
        record({
          id: "pack.a",
          name: "Pack A",
          files: ["PnFMods/PackA/main.py"],
          sharedRoots: ["pnfmods/ttaromodutils/"],
        }),
        record({
          id: "pack.b",
          name: "Pack B",
          files: ["PnFMods/PackB/main.py"],
          sharedRoots: ["PnFMods/TTaroModUtils"],
        }),
      ],
      [],
      [],
    );
    expect(rows).toHaveLength(3);
    const own = rows.find((row) => row.own)!;
    expect(own).toMatchObject({
      kind: "record",
      recordId: "shared.pnfmods.ttaromodutils",
      source: "shared",
      shared: true,
      removable: false,
      files: 2,
      totalFiles: 2,
    });
    const deps = rows.filter((row) => row.dependency);
    expect(deps.map((row) => row.recordId).sort()).toEqual(["pack.a", "pack.b"]);
    expect(deps.every((row) => row.files === 0 && row.totalFiles === 1 && row.removable)).toBe(true);
  });

  it("matches slash-less shared roots as file-family prefixes (unbound fragments)", () => {
    const u = unit({ relPath: "gui/unbound2/PnFMods", name: "unbound2" });
    const rows = relationsOf(u, [
      record({
        id: "shared.gui.unbound2.pnfmods.ttaromodutils",
        name: "Shared TTaro unbound fragments",
        files: ["gui/unbound2/PnFMods/TTaroModUtils2.unbound"],
      }),
      record({
        id: "pack.a",
        name: "Pack A",
        files: ["PnFMods/PackA/main.py"],
        sharedRoots: ["gui/unbound2/pnfmods/ttaromodutils"],
      }),
    ]);
    expect(rows.find((row) => row.recordId === "pack.a")).toMatchObject({
      dependency: true,
      removable: true,
    });
    expect(rows.find((row) => row.recordId === "shared.gui.unbound2.pnfmods.ttaromodutils")).toMatchObject({
      own: true,
      shared: true,
      removable: false,
    });
  });

  it("matches .bak/case-variant spellings and single-file roots", () => {
    const u = unit({ relPath: "PnFMods/ModX", name: "ModX" });
    expect(
      relationsOf(u, [
        record({ id: "pack.one", files: ["pnfmods\\modx\\file.txt.BAK"] }),
      ]).map((row) => row.recordId),
    ).toEqual(["pack.one"]);

    const loader = unit({ relPath: "PnFModsLoader.py", name: "PnFModsLoader.py" });
    expect(
      relationsOf(loader, [
        record({ id: "pack.loader", files: ["pnfmodsloader.py.bak"] }),
      ]).map((row) => row.recordId),
    ).toEqual(["pack.loader"]);
  });

  it("adds the Aslain foreign row that pairs the unit (and no catalog twin)", () => {
    const u = unit({ relPath: "PnFMods/AslainOne", name: "Aslain One", identity: "mod-b" });
    const rows = relationsOf(
      u,
      [],
      [foreign({ key: "aslain-one", name: "Aslain One", identity: "mod-b", version: "2.1" })],
      [entry("mod-b")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "foreign",
      name: "Aslain One",
      version: "2.1",
      catalogId: "mod-b",
      source: "aslain",
      // The manifest row's name anchors this unit, so it is the unit's own mod.
      own: true,
      removable: true,
      ownerRelPath: u.relPath,
      files: 0,
    });
  });

  it("adds a catalog identity row when neither the ledger nor Aslain claims it", () => {
    const u = unit({ relPath: "PnFMods/Paired", name: "Paired Dir", identity: "mod-c" });
    const rows = relationsOf(u, [], [], [entry("mod-c", { nameEn: "Catalog Name" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "catalog",
      catalogId: "mod-c",
      name: "Catalog Name",
      source: "catalog",
      // The identity pairing is the unit's own mod when nothing else backs it.
      own: true,
      removable: true,
      ownerRelPath: u.relPath,
    });
  });

  it("pairs a folded family's superseded legacy record id to the entry", () => {
    const u = unit({ relPath: "PnFMods/Panel", name: "Panel", identity: "battle.panel.ttaro" });
    const catalog = [entry("battle.panel", { supersedes: { "battle.panel.ttaro": "ttaro" } })];
    const rows = relationsOf(
      u,
      [record({ id: "battle.panel.ttaro", files: ["PnFMods/Panel/a.xml"] })],
      [],
      catalog,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].own).toBe(true);
    expect(rows[0].catalogId).toBe("battle.panel");
  });

  it("ignores records of another game root but keeps legacy empty stamps", () => {
    const u = unit({ relPath: "PnFMods/ModA", name: "Mod A", identity: "mod-a" });
    const legacy = record({ id: "mod-a", name: "Mod A", files: ["PnFMods/ModA/x"], gameRoot: "" });
    expect(relationsOf(u, [legacy], [], [], GAME)).toHaveLength(1);
    expect(
      relationsOf(u, [record({ id: "mod-a", files: ["PnFMods/ModA/x"], gameRoot: "D:/OtherGame" })]),
    ).toHaveLength(0);
  });

  it("never associates @game drops (and excludes them from the file counts)", () => {
    const u = unit({ relPath: "PnFMods/ModA", name: "Mod A" });
    expect(
      relationsOf(u, [record({ id: "mod-a", name: "Mod A", files: ["@game/gettext_x64r.dll"] })]),
    ).toHaveLength(0);
    const mixed = relationsOf(u, [
      record({ id: "mod-a", name: "Mod A", files: ["@game/gettext_x64r.dll", "PnFMods/ModA/x"] }),
    ]);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatchObject({ files: 1, totalFiles: 2 });
  });

  it("skips a foreign row that a ledger record already backs", () => {
    const u = unit({ relPath: "PnFMods/ModA", name: "Mod A", identity: "mod-a" });
    const rows = relationsOf(
      u,
      [record({ id: "mod-a", name: "Mod A", files: ["PnFMods/ModA/x"] })],
      [foreign({ key: "mod-a", name: "Mod A", identity: "mod-a" })],
      [entry("mod-a")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("record");
  });

  it("matches unit roots on a path boundary, not a raw string prefix", () => {
    const u = unit({ relPath: "content", name: "content" });
    // `contents/` merely shares the first characters — it is a different tree.
    expect(
      relationsOf(u, [record({ id: "pack.other", files: ["contents/gui/x.png"] })]),
    ).toHaveLength(0);
    expect(
      relationsOf(u, [record({ id: "pack.own", files: ["content/gui/x.png"] })]),
    ).toHaveLength(1);
  });

  it("does not badge one of several shared components as a catch-all tree's own mod", () => {
    // The `texts` catch-all carries a whole family of single-file shared
    // catalogs: none of them is "the" unit's own mod.
    const u = unit({ relPath: "texts", name: "texts" });
    const rows = relationsOf(u, [
      record({
        id: "shared.texts.en.ttaro-mod-config.mo",
        name: "Shared TTaro text catalog (en)",
        files: ["texts/en/ttaro-mod-config.mo"],
      }),
      record({
        id: "shared.texts.de.ttaro-mod-config.mo",
        name: "Shared TTaro text catalog (de)",
        files: ["texts/de/ttaro-mod-config.mo"],
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.shared && !row.own && !row.removable)).toBe(true);
  });

  it("badges the single shared component owning a pure runtime unit", () => {
    const u = unit({ relPath: "gui/ttaro", name: "ttaro" });
    const rows = relationsOf(u, [
      record({
        id: "shared.gui.ttaro",
        name: "Shared TTaro GUI tree",
        files: ["gui/ttaro/index.css", "gui/ttaro/panel.dds"],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shared: true, own: true, removable: false, files: 2 });
  });
});
