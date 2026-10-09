import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";

import { t } from "@/i18n";
import { resolveShipImage } from "@/utils/shipImages";
import {
  nationCrossLinks,
  nationTree,
  techTreeNode,
  treeNextShipIds,
  type TechTreeNode,
  type TechTreeRealm,
} from "@/utils/techTreeData";
import { archetypeKey } from "@/utils/archetypeLabels";
import { resolveNationFlag } from "@/utils/nationFlags";
import { useAppliedDpiScale } from "@/theme/dpiPrefs";
import { tierToRoman } from "@wowsp/holo";
import { GitBranch, Info } from "@lucide/vue";
import { AssetImage } from "@/components/base/AssetImage";
import BattleIcon from "@/components/base/BattleIcon";
import { recordShipImageFailure } from "@/utils/shipImageFailures";
import type { ShipInfo } from "@/api";
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
 *   - Research links that change something — a fork or a cross-type hop —
 *     carry a small ⓘ button on the line whose hover card names the ship the
 *     link leads to and what changes (type hand-off, parallel branches,
 *     line-focus switch), mirroring the in-game link info.
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

    function shipLabel(cell: PosCell): string {
      return cell.ship?.name ?? cell.node?.name ?? String(cell.shipId);
    }
    function labelOf(shipId: number): string {
      return props.byId.get(shipId)?.name ?? techTreeNode(shipId, props.realm)?.name ?? String(shipId);
    }

    /**
     * Hover-card JSON for one research link (the ⓘ the in-game tree puts on
     * lines that change something): what the link leads to, plus a row per
     * change — the type hand-off, the parallel branch ships, the line-focus
     * switch. Everything is pre-localized here; the global tooltip hook only
     * parses and renders.
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

    // ── SVG overlay measurement ──────────────────────────────────────────
    const containerRef = ref<HTMLElement | null>(null);
    interface DItem { key: string; d: string; cls: string; cx?: number; cy?: number }
    const drawItems = ref<DItem[]>([]);
    /** ⓘ buttons on change-links, positioned by measure() next to the paths. */
    interface LinkIcon { key: string; x: number; y: number; card: string }
    const linkIcons = ref<LinkIcon[]>([]);
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
        // Tracks: per-branch dashed vertical guide lines
        for (let bi = 0; bi < sec.numBranches; bi++) {
          const col = sec.cells.filter((c) => c.branchIdx === bi);
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

          out.push({ key: `v-${c.parentId}-${c.shipId}`, d: `M ${pCX} ${pCY} V ${cCY}`, cls: "conn" });

          // ⓘ on links that change something: the parent forks into several
          // research lines (the direct continuation included).
          const parentNode = techTreeNode(c.parentId, props.realm);
          if (parentNode && treeNextShipIds(parentNode, props.realm).length > 1) {
            icons.push({
              key: `i-${c.parentId}-${c.shipId}`,
              x: pCX,
              y: (pCY + cCY) / 2,
              card: linkHintCard(parentNode, c.node),
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
          // Step 1: down from parent bottom to halfway between parent-bottom and child-top
          const midY = pCY + (cCY - pCY) * 0.45;
          out.push({
            key: `f-${c.forkFromId}-${c.shipId}`,
            d: `M ${pCX} ${pCY} V ${midY} H ${cCX} V ${cCY}`,
            cls: "conn",
          });

          dot(`dot-${c.forkFromId}-fout`, pCX, pCY);
          dot(`dot-${c.shipId}-fin`, cCX, cCY);

          const parentNode = techTreeNode(c.forkFromId, props.realm);
          if (parentNode) {
            icons.push({
              key: `i-${c.forkFromId}-${c.shipId}`,
              x: (pCX + cCX) / 2,
              y: midY,
              card: linkHintCard(parentNode, c.node),
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

        if (childNode.tier === parentNode.tier) {
          out.push({ key: `x-${link.from}-${link.to}`, d: `M ${pX} ${pMidY} H ${cX}`, cls: "conn" });
          dot(`dot-${link.from}-xout`, pX, pMidY);
          dot(`dot-${link.to}-xin`, cX, pMidY);
          icons.push({
            key: `i-${link.from}-${link.to}`,
            x: (pX + cX) / 2,
            y: pMidY,
            card: linkHintCard(parentNode, childNode),
          });
        } else {
          // Tier-shifted hand-offs (Pan-Asia DD→CA at IV→V): run across at
          // the parent's mid height, then drop into the child's top.
          const cCX = ch.x + ch.w / 2;
          out.push({
            key: `x-${link.from}-${link.to}`,
            d: `M ${pX} ${pMidY} H ${cCX} V ${ch.y}`,
            cls: "conn",
          });
          dot(`dot-${link.from}-xout`, pX, pMidY);
          dot(`dot-${link.to}-xin`, cCX, ch.y);
          icons.push({
            key: `i-${link.from}-${link.to}`,
            x: (pX + cCX) / 2,
            y: pMidY,
            card: linkHintCard(parentNode, childNode),
          });
        }
      }

      drawItems.value = out;
      linkIcons.value = icons;
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

          {/* ⓘ buttons on change-links — geometry lands after measure() */}
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
