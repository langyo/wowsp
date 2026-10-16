/**
 * Tests for the after-update success card (UpdateAppliedToast).
 *
 * The card keys off the persisted `wowsp-last-run-version` slot: the
 * installer kills the app and relaunches the new build, so the ONLY way
 * a fresh process knows an update just landed is by comparing the slot
 * against its own `getVersion()`. These tests pin the three boot
 * outcomes of that comparison (moved version / first-ever run / same
 * version) and the 查看 action's landing in the settings' changelog
 * section.
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { initLocaleMessages } from "@/i18n";
import { useSettingsUiStore } from "@/stores/settingsUi";

const mocks = vi.hoisted(() => ({ getVersion: vi.fn() }));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));

// The card gates on the desktop Tauri shell; pin that classification.
vi.mock("@/utils/platform", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/utils/platform")>();
  return {
    ...real,
    isTauri: () => true,
    isMobileApp: () => false,
    isPhoneLayout: () => false,
  };
});

import UpdateAppliedToast from "./UpdateAppliedToast";

enableAutoUnmount(afterEach);

// The card renders through vue-i18n; locale messages load lazily now, so
// the bundle must be in place before the first mount asserts on its text.
beforeAll(async () => {
  await initLocaleMessages();
});

const CARD = ".update-applied";

function mountCard() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(UpdateAppliedToast, { global: { plugins: [pinia] } });
}

beforeEach(() => {
  mocks.getVersion.mockReset();
  localStorage.removeItem("wowsp-last-run-version");
  document.body.innerHTML = "";
});

describe("UpdateAppliedToast", () => {
  it("raises once when the recorded version moved, then lands 查看 on the changelog section", async () => {
    localStorage.setItem("wowsp-last-run-version", "0.4.7");
    mocks.getVersion.mockResolvedValue("0.5.0");

    mountCard();
    await flushPromises();

    const card = document.body.querySelector(CARD);
    expect(card).not.toBeNull();
    // The new version is the headline (locale-agnostic assertion).
    expect(card?.textContent).toContain("0.5.0");

    // The slot must already record the new version, so the card never
    // re-raises on the next boot of the same build.
    expect(localStorage.getItem("wowsp-last-run-version")).toBe("0.5.0");

    // 查看 opens the settings modal straight onto the changelog section
    // and folds the card out.
    const view = document.body.querySelector<HTMLElement>(".update-applied__view");
    expect(view).not.toBeNull();
    view?.click();
    await flushPromises();

    const ui = useSettingsUiStore();
    expect(ui.visible).toBe(true);
    expect(ui.section).toBe("changelog");
    expect(document.body.querySelector(CARD)?.classList).toContain("update-applied--leave");
  });

  it("stays silent on the first-ever run but records the version", async () => {
    mocks.getVersion.mockResolvedValue("0.5.0");

    mountCard();
    await flushPromises();

    expect(document.body.querySelector(CARD)).toBeNull();
    expect(localStorage.getItem("wowsp-last-run-version")).toBe("0.5.0");
  });

  it("stays silent when the version has not moved", async () => {
    localStorage.setItem("wowsp-last-run-version", "0.5.0");
    mocks.getVersion.mockResolvedValue("0.5.0");

    mountCard();
    await flushPromises();

    expect(document.body.querySelector(CARD)).toBeNull();
  });
});
