import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";

import { t } from "@/i18n";
import { resolveShipImage } from "@/utils/shipImages";
import { nationTree, techTreeNode, type TechTreeNode } from "@/utils/techTreeData";
import { archetypeKey } from "@/utils/archetypeLabels";
import { tierToRoman } from "@/utils/tierRoman";
import { GitBranch } from "lucide-vue-next";
import type { ShipInfo } from "@/api";
import "./TechTreeView.scss";

/**
 * Vertical tech-tree.
 *
 * Layout (matching the in-game port tech-tree panel):
 *   - Nation rail on the left (handled by ShipsView).
 *   - Ship-type sections laid out left-to-right in a horizontal row.
 *     Each section header labels the type (Battleship / Cruiser / ...).
 *   - Within a section, each research branch is a column. Cards are
 *     absolutely positioned so tiers align horizontally across columns.
 *   - Fork branches start their own column at the fork tier; shared
 *     prefix ships appear only in the first/main column, never duplicated.
 *   - SVG connectors draw vertical links within a column and diagonal
 *     fork connectors from the parent ship to the fork column's first ship.
 */
export default defineComponent({
  name: "TechTreeView",
  props: {
    nation: { type: String, required: true },
    byId: { type: Object as () => Map<number, ShipInfo>, required: true },
  },
  emits: { open: (_ship: ShipInfo) => true },
  setup(props, { emit }) {
    const tree = computed(() => nationTree(props.nation));
    const hasTree = computed(() => tree.value.some((g) => g.branches.length > 0));

    // Layout dimensions
    const COL_W = 118;
    const CARD_H = 110;
    const GAP_X = 22;   // horizontal gap between branch columns
    const GAP_Y = 16;   // vertical gap between tier rows
    const PAD = 14;     // padding inside each type section canvas
    const HEAD_H = 22;  // type header height

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
            const node = techTreeNode(sid);
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

    // ── SVG overlay measurement ──────────────────────────────────────────
    const containerRef = ref<HTMLElement | null>(null);
    interface DItem { key: string; d: string; cls: string; cx?: number; cy?: number }
    const drawItems = ref<DItem[]>([]);
    const svgSize = ref({ w: 0, h: 0 });
    let ro: ResizeObserver | null = null;

    function measure() {
      const root = containerRef.value;
      if (!root) return;
      const rootR = root.getBoundingClientRect();
      const out: DItem[] = [];

      sections.value.forEach((sec) => {
        const cardEls = new Map<number, { x: number; y: number; w: number; h: number }>();
        sec.cells.forEach((c) => {
          const el = root.querySelector(`[data-sid="${c.shipId}"]`) as HTMLElement | null;
          if (el) {
            const r = el.getBoundingClientRect();
            cardEls.set(c.shipId, { x: r.left - rootR.left, y: r.top - rootR.top, w: r.width, h: r.height });
          }
        });

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

        // Connectors: parent → child with right-angle paths
        const dotSet = new Set<string>();

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

          const dk1 = `dot-${c.parentId}-out`;
          if (!dotSet.has(dk1)) { dotSet.add(dk1); out.push({ key: dk1, cx: pCX, cy: pCY, d: "", cls: "dot" }); }
          const dk2 = `dot-${c.shipId}-in`;
          if (!dotSet.has(dk2)) { dotSet.add(dk2); out.push({ key: dk2, cx: cCX, cy: cCY, d: "", cls: "dot" }); }

          out.push({ key: `v-${c.parentId}-${c.shipId}`, d: `M ${pCX} ${pCY} V ${cCY}`, cls: "conn" });
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

          const dk1 = `dot-${c.forkFromId}-fout`;
          if (!dotSet.has(dk1)) { dotSet.add(dk1); out.push({ key: dk1, cx: pCX, cy: pCY, d: "", cls: "dot" }); }
          const dk2 = `dot-${c.shipId}-fin`;
          if (!dotSet.has(dk2)) { dotSet.add(dk2); out.push({ key: dk2, cx: cCX, cy: cCY, d: "", cls: "dot" }); }
        });
      });

      drawItems.value = out;
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
    watch(() => props.nation, () => {
      void nextTick(() => { setTimeout(measure, 150); setTimeout(measure, 500); });
    });

    function shipLabel(cell: PosCell): string {
      return cell.ship?.name ?? cell.node?.name ?? String(cell.shipId);
    }
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

          {/* Type sections laid out left-to-right */}
          <div class="tech-tree-v3__row">
            {sections.value.map((sec) => {
              const tierH = CARD_H + GAP_Y;
              const w = sec.numBranches * (COL_W + GAP_X) - GAP_X + PAD * 2;
              const h = (sec.maxTier - sec.minTier + 1) * tierH + PAD * 2;
              return (
                <div class="tech-type-v3" key={sec.type}>
                  <div class="tech-type-v3__head">{t(`ships.type.${sec.type}`)}</div>
                  <div class="tech-type-v3__canvas" style={{ width: `${w}px`, height: `${h}px` }}>
                    {sec.cells.map((cell) => {
                      const left = PAD + cell.branchIdx * (COL_W + GAP_X);
                      const top = PAD + (cell.tier - sec.minTier) * tierH;
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
                                title={cell.forkArchetypes.map((a) => t(`ships.archetype.${a}`)).join(" / ")}
                              >
                                <GitBranch size={10} />
                              </span>
                            ) : null}
                            {img ? (
                              <img class="tech-card-v3__img" src={img} alt={name} loading="lazy" />
                            ) : (
                              <div class="tech-card-v3__img--placeholder">
                                <span class="tech-card-v3__initial">{name.charAt(0)}</span>
                              </div>
                            )}
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
        </div>
      );
    };
  },
});
