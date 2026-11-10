/**
 * Dynamic preview-media prefetch for the online catalog.
 *
 * The product ask is that every pack's preview loads dynamically: nothing
 * streams until the user looks at (or selects) a row. Two prefetch channels
 * feed the same small LRU (12 URLs, dedupe of in-flight loads — the same
 * URL is never fetched twice concurrently, and re-requesting a settled URL
 * is a no-op while it stays in the LRU):
 *
 * - **Row visibility**: a catalog row's preview image is warmed once the
 *   row scrolls within `rootMargin: 300px` of the viewport. The rows are
 *   plain render functions, so the wiring is a Vue directive
 *   (`rowDirective`) backed by one shared IntersectionObserver.
 * - **Selection**: the selected entry's `preview_video` metadata is warmed
 *   with a detached, muted, `playsinline` <video preload="metadata">
 *   (held until `loadedmetadata` / `error` / an 8 s timeout), and its
 *   poster image through `new Image()`. Nothing is appended to the DOM.
 *
 * The prefetcher never throws: unreadable URLs, absent `Image`/`video`
 * constructors, a missing IntersectionObserver and media errors all resolve
 * quietly. `dispose()` (run automatically by `usePreviewPrefetch` on scope
 * teardown) disconnects the observer, drops every held video element and
 * resolves pending promises, so no listener outlives the view.
 *
 * Network behaviour is the browser's: the warmed request lands in the HTTP
 * cache, and the later <img>/player request reuses it. Images ride the same
 * URL the rows render (already passed through mediaImageUrl by the caller).
 */
import { onScopeDispose, watch, type Directive } from "vue";

import type { CatalogEntry } from "@/api";
import { mediaImageUrl } from "@/utils/media";

/** LRU capacity: a sidebar viewport rarely shows more than a dozen rows. */
const DEFAULT_LIMIT = 12;
/** A row this close to the viewport starts warming its preview. */
const VIEWPORT_MARGIN_PX = 300;
/** Metadata loads that never settle are dropped after this long. */
const VIDEO_METADATA_TIMEOUT_MS = 8_000;

export interface PreviewPrefetcherOptions {
  /** LRU capacity (default 12). */
  limit?: number;
  /** Detached video metadata timeout (default 8 s). */
  videoTimeoutMs?: number;
  /** Test seam: image factory (defaults to `new Image()`). */
  createImage?: () => HTMLImageElement;
  /** Test seam: video factory (defaults to `document.createElement("video")`). */
  createVideo?: () => HTMLVideoElement;
}

export interface PreviewPrefetchStats {
  /** Loads still waiting for their image/video event. */
  pending: number;
  /** URLs remembered by the LRU (in-flight + recently settled). */
  tracked: number;
  /** Rows currently watched by the IntersectionObserver. */
  rows: number;
}

export interface PreviewPrefetcher {
  /** Warm one image URL (deduped; resolves even on error). */
  prefetchImage(url: string | null | undefined): Promise<void>;
  /** Warm one video's metadata (detached element; deduped). */
  prefetchVideo(url: string | null | undefined): Promise<void>;
  /** Warm the selected entry's poster image + `preview_video` metadata. */
  prefetchEntry(
    entry: Pick<CatalogEntry, "preview" | "previewVideo"> | null | undefined,
  ): void;
  /** Watch a row: warm its image once it nears the viewport. */
  observeRow(el: Element | null | undefined, url: string | null | undefined): void;
  /** Stop watching a row (idempotent). */
  unobserveRow(el: Element | null | undefined): void;
  /** Release every observer, listener and held element (idempotent). */
  dispose(): void;
  /** Observable bookkeeping (tests / debugging). */
  stats(): PreviewPrefetchStats;
}

interface LoadState {
  settled: boolean;
  cancel: () => void;
}

interface TrackedLoad {
  promise: Promise<void>;
  state: LoadState;
}

function normalizeUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface PreviewPrefetcherInternals {
  createImage(): HTMLImageElement;
  createVideo(): HTMLVideoElement;
}

