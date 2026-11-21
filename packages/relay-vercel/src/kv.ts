/**
 * The storage seam: Upstash KV over its REST API (plain `fetch`), with
 * an in-memory Map fallback when the env is absent.
 *
 * Contract: docs/en/designs/cache-mesh.md §7 (deployment matrix:
 * "Upstash KV REST (or per-instance memory)") and §4.3 (eviction rides
 * key TTLs; blocks are stored with TTL + 24 h grace).
 *
 * ⚠️ MEMORY MODE IS PER-INSTANCE. Without KV_REST_URL / KV_REST_TOKEN
 * every edge isolate keeps its OWN Map: cache hits, peer rows and rate
 * limits are neither shared nor durable and reset on every cold start.
 * That is fine for `vercel dev` and previews; production deployments
 * must attach an Upstash KV database (README walks through it).
 */

export interface Kv {
  /** Raw string get; `null` when the key is absent or expired. */
  get(key: string): Promise<string | null>;
  /** Set a string value with a TTL in seconds (Upstash `SET ... EX`). */
  setTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Delete a key. */
  del(key: string): Promise<void>;
  /**
   * Increment a counter and give it a TTL only when it has none yet
   * (`INCR` + `EXPIRE ... NX`): the fixed rate-limit windows in
   * src/lookup.ts / src/peers.ts key on the bucket, so the TTL must
   * not be refreshed on every hit.
   */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
  /** List keys under a prefix (Upstash `SCAN ... MATCH`, memory: Map). */
  keys(prefix: string): Promise<string[]>;
}

// ── Upstash REST (https://docs.upstash.com/redis/features/restapi) ─────────
// The REST API speaks Redis commands as JSON arrays: a single command is
// POST {url} with ["SET", key, value, "EX", ttl]; an array of command
// arrays is a pipeline. The token rides the Authorization header, never
// the URL.

interface UpstashRestResult {
  result?: unknown;
  error?: string;
}

async function upstashFetch(
  baseUrl: string,
  token: string,
  body: unknown[],
): Promise<UpstashRestResult> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`upstash rest ${response.status}`);
  }
  return (await response.json()) as UpstashRestResult;
}

function upstashKv(baseUrl: string, token: string): Kv {
  return {
    async get(key) {
      const { result, error } = await upstashFetch(baseUrl, token, ["GET", key]);
      if (error) throw new Error(`upstash GET: ${error}`);
      return result === null || result === undefined ? null : String(result);
    },
    async setTtl(key, value, ttlSeconds) {
      const { error } = await upstashFetch(baseUrl, token, ["SET", key, value, "EX", ttlSeconds]);
      if (error) throw new Error(`upstash SET: ${error}`);
    },
    async del(key) {
      await upstashFetch(baseUrl, token, ["DEL", key]);
    },
    async incrWithTtl(key, ttlSeconds) {
      // Pipeline: INCR then EXPIRE NX (only arms the TTL on first hit).
      const results = (await upstashFetch(baseUrl, token, [
        ["INCR", key],
        ["EXPIRE", key, ttlSeconds, "NX"],
      ])) as unknown as UpstashRestResult[];
      const incr = results[0];
      if (!incr || incr.error) throw new Error(`upstash INCR: ${incr?.error ?? "no result"}`);
      return Number(incr.result);
    },
    async keys(prefix) {
      const found: string[] = [];
      let cursor = "0";
      // SCAN starts AT cursor "0" (Redis semantics: zero is the initial
      // cursor, the loop ENDS when the server returns it) -- a do/while,
      // not a pre-condition loop. Rounds stay bounded (5 x COUNT 256):
      // the peer table is capped at 128 rows anyway (§5.2.3).
      let round = 0;
      do {
        const { result, error } = await upstashFetch(baseUrl, token, [
          "SCAN",
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          "256",
        ]);
        if (error) throw new Error(`upstash SCAN: ${error}`);
        const [next, batch] = result as [string, string[]];
        cursor = next;
        found.push(...batch);
        round += 1;
      } while (cursor !== "0" && round < 5 && found.length < 1024);
      return found;
    },
  };
}

// ── In-memory fallback (per-instance, see the module warning) ─────────────

interface MemoryRow {
  value: string;
  expiresAt: number | null;
}

const memoryStore = new Map<string, MemoryRow>();

/** Test-only: wipe the shared memory store between cases. */
export function resetMemoryKvForTests(): void {
  memoryStore.clear();
}

function memoryKv(): Kv {
  const live = (key: string): MemoryRow | null => {
    const row = memoryStore.get(key);
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
      memoryStore.delete(key);
      return null;
    }
    return row;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async setTtl(key, value, ttlSeconds) {
      memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      // Opportunistic sweep keeps long-lived isolates from accumulating.
      if (memoryStore.size > 4096) {
        const now = Date.now();
        for (const [k, row] of memoryStore) {
          if (row.expiresAt !== null && row.expiresAt <= now) memoryStore.delete(k);
        }
      }
    },
    async del(key) {
      memoryStore.delete(key);
    },
    async incrWithTtl(key, ttlSeconds) {
      const row = live(key);
      const next = row === null ? 1 : Number(row.value || "0") + 1;
      memoryStore.set(key, {
        value: String(next),
        expiresAt: row?.expiresAt ?? Date.now() + ttlSeconds * 1000,
      });
      return next;
    },
    async keys(prefix) {
      const out: string[] = [];
      for (const key of memoryStore.keys()) {
        if (key.startsWith(prefix) && live(key) !== null) out.push(key);
      }
      return out;
    },
  };
}

/**
 * Open the KV: Upstash REST when both KV_REST_URL and KV_REST_TOKEN are
 * set, the per-instance memory store otherwise.
 */
export function openKv(kvRestUrl: string | null, kvRestToken: string | null): Kv {
  if (kvRestUrl && kvRestToken) return upstashKv(kvRestUrl, kvRestToken);
  return memoryKv();
}
