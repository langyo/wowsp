import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";

import type { ReplayMetaLite } from "@/api";

enableAutoUnmount(afterEach);

/** Per-render probe: `ReplayCard` resolves its own ship off the offline DB
 *  inside its render function, so this call count IS the card's render
 *  count — the cheapest honest way to observe whether Vue re-rendered a
 *  child (there is no React-style `memo` wrapper to introspect). */
const probes = vi.hoisted(() => ({
  shipName: vi.fn((_id: number) => "Test Ship"),
  shipEntry: vi.fn(() => ({ type: "BB", tier: 8, nation: "usa" })),
  colorOf: vi.fn(() => null as string | null),
}));

vi.mock("@/i18n", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("@/i18n/useLanguage", () => ({
  useLanguage: () => ({ dataLanguage: { value: "en" } }),
}));
vi.mock("@/stores/markers", () => ({
  useMarkersStore: () => ({
    colorOf: probes.colorOf,
    ensureLoaded: () => Promise.resolve(),
  }),
}));
// Partial mock: the view's module graph resolves map minimaps off this
// module at import time, so only the two card probes are replaced.
vi.mock("@/features/holographic/modelLoader", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/features/holographic/modelLoader")
  >();
  return {
    ...actual,
    shipOfflineEntry: probes.shipEntry,
    shipNameFromOfflineDb: probes.shipName,
  };
});

import {
  REPLAY_CARD_PAGE,
  ReplayCard,
  cardPageSlice,
  nextCardPageCount,
} from "./ReplayView";

function meta(i: number): ReplayMetaLite {
  return {
    path: `/replays/2024010${i % 9}_120000_R${i}.wowsreplay`,
    dateTime: "20240101_120000",
    mapName: "30_NE_fault_line",
    playerName: `Player${i}`,
    playerCount: 24,
    enemyCount: 24,
    ownShipId: 100 + i,
  } as unknown as ReplayMetaLite;
}

function metas(n: number): ReplayMetaLite[] {
  return Array.from({ length: n }, (_, i) => meta(i));
}

/** Host stand-in for the rail: renders one `ReplayCard` per entry and owns
 *  the `active` flag exactly as ReplayView does (a single selected path). */
const Rail = defineComponent({
  props: {
    replays: { type: Array as () => ReplayMetaLite[], required: true },
  },
  setup(props) {
    const activePath = ref<string | null>(null);
    const opened: string[] = [];
    const closed: string[] = [];
    // Stable handlers, exactly as the view passes them: a per-card closure
    // would defeat the props comparison the card relies on.
    const onOpen = (path: string) => {
      opened.push(path);
      activePath.value = path;
    };
    const onClose = (path: string) => {
      closed.push(path);
    };
    return () =>
      h(
        "ul",
        props.replays.map((r) =>
          h(ReplayCard, {
            key: r.path,
            replay: r,
            external: false,
            active: activePath.value === r.path,
            onOpen,
            onClose,
          }),
        ),
      );
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rail card paging", () => {
  it("pages in 200-card steps", () => {
    expect(REPLAY_CARD_PAGE).toBe(200);
    // First page of a long rail: 200 of 1000.
    expect(cardPageSlice(metas(1000), REPLAY_CARD_PAGE)).toHaveLength(200);
    // The 200 boundary itself: a list of exactly one page stays whole, and
    // the next page is the whole (already complete) list.
    expect(cardPageSlice(metas(200), REPLAY_CARD_PAGE)).toHaveLength(200);
    expect(cardPageSlice(metas(201), REPLAY_CARD_PAGE)).toHaveLength(200);
    expect(cardPageSlice(metas(201), nextCardPageCount(REPLAY_CARD_PAGE, 201))).toHaveLength(201);
    // The 400 boundary: the second page completes a 400-card rail and is
    // still a strict head of a 401-card one.
    expect(cardPageSlice(metas(400), 400)).toHaveLength(400);
    expect(cardPageSlice(metas(401), 400)).toHaveLength(400);
    expect(cardPageSlice(metas(401), nextCardPageCount(400, 401))).toHaveLength(401);
  });

  it("advances one page at a time, clamped to the total", () => {
    expect(nextCardPageCount(REPLAY_CARD_PAGE, 1000)).toBe(400);
    expect(nextCardPageCount(400, 1000)).toBe(600);
    // Clamp: never past the end, never below the page already shown.
    expect(nextCardPageCount(200, 200)).toBe(200);
    expect(nextCardPageCount(200, 250)).toBe(250);
    expect(nextCardPageCount(400, 350)).toBe(350);
    // Empty rail and a zero/negative count stay sane (no throw, no card).
    expect(nextCardPageCount(200, 0)).toBe(0);
    expect(cardPageSlice(metas(3), 0)).toHaveLength(0);
    expect(cardPageSlice(metas(3), -5)).toHaveLength(0);
  });

  it("keeps the sort order — only a tail is withheld", () => {
    const cards = metas(5);
    expect(cardPageSlice(cards, 3).map((r) => r.path)).toEqual(cards.slice(0, 3).map((r) => r.path));
  });
});

describe("ReplayCard render bail-out", () => {
  it("builds every card once on mount", () => {
    const wrapper = mount(Rail, { props: { replays: metas(3) } });
    expect(wrapper.findAll("li.replay-view__item")).toHaveLength(3);
    expect(probes.shipName).toHaveBeenCalledTimes(3);
  });

  it("re-renders only the card whose active flag flips", async () => {
    const wrapper = mount(Rail, { props: { replays: metas(4) } });
    probes.shipName.mockClear();

    const buttons = wrapper.findAll("button.replay-card");
    await buttons[1].trigger("click");
    // Nothing was active before: one card flips. Without the component
    // boundary the whole rail (4 cards) would re-run the offline-DB lookup.
    expect(probes.shipName).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll(".replay-card--active")).toHaveLength(1);

    probes.shipName.mockClear();
    await buttons[2].trigger("click");
    // The previously active card clears and the new one lights up: two
    // cards re-render, still far below the four-card rail.
    expect(probes.shipName).toHaveBeenCalledTimes(2);
    const active = wrapper.findAll(".replay-card--active");
    expect(active).toHaveLength(1);
    expect(active[0].text()).toContain("Player2");
  });

  it("re-renders nothing when the click lands on the already-active card", async () => {
    const wrapper = mount(Rail, { props: { replays: metas(4) } });
    const buttons = wrapper.findAll("button.replay-card");
    await buttons[0].trigger("click");
    probes.shipName.mockClear();
    // Selecting the SAME card again changes no prop — zero card renders.
    await buttons[0].trigger("click");
    expect(probes.shipName).toHaveBeenCalledTimes(0);
  });

  it("re-renders every card when the list itself is replaced", async () => {
    // The bail-out is a props comparison, not a cache: a rescan/new sort
    // hands over fresh objects, and the cards must follow.
    const wrapper = mount(Rail, { props: { replays: metas(3) } });
    probes.shipName.mockClear();
    await wrapper.setProps({ replays: metas(3) });
    expect(probes.shipName).toHaveBeenCalledTimes(3);
  });
});
