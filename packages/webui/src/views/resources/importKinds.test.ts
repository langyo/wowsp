/** Pure custom-import rules: the path-string checks the wizard can run
 *  without the backend, the display-name seed, the probe summary formatters
 *  and the language-neutral problem/stage code → i18n key mapping. */
import { describe, expect, it } from "vitest";

import {
  IMPORT_KINDS,
  PROBLEM_CODES,
  STAGE_CODES,
  defaultDisplayName,
  formatBytes,
  isLowTierVideo,
  kindOption,
  leafName,
  pathExtension,
  probeBlocks,
  problemKey,
  progressPercent,
  stageKey,
  stemName,
  validatePickedPath,
} from "./importKinds";

describe("import kind metadata", () => {
  it("lists the four spec kinds with their picker shape", () => {
    expect(IMPORT_KINDS.map((kind) => kind.id)).toEqual([
      "video",
      "voice",
      "texture",
      "misc",
    ]);
    expect(kindOption("video")?.wantsFile).toBe(true);
    expect(kindOption("voice")?.wantsFile).toBe(false);
    expect(kindOption("texture")?.wantsFile).toBe(false);
    expect(kindOption("misc")?.wantsFile).toBe(false);
    expect(kindOption(null)).toBeNull();
    expect(kindOption("video")?.extensions).toEqual(["webm", "mp4", "mov", "mkv"]);
  });
});

describe("path helpers", () => {
  it("reads extensions from either separator, case-insensitively", () => {
    expect(pathExtension("C:\\clips\\Intro.WEBM")).toBe("webm");
    expect(pathExtension("/home/a/clip.mp4")).toBe("mp4");
    expect(pathExtension("clip")).toBe("");
    expect(pathExtension("clip.")).toBe("");
    expect(pathExtension(".hidden")).toBe("");
  });

  it("reads the leaf name and the stem", () => {
    expect(leafName("C:\\a\\b\\pack")).toBe("pack");
    expect(leafName("C:\\a\\b\\")).toBe("b");
    expect(leafName("/a/b/c.tar.gz")).toBe("c.tar.gz");
    expect(leafName("")).toBe("");
    expect(stemName("C:\\a\\My Login.webm")).toBe("My Login");
    expect(stemName("C:\\a\\folder")).toBe("folder");
  });

  it("seeds the display name from the kind", () => {
    expect(defaultDisplayName("video", "C:\\clips\\intro.webm")).toBe("intro");
    expect(defaultDisplayName("voice", "C:\\packs\\Hoshino pack")).toBe(
      "Hoshino pack",
    );
  });

  it("recognizes the 720p tier by its _low suffix", () => {
    expect(isLowTierVideo("C:\\clips\\ending_low.webm")).toBe(true);
    expect(isLowTierVideo("C:\\clips\\ending_LOW.webm")).toBe(true);
    expect(isLowTierVideo("C:\\clips\\ending.webm")).toBe(false);
  });
});

describe("validatePickedPath", () => {
  it("requires a path", () => {
    expect(validatePickedPath("video", "   ")).toEqual({ code: "missingPath" });
    expect(validatePickedPath(null, "C:\\a")).toBeNull();
  });

  it("accepts the four video containers and refuses the rest", () => {
    for (const ext of ["webm", "mp4", "mov", "mkv", "MKV"]) {
      expect(validatePickedPath("video", `C:\\clips\\a.${ext}`)).toBeNull();
    }
    expect(validatePickedPath("video", "C:\\clips\\a.avi")).toEqual({
      code: "unsupportedVideo",
      detail: "avi",
    });
    expect(validatePickedPath("video", "C:\\clips\\a")).toEqual({
      code: "unsupportedVideo",
      detail: "?",
    });
  });

  it("leaves folder kinds to the backend probe", () => {
    expect(validatePickedPath("voice", "C:\\packs\\anything")).toBeNull();
    expect(validatePickedPath("texture", "C:\\packs\\anything")).toBeNull();
  });
});

describe("probe summary helpers", () => {
  it("treats any problem as blocking", () => {
    expect(probeBlocks([])).toBe(false);
    expect(probeBlocks([{ code: "missingPath" }])).toBe(true);
  });

  it("formats binary sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(200 * 1024 * 1024)).toBe("200 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("clamps progress percentages", () => {
    expect(progressPercent(42.4)).toBe(42);
    expect(progressPercent(-3)).toBe(0);
    expect(progressPercent(120)).toBe(100);
    expect(progressPercent(Number.NaN)).toBe(0);
  });
});

describe("code → i18n key mapping", () => {
  it("localizes every known problem code", () => {
    for (const code of PROBLEM_CODES) {
      expect(problemKey(code)).toBe(`resources.importWizard.problem.${code}`);
    }
    expect(problemKey("somethingNew")).toBe(
      "resources.importWizard.problem.unknown",
    );
  });

  it("localizes every stage code", () => {
    for (const code of STAGE_CODES) {
      expect(stageKey(code)).toBe(`resources.importWizard.stage.${code}`);
    }
    expect(stageKey("resuming")).toBe("resources.importWizard.stage.working");
  });
});
