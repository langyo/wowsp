/**
 * Tests for the settings' changelog pane (ChangelogSection + its store).
 *
 * The pane renders store state only — SettingsBody's section activators
 * are what load the feed — so these tests drive the store directly
 * against a mocked `changelog_list` and pin the rendered outcomes: the
 * release list (version chips, markdown body, PR links, the 当前 badge
 * on the running build), the progressive stream (scroll sentinel pulls
 * the next batch, end marker on exhaustion) and the mirror-ladder
 * failure state.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { RPC } from "@/rpc";
import { useChangelogStore, type ChangelogRelease } from "@/stores/changelog";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));

import ChangelogSection from "./ChangelogSection";

enableAutoUnmount(afterEach);

const RELEASES: ChangelogRelease[] = [
  {
    version: "0.4.6",
    published_at: "2026-09-24T04:09:10Z",
    body: [
      "## What's Changed",
      "",
      "### ✨ Features",
      "",
      "- [#532](https://github.com/langyo/wowsp/pull/532) ✨ Split live battle into its own page and add map tactics analysis.",
      "",
      "### 🐛 Fixes",
      "",
      "- [#511](https://github.com/langyo/wowsp/pull/511) 🐛 Keep live roster seals on the card's right edge for both teams.",
    ].join("\n"),
  },
  {
    version: "0.4.5",
    published_at: "2026-09-22T05:43:17Z",
    body: "**Hardened** the installer flow.",
  },
];

const OLDER: ChangelogRelease[] = [
  {
    version: "0.4.4",
    published_at: "2026-09-20T00:00:00Z",
    body: "Older notes.",
  },
  // A release published between two loads would surface on both pages —
  // the store's dedupe must drop the second sighting.
  {
    version: "0.4.6",
    published_at: "2026-09-24T04:09:10Z",
    body: "## What's Changed",
  },
];

/** Test double for the scroll sentinel's observer: happy-dom's own
 *  IntersectionObserver never fires, so the stream tests drive the
 *  captured callback directly. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.getVersion.mockReset().mockResolvedValue("0.4.6");
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Mount attached to the body — the pane renders in place (no Teleport),
 *  so the shared document.body queries only see it when attached. */
function mountSection() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ChangelogSection, { attachTo: document.body, global: { plugins: [pinia] } });
}

/** Fresh page payload per call — the store keeps the array it is given
 *  (loadMore pushes onto it), so a module-level fixture must never be
 *  handed out by reference: one test's batch would leak into the next. */
function pageOf(releases: ChangelogRelease[], has_more: boolean, next_page: number) {
  return { releases: structuredClone(releases), has_more, next_page };
}

