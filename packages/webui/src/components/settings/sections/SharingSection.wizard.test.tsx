/** The share wizard's open path, pinned: the section renders the enroll
 *  CTA (un-enrolled) and clicking it teleports the wizard HkModal into
 *  body — with AND without bound accounts (the identity picker branches
 *  on the account list, and #1114 introduced that fork). HkModal's
 *  teleported root carries .hk-modal-content (never a bare .hk-modal
 *  class — a selector trap this file exists to document too).
 *
 *  The enrolled card is pinned to the slim shape too: identity + consent
 *  render as read-only tags (NO inline realm/name editor — the wizard's
 *  intro step owns editing), and the wizard window's width matches the
 *  settings shell (58rem) so it reads as a sibling window. */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { HkModal } from "@celestia-island/hikari";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import SharingSection from "./SharingSection";

enableAutoUnmount(afterEach);

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "contribution_state") {
      return Promise.resolve({
        identity: null,
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
  // happy-dom has no Tauri shell: stub the internals isTauri() probes so
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
});
