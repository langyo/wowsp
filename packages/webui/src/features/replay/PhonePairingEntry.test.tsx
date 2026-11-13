/**
 * Tests for the live view's phone-pairing entry (PhonePairingEntry — the
 * user-requested live-stats pairing entry points):
 *
 *  - both faces render — the head row's icon-only pill (aria-label +
 *    data-hint tooltip, no label text) and the waiting placeholder's
 *    labeled pill;
 *  - the PHONE branch deep-links to /replay?pairing=1 (ReplayView
 *    auto-opens the PairingWizard there — the same route the phone
 *    settings' pairing section uses) and never mounts the desktop modal;
 *  - the DESKTOP branch opens the compact handshake modal: the channel
 *    identity (realm + nickname + publish phase), the gateway root, and
 *    the service toggle driving the SAME composable the settings
 *    section's toggle runs on (enable = persist + gateway_publish_start
 *    on the account route r:<realm>:<accountId>);
 *  - the modal's footer link lands on the settings pairing section and
 *    closes the modal.
 *
 * The api module is mocked (gateway commands + the listener wiring); the
 * pinia stores are real so the modal reads the same state the app does;
 * the router and the platform gate are mocked per branch. hikari's
 * HkModal/HkTabs/HkTag stubs mirror the real contracts the host suites
 * stub the same way (HkTabs keeps the no-emit-for-active-key guard).
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

import { useToast } from "@celestia-island/hikari";

const mocks = vi.hoisted(() => ({
  /** The platform gate under test control (desktop by default). */
  mobileApp: false,
  routerPush: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  publishStart: vi.fn(),
  publishStop: vi.fn(),
  publishStatus: vi.fn(),
  appdataRead: vi.fn(),
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.routerPush }) }));

vi.mock("@/utils/platform", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/utils/platform")>();
  return { ...orig, isMobileApp: () => mocks.mobileApp };
});

vi.mock("@/api", () => ({
  api: {
    gatewayGetConfig: mocks.getConfig,
    gatewaySetConfig: mocks.setConfig,
    gatewayPublishStart: mocks.publishStart,
    gatewayPublishStop: mocks.publishStop,
    gatewayPublishStatus: mocks.publishStatus,
    appdataRead: mocks.appdataRead,
    // The gateway store wires its listeners once, at creation.
    listenGatewayState: () => Promise.resolve(() => undefined),
    listenGatewayBattle: () => Promise.resolve(() => undefined),
    listenGatewaySelfhost: () => Promise.resolve(() => undefined),
  },
  GATEWAY_OFFICIAL_ROOT: "https://wowsp.langyo.xyz/gateway/",
  // Imported as a runtime value by gatewayBattle.ts (in the graph through
  // useSettingsGatewayState) — present so the mock stays a drop-in.
  GATEWAY_ROUTE_RE: /^r:[a-z]{2,5}:[0-9]+$/,
}));

import { initLocaleMessages, t } from "@/i18n";
import { useSessionStore } from "@/stores/session";
import { useSettingsUiStore } from "@/stores/settingsUi";
import type { SessionSnapshot } from "@/api";
import { fakeAs } from "@/test-utils/fakes";

import PhonePairingEntry from "./PhonePairingEntry";

/* ── hikari stubs (the host suites' shapes) ─────────────────────────── */

/** Renders its slot while open — the modal's open/close contract without
 * the real surface machine (teleport, transitions, focus trap). */
const HkModal = defineComponent({
  name: "HkModal",
  props: {
    modelValue: { type: Boolean, default: false },
    title: { type: String, default: "" },
    width: { type: String, default: undefined },
  },
  emits: ["update:modelValue"],
  setup(props, { slots }) {
    return () =>
      props.modelValue
        ? h("section", { class: "stub-HkModal" }, [
            h("h2", { class: "stub-HkModal-title" }, props.title),
            slots.default?.(),
          ])
        : null;
  },
});

/** The segmented control's click contract, guard included (no update
 * emit for the already-active key — HkTabs.tsx's own rule). */
