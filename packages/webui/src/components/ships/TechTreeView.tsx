import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";

import { t } from "@/i18n";
import { resolveShipImage } from "@/utils/shipImages";
import {
  nationCrossLinks,
  nationTree,
  techTreeBranchHasContent,
  techTreeBranchInfo,
  techTreeCardIcon,
  techTreeFeatChips,
  techTreeCategoryIcon,
  techTreeFeatureCategoryText,
  techTreeFeatureNote,
  techTreeFeatureTitle,
  techTreeNode,
  techTreeShipBranch,
  treeNextShipIds,
  type TechTreeNode,
  type TechTreeRealm,
} from "@/utils/techTreeData";
import { useLanguage } from "@/i18n/useLanguage";
import { shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { archetypeKey } from "@/utils/archetypeLabels";
import { resolveNationFlag } from "@/utils/nationFlags";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import { tierToRoman } from "@wowsp/holo";
import { GitBranch, Info } from "@lucide/vue";
import { AssetImage } from "@/components/base/AssetImage";
import BattleIcon from "@/components/base/BattleIcon";
import { recordShipImageFailure } from "@/utils/shipImageFailures";
import type { ShipInfo } from "@/api";
import { forkJogY, forkLinkHitPath, treeLinkHintCard } from "./treeLinkHint";
import "./TechTreeView.scss";

/**
 * Vertical tech-tree.
 *
 * Layout (matching the in-game port tech-tree panel):
 *   - Nation rail on the left (handled by ShipsView).
 *   - Ship-type sections laid out left-to-right in a horizontal row, all
 *     sharing one tier ladder: row N is tier (topTier + N) in every section,
 *     so a branch that starts mid-tree (Pan-Am battleships at VIII) sits on
 *     the same row as the tier-VIII ship of the neighboring lines. Section
 *     headers stick to the top of the scroll container while scrolling.
 *   - Within a section, each research branch is a column. Cards are
 *     absolutely positioned so tiers align horizontally across columns.
 *   - Fork branches start their own column at the fork tier; shared
 *     prefix ships appear only in the first/main column, never duplicated.
 *   - SVG connectors draw vertical links within a column, diagonal fork
 *     connectors from the parent ship to the fork column's first ship, and
 *     cross-type research links straight across the type-section gap (the
 *     cruiser→battleship, destroyer→carrier hand-offs the in-game tree also
 *     bridges).
 *   - The cards stay plain portraits — all branch features live inside the
 *     ⓘ popup, whose texts are the client's own localization (official
 *     zh-Hans + ru-RU, curated en-US), bundled by
 *     scripts/extract/build_branch_features.py.
 *   - Hovering a ship→ship connector opens the research-XP tooltip: the
 *     lower ship's ShipUpgradeInfo costXP for the active realm (WG/Lesta),
 *     from the bundled upgrade chains. Every connector is a hover target
 *     EXCEPT a fork connector's shared pre-fork stub — that stub also
 *     carries the parent's straight continuation, so it stays with the
 *     continuation's tooltip; the fork chain is hoverable from its
 *     distinct jog onward (geometry in treeLinkHint.ts).
 *   - Two kinds of links carry a small ⓘ button, mirroring the in-game
 *     tree: the cross-type research hand-offs carry the link info card (the
 *     client's ShipCrossResearchInfo: what the link changes — type hand-off,
 *     parallel branches, archetype hand-off), and every branch run's first
 *     ship carries the game's "warship characteristics" popup — the branch's
 *     start—end range, feature icons and per-category feature groups,
 *     decoded from the client's encrypted BranchesSettings module. Both
 *     hang on the incoming connector of the link's far ship, so a run that
 *     starts at its section root has no ⓘ — exactly the in-game placement.
 */
export default defineComponent({
  name: "TechTreeView",
  props: {
    nation: { type: String, required: true },
    /** Branch source: the WG reference topology or the Lesta client's own. */
    realm: { type: String as () => TechTreeRealm, required: true },
    byId: { type: Object as () => Map<number, ShipInfo>, required: true },
  },
  emits: { open: (_ship: ShipInfo) => true },
  setup(props, { emit }) {
    const tree = computed(() => nationTree(props.nation, props.realm));
    const crossLinks = computed(() => nationCrossLinks(props.nation, props.realm));
    const hasTree = computed(() => tree.value.some((g) => g.branches.length > 0));

    // Layout dimensions
    const COL_W = 118;
    const CARD_H = 110;
    const GAP_X = 22;   // horizontal gap between branch columns
    const GAP_Y = 16;   // vertical gap between tier rows
    const PAD = 14;     // padding inside each type section canvas

    // ── Build deduplicated positioned cells per type section ─────────────
    interface PosCell {
      shipId: number;
      ship: ShipInfo | undefined;
      node: TechTreeNode;
      tier: number;
      branchIdx: number;
      archetype: string | null;
      /** shipId of the parent in this branch (null for first ship). */
      parentId: number | null;
      /** If this cell is the start of a fork branch, the ship it forks from. */
      forkFromId: number | null;
      /** If this ship is a fork point (spawns multiple branches), the archetypes. */
      forkArchetypes: string[];
    }

    interface TypeSection {
      type: string;
      cells: PosCell[];
      numBranches: number;
      minTier: number;
      maxTier: number;
    }

    const sections = computed<TypeSection[]>(() => {
      return tree.value.map((group) => {
        const claimed = new Set<number>(); // shipIds already placed in an earlier column
        const cells: PosCell[] = [];
        let minTier = 11;
        let maxTier = 1;

        group.branches.forEach((branch, bi) => {
          // Find the first ship in this branch not yet claimed by earlier branches.
          let startIdx = 0;
          let forkFrom: number | null = null;
          while (startIdx < branch.ships.length && claimed.has(branch.ships[startIdx])) {
            forkFrom = branch.ships[startIdx];
            startIdx++;
          }
          if (startIdx >= branch.ships.length) return; // all ships already in another column

          for (let i = startIdx; i < branch.ships.length; i++) {
            const sid = branch.ships[i];
            const node = techTreeNode(sid, props.realm);
            if (!node) continue;
            const ship = props.byId.get(sid);
            if (node.tier < minTier) minTier = node.tier;
            if (node.tier > maxTier) maxTier = node.tier;
            claimed.add(sid);

            const isFirstInCol = i === startIdx;
            cells.push({
              shipId: sid,
              ship,
              node,
              tier: node.tier,
              branchIdx: bi,
              archetype: i === branch.ships.length - 1 ? archetypeKey(node.archetype) : null,
              parentId: i > startIdx ? branch.ships[i - 1] : null,
              forkFromId: isFirstInCol ? forkFrom : null,
              forkArchetypes: [],
            });
          }
        });

        return {
          type: group.type,
          cells,
          numBranches: group.branches.length,
          minTier,
          maxTier,
        };
      }).filter((s) => s.cells.length > 0).map((sec) => {
        // Annotate fork points: ships that spawn other branches
        const forkParentArchetypes = new Map<number, string[]>();
        for (const c of sec.cells) {
          if (c.forkFromId != null && c.archetype) {
            if (!forkParentArchetypes.has(c.forkFromId)) {
              forkParentArchetypes.set(c.forkFromId, []);
            }
            forkParentArchetypes.get(c.forkFromId)!.push(c.archetype);
          }
        }
        return {
          ...sec,
          cells: sec.cells.map((c) => ({
            ...c,
            forkArchetypes: forkParentArchetypes.get(c.shipId) ?? [],
          })),
        };
      });
    });

    /** Tier of the topmost row, shared across every section of the nation:
        rows line up at the same tier in all type columns, so a line starting
        mid-tree (Pan-Am BBs at VIII) renders on the VIII row, not at the top. */
    const globalMinTier = computed(() => {
      const mins = sections.value.map((s) => s.minTier);
      return mins.length ? Math.min(...mins) : 1;
    });

    /**
     * Human ship name for a tree node. The committed tree data carries raw
     * location keys ('IDS_PASA020') for WG nodes, and the encyclopedia list
     * that normally overlays them is network-first — a phone with a slow or
     * unavailable WG API would otherwise render IDS keys everywhere. Order:
     * encyclopedia entry -> bundled ship_names.json -> the node's display
     * name, and a raw IDS key never reaches the UI (the node's index reads
     * as a ship name far better than 'IDS_PASA020').
     */
    const { dataLanguage } = useLanguage();
    function resolveShipName(shipId: number): string {
      const candidates = [
        props.byId.get(shipId)?.name,
        shipNameFromOfflineDb(shipId, dataLanguage.value) ?? undefined,
        techTreeNode(shipId, props.realm)?.name,
      ];
      for (const name of candidates) {
        if (name && !/^IDS_/.test(name)) return name;
      }
      const node = techTreeNode(shipId, props.realm);
      return node?.index || String(shipId);
    }
    function shipLabel(cell: PosCell): string {
      if (cell.ship?.name && !/^IDS_/.test(cell.ship.name)) return cell.ship.name;
      return resolveShipName(cell.shipId);
    }
    function labelOf(shipId: number): string {
      return resolveShipName(shipId);
    }

    /**
     * Hover-card JSON for one research link (the ⓘ the in-game tree puts on
     * cross-type research links): what the link leads to, plus a row per
     * change — the type hand-off, the parallel branch ships, the archetype
     * hand-off. Everything is pre-localized here; the global tooltip hook
     * only parses and renders.
     */
    function linkHintCard(parentNode: TechTreeNode, childNode: TechTreeNode): string {
      const rows: { label: string; value: string }[] = [];
      if (childNode.type !== parentNode.type) {
        rows.push({
          label: t("ships.techTree.linkTypeChange"),
          value: `${t(`ships.type.${parentNode.type}`)} → ${t(`ships.type.${childNode.type}`)}`,
        });
      }
      const others = treeNextShipIds(parentNode, props.realm)
        .filter((id) => id !== childNode.shipId)
        .map((id) => {
          const n = techTreeNode(id, props.realm);
          return n ? `${labelOf(id)} ${tierToRoman(n.tier)}` : String(id);
        });
      if (others.length > 0) {
        rows.push({ label: t("ships.techTree.linkBranches"), value: others.join(" / ") });
      }
      const fromArch = archetypeKey(parentNode.archetype);
      const toArch = archetypeKey(childNode.archetype);
      if (fromArch && toArch && fromArch !== toArch) {
        rows.push({
          label: t("ships.techTree.linkArchetype"),
          value: `${t(`ships.archetype.${fromArch}`)} → ${t(`ships.archetype.${toArch}`)}`,
        });
      }
      return JSON.stringify({
        title: labelOf(childNode.shipId),
        badge: tierToRoman(childNode.tier),
        subtitle: t(`ships.type.${childNode.type}`),
        subtitleFlagUrl: resolveNationFlag(childNode.nation, "flag"),
        rows,
      });
    }

    /**
     * Hover-card JSON for the branch-feature ⓘ (the popup the in-game tree
     * shows above each branch's first ship): the branch's run from its start
     * ship to its end ship plus one row per feature group. Texts are the
     * game's own BranchesSettings content, bundled with zh/en strings.
     */
    function branchSegmentCard(
      branchName: string,
      startNode: TechTreeNode,
      endNode: TechTreeNode,
    ): string {
      const info = techTreeBranchInfo(branchName, endNode.type);
      const rows = (info?.groups ?? [])
        .map(([category, feats]) => ({
          label: techTreeFeatureCategoryText(category),
          chips: techTreeFeatChips(feats),
          iconUrl: techTreeCategoryIcon(category) ?? undefined,
        }))
        .filter((row) => row.chips.length > 0);
      const icons = (info?.card ?? [])
        .map((k) => techTreeCardIcon(k))
        .filter((u): u is string => u !== null)
        .slice(0, 3);
      const startLabel = labelOf(startNode.shipId);
      const endLabel = labelOf(endNode.shipId);
      return JSON.stringify({
        title: techTreeFeatureTitle() || branchName,
        badge: tierToRoman(startNode.tier),
        subtitle: startLabel === endLabel ? startLabel : `${startLabel} — ${endLabel}`,
        icons,
        rows,
        note: techTreeFeatureNote(),
      });
    }

    /** The branch run's last ship: walk the column down while the branch
     *  name stays the same — that run is exactly one in-game branch. */
    function segmentEndNode(col: PosCell[], fromIdx: number, branchName: string): TechTreeNode {
      let end = col[fromIdx];
      for (let j = fromIdx + 1; j < col.length; j++) {
        if (techTreeShipBranch(col[j].shipId) !== branchName) break;
        end = col[j];
      }
      return end.node;
    }

    // ── SVG overlay measurement ──────────────────────────────────────────
    const containerRef = ref<HTMLElement | null>(null);
    interface DItem { key: string; d: string; cls: string; cx?: number; cy?: number }
    const drawItems = ref<DItem[]>([]);
    /** ⓘ buttons (branch-feature popups + cross-type link info), positioned
     *  by measure() next to the paths. */
    interface LinkIcon { key: string; x: number; y: number; card: string }
    const linkIcons = ref<LinkIcon[]>([]);
    /** Invisible wide hit strokes for the connector research-XP tooltips;
     *  same coordinate space as the visible paths, measured per run. */
    interface HitItem { key: string; d: string; card: string }
    const hitItems = ref<HitItem[]>([]);
    const svgSize = ref({ w: 0, h: 0 });
    let ro: ResizeObserver | null = null;

    interface Rect { x: number; y: number; w: number; h: number }

    function measure() {
      const root = containerRef.value;
      if (!root) return;
      const rootR = root.getBoundingClientRect();
      // The shell's interface-scale preference is a root CSS `zoom`, which
      // scales getBoundingClientRect away from the layout px the SVG's user
      // units live in — fold every rect back so lines land on cards at any
      // zoom level (1 is the common case, so this is a no-op by default).
      const zoom = Number(window.getComputedStyle(document.documentElement).zoom) || 1;
      const rel = (el: HTMLElement): Rect => {
        const r = el.getBoundingClientRect();
        return { x: (r.left - rootR.left) / zoom, y: (r.top - rootR.top) / zoom, w: r.width / zoom, h: r.height / zoom };
      };

      const out: DItem[] = [];
      const icons: LinkIcon[] = [];
      // Connector tooltip hit paths. Vertical/cross strokes land in `hits`
      // and render ABOVE the fork strokes (`forkHits`): at a fork parent the
      // shared pre-fork stub overlaps the straight continuation, and the
      // continuation must win that hover (the fork child's XP is ambiguous
      // there — see treeLinkHint.ts).
      const hits: HitItem[] = [];
      const forkHits: HitItem[] = [];
      /** The data-hint-card JSON for one ship→ship research connector, or
       *  null when the active realm's bundle cannot price it (then no hit
       *  path is emitted — a hover that shows nothing must not exist). */
      const connectorCard = (fromShipId: number, toShipId: number): string | null =>
        treeLinkHintCard(fromShipId, toShipId, props.realm, { toName: labelOf(toShipId) });
      const dotSet = new Set<string>();
      const dot = (key: string, cx: number, cy: number): void => {
        if (!dotSet.has(key)) {
          dotSet.add(key);
          out.push({ key, cx, cy, d: "", cls: "dot" });
        }
      };

      // One root-wide card rect map: cross-type connectors reach across
      // sections, so a per-section map would miss the far endpoint.
      const cardEls = new Map<number, Rect>();
      for (const sec of sections.value) {
        for (const c of sec.cells) {
          const el = root.querySelector(`[data-sid="${c.shipId}"]`) as HTMLElement | null;
          if (el) cardEls.set(c.shipId, rel(el));
        }
      }

      sections.value.forEach((sec) => {
        // Per-branch column cell lists, tier-ascending (cells were pushed in
        // chain order); shared with the ⓘ segment walks below.
        const cols: PosCell[][] = [];
        for (let bi = 0; bi < sec.numBranches; bi++) {
          cols.push(sec.cells.filter((c) => c.branchIdx === bi));
        }

        // Tracks: per-branch dashed vertical guide lines
        for (let bi = 0; bi < sec.numBranches; bi++) {
          const col = cols[bi];
          if (col.length < 2) continue;
          const first = cardEls.get(col[0].shipId);
          const last = cardEls.get(col[col.length - 1].shipId);
          if (first && last) {
            const cx = first.x + first.w / 2;
            out.push({ key: `trk-${sec.type}-${bi}`, d: `M ${cx} ${first.y + first.h / 2} L ${cx} ${last.y + last.h / 2}`, cls: "track" });
          }
        }

        // 1. Same-column vertical connectors (parentId in same branch)
        sec.cells.forEach((c) => {
          if (!c.parentId) return;
          const p = cardEls.get(c.parentId);
          const ch = cardEls.get(c.shipId);
          if (!p || !ch) return;
          const pCX = p.x + p.w / 2;
          const pCY = p.y + p.h;
          const cCX = ch.x + ch.w / 2;
          const cCY = ch.y;

          dot(`dot-${c.parentId}-out`, pCX, pCY);
          dot(`dot-${c.shipId}-in`, cCX, cCY);

          const connD = `M ${pCX} ${pCY} V ${cCY}`;
          out.push({ key: `v-${c.parentId}-${c.shipId}`, d: connD, cls: "conn" });
          // Hover target: a widened invisible stroke over the same line.
          // Cards and the ⓘ buttons sit in higher z bands, so they keep
          // their own pointer targets.
          const connCard = connectorCard(c.parentId, c.shipId);
          if (connCard) hits.push({ key: `hv-${c.parentId}-${c.shipId}`, d: connD, card: connCard });

          // ⓘ at branch-segment starts: the game hangs its characteristics
          // popup above the first ship of every branch run. Runs without
          // bundled feature content (no record in the client either) draw
          // nothing — an empty popup would be noise.
          const parentBranch = techTreeShipBranch(c.parentId);
          const childBranch = techTreeShipBranch(c.shipId);
          if (childBranch && parentBranch !== childBranch && techTreeBranchHasContent(childBranch, c.node.type)) {
            const col = cols[c.branchIdx] ?? [];
            const idx = col.findIndex((x) => x.shipId === c.shipId);
            icons.push({
              key: `i-${c.parentId}-${c.shipId}`,
              x: pCX,
              y: (pCY + cCY) / 2,
              card: branchSegmentCard(childBranch, c.node, segmentEndNode(col, idx, childBranch)),
            });
          }
        });

        // 2. Fork connectors: from forkFromId to first unique ship (right-angle path)
        sec.cells.forEach((c) => {
          if (!c.forkFromId) return;
          const p = cardEls.get(c.forkFromId);
          const ch = cardEls.get(c.shipId);
          if (!p || !ch) return;
          const pCX = p.x + p.w / 2;
          const pCY = p.y + p.h;
          const cCX = ch.x + ch.w / 2;
          const cCY = ch.y;

          // Right-angle fork path:
          //   parent↓ → corner → child→ (or ┌ shape when child is to the right)
          // Step 1: down from parent bottom to the jog height. The stub above
          // the jog is shared with the parent's straight continuation, so it
          // belongs to THAT connector's tooltip, never to this fork child's.
          const midY = forkJogY(pCY, cCY);
          out.push({
            key: `f-${c.forkFromId}-${c.shipId}`,
            d: `M ${pCX} ${pCY} V ${midY} H ${cCX} V ${cCY}`,
            cls: "conn",
          });
          // Hover target: only the DISTINCT part — the horizontal jog plus
          // the vertical drop into the fork child — never the shared stub.
          const forkCard = connectorCard(c.forkFromId, c.shipId);
          if (forkCard) {
            forkHits.push({
              key: `hf-${c.forkFromId}-${c.shipId}`,
              d: forkLinkHitPath(pCX, pCY, cCX, cCY),
              card: forkCard,
            });
          }

          dot(`dot-${c.forkFromId}-fout`, pCX, pCY);
          dot(`dot-${c.shipId}-fin`, cCX, cCY);

          // A fork column starts its own branch run — the same segment-ⓘ
          // rule as the vertical hand-offs above.
          const parentBranch = techTreeShipBranch(c.forkFromId);
          const childBranch = techTreeShipBranch(c.shipId);
          if (childBranch && parentBranch !== childBranch && techTreeBranchHasContent(childBranch, c.node.type)) {
            const col = cols[c.branchIdx] ?? [];
            const idx = col.findIndex((x) => x.shipId === c.shipId);
            icons.push({
              key: `i-${c.forkFromId}-${c.shipId}`,
              x: (pCX + cCX) / 2,
              y: midY,
              card: branchSegmentCard(childBranch, c.node, segmentEndNode(col, idx, childBranch)),
            });
          }
        });
      });

      // 3. Cross-type research links, straight across the section gap. The
      // in-game tree bridges these too — the cruiser→battleship, DD→CV/SS
      // hand-offs where the unlocked ship roots its own type section, usually
      // on the same tier row as its unlocker.
      for (const link of crossLinks.value) {
        const p = cardEls.get(link.from);
        const ch = cardEls.get(link.to);
        const parentNode = techTreeNode(link.from, props.realm);
        const childNode = techTreeNode(link.to, props.realm);
        if (!p || !ch || !parentNode || !childNode) continue;
        // Leave from the facing edges: BB lines unlock from cruisers to
        // their right, CV/SS lines from DDs to their left; some hand-offs
        // skip a section — the run passes harmlessly behind the intervening
        // cards (SVG sits under the card layer).
        const rightward = ch.x + ch.w / 2 > p.x + p.w / 2;
        const pX = rightward ? p.x + p.w : p.x;
        const cX = rightward ? ch.x : ch.x + ch.w;
        const pMidY = p.y + p.h / 2;

        let linkD: string;
        let iconX: number;
        if (childNode.tier === parentNode.tier) {
          linkD = `M ${pX} ${pMidY} H ${cX}`;
          dot(`dot-${link.from}-xout`, pX, pMidY);
          dot(`dot-${link.to}-xin`, cX, pMidY);
          iconX = (pX + cX) / 2;
        } else {
          // Tier-shifted hand-offs (Pan-Asia DD→CA at IV→V): run across at
          // the parent's mid height, then drop into the child's top.
          const cCX = ch.x + ch.w / 2;
          linkD = `M ${pX} ${pMidY} H ${cCX} V ${ch.y}`;
          dot(`dot-${link.from}-xout`, pX, pMidY);
          dot(`dot-${link.to}-xin`, cCX, ch.y);
          iconX = (pX + cCX) / 2;
        }
        out.push({ key: `x-${link.from}-${link.to}`, d: linkD, cls: "conn" });
        icons.push({
          key: `i-${link.from}-${link.to}`,
          x: iconX,
          y: pMidY,
          card: linkHintCard(parentNode, childNode),
        });
        // The line is a ship→ship research link too, so it gets the XP
        // tooltip; the ⓘ card above it keeps working (the button is DOM in
        // a higher z band and wins the pointer over the line's midpoint).
        const linkCard = connectorCard(link.from, link.to);
        if (linkCard) hits.push({ key: `hx-${link.from}-${link.to}`, d: linkD, card: linkCard });
      }

      drawItems.value = out;
      linkIcons.value = icons;
      // Fork hits render first so the straight-continuation and cross-link
      // hits paint above them: the shared pre-fork stub always resolves to
      // the continuation's tooltip.
      hitItems.value = [...forkHits, ...hits];
      svgSize.value = { w: root.scrollWidth, h: root.scrollHeight };
    }

    onMounted(() => {
      void nextTick(() => measure());
      setTimeout(() => measure(), 350);
      if (containerRef.value && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => measure());
        ro.observe(containerRef.value);
      }
    });
    onBeforeUnmount(() => ro?.disconnect());
    // An interface-scale change rewrites the root CSS `zoom` without
    // resizing anything in this component's own coordinate space, so the
    // ResizeObserver never fires — watch the scale and re-measure.
    watch(useAppliedDpiScale(), () => {
      void nextTick(() => measure());
    });
    watch(
      () => [props.nation, props.realm] as const,
      () => {
        void nextTick(() => { setTimeout(measure, 150); setTimeout(measure, 500); });
      },
    );

    function shipImg(cell: PosCell): string | null {
      return cell.ship ? resolveShipImage(cell.ship.shipId, cell.ship.images?.small) : null;
    }

    return () => {
      if (!hasTree.value) {
        return <div class="tech-tree-v3 tech-tree-v3--empty">{t("ships.techTree.empty")}</div>;
      }
      return (
        <div class="tech-tree-v3" ref={containerRef}>
          <svg class="tech-tree-v3__svg" aria-hidden="true" width={svgSize.value.w} height={svgSize.value.h}>
            {drawItems.value.map((item) => {
              if (item.cls === "dot") {
                return <circle key={item.key} class="tech-tree-v3__dot" cx={item.cx} cy={item.cy} r={3} />;
              }
              return (
                <path key={item.key} class={`tech-tree-v3__${item.cls}`} d={item.d} />
              );
            })}
            {/* Connector research-XP hover targets: invisible wide strokes
                over the visible lines (CSS re-enables pointer events on the
                stroke only). Same data-hint-card JSON contract as the ⓘ
                buttons; the card/ⓘ layers above the SVG keep their pointers. */}
            {hitItems.value.map((item) => (
              <path
                key={item.key}
                class="tech-tree-v3__linkhit"
                d={item.d}
                data-hint-card={item.card}
                data-hint-pos="top"
              />
            ))}
          </svg>

          {/* Type sections laid out left-to-right on one shared tier ladder */}
          <div class="tech-tree-v3__row">
            {sections.value.map((sec) => {
              const tierH = CARD_H + GAP_Y;
              const w = sec.numBranches * (COL_W + GAP_X) - GAP_X + PAD * 2;
              const h = (sec.maxTier - globalMinTier.value + 1) * tierH + PAD * 2;
              return (
                <div class="tech-type-v3" key={sec.type}>
                  <div class="tech-type-v3__head">
                    <BattleIcon type={sec.type} kind="ship" variant="plain" size={14} />
                    {t(`ships.type.${sec.type}`)}
                  </div>
                  <div class="tech-type-v3__canvas" style={{ width: `${w}px`, height: `${h}px` }}>
                    {sec.cells.map((cell) => {
                      const left = PAD + cell.branchIdx * (COL_W + GAP_X);
                      const top = PAD + (cell.tier - globalMinTier.value) * tierH;
                      const img = shipImg(cell);
                      const name = shipLabel(cell);
                      return (
                        <div
                          class="tech-cell-v3"
                          data-sid={cell.shipId}
                          style={{ left: `${left}px`, top: `${top}px`, width: `${COL_W}px` }}
                        >
                          <button
                            class={[
                              "tech-card-v3",
                              cell.node.isPremium ? "tech-card-v3--premium" : "",
                              cell.node.isSpecial ? "tech-card-v3--special" : "",
                            ]}
                            onClick={() => cell.ship && emit("open", cell.ship)}
                          >
                            {cell.forkArchetypes.length > 0 ? (
                              <span
                                class="tech-card-v3__fork"
                                data-hint={cell.forkArchetypes.map((a) => t(`ships.archetype.${a}`)).join(" / ")}
                              >
                                <GitBranch size={10} />
                              </span>
                            ) : null}
                            <div class="tech-card-v3__img-wrap">
                              <AssetImage
                                class="tech-card-v3__img"
                                src={img}
                                alt={name}
                                loading="lazy"
                                fallback={<span class="tech-card-v3__initial">{name.charAt(0)}</span>}
                                fallbackTitle={t("common.imageUnavailable")}
                                onError={() => recordShipImageFailure(cell.shipId)}
                              />
                            </div>
                            <span class="tech-card-v3__tier">{tierToRoman(cell.tier)}</span>
                            <span class="tech-card-v3__name">{name}</span>
                          </button>
                          {cell.archetype ? (
                            <span class="tech-card-v3__archetype">{cell.archetype}</span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ⓘ buttons (branch features + cross-type link info) — geometry lands after measure() */}
          {linkIcons.value.map((ic) => (
            <button
              key={ic.key}
              type="button"
              class="tech-tree-v3__linkinfo"
              style={{ left: `${ic.x - 8}px`, top: `${ic.y - 8}px` }}
              data-hint-card={ic.card}
              data-hint-pos="top"
              aria-label={t("ships.techTree.linkInfo")}
            >
              <Info size={10} />
            </button>
          ))}
        </div>
      );
    };
  },
});
