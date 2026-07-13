import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";

import { t } from "@/i18n";
import { resolveShipImage } from "@/utils/shipImages";
import { nationTree, techTreeNode, type TechTreeNode } from "@/utils/techTreeData";
import { archetypeKey } from "@/utils/archetypeLabels";
import { SHIP_TYPE_SHORT } from "@/utils/shipAggregation";
import type { ShipInfo } from "@/api";
import "./TechTreeView.scss";

/**
 * Per-nation tech-tree view — mirrors the in-game tech-tree page.
 *
 * Layout: for the selected nation, one horizontal row per ship type
 * (Battleship / Cruiser / Destroyer / Aircraft Carrier / Submarine). Within a
 * row, each research branch is its own sub-row: T1 on the left, T10 on the
 * right, with right-angle SVG connectors between consecutive tiers and a
 * short archetype label on the branch (e.g. "Long-range battleships"). Forks
 * (a tier that unlocks 2+ successors) stack vertically as parallel branches.
 *
 * Node positions are computed by the renderer (CSS grid by tier), and the SVG
 * overlay measures the rendered card DOM to draw the connectors — so a window
 * resize re-runs the measurement via a ResizeObserver.
 *
 * Premium / special ships that hang off a tech-tree node render as a small
 * side card pinned under their parent (no outgoing connector).
 */
