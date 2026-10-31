/** The phone-layout title-bar avatar button (the drawer opener): on phone
 *  LAYOUT the hamburger becomes the current-account avatar — dog-tag
 *  emblem, nickname-initial letter, or the neutral disc when no account is
 *  shown — and the tap opens the nav drawer; desktop layout keeps the
 *  plain hamburger. (Layout is viewport-driven: the test drives
 *  window.innerWidth, the same signal hikari's useBreakpoint reads.) */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  appdataRead: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: { appdataRead: mocks.appdataRead },
}));

// The title bar routes nothing itself but rides the router instance
// hooks; the harness has none — the spy is the assertion surface.
vi.mock("vue-router", () => ({
  useRoute: () => ({ path: "/" }),
  useRouter: () => ({ push: mocks.routerPush }),
}));

import { initLocaleMessages, t } from "@/i18n";
import { useAccountStore } from "@/stores/account";
import { useNavUiStore } from "@/stores/navUi";
import { useSessionStore } from "@/stores/session";
import type { SessionSnapshot } from "@/api";
import { fakeAs } from "@/test-utils/fakes";
import AppTitleBar from "./AppTitleBar";

enableAutoUnmount(afterEach);

// happy-dom's innerWidth is a fixed getter — plain assignment is silently
// ignored, so shadow it with a controllable accessor (the same signal
// hikari's useBreakpoint reads).
let viewportWidth = 1024;
Object.defineProperty(window, "innerWidth", {
  get: () => viewportWidth,
  configurable: true,
});

async function mountBar(width: number) {
  viewportWidth = width;
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(AppTitleBar, {
    attachTo: document.body,
    global: { plugins: [pinia] },
    props: { icon: "", title: "WoWSP", subtitle: "" },
  });
  await flushPromises();
  return { wrapper, pinia };
}

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  mocks.routerPush.mockReset();
  mocks.appdataRead.mockReset().mockRejectedValue(new Error("no cache file"));
});

afterEach(() => {
  viewportWidth = 1024;
  document.body.innerHTML = "";
});

describe("AppTitleBar account avatar (phone layout)", () => {
  it("replaces the hamburger with the account avatar and opens the drawer", async () => {
    const { wrapper } = await mountBar(480);
    const accounts = useAccountStore();
    accounts.accounts = [{ realm: "asia", accountId: 123, nickname: "Tester" }];
    accounts.activeRealm = "asia";
    accounts.activeAccountId = 123;
    await flushPromises();

    const btn = wrapper.find(".app-titlebar__account");
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("aria-label")).toBe(t("nav.accountMenu"));
    // No emblem cached → the nickname's initial rides the letter disc.
    expect(btn.find(".app-titlebar__account-letter").text()).toBe("T");

    const navUi = useNavUiStore();
    expect(navUi.open).toBe(false);
    await btn.trigger("click");
    expect(navUi.open).toBe(true);
  });

  it("shows the neutral account disc when no account is bound", async () => {
    await mountBar(480);
    const btn = document.querySelector<HTMLElement>(".app-titlebar__account");
    expect(btn).not.toBeNull();
    // Neither emblem nor letter: the AccountAvatar disc (its glyph span).
    expect(document.querySelector(".app-titlebar__account-letter")).toBeNull();
    expect(document.querySelector(".account-avatar")).not.toBeNull();
  });

  it("keeps the plain hamburger on desktop layout", async () => {
    const { wrapper } = await mountBar(1200);
    expect(wrapper.find(".app-titlebar__account").exists()).toBe(false);
    const menu = wrapper.find(".app-titlebar__menu");
    expect(menu.exists()).toBe(true);
    expect(menu.attributes("aria-label")).toBe(t("nav.openMenu"));
  });

  it("uses the session hub's resolved identity when present", async () => {
    await mountBar(480);
    const session = useSessionStore();
    session.snapshot = fakeAs<SessionSnapshot>({
      display: {
        accountId: 42,
        nickname: "HubPlayer",
        realm: "eu",
        registered: true,
        playing: true,
      },
    });
    await flushPromises();
    const letter = document.querySelector<HTMLElement>(".app-titlebar__account-letter");
    expect(letter?.textContent).toBe("H");
  });
});
