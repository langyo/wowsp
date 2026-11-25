/** The catalog detail pane's install ACTION SCOPE: one plan that decides
 *  whether the footer offers the single toggle-dependent button (today's
 *  behavior) or TWO explicit actions — "all clients" plus "this client".
 *
 *  The ambiguity this resolves (user report 2026-11-25): the footer's one
 *  install button silently means different things depending on the 多客户端
 *  同步 toggle, so an entry installed on SOME detected clients (e.g. 国服 +
 *  Lesta) but missing on the ACTIVE one showed a lone "安装" that read as a
 *  no-op or as a duplicate install depending on the toggle in the header.
 *
 *  PARTIAL = at least one applicable client already carries the current
 *  version while at least one other still lacks it (or is stale). Only then
 *  are the two explicit actions shown; every other state keeps the single
 *  button whose label the pane already derives from the ledger record.
 *
 *  Pure (no Vue, no IPC, no i18n): the label fields are message KEYS, so the
 *  branch matrix is unit-testable without mounting the view. */
import type { EntryClientStatus } from "./entryClients";

import { sameGamePath } from "@/utils/gamePath";

/** The pair of message keys the footer renders. `allLabel` is null while
 *  the all-clients action is hidden (the contract: label presence and
 *  button presence never disagree). */
export type InstallScopePlan = {
  /** More than one applicable client is configured — the machine-wide
   *  fan-out is even possible. */
  multi: boolean;
  /** Clients the entry applies to (state !== "unsupported"). */
  applicable: number;
  /** Applicable clients with no ledger record at all. */
  missing: number;
  /** Applicable clients whose record is on another version. */
  stale: number;
  /** Applicable clients on the entry's current version. */
  current: number;
  /** Partial state: show "all clients" + "this client" side by side. */
  showAllClients: boolean;
  /** The all-clients action's label, or null when that action is hidden. */
  allLabel:
    | "resources.installAllClients"
    | "resources.updateAllClients"
    | null;
  /** The active client's action label (always present — the single-button
   *  branch computes its own precedence chain from the ledger record). */
  thisLabel:
    | "resources.installThisClient"
    | "resources.updateThisClient"
    | "resources.reinstallThisClient";
};

/** One plan over the per-client statuses (detection order, as
 *  `entryClientStatusesOf` derives them) and the ACTIVE client root.
 *
 *  Rules:
 *  - Realm-inapplicable clients never count (the fan-out skips them too).
 *  - The active client is the applicable status matching `activeRoot` by
 *    the shared path identity; when the active root is not among the
 *    configured clients it reads as "notInstalled" (the pane can still
 *    install there).
 *  - The all-clients action is PARTIAL-only: something to roll out
 *    (missing/stale) AND something already landed (current/stale). With no
 *    client carrying the entry there is nothing to "sync" — the single
 *    install button already names the whole action. */
export function installScopePlan(
  statuses: readonly EntryClientStatus[],
  activeRoot: string,
): InstallScopePlan {
  const applicable = statuses.filter((s) => s.state !== "unsupported");
  const multi = applicable.length > 1;
  const thisState =
    applicable.find((s) => sameGamePath(s.install.path, activeRoot))?.state ??
    "notInstalled";
  let missing = 0;
  let stale = 0;
  let current = 0;
  for (const s of applicable) {
    if (s.state === "installed") current += 1;
    else if (s.state === "needsUpdate") stale += 1;
    else missing += 1;
  }
  const rollout = missing > 0 || stale > 0;
  const landed = current + stale > 0;
  const showAllClients = multi && rollout && landed;
  return {
    multi,
    applicable: applicable.length,
    missing,
    stale,
    current,
    showAllClients,
    allLabel: !showAllClients
      ? null
      : missing > 0
        ? "resources.installAllClients"
        : "resources.updateAllClients",
    thisLabel:
      thisState === "installed"
        ? "resources.reinstallThisClient"
        : thisState === "needsUpdate"
          ? "resources.updateThisClient"
          : "resources.installThisClient",
  };
}
