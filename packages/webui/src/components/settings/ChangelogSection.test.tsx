/**
 * Tests for the settings' changelog pane (ChangelogSection + its store).
 *
 * The pane renders store state only — SettingsBody's section activators
 * are what load the feed — so these tests drive the store directly
 * against a mocked `changelog_list` and pin the rendered outcomes: the
 * release list (version chips, markdown body, PR links, the 当前 badge
 * on the running build) and the mirror-ladder failure state.
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

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.getVersion.mockReset().mockResolvedValue("0.4.6");
  document.body.innerHTML = "";
});

/** Mount attached to the body — the pane renders in place (no Teleport),
 *  so the shared document.body queries only see it when attached. */
function mountSection() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ChangelogSection, { attachTo: document.body, global: { plugins: [pinia] } });
}

describe("ChangelogSection", () => {
  it("renders the release feed with chips, markdown bodies, links and the current badge", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === RPC.changelog_list) return Promise.resolve(RELEASES);
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
  });

  it("renders the failure state when every mirror fails", async () => {
    mocks.invoke.mockRejectedValue("no mirror attempted for the changelog");

    mountSection();
    const changelog = useChangelogStore();
    void changelog.refresh();
    await flushPromises();

    expect(document.body.querySelector(".changelog__error")).not.toBeNull();
    expect(document.body.querySelector(".changelog__release")).toBeNull();
    expect(changelog.error).toContain("no mirror");

    // A later successful refresh replaces the failure with the feed.
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === RPC.changelog_list ? Promise.resolve(RELEASES) : Promise.resolve(undefined),
    );
    void changelog.refresh();
    await flushPromises();
    expect(document.body.querySelector(".changelog__release")).not.toBeNull();

    // A refresh that then fails keeps the stale feed on screen — the
    // error rides above the list instead of blanking the pane.
    mocks.invoke.mockRejectedValue("proxy dropped");
    void changelog.refresh();
    await flushPromises();
    expect(document.body.querySelector(".changelog__release")).not.toBeNull();
    expect(document.body.querySelector(".changelog__error")).not.toBeNull();
  });

  it("renders the empty state for an empty feed", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      cmd === RPC.changelog_list ? Promise.resolve([]) : Promise.resolve(undefined),
    );

    mountSection();
    const changelog = useChangelogStore();
    void changelog.refresh();
    await flushPromises();

    expect(document.body.querySelector(".changelog__empty")).not.toBeNull();
  });
});
