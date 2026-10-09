import { defineStore } from "pinia";
import { ref } from "vue";

import type { PrAlgo } from "@/stores/statsPrefs";

/** One water-table (水表) query message — the unit of the shared FIFO
 *  pipeline below. Every kind maps to exactly one WG-querying RPC (or a
 *  store executor wrapping it); the payload carries everything the
 *  executor needs, so messages stay inspectable data instead of opaque
 *  closures. */
export type StatsQueryMessage =
  | {
      kind: "player-stats";
      nickname: string;
      realm: string;
      force: boolean;
      ttlMs: number;
    }
  | { kind: "ship-stats"; accountId: number; realm: string; ttlMs: number }
  | {
      kind: "ranked-stats";
      accountId: number;
      realm: string;
      seasonCount?: number;
      ttlMs: number;
    }
  | {
      kind: "roster-batch";
      names: string[];
      realm: string;
      crossRealm: boolean;
      prAlgo: PrAlgo | undefined;
    };

/** A message plus its executor and settle callbacks. `run` is bound by the
 *  producing store/composable, which keeps this pipeline store-agnostic
 *  (no import cycles) while the message itself stays plain data. */
interface QueryEnvelope {
  message: StatsQueryMessage;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** The ONE shared query pipeline every water-table surface funnels its WG
 *  queries through — 我的水表 (dashboard), 常规水表查询 (lookup page),
 *  录像水表查询 (replay drill-downs, hologram follow menu, roster
 *  batches) alike.
 *
 *  Multi-read / single-write: all surfaces freely READ the same reactive
 *  store caches (and the cheap cache/TTL fast paths in front of this
 *  queue never enter it); only this pipeline's lanes EXECUTE queries and
 *  write those caches.
 *
 *  FIFO dispatch, bounded-parallel execution: messages START strictly in
 *  submission order, but up to QUERY_LANES of them run concurrently, and
 *  each settles the moment ITS executor finishes — a fast roster
 *  sub-batch (or a cache-backed single hit) displays without waiting for
 *  the slower query dispatched beside it, and a slow one never blocks the
 *  queue behind it. A rejecting message settles only its own awaiter and
 *  never stalls the pipeline.
 *
 *  The Rust layer keeps its own bounded-parallelism batch fan-out and
 *  same-key single-flight caches; this queue adds the cross-surface,
 *  cross-player pacing the backend doesn't provide (QUERY_LANES × the
 *  backend's per-command fan-out ≈ the request width the old chunked
 *  frontend fetchers already kept, so the WG endpoints see the same
 *  storm shape they tolerate). */
export const useStatsQueryStore = defineStore("statsQuery", () => {
  /** Concurrent messages ("lanes"). Three keeps a full roster's sub-batches
   *  moving together without re-creating the thundering herd the serial
   *  worker existed to prevent. */
  const QUERY_LANES = 3;
  /** The FIFO (plain closure state — envelopes carry functions and promise
   *  callbacks that must not become reactive). */
  const queue: QueryEnvelope[] = [];
  /** Messages currently executing (0 … QUERY_LANES). */
  let running = 0;
  /** True while at least one lane is executing a message. */
  const active = ref(false);
  /** The kind most recently DISPATCHED (null = all lanes idle). With
   *  several lanes in flight this is an observability hint, not the
   *  single running kind. */
  const activeKind = ref<StatsQueryMessage["kind"] | null>(null);
  /** Messages waiting in the queue (excludes the running ones). */
  const pending = ref(0);

  /** Push one message and await its result. Resolves/rejects with whatever
   *  the producer-bound executor settles with, in FIFO dispatch turn —
   *  completion order is the executor's own. */
  function enqueue<T>(message: StatsQueryMessage, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ message, run, resolve: resolve as (value: unknown) => void, reject });
      pending.value = queue.length;
      pump();
    });
  }

  /** The dispatcher: starts queued messages in FIFO order while a lane is
   *  free. Each lane settles its own message and immediately frees the
   *  slot for the next one — no pass ever awaits inside, so re-entry
   *  needs no gate. */
  function pump() {
    while (running < QUERY_LANES && queue.length > 0) {
      const env = queue.shift()!;
      pending.value = queue.length;
      running += 1;
      active.value = true;
      activeKind.value = env.message.kind;
      void (async () => {
        try {
          env.resolve(await env.run());
        } catch (e) {
          // The error belongs to this message's awaiter only — the
          // pipeline itself must keep flowing.
          env.reject(e);
        } finally {
          running -= 1;
          if (running === 0) {
            active.value = false;
            activeKind.value = null;
          }
          pump();
        }
      })();
    }
  }

  return { enqueue, active, activeKind, pending };
});
