/** Tests for the sidebar's gateway captcha hint: the PINNED state (mobile
 *  service on + pub socket in the captcha phase opens the card on its own,
 *  anchored right of the game-status card), the verify → publish exchange
 *  (token handed to gateway_publish_start; a captcha-failed rejection
 *  remints the widget via the attempt bump; success unpins), and the
 *  minimize park (a deliberate dismissal wins over the pin until a
 *  settled hover reopens it).
 *
 *  The api module is mocked; HkCaptchaWidget is stubbed with a button
 *  emitting verify (the real widget loads a third-party script). */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";

import { useToast } from "@celestia-island/hikari";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  getHealth: vi.fn(),
  publishStart: vi.fn(),
  publishStop: vi.fn(),
  appdataRead: vi.fn(),
  loadCachedFile: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    gatewayGetConfig: mocks.getConfig,
    gatewaySetConfig: mocks.setConfig,
    gatewayGetHealth: mocks.getHealth,
    gatewayPublishStart: mocks.publishStart,
    gatewayPublishStop: mocks.publishStop,
    appdataRead: mocks.appdataRead,
    listenGatewayState: () => Promise.resolve(() => undefined),
    listenGatewayBattle: () => Promise.resolve(() => undefined),
    listenGatewaySelfhost: () => Promise.resolve(() => undefined),
  },
  GATEWAY_OFFICIAL_ROOT: "https://wowsp.langyo.xyz/gateway/",
  GATEWAY_ROUTE_RE: /^r:[a-z]{2,5}:[0-9]+$/,
}));

import { initLocaleMessages, t } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
import { useSessionStore } from "@/stores/session";
import type { SessionSnapshot } from "@/api";
import { fakeAs } from "@/test-utils/fakes";
import { resetAppliedDpiScaleForTest } from "@/theme/dpiPrefs";
import GatewayCaptchaHint, { REOPEN_DELAY_MS } from "./GatewayCaptchaHint";

enableAutoUnmount(afterEach);

/** Stub standing in for HkCaptchaWidget: a button that emits verify with a
 *  token tagged by the current attempt (so remints are observable). */
const CaptchaStub = defineComponent({
  name: "HkCaptchaWidget",
  props: { siteKey: { type: String, default: "" }, attempt: { type: Number, default: 0 } },
  emits: { verify: (_token: string) => true },
  setup(props, { emit }) {
    return () =>
      h("button", { class: "cap-stub", onClick: () => emit("verify", "tok-" + props.attempt) }, "cap");
  },
});

function stubRect(el: HTMLElement, rect: { right: number; top: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, bottom: 0, width: 0, x: 0, y: 0, ...rect, toJSON: () => ({}) }) as DOMRect;
}

function anchorCard(right = 240, top = 700, height = 40): HTMLElement {
  const el = document.createElement("div");
  stubRect(el, { right, top, height });
  return el;
}

/** Mount the hint around a stubbed anchor with a pinned captcha phase. */
async function mountHint(card: HTMLElement | null = anchorCard()) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const gateway = useGatewayStore();
  gateway.config.root = "https://wowsp.langyo.xyz/gateway/";
  gateway.config.enabled = true;
  gateway.pubPhase = "captcha";
  gateway.pubRoute = "r:asia:123";
  const session = useSessionStore();
  session.snapshot = fakeAs<SessionSnapshot>({
    display: { accountId: 123, nickname: "Tester", realm: "asia", registered: true, playing: false },
  });
  const anchor = ref<HTMLElement | null>(card);
  const wrapper = mount(GatewayCaptchaHint, {
    props: { anchor },
    global: {
      plugins: [pinia],
      stubs: { HkCaptchaWidget: CaptchaStub },
    },
    slots: { default: () => "trigger" },
  });
  await flushPromises();
  return { wrapper, gateway };
}

function pop(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".gateway-captcha-hint__pop");
}

/** Click a control inside the TELEPORTED popup (document.body, outside the
 *  test wrapper's element tree). */
async function clickIn(selector: string): Promise<void> {
  const el = document.body.querySelector<HTMLElement>(selector);
  expect(el, selector + " should exist").not.toBeNull();
  el!.click();
  await flushPromises();
}

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  // The DPI singleton re-reads the documentElement per test: a zoom
  // test's scale must never leak into the unzoomed default.
  delete document.documentElement.dataset.dpiScale;
  document.documentElement.style.removeProperty("zoom");
  resetAppliedDpiScaleForTest();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.appdataRead.mockRejectedValue(new Error("no cache file"));
  mocks.getHealth.mockResolvedValue({
    gateway: "v1",
    auth: { turnstile: { required: true, sitekey: "0xTESTSITEKEY" }, password: { required: false } },
  });
  mocks.publishStart.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.dpiScale;
  document.documentElement.style.removeProperty("zoom");
  resetAppliedDpiScaleForTest();
  const toasts = useToast().toasts;
  for (const slot of [...toasts]) useToast().remove(slot.id);
});

