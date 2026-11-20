/**
 * Tactical-board exporters: compose the 2D map + annotation layers into one
 * canvas, then either rasterize it (PNG/WebP) or record it (MediaRecorder,
 * MP4 when the host supports H.264 muxing, WebM otherwise) — and persist the
 * result through the native save dialog via raw IPC.
 *
 * Wave 2 (see the tactical-board design notes) replaces the realtime
 * recorder with a deterministic offline render (WebCodecs via mediabunny)
 * that re-renders each frame at a fixed fps instead of following wall-clock
 * playback; the compose pipeline below is shared by both.
 */
import { api } from "@/api/client";
import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  canEncodeVideo,
  type VideoCodec,
} from "mediabunny";
import type { ImageExportOptions } from "./types";
import { TACTICAL_SIZE } from "./render";

export function formatBattleClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `T+${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Burn a "T+MM:SS" chip into the top-left corner of an export frame. */
export function drawTimestampChip(
  ctx: CanvasRenderingContext2D,
  size: number,
  text: string,
): void {
  const fs = Math.round(size * 0.032);
  ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(5, 8, 15, 0.72)";
  ctx.beginPath();
  ctx.roundRect(size * 0.02, size * 0.02, w + fs, fs * 1.7, fs * 0.5);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size * 0.02 + fs * 0.5, size * 0.02 + fs * 0.87);
}

/** Compose base map + annotations into a fresh export canvas. `crop` is in
 *  logical 760 units; output size is per-axis (a non-square crop exports at
 *  its TRUE aspect, not squashed into a square). `minimap` (the host's
 *  overview canvas) burns into the bottom-right corner. */
export function composeExportCanvas(
  base: HTMLCanvasElement,
  overlay: HTMLCanvasElement | null,
  opts: ImageExportOptions,
  outWidth: number,
  outHeight: number,
  timeText: string | null,
  minimap?: HTMLCanvasElement | null,
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = outWidth;
  out.height = outHeight;
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  // Source rect on the (square, HiDPI) live canvases: logical units →
  // device px via the shared backing-store scale.
  const scale = base.width / TACTICAL_SIZE;
  const crop = opts.crop ?? { x: 0, y: 0, w: TACTICAL_SIZE, h: TACTICAL_SIZE };
  const sx = crop.x * scale;
  const sy = crop.y * scale;
  const sw = crop.w * scale;
  const sh = crop.h * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(base, sx, sy, sw, sh, 0, 0, outWidth, outHeight);
  if (overlay) ctx.drawImage(overlay, sx, sy, sw, sh, 0, 0, outWidth, outHeight);
  if (timeText) drawTimestampChip(ctx, Math.min(outWidth, outHeight), timeText);
  if (minimap) drawMinimapChip(ctx, outWidth, outHeight, minimap);
  return out;
}

/** Burn the host's overview minimap into an export frame's bottom-right
 *  corner — with the view window boxed by the host, viewers of a recorded
 *  walkthrough always know where on the map the camera is looking. */
export function drawMinimapChip(
  ctx: CanvasRenderingContext2D,
  outWidth: number,
  outHeight: number,
  minimap: HTMLCanvasElement,
): void {
  if (minimap.width === 0 || minimap.height === 0) return;
  const edge = Math.min(outWidth, outHeight);
  const size = Math.round(edge * 0.2);
  const pad = Math.round(edge * 0.02);
  const x = outWidth - size - pad;
  const y = outHeight - size - pad;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(minimap, 0, 0, minimap.width, minimap.height, x, y, size, size);
  ctx.strokeStyle = "rgba(203, 213, 225, 0.55)";
  ctx.lineWidth = Math.max(1, Math.round(size * 0.014));
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  ctx.restore();
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: "image/png" | "image/webp",
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`encode ${mime} failed`))),
      mime,
      0.95,
    );
  });
}

function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** One completed save: where the file landed and whether it exists as a
 *  NATIVE file (dialog path) — only a native file can ride the follow-up
 *  clipboard hand-off (the replay clip's paste-into-chat copy); a
 *  browser-download fallback names a file the shell has never seen. */
export interface SavedExport {
  path: string;
  native: boolean;
}

/** Save through the native dialog (desktop) or a browser download fallback.
 *  Returns the save result, or null when the user cancelled the dialog. */
export async function saveExportBlob(
  blob: Blob,
  defaultName: string,
  filterLabel: string,
  ext: string,
): Promise<SavedExport | null> {
  let path: string | null = null;
  let hostFallback = false;
  try {
    path = await api.pickExportPath(defaultName, filterLabel, [ext]);
  } catch {
    // Non-tauri host or dialog backend unavailable — fall back to a
    // browser download with the default name.
    hostFallback = true;
  }
  if (path == null) {
    if (!hostFallback) return null; // user cancelled the save dialog
    if (ext && !defaultName.toLowerCase().endsWith(`.${ext}`)) {
      defaultName = `${defaultName}.${ext}`;
    }
    browserDownload(blob, defaultName);
    return { path: defaultName, native: false };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    await api.saveExportBytes(path, bytes);
  } catch {
    browserDownload(blob, defaultName);
    return { path: defaultName, native: false };
  }
  return { path, native: true };
}

/** Save into a user-chosen DIRECTORY (the export modal's path row) —
 *  no native dialog. Returns null when the host rejects the write (non-
 *  tauri host, revoked dir grant, IO error) so callers fall back to
 *  saveExportBlob's dialog/browser path. */
/** Join a directory + file name with the directory's own separator (a
 *  Windows path keeps backslashes, a POSIX path keeps slashes); trailing
 *  separators are collapsed. Empty dir → null (nothing to write into). */
export function joinExportPath(dir: string, name: string): string | null {
  const trimmed = dir.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const sep = trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${sep}${name}`;
}

