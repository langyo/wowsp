/** The composition-sweep composable's realm grouping: names batch into one
 *  invoke per resolved realm (a per-name override wins over the base
 *  realm), asked names dedupe per `${realm}:${name}`, a name without any
 *  realm never gets asked, and a failed sweep un-asks its own group so the
 *  next roster change retries it (the other groups' verdicts stand). */
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

import { api, type PlayerComposition } from "@/api";
import { useLiveCompositions } from "./useLiveCompositions";

vi.mock("@/api", () => ({
  api: {
    lookupPlayersComposition: vi.fn(),
  },
}));

const comp = (air: boolean, sub: boolean): PlayerComposition => ({
  air,
  sub,
  airVeteran: false,
  subVeteran: false,
});

describe("useLiveCompositions realm grouping", () => {
  it("batches one invoke per resolved realm — a per-name override wins over the base", async () => {
    vi.mocked(api.lookupPlayersComposition).mockImplementation(async (_names, realm) =>
      realm === "na" ? [comp(true, false)] : [null, comp(false, true)],
    );
    const verdicts = useLiveCompositions(
      ref(["aaa", "bbb", "ccc"]),
      ref("asia"),
      ref({ aaa: "na" }),
    );
    await flushPromises();
    expect(api.lookupPlayersComposition).toHaveBeenCalledTimes(2);
    expect(api.lookupPlayersComposition).toHaveBeenCalledWith(["aaa"], "na");
    expect(api.lookupPlayersComposition).toHaveBeenCalledWith(["bbb", "ccc"], "asia");
    expect(verdicts.value.get("aaa")).toEqual(comp(true, false));
    expect(verdicts.value.get("bbb")).toBeNull();
    expect(verdicts.value.get("ccc")).toEqual(comp(false, true));
  });

  it("dedupes asked names per realm and skips names without any realm", async () => {
    vi.mocked(api.lookupPlayersComposition).mockResolvedValue([comp(true, false)]);
    const names = ref(["dup", "realmless"]);
    const overrides = ref<Record<string, string> | null>({ dup: "asia" });
    useLiveCompositions(names, "", overrides);
    await flushPromises();
    expect(api.lookupPlayersComposition).toHaveBeenCalledTimes(1);
    expect(api.lookupPlayersComposition).toHaveBeenCalledWith(["dup"], "asia");
    // A re-fire over the same roster (a re-render's watch) stays idle —
    // every name was asked, and the realm-less name never counts as todo.
    names.value = [...names.value];
    await nextTick();
    await flushPromises();
    expect(api.lookupPlayersComposition).toHaveBeenCalledTimes(1);
  });

  it("un-asks a failed realm's group only, retrying it on the next roster change", async () => {
    vi.mocked(api.lookupPlayersComposition)
      .mockRejectedValueOnce(new Error("wg down"))
      .mockResolvedValue([null, null, comp(false, true)]);
    const names = ref(["aaa", "bbb"]);
    const verdicts = useLiveCompositions(names, "asia");
    await flushPromises();
    // The failed sweep left no verdicts — and nothing re-fires the watch
    // on its own; the next roster change retries the whole group.
    expect(verdicts.value.size).toBe(0);
    names.value = ["aaa", "bbb", "ccc"];
    await nextTick();
    await flushPromises();
    expect(api.lookupPlayersComposition).toHaveBeenCalledTimes(2);
    expect(api.lookupPlayersComposition).toHaveBeenLastCalledWith(
      ["aaa", "bbb", "ccc"],
      "asia",
    );
    expect(verdicts.value.get("ccc")).toEqual(comp(false, true));
  });
});
