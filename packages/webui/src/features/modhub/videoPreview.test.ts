/** videoPreview: the video-extension and layer-directory rules behind the
 *  inline login-video player. */
import { describe, expect, it } from "vitest";

import {
  LOGIN_VIDEO_DIR,
  isVideoExt,
  isVideoPath,
  videoPreviewDir,
} from "./videoPreview";

describe("isVideoExt", () => {
  it("accepts the WEBM/MP4 containers case-insensitively", () => {
    expect(isVideoExt("webm")).toBe(true);
    expect(isVideoExt("MP4")).toBe(true);
  });

  it("rejects non-video extensions", () => {
    expect(isVideoExt("png")).toBe(false);
    expect(isVideoExt("wem")).toBe(false);
    expect(isVideoExt("")).toBe(false);
    expect(isVideoExt("webm.bak")).toBe(false);
  });
});

describe("isVideoPath", () => {
  it("reads the final segment under either separator", () => {
    expect(isVideoPath("gui/video/login/main.webm")).toBe(true);
    expect(isVideoPath("gui\\video\\login\\main_low.WEBM")).toBe(true);
    expect(isVideoPath("gui/video/login/poster.png")).toBe(false);
    expect(isVideoPath("gui/video/login/main")).toBe(false);
  });
});

describe("videoPreviewDir", () => {
  it("prefers the layer's own video directory", () => {
    expect(
      videoPreviewDir({
        category: "video",
        videoDir: "gui/video/login",
      }),
    ).toBe("gui/video/login");
  });

  it("falls back to the login target for video-category layers only", () => {
    expect(videoPreviewDir({ category: "video" })).toBe(LOGIN_VIDEO_DIR);
    expect(videoPreviewDir({ category: "skin" })).toBeNull();
    expect(videoPreviewDir({ category: "skin", videoDir: "gui/video/login" })).toBe(
      "gui/video/login",
    );
  });
});
