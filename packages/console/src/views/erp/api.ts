/**
 * The /erp console's API surface. Everything with a matching signature in
 * `@/shared/api` is re-exported from there (single import point for the
 * views) — including the cursor-paged feedback listing
 * (`getFeedbackList(pageToken)`, the Bitable `page_token` /
 * `next_page_token` protocol).
 */

import { getFeedbackList, updateFeedback } from "@/shared/api";

import type { FeedbackListPage } from "./types";

export {
  erpLogin,
  erpLogout,
  getErpSession,
  getReplayAdminCredits,
  getReplayAdminList,
  getReplayAdminWanted,
  replayAdminArchiveUrl,
  replayAdminBackfill,
  replayAdminDrain,
  replayAdminRename,
  saveReplayAdminWanted,
} from "@/shared/api";

export type { ErpSession } from "@/shared/api";

export type {
  AdminContributor,
  BackfillMember,
  BackfillOk,
  CreditsResponse,
  DrainResult,
  FeedbackItem,
  FeedbackListPage,
  ReplayAdminList,
  RenameOk,
  WantedDoc,
  WantedRaw,
  WantedRule,
  WantedSaveOk,
} from "./types";

/** GET /api/feedback/list — one page of review rows (typed view over the
 *  shared cursor-paged call). */
export function listFeedbackPage(pageToken?: string | null): Promise<FeedbackListPage> {
  return getFeedbackList(pageToken ?? undefined) as Promise<FeedbackListPage>;
}

/** POST /api/feedback/update — typed wrapper over the shared free-form
 *  call: `{record_id, status, pr_link}` (server-validated; an empty
 *  `pr_link` is skipped by the handler — a PR link cannot be cleared). */
export function updateFeedbackRow(body: {
  record_id: string;
  status: string;
  pr_link: string;
}): Promise<unknown> {
  return updateFeedback(body);
}

/** Whether a failed call means the session cookie died (the handler
 *  answers 401 `unauthorized`; the cross-origin write guard is 403). */
export function isAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === "unauthorized" || msg === "forbidden" || msg === "HTTP 401" || msg === "HTTP 403";
}
