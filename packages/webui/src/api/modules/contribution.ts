/** Replay-share contribution domain of the WoWSP API client (录像共享计划):
 *  the settings sharing section's status card, wizard planner and upload
 *  queue (composed into `api` by client.ts). Every type mirrors
 *  `wowsp_tauri_shared::contribution` (camelCase serde) — the wire truth is
 *  CONTRACT-replay-share.md §9. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** The share progress event channel (mirrors the Rust const). */
export const CONTRIBUTION_PROGRESS_EVENT = "wowsp://contribution-progress";

/** The five realm codes the identity picker accepts (canonical lowercase). */
export const CONTRIBUTION_REALMS = ["ru", "eu", "na", "asia", "cn"] as const;

/** The ship-class spellings a plan hint may carry; anything else (e.g. the
 *  offline DB's "Auxiliary") is passed as null — the Rust side's
 *  plausibility check rejects unknown spellings outright. */
export const CONTRIBUTION_SHIP_CLASSES = [
  "AirCarrier",
  "Battleship",
  "Cruiser",
  "Destroyer",
  "Submarine",
] as const;

export type ContributionShipClass = (typeof CONTRIBUTION_SHIP_CLASSES)[number];

/** Queue stage keys (contract §9; `stage` stays a plain JSON string). */
export const QUEUE_STAGES = [
  "idle",
  "plan",
  "check",
  "mine",
  "pack",
  "upload",
  "done",
  "error",
] as const;
export type QueueStage = (typeof QUEUE_STAGES)[number];

/** Self-declared contributor identity — realm code + credited nickname
 *  (3..24 chars, no control characters; validated on the Rust side). */
export interface ContributionIdentity {
  realm: string;
  name: string;
}

/** The collection watermark: bytes staged across all contributors against
 *  the plan's total budget. */
export interface Watermark {
  stagedBytes: number;
  limitBytes: number;
  accepting: boolean;
}

/** One server-authoritative acceptance rule. Absent/empty arrays mean
 *  "any"; `maxCount` null = unlimited. */
export interface WantedRule {
  id: string;
  collected: number;
  maxCount?: number | null;
  note?: string | null;
  maps: string[];
  /** Canonical match-group keys (`standard` etc. — the replay list filter's
   *  vocabulary). */
  modes: string[];
  scenarios: string[];
  realms: string[];
  shipClasses: string[];
  shipIds: number[];
  tiers: number[];
  playerCountMin?: number | null;
  playerCountMax?: number | null;
  botMax?: number | null;
  clientVersionMin?: string | null;
}

/** The cached `GET /api/replays/wanted` document (empty rules = closed). */
export interface WantedDoc {
  rulesetVersion: number;
  updatedAt: string | null;
  watermark: Watermark;
  rules: WantedRule[];
}

/** One of the contributor's currently staged replays (`GET /mine`). */
export interface StagedEntry {
  sha256: string;
  fileName: string;
  sizeBytes: number;
}

/** The cached `GET /mine` document; a fresh contributor heals to empty. */
export interface MineDoc {
  staged: StagedEntry[];
  archiveBytes: number;
  creditCount: number;
}

/** Client-claimed per-replay facts (contract §2) — the flat wire shape the
 *  manifest members embed (sans sha256/fileName/sizeBytes) is the same core
 *  fields, so one interface serves both. Empty strings mean "unknown". */
export interface ReplayFacts {
  sha256: string;
  fileName: string;
  sizeBytes: number;
  map: string;
  mode: string;
  scenario?: string | null;
  realm: string;
  ownShipId: number;
  shipClass?: string | null;
  tier?: number | null;
  playerCount: number;
  botCount: number;
  clientVersion: string;
  /** RFC3339 UTC; empty = undatable file name. */
  battleTime: string;
}

/** Share-plan verdict (contract §4 precedence: duplicate > own_staged >
 * accept > unwanted). */
export type ContributionVerdict = "accept" | "own_staged" | "duplicate" | "unwanted";

