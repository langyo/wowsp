/**
 * Tests for the About modal's trivia ship links. The localized trivia
 * strings carry [[shipIndex:label]] markers on every ship mention; the
 * parser splits them out, renderTriviaFact turns them into underlined
 * buttons that open the tech tree's ship-detail modal (through the same
 * useShipDetail composable ShipsView hosts) without also restoring the
 * plain description, and every locale must wrap the SAME ship set per
 * trivia key (the wrap is part of the content contract, not translation
 * freedom).
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import { initLocaleMessages } from "@/i18n";
import shipNamesDbRaw from "@/data/ship_names.json";

import { AboutContent, parseTriviaNodes, renderTriviaFact } from "./AboutModal";

// res/ lives outside the package root (same haul the i18n bootstrap does),
// so the locale files come in through Vite's glob rather than JSON imports.
const ABOUT_MODULES = import.meta.glob("../../../../../res/i18n/locales/*/about.json", {
  eager: true,
}) as Record<string, { default: Record<string, string> }>;

const mocks = vi.hoisted(() => ({
  openShip: vi.fn(),
  openExternal: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@/utils/openExternal", () => ({ openExternal: mocks.openExternal }));
vi.mock("@/composables/useShipDetail", () => ({
  useShipDetail: () => ({
    selectedShip: { value: null },
    gameRoot: { value: "" },
    openShip: mocks.openShip,
    closeShip: vi.fn(),
  }),
}));
// Closed shell is enough — the real modal drags the whole ship-detail tree.
vi.mock("@/components/ships/ShipDetailModal", () => ({
  default: {
    name: "ShipDetailModal",
    props: ["ship", "source", "accountId", "realm", "gameRoot"],
    render: () => null,
  },
}));
vi.mock("@/stores/updater", () => ({
  useUpdaterStore: () => ({
    portable: false,
    running: false,
    available: false,
    checked: true,
    version: null,
    statusText: "",
    init: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    downloadAndInstall: vi.fn(async () => {}),
  }),
}));

enableAutoUnmount(afterEach);

beforeAll(async () => {
  mocks.getVersion.mockResolvedValue("0.0.0");
  await initLocaleMessages();
});

/** The trivia keys whose facts mention in-game ships (the wrap set). */
const SHIP_TRIVIA_KEYS = [
  "trivia01", "trivia04", "trivia06", "trivia07", "trivia08", "trivia11",
  "trivia12", "trivia14", "trivia16", "trivia18", "trivia20", "trivia22",
  "trivia23", "trivia24", "trivia26", "trivia29", "trivia31", "trivia32",
  "trivia33", "trivia35", "trivia36", "trivia39", "trivia41", "trivia43",
  "trivia45", "trivia46",
] as const;

const ABOUTS: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(ABOUT_MODULES).map(([pathKey, mod]) => [
    pathKey.match(/locales\/([^/]+)\/about\.json$/)?.[1] ?? pathKey,
    mod.default,
  ]),
);

/** Ship mentions of one trivia value, as sorted "index xCount" pairs. */
function shipSet(text: string): string[] {
  const counts = new Map<string, number>();
  for (const node of parseTriviaNodes(text)) {
    if (typeof node === "string") continue;
    counts.set(node.shipIndex, (counts.get(node.shipIndex) ?? 0) + 1);
  }
  return [...counts.entries()].sort().map(([index, count]) => `${index}x${count}`);
}

describe("parseTriviaNodes", () => {
  it("splits ship markers from the surrounding text", () => {
    expect(parseTriviaNodes("前[[PJSB111:萨摩]]后")).toEqual([
      "前",
      { shipIndex: "PJSB111", label: "萨摩" },
      "后",
    ]);
  });

  it("keeps marker-free text as one plain run", () => {
    expect(parseTriviaNodes("no mentions here")).toEqual(["no mentions here"]);
  });

  it("leaves malformed brackets untouched as plain text", () => {
    expect(parseTriviaNodes("not a ship [[PJSB111]] nor [[x:]] here")).toEqual([
      "not a ship [[PJSB111]] nor [[x:]] here",
    ]);
  });

  it("parses several markers in one line", () => {
    const nodes = parseTriviaNodes("[[A:一]]、[[B:二]]与[[C:三]]");
    expect(nodes.filter((node) => typeof node !== "string")).toHaveLength(3);
  });
});

describe("renderTriviaFact", () => {
  it("returns plain text when nothing is linkable", () => {
    expect(renderTriviaFact("plain fact", vi.fn())).toBe("plain fact");
  });

  it("renders ship mentions as stop-bubbling link buttons", () => {
    const onShip = vi.fn();
    const out = renderTriviaFact("pre[[PJSB111:萨摩]]post", onShip) as unknown[];
    expect(out).toHaveLength(3);
    const button = out.find((node) => typeof node === "object") as {
      props: { class: unknown; onClick: (event: { stopPropagation: () => void }) => void };
    };
    expect(String(button.props.class)).toContain("about-modal__trivia-link");
    const event = { stopPropagation: vi.fn() };
    button.props.onClick(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onShip).toHaveBeenCalledWith("PJSB111", "萨摩");
    expect(out).toContain("pre");
    expect(out).toContain("post");
  });

  it("keeps the credited-helper token an external Bilibili link", () => {
    const out = renderTriviaFact("@BestNaomi once drove Vermont", vi.fn()) as unknown[];
    const button = out.find((node) => typeof node === "object") as {
      props: { onClick: (event: { stopPropagation: () => void }) => void };
    };
    button.props.onClick({ stopPropagation: vi.fn() });
    expect(mocks.openExternal).toHaveBeenCalledWith(
      expect.stringContaining("space.bilibili.com"),
    );
  });
});

describe("trivia ship-link data contract", () => {
  it("every locale wraps the same ship set per trivia key", () => {
    for (const key of SHIP_TRIVIA_KEYS) {
      const expected = shipSet(ABOUTS["zh-CN"][key]);
      expect(expected, `zh-CN ${key} should carry markers`).not.toHaveLength(0);
      for (const [locale, about] of Object.entries(ABOUTS)) {
        expect(about[key], `${locale}.${key} missing`).toBeTruthy();
        expect(shipSet(about[key]), `${locale}.${key}`).toEqual(expected);
      }
    }
  });

  it("every marker index resolves in the offline ship DB", () => {
    const indexes = new Set(
      Object.values(shipNamesDbRaw as Record<string, { index?: string }>)
        .map((entry) => entry?.index)
        .filter(Boolean),
    );
    for (const [locale, about] of Object.entries(ABOUTS)) {
      for (const key of SHIP_TRIVIA_KEYS) {
        for (const node of parseTriviaNodes(about[key])) {
          if (typeof node === "string") continue;
          expect(indexes.has(node.shipIndex), `${locale}.${key} -> ${node.shipIndex}`).toBe(true);
          expect(node.label, `${locale}.${key} label`).not.toMatch(/[\][|@{}]/);
        }
      }
    }
  });
});

describe("AboutContent trivia ship links", () => {
  it("opens the ship-detail modal from a trivia ship mention", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(AboutContent, { global: { plugins: [pinia] } });
    await flushPromisesTick();

    // Trivia draws are random; poke the logo until a draw carries ship
    // links (26 of 49 facts do) and click one — it must open the tech
    // tree's ship-detail modal and NOT restore the plain description.
    const logo = wrapper.find(".about-modal__logo");
    expect(logo.exists()).toBe(true);
    let clicked = false;
    for (let draw = 0; draw < 30 && !clicked; draw += 1) {
      await logo.trigger("click");
      const buttons = wrapper.findAll(".about-modal__trivia-link");
      for (const button of buttons) {
        await button.trigger("click");
        if (mocks.openShip.mock.calls.length > 0) {
          clicked = true;
          break;
        }
      }
    }
    expect(clicked, "no trivia draw carried a clickable ship mention").toBe(true);
    expect(mocks.openShip).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(String),
      expect.any(String),
    );
    // The trivia face must still be shown (the link click swallowed the
    // restore click through stopPropagation).
    expect(wrapper.find(".about-modal__trivia").attributes("style")).toContain("opacity: 1");
  });
});

/** Microtask flush helper (no timer semantics needed here). */
function flushPromisesTick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
