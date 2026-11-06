/** Shared copy-shot kit: every generation announces a "generating" toast
 *  before rendering, and a repeat click on the SAME content copies the
 *  cached bytes (success toast, no second render). */
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { useToast } from "@celestia-island/hikari";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ copyImageToClipboard: vi.fn(async () => {}) }));

vi.mock("@/api", () => ({
  api: {
    copyImageToClipboard: mocks.copyImageToClipboard,
  },
}));

import { useShareImage } from "./useShareImage";

function mountKit(render: () => Promise<Uint8Array>, signature?: () => string | number) {
  const kit = { shot: null as ReturnType<typeof useShareImage> | null };
  const Comp = defineComponent({
    setup() {
      kit.shot = useShareImage(render, { signature });
      return () => h("div", "shot");
    },
  });
  const wrapper = mount(Comp);
  return { wrapper, kit: kit as { shot: ReturnType<typeof useShareImage> } };
}

function toastTexts(): string[] {
  return useToast().toasts.flatMap((slot) => slot.messages.map((msg) => msg.text));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const slot of [...useToast().toasts]) useToast().remove(slot.id);
});

describe("useShareImage generation flow", () => {
  it("announces generation, then copies and reports success", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const render = vi.fn(async () => bytes);
    const { kit } = mountKit(render);
    await kit.shot!.copyShot();
    expect(render).toHaveBeenCalledTimes(1);
    expect(mocks.copyImageToClipboard).toHaveBeenCalledWith(bytes);
    const texts = toastTexts();
    expect(texts).toContain("share.copyShotGenerating");
    expect(texts).toContain("share.copyShotDone");
  });

  it("re-copies a cached shot without rendering again", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const render = vi.fn(async () => bytes);
    const { kit } = mountKit(render);
    await kit.shot!.copyShot();
    await kit.shot!.copyShot();
    expect(render).toHaveBeenCalledTimes(1);
    expect(mocks.copyImageToClipboard).toHaveBeenCalledTimes(2);
    // The second click reports success directly (no second "generating"):
    // the render ran once, the clipboard received both clicks, and exactly
    // one generating toast exists.
    const generating = toastTexts().filter((text) => text === "share.copyShotGenerating");
    expect(generating).toHaveLength(1);
    expect(toastTexts()).toContain("share.copyShotDone");
  });

  it("re-renders when the content signature changes", async () => {
    const render = vi.fn(async () => new Uint8Array([1, 2, 3]));
    let sig = "a";
    const { kit } = mountKit(render, () => sig);
    await kit.shot!.copyShot();
    await kit.shot!.copyShot();
    expect(render).toHaveBeenCalledTimes(1);
    sig = "b";
    await kit.shot!.copyShot();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("keeps the rendered bytes when the clipboard write fails, so a retry is free", async () => {
    const render = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const nav = navigator as { clipboard?: unknown };
    const original = nav.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      mocks.copyImageToClipboard.mockRejectedValueOnce(new Error("denied"));
      const { kit } = mountKit(render);
      await kit.shot!.copyShot();
      expect(toastTexts()).toContain("share.copyShotFailed");
      // The bytes survived the failed copy: the retry skips the render.
      await kit.shot!.copyShot();
      expect(render).toHaveBeenCalledTimes(1);
      expect(toastTexts()).toContain("share.copyShotDone");
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
    }
  });
});
