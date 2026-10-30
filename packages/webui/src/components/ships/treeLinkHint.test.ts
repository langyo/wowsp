/**
 * Tests for the tech-tree connector research-XP tooltip:
 *
 *   - realm resolution — the lower ship's own costXP from the ACTIVE realm's
 *     bundled upgrade chain (WG vs Lesta are separate economies);
 *   - the research-free supership edge (costXP 0) renders the localized
 *     "no research XP" text, never a literal 0;
 *   - a link with no chain data resolves to null, so the view emits NO hit
 *     path (a hover target that opens nothing must not exist);
 *   - the fork hit area: only the distinct post-fork jog + drop is hoverable,
 *     the shared pre-fork stub (the straight continuation's line) is not;
 *   - the "with required modules" row appears only when the bundle carries a
 *     value: absent until a server price-catalog capture is applied, then the
 *     card grows a second row (the tests assert both states by reading the
 *     bundle rather than pinning one).
 *
 * Numeric XP is asserted only RELATIONALLY against the accessor (same rule as
 * shipUpgradeChain.test.ts): a future rebalance regenerates the bundles and
 * must not invalidate this test. Real ids are pinned from the current WG build
 * 13357625 / Lesta build 8867689.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { hintCardFrom } from "@/composables/globalTooltip";
import { initLocaleMessages, t } from "@/i18n";
import { nextResearch, researchOf } from "@/utils/shipUpgradeChain";
import { allTechTreeNodes, techTreeNode } from "@/utils/techTreeData";

import {
  FORK_JOG_FRACTION,
  forkJogY,
  forkLinkHitPath,
  treeLinkHintCard,
  treeLinkResearch,
} from "./treeLinkHint";

// The future "with required modules" source does not exist yet — mock the
// accessor's optional field so the second-row branch stays covered without
// ever faking data in the shipped bundle.
vi.mock("@/utils/shipUpgradeChain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/shipUpgradeChain")>();
  return { ...actual, nextResearch: vi.fn(actual.nextResearch) };
});

/** Myōkō (PJSC008), tier-VII IJN cruiser — present in both realm trees. */
const MYOKO = 4286494416;
/** Mogami (PJSC009), tier-VIII IJN cruiser — Myōkō's only successor. */
const MOGAMI = 4285445840;
/** Minsk (PRSD207), the tier-VII USSR destroyer — a fork parent in both realms. */
const MINSK = 4077794768;
/** Pr.48/Kiev (PRSD308) — the WG straight-continuation child of Minsk. */
const PR_48 = 3971888592;
/** Pr.30 (PRSD208) — the WG fork child of Minsk (second branch line). */
const PR_30 = 4076746192;
/** Pr.218 (PRSD218) — the Lesta fork child on the same Minsk node. */
const PR_218 = 4066260432;
/** Montana (PASB017), tier X — the supership link's unlocker. */
const MONTANA = 4277090288;
/** Maine (PASB111), tier XI — the research-free supership itself. */
const MAINE = 4178524144;
/** New Jersey (PASB310) — a Lesta-only line; WG has neither node nor bundle. */
const LESTA_ONLY = 3969857520;
/** Its Lesta successor (PASB211). */
const LESTA_NEXT = 4073666544;
/** No tree node, no chain record in either realm. */
const MISSING_A = 123456789;
const MISSING_B = 987654321;

const mockedNextResearch = vi.mocked(nextResearch);

beforeAll(async () => {
  await initLocaleMessages();
});