const HkTabs = defineComponent({
  name: "HkTabs",
  props: {
    modelValue: { type: String, default: "" },
    tabs: { type: Array, default: () => [] },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h(
        "div",
        { class: "stub-HkTabs" },
        (props.tabs as Array<{ key: string; label: string }>).map((tab) =>
          h(
            "button",
            {
              key: tab.key,
              type: "button",
              "data-tab": tab.key,
              "data-active": tab.key === props.modelValue ? "" : undefined,
              onClick: () => {
                // The real control's guard: the active segment never
                // re-emits (HkTabs suppresses the no-op update).
                if (tab.key !== props.modelValue) emit("update:modelValue", tab.key);
              },
            },
            tab.label,
          ),
        ),
      );
  },
});

const HkTag = defineComponent({
  name: "HkTag",
  props: { variant: { type: String, default: "default" }, size: { type: String, default: "md" } },
  setup(props, { slots }) {
    return () =>
      h("span", { class: "stub-HkTag", "data-variant": props.variant, "data-size": props.size }, slots.default?.() ?? []);
  },
});

const HkAlert = defineComponent({
  name: "HkAlert",
  props: { variant: { type: String, default: "info" }, size: { type: String, default: "md" }, message: { type: String, default: "" } },
  setup: (props) => () => h("p", { class: "stub-HkAlert" }, props.message),
});

const HkButton = defineComponent({
  name: "HkButton",
  setup: (_props, { slots }) => () => h("button", { class: "stub-HkBtn", type: "button" }, slots.default?.() ?? []),
});

const HkSpinner = defineComponent({
  name: "HkSpinner",
  setup: () => () => h("span", { class: "stub-HkSpinner" }),
});

const STUBS = { HkModal, HkTabs, HkTag, HkAlert, HkButton, HkSpinner };

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

const OFFICIAL_ROOT = "https://wowsp.langyo.xyz/gateway/";

/** Mount the entry around the session hub's resolved identity (the same
 * fake the captcha-hint suite uses — the route derives from it). */
function mountEntry(props: { labeled?: boolean } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSessionStore();
  session.snapshot = fakeAs<SessionSnapshot>({
    display: { accountId: 123, nickname: "Tester", realm: "asia", registered: true, playing: false },
  });
  const wrapper = mount(PhonePairingEntry, {
    props,
    global: { plugins: [pinia], stubs: STUBS },
  });
  return wrapper;
}

/** The entry's interactive pill (AppTag's wrapper button). */
const entryButton = (wrapper: ReturnType<typeof mountEntry>) =>
  wrapper.find<HTMLButtonElement>("button.phone-pairing-entry");

beforeEach(() => {
  mocks.mobileApp = false;
  for (const m of [mocks.routerPush, mocks.getConfig, mocks.setConfig, mocks.publishStart, mocks.publishStop, mocks.publishStatus, mocks.appdataRead])
    m.mockReset();
  mocks.getConfig.mockResolvedValue({ root: OFFICIAL_ROOT, enabled: false });
  mocks.publishStatus.mockResolvedValue({ enabled: false, phase: "stopped", subscribers: 0 });
  mocks.setConfig.mockResolvedValue({ root: OFFICIAL_ROOT, enabled: true });
  mocks.publishStart.mockResolvedValue(null);
  mocks.publishStop.mockResolvedValue(null);
  mocks.appdataRead.mockRejectedValue(new Error("no cache file"));
  const toasts = useToast().toasts;
  for (const slot of [...toasts]) useToast().remove(slot.id);
});

afterEach(() => {
  const toasts = useToast().toasts;
  for (const slot of [...toasts]) useToast().remove(slot.id);
});

