import { ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

import { api, type PlayerComposition } from "@/api";

/** Composition-seal verdicts (空中小人 / 水下小人) for
 *  a roster, fetched through the same backend command the Tab overlay
 *  rides (`lookup_players_composition` — per-account per-ship sweep behind
 *  a process-lifetime cache, so every consumer shares one WG request per
 *  player per session, whichever asks first).
 *
 *  The rosters' own stat pipelines never pull per-ship rows, so this
 *  composable owns its fetch: one batched invoke per realm for every
 *  human name the caller lists that has not been asked yet, keyed
 *  `${realm}:${name}` for the caller's session (a career composition is
 *  session-stable). `realm` backs names without an entry in the optional
 *  `realmOfName` map — the live panel passes one realm and no map, the
 *  post-battle matrix passes each row's own realm (its battle can stray
 *  cross-realm) and no base to speak of. `names` shrinking to [] (or a
 *  non-zh UI / seals off — the caller gates that) idles the pipeline; a
 *  failed sweep un-asks its names so the next roster change retries them
 *  once more. null verdicts (hidden profile / not found) are FINAL for
 *  the name — they render no seal and are never re-asked. */
export function useLiveCompositions(
  names: MaybeRefOrGetter<string[]>,
  realm: MaybeRefOrGetter<string>,
  realmOfName?: MaybeRefOrGetter<Record<string, string> | null>,
): Readonly<Ref<Map<string, PlayerComposition | null>>> {
  const verdicts = ref(new Map<string, PlayerComposition | null>());
  const asked = new Set<string>();

  watch(
    [() => toValue(names), () => toValue(realm), () => toValue(realmOfName)],
    async ([nextNames, nextRealm, nextRealms]) => {
      // The not-yet-asked names grouped by their resolved realm — one
      // batched invoke per group (a same-realm roster stays one invoke).
      const byRealm = new Map<string, string[]>();
      for (const n of nextNames) {
        if (n === "") continue;
        const r = nextRealms?.[n] ?? nextRealm;
        if (!r) continue;
        const key = `${r}:${n}`;
        if (asked.has(key)) continue;
        asked.add(key);
        const group = byRealm.get(r);
        if (group) group.push(n);
        else byRealm.set(r, [n]);
      }
      // Groups settle in parallel (the post-battle matrix's own loadNameStats
      // discipline) — each writes its verdicts into the map as it lands.
      await Promise.all(
        [...byRealm].map(async ([r, todo]) => {
          try {
            const rows = await api.lookupPlayersComposition(todo, r);
            const next = new Map(verdicts.value);
            todo.forEach((n, i) => next.set(n, rows[i] ?? null));
            verdicts.value = next;
          } catch {
            // A seal is decoration — a failed sweep must never take the panel
            // down. Un-ask so the next roster change retries the names (the
            // backend's own cache keeps a retry cheap).
            for (const n of todo) asked.delete(`${r}:${n}`);
          }
        }),
      );
    },
    { immediate: true },
  );

  return verdicts;
}