describe("treeLinkResearch", () => {
  it("reads the LOWER ship's own costXP from the active realm's bundle", () => {
    for (const realm of ["wg", "lesta"] as const) {
      const research = treeLinkResearch(MYOKO, MOGAMI, realm);
      expect(research, realm).not.toBeNull();
      expect(research!.xp, realm).toBe(researchOf(MOGAMI, realm)!.xp);
      // The "with required modules" total mirrors the bundle: absent until a
      // server price-catalog capture is applied, then a positive total.
      const bundleTotal = nextResearch(MYOKO, MOGAMI, realm)?.xpWithModules ?? null;
      expect(research!.xpWithModules, realm).toBe(bundleTotal);
      if (research!.xpWithModules !== null) {
        expect(research!.xpWithModules, realm).toBeGreaterThanOrEqual(research!.xp);
      }
    }
  });

  it("resolves the realm BEFORE the pair: shared ships carry two economies", () => {
    // Minsk -> Pr.48 exists in both bundles, each with its own client's cost.
    const wg = treeLinkResearch(MINSK, PR_48, "wg");
    const lesta = treeLinkResearch(MINSK, PR_48, "lesta");
    expect(wg!.xp).toBe(researchOf(PR_48, "wg")!.xp);
    expect(lesta!.xp).toBe(researchOf(PR_48, "lesta")!.xp);
    // Each realm resolves its own research record (the accessors above prove
    // the split; the Lesta-only line case below proves realm SELECTION).
  });

  it("falls back to the unlocker's next[xpShip] when the lower record is absent", () => {
    // The generic accessor contract promises both sources agree, so a real
    // edge always resolves; exercise the fallback without touching the bundle
    // by making the pair lookup miss once.
    mockedNextResearch.mockReturnValueOnce(null);
    expect(treeLinkResearch(MYOKO, MOGAMI, "wg")).toEqual({
      xp: researchOf(MOGAMI, "wg")!.xp,
      xpWithModules: null,
    });
  });

  it("returns null when neither side of the pair carries a chain record", () => {
    expect(treeLinkResearch(MISSING_A, MISSING_B, "wg")).toBeNull();
  });
});

describe("treeLinkHintCard", () => {
  it("builds the shared hint-card shape (one XP row, plus the capture row when filled)", () => {
    const raw = treeLinkHintCard(MYOKO, MOGAMI, "wg", { toName: "最上" });
    expect(raw).not.toBeNull();
    const card = hintCardFrom(JSON.parse(raw!));
    expect(card).not.toBeNull();
    expect(card!.title).toBe("最上");
    // Tech-tree tier numerals are roman.
    expect(card!.badge).toBe("VIII");
    expect(card!.subtitle).toBe(t("ships.type.Cruiser"));
    expect(card!.subtitleFlagUrl).toContain("images/nations_small/japan.webp");
    // The capture may have filled the "with required modules" total — the
    // row set is state-aware, never assuming the unfilled bundle.
    const bundleTotal = nextResearch(MYOKO, MOGAMI, "wg")?.xpWithModules ?? null;
    expect(card!.rows).toHaveLength(bundleTotal === null ? 1 : 2);
    expect(card!.rows![0]).toEqual({
      label: t("ships.techTree.linkResearchXp"),
      value: researchOf(MOGAMI, "wg")!.xp.toLocaleString(),
    });
    if (bundleTotal !== null) {
      expect(card!.rows![1]).toEqual({
        label: t("ships.techTree.linkResearchWithModules"),
        value: bundleTotal.toLocaleString(),
      });
    }
    // The label really resolved (not an echoed missing-i18n key).
    expect(card!.rows![0].label).not.toContain("ships.techTree");
  });

  it("falls back to the tree node's working name when the view passes none", () => {
    const card = hintCardFrom(
      JSON.parse(treeLinkHintCard(MYOKO, MOGAMI, "wg")!),
    )!;
    expect(card.title).toBe(techTreeNode(MOGAMI, "wg")!.name);
    // Lesta's nodes carry a friendly working name ("Mogami 1935").
    expect(techTreeNode(MOGAMI, "lesta")!.name).not.toMatch(/^IDS_/);
  });

  it("renders the localized no-research text for a research-free supership link", () => {
    for (const realm of ["wg", "lesta"] as const) {
      expect(researchOf(MAINE, realm)!.xp, realm).toBe(0);
      const card = hintCardFrom(
        JSON.parse(treeLinkHintCard(MONTANA, MAINE, realm, { toName: "Maine" })!),
      )!;
      expect(card.rows![0].label).toBe(t("ships.techTree.linkResearchXp"));
      expect(card.rows![0].value).toBe(t("ships.techTree.linkResearchNone"));
      // Never the misleading literal zero, and never a raw key echo.
      expect(card.rows![0].value).not.toBe("0");
      expect(card.rows![0].value).not.toContain("ships.techTree");
    }
  });

  it("returns null for a pair the realm's bundle cannot price", () => {
    expect(treeLinkHintCard(MISSING_A, MISSING_B, "wg")).toBeNull();
    // A Lesta-only line is absent from the WG tree AND the WG bundle.
    expect(techTreeNode(LESTA_ONLY, "wg")).toBeNull();
    expect(treeLinkHintCard(LESTA_ONLY, LESTA_NEXT, "wg")).toBeNull();
    // ... and prices normally on its own realm.
    expect(treeLinkHintCard(LESTA_ONLY, LESTA_NEXT, "lesta")).not.toBeNull();
  });

  it("prices both children of a fork parent (the exclusion is geometric only)", () => {
    // Both branches leave Minsk, so the DATA prices both; only the shared
    // pre-fork stub is excluded from the hover geometry below.
    expect(treeLinkHintCard(MINSK, PR_48, "wg")).not.toBeNull();
    expect(treeLinkHintCard(MINSK, PR_30, "wg")).not.toBeNull();
    expect(treeLinkHintCard(MINSK, PR_48, "lesta")).not.toBeNull();
    expect(treeLinkHintCard(MINSK, PR_218, "lesta")).not.toBeNull();
  });

  it("adds the 'with required modules' row the moment the bundle carries it", () => {
    mockedNextResearch.mockReturnValueOnce({
      index: "PJSC009",
      xpShip: researchOf(MOGAMI, "wg")!.xp,
      xpWithModules: 207_000,
      requiredModules: ["PJUH000_HULL_TOP"],
    });
    const card = hintCardFrom(
      JSON.parse(treeLinkHintCard(MYOKO, MOGAMI, "wg", { toName: "Mogami" })!),
    )!;
    expect(card.rows).toHaveLength(2);
    expect(card.rows![1]).toEqual({
      label: t("ships.techTree.linkResearchWithModules"),
      value: (207_000).toLocaleString(),
    });
  });
});