describe("GatewayCaptchaHint", () => {
  it("pins open without hover while the challenge is pending", async () => {
    await mountHint();

    const el = pop();
    expect(el).not.toBeNull();
    // Anchored right of the card, vertically centered on it.
    expect(el?.style.left).toBe("250px");
    expect(el?.style.top).toBe("720px");
    expect(el?.style.transform).toBe("translateY(-50%)");
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.textContent).toContain(t("gateway.captchaTitle"));
  });

  it("divides the anchor geometry by the applied root zoom", async () => {
    // PluginUpdateHint's zoom regression, mirrored for the cloned
    // mechanics: at 125% the unconverted card drifted scale× off the
    // anchor (240 visual / 1.25 + 10 → 202 local; center 720 → 576).
    document.documentElement.dataset.dpiScale = "125";
    resetAppliedDpiScaleForTest();
    await mountHint();

    const el = pop();
    expect(el).not.toBeNull();
    expect(el?.style.left).toBe("202px");
    expect(el?.style.top).toBe("576px");
  });

  it("mounts the widget only after the health document lands", async () => {
    let resolveHealth!: (doc: unknown) => void;
    mocks.getHealth.mockReturnValue(
      new Promise((r) => {
        resolveHealth = r as typeof resolveHealth;
      }),
    );
    await mountHint();

    const el = pop();
    expect(el?.querySelector(".cap-stub")).toBeNull();
    expect(el?.textContent).toContain(t("gateway.captchaLoading"));

    resolveHealth({
      gateway: "v1",
      auth: { turnstile: { required: true, sitekey: "0xTESTSITEKEY" }, password: { required: false } },
    });
    await flushPromises();
    expect(pop()?.querySelector(".cap-stub")).not.toBeNull();
  });

  it("hands a verified token to gateway_publish_start and unpins on success", async () => {
    const { gateway } = await mountHint();

    await clickIn(".cap-stub");

    expect(mocks.publishStart).toHaveBeenCalledWith({
      route: "r:asia:123",
      turnstileToken: "tok-0",
    });
    // The pass landed: phase moves off captcha, the pin lifts, card closes.
    gateway.pubPhase = "online";
    await flushPromises();
    expect(pop()).toBeNull();
  });

  it("remints the widget after a captcha-failed exchange", async () => {
    mocks.publishStart.mockRejectedValue(new Error("gateway captcha verification failed"));
    const { gateway } = await mountHint();

    await clickIn(".cap-stub");
    // The store's start attempt optimistically moved the phase to
    // "resolving"; the backend's captcha re-demand puts it back — replay
    // that event side of the exchange before asserting the remint.
    gateway.pubPhase = "captcha";
    await flushPromises();

    // The card stays pinned; the attempt bump remints a fresh token.
    expect(pop()).not.toBeNull();
    await clickIn(".cap-stub");
    expect(mocks.publishStart).toHaveBeenLastCalledWith({
      route: "r:asia:123",
      turnstileToken: "tok-1",
    });
  });

  it("parks on minimize and reopens on a settled hover of the trigger", async () => {
    const { wrapper } = await mountHint();
    expect(pop()).not.toBeNull();

    await clickIn(".gateway-captcha-hint__min");
    expect(pop()).toBeNull();

    // The park survives while the SAME episode stays pending — the pin
    // alone must not yank the card the user just put away back up.
    await flushPromises();
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(pop()).toBeNull();

    // A settled hover on the trigger unparks it (the debounce keeps a
    // fleeting pass from undoing the dismissal).
    await wrapper.find(".gateway-captcha-hint").trigger("mouseenter");
    vi.advanceTimersByTime(REOPEN_DELAY_MS - 1);
    await flushPromises();
    expect(pop()).toBeNull();
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(pop()).not.toBeNull();
  });

  it("a FRESH captcha episode clears an old park and re-pins", async () => {
    await mountHint();
    await clickIn(".gateway-captcha-hint__min");
    expect(pop()).toBeNull();

    // Phase cycling out and back into captcha = a new challenge demand
    // (a rejected ticket) — the reminder must announce itself again. The
    // two flips need a flush between them: a same-tick round trip is
    // invisible to the watcher (pre-flush batching sees only the end
    // state).
    const gateway = useGatewayStore();
    gateway.pubPhase = "connecting";
    await flushPromises();
    gateway.pubPhase = "captcha";
    await flushPromises();
    expect(pop()).not.toBeNull();
  });

  it("does not pin while the service is off", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const gateway = useGatewayStore();
    gateway.config.enabled = false;
    gateway.pubPhase = "captcha";
    const anchor = ref<HTMLElement | null>(anchorCard());
    mount(GatewayCaptchaHint, {
      props: { anchor },
      global: { plugins: [pinia], stubs: { HkCaptchaWidget: CaptchaStub } },
      slots: { default: () => "trigger" },
    });
    await flushPromises();
    expect(pop()).toBeNull();
  });
});
