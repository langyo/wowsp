/**
 * Tech-tree research-link hover cards + hit-area geometry.
 *
 * Hovering a ship→ship connector in the tech tree opens the global tooltip
 * with the research XP the LOWER ship costs. The number comes from the
 * realm's bundled upgrade chain (ShipUpgradeInfo costXP): the lower ship's
 * own `research.xp`, with the unlocker's `next[xpShip]` record as the
 * fallback — WG and Lesta are separate bundles, so the active realm decides.
 * The future "with required modules" total (`next.xpWithModules`) renders as
 * a second row the moment a module-economy source fills it; it is null in
 * today's bundles and a null row is never faked.
 *
 * Two edge shapes are special:
 *   - a research-free link (supership X → XI: costXP 0) still shows a card,
 *     but its value is the localized "no research XP" text, not a literal 0;
 *   - a fork connector's hit area is only its DISTINCT part — the horizontal
 *     jog plus the drop into the fork child. The shared pre-fork stub
 *     overlaps the parent's straight continuation, so a hover there must
 *     resolve to that continuation's tooltip, never to the fork child's (the
 *     view renders the straight-continuation hits above the fork hits).
 *
 * Everything here is pure (no DOM): the view measures the rects and passes
 * them in, and the unit tests pin the card JSON and the hit-path strings.
 */
import { t } from "@/i18n";
import { tierToRoman } from "@wowsp/holo";

import { resolveNationFlag } from "@/utils/nationFlags";
import { nextResearch, researchOf } from "@/utils/shipUpgradeChain";
import { techTreeNode, type TechTreeRealm } from "@/utils/techTreeData";

/** Resolved research economy of one ship→ship link (the tooltip's data). */
export interface TreeLinkResearch {
  /** XP to research the LOWER ship — its own ShipUpgradeInfo costXP. Zero
   *  for research-free links (superships), never negative. */
  xp: number;
  /** Ship XP + required-module XP; null until a module-economy source lands
   *  (the bundled chains already carry the field, so only the extractor
   *  changes when that source appears). */
  xpWithModules: number | null;
}

/**
 * Resolve the research XP of one ship→ship link in a realm.
 *
 * The lower ship's own `research.xp` is the primary source — that is the
 * in-game cost the user reads. The unlocker's `next[xpShip]` record (the
 * minimal-case value the bundle comments name) is the fallback, so a tree
 * link still prices when only one side carries its chain record. Only when
 * both sources are absent does the link resolve to null: the caller must
 * then emit no hit path at all, because a hover target that opens nothing
 * must not exist.
 */
export function treeLinkResearch(
  fromShipId: number,
  toShipId: number,
  realm: TechTreeRealm = "wg",
): TreeLinkResearch | null {
  const target = researchOf(toShipId, realm);
  const next = nextResearch(fromShipId, toShipId, realm);
  const xp = target?.xp ?? next?.xpShip;
  if (xp == null) return null;
  return { xp, xpWithModules: next?.xpWithModules ?? null };
}

/** Per-call display overrides for {@link treeLinkHintCard}. */
export interface TreeLinkHintOptions {
  /** Display name of the researched (LOWER) ship — the view resolves the
   *  localized encyclopedia name, which wins over the tree node's working
   *  name (an IDS_* loc key on the WG side). */
  toName?: string;
}

/** Row value text: grouped like every other big number in the app, with the
 *  localized explanation standing in for a research-free (0 XP) link. */
function xpText(xp: number): string {
  return xp === 0 ? t("ships.techTree.linkResearchNone") : xp.toLocaleString();
}

/**
 * Build the `data-hint-card` JSON a connector tooltip carries, or null when
 * the realm's chain bundle cannot price the link (or the lower ship is not
 * researchable) — the view emits no hit path for a null card.
 *
 * The card reuses the ⓘ link cards' shape: title = lower ship, badge = tier,
 * subtitle = ship type with the nation flag, then one XP row ("with required
 * modules" only when the bundle actually carries it — never faked).
 */
export function treeLinkHintCard(
  fromShipId: number,
  toShipId: number,
  realm: TechTreeRealm = "wg",
  opts: TreeLinkHintOptions = {},
): string | null {
  const node = techTreeNode(toShipId, realm);
  // Premium/special hulls can hang off a tree node as side leaves in the
  // renderer's data model, but they are bought, not researched (their
  // GameParams costXP is a research-free sentinel), so they must not claim
  // a research tooltip.
  if (!node || node.isPremium || node.isSpecial) return null;
  const research = treeLinkResearch(fromShipId, toShipId, realm);
  if (!research) return null;

  const rows: { label: string; value: string }[] = [
    { label: t("ships.techTree.linkResearchXp"), value: xpText(research.xp) },
  ];
  if (research.xpWithModules !== null) {
    rows.push({
      label: t("ships.techTree.linkResearchWithModules"),
      value: xpText(research.xpWithModules),
    });
  }

  const flagUrl = resolveNationFlag(node.nation, "flag");
  return JSON.stringify({
    title: opts.toName ?? node.name,
    badge: tierToRoman(node.tier),
    subtitle: t(`ships.type.${node.type}`),
    ...(flagUrl ? { subtitleFlagUrl: flagUrl } : {}),
    rows,
  });
}

// ── Hit-area geometry ───────────────────────────────────────────────────

/** Vertical fraction of the fork connector's parent→child gap at which the
 *  run jogs sideways — where the shared pre-fork stub ends. */
export const FORK_JOG_FRACTION = 0.45;

/** SVG y of a fork connector's horizontal jog. The visible path, its ⓘ
 *  anchor and the hit path all derive their height from this one place, so
 *  they can never drift apart. */
export function forkJogY(parentBottomY: number, childTopY: number): number {
  return parentBottomY + (childTopY - parentBottomY) * FORK_JOG_FRACTION;
}

/**
 * Hit-path `d` for a fork connector: ONLY the distinct post-fork part — the
 * horizontal jog from the parent's centre line plus the drop into the fork
 * child.
 *
 * The shared stub (parent bottom → jog) is deliberately excluded: both the
 * parent's straight continuation and the fork jog leave the same parent
 * point, so that stub is ambiguous. The view also paints the straight
 * continuation's hit paths above the fork ones, which makes the stub always
 * resolve to the continuation even where the two wide strokes overlap.
 */
export function forkLinkHitPath(
  parentCenterX: number,
  parentBottomY: number,
  childCenterX: number,
  childTopY: number,
): string {
  return `M ${parentCenterX} ${forkJogY(parentBottomY, childTopY)} H ${childCenterX} V ${childTopY}`;
}
