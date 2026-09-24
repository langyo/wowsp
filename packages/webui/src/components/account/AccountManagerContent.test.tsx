/**
 * Tests for the add-player dialog's search step (the dashed 新增玩家 row's
 * dialog inside AccountManagerContent).
 *
 * Both cases come from a phone report (2026-09-24) about the bind flow:
 *
 *  - The search button's busy ring is a load indicator the user never saw.
 *    A lookup the stats cache can answer resolved within a couple of
 *    animation frames, so `searching` flipped back before the ring's own
 *    paint landed. The floor under the busy state (SEARCH_BUSY_FLOOR_MS) is
 *    what makes it visible; the first test pins it by asserting the ring is
 *    STILL up after the lookup has settled.
 *
 *  - An attempt in flight has to be droppable. `searchSeq` is bumped by the
 *    dialog reopen (and by a realm switch), and a lookup that resolves
 *    afterwards must not stage its player into the new visit — that is a
 *    stale preview, and confirming it binds the wrong account.
 *
 * The transport is mocked rather than the api module so the real stats
 * store runs underneath: that is what makes the second half of the first
 * test meaningful — the repeat search must reach the API even though the
 * first one filled the cache (the dialog passes `force`).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createPinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { RPC } from "@/rpc";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/transport", () => ({ transport: { invoke: mocks.invoke } }));

import AccountManagerContent from "./AccountManagerContent";
import type { PlayerStats } from "@/api";

enableAutoUnmount(afterEach);

const PLAYER: PlayerStats = {
  accountId: 1024000001,
  name: "RingProbeOne",
  battles: 1234,
  winrate: 55.5,
  avgDamage: 42000,
  pr: 1500,
} as PlayerStats;

/** Route the mocked transport by command. AppData is an empty store (no
 *  cache, no index) unless a test seeds it, and every other command the
 *  component touches is a no-op. */
function routeTransport(
  onLookup: (args: Record<string, unknown>) => Promise<PlayerStats>,
) {
  mocks.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case RPC.lookup_player_stats:
        return onLookup(args ?? {});
      case RPC.appdata_read:
        return Promise.resolve(null);
      case RPC.appdata_write:
      case RPC.snapshot_player_stats:
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
}

function mountContent() {
  const pinia = createPinia();
  return mount(AccountManagerContent, { global: { plugins: [pinia] } });
}

/** The add dialog's own content renders through HModal, which teleports to
 *  body — so the search row is queried there, not on the wrapper. The row
 *  is [HSelect, HInput, HButton], and BOTH HSelect and HButton put a
 *  <button> in it (the select's trigger comes first), so the search button
 *  is the LAST button in the row. Same reason the nickname field is the
 *  last input: HSelect renders its own. */
const searchInput = () => {
  const inputs = document.body.querySelectorAll<HTMLInputElement>(
    ".acct-modal__search input",
  );
  return inputs[inputs.length - 1];
};
const searchButton = () => {
  const buttons = document.body.querySelectorAll<HTMLButtonElement>(
    ".acct-modal__search button.hk-btn",
  );
  return buttons[buttons.length - 1];
};
const searchIsBusy = () => {
  const btn = searchButton();
  return {
    loadingClass: !!btn?.classList.contains("hk-btn-loading"),
    ring: !!btn?.querySelector("svg.hk-btn-ring"),
  };
};
// The staged player's card. The dialog's children teleport OUT of the
// component root (.acct-modal), so the card is matched by its own class
// under body — this dialog is the app's only renderer of the variant.
const previewCard = () => document.body.querySelector(".acct-card--preview");

async function openAddDialog(wrapper: ReturnType<typeof mountContent>) {
  await wrapper.find("button.acct-modal__add").trigger("click");
  await flushPromises();
  if (!searchInput() || !searchButton()) {
    throw new Error("add dialog did not render its search row");
  }
}

async function typeName(name: string) {
  const input = searchInput();
  if (!input) throw new Error("search input not rendered");
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flushPromises();
  if (searchButton()?.disabled) {
    throw new Error("nickname did not reach the search button");
  }
}

async function clickSearch() {
  const btn = searchButton();
  if (!btn) throw new Error("search button not rendered");
  btn.click();
  await flushPromises();
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe("add-player dialog search", () => {
  it("holds the busy ring past the lookup so a fast search still reads as busy", async () => {
    // A lookup that answers instantly is the worst case for the ring: this
    // is exactly the shape that used to flash for ~2 frames and disappear.
    let lookups = 0;
    routeTransport(async () => {
      lookups++;
      return PLAYER;
    });

    const wrapper = mountContent();
    await openAddDialog(wrapper);
    await typeName(PLAYER.name!);

    await clickSearch();

    // The lookup has already settled here (flushPromises drained it), yet
    // the ring must still be up: without the floor it is cleared in the same
    // tick the result lands and the button never visibly reacts.
    expect(lookups).toBe(1);
    expect(searchIsBusy()).toEqual({ loadingClass: true, ring: true });

    // ...and it must not outstay the floor either.
    await settle(600);
    await flushPromises();
    expect(searchIsBusy()).toEqual({ loadingClass: false, ring: false });
    expect(previewCard()).not.toBeNull();
  });

  it("reaches the API on a repeat search instead of serving the cached stats", async () => {
    let lookups = 0;
    routeTransport(async () => {
      lookups++;
      return PLAYER;
    });

    const wrapper = mountContent();
    await openAddDialog(wrapper);
    await typeName(PLAYER.name!);

    await clickSearch();
    await settle(600);
    // The first search filled the store's stats cache for this nickname.
    await clickSearch();
    await settle(600);

    // force: the dialog's query is an explicit user lookup, so the second
    // one re-pulls rather than previewing the cached copy.
    expect(lookups).toBe(2);
  });

  it("drops an attempt in flight when the dialog is reopened", async () => {
    let resolveLookup: (stats: PlayerStats) => void = () => {};
    routeTransport(() => new Promise<PlayerStats>((resolve) => (resolveLookup = resolve)));

    const wrapper = mountContent();
    await openAddDialog(wrapper);
    await typeName(PLAYER.name!);
    await clickSearch();
    expect(searchIsBusy().ring).toBe(true);

    // Reopening starts a clean visit: the pending attempt belongs to the
    // previous one and must not stage a preview into this one.
    await openAddDialog(wrapper);

    resolveLookup(PLAYER);
    await flushPromises();
    await settle(600);
    await flushPromises();

    expect(previewCard()).toBeNull();
    expect(searchIsBusy()).toEqual({ loadingClass: false, ring: false });
  });
});