export async function saveExportBlobTo(
  blob: Blob,
  dir: string,
  name: string,
): Promise<SavedExport | null> {
  const path = joinExportPath(dir, name);
  if (!path) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    await api.saveExportBytes(path, bytes);
  } catch {
    return null;
  }
  return { path, native: true };
}

const RECORDER_MIMES: { mime: string; ext: "mp4" | "webm" }[] = [
  { mime: "video/mp4;codecs=avc1.640028", ext: "mp4" },
  { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
  { mime: "video/mp4", ext: "mp4" },
  { mime: "video/webm;codecs=vp9", ext: "webm" },
  { mime: "video/webm;codecs=vp8", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
];

export function pickRecorderMime(): { mime: string; ext: "mp4" | "webm" } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const cand of RECORDER_MIMES) {
    if (MediaRecorder.isTypeSupported(cand.mime)) return cand;
  }
  return null;
}

// ── Offline (faster-than-realtime) export via WebCodecs ──────────────────

/** Frame timestamps for an offline render: starts at `from`, steps by
 *  1/fps, never passes `to`, always contains at least `from`. Pure —
 *  unit-tested so the encoder contract (strictly increasing, last ≤ to)
 *  stays guaranteed. */
export function frameTimes(from: number, to: number, fps: number): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || fps <= 0) {
    return Number.isFinite(from) ? [from] : [];
  }
  const step = 1 / fps;
  const out: number[] = [];
  // Snap to a fixed grid (not += accumulation) so float error can never
  // produce a non-increasing pair.
  const count = Math.floor((to - from) / step + 1e-9) + 1;
  for (let i = 0; i < count; i++) {
    const t = from + i * step;
    out.push(t > to ? to : Number(t.toFixed(6)));
  }
  return out;
}

