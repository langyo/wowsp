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
 *
 * The translation half pins the per-release fetch contract: the spinner
 * row while the asset is in flight, the retry chip on a FAILED fetch
 * (never the "no translation" hint), English + hint for a release that
 * genuinely ships no asset, and the viewport gating (only cards the
 * shared observer reports are fetched).
 */
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { setLocale, type Locale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
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

/** Test double for the shared viewport observer: happy-dom's own
 *  IntersectionObserver never fires, so the tests drive the captured
 *  callback directly. A card entry carries the ARTICLE element as its
 *  target; an entry without one is the tail sentinel (the streaming
 *  tests' shape). */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: (entries: Array<{ isIntersecting: boolean; target?: Element }>) => void;
  observed: Element[] = [];
  constructor(callback: (entries: Array<{ isIntersecting: boolean; target?: Element }>) => void) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target?: Element): void {
    if (target) this.observed.push(target);
  }
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

/** Point the pane at a UI locale: the prefetch watcher keys off
 *  useLanguage().uiLocale while every label reads the vue-i18n singleton,
 *  and the locale bundle loads lazily — all three have to move before the
 *  translation states are observable in the DOM. */
async function useUiLocale(locale: Locale): Promise<void> {
  useLanguage().uiLocale.value = locale;
  await setLocale(locale);
}

/** The rendered release articles, feed order (newest first). */
function cards(): Element[] {
  return [...document.body.querySelectorAll(".changelog__release")];
}

/** A settled feed page plus the per-tag handler backing the translation
 *  command; any other command resolves undefined like the real surface. */
function mockChangelog(
  page: { releases: ChangelogRelease[]; has_more: boolean; next_page: number },
  i18n: (tag: string) => Promise<unknown>,
): void {
  mocks.invoke.mockImplementation((cmd: string, args?: { tag?: string }) => {
    if (cmd === RPC.changelog_list) return Promise.resolve(page);
    if (cmd === RPC.changelog_i18n) return i18n(args?.tag ?? "");
    return Promise.resolve(undefined);
  });
}

/** Fire the shared observer as the browser would: `target` is a release
 *  ARTICLE for the translation prefetch, omitted for the tail sentinel. */
function intersect(target?: Element): void {
  const observer = FakeIntersectionObserver.instances.at(-1);
  expect(observer).toBeTruthy();
  observer!.callback([{ isIntersecting: true, target }]);
}

/** Fire the shared observer for the TAIL SENTINEL — the entry carries the
 *  real `.changelog__sentinel` element, so the observer's card-vs-sentinel
 *  routing (not the untargeted legacy shape) is what streams the batch. */
