/**
 * Post-battle head mode resolution — the pure rule behind the results
 * panel's mode pill (label + colour) and the share shot's mode line.
 *
 * The panel receives the battle identity as bare descriptor fields
 * (`PostBattleHead`) plus two facts its callers already resolved:
 *   - the roster's SINGLE-TEAM shape (`props.roster`: listed players, no
 *     enemy-side entry) — inside the pve family that shape is a story
 *     operation (行动), never plain co-op (real co-op always fields the
 *     enemy bot team). It is the same argument every other mode surface
 *     forwards into `modeKey` (`hasSingleTeamRoster`);
 *   - the parent's operation verdict (`props.operation`, ReplayView's
 *     `isOperation`): the descriptor classifier's verdict OR the
 *     decode-time spawn-symmetry probe's promotion. When it is TRUE for a
 *     battle whose descriptor still yields `"cooperative"` (the probe
 *     promoted a two-sided story battle), the head pill must take the
 *     verdict as a one-way promotion or it would disagree with the viewer
 *     header right above the modal.
 *
 * Extracted as a pure helper (rather than inlined in the component) so the
 * DOM pill and the two share models resolve through ONE tested rule, and so
 * the panel's rendering code stays free of classifier plumbing.
 */
import { modeKey } from "@/utils/modeColors";

/** The layered descriptor identity the post-battle head carries — a
 *  structural subset of `PostBattleHead` (declared here so this module
 *  never imports the component). */
export interface PostBattleModeIdentity {
  matchGroup?: string | null;
  scenario?: string | null;
  eventType?: string | null;
  botCount?: number | null;
  scriptedUnitCount?: number | null;
}

/**
 * Canonical mode key of a post-battle head:
 *   1. the shared descriptor classifier, fed the single-team roster shape
 *      (`singleTeamRoster`) — the exact rule the replay cards, viewer
 *      header and live panels use;
 *   2. a ONE-WAY operation promotion from `operation`: when the parent's
 *      verdict says operation and the descriptor still yields
 *      `"cooperative"` (only the decode-time probe can produce that), the
 *      key becomes `"operation"`. Never the other way round — a verdict
 *      may only add the story-operation label the descriptor missed.
 *
 * Returns the classifier's raw key otherwise (empty string when the
 * descriptor carries no `matchGroup`/identity at all — callers render no
 * pill then).
 */
export function postBattleModeKey(
  head: PostBattleModeIdentity | null | undefined,
  singleTeamRoster: boolean | null,
  operation: boolean,
): string {
  const key = modeKey(
    head?.matchGroup,
    head?.scenario,
    head?.eventType,
    head?.botCount ?? 0,
    head?.scriptedUnitCount ?? 0,
    singleTeamRoster,
  );
  // One-way: the decode-time probe only ever promotes co-op -> operation,
  // so the verdict may fix a plain-co-op descriptor key and nothing else.
  if (operation && key === "cooperative") return "operation";
  return key;
}
