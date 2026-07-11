/** Winrate color tiers — mirrors ApeRadar / competitive WoWS community convention.
 *  Red < 47% → yellow 47-50% → green 50-55% → purple > 55%. */

export type WinrateTier = "red" | "yellow" | "green" | "purple";

export function winrateTier(wr: number | null | undefined): WinrateTier {
  if (wr == null) return "red";
  if (wr >= 55) return "purple";
  if (wr >= 50) return "green";
  if (wr >= 47) return "yellow";
  return "red";
}

export function winrateColor(wr: number | null | undefined): string {
  switch (winrateTier(wr)) {
    case "purple": return "rgb(168 85 247)";
    case "green": return "rgb(71 227 165)";
    case "yellow": return "rgb(230 170 50)";
    case "red": return "rgb(220 80 80)";
  }
}

export function prTier(pr: number | null | undefined): { label: string; color: string } {
  if (pr == null) return { label: "—", color: "rgb(150 160 175)" };
  if (pr >= 2100) return { label: "Unicum", color: "rgb(168 85 247)" };
  if (pr >= 1700) return { label: "Great", color: "rgb(71 227 165)" };
  if (pr >= 1200) return { label: "Good", color: "rgb(71 227 165)" };
  if (pr >= 900) return { label: "Average", color: "rgb(230 170 50)" };
  if (pr >= 600) return { label: "Below Avg", color: "rgb(230 170 50)" };
  return { label: "Needs Work", color: "rgb(220 80 80)" };
}
