/** Pure custom-import rules (自定义导入安装).
 *
 *  The wizard's `useImportWizard` state machine and the `ImportWizard` view
 *  both read these helpers: which kinds exist and how each one is picked,
 *  what the cheap CLIENT-SIDE checks can say before the backend probe runs,
 *  how a probe is summarized, and how the backend's language-neutral problem
 *  / stage codes map onto i18n keys. No Vue, no IPC — every function here is
 *  a pure value transform (vitest covers them in importKinds.test.ts).
 */
import type { CustomImportKind, CustomImportProblem } from "@/api";

/** One selectable kind on the wizard's step 1. */
export interface ImportKindOption {
  id: CustomImportKind;
  /** Lucide icon the view resolves (data, so this module stays component-free). */
  icon: "Film" | "Music" | "Palette" | "Package";
  /** True: the native SINGLE-FILE picker (video); false: the folder picker. */
  wantsFile: boolean;
  /** Accepted source extensions (lowercase, no dot) for file kinds. */
  extensions: string[];
}

/** The four kinds, in the order the selection grid renders them. */
export const IMPORT_KINDS: readonly ImportKindOption[] = [
  { id: "video", icon: "Film", wantsFile: true, extensions: ["webm", "mp4", "mov", "mkv"] },
  { id: "voice", icon: "Music", wantsFile: false, extensions: [] },
  { id: "texture", icon: "Palette", wantsFile: false, extensions: [] },
  { id: "misc", icon: "Package", wantsFile: false, extensions: [] },
];

/** Problem codes the backend may report (the wizard localizes each with
 *  `resources.importWizard.problem.<code>`; anything else falls back to
 *  `problem.unknown` so a future code can never render a raw key). */
export const PROBLEM_CODES = [
  "missing",
  "notFile",
  "notDirectory",
  "unsupportedVideo",
  "videoTooLarge",
  "missingFfmpeg",
  "voiceLayout",
  "textureRoots",
  "missingPath",
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** Progress stage codes the backend emits. */
export const STAGE_CODES = [
  "preparing",
  "transcodeMain",
  "transcodeLow",
  "copying",
  "installing",
  "done",
] as const;

export type StageCode = (typeof STAGE_CODES)[number];

export function kindOption(kind: CustomImportKind | null): ImportKindOption | null {
  if (!kind) return null;
  return IMPORT_KINDS.find((option) => option.id === kind) ?? null;
}

/** Lowercase extension without the dot; handles both path separators. */
export function pathExtension(path: string): string {
  const leaf = path.split(/[\\/]/).pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || dot === leaf.length - 1) return "";
  return leaf.slice(dot + 1).toLowerCase();
}

/** Leaf name of a path (file name or folder name), tolerant of both
 *  separators and a trailing separator. */
export function leafName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/** `leafName` without the extension — the display-name seed. */
export function stemName(path: string): string {
  const leaf = leafName(path);
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/** The display name the wizard pre-fills after a pick. */
export function defaultDisplayName(kind: CustomImportKind, path: string): string {
  return kind === "video" ? stemName(path) : leafName(path);
}

/** The cheap client-side checks — the ones that need no backend probe.
 *
 *  Everything structural (size, layout, ffmpeg) is the probe's job: the
 *  webview cannot stat a path. This only rejects what the PATH STRING itself
 *  already proves wrong, so "next" never fires a doomed IPC.
 */
export function validatePickedPath(
  kind: CustomImportKind | null,
  path: string,
): CustomImportProblem | null {
  const option = kindOption(kind);
  if (!option) return null;
  const trimmed = path.trim();
  if (!trimmed) return { code: "missingPath" };
  if (!option.wantsFile) return null;
  const ext = pathExtension(trimmed);
  if (!option.extensions.includes(ext)) {
    return { code: "unsupportedVideo", detail: ext || "?" };
  }
  return null;
}

/** Is this video source already the 720p (`*_low`) tier? */
export function isLowTierVideo(path: string): boolean {
  return stemName(path).toLowerCase().endsWith("_low");
}

/** Does the probe block the wizard's "next"? */
export function probeBlocks(problems: readonly CustomImportProblem[]): boolean {
  return problems.length > 0;
}

/** i18n key of one backend problem code (whitelisted). */
export function problemKey(code: string): string {
  return (PROBLEM_CODES as readonly string[]).includes(code)
    ? `resources.importWizard.problem.${code}`
    : "resources.importWizard.problem.unknown";
}

/** i18n key of one progress stage code (whitelisted). */
export function stageKey(stage: string): string {
  return (STAGE_CODES as readonly string[]).includes(stage)
    ? `resources.importWizard.stage.${stage}`
    : "resources.importWizard.stage.working";
}

/** Clamp + round an event percentage for the progress bar. */
export function progressPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/** Human size for the step-2 summary ("1.4 MB"). Binary units, one
 *  decimal from KB up — file sizes are familiar in that shape. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