/**
 * The pure prefetcher (no Vue lifecycle). `usePreviewPrefetch` layers the
 * selection watcher + directive and ties disposal to the component scope;
 * tests drive this directly.
 */
export function createPreviewPrefetcher(
  options: PreviewPrefetcherOptions = {},
): PreviewPrefetcher {
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT));
  const videoTimeoutMs = Math.max(1, options.videoTimeoutMs ?? VIDEO_METADATA_TIMEOUT_MS);
  const internals: PreviewPrefetcherInternals = {
    createImage: options.createImage ?? (() => new Image()),
    createVideo: options.createVideo ?? (() => document.createElement("video")),
  };

  // Map insertion order is the LRU order: oldest first, newest last.
  const loads = new Map<string, TrackedLoad>();
  const heldVideos = new Set<HTMLVideoElement>();
  const rowUrls = new Map<Element, string>();
  let observer: IntersectionObserver | null = null;
  let disposed = false;

  /** Move a known URL to the most-recent end; return its tracked load. */
  function touch(url: string): TrackedLoad | undefined {
    const load = loads.get(url);
    if (!load) return undefined;
    loads.delete(url);
    loads.set(url, load);
    return load;
  }

  function markSettled(url: string) {
    const load = loads.get(url);
    if (load) load.state.settled = true;
  }

  /** Evict the oldest URL(s) beyond the capacity, cancelling in-flight work. */
  function enforceLimit() {
    while (loads.size > limit) {
      const first = loads.entries().next();
      if (first.done) return;
      const [url, load] = first.value;
      loads.delete(url);
      if (!load.state.settled) load.state.cancel();
    }
  }

  function prefetchImage(raw: string | null | undefined): Promise<void> {
    const url = normalizeUrl(raw);
    if (!url || disposed) return Promise.resolve();
    const existing = touch(url);
    if (existing) return existing.promise;

    const state: LoadState = { settled: false, cancel: () => {} };
    const promise = new Promise<void>((resolve) => {
      const settle = () => {
        if (state.settled) return;
        state.settled = true;
        resolve();
      };
      state.cancel = settle;
      try {
        const image = internals.createImage();
        image.onload = () => {
          image.onload = null;
          image.onerror = null;
          settle();
        };
        image.onerror = () => {
          image.onload = null;
          image.onerror = null;
          settle();
        };
        image.src = url;
      } catch {
        settle();
      }
    }).then(() => markSettled(url));
    loads.set(url, { promise, state });
    enforceLimit();
    return promise;
  }

  function prefetchVideo(raw: string | null | undefined): Promise<void> {
    const url = normalizeUrl(raw);
    if (!url || disposed) return Promise.resolve();
    const existing = touch(url);
    if (existing) return existing.promise;

    const state: LoadState = { settled: false, cancel: () => {} };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve) => {
      let video: HTMLVideoElement | null = null;
      const finish = () => {
        if (state.settled) return;
        state.settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (video) {
          try {
            video.removeEventListener("loadedmetadata", finish);
            video.removeEventListener("error", finish);
            video.removeAttribute("src");
          } catch {
            // Detached element with a hostile stub — nothing else to free.
          }
          heldVideos.delete(video);
          video = null;
        }
        resolve();
      };
      state.cancel = finish;
      try {
        video = internals.createVideo();
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;
        video.addEventListener("loadedmetadata", finish);
        video.addEventListener("error", finish);
        timer = setTimeout(finish, videoTimeoutMs);
        video.src = url;
        heldVideos.add(video);
      } catch {
        finish();
      }
    }).then(() => markSettled(url));
    loads.set(url, { promise, state });
    enforceLimit();
    return promise;
  }

  function prefetchEntry(
    entry: Pick<CatalogEntry, "preview" | "previewVideo"> | null | undefined,
  ): void {
    if (disposed || !entry) return;
    try {
      if (entry.previewVideo) void prefetchVideo(entry.previewVideo);
      if (entry.preview) void prefetchImage(mediaImageUrl(entry.preview));
    } catch {
      // Prefetch is best-effort; a malformed entry never breaks the pane.
    }
  }

  function ensureObserver(): IntersectionObserver | null {
    if (observer || disposed) return observer;
    if (typeof IntersectionObserver === "undefined") return null;
    try {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const url = rowUrls.get(entry.target);
            if (!url) continue;
            // One-shot: once warmed, the row stops costing observer work.
            unobserveRow(entry.target);
            void prefetchImage(url);
          }
        },
        { rootMargin: `${VIEWPORT_MARGIN_PX}px` },
      );
    } catch {
      observer = null;
    }
    return observer;
  }

  function observeRow(
    el: Element | null | undefined,
    rawUrl: string | null | undefined,
  ): void {
    if (disposed || !el) return;
    const url = normalizeUrl(rawUrl);
    const current = rowUrls.get(el);
    if (current === (url ?? undefined)) return;
    if (current) unobserveRow(el);
    if (!url) return;
    rowUrls.set(el, url);
    const io = ensureObserver();
    if (!io) {
      // No IntersectionObserver (old webview / test environment): warming
      // is still safe, just not viewport-gated.
      void prefetchImage(url);
      return;
    }
    try {
      io.observe(el);
    } catch {
      rowUrls.delete(el);
    }
  }

  function unobserveRow(el: Element | null | undefined): void {
    if (!el) return;
    rowUrls.delete(el);
    try {
      observer?.unobserve(el);
    } catch {
      // Stub observers may throw for unknown targets; the map is the truth.
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      observer?.disconnect();
    } catch {
      // ignore
    }
    observer = null;
    rowUrls.clear();
    for (const load of loads.values()) {
      if (!load.state.settled) load.state.cancel();
    }
    loads.clear();
    for (const video of [...heldVideos]) {
      try {
        video.removeAttribute("src");
      } catch {
        // ignore
      }
    }
    heldVideos.clear();
  }

  function stats(): PreviewPrefetchStats {
    let pending = 0;
    for (const load of loads.values()) {
      if (!load.state.settled) pending += 1;
    }
    return { pending, tracked: loads.size, rows: rowUrls.size };
  }

  return {
    prefetchImage,
    prefetchVideo,
    prefetchEntry,
    observeRow,
    unobserveRow,
    dispose,
    stats,
  };
}