describe("PhonePairingEntry", () => {
  it("renders the head face as an icon-only pill with the tooltip", async () => {
    const wrapper = mountEntry();
    await flushPromises();

    const btn = entryButton(wrapper);
    expect(btn.exists()).toBe(true);
    // Tooltip + accessible name, no visible label text on this face.
    expect(btn.attributes("aria-label")).toBe(t("replay.live.pairingEntryHintDesktop"));
    expect(btn.attributes("data-hint")).toBe(t("replay.live.pairingEntryHintDesktop"));
    expect(btn.text()).not.toContain(t("replay.live.pairingEntry"));
    // No modal until clicked.
    expect(wrapper.find(".stub-HkModal").exists()).toBe(false);
  });

  it("renders the placeholder face with the label", async () => {
    const wrapper = mountEntry({ labeled: true });
    await flushPromises();

    expect(entryButton(wrapper).text()).toContain(t("replay.live.pairingEntry"));
  });

  it("deep-links the phone build to the replay pairing wizard", async () => {
    mocks.mobileApp = true;
    const wrapper = mountEntry();
    await flushPromises();

    const btn = entryButton(wrapper);
    expect(btn.attributes("aria-label")).toBe(t("replay.live.pairingEntryHintPhone"));
    await btn.trigger("click");
    await flushPromises();

    expect(mocks.routerPush).toHaveBeenCalledWith({ path: "/replay", query: { pairing: "1" } });
    // The desktop handshake modal never mounts on the phone build.
    expect(wrapper.find(".stub-HkModal").exists()).toBe(false);
  });

  it("opens the desktop handshake modal with the channel essentials", async () => {
    // Service already on and a phone linked: the modal's snapshot poll
    // (refreshPublishStatus on mount) reads THIS state — the online phase
    // pill, the linked-phone count, and the enabled toggle's on segment.
    mocks.getConfig.mockResolvedValue({ root: OFFICIAL_ROOT, enabled: true });
    mocks.publishStatus.mockResolvedValue({ enabled: true, phase: "online", subscribers: 1 });
    const wrapper = mountEntry();
    await flushPromises();

    await entryButton(wrapper).trigger("click");
    await flushPromises();

    const modal = wrapper.find(".stub-HkModal");
    expect(modal.exists()).toBe(true);
    expect(modal.find("h2").text()).toBe(t("replay.live.pairingModalTitle"));
    const text = modal.text();
    // The how-it-works hint, the channel identity, the publish phase,
    // the linked-phone count and the route entry.
    expect(text).toContain(t("gateway.serviceHint"));
    expect(text).toContain("ASIA");
    expect(text).toContain("Tester");
    expect(text).toContain(t("gateway.phaseOnline"));
    expect(text).toContain(t("tray.phoneLinked", { n: 1 }));
    expect(text).toContain(OFFICIAL_ROOT);
    expect(wrapper.find('.stub-HkTabs [data-tab="on"]').attributes("data-active")).toBe("");
  });

  it("enables the mobile service through the shared settings composable", async () => {
    const wrapper = mountEntry();
    await flushPromises();
    await entryButton(wrapper).trigger("click");
    await flushPromises();

    // The segmented control's "on" segment (serviceOff/serviceOn keys).
    const onTab = wrapper.find('.stub-HkTabs [data-tab="on"]');
    expect(onTab.exists()).toBe(true);
    await onTab.trigger("click");
    await flushPromises();

    // Persist + publish on the session-hub route r:<realm>:<accountId>.
    expect(mocks.setConfig).toHaveBeenCalledWith({ enabled: true });
    expect(mocks.publishStart).toHaveBeenCalledWith({ route: "r:asia:123" });
  });

  it("links into the full settings pairing section and closes", async () => {
    const wrapper = mountEntry();
    await flushPromises();
    await entryButton(wrapper).trigger("click");
    await flushPromises();

    const open = wrapper
      .findAll("button.stub-HkBtn")
      .find((b) => b.text().includes(t("replay.live.pairingModalOpenSettings")));
    expect(open).toBeTruthy();
    await open!.trigger("click");
    await flushPromises();

    const settings = useSettingsUiStore();
    expect(settings.visible).toBe(true);
    expect(settings.section).toBe("pairing");
    // The compact surface steps aside for the full section.
    expect(wrapper.find(".stub-HkModal").exists()).toBe(false);
  });
});