/** One planner input row: the webui enriches the ship class/tier hints off
 *  its offline ship catalog (the replay header only carries the ship id);
 *  Rust reads everything else off the file itself. */
export interface PlanCandidate {
  path: string;
  shipClass?: string | null;
  tier?: number | null;
}

/** One planner output row (verdict-merged: known-hash cache, cached mine
 *  set, wanted-ruleset match). */
export interface PlanItem {
  path: string;
  sha256: string;
  sizeBytes: number;
  facts: ReplayFacts;
  verdict: ContributionVerdict;
  ruleId?: string | null;
  fileName: string;
}

/** Per-item terminal outcome of a started share run. */
export type QueueOutcome = "accepted" | "duplicate" | "unwanted" | "failed";

export interface QueueResult {
  sha256: string;
  fileName: string;
  outcome: QueueOutcome;
}

/** The queue snapshot both `contribution_queue` and every progress event
 *  carry (contract §9). */
export interface QueueSnapshot {
  running: boolean;
  stage: QueueStage | string;
  totalItems: number;
  doneItems: number;
  totalBytes: number;
  currentBytes: number;
  message?: string | null;
  results: QueueResult[];
}

/** The status card's view of the local share state. */
export interface ContributionState {
  identity: ContributionIdentity | null;
  consentVersion?: number | null;
  anonId?: string | null;
  hasUploadToken: boolean;
  creditCount: number;
  stagedCount: number;
  stagedBytes: number;
  lastSyncAt?: string | null;
}

export const contributionApi = {
  /** Local share state (identity, consent, counts, last sync). Never
   *  rejects — an unreadable store degrades to defaults on the Rust side. */
  contributionState: () => transport.invoke<ContributionState>(RPC.contribution_state),
  /** Declare/replace the self-declared identity (realm + nickname). */
  contributionSetIdentity: (realm: string, name: string) =>
    transport.invoke<null>(RPC.contribution_set_identity, { realm, name }),
  /** Record the accepted consent version (monotonic — never lowers). */
  contributionSaveConsent: (version: number) =>
    transport.invoke<null>(RPC.contribution_save_consent, { version }),
  /** Forget identity + token + staged caches (keeps the known-hash cache). */
  contributionForgetIdentity: () => transport.invoke<null>(RPC.contribution_forget_identity),
  /** Wanted ruleset with live counters (10-min local cache; `force`
   *  bypasses it). */
  contributionFetchWanted: (force: boolean) =>
    transport.invoke<WantedDoc>(RPC.contribution_fetch_wanted, { force }),
  /** Re-sync `GET /mine` (404 heals to empty); refreshes the state cache. */
  contributionSyncMine: () => transport.invoke<MineDoc>(RPC.contribution_sync_mine),
  /** Plan a candidate batch: hashes + header-reads each file, merges the
   *  local verdict mirror. Advisory only — the pipeline always re-checks
   *  server-side. */
  contributionPlan: (items: PlanCandidate[]) =>
    transport.invoke<PlanItem[]>(RPC.contribution_plan, { items }),
  /** Launch the single-flight background share pipeline
   *  (plan → check → mine → pack → upload); progress arrives on
   *  `wowsp://contribution-progress`. */
  contributionStart: (items: PlanCandidate[]) =>
    transport.invoke<null>(RPC.contribution_start, { items }),
  /** Cancel the in-flight pipeline (cooperative; stages check between
   *  items). */
  contributionCancel: () => transport.invoke<null>(RPC.contribution_cancel),
  /** Direct queue snapshot (the progress event's exact shape). */
  contributionQueue: () => transport.invoke<QueueSnapshot>(RPC.contribution_queue),
  /** The share-pipeline progress stream. Outside the Tauri shell (browser
   *  dev without a mock bus) the handler simply never fires. */
  listenContributionProgress: (handler: (q: QueueSnapshot) => void) =>
    transport.listen?.<QueueSnapshot>(CONTRIBUTION_PROGRESS_EVENT, handler),
};
