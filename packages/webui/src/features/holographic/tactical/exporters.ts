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
 *  its TRUE aspect, not squashed into a square). */
export function composeExportCanvas(
  base: HTMLCanvasElement,
  overlay: HTMLCanvasElement | null,
  opts: ImageExportOptions,
  outWidth: number,
  outHeight: number,
  timeText: string | null,
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
  return out;
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

/** Save through the native dialog (desktop) or a browser download fallback.
 *  Returns the saved path / fallback filename, or null when the user
 *  cancelled the dialog. */
export async function saveExportBlob(
  blob: Blob,
  defaultName: string,
  filterLabel: string,
  ext: string,
): Promise<string | null> {
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
    return defaultName;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    await api.saveExportBytes(path, bytes);
  } catch {
    browserDownload(blob, defaultName);
    return defaultName;
  }
  return path;
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
