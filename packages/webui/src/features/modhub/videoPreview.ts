/**
 * Video-pack preview helpers. The modern client's login/opening clip is
 * `gui/video/login/main.webm` (1080p) plus `main_low.webm` (720p) —
 * VP9+Vorbis, 25 fps — and a video pack simply shadows those paths in
 * res_mods. These helpers stay pure (no IPC, no Vue) so
 * videoPreview.test.ts can pin the extension and directory rules.
 */
import type { ModLayer } from "@/api";

/** Where the stock login/opening clip lives, relative to res_mods. A video
 *  pack that only exists as a legacy record still previews from here. */
export const LOGIN_VIDEO_DIR = "gui/video/login";

/** Browser-playable containers the inline player accepts. */
const VIDEO_EXTS = ["webm", "mp4"] as const;

/** True for a bare extension (no dot, any case) the pane can play. */
export function isVideoExt(ext: string): boolean {
  return (VIDEO_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/** True for a path whose final segment carries a video extension. */
export function isVideoPath(rel: string): boolean {
  const name = rel.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && isVideoExt(name.slice(dot + 1));
}

/** The directory a layer's video section should list: the backend-reported
 *  video directory when the layer ships video files, else the known login
 *  target for a video-category layer (legacy installs have no fingerprint).
 *  Null means this layer shows no video section at all. */
export function videoPreviewDir(
  layer: Pick<ModLayer, "category" | "videoDir">,
): string | null {
  if (layer.videoDir) return layer.videoDir;
  return layer.category === "video" ? LOGIN_VIDEO_DIR : null;
}
