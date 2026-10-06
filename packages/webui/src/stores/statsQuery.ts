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

/** The ONE serial query pipeline every water-table surface funnels its WG
 *  queries through — 我的水表 (dashboard), 常规水表查询 (lookup page),
 *  录像水表查询 (replay drill-downs, hologram follow menu, roster
 *  batches) alike.
 *
 *  Multi-read / single-write: all surfaces freely READ the same reactive
 *  store caches (and the cheap cache/TTL fast paths in front of this
 *  queue never enter it); only this pipeline's single worker EXECUTES
 *  queries and writes those caches.
 *
 *  FIFO message queue: messages run strictly one at a time, in submission
 *  order — concurrent surfaces (e.g. a dashboard refresh racing the
 *  replay follow menu's player batch) queue behind each other instead of
 *  bursting the WG API in parallel. A rejecting message settles only its
 *  own awaiter and never stalls the pipeline.
 *
 *  The Rust layer keeps its own bounded-parallelism batch fan-out and
 *  same-key single-flight caches; this queue adds the cross-surface,
 *  cross-player ordering the backend doesn't provide. */
export const useStatsQueryStore = defineStore("statsQuery", () => {
  /** The FIFO (plain closure state — envelopes carry functions and promise
   *  callbacks that must not become reactive). */
  const queue: QueryEnvelope[] = [];
  /** True while the worker is executing a message. */
  const active = ref(false);
  /** What the worker is executing right now (null = idle). */
  const activeKind = ref<StatsQueryMessage["kind"] | null>(null);
  /** Messages waiting in the queue (excludes the running one). */
  const pending = ref(0);

  /** Push one message and await its result. Resolves/rejects with whatever
   *  the producer-bound executor settles with, in strict FIFO turn. */
  function enqueue<T>(message: StatsQueryMessage, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ message, run, resolve: resolve as (value: unknown) => void, reject });
      pending.value = queue.length;
      void drain();
    });
  }

  /** The single worker loop — at most one drain() pass ever runs (`active`
   *  gates re-entry); messages enqueued while it awaits are picked up by
   *  the same pass. */
  async function drain() {
    if (active.value) return;
    active.value = true;
    try {
      while (queue.length > 0) {
        const env = queue.shift()!;
        pending.value = queue.length;
        activeKind.value = env.message.kind;
        try {
          env.resolve(await env.run());
        } catch (e) {
          // The error belongs to this message's awaiter only — the
          // pipeline itself must keep flowing.
          env.reject(e);
        } finally {
          activeKind.value = null;
        }
      }
    } finally {
      active.value = false;
    }
  }

  return { enqueue, active, activeKind, pending };
});
