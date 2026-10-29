/**
 * Display formatters shared by the /erp views — the same presentations
 * the retired embedded page rendered (zh-CN timestamps, binary byte
 * units, the wanted-rule dimension line).
 */

import type { WantedRule } from "./types";

/** zh-CN locale timestamp (`hour12: false`), empty for missing values. */
export function fmtTime(v: number | string | null | undefined): string {
  if (!v) return "";
  return new Date(v).toLocaleString("zh-CN", { hour12: false });
}

/** Binary byte units (B → TB), one decimal above the base unit. */
export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[Math.min(i, 4)]}`;
}

/** The one-line dimension summary of a wanted rule — the retired page's
 *  `dimsOf` (图/模式/服/舰系/等级/指定舰/人数/机器人/客户端版本). */
export function dimsOf(rule: WantedRule): string {
  const parts: string[] = [];
  if (rule.maps?.length) parts.push(`图 ${rule.maps.join(",")}`);
  if (rule.modes?.length) parts.push(`模式 ${rule.modes.join(",")}`);
  if (rule.realms?.length) parts.push(rule.realms.map((r) => r.toUpperCase()).join("/"));
  if (rule.shipClasses?.length) parts.push(rule.shipClasses.join("/"));
  if (rule.tiers?.length) parts.push(`T${rule.tiers.join(",")}`);
  if (rule.shipIds?.length) parts.push(`指定舰 ${rule.shipIds.length}`);
  if (rule.playerCountMin || rule.playerCountMax) {
    parts.push(`人数 ${rule.playerCountMin || 1}-${rule.playerCountMax ?? "∞"}`);
  }
  if (rule.botMax != null) parts.push(`机器人≤${rule.botMax}`);
  if (rule.teamWinRateMin != null) parts.push(`双方胜率≥${rule.teamWinRateMin}%`);
  if (rule.clientVersionMin) parts.push(`版本≥${rule.clientVersionMin}`);
  return parts.join(" · ") || "不限";
}

/** The template the wanted editor seeds an EMPTY ruleset with — the same
 *  document the retired page offered (server-stamped fields included so
 *  the strict validator accepts it verbatim). */
export const WANTED_TEMPLATE = JSON.stringify(
  {
    rulesetVersion: 1,
    updatedAt: new Date().toISOString(),
    rules: [
      {
        id: "example-rule",
        note: "示例：按需删改；空数组 = 该维度不限",
        maps: [],
        modes: [],
        scenarios: [],
        realms: [],
        shipClasses: [],
        shipIds: [],
        tiers: [],
        playerCountMin: null,
        playerCountMax: null,
        botMax: 0,
        clientVersionMin: "",
        maxCount: 100,
      },
    ],
  },
  null,
  2,
);