export interface PreviewPrefetchOptions extends PreviewPrefetcherOptions {
  /** Reactive getter for the selected catalog entry (null when none). */
  selectedEntry?: () => CatalogEntry | null | undefined;
}

export interface PreviewPrefetchHandle extends PreviewPrefetcher {
  /** Vue directive for catalog rows: `v-prefetch-row="imageUrl"`. */
  rowDirective: Directive<HTMLElement, string | null | undefined>;
}

/**
 * Component-scoped prefetcher: watches the selected entry (poster image +
 * preview-video metadata) and returns a row directive for the sidebar.
 * Everything is disposed when the owning scope stops.
 */
export function usePreviewPrefetch(
  options: PreviewPrefetchOptions = {},
): PreviewPrefetchHandle {
  const { selectedEntry, ...prefetcherOptions } = options;
  const prefetcher = createPreviewPrefetcher(prefetcherOptions);

  const rowDirective: Directive<HTMLElement, string | null | undefined> = {
    mounted(el, binding) {
      prefetcher.observeRow(el, binding.value);
    },
    updated(el, binding) {
      if (binding.value !== binding.oldValue) {
        prefetcher.observeRow(el, binding.value);
      }
    },
    unmounted(el) {
      prefetcher.unobserveRow(el);
    },
  };

  if (selectedEntry) {
    watch(
      selectedEntry,
      (entry) => {
        if (entry) prefetcher.prefetchEntry(entry);
      },
      { immediate: true },
    );
  }
  onScopeDispose(() => prefetcher.dispose());

  return {
    prefetchImage: prefetcher.prefetchImage,
    prefetchVideo: prefetcher.prefetchVideo,
    prefetchEntry: prefetcher.prefetchEntry,
    observeRow: prefetcher.observeRow,
    unobserveRow: prefetcher.unobserveRow,
    dispose: prefetcher.dispose,
    stats: prefetcher.stats,
    rowDirective,
  };
}
