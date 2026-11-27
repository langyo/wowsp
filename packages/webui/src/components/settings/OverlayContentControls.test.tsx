/**
 * OverlayContentControls — the 游戏内水表 content card's backdrop-opacity dial
 * (settings ▸ 游戏内水表, first row of the card).
 *
 * Pinned here:
 *  - the dial row is the FIRST stats-prefs row of the card and sits AHEAD of
 *    the columns editor in DOM order (the dial shapes the plates the columns
 *    fill, so it heads the card);
 *  - the slider's a11y contract carries the store's band and the live value
 *    (aria-valuemin/-max/-now/-valuetext), and the readout span shows the
 *    same percent;
 *  - a drag emits update:modelValue and commits through the store action;
 *  - a store-side change (the overlay's own broadcast path) moves the
 *    readout, so the row is genuinely reactive;
 *  - the band is NOT baked into the component: one test moves the mocked
 *    MIN/MAX exports to 40/90 and the remounted slider follows them, which
 *    is what proves the component reads @/stores/statsPrefs rather than
 *    literals (the real 50/100 band is pinned by statsPrefs.test.ts).
 *
 * The i18n module is identity-mocked (keys render as text); the columns
 * editor — the sibling card and its HkDraggableList machinery — is stubbed
 * to a marker div, since this suite is about the dial row alone. The store
 * is a reactive stub; real Pinia is installed because the component is
 * mounted as it is in the settings host.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { enableAutoUnmount, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, reactive } from "vue";

const mocks = vi.hoisted(() => ({
  /** The exported band the component imports — starts at the REAL exports
   *  (assigned in the store mock factory below) and one test moves it. */
  band: { min: NaN, max: NaN },
  /** The real exports, kept so afterEach can restore the override. */
  realBand: { min: NaN, max: NaN },
  stores: {} as Record<string, unknown>,
}));

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

vi.mock("@/components/settings/OverlayColumnsEditor", async () => {
  // Marker div so the DOM-order assertion can locate the editor slot.
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "OverlayColumnsEditor",
      setup: () => () => h("div", { class: "stub-columns" }),
    }),
  };
});

vi.mock("@/stores/statsPrefs", async (importOriginal) => {
  // The band comes from the REAL module exports: the mock only wraps them so
  // the literals-vs-exports question stays honest (see the band test).
  const actual = await importOriginal<typeof import("@/stores/statsPrefs")>();
  mocks.realBand.min = mocks.band.min = actual.OVERLAY_BACKDROP_PCT_MIN;
  mocks.realBand.max = mocks.band.max = actual.OVERLAY_BACKDROP_PCT_MAX;
  return {
    ...actual,
    get OVERLAY_BACKDROP_PCT_MIN() {
      return mocks.band.min;
    },
    get OVERLAY_BACKDROP_PCT_MAX() {
      return mocks.band.max;
    },
    useStatsPrefsStore: () => mocks.stores.statsPrefs,
  };
});

import OverlayContentControls from "./OverlayContentControls";
import OverlayColumnsEditor from "@/components/settings/OverlayColumnsEditor";

enableAutoUnmount(afterEach);

interface StoreStub {
  prefs: {
    overlayBackdropPct: number;
    overlayBattleScope: string;
    sealsEnabled: boolean;
    teamAvgEnabled: boolean;
    prEnabled: boolean;
  };
  setOverlayBackdropPct: Mock<(v: number) => void>;
  setOverlayBattleScope: Mock<(v: string) => void>;
  setSealsEnabled: Mock<(v: boolean) => void>;
  setTeamAvgEnabled: Mock<(v: boolean) => void>;
}

/** Reactive store stub: prefs is a real reactive object, so a test can nudge
 *  it the way the overlay window's broadcast does. */
