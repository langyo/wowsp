/** Contract tests for the shared useImage() hook.
 *  The hook itself lives in @wowsp/holo (an upstream candidate for hikari's
 *  composable set), but only the webui package runs vitest — so the contract
 *  is pinned here, on the package that consumes it the most. */
import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";

import { useImage } from "@wowsp/holo";

describe("useImage", () => {
  it("reports empty for null / undefined / empty-string sources", async () => {
    for (const empty of [null, undefined, ""] as const) {
      const source = ref(empty);
      const img = useImage(() => source.value);
      expect(img.src.value).toBe("");
      expect(img.status.value).toBe("empty");
      await nextTick();
      expect(img.src.value).toBe("");
      expect(img.status.value).toBe("empty");
    }
  });

  it("starts loading a source and flips to loaded via onLoad", async () => {
    const source = ref("https://example.test/portrait.png");
    const img = useImage(() => source.value);
    await nextTick();
    expect(img.src.value).toBe("https://example.test/portrait.png");
    expect(img.status.value).toBe("loading");
    img.onLoad();
    expect(img.status.value).toBe("loaded");
  });

  it("flips to error via onError while loading", async () => {
    const img = useImage(() => "https://example.test/missing.png");
    await nextTick();
    expect(img.status.value).toBe("loading");
    img.onError();
    expect(img.status.value).toBe("error");
  });

  it("ignores a stale onError after the image already loaded", () => {
    const img = useImage(() => "https://example.test/slow.png");
    img.onLoad();
    expect(img.status.value).toBe("loaded");
    // Superseded requests may still emit an error — loaded must not clobber.
    img.onError();
    expect(img.status.value).toBe("loaded");
  });

  it("retry() re-requests: bumps the key and returns to loading", async () => {
    const img = useImage(() => "https://example.test/retry.png");
    await nextTick();
    const keyBefore = img.key.value;
    img.onError();
    expect(img.status.value).toBe("error");
    img.retry();
    expect(img.status.value).toBe("loading");
    expect(img.key.value).not.toBe(keyBefore);
    // retry() on an empty source is a no-op.
    const empty = useImage(() => null);
    await nextTick();
    const emptyKey = empty.key.value;
    empty.retry();
    expect(empty.key.value).toBe(emptyKey);
  });

  it("resets attempt and status when the source changes", async () => {
    const source = ref<string | null>("https://example.test/first.png");
    const img = useImage(() => source.value);
    await nextTick();
    img.onError();
    img.retry();
    expect(img.status.value).toBe("loading");
    expect(img.key.value).toBe("https://example.test/first.png#1");

    source.value = "https://example.test/second.png";
    await nextTick();
    expect(img.src.value).toBe("https://example.test/second.png");
    expect(img.status.value).toBe("loading");
    expect(img.key.value).toBe("https://example.test/second.png#0");

    // Dropping the source entirely goes back to empty.
    source.value = null;
    await nextTick();
    expect(img.src.value).toBe("");
    expect(img.status.value).toBe("empty");
  });
});
