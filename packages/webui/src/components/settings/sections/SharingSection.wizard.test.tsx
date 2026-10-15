/** The share wizard's open path, pinned: the section renders the enroll
 *  CTA (un-enrolled) and clicking it teleports the wizard HkModal into
 *  body — with AND without bound accounts (the identity picker branches
 *  on the account list, and #1114 introduced that fork). HkModal's
 *  teleported root carries .hk-modal-content (never a bare .hk-modal
 *  class — a selector trap this file exists to document too). */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

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
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
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
});
