/**
 * Clan-winrate lookup for the hidden-profile 过街老鼠 gate (the 5th argument
 * of `careerStamp` in utils/winrate): a hidden profile in a clan whose
 * aggregate winrate beats RAT_CLAN_WINRATE_MAX is excused from the rat
 * stamp — a clan that strong implies the player is not hiding a bad career.
 *
 * Deliberately NOT routed through the Pinia `useClanStatsStore`, for two
 * reasons: that store keys its cache per PR algorithm (a clan roster's
 * member stats differ under "winrate" vs "expected"), while this module
 * needs exactly one number — `ClanInfo.winrate` is the same under every
 * algorithm, so no prAlgo is forwarded to `clans/info`; and the in-game
 * overlay page (src/overlay/main.ts) runs without Vue/Pinia entirely, so a
 * shared plain-TS module is the only cache both surfaces can use. The cache
 * is still per JS context (main and overlay windows never share module
 * state), so each window pays its own first lookup per clan: one
 * `clans/info` call (which the backend serves with one batched
 * `account/info` over the roster) — once per window, forever. Successes are
 * cached permanently; failures are NOT cached, so the next caller retries,
 * and concurrent callers share a single in-flight request.
 */
import { api } from "@/api";

/** Cache / in-flight key for one clan on one realm. Exported so the overlay
 *  page's verdict map agrees with this module's namespace. */
export function clanWinrateKey(realm: string, clanId: number): string {
  return `${realm}:${clanId}`;
}

/** Resolved clan winrates, keyed by realm:clanId — successes only, kept for
 *  the window's lifetime (clan aggregate winrates move too slowly to care). */
const resolved = new Map<string, number>();
/** In-flight requests, so concurrent callers share one clans/info call.
 *  Entries are removed on settle; failed lookups land nowhere else. */
const inFlight = new Map<string, Promise<number | null>>();

/** The clan's aggregate winrate (percent), or null when the lookup failed —
 *  callers must treat null as "no clan data" and stamp fail-open. */
export async function lookupClanWinrate(realm: string, clanId: number): Promise<number | null> {
  // A garbage key (empty realm still resolving, non-numeric clan id) can
  // only produce a wrong answer — resolve it like a failure, never cache it.
  if (!realm || !Number.isFinite(clanId)) return null;
  const key = clanWinrateKey(realm, clanId);
  const hit = resolved.get(key);
  if (hit != null) return hit;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const call = (async () => {
    try {
      // Winrate is algorithm-independent — no prAlgo, the backend keeps its
      // zero-cost default.
      const info = await api.lookupClanInfo(clanId, realm);
      const wr = info?.winrate ?? null;
      if (wr != null) resolved.set(key, wr);
      return wr;
    } catch {
      // Failure stays uncached — the next caller retries.
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, call);
  return call;
}
