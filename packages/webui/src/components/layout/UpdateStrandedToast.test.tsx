/**
 * Tests for the stranded-update recovery card (UpdateStrandedToast).
 *
 * The verdict arrives AFTER mount (the store's startup init is async),
 * and the wrapper renders nothing until then — the watcher must survive
 * the template-ref binding order (flush: "post") or the card never
 * rises. Pins: the raise with both recovery pills, the reinstall pill's
 * recovering-disabled state, and a pill folding the card away.
 *
 * The card Teleports to document.body, so queries scope there; the
 * leave window is delayed, so the fold asserts the --leave modifier
 * (not the unmount).
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { initLocaleMessages } from "@/i18n";
import { useUpdaterStore } from "@/stores/updater";

vi.mock("@/utils/platform", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/utils/platform")>();
  return {
    ...real,
    isNative: () => true,
    isMobileApp: () => false,
    isPhoneLayout: () => false,
  };
});

import UpdateStrandedToast from "./UpdateStrandedToast";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

const CARD = ".update-stranded";

const cardEl = () => document.body.querySelector<HTMLElement>(CARD);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("UpdateStrandedToast", () => {
  it("stays hidden until the verdict lands, then raises with both pills", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(UpdateStrandedToast, { global: { plugins: [pinia] } });
    const updater = useUpdaterStore(pinia);
    expect(cardEl()).toBeNull();

    // The startup reconciliation lands after mount (async init) — the
    // flush:"post" watcher must fire with the base ref already bound,
    // or the card never rises.
    updater.stranded = { expected: "1.2.3", installer_ready: true };
    await flushPromises();

    const card = cardEl()!;
    expect(card).not.toBeNull();
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.classList.contains("update-stranded--leave")).toBe(false);
    expect(card.querySelector(".update-stranded__reinstall")).not.toBeNull();
    expect(card.querySelector(".update-stranded__download")).not.toBeNull();
    wrapper.unmount();
  });

  it("disables the reinstall pill while a recovery pass runs", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(UpdateStrandedToast, { global: { plugins: [pinia] } });
    const updater = useUpdaterStore(pinia);
    updater.stranded = { expected: "1.2.3", installer_ready: true };
    await flushPromises();

    updater.recovering = true;
    await flushPromises();
    expect(cardEl()!.querySelector(".update-stranded__reinstall")!.hasAttribute("disabled")).toBe(true);
    wrapper.unmount();
  });

  it("folds the card when a recovery pill runs its fallback", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(UpdateStrandedToast, { global: { plugins: [pinia] } });
    const updater = useUpdaterStore(pinia);
    const download = vi.spyOn(updater, "openDownloadPage").mockResolvedValue();
    updater.stranded = { expected: "1.2.3", installer_ready: false };
    await flushPromises();

    // installer_ready false → only the download fallback pill renders.
    expect(cardEl()!.querySelector(".update-stranded__reinstall")).toBeNull();
    new DOMWrapper(cardEl()!.querySelector(".update-stranded__download")!).trigger("click");
    expect(download).toHaveBeenCalledTimes(1);

    // The fold is delayed (the base's leave window) — the card carries
    // the --leave modifier immediately and retires after it.
    await flushPromises();
    expect(cardEl()!.classList.contains("update-stranded--leave")).toBe(true);
    wrapper.unmount();
  });
});
