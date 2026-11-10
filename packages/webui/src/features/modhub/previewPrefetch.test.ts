/** previewPrefetch: LRU + in-flight dedupe, viewport observation and the
 *  component-scope disposal contract. */
import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogEntry } from "@/api";
import {
  createPreviewPrefetcher,
  usePreviewPrefetch,
  type PreviewPrefetchHandle,
} from "./previewPrefetch";

class FakeImage {
  static instances: FakeImage[] = [];
  onload: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  src = "";

  constructor() {
    FakeImage.instances.push(this);
  }

  finish() {
    this.onload?.();
  }
}

class FakeVideo {
  static instances: FakeVideo[] = [];
  preload = "";
  muted = false;
  playsInline = false;
  src = "";
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeVideo.instances.push(this);
  }

  addEventListener(type: string, fn: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }

  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly elements = new Set<Element>();
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    this.elements.add(el);
  }

  unobserve(el: Element) {
    this.elements.delete(el);
  }

  disconnect() {
    this.disconnected = true;
    this.elements.clear();
  }

  trigger(el: Element) {
    this.callback(
      [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const createImage = () => new FakeImage() as unknown as HTMLImageElement;
const createVideo = () => new FakeVideo() as unknown as HTMLVideoElement;

beforeEach(() => {
  FakeImage.instances = [];
  FakeVideo.instances = [];
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const URL_A = "https://github.com/user-attachments/assets/a.png";
const URL_B = "https://github.com/user-attachments/assets/b.png";
const URL_C = "https://github.com/user-attachments/assets/c.png";
const VIDEO = "https://github.com/langyo/wowsp/releases/download/preview/p.mp4";

describe("prefetchImage", () => {
  it("dedupes in-flight loads for the same URL", async () => {
    const p = createPreviewPrefetcher({ createImage });
    const first = p.prefetchImage(URL_A);
    const second = p.prefetchImage(URL_A);
    expect(second).toBe(first);
    expect(FakeImage.instances).toHaveLength(1);
    expect(p.stats()).toEqual({ pending: 1, tracked: 1, rows: 0 });
    FakeImage.instances[0].finish();
    await first;
    expect(p.stats()).toEqual({ pending: 0, tracked: 1, rows: 0 });
  });

  it("ignores blank URLs and never rejects on an image error", async () => {
    const p = createPreviewPrefetcher({ createImage });
    await expect(p.prefetchImage("")).resolves.toBeUndefined();
    await expect(p.prefetchImage(null)).resolves.toBeUndefined();
    expect(FakeImage.instances).toHaveLength(0);
    const pending = p.prefetchImage(URL_A);
    FakeImage.instances[0].onerror?.();
    await expect(pending).resolves.toBeUndefined();
    expect(p.stats().pending).toBe(0);
  });

  it("keeps at most the configured LRU size and refetches evicted URLs", async () => {
    const p = createPreviewPrefetcher({ limit: 2, createImage });
    for (const url of [URL_A, URL_B, URL_C]) {
      const pending = p.prefetchImage(url);
      FakeImage.instances.at(-1)?.finish();
      await pending;
    }
    expect(p.stats().tracked).toBe(2);
    // A was the oldest and has been evicted: asking again starts a load.
    void p.prefetchImage(URL_A);
    expect(FakeImage.instances).toHaveLength(4);
    expect(p.stats().tracked).toBe(2);
  });
});

describe("prefetchVideo", () => {
  it("dedupes the detached metadata load and releases it on loadedmetadata", async () => {
    const p = createPreviewPrefetcher({ createVideo });
    const first = p.prefetchVideo(VIDEO);
    const second = p.prefetchVideo(VIDEO);
    expect(second).toBe(first);
    expect(FakeVideo.instances).toHaveLength(1);
    const video = FakeVideo.instances[0];
    expect(video.preload).toBe("metadata");
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(p.stats().pending).toBe(1);
    video.dispatch("loadedmetadata");
    await first;
    expect(video.src).toBe("");
    expect(video.listenerCount("loadedmetadata")).toBe(0);
    expect(p.stats().pending).toBe(0);
  });

  it("drops a metadata load at the 8 s timeout", async () => {
    vi.useFakeTimers();
    const p = createPreviewPrefetcher({ createVideo });
    const pending = p.prefetchVideo(VIDEO);
    expect(p.stats().pending).toBe(1);
    vi.advanceTimersByTime(8_000);
    await pending;
    expect(FakeVideo.instances[0].src).toBe("");
    expect(p.stats().pending).toBe(0);
  });
});

describe("observeRow", () => {
  it("warms the image once the row intersects, then stops observing it", () => {
    const p = createPreviewPrefetcher({ createImage });
    const row = document.createElement("button");
    p.observeRow(row, URL_A);
    const io = FakeIntersectionObserver.instances[0];
    expect(io.elements.has(row)).toBe(true);
    expect(io.options?.rootMargin).toBe("300px");
    io.trigger(row);
    expect(FakeImage.instances).toHaveLength(1);
    expect(io.elements.has(row)).toBe(false);
    expect(p.stats().rows).toBe(0);
  });

  it("falls back to an eager warm when IntersectionObserver is absent", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const p = createPreviewPrefetcher({ createImage });
    p.observeRow(document.createElement("button"), URL_A);
    expect(FakeImage.instances).toHaveLength(1);
  });
});

describe("dispose", () => {
  it("disconnects the observer and cancels every in-flight load", () => {
    const p = createPreviewPrefetcher({ createImage, createVideo });
    const row = document.createElement("button");
    p.observeRow(row, URL_A);
    void p.prefetchImage(URL_A);
    void p.prefetchVideo(VIDEO);
    expect(p.stats().pending).toBe(2);
    p.dispose();
    expect(FakeIntersectionObserver.instances[0].disconnected).toBe(true);
    expect(p.stats()).toEqual({ pending: 0, tracked: 0, rows: 0 });
    expect(FakeVideo.instances[0].src).toBe("");
    // Idempotent and inert afterwards.
    expect(() => p.dispose()).not.toThrow();
    expect(() => p.observeRow(row, URL_B)).not.toThrow();
  });
});

describe("usePreviewPrefetch", () => {
  const entry = {
    preview: URL_A,
    previewVideo: VIDEO,
  } as Pick<CatalogEntry, "preview" | "previewVideo">;

  it("prefetches the selected entry's poster + preview-video metadata", async () => {
    const scope = effectScope();
    const selected = ref<CatalogEntry | null>(null);
    let handle: PreviewPrefetchHandle | undefined;
    scope.run(() => {
      handle = usePreviewPrefetch({
        selectedEntry: () => selected.value,
        createImage,
        createVideo,
      });
    });
    selected.value = entry as CatalogEntry;
    await nextTick();
    expect(FakeImage.instances).toHaveLength(1);
    expect(FakeVideo.instances).toHaveLength(1);
    expect(FakeVideo.instances[0].src).toBe(VIDEO);
    scope.stop();
    expect(handle?.stats()).toEqual({ pending: 0, tracked: 0, rows: 0 });
    expect(FakeVideo.instances[0].src).toBe("");
  });
});