describe("fork hit-area geometry", () => {
  // One fork connector between two 118px cards one tier apart:
  // parent centre line x=69, parent bottom y=130, child centre x=209,
  // child top y=270 (the gap used by the renderer is CARD_H+GAP_Y=126 for a
  // one-tier drop; round numbers keep the expectation readable).
  const P_CX = 69;
  const P_CY = 130;
  const C_CX = 209;
  const C_CY = 270;

  it("pins the jog height fraction shared by the visible path and the hit area", () => {
    expect(FORK_JOG_FRACTION).toBe(0.45);
    expect(forkJogY(0, 100)).toBe(45);
    expect(forkJogY(P_CY, C_CY)).toBe(193); // 130 + 140 * 0.45
  });

  it("starts the fork hit area at the jog, never at the parent's shared stub", () => {
    const hit = forkLinkHitPath(P_CX, P_CY, C_CX, C_CY);
    expect(hit).toBe("M 69 193 H 209 V 270");
    // The vertical shared stub (parent bottom -> jog) is NOT hoverable as the
    // fork child: the continuation's own hit path owns it.
    expect(hit).not.toContain(`M ${P_CX} ${P_CY}`);
    expect(hit).not.toContain(`V ${P_CY}`);
    expect(hit.startsWith(`M ${P_CX} ${forkJogY(P_CY, C_CY)}`)).toBe(true);
    // Contrast: the visible fork path (and the straight continuation's full
    // line) DOES start at the parent bottom — the visible stub is shared.
    expect(`M ${P_CX} ${P_CY} V ${forkJogY(P_CY, C_CY)} H ${C_CX} V ${C_CY}`).not.toBe(hit);
  });

  it("uses the same jog height for a tier-skipping fork child", () => {
    // A branch child two tiers down (the Pan-Am BB / Pan-Europe BB forks):
    // the jog still sits at 45% of the gap, so the stub length scales.
    expect(forkJogY(130, 396)).toBe(130 + 266 * FORK_JOG_FRACTION);
    expect(forkLinkHitPath(P_CX, 130, C_CX, 396)).toBe(
      `M ${P_CX} ${130 + 266 * FORK_JOG_FRACTION} H ${C_CX} V 396`,
    );
  });
});

describe("research edges", () => {
  it("prices every edge both tree realms draw", () => {
    for (const realm of ["wg", "lesta"] as const) {
      const tree = allTechTreeNodes(realm);
      let edges = 0;
      for (const node of Object.values(tree)) {
        for (const childId of node.nextShips) {
          const child = tree[String(childId)];
          if (!child) continue;
          edges += 1;
          expect(
            treeLinkHintCard(node.shipId, childId, realm),
            `${realm} ${node.index} -> ${child.index}`,
          ).not.toBeNull();
        }
      }
      // Both bundles carry a real research graph (not a smoke-sized stub).
      expect(edges, realm).toBeGreaterThan(100);
    }
  });
});
