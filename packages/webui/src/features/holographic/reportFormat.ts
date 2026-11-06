/**
 * reportFormat — the AI report's shared formatters and category ink.
 *
 * Presentation-neutral helpers used by the panel header, the player picker,
 * the editor timeline and their tests. Split out of StaticReportPanel so the
 * timeline component and the panel can both import them WITHOUT a circular
 * module edge.
 */
import { t as i18nT } from "@/i18n";
import type { StaticCoverage, StaticMoment } from "@/api";

/** Percent face (0.873 → "87"). */
export const pct = (v: number): string => Math.round(v * 100).toString();

/** Compact damage/HP rendering (84.2k / 1.31M). Exported for vitest. */
export function formatHp(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toString();
}

/** Move-sector → relative bearing label ("+45°"; 16 = held). Vitest. */
export function sectorLabel(sector: number): string {
  if (sector === 16) return i18nT("replay.report.held");
  const deg = Math.round((sector * 22.5 + 360) % 360);
  return `${deg}°`;
}

/** mm:ss battle clock (the timeline's ruler and keyframe heads). Vitest. */
export function formatClock(tSec: number): string {
  const total = Math.max(0, Math.floor(tSec));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/** Coverage badge class: full / partial / none. Exported for vitest. */
export function coverageClass(c: { samples: number; completeness: number }): string {
  if (c.samples === 0) return "none";
  return c.completeness > 0.9 ? "full" : "partial";
}

/** Category → the AppTag tone (and marker class) it paints — one table so
 *  the keyframe glyph, the legend, the tooltip badge and the callout card
 *  can never disagree. */
export const CATEGORY_TONE: Record<
  StaticMoment["category"],
  { tone: string; tag: "success" | "danger" | "warning" | "info" }
> = {
  damageRealized: { tone: "good", tag: "success" },
  missedOpportunity: { tone: "bad", tag: "danger" },
  weakWindow: { tone: "bad", tag: "danger" },
  forcedShot: { tone: "warn", tag: "warning" },
  strongWindow: { tone: "ok", tag: "info" },
};

/** Marker/callout tone class of one moment category. */
export function categoryTone(category: StaticMoment["category"]): string {
  return CATEGORY_TONE[category].tone;
}

/** Localized category caption ("伤害兑现"). */
export function categoryLabel(category: StaticMoment["category"]): string {
  return i18nT(`replay.report.cat_${category}`);
}

/** The gapSegments of one roster row's coverage (empty when absent). */
export function coverageGaps(
  coverage: StaticCoverage | undefined,
): [number, number][] {
  return coverage?.gapSegments ?? [];
}
