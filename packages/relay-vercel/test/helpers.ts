/**
 * Shared vitest helpers: env hygiene, the per-instance memory KV reset,
 * and a router-style global fetch mock (no network in tests, ever).
 */

import { afterEach, beforeEach, vi } from "vitest";
import { resetMemoryKvForTests } from "../src/kv";

/** Every env knob the adapter reads (src/config.ts). */
export const ENV_KEYS = [
  "KV_REST_URL",
  "KV_REST_TOKEN",
  "LOOKUP_RATE_PER_HOUR",
  "PEERS_ACCEPT_ANNOUNCES",
  "PEERS_UPSTREAM",
  "PEERS_SYNC",
  "SYNC_PEERS_MAX",
  "NODE_ROLE",
  "NODE_ID",
  "NOTICE",
  "UPSTREAM_OVERRIDE",
] as const;

/**
 * Reset adapter env to a clean slate (memory KV, defaults) and apply
 * overrides. Suites call this in beforeEach; global hooks below wipe
 * everything after each test.
 */
export function freshEnv(overrides: Record<string, string> = {}): void {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  resetMemoryKvForTests();
}

beforeEach(() => {
  resetMemoryKvForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  bodyText: string | null;
}

/**
 * Install a global fetch mock. The handler receives the parsed URL and
 * the fetch init; returning a Response (or a promise of one) answers
 * the call. Throwing simulates a network failure.
 */
export function mockFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>): {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    let bodyText: string | null = null;
    if (init?.body !== undefined && init.body !== null) {
      bodyText =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : "<unhandled body type>";
    }
    calls.push({ url: url.href, init, bodyText });
    return handler(url, init);
  };
  vi.stubGlobal("fetch", vi.fn(fn));
  return { calls };
}

/** A Request against the deployed shape (the adapter is origin-agnostic). */
export function get(pathAndQuery: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://relay.example.vercel.app${pathAndQuery}`, { headers });
}

export function post(pathAndQuery: string, body: string | Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request(`https://relay.example.vercel.app${pathAndQuery}`, {
    method: "POST",
    body: body as BodyInit,
    headers,
  });
}

/**
 * Read a JSON response body. Generic with an `unknown` default so the
 * suites that destructure annotate the shape they assert against (and
 * the rest pass the value straight to `expect`).
 */
export async function jsonOf<T = unknown>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}