function seedStore(pct = 62): StoreStub {
  const prefs = reactive({
    overlayBackdropPct: pct,
    overlayBattleScope: "follow",
    sealsEnabled: true,
    teamAvgEnabled: false,
    prEnabled: true,
  });
  const stub: StoreStub = {
    prefs,
    setOverlayBackdropPct: vi.fn(),
    setOverlayBattleScope: vi.fn(),
    setSealsEnabled: vi.fn(),
    setTeamAvgEnabled: vi.fn(),
  };
  mocks.stores.statsPrefs = stub;
  return stub;
}

let pinia: Pinia;

function mountControls(): VueWrapper {
  return mount(OverlayContentControls, { global: { plugins: [pinia] } });
}

const dialRow = (wrapper: VueWrapper) =>
  wrapper
    .findAll(".stats-prefs__row")
    .find((row) => row.find(".overlay-content__backdrop-slider").exists())!;

beforeEach(() => {
  // The host always installs the app Pinia before mounting a settings card.
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
});

afterEach(() => {
  // The band override is per-test: restore the real exports so mount order
  // can never leak 40/90 into another assertion.
  mocks.band.min = mocks.realBand.min;
  mocks.band.max = mocks.realBand.max;
});

describe("OverlayContentControls backdrop dial", () => {
  it("heads the card: first stats-prefs row, ahead of the columns editor", () => {
    seedStore();
    const wrapper = mountControls();

    // querySelector on the root element searches DESCENDANTS only, so find
    // the container through the wrapper (the root IS the stats-prefs div).
    const container = wrapper.find(".stats-prefs").element;
    const rows = wrapper.findAll(".stats-prefs__row");
    expect(rows.length).toBeGreaterThan(1);
    // The dial row IS the container's first row element.
    expect(container.firstElementChild?.classList.contains("stats-prefs__row")).toBe(true);
    expect(rows[0].find(".overlay-content__backdrop-slider").exists()).toBe(true);

    // DOM order: the editor's mount point follows the dial row.
    const editor = wrapper.findComponent(OverlayColumnsEditor);
    expect(editor.exists()).toBe(true);
    const position = rows[0].element.compareDocumentPosition(editor.element);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("carries the store band and the live value on the slider + readout", () => {
    seedStore(62);
    const wrapper = mountControls();

    const row = dialRow(wrapper);
    expect(row.text()).toContain("settings.overlayContent.backdropOpacity");
    expect(row.text()).toContain("settings.overlayContent.backdropOpacityDesc");

    const slider = row.find(".hk-slider");
    expect(slider.attributes("aria-valuemin")).toBe("50");
    expect(slider.attributes("aria-valuemax")).toBe("100");
    expect(slider.attributes("aria-valuenow")).toBe("62");
    expect(slider.attributes("aria-valuetext")).toBe("62%");
    expect(row.find(".overlay-content__backdrop-value").text()).toBe("62%");
  });

  it("commits a slider notch through the store action", () => {
    const store = seedStore(62);
    const wrapper = mountControls();

    wrapper
      .findComponent({ name: "HkSlider" })
      .vm.$emit("update:modelValue", 75);

    expect(store.setOverlayBackdropPct).toHaveBeenCalledTimes(1);
    expect(store.setOverlayBackdropPct).toHaveBeenCalledWith(75);
  });

  it("follows a store-side change (the overlay broadcast path)", async () => {
    const store = seedStore(62);
    const wrapper = mountControls();
    expect(wrapper.find(".overlay-content__backdrop-value").text()).toBe("62%");

    store.prefs.overlayBackdropPct = 100;
    await nextTick();

    expect(wrapper.find(".overlay-content__backdrop-value").text()).toBe("100%");
    expect(wrapper.find(".hk-slider").attributes("aria-valuetext")).toBe("100%");
  });

  it("takes its band from the store exports, not literals", () => {
    seedStore(70);
    mocks.band.min = 40;
    mocks.band.max = 90;
    const wrapper = mountControls();

    const slider = wrapper.find(".hk-slider");
    expect(slider.attributes("aria-valuemin")).toBe("40");
    expect(slider.attributes("aria-valuemax")).toBe("90");
    expect(slider.attributes("aria-valuenow")).toBe("70");
  });
});
