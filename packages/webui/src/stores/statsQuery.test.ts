/** The shared water-table query pipeline: strict FIFO ordering, strictly
 *  serial execution (one message at a time, next starts only after the
 *  previous settles), rejection containment (a failing message never
 *  stalls the worker) and the pending/active observability refs. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useStatsQueryStore, type StatsQueryMessage } from "./statsQuery";

function msg(tag: string): StatsQueryMessage {
  return { kind: "player-stats", nickname: tag, realm: "asia", force: false, ttlMs: 0 };
}

/** An executor that records start order and only settles when told to. */
function deferredRun(order: string[], tag: string) {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  const run = () => {
    order.push(`start:${tag}`);
    return promise;
  };
  return { run, resolve, tag };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("statsQuery pipeline", () => {
  it("executes messages strictly in FIFO order, never in parallel", async () => {
    const store = useStatsQueryStore();
    const order: string[] = [];
    const a = deferredRun(order, "a");
    const b = deferredRun(order, "b");
    const c = deferredRun(order, "c");

    const pa = store.enqueue(msg("a"), a.run);
    const pb = store.enqueue(msg("b"), b.run);
    const pc = store.enqueue(msg("c"), c.run);

    // Let the worker pick up "a" (and prove b/c have NOT started).
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:a"]);
    expect(store.active).toBe(true);
    expect(store.activeKind).toBe("player-stats");
    expect(store.pending).toBe(2);

    a.resolve("A");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:a", "start:b"]);

    b.resolve("B");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:a", "start:b", "start:c"]);

    c.resolve("C");
    expect(await Promise.all([pa, pb, pc])).toEqual(["A", "B", "C"]);
    expect(store.active).toBe(false);
    expect(store.activeKind).toBe(null);
    expect(store.pending).toBe(0);
  });

  it("keeps draining after a rejecting message", async () => {
    const store = useStatsQueryStore();
    const order: string[] = [];
    const p1 = store
      .enqueue(msg("x1"), async () => {
        order.push("x1");
        throw new Error("boom");
      })
      .catch((e: Error) => e.message);
    const p2 = store.enqueue(msg("x2"), async () => {
      order.push("x2");
      return "ok";
    });

    expect(await p1).toBe("boom");
    expect(await p2).toBe("ok");
    expect(order).toEqual(["x1", "x2"]);
    expect(store.active).toBe(false);
  });

  it("drains messages enqueued while the worker is busy in the same pass", async () => {
    const store = useStatsQueryStore();
    const order: string[] = [];
    const a = deferredRun(order, "a");

    const pa = store.enqueue(msg("a"), a.run);
    await new Promise<void>((r) => setTimeout(r, 0));
    // Enqueue mid-flight — the running drain pass must pick it up.
    const pb = store.enqueue(msg("b"), async () => {
      order.push("start:b");
      return "B";
    });

    a.resolve("A");
    expect(await pa).toBe("A");
    expect(await pb).toBe("B");
    expect(order).toEqual(["start:a", "start:b"]);
    expect(store.active).toBe(false);
  });
});
