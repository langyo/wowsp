/** The shared water-table query pipeline: strict FIFO dispatch order,
 *  bounded-parallel execution (at most QUERY_LANES messages at once, the
 *  fourth waits for a lane), per-message settlement (a message resolves
 *  the moment its own executor finishes — first-arrived, first-shown, in
 *  ANY completion order), rejection containment (a failing message never
 *  stalls a lane) and the pending/active observability refs. */
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
  it("dispatches in FIFO order, at most three messages concurrently", async () => {
    const store = useStatsQueryStore();
    const order: string[] = [];
    const a = deferredRun(order, "a");
    const b = deferredRun(order, "b");
    const c = deferredRun(order, "c");
    const d = deferredRun(order, "d");

    const pa = store.enqueue(msg("a"), a.run);
    const pb = store.enqueue(msg("b"), b.run);
    const pc = store.enqueue(msg("c"), c.run);
    const pd = store.enqueue(msg("d"), d.run);

    // The three lanes pick up a/b/c; d has NOT started (no free lane).
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:a", "start:b", "start:c"]);
    expect(store.active).toBe(true);
    expect(store.pending).toBe(1);

    // Freeing ONE lane starts exactly the next message in FIFO order.
    a.resolve("A");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:a", "start:b", "start:c", "start:d"]);

    b.resolve("B");
    c.resolve("C");
    d.resolve("D");
    expect(await Promise.all([pa, pb, pc, pd])).toEqual(["A", "B", "C", "D"]);
    expect(store.active).toBe(false);
    expect(store.activeKind).toBe(null);
    expect(store.pending).toBe(0);
  });

  it("settles each message the moment its own executor finishes", async () => {
    const store = useStatsQueryStore();
    const a = deferredRun([], "a");
    const b = deferredRun([], "b");
    const c = deferredRun([], "c");

    const pa = store.enqueue(msg("a"), a.run);
    const pb = store.enqueue(msg("b"), b.run);
    const pc = store.enqueue(msg("c"), c.run);
    await new Promise<void>((r) => setTimeout(r, 0));

    // The LAST-dispatched message finishing first resolves first — the
    // first-arrived-first-shown contract — without disturbing the others.
    let cSettled = false;
    void pc.then(() => {
      cSettled = true;
    });
    c.resolve("C");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(cSettled).toBe(true);
    expect(store.active).toBe(true);

    a.resolve("A");
    b.resolve("B");
    expect(await Promise.all([pa, pb, pc])).toEqual(["A", "B", "C"]);
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

  it("frees its lane when a message rejects", async () => {
    const store = useStatsQueryStore();
    const order: string[] = [];
    const a = deferredRun(order, "a");
    const b = deferredRun(order, "b");
    const c = deferredRun(order, "c");

    const px = store
      .enqueue(msg("x"), async () => {
        order.push("start:x");
        throw new Error("boom");
      })
      .catch(() => "rejected");
    const pa = store.enqueue(msg("a"), a.run);
    store.enqueue(msg("b"), b.run);
    const pc = store.enqueue(msg("c"), c.run);

    // Dispatch is synchronous — x, a, b fill the lanes before any await;
    // c must wait (no free lane yet).
    expect(order).toEqual(["start:x", "start:a", "start:b"]);

    // x's rejection settles only its own awaiter AND releases its lane —
    // c starts without waiting for a or b to finish.
    await expect(px).resolves.toBe("rejected");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:x", "start:a", "start:b", "start:c"]);

    a.resolve("A");
    b.resolve("B");
    c.resolve("C");
    expect(await pa).toBe("A");
    expect(await pc).toBe("C");
    expect(store.active).toBe(false);
  });

  it("starts a message enqueued while every lane is busy once a lane frees", async () => {
    const store = useStatsQueryStore();
    const order: string[] = [];
    const a = deferredRun(order, "a");
    const b = deferredRun(order, "b");
    const c = deferredRun(order, "c");

    const pa = store.enqueue(msg("a"), a.run);
    store.enqueue(msg("b"), b.run);
    store.enqueue(msg("c"), c.run);
    await new Promise<void>((r) => setTimeout(r, 0));
    // All lanes busy — this one must wait its FIFO turn.
    const pd = store.enqueue(msg("d"), async () => {
      order.push("start:d");
      return "D";
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:a", "start:b", "start:c"]);

    b.resolve("B");
    await expect(pd).resolves.toBe("D");
    expect(order).toEqual(["start:a", "start:b", "start:c", "start:d"]);
    a.resolve("A");
    c.resolve("C");
    expect(await pa).toBe("A");
    expect(store.active).toBe(false);
  });
});