function intersectSentinel(): void {
  const el = document.body.querySelector(".changelog__sentinel");
  expect(el, "the sentinel renders while the stream is armed").not.toBeNull();
  intersect(el!);
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

    intersectSentinel();
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
    intersectSentinel();
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

    intersectSentinel();
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

  /** The per-release translation states. The prefetch watcher only runs
   *  for a non-English UI locale, so this block pins the pane to zh-CN
   *  (and restores the default afterwards). */
  describe("release translations", () => {
    beforeAll(async () => {
      await useUiLocale("zh-CN");
    });
    afterAll(async () => {
      await useUiLocale("en-US");
    });

    it("shows the translating row while the asset fetch is in flight", async () => {
      const tags: string[] = [];
      let settle: (value: unknown) => void = () => {};
      mockChangelog(pageOf(RELEASES, false, 0), (tag) => {
        tags.push(tag);
        return new Promise((resolve) => {
          settle = resolve;
        });
      });

      mountSection();
      const changelog = useChangelogStore();
      void changelog.refresh();
      await flushPromises();

      // The feed alone asks for nothing: cards are viewport-gated.
      expect(cards().length).toBe(2);
      expect(tags).toEqual([]);
      expect(document.body.querySelector(".changelog__i18n-status")).toBeNull();

      intersect(cards()[0]);
      await flushPromises();

      expect(changelog.translationStates["0.4.6"]).toEqual({ status: "loading" });
      const [newest, older] = cards();
      const status = newest.querySelector(".changelog__i18n-status");
      expect(status).not.toBeNull();
      expect(status!.querySelector(".hk-spinner")).not.toBeNull();
      expect(status!.textContent).toContain("正在获取翻译");
      // A pending fetch is not an absence: the fallback hint waits, and
      // the English body stays rendered under the status row.
      expect(newest.querySelector(".changelog__i18n-fallback")).toBeNull();
      expect(newest.textContent).toContain("What's Changed");
      // The card outside the viewport never asked (and shows no row).
      expect(changelog.translationStates["0.4.5"]).toBeUndefined();
      expect(older.querySelector(".changelog__i18n-status")).toBeNull();

      // ensureTranslations is idempotent: a repeated report adds no request.
      intersect(cards()[0]);
      await flushPromises();
      expect(tags).toEqual(["v0.4.6"]);

      // Let the in-flight request settle so nothing dangles past the test.
      settle(null);
      await flushPromises();
    });

    it("renders the translated body once the asset resolves", async () => {
      const tags: string[] = [];
      mockChangelog(pageOf(RELEASES, false, 0), (tag) => {
        tags.push(tag);
        return Promise.resolve({
          tag,
          sections: { "zh-CN": "## 更新内容\n\n- 中文条目渲染成功" },
        });
      });

      mountSection();
      const changelog = useChangelogStore();
      void changelog.refresh();
      await flushPromises();
      intersect(cards()[0]);
      await flushPromises();

      expect(changelog.translationStates["0.4.6"]).toMatchObject({ status: "ready" });
      const newest = cards()[0];
      expect(newest.textContent).toContain("中文条目渲染成功");
      expect(newest.textContent).not.toContain("What's Changed");
      expect(newest.querySelector(".changelog__i18n-status")).toBeNull();
      expect(newest.querySelector(".changelog__i18n-fallback")).toBeNull();

      // refresh drops the cached state, and the bumped epoch re-requests
      // the visible card.
      void changelog.refresh();
      await flushPromises();
      expect(tags).toEqual(["v0.4.6", "v0.4.6"]);
      expect(changelog.translationStates["0.4.6"]).toMatchObject({ status: "ready" });
    });

    it("offers the retry chip when the fetch fails and recovers on retry", async () => {
      const tags: string[] = [];
      mockChangelog(pageOf(RELEASES, false, 0), (tag) => {
        tags.push(tag);
        if (tags.length === 1) return Promise.reject("mirror ladder exhausted");
        return Promise.resolve({ tag, sections: { "zh-CN": "- 重试后的译文" } });
      });

      mountSection();
      const changelog = useChangelogStore();
      void changelog.refresh();
      await flushPromises();
      intersect(cards()[0]);
      await flushPromises();

      // A failed fetch is NOT "no translation": the row says it failed,
      // offers the retry, and the fallback hint stays out of it.
      expect(changelog.translationStates["0.4.6"]).toEqual({
        status: "error",
        error: "mirror ladder exhausted",
      });
      const newest = cards()[0];
      expect(newest.textContent).toContain("翻译获取失败");
      expect(newest.querySelector(".changelog__i18n-fallback")).toBeNull();
      expect(newest.textContent).toContain("What's Changed");
      const retry = newest.querySelector(".changelog__i18n-status .hk-btn");
      expect(retry).not.toBeNull();
      expect(retry!.textContent).toContain("重试");

      (retry as HTMLButtonElement).click();
      await flushPromises();

      expect(tags).toEqual(["v0.4.6", "v0.4.6"]);
      expect(changelog.translationStates["0.4.6"]).toMatchObject({ status: "ready" });
      const recovered = cards()[0];
      expect(recovered.textContent).toContain("重试后的译文");
      expect(recovered.querySelector(".changelog__i18n-status")).toBeNull();
      expect(recovered.querySelector(".changelog__i18n-fallback")).toBeNull();
    });

    it("drops a stale fetch that rejects after refresh delivered the translation", async () => {
      let attempts = 0;
      let rejectStale: (reason?: unknown) => void = () => {};
      mocks.invoke.mockImplementation((cmd: string) => {
        if (cmd === RPC.changelog_list) return Promise.resolve(pageOf(RELEASES, false, 0));
        if (cmd === RPC.changelog_i18n) {
          attempts += 1;
          if (attempts === 1) {
            return new Promise<unknown>((_resolve, reject) => {
              rejectStale = reject;
            });
          }
          return Promise.resolve({ tag: "v0.4.6", sections: { "zh-CN": "- 刷新后的译文" } });
        }
        return Promise.resolve(undefined);
      });

      mountSection();
      const changelog = useChangelogStore();
      void changelog.refresh();
      await flushPromises();
      intersect(cards()[0]);
      await flushPromises();
      expect(attempts).toBe(1);
      expect(changelog.translationStates["0.4.6"]).toEqual({ status: "loading" });

      // refresh clears the states and re-requests the visible card: the
      // fresh fetch lands ready while the first attempt is still in flight.
      void changelog.refresh();
      await flushPromises();
      expect(attempts).toBe(2);
      expect(changelog.translationStates["0.4.6"]).toMatchObject({ status: "ready" });
      expect(cards()[0].textContent).toContain("刷新后的译文");

      // The superseded attempt now rejects: its completion belongs to the
      // pre-refresh list and must be dropped — the card keeps the fresh
      // translation, with no retry chip and no fallback hint.
      rejectStale("stale fetch failed late");
      await flushPromises();
      expect(changelog.translationStates["0.4.6"]).toMatchObject({ status: "ready" });
      const card = cards()[0];
      expect(card.textContent).toContain("刷新后的译文");
      expect(card.textContent).not.toContain("翻译获取失败");
      expect(card.querySelector(".changelog__i18n-status")).toBeNull();
      expect(card.querySelector(".changelog__i18n-fallback")).toBeNull();
    });

    it("shows the English body with the fallback hint when the release ships no asset", async () => {
      mockChangelog(pageOf(RELEASES, false, 0), () => Promise.resolve(null));

      mountSection();
      const changelog = useChangelogStore();
      void changelog.refresh();
      await flushPromises();
      intersect(cards()[0]);
      await flushPromises();

      expect(changelog.translationStates["0.4.6"]).toEqual({ status: "missing" });
      const newest = cards()[0];
      expect(newest.textContent).toContain("What's Changed");
      expect(newest.textContent).toContain("该版本还没有你所用语言的更新说明");
      expect(newest.querySelector(".changelog__i18n-status")).toBeNull();
    });

    it("treats a non-object payload as a missing asset instead of crashing", async () => {
      // The generic test-double route resolves undefined for every
      // command it does not know — the store must read that as "no asset".
      mocks.invoke.mockImplementation((cmd: string) =>
        cmd === RPC.changelog_list
          ? Promise.resolve(pageOf(RELEASES, false, 0))
          : Promise.resolve(undefined),
      );

      mountSection();
      const changelog = useChangelogStore();
      void changelog.refresh();
      await flushPromises();
      intersect(cards()[0]);
      await flushPromises();

      expect(changelog.translationStates["0.4.6"]).toEqual({ status: "missing" });
    });

    it("fetches a release's asset only once its card nears the viewport", async () => {
      const tags: string[] = [];
      mockChangelog(pageOf(RELEASES, true, 2), (tag) => {
        tags.push(tag);
        return Promise.resolve(null);
      });

      mountSection();
      const changelog = useChangelogStore();
      void changelog.refresh();
      await flushPromises();

      // Nothing has crossed the observer yet: the feed renders, no asset
      // request has been made for either release.
      expect(cards().length).toBe(2);
      expect(tags).toEqual([]);
      expect(changelog.translationStates).toEqual({});

      // The older card (never near the viewport before) intersects:
      // exactly ITS tag is requested.
      intersect(cards()[1]);
      await flushPromises();
      expect(tags).toEqual(["v0.4.5"]);
      expect(changelog.translationStates["0.4.5"]).toEqual({ status: "missing" });
      expect(changelog.translationStates["0.4.6"]).toBeUndefined();

      // The newest card intersects later: its tag joins the requests.
      intersect(cards()[0]);
      await flushPromises();
      expect(tags).toEqual(["v0.4.5", "v0.4.6"]);
    });

    it("fetches every release in the batch when the environment has no IntersectionObserver", async () => {
      vi.stubGlobal("IntersectionObserver", undefined);
      const tags: string[] = [];
      mockChangelog(pageOf(RELEASES, false, 0), (tag) => {
        tags.push(tag);
        return Promise.resolve(null);
      });

      mountSection();
      const changelog = useChangelogStore();
      void changelog.refresh();
      await flushPromises();

      // Ungated fallback: both cards request their asset with no
      // intersection report, in feed order.
      expect(tags).toEqual(["v0.4.6", "v0.4.5"]);
      expect(changelog.translationStates["0.4.6"]).toEqual({ status: "missing" });
      expect(changelog.translationStates["0.4.5"]).toEqual({ status: "missing" });
      expect(document.body.querySelectorAll(".changelog__i18n-fallback").length).toBe(2);
    });
  });
});
