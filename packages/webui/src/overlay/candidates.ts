/** Candidate-range chip faces: fold the bot members out.
 *
 *  A mid-battle candidate RANGE lists every roster member the row could
 *  still be (inferredOrder.ts's provable contiguous ranges). Rendering
 *  each member's face verbatim turned those chips into "bot / bot / — /
 *  bot": the game's own Tab table already marks its bot rows, so the
 *  repeated "bot" faces carried no information while stretching the chip
 *  wide enough to pin itself over the screen's left HUD (chipFit's
 *  terminal clamp). Bots never carry stats, so the honest compression
 *  keeps the human faces and folds every AI member into ONE count-less
 *  muted badge — "43.2% + bot" says all a Tab-glance acts on, at a
 *  fraction of the width. */

import { AI_NAME } from "@/utils/aiNames";

export interface CollapsedCandidates {
  /** Roster members that can carry stats (non-AI), in range order. */
  humans: string[];
  /** How many AI members the range folds away. */
  botCount: number;
}

/** Split one candidate range into its human faces and its folded bot
 *  count. Order within `humans` preserves the range's Tab-key order, so
 *  the slash-joined faces keep listing candidates the way the chip always
 *  did — only the bot faces collapse. */
export function collapseCandidateBots(members: string[]): CollapsedCandidates {
  const humans: string[] = [];
  let botCount = 0;
  for (const m of members) {
    if (AI_NAME.test(m)) botCount++;
    else humans.push(m);
  }
  return { humans, botCount };
}
