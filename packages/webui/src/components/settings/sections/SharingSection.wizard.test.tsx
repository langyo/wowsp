/** The share wizard's open path, pinned: the section renders the enroll
 *  CTA (un-enrolled) and clicking it teleports the wizard HkModal into
 *  body — with AND without bound accounts (the identity picker branches
 *  on the account list, and #1114 introduced that fork). HkModal's
 *  teleported root carries .hk-modal-content (never a bare .hk-modal
 *  class — a selector trap this file exists to document too).
 *
 *  The enrolled card is pinned to the slim shape too: uploader tags +
 *  consent render as read-only tags (NO inline realm/name editor — the
 *  wizard's intro step owns editing), and the wizard window's width
 *  matches the settings shell (58rem) so it reads as a sibling window.
 *  The uploader tags themselves are pinned separately: one per identity
 *  this machine actually uploaded under, no stop-participating button,
 *  and a volunteer chip click closes the settings window on its way to
 *  the lookup page. */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import { HkModal } from "@celestia-island/hikari";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import SharingSection from "./SharingSection";
import { useSettingsUiStore } from "@/stores/settingsUi";

enableAutoUnmount(afterEach);

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "contribution_state") {
      return Promise.resolve({
        identity: null,
        uploaders: [],
        consentVersion: null,
        anonId: null,
        hasUploadToken: false,
        creditCount: 0,
        stagedCount: 0,
        stagedBytes: 0,
        lastSyncAt: null,
      });
    }
    if (cmd === "contribution_queue") {
      // Defensive: the onMounted re-attach reads q.running unguarded — a
      // settled idle snapshot keeps undefined far from that read.
      return Promise.resolve({
        running: false,
        stage: "idle",
        message: null,
        totalBytes: 0,
        currentBytes: 0,
        doneItems: 0,
        totalItems: 0,
        results: [],
      });
    }
    if (cmd === "list_replays_meta") return Promise.resolve([]);
    if (cmd === "appdata_read") {
      return Promise.resolve(JSON.stringify({
        accounts: [
          { accountId: 1, nickname: "langyo", realm: "asia" },
          { accountId: 2, nickname: "神楽坂柚咲", realm: "cn" },
          { accountId: 3, nickname: "langyo", realm: "ru" },
        ],
        activeAccountId: 1,
        activeRealm: "asia",
      }));
    }
    return Promise.resolve(undefined);
  });
  // happy-dom has no Tauri shell: stub the internals isNative() probes so
  // the lazy transport singleton becomes a TauriTransport whose every
  // invoke lands on mocks.invoke. Without this the browser fetch shim
  // would ECONNREFUSED against the dev-only mock backend and leave the
  // state card stuck on its un-enrolled defaults.
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: { invoke: mocks.invoke },
  };
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("SharingSection wizard", () => {
  it("opens the wizard modal from the enroll CTA (with bound accounts)", async () => {
    const errors: unknown[][] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(SharingSection, {
      attachTo: document.body,
      global: { plugins: [pinia] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("Participate in sharing");
    expect(errors, `setup errors: ${JSON.stringify(errors)}`).toHaveLength(0);

    // The enroll CTA (i18n may resolve keys or en fallback — match either).
    const btn = wrapper
      .findAll("button")
      .find((b) => /enroll|参与共享|Participate/i.test(b.text()));
    expect(btn, "enroll CTA exists").toBeTruthy();
    await btn!.trigger("click");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));

    expect(
      document.body.querySelector(".hk-modal-content"),
      "the wizard modal teleports into body on the enroll CTA",
    ).toBeTruthy();
    expect(errors, `render errors: ${JSON.stringify(errors)}`).toHaveLength(0);
    err.mockRestore();
  });

  it("shows the enrolled card tag-only and opens the wizard at the settings width", async () => {
    const errors: unknown[][] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "contribution_state") {
        return Promise.resolve({
          identity: { realm: "asia", name: "langyo" },
          uploaders: [{ realm: "asia", name: "langyo" }],
          consentVersion: 1,
          anonId: null,
          hasUploadToken: false,
          creditCount: 3,
          stagedCount: 0,
          stagedBytes: 0,
          lastSyncAt: null,
        });
      }
      if (cmd === "contribution_queue") {
        return Promise.resolve({
          running: false,
          stage: "idle",
          message: null,
          totalBytes: 0,
          currentBytes: 0,
          doneItems: 0,
          totalItems: 0,
          results: [],
        });
      }
      if (cmd === "list_replays_meta") return Promise.resolve([]);
      if (cmd === "appdata_read") return Promise.resolve(JSON.stringify({ accounts: [], activeAccountId: null, activeRealm: null }));
      return Promise.resolve(undefined);
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(SharingSection, {
      attachTo: document.body,
      global: { plugins: [pinia] },
    });
    await flushPromises();

    // Slim card: identity reads as a tag row, no inline editor inputs and
    // no terms toggle — the wizard intro owns both. (wrapper.find never
    // reaches the teleported modal tree, so the wizard's own identity row
    // cannot false-positive here even if HkModal mounts it hidden.)
    expect(wrapper.text()).toContain("ASIA · langyo");
    expect(
      wrapper.find(".sharing-sec__identity").exists(),
      "no inline identity editor in the enrolled card",
    ).toBe(false);
    expect(wrapper.findAll("input"), "no editor inputs in the enrolled card").toHaveLength(0);
    expect(
      wrapper.findAll("button").filter((b) => /full terms|完整条款/i.test(b.text())),
      "no terms toggle in the card",
    ).toHaveLength(0);

    // The wizard window matches the settings shell width (SettingsModal's
    // own 58rem), pinned via the HkModal prop.
    const modal = wrapper.findComponent(HkModal);
    expect(modal.exists()).toBe(true);
    expect(modal.props("width")).toBe("58rem");

    // …and the 共享录像… entry still opens it.
    const btn = wrapper
      .findAll("button")
      .find((b) => /share replays|共享录像/i.test(b.text()));
    expect(btn, "share-replays entry exists").toBeTruthy();
    await btn!.trigger("click");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));
    expect(
      document.body.querySelector(".hk-modal-content"),
      "the wizard modal teleports into body on the share entry",
    ).toBeTruthy();
    expect(errors, `render errors: ${JSON.stringify(errors)}`).toHaveLength(0);
    err.mockRestore();
  });

  /** The field report that motivated the mismatch warning: the credits
   *  list held an ASCII `_` where the replays record the CJK lookalike
   *  灬, and a lookup by the credited name found nobody. */
  const typoState = {
    identity: { realm: "cn", name: "万州烤鱼_椒盐味丨蓝博" },
    uploaders: [{ realm: "cn", name: "万州烤鱼_椒盐味丨蓝博" }],
    consentVersion: 1,
    anonId: null,
    hasUploadToken: false,
    creditCount: 1,
    stagedCount: 0,
    stagedBytes: 0,
    lastSyncAt: null,
  };
  function replayRow(playerName: string | null) {
    return [
      {
        path: "D:\\Replays\\20261018_231227.wowsreplay",
        dateTime: "18.10.2026 23:12:27",
        matchGroup: "pvp",
        mapName: "35_NE_no",
        mapId: 15,
        scenario: null,
        eventType: null,
        botCount: 0,
        scriptedUnitCount: 0,
        ownShipId: 4065212112,
        playerName,
        playerCount: 24,
        installPath: null,
        installKind: null,
        installRealm: null,
      },
    ];
  }

  it("warns when the credited name matches none of the scanned recorders", async () => {
    const errors: unknown[][] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "contribution_state") return Promise.resolve(typoState);
      if (cmd === "contribution_queue") {
        return Promise.resolve({
          running: false,
          stage: "idle",
          message: null,
          totalBytes: 0,
          doneItems: 0,
          totalItems: 0,
          results: [],
        });
      }
      if (cmd === "list_replays_meta") {
        return Promise.resolve(replayRow("万州烤鱼灬椒盐味丨蓝博"));
      }
      if (cmd === "appdata_read") return Promise.resolve(JSON.stringify({ accounts: [], activeAccountId: null, activeRealm: null }));
      return Promise.resolve(undefined);
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(SharingSection, {
      attachTo: document.body,
      global: { plugins: [pinia] },
    });
    await flushPromises();

    const btn = wrapper
      .findAll("button")
      .find((b) => /share replays|共享录像/i.test(b.text()));
    expect(btn, "share-replays entry exists").toBeTruthy();
    await btn!.trigger("click");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));

    const modalText =
      document.body.querySelector(".hk-modal-content")?.textContent ?? "";
    expect(modalText).toMatch(/credit name|署名与录像不一致/i);
    // The warning names the REAL recorder the replays carry — the exact
    // string the credited identity should become.
    expect(modalText).toContain("万州烤鱼灬椒盐味丨蓝博");
    expect(errors, `render errors: ${JSON.stringify(errors)}`).toHaveLength(0);
    err.mockRestore();
  });

  it("stays silent when the credited name matches a scanned recorder", async () => {
    const errors: unknown[][] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "contribution_state") {
        return Promise.resolve({
          ...typoState,
          identity: { realm: "cn", name: "万州烤鱼灬椒盐味丨蓝博" },
          uploaders: [{ realm: "cn", name: "万州烤鱼灬椒盐味丨蓝博" }],
        });
      }
      if (cmd === "contribution_queue") {
        return Promise.resolve({
          running: false,
          stage: "idle",
          message: null,
          totalBytes: 0,
          doneItems: 0,
          totalItems: 0,
          results: [],
        });
      }
      if (cmd === "list_replays_meta") {
        return Promise.resolve(replayRow("万州烤鱼灬椒盐味丨蓝博"));
      }
      if (cmd === "appdata_read") return Promise.resolve(JSON.stringify({ accounts: [], activeAccountId: null, activeRealm: null }));
      return Promise.resolve(undefined);
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(SharingSection, {
      attachTo: document.body,
      global: { plugins: [pinia] },
    });
    await flushPromises();

    const btn = wrapper
      .findAll("button")
      .find((b) => /share replays|共享录像/i.test(b.text()));
    await btn!.trigger("click");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));

    const modalText =
      document.body.querySelector(".hk-modal-content")?.textContent ?? "";
    expect(modalText).not.toMatch(/credit name|署名与录像不一致/i);
    expect(errors, `render errors: ${JSON.stringify(errors)}`).toHaveLength(0);
    err.mockRestore();
  });

  it("lists every uploader tag, drops the stop-participating button, and closes settings on a volunteer chip", async () => {
    const errors: unknown[][] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "contribution_state") {
        return Promise.resolve({
          identity: { realm: "asia", name: "langyo" },
          // Two uploads ran from this machine: one under the own
          // identity, one on a friend's behalf (代传).
          uploaders: [
            { realm: "asia", name: "langyo" },
            { realm: "cn", name: "神楽坂柚咲" },
          ],
          consentVersion: 1,
          anonId: null,
          hasUploadToken: false,
          creditCount: 5,
          stagedCount: 0,
          stagedBytes: 0,
          lastSyncAt: null,
        });
      }
      if (cmd === "contribution_queue") {
        return Promise.resolve({
          running: false,
          stage: "idle",
          message: null,
          totalBytes: 0,
          currentBytes: 0,
          doneItems: 0,
          totalItems: 0,
          results: [],
        });
      }
      if (cmd === "list_replays_meta") return Promise.resolve([]);
      if (cmd === "appdata_read") return Promise.resolve(JSON.stringify({ accounts: [], activeAccountId: null, activeRealm: null }));
      return Promise.resolve(undefined);
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    // The volunteer chips navigate to the lookup page — a memory router
    // keeps the push local to the test.
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/lookup", component: { template: "<div />" } },
        { path: "/", component: { template: "<div />" } },
      ],
    });
    await router.push("/");
    const ui = useSettingsUiStore();
    ui.visible = true;

    const wrapper = mount(SharingSection, {
      attachTo: document.body,
      global: { plugins: [pinia, router] },
    });
    await flushPromises();
    await router.isReady();

    // One tag per uploader, first-recorded order (the status card's meta
    // row renders the uploaders vec verbatim).
    const text = wrapper.text();
    expect(text).toContain("ASIA · langyo");
    expect(text).toContain("CN · 神楽坂柚咲");
    expect(
      text.indexOf("ASIA · langyo"),
      "uploader tags keep first-recorded order",
    ).toBeLessThan(text.indexOf("CN · 神楽坂柚咲"));

    // The stop-participating button is gone for good — no armed confirm
    // either (the contributor record is not a revocable enrollment).
    expect(
      wrapper
        .findAll("button")
        .filter((b) => /stop participating|停止参与|dejar de participar|arrêter la participation|参加を停止|참여 중단|прекратить участие|停止參與/i.test(b.text())),
      "no stop-participating button remains",
    ).toHaveLength(0);

    // A volunteer chip closes the settings window on its way to /lookup.
    // (The chips list the bundled contributors doc — 刮痧之王奈里夫 is one
    // of the four bundled CN volunteers.)
    const chip = wrapper
      .findAll("button")
      .find((b) => /刮痧之王奈里夫/.test(b.text()) && b.classes().join(" ").includes("contrib-chip"));
    expect(chip, "contributor chip exists").toBeTruthy();
    await chip!.trigger("click");
    await flushPromises();
    expect(ui.visible, "settings window auto-closes").toBe(false);
    expect(router.currentRoute.value.path).toBe("/lookup");
    expect(errors, `render errors: ${JSON.stringify(errors)}`).toHaveLength(0);
    err.mockRestore();
  });

  it("picks the credited identity from the account picker window", async () => {
    const errors: unknown[][] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(SharingSection, {
      attachTo: document.body,
      global: { plugins: [pinia] },
    });
    await flushPromises();

    // Open the wizard (the default mocks bind three accounts) and find its
    // teleported surface.
    const btn = wrapper
      .findAll("button")
      .find((b) => /enroll|参与共享|Participate/i.test(b.text()));
    expect(btn, "enroll CTA exists").toBeTruthy();
    await btn!.trigger("click");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));
    const wizard = [...document.body.querySelectorAll(".hk-modal-content")].find(
      (m) => m.querySelector(".sharing-sec__identity"),
    );
    expect(wizard, "wizard modal found").toBeTruthy();

    // The intro step's single identity control is the select-chrome
    // trigger; the old inline realm/name free-form fields are gone (the
    // only input left is the consent checkbox).
    const trigger = wizard!.querySelector<HTMLButtonElement>("button.hk-select-trigger");
    expect(trigger, "identity trigger exists").toBeTruthy();
    expect(
      wizard!.querySelectorAll('input:not([type="checkbox"])'),
      "no free-form identity inputs",
    ).toHaveLength(0);

    // Clicking it opens the picker window with one card per bound account
    // — no drag handles, preferred stars or remove buttons there.
    trigger!.click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));
    const cards = document.body.querySelectorAll(".acct-card:not(.acct-card--preview)");
    expect(cards.length, "one card per bound account").toBe(3);
    expect(
      document.body.querySelectorAll(".acct-card__remove, .acct-card__promote, .hk-draggable-list-handle"),
      "picker cards carry no manage affordances",
    ).toHaveLength(0);

    // Picking the CN card credits that identity in the wizard's draft.
    const cnCard = [...cards].find((c) => c.textContent?.includes("神楽坂柚咲"));
    expect(cnCard, "CN account card exists").toBeTruthy();
    (cnCard as HTMLElement).click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));
    expect(trigger!.textContent).toContain("神楽坂柚咲");
    expect(trigger!.textContent).toContain("CN");

    // Consent, then 下一步: the footer persists the picked identity through
    // the Rust command on leaving the intro step.
    const checkbox = wizard!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox, "consent checkbox exists").toBeTruthy();
    checkbox!.click();
    await flushPromises();
    const next = [...document.body.querySelectorAll("button")].find((b) =>
      /next|下一步/i.test(b.textContent ?? ""),
    );
    expect(next, "wizard next button exists").toBeTruthy();
    (next as HTMLElement).click();
    await flushPromises();
    const setCall = mocks.invoke.mock.calls.find((c) => c[0] === "contribution_set_identity");
    expect(setCall, "identity persisted on next").toBeTruthy();
    expect(setCall![1]).toMatchObject({ realm: "cn", name: "神楽坂柚咲" });

    expect(errors, `render errors: ${JSON.stringify(errors)}`).toHaveLength(0);
    err.mockRestore();
  });
});
