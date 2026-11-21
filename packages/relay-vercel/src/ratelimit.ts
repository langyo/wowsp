/**
 * Fixed-window hourly per-IP budgets (contract §3.5 lookup: 240/h;
 * §5.2.4 announce: 10/h). The counter key embeds the epoch-hour bucket
 * and the TTL is armed only on first increment, so a bucket lives
 * exactly one hour. KV errors fail OPEN: these budgets are abuse
 * brakes, not security boundaries -- a KV blip must not 500 the route.
 */

import type { Kv } from "./kv";

export interface BudgetVerdict {
  allowed: boolean;
  retryAfter: number;
}

export async function rateLimit(kv: Kv, kind: string, ip: string, limit: number): Promise<BudgetVerdict> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 3600);
  try {
    const count = await kv.incrWithTtl(`rl:${kind}:${ip}:${bucket}`, 3600);
    if (count > limit) return { allowed: false, retryAfter: Math.max(1, 3600 - (now % 3600)) };
  } catch {
    // fail-open (module doc)
  }
  return { allowed: true, retryAfter: 0 };
}