export default defineComponent({
  name: "TechTreeView",
  props: {
    nation: { type: String, required: true },
    /** The full encyclopedia, used to resolve display names + images by shipId. */
    byId: { type: Object as () => Map<number, ShipInfo>, required: true },
  },
  emits: {
    open: (_ship: ShipInfo) => true,
  },
  setup(props, { emit }) {
    const tree = computed(() => nationTree(props.nation));
    const hasTree = computed(() => tree.value.some((g) => g.branches.length > 0));

    // Flatten every (type, branch, shipId) into a render list so the template
    // can place cards into a tier-indexed grid. Connectors are drawn later by
    // measuring the rendered DOM.
    interface Cell {
      typeIdx: number;
      type: string;
      branchIdx: number;
      tier: number;
      shipId: number;
      node: TechTreeNode;
      ship: ShipInfo | undefined;
      archetype: string | null;
      isRoot: boolean;
    }
    const rows = computed(() => {
      const out: Cell[][] = [];
      tree.value.forEach((group, typeIdx) => {
        group.branches.forEach((branch, branchIdx) => {
          const cells: Cell[] = [];
          branch.ships.forEach((sid, i) => {
            const node = (null as never) as TechTreeNode; // reassigned below
            const cell: Cell = {
              typeIdx,
              type: group.type,
              branchIdx,
              tier: 0,
              shipId: sid,
              node,
              ship: props.byId.get(sid),
              archetype: i === branch.ships.length - 1 ? archetypeKey(branch.archetype) : null,
              isRoot: i === 0,
            };
            cells.push(cell);
          });
          out.push(cells);
        });
      });
      // Populate node + tier from tech_tree.json after the skeleton.
      for (const cells of out) {
        for (const c of cells) {
          c.node = techTreeNode(c.shipId);
          c.tier = c.node?.tier ?? 0;
        }
      }
      return out;
    });

    /** SVG connector overlay: re-measured from card DOM whenever the layout
     *  changes or the viewport resizes. The overlay is sized to the tree's full
     *  scrollable content (not just the visible client area) so connectors stay
     *  aligned with cards when the tree scrolls horizontally. */
    const containerRef = ref<HTMLElement | null>(null);
    const connectors = ref<{ d: string; key: string }[]>([]);
    const branchLabels = ref<{ x: number; y: number; text: string; tip: string }[]>([]);
    const svgSize = ref({ w: 0, h: 0 });
    let ro: ResizeObserver | null = null;

    function measure() {
      const root = containerRef.value;
      if (!root) return;
      const rootRect = root.getBoundingClientRect();
      const segs: { d: string; key: string }[] = [];
      const labels: { x: number; y: number; text: string; tip: string }[] = [];
      // For each branch row, connect consecutive cards with a right-angle path.
      const rowEls = root.querySelectorAll<HTMLElement>(".tech-row__branch");
      rowEls.forEach((rowEl, ri) => {
        const cards = Array.from(rowEl.querySelectorAll<HTMLElement>(".tech-card"));
        for (let i = 0; i < cards.length - 1; i++) {
          const a = cards[i].getBoundingClientRect();
          const b = cards[i + 1].getBoundingClientRect();
          const x1 = a.right - rootRect.left;
          const y1 = a.top + a.height / 2 - rootRect.top;
          const x2 = b.left - rootRect.left;
          const y2 = b.top + b.height / 2 - rootRect.top;
          const mx = (x1 + x2) / 2;
          // right-angle: out → vertical → in (a flat path if same row).
          segs.push({
            d: `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`,
            key: `${ri}-${i}`,
          });
        }
        // Branch archetype label at the row's right edge (last card).
        const labelEl = rowEl.querySelector<HTMLElement>(".tech-card__archetype");
        if (labelEl) {
          const last = cards[cards.length - 1].getBoundingClientRect();
          labels.push({
            x: last.right - rootRect.left + 8,
            y: last.top + last.height / 2 - rootRect.top,
            text: labelEl.dataset.label ?? "",
            tip: labelEl.dataset.tip ?? "",
          });
        }
      });
      connectors.value = segs;
      branchLabels.value = labels;
      // Size the SVG to the full scrollable content so paths aren't clipped and
      // stay aligned with cards across horizontal scroll.
      svgSize.value = { w: root.scrollWidth, h: root.scrollHeight };
    }

    onMounted(() => {
      void nextTick(measure);
      if (containerRef.value && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => measure());
        ro.observe(containerRef.value);
      }
    });
    onBeforeUnmount(() => ro?.disconnect());
    watch(() => props.nation, () => void nextTick(measure));

    function shipLabel(cell: Cell): string {
      return cell.ship?.name ?? cell.node?.name ?? String(cell.shipId);
    }
    function shipImg(cell: Cell): string | null {
      return cell.ship ? resolveShipImage(cell.ship.shipId, cell.ship.images?.small) : null;
    }
    function typeShort(type: string): string {
      return SHIP_TYPE_SHORT[type] ?? "?";
    }

    /** Distinct type headers (once per type group). */
    const typeHeaders = computed(() => {
      const seen = new Map<string, number>(); // type → first typeIdx
      tree.value.forEach((g) => {
        if (!seen.has(g.type) && g.branches.length) seen.set(g.type, tree.value.indexOf(g));
      });
      return Array.from(seen.entries()); // [type, typeIdx]
    });

    return () => {
      if (!hasTree.value) {
        return <div class="tech-tree tech-tree--empty">{t("ships.techTree.empty")}</div>;
      }
      return (
        <div class="tech-tree" ref={containerRef}>
          <svg
            class="tech-tree__svg"
            aria-hidden="true"
            width={svgSize.value.w}
            height={svgSize.value.h}
          >
            {connectors.value.map((s) => {
              // Parse the two endpoints (M..H.. and final H..) to dot them.
              const nums = s.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
              // nums: [x1, y1, mx, y2, x2] for our path shape
              const x1 = nums[0];
              const y1 = nums[1];
              const x2 = nums[nums.length - 1];
              const y2 = nums.length >= 4 ? nums[3] : y1;
              return [
                <path class="tech-tree__conn" d={s.d} key={`${s.key}-p`} />,
                <circle class="tech-tree__node" cx={x1} cy={y1} r={2.5} key={`${s.key}-a`} />,
                <circle class="tech-tree__node" cx={x2} cy={y2} r={2.5} key={`${s.key}-b`} />,
              ];
            })}
            {branchLabels.value.map((l, i) => (
              <text
                class="tech-tree__label"
                x={l.x}
                y={l.y}
                dy="0.32em"
                key={i}
              >
                {l.text}
              </text>
            ))}
          </svg>
          {typeHeaders.value.map(([type, _idx]) => (
            <div class="tech-type">
              <div class="tech-type__head">
                <span class="tech-type__name">{t(`ships.type.${type}`)}</span>
                <span class="tech-type__abbr">({typeShort(type)})</span>
              </div>
              <div class="tech-type__branches">
                {rows.value
                  .filter((cells) => cells[0]?.type === type)
                  .map((cells, bi) => (
                    <div class="tech-row__branch" key={bi}>
                      {cells.map((cell) => (
                        <button
                          class={[
                            "tech-card",
                            cell.node?.isPremium ? "tech-card--premium" : "",
                            cell.node?.isSpecial ? "tech-card--special" : "",
                            cell.isRoot ? "tech-card--root" : "",
                          ]}
                          style={{ "--tier": cell.tier }}
                          onClick={() => cell.ship && emit("open", cell.ship)}
                        >
                          {shipImg(cell) ? (
                            <img class="tech-card__img" src={shipImg(cell)!} alt={shipLabel(cell)} loading="lazy" />
                          ) : (
                            <div class="tech-card__img tech-card__img--empty" />
                          )}
                          <span class="tech-card__tier">T{cell.tier}</span>
                          <span class="tech-card__name">{shipLabel(cell)}</span>
                          {cell.archetype ? (
                            <span
                              class="tech-card__archetype"
                              data-label={t(`ships.archetype.${cell.archetype}`)}
                              data-tip={t(`ships.archetype.${cell.archetype}`)}
                            />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      );
    };
  },
});
