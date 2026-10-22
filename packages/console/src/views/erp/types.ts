/**
 * Typed shapes of the /erp console's API responses — each one mirrors the
 * relay-worker handler that produces it (the comment names the file:line
 * face). The wire stays the authority: fields the page does not read are
 * not listed, and loose-optionality marks fields the handler may omit.
 */

// ── session (relay-worker/src/erp.rs — /api/erp/session) ─────────────────

export interface ErpSessionOk {
  ok: true;
  /** Feishu display name (may be blank for anonymized profiles). */
  name?: string;
  avatar?: string;
  /** Contact re-read outcome; anything but "refreshed" is a warning. */
  debug?: string;
  /** Set under the ERP_OPEN_ACCESS legacy gate — the caller's open_id
   *  for the allowlist hint. */
  open_access?: string;
}

// ── feedback review (relay-worker/src/feedback.rs) ────────────────────────

/** One row of GET /api/feedback/list (handle_list). */
export interface FeedbackItem {
  record_id: string;
  /** Submit timestamp in milliseconds; null when the sheet cell is empty. */
  time: number | null;
  description: string;
  contact: string;
  version: string;
  sysinfo: string;
  server: string;
  game_id: string;
  channel: string;
  status: string;
  /** URL string or null. */
  pr: string | null;
  attachments: { name: string; size: number; url: string }[];
  record_url: string;
}

/** GET /api/feedback/list (handle_list) — page_token pagination, NOT
 *  page numbers: `next_page_token` feeds the next request's `page_token`. */
export interface FeedbackListPage {
  ok: boolean;
  items: FeedbackItem[];
  next_page_token: string | null;
}

// ── replay-share admin (relay-worker/src/replay.rs → relay-core) ──────────

/** GET /api/replays/admin/list row (admin_list_response). */
export interface AdminContributor {
  anonId: string;
  creditedName: string;
  realm: string;
  stagedCount: number;
  archiveBytes: number;
  /** ISO-8601 UTC string. */
  updatedAt: string;
}

export interface ReplayAdminList {
  contributors: AdminContributor[];
  watermark: { stagedBytes: number; limitBytes: number };
}

/** GET /api/replays/admin/wanted (handle_admin_wanted) — the RAW stored
 *  ruleset text, not the merged counters view. */
export interface WantedRaw {
  exists: boolean;
  raw: string;
}

/** POST .../wanted success ({ok, rulesetVersion, rules}); failure comes
 *  back as HTTP 400 + {ok: false, error} (the client throws the error). */
export interface WantedSaveOk {
  ok: true;
  rulesetVersion: number;
  rules: number;
}

/** The canonical wanted-ruleset document shape (relay-core validate /
 *  WantedRule serde) — parsed LENIENTLY for the summary table; the
 *  server validates the real thing on save. */
export interface WantedRule {
  id?: string;
  note?: string;
  maps?: string[];
  modes?: string[];
  scenarios?: string[];
  realms?: string[];
  shipClasses?: string[];
  shipIds?: number[];
  tiers?: number[];
  playerCountMin?: number | null;
  playerCountMax?: number | null;
  botMax?: number | null;
  clientVersionMin?: string;
  maxCount?: number | null;
}

export interface WantedDoc {
  rulesetVersion?: number;
  updatedAt?: string;
  rules?: WantedRule[];
}

/** GET /api/replays/admin/credits (credits_response) — the per-identity
 *  lifetime share counts. */
export interface CreditsResponse {
  contributors: { name: string; realm: string; count: number }[];
}

/** POST /api/replays/admin/drain {anonIds} (handle_admin_drain). */
export interface DrainResult {
  drained: string[];
  bytes: number;
}

/** POST .../rename success; 404 surfaces as Error("unknown_contributor"). */
export interface RenameOk {
  ok: true;
  name: string;
}

/** POST .../backfill success; 409 surfaces as Error("identity_conflict"). */
export interface BackfillOk {
  ok: true;
  credited: number;
  duplicates: number;
  name: string;
}

/** One member row of the backfill request (BackfillMember, camelCase
 *  serde). `ruleId` is optional (None = credited outside any rule). */
export interface BackfillMember {
  sha256: string;
  fileName: string;
  sizeBytes: number;
  ruleId?: string;
}