describe("ChangelogSection", () => {
  it("renders the release feed with chips, markdown bodies, links and the current badge", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === RPC.changelog_list) {
        return Promise.resolve(pageOf(RELEASES, true, 2));
      }
      return Promise.resolve(undefined);
    });

    mountSection();
    const changelog = useChangelogStore();
    void changelog.refresh();
    await flushPromises();

    const text = document.body.textContent ?? "";
    // Version chips, newest first.
    expect(text).toContain("v0.4.6");
    expect(text).toContain("v0.4.5");
    // Markdown body rendered as text (headings + bullets), links as
    // buttons instead of raw anchors or v-html.
    expect(text).toContain("What's Changed");
    expect(text).toContain("Split live battle into its own page");
    expect(text).toContain("Keep live roster seals");
    // Inline **bold** markers are consumed, not shown.
    expect(text).toContain("Hardened");
    expect(text).not.toContain("**Hardened**");

    const links = document.body.querySelectorAll(".release-md__link");
    expect(links.length).toBe(2);
    expect(links[0].textContent).toBe("#532");

    // The running build (0.4.6) carries the 当前/current badge; the
    // older release does not.
    const badges = document.body.querySelectorAll(".changelog__current");
    expect(badges.length).toBe(1);
    const first = document.body.querySelector(".changelog__release");
    expect(first?.querySelector(".changelog__current")).not.toBeNull();

    // More batches exist: the stream is armed and the end marker waits.
    expect(document.body.querySelector(".changelog__sentinel")).not.toBeNull();
    expect(document.body.querySelector(".changelog__end")).toBeNull();
  });

  it("streams the next batch when the sentinel intersects, then shows the end marker", async () => {
    const calls: Array<unknown> = [];
    mocks.invoke.mockImplementation((_cmd: string, args?: unknown) => {
      calls.push(args);
      return Promise.resolve(
        calls.length === 1 ? pageOf(RELEASES, true, 2) : pageOf(OLDER, false, 0),
      );
    });

    mountSection();
    const changelog = useChangelogStore();
    void changelog.refresh();
    await flushPromises();

    expect(document.body.textContent).toContain("v0.4.6");
    expect(document.body.textContent).not.toContain("v0.4.4");

    const observer = FakeIntersectionObserver.instances.at(-1);
    expect(observer).toBeTruthy();
    observer!.callback([{ isIntersecting: true }]);
    await flushPromises();

    // The second call carried the raw-page cursor straight back.
    expect(calls[1]).toEqual({ page: 2 });
    expect(document.body.textContent).toContain("v0.4.4");
    // The duplicate 0.4.6 sighting on the second page was dropped.
    expect(document.body.querySelectorAll(".changelog__release").length).toBe(3);
    // List exhausted: end marker in, sentinel out.
    expect(document.body.querySelector(".changelog__end")).not.toBeNull();
    expect(document.body.querySelector(".changelog__sentinel")).toBeNull();
  });

  it("discards an in-flight older batch when refresh restarts the stream", async () => {
    // happy-dom reports zero rects, which would let the post-load rescan
    // immediately fire a NEW (legitimate) tail request and muddy the
    // race under test — park the sentinel far below the viewport so only
    // the stale batch is in flight.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 10000 } as DOMRect);
    let releaseTail: ((v: unknown) => void) | null = null;
    mocks.invoke.mockImplementation((_cmd: string, args?: { page?: number }) => {
      if ((args?.page ?? 1) === 1) {
        return Promise.resolve(pageOf(RELEASES, true, 2));
      }
      return new Promise((resolve) => {
        releaseTail = resolve;
      });
    });

    mountSection();
    const changelog = useChangelogStore();
    void changelog.refresh();
    await flushPromises();

    // Stream the tail: the request hangs until we let it go.
    const observer = FakeIntersectionObserver.instances.at(-1);
    observer!.callback([{ isIntersecting: true }]);
    await flushPromises();
    expect(changelog.loadingMore).toBe(true);

    // Refresh restarts the stream while the tail request is in flight.
    void changelog.refresh();
    await flushPromises();

    // The stale tail lands late — it must not append onto the new list
    // or clobber the restarted stream's cursor.
    releaseTail!(pageOf(OLDER, false, 0));
    await flushPromises();
    rectSpy.mockRestore();

    expect(document.body.querySelectorAll(".changelog__release").length).toBe(2);
    expect(document.body.textContent).not.toContain("v0.4.4");
    expect(changelog.hasMore).toBe(true);
    expect(changelog.nextPage).toBe(2);
  });

  it("renders the failure state when every mirror fails", async () => {
    mocks.invoke.mockRejectedValue("no mirror attempted for the changelog");

    mountSection();
    const changelog = useChangelogStore();
    void changelog.refresh();
    await flushPromises();

    expect(document.body.querySelector(".hk-error-landing")).not.toBeNull();
    expect(document.body.querySelector(".hk-error-landing.is-fill")).not.toBeNull();
    // The group hands the rest of the pane to the fill-seated card.
    const errorGroup = document.body.querySelector(".changelog__error-fill");
    expect(errorGroup).not.toBeNull();
    expect(errorGroup!.classList.contains("hk-settings-group")).toBe(true);
    expect(document.body.querySelector(".changelog__release")).toBeNull();
    expect(changelog.error).toContain("no mirror");

    // A later successful refresh replaces the failure with the feed.
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === RPC.changelog_list
        ? Promise.resolve(pageOf(RELEASES, false, 0))
        : Promise.resolve(undefined),
    );
    void changelog.refresh();
    await flushPromises();
    expect(document.body.querySelector(".changelog__release")).not.toBeNull();

    // A refresh that then fails keeps the stale feed on screen — the
    // error card rides above the list instead of blanking the pane.
    mocks.invoke.mockRejectedValue("proxy dropped");
    void changelog.refresh();
    await flushPromises();
    expect(document.body.querySelector(".changelog__release")).not.toBeNull();
    expect(document.body.querySelector(".hk-error-landing")).not.toBeNull();
    // The stale-feed card rides ABOVE real content — it must stay in
    // flow (no fill seating, no yielded group).
    expect(document.body.querySelector(".hk-error-landing.is-fill")).toBeNull();
    expect(document.body.querySelector(".changelog__error-fill")).toBeNull();
  });

  it("keeps the streamed feed when the next batch fails", async () => {
    mocks.invoke.mockImplementation((_cmd: string, args?: { page?: number }) =>
      (args?.page ?? 1) === 1
        ? Promise.resolve(pageOf(RELEASES, true, 2))
        : Promise.reject("tail page dropped"),
    );

    mountSection();
    const changelog = useChangelogStore();
    void changelog.refresh();
    await flushPromises();

    const observer = FakeIntersectionObserver.instances.at(-1);
    observer!.callback([{ isIntersecting: true }]);
    await flushPromises();

    // The stale feed stays and the failure card rides above it in flow —
    // the end marker must NOT show while the stream is in error.
    expect(document.body.querySelector(".changelog__release")).not.toBeNull();
    expect(document.body.querySelector(".hk-error-landing")).not.toBeNull();
    expect(document.body.querySelector(".hk-error-landing.is-fill")).toBeNull();
    expect(document.body.querySelector(".changelog__end")).toBeNull();
  });

  it("renders the empty state for an empty feed", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === RPC.changelog_list
        ? Promise.resolve(pageOf([], false, 0))
        : Promise.resolve(undefined),
    );

    mountSection();
    const changelog = useChangelogStore();
    void changelog.refresh();
    await flushPromises();

    expect(document.body.querySelector(".changelog__empty")).not.toBeNull();
  });
});
