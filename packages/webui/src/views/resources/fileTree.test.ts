import { describe, expect, it } from "vitest";

import { buildPathTree, commonRootDir, splitGameRootFiles } from "./fileTree";

describe("splitGameRootFiles", () => {
  it("separates @game drops from res_mods-relative paths", () => {
    const { resMods, game } = splitGameRootFiles([
      "PnFModsLoader.py",
      "PnFMods/ShotTimer/Main.py",
      "@game/magic.dll",
      "gui/unbound.xml",
    ]);
    expect(resMods).toEqual(["PnFModsLoader.py", "PnFMods/ShotTimer/Main.py", "gui/unbound.xml"]);
    expect(game).toEqual(["magic.dll"]);
  });
});

describe("buildPathTree", () => {
  it("nests paths with folders first and everything alphabetical", () => {
    const tree = buildPathTree([
      "banks/ba_yuuka/megumin_01.wem",
      "PnFModsLoader.py",
      "PnFMods/ShotTimer/Main.py",
      "PnFMods/AimHelper/Main.py",
      "gui/unbound.xml",
    ]);
    expect(tree.map((n) => n.name)).toEqual(["banks", "gui", "PnFMods", "PnFModsLoader.py"]);
    const pnf = tree[2];
    expect(pnf.children?.map((c) => c.name)).toEqual(["AimHelper", "ShotTimer"]);
    expect(pnf.children?.[0].children?.[0].name).toBe("Main.py");
    expect(pnf.children?.[0].children?.[0].path).toBe("PnFMods/AimHelper/Main.py");
  });

  it("dedupes repeated paths and skips empties", () => {
    const tree = buildPathTree(["a/b.txt", "a/b.txt", "", "/", "a/c.txt"]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children?.map((c) => c.name)).toEqual(["b.txt", "c.txt"]);
  });

  it("returns an empty tree for no files", () => {
    expect(buildPathTree([])).toEqual([]);
  });
});

describe("commonRootDir", () => {
  it("takes the longest shared directory chain", () => {
    expect(
      commonRootDir([
        "PnFMods/ShotTimer/Main.py",
        "PnFMods/ShotTimer/lib/util.py",
        "PnFMods/ShotTimer/readme.txt",
      ]),
    ).toBe("PnFMods/ShotTimer");
  });

  it("collapses to res_mods root when a file sits at the top", () => {
    expect(commonRootDir(["PnFMods/ShotTimer/Main.py", "PnFModsLoader.py"])).toBe("");
  });

  it("handles the empty list and single root file", () => {
    expect(commonRootDir([])).toBe("");
    expect(commonRootDir(["PnFModsLoader.py"])).toBe("");
  });
});