export interface OfflineRenderOptions {
  fps: number;
  times: number[];
  /** Output edge in px (square canvas, same as the realtime recorder).
   *  Used as both width and height when `width`/`height` are omitted —
   *  one of the two forms must be present. */
  size?: number;
  /** Output frame width in px (defaults to `size`). Non-square hosts
   *  (the replay-playback export) pass their own width/height; codecs
   *  want even numbers. */
  width?: number;
  /** Output frame height in px (defaults to `size`). */
  height?: number;
  /** Paint one finished frame (base map + annotations + timestamp) for
   *  battle time `t` onto `ctx`. Called once per entry of `times`; the
   *  backing canvas measures the resolved width × height. */
  paintAt: (t: number, ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  /** Presentation timestamps (seconds) per entry of `times` — defaults to
   *  the battle-time deltas (times[i] − times[0]), the tactical board's
   *  realtime-paced contract. Hosts that COMPRESS battle time (the
   *  replay-playback export's speed multiplier) pass their own uniform
   * grid (i / fps) so the clip plays fast instead of long. */
  frameTimestamps?: number[];
  /** Preferred codec/container ladder, best first. Defaults to the
   *  board's MP4-first contract (avc into MP4, vp9 into WebM); hosts with
   *  a different compatibility contract (the replay clip ships
   *  VP9/AV1 into MP4) pass their own ladder. The first entry the host
   *  can actually encode wins. */
  codecLadder?: readonly OfflineCodecChoice[];
  onProgress?: (done: number, total: number) => void;
  /** Coarse PHASE signal for the progress surface: "render" while frames
   *  are painted+encoded, "finalize" while the encoder flushes and the
   *  muxer writes the container (mediabunny's finalize can take a long
   *  while on a long in-memory track and reports no percentage of its
   *  own — the UI must at least change state there instead of looking
   *  frozen at 100%). */
  onPhase?: (phase: "render" | "finalize") => void;
  cancelToken?: { cancelled: boolean };
}

export interface OfflineRenderResult {
  blob: Blob;
  ext: "mp4" | "webm";
  /** True when the user cancelled; `blob` then holds the partial render
   *  (possibly empty) and callers stay quiet instead of erroring. */
  cancelled: boolean;
}

/** One rung of an offline export's codec ladder: the mediabunny codec id
 *  plus the container it muxes into. The pairing is explicit because a
 *  container's decoder support is codec-dependent (VP8 is only playable
 *  inside WebM, VP9/AV1 are playable inside MP4, H.264 rides MP4). */
export interface OfflineCodecChoice {
  codec: VideoCodec;
  ext: "mp4" | "webm";
}

/** The tactical board's MP4-first contract (unchanged): H.264 into MP4, VP9
 *  into WebM as the fallback when the host exposes no AVC encoder. */
export const DEFAULT_CODEC_LADDER: readonly OfflineCodecChoice[] = [
  { codec: "avc", ext: "mp4" },
  { codec: "vp9", ext: "webm" },
];

/** Preferred codec/container ladder for offline exports. Returns null when
 *  WebCodecs can't encode any entry (caller falls back to the realtime
 *  MediaRecorder path). */
async function pickOfflineFormat(
  width: number,
  height: number,
  codecLadder: readonly OfflineCodecChoice[] = DEFAULT_CODEC_LADDER,
): Promise<OfflineCodecChoice | null> {
  if (typeof VideoEncoder === "undefined") return null;
  for (const choice of codecLadder) {
    if (await canEncodeVideo(choice.codec, { width, height })) {
      return choice;
    }
  }
  return null;
}

export async function renderVideoOffline(opts: OfflineRenderOptions): Promise<OfflineRenderResult | null> {
  const times = opts.times;
  if (times.length === 0) return null;
  const width = opts.width ?? opts.size ?? 0;
  const height = opts.height ?? opts.size ?? 0;
  if (width <= 0 || height <= 0) return null;
  const picked = await pickOfflineFormat(width, height, opts.codecLadder);
  if (!picked) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const target = new BufferTarget();
  const format = picked.ext === "mp4"
    ? new Mp4OutputFormat({ fastStart: "in-memory" })
    : new WebMOutputFormat();
  // Ladder rungs pair a codec with a container, and a mismatched pair (e.g.
  // AVC into WebM) type-checks but makes addVideoTrack throw OUTSIDE the
  // cancel-handling try below. Verify the container accepts the codec and
  // degrade to null (the caller's "unsupported" path) instead.
  if (!format.getSupportedVideoCodecs().includes(picked.codec)) return null;
  const output = new Output({ format, target });
  // Encoder tuned for THROUGHPUT WITH legible text: `quality: HIGH` drove
  // the VP9/AV1 software encoders into their slowest paths (a 10-minute
  // match encoded for tens of minutes), but the first throughput pass
  // (0.12 bpp) starved the realtime deadline into smeared map text — the
  // "太糊了" report. 0.2 bpp with a 6 Mbps floor keeps grid lines and
  // ship-name pills crisp at the realtime deadline; the realtime latency
  // mode itself stays (it is what keeps libvpx out of the slow paths),
  // and prefer-hardware lets AVC land on the platform encoder.
  const source = new CanvasSource(canvas, {
    codec: picked.codec,
    bitrate: Math.min(
      30_000_000,
      Math.max(6_000_000, Math.round(width * height * opts.fps * 0.2)),
    ),
    latencyMode: "realtime",
    hardwareAcceleration: "prefer-hardware",
  });
  output.addVideoTrack(source, { frameRate: opts.fps });
  const cancelled = () => opts.cancelToken?.cancelled === true;

  try {
    // mediabunny contract: tracks must be declared, then the output started,
    // before the first sample — `source.add` throws on a pending output.
    await output.start();
    opts.onPhase?.("render");
    const first = times[0];
    const frameDuration = 1 / opts.fps;
    let encodedAny = false;
    for (let i = 0; i < times.length; i++) {
      if (cancelled()) break;
      const t = times[i];
      opts.paintAt(t, ctx, width, height);
      // Video timestamps are relative to the first rendered frame — the
      // caller's explicit grid wins (speed-compressed exportspace).
      const pts = opts.frameTimestamps ? opts.frameTimestamps[i] : t - first;
      await source.add(pts, frameDuration);
      encodedAny = true;
      opts.onProgress?.(i + 1, times.length);
    }
    // Frames are done: the encoder flush + container write is the
    // "finalize" phase (no percentage of its own — see onPhase).
    opts.onPhase?.("finalize");
    source.close();
    await output.finalize();
    // A cancelled render with zero encoded frames finalizes to a header-only
    // mux (~100 B, unplayable) — judge by frames, not by buffer size.
    if (!encodedAny) {
      if (cancelled()) {
        return { blob: new Blob([], { type: "video/mp4" }), ext: picked.ext, cancelled: true };
      }
      return null;
    }
    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) return null;
    return {
      blob: new Blob([buffer], {
        type: picked.ext === "mp4" ? "video/mp4" : "video/webm",
      }),
      ext: picked.ext,
      cancelled: cancelled(),
    };
  } catch (e) {
    // Cancel the output so no half-written file escapes; the realtime
    // recorder is the caller's fallback.
    try {
      await output.cancel();
    } catch {
      // ignore secondary cancel failures
    }
    throw e;
  }
}

