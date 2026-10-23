/**
 * Same-origin API client for both console entries. Every call is relative
 * — the pages are served by the worker's own [assets] layer, and the dev
 * server proxies /api to `wrangler dev` (see vite.config.ts).
 *
 * Response shapes mirror the relay-worker handlers; where a shape is
 * wide (admin rows evolve), the type stays intentionally loose and the
 * page components document what they read.
 */

async function json<T>(resOrPromise: Response | Promise<Response>): Promise<T> {
  const res = await resOrPromise;
  if (!res.ok) {
    let code = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) code = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(code);
  }
  return (await res.json()) as T;
}

// ── public feedback surface ────────────────────────────────────────────────

/** GET /api/feedback/config — the values the worker used to server-inject
 *  into the page HTML (Turnstile sitekey, latest version prefill). */
export interface FeedbackConfig {
  sitekey: string;
  latestVersion: string;
}

export async function getFeedbackConfig(): Promise<FeedbackConfig> {
  return json(fetch("api/feedback/config"));
}

export interface SubmitResult {
  ok: boolean;
  record_url?: string;
  /** null when the submission carried no contact (audit M-7). */
  lookup_token: string | null;
}

/** POST /api/feedback/submit — multipart, same parts the embedded page
 *  sent; `turnstile` is the widget token. Returns the one-time lookup
 *  credential (see audit M-7). */
export async function submitFeedback(
  parts: {
    description: string;
    contact: string;
    version: string;
    sysinfo: string;
    channel: string;
    anon: string;
    server: string;
    game_id: string;
    file?: Blob | null;
    fileName?: string;
  },
  turnstile: string,
): Promise<SubmitResult> {
  const fd = new FormData();
  fd.set("description", parts.description);
  fd.set("contact", parts.contact);
  fd.set("version", parts.version);
  fd.set("sysinfo", parts.sysinfo);
  fd.set("channel", parts.channel);
  fd.set("anon", parts.anon);
  fd.set("server", parts.server);
  fd.set("game_id", parts.game_id);
  if (parts.file) fd.set("file", parts.file, parts.fileName ?? "attachment");
  fd.set("cf-turnstile-response", turnstile);
  const res = await fetch("api/feedback/submit", { method: "POST", body: fd });
  if (!res.ok) {
    // Error bodies are JSON {"error": code} (429 rate_limited etc.).
    let code = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) code = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(code);
  }
  return (await res.json()) as SubmitResult;
}

/** GET /api/feedback/history?token=… — the submitter's own rows, keyed by
 *  the one-time lookup credential (never by contact — audit M-7). */
export async function getFeedbackHistory(token: string): Promise<unknown> {
  return json(fetch(`api/feedback/history?token=${encodeURIComponent(token)}`));
}

// ── erp session surface ────────────────────────────────────────────────────

export interface ErpSession {
  ok: boolean;
  name?: string;
  avatar?: string;
  debug?: string;
  /** The holder sits in the ADMIN tier (env allowlist): full control,
   *  including the people-management surface. Members see false. */
  admin?: boolean;
}

export async function getErpSession(): Promise<ErpSession> {
  return json(fetch("api/erp/session"));
}

export async function erpLogout(): Promise<void> {
  await fetch("api/erp/logout", { method: "POST" });
}

/** The login hand-off is a full redirect (Feishu OAuth), not an XHR. */
export function erpLogin(): void {
  window.location.href = "api/erp/login";
}

// ── erp people management (admin tier) ─────────────────────────────────────

/** One Feishu org user row (GET /api/erp/users). */
export interface ErpOrgUser {
  open_id: string;
  name: string;
  avatar: string;
}

export interface ErpUsersPage {
  ok: boolean;
  users: ErpOrgUser[];
  next_page_token: string | null;
}

/** GET /api/erp/users — one page of org users under a department
 *  (department_id defaults to the root on the worker side). */
export async function getErpUsers(pageToken?: string): Promise<ErpUsersPage> {
  const qs = new URLSearchParams();
  if (pageToken) qs.set("page_token", pageToken);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return json(fetch(`api/erp/users${suffix}`));
}

export interface ErpMembers {
  ok: boolean;
  /** KV-managed view-access tier. */
  members: string[];
  /** Env-configured admin tier (un-revocable from the console). */
  admins: string[];
}

export async function getErpMembers(): Promise<ErpMembers> {
  return json(fetch("api/erp/members"));
}

export async function setErpMember(
  openId: string,
  action: "add" | "remove",
): Promise<ErpMembers> {
  return json(
    fetch("api/erp/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ open_id: openId, action }),
    }),
  );
}

// ── erp review console ─────────────────────────────────────────────────────

/** GET /api/feedback/list — session-gated; the Bitable cursor protocol:
 *  pass the previous page's `next_page_token` (omit for the first page);
 *  the response carries `next_page_token` while more rows remain. Row
 *  shape evolves with the Bitable schema (the page documents the fields
 *  it reads). */
export async function getFeedbackList(
  pageToken?: string,
  pageSize = 50,
): Promise<unknown> {
  const qs = new URLSearchParams({ page_size: String(pageSize) });
  if (pageToken) qs.set("page_token", pageToken);
  return json(fetch(`api/feedback/list?${qs.toString()}`));
}

/** POST /api/feedback/update — status transition + PR link. */
export async function updateFeedback(body: Record<string, unknown>): Promise<unknown> {
  return json(
    fetch("api/feedback/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// ── erp replay-share admin ─────────────────────────────────────────────────

export async function getReplayAdminList(): Promise<unknown> {
  return json(fetch("api/replays/admin/list"));
}

/** 302 to the contributor's shard stream — navigate, do not XHR. */
export function replayAdminArchiveUrl(anonId: string): string {
  return `api/replays/admin/archive?anon_id=${encodeURIComponent(anonId)}`;
}

export async function getReplayAdminWanted(): Promise<{ exists: boolean; raw: string }> {
  return json(fetch("api/replays/admin/wanted"));
}

export async function saveReplayAdminWanted(raw: string): Promise<unknown> {
  return json(
    fetch("api/replays/admin/wanted", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    }),
  );
}

export async function getReplayAdminCredits(): Promise<unknown> {
  return json(fetch("api/replays/admin/credits"));
}

export async function replayAdminDrain(body: Record<string, unknown>): Promise<unknown> {
  return json(
    fetch("api/replays/admin/drain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function replayAdminRename(body: Record<string, unknown>): Promise<unknown> {
  return json(
    fetch("api/replays/admin/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function replayAdminBackfill(body: Record<string, unknown>): Promise<unknown> {
  return json(
    fetch("api/replays/admin/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
