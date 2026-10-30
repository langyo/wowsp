/**
 * Onboarding player-candidate grouping and default selection.
 *
 * The wizard's game step folds the backend's `replay_player_candidates`
 * answer (one row per (realm, nickname) the local replays testify was
 * logged in on this machine) into per-realm groups and seeds the
 * checkbox selection: ONE row per server — the most-evidence row of each
 * realm — preselected, every other row available for the shared-machine
 * case (several accounts in turn on one client) and the multi-server
 * case (one client per realm, each its own preselected row). Only the
 * user-confirmed rows are ever bound as accounts.
 *
 * Pure module (no Vue/pinia) so the grouping rules are unit-testable the
 * same way utils/gamePath's path rules are.
 */
import type { ReplayPlayerCandidate } from "@/api";

export interface PlayerCandidateGroup {
  /** The realm code ("ru"/"eu"/"na"/"asia"/"cn"). */
  realm: string;
  /** That realm's candidates in answer order (most evidence first). */
  rows: ReplayPlayerCandidate[];
}

/** Stable realm display order: the known realm list first (server
 *  selection menus use the same order), then any unknown code the
 *  backend may introduce, alphabetical. */
export function groupCandidatesByRealm(
  candidates: readonly ReplayPlayerCandidate[],
  knownRealms: readonly string[],
): PlayerCandidateGroup[] {
  const byRealm = new Map<string, ReplayPlayerCandidate[]>();
  for (const c of candidates) {
    const rows = byRealm.get(c.realm) ?? [];
    rows.push(c);
    byRealm.set(c.realm, rows);
  }
  const known = knownRealms.filter((r) => byRealm.has(r));
  const extra = [...byRealm.keys()]
    .filter((r) => !knownRealms.includes(r))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...extra].map((realm) => ({ realm, rows: byRealm.get(realm) ?? [] }));
}

/** Selection seed — "one per server": each realm's FIRST row (the answer
 *  is most-evidence-first, so that is the realm's likeliest owner). The
 *  wizard renders this as the initial checkbox state; the user can add
 *  the machine's other accounts or drop a realm's row entirely. */
export function defaultSelection(
  groups: readonly PlayerCandidateGroup[],
): Set<string> {
  const selected = new Set<string>();
  for (const g of groups) {
    const head = g.rows[0];
    if (head) selected.add(candidateKey(head));
  }
  return selected;
}

/** Checkbox identity — (realm, nickname) is the candidate's whole key;
 *  the NUL separator can never occur in either half. */
export function candidateKey(c: Pick<ReplayPlayerCandidate, "realm" | "nickname">): string {
  return `${c.realm}\u0000${c.nickname}`;
}
