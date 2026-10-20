import { ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

import { api, type PlayerComposition } from "@/api";

/** Composition-seal verdicts (空中小人 / 水下小人 + the share figures) for
 *  the LIVE panel's roster, fetched through the same backend command the
 *  Tab overlay rides (`lookup_players_composition` — per-account per-ship
 *  sweep behind a process-lifetime cache, so the panel and the overlay
 *  share one WG request per player per session, whichever asks first).
 *
 *  The panel's own roster pipeline (useRosterStats) never pulls per-ship
 *  rows, so this composable owns its fetch: one batched invoke for every
 *  human name the caller lists that has not been asked yet, keyed
 *  `${realm}:${name}` for the panel's session (a career composition is
 *  session-stable). `names` shrinking to [] (or a non-zh UI / seals off —
 *  the caller gates that) idles the pipeline; a failed sweep un-asks its
 *  names so the next roster change retries them once more. null verdicts
 *  (hidden profile / not found) are FINAL for the name — they render no
 *  seal and are never re-asked. */
export function useLiveCompositions(
  names: MaybeRefOrGetter<string[]>,
  realm: MaybeRefOrGetter<string>,
): Readonly<Ref<Map<string, PlayerComposition | null>>> {
  const verdicts = ref(new Map<string, PlayerComposition | null>());
  const asked = new Set<string>();

  watch(
    [() => toValue(names), () => toValue(realm)],
    async ([nextNames, nextRealm]) => {
      if (!nextRealm) return;
      const todo = nextNames.filter((n) => n !== "" && !asked.has(`${nextRealm}:${n}`));
      if (todo.length === 0) return;
      for (const n of todo) asked.add(`${nextRealm}:${n}`);
      try {
        const rows = await api.lookupPlayersComposition(todo, nextRealm);
        const next = new Map(verdicts.value);
        todo.forEach((n, i) => next.set(n, rows[i] ?? null));
        verdicts.value = next;
      } catch {
        // A seal is decoration — a failed sweep must never take the panel
        // down. Un-ask so the next roster change retries the names (the
        // backend's own cache keeps a retry cheap).
        for (const n of todo) asked.delete(`${nextRealm}:${n}`);
      }
    },
    { immediate: true },
  );

  return verdicts;
}