/**
 * Realtime canvas recorder over `captureStream(0)` + explicit `requestFrame`
 * per composited frame: frames land only when the tactical layer paints, so
 * pauses never emit duplicate frames. The compose callback receives a
 * pre-sized ctx and must paint the whole frame every tick.
 */
export class TacticalRecorder {
  readonly ext: "mp4" | "webm";
  readonly mime: string;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly compose: (ctx: CanvasRenderingContext2D, size: number) => void;
  private recorder: MediaRecorder | null = null;
  private track: CanvasCaptureMediaStreamTrack | null = null;
  private chunks: Blob[] = [];

  constructor(
    compose: (ctx: CanvasRenderingContext2D, size: number) => void,
    size = 1280,
    mimeChoice: { mime: string; ext: "mp4" | "webm" } | null = pickRecorderMime(),
  ) {
    this.compose = compose;
    this.mime = mimeChoice?.mime ?? "";
    this.ext = mimeChoice?.ext ?? "webm";
    this.canvas = document.createElement("canvas");
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext("2d");
  }

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  start(): boolean {
    if (!this.ctx || !this.mime) return false;
    const stream = this.canvas.captureStream(0);
    this.track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    try {
      this.recorder = new MediaRecorder(stream, {
        mimeType: this.mime,
        videoBitsPerSecond: 12_000_000,
      });
    } catch {
      this.track = null;
      return false;
    }
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    return true;
  }

  /** Paint + push one frame. Call every RAF while recording. */
  tick(): void {
    if (!this.recording || !this.ctx) return;
    this.compose(this.ctx, this.canvas.width);
    this.track?.requestFrame();
  }

  async stop(): Promise<Blob> {
    const rec = this.recorder;
    if (!rec) return new Blob([], { type: this.mime });
    // A recorder that already went inactive (error/forced stop) never fires
    // onstop — resolve immediately instead of hanging the awaiter.
    if (rec.state === "inactive") {
      this.track = null;
      this.recorder = null;
      return new Blob(this.chunks, { type: this.mime });
    }
    const done = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.stop();
    await done;
    this.track = null;
    this.recorder = null;
    return new Blob(this.chunks, { type: this.mime });
  }
}
