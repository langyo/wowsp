/** videoPrimary: the one-primary-clip rule behind the video-pack preview. */
import { describe, expect, it } from "vitest";

import { pickPrimaryVideo, videoBasename, videoTierRank } from "./videoPrimary";

const clip = (rel: string, size = 1024) => ({ rel, size });

describe("videoBasename", () => {
  it("reads the final segment under either separator", () => {
    expect(videoBasename("gui/video/login/main.webm")).toBe("main.webm");
    expect(videoBasename("gui\\video\\login\\main_low.webm")).toBe("main_low.webm");
    expect(videoBasename("main.webm")).toBe("main.webm");
  });
});

describe("videoTierRank", () => {
  it("ranks exact main.webm first, full tiers next, low tiers last", () => {
    expect(videoTierRank("main.webm")).toBe(0);
    expect(videoTierRank("MAIN.WEBM")).toBe(0);
    expect(videoTierRank("opening.webm")).toBe(1);
    expect(videoTierRank("main_low.webm")).toBe(2);
    expect(videoTierRank("MAIN_LOW.WEBM")).toBe(2);
  });
});

describe("pickPrimaryVideo", () => {
  it("prefers main.webm over main_low.webm", () => {
    const main = clip("gui/video/login/main.webm", 30 * 1024);
    const low = clip("gui/video/login/main_low.webm", 12 * 1024);
    const picked = pickPrimaryVideo([low, main]);
    expect(picked.primary).toBe(main);
    expect(picked.siblings).toEqual([low]);
  });

  it("falls back to the first non-_low tier when main.webm is absent", () => {
    const low = clip("gui/video/login/main_low.webm");
    const other = clip("gui/video/login/zzz.webm");
    const picked = pickPrimaryVideo([low, other]);
    expect(picked.primary).toBe(other);
    expect(picked.siblings).toEqual([low]);
  });

  it("keeps the only low-tier clip when nothing else is shipped", () => {
    const low = clip("gui/video/login/main_low.webm");
    const picked = pickPrimaryVideo([low]);
    expect(picked.primary).toBe(low);
    expect(picked.siblings).toEqual([]);
  });

  it("breaks full-tier ties by name", () => {
    const alpha = clip("gui/video/login/alpha.webm");
    const beta = clip("gui/video/login/beta.webm");
    const picked = pickPrimaryVideo([beta, alpha]);
    expect(picked.primary).toBe(alpha);
    expect(picked.siblings).toEqual([beta]);
  });

  it("matches main.webm case-insensitively", () => {
    const upper = clip("gui/video/login/MAIN.WEBM");
    const low = clip("gui/video/login/main_low.webm");
    expect(pickPrimaryVideo([low, upper]).primary).toBe(upper);
  });

  it("orders all siblings by the same rule", () => {
    const low = clip("gui/video/login/main_low.webm");
    const beta = clip("gui/video/login/beta.webm");
    const alpha = clip("gui/video/login/alpha.webm");
    const picked = pickPrimaryVideo([low, beta, alpha]);
    expect(picked.primary).toBe(alpha);
    expect(picked.siblings).toEqual([beta, low]);
  });

  it("returns null for an empty listing", () => {
    expect(pickPrimaryVideo([])).toEqual({ primary: null, siblings: [] });
  });
});
