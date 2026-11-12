/**
 * DownloadToast — the shared resource-download pass card.
 *
 * The card is thin store wiring over ToastCardBase, so these tests pin the
 * wiring the refactor exists for: every resource pass renders HERE (never
 * inline in a settings pane), the mount grace keeps instant passes from
 * flashing, the fold-out serves a frozen snapshot, and the cancel action goes
 * through the unified context rather than a per-store copy.
 */
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  resCancel: vi.fn(),
  aiPackCancel: vi.fn(),
  listenDownloadProgress: vi.fn((_handler: unknown) => () => undefined),
}));

vi.mock("@/api", () => ({ api: mocks }));

import { initLocaleMessages, t } from "@/i18n";
import { DOWNLOAD_CARD_GRACE_MS, useDownloadsStore } from "@/stores/downloads";
import DownloadToast from "./DownloadToast";

enableAutoUnmount(afterEach);

const CARD = ".download-toast";

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(CARD);
}

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mount grace", () => {
  it("never mounts for a pass that ends inside the grace", async () => {
    const downloads = useDownloadsStore();
    mount(DownloadToast);

    const pass = downloads.track("res-pack", async () => undefined);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_CARD_GRACE_MS - 1);
    await pass;
    // The pass is over and the card never appeared — the store's success toast
    // is the whole feedback (a flash-in/flash-out reads as a glitch).
    expect(card()).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(card()).toBeNull();
  });

  it("mounts once the pass outlives the grace", async () => {
    const downloads = useDownloadsStore();
    mount(DownloadToast);
    let release!: () => void;
    const pass = downloads.track(
      "res-pack",
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    await vi.advanceTimersByTimeAsync(DOWNLOAD_CARD_GRACE_MS - 1);
    expect(card()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(card()).not.toBeNull();
    expect(card()?.textContent).toContain(t("settings.resPackTitle"));
    release();
    await pass;
  });
});

describe("live pass rendering", () => {
  it("renders the phase line, the percent/speed meta and a determinate bar", async () => {
    const downloads = useDownloadsStore();
    mount(DownloadToast);
    downloads.begin("ai-models");
    downloads.ensureWired();
    const handler = mocks.listenDownloadProgress.mock.calls[0][0] as (p: unknown) => void;
    handler({
      id: "ai-models",
      kind: "ai-models",
      phase: "download",
      received: 512 * 1024,
      total: 1024 * 1024,
      speedBps: 2 * 1024 * 1024,
      detail: { file: "fire_model.onnx" },
      error: null,
    });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_CARD_GRACE_MS + 1);
    await nextTick();

    const text = card()?.textContent ?? "";
    expect(text).toContain(t("settings.resourcesDecisionsName"));
    expect(text).toContain(t("settings.downloadStreaming"));
    expect(text).toContain("50%");
    expect(text).toContain("2.0 MB/s");
    // A known fraction fills the bar instead of animating the indeterminate
    // slide, so the bar and the numbers agree.
    const fill = card()?.querySelector(".toast-card__fill");
    expect(fill?.classList.contains("toast-card__fill--indeterminate")).toBe(false);
    expect((fill as HTMLElement).style.width).toBe("50%");
  });

  it("slides the bar while the phase has no fraction", async () => {
    const downloads = useDownloadsStore();
    mount(DownloadToast);
    downloads.begin("res-pack", "race");
    await vi.advanceTimersByTimeAsync(DOWNLOAD_CARD_GRACE_MS + 1);
    await nextTick();
    const text = card()?.textContent ?? "";
    expect(text).toContain(t("settings.downloadRacing"));
    expect(card()?.querySelector(".toast-card__fill--indeterminate")).not.toBeNull();
  });

  it("offers cancel through the unified context", async () => {
    const downloads = useDownloadsStore();
    mount(DownloadToast);
    downloads.begin("res-pack", "download");
    await vi.advanceTimersByTimeAsync(DOWNLOAD_CARD_GRACE_MS + 1);
    await nextTick();

    const cancel = Array.from(card()?.querySelectorAll(".toast-card__action") ?? []).find(
      (el) => el.textContent === t("settings.cacheCancel"),
    );
    expect(cancel).toBeDefined();
    (cancel as HTMLElement).click();
    await nextTick();
    // The card's cancel IS the registry verb — no per-context copy.
    expect(mocks.resCancel).toHaveBeenCalledTimes(1);
  });

  it("folds out on completion instead of snapping away", async () => {
    const downloads = useDownloadsStore();
    mount(DownloadToast);
    downloads.begin("res-pack", "download");
    await vi.advanceTimersByTimeAsync(DOWNLOAD_CARD_GRACE_MS + 1);
    await nextTick();
    expect(card()).not.toBeNull();

    downloads.settle("res-pack", null);
    await nextTick();
    // The card stays mounted for the leave transition, serving the frozen
    // pass (still saying what finished), then unmounts.
    expect(card()).not.toBeNull();
    expect(card()?.textContent).toContain(t("settings.downloadFinished"));
    await vi.advanceTimersByTimeAsync(1_000);
    await nextTick();
    expect(card()).toBeNull();
  });
});

describe("idle", () => {
  it("renders nothing while every card context is idle", async () => {
    mount(DownloadToast);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(card()).toBeNull();
  });
});
