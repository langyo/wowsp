import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import { RPC } from "@/rpc";
import type { ReleaseTranslations } from "@/utils/releaseI18n";

/** One GitHub release as served by the Rust `changelog_list` command
 *  (app tag minus the `v`, publish timestamp, markdown body — infra
 *  releases like res-latest/mod-hub are filtered out Rust-side). */
export interface ChangelogRelease {
  version: string;
  published_at: string;
  body: string;
}

/** One streamed batch from `changelog_list`: the visible releases plus
 *  the continuation — `has_more` and the raw-page cursor `next_page` to
 *  hand straight back into the next call (0 once exhausted). */
export interface ChangelogPage {
  releases: ChangelogRelease[];
  has_more: boolean;
  next_page: number;
}

/** One release's release-notes-i18n-<tag>.json asset, as served by the
 *  Rust changelog_i18n command (sections keyed by locale; null when the
 *  release has no asset). */
export interface ChangelogI18nPayload {
  tag: string;
  sections: ReleaseTranslations;
}

/** One release's translation-asset fetch, as the changelog section
 *  renders it. "loading" is the in-flight state (the card keeps its
 *  English body and adds the translating row above it); "ready" carries
 *  the sections; "missing" means the release genuinely ships no asset
 *  (old releases — English body plus the fallback hint); "error" means
 *  the fetch FAILED (transport/HTTP) and the card offers a retry instead
 *  of claiming the translation does not exist. */
export type ReleaseTranslationState =
  | { status: "loading" }
  | { status: "ready"; sections: ReleaseTranslations }
  | { status: "missing" }
  | { status: "error"; error: string };

/**
 * Changelog store, backed by the Rust `changelog_list` command: the
 * release list streams from GitHub's Releases API through the mirror
 * ladder (user mirror → official route → ghproxy prefixes — see
 * commands/changelog.rs). The repo deliberately keeps no changelog file,
 * so GitHub is the only source of release notes.
 *
 * Fetching is progressive: the first visible batch loads when the section
 * comes up, and `loadMore` streams the next batch as the user scrolls —
 * only the batches actually reached are ever fetched. The section's
 * refresh button calls `refresh`, which restarts the stream at page 1. In
 * browser-only dev mode the command throws (no Tauri runtime); the
 * failure lands in `error` so the section renders its retry state.
 */
export const useChangelogStore = defineStore("changelog", () => {
  const releases = ref<ChangelogRelease[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loaded = ref(false);
  const hasMore = ref(false);
  const nextPage = ref(0);
  const loadingMore = ref(false);
  /** Stream epoch: `refresh` bumps it so a loadMore already in flight
   *  cannot append its stale batch onto the restarted list. */
  let epoch = 0;
  /** Per-release translation asset state, keyed by app version (the tag
   *  minus its "v"). Absent until the section's viewport watcher asks for
   *  the card; "missing" is the genuinely asset-less old release while
   *  "error" is a retryable failed fetch. */
  const translationStates = ref<Record<string, ReleaseTranslationState>>({});
  /** Bumped whenever `refresh` clears the translation cache so the
   *  section's watcher re-runs even when the version list is unchanged
   *  (a refresh that returns the same feed must still re-request the
   *  assets dropped above). */
  const i18nEpoch = ref(0);

  /** Replace ONE release's state (a fresh map so every transition
   *  re-renders the section). */
  function setTranslationState(version: string, state: ReleaseTranslationState): void {
    translationStates.value = { ...translationStates.value, [version]: state };
  }

  /** Monotonic per-release fetch tokens: every attempt claims the current
   *  token and only a completion that still owns it may land. A fetch in
   *  flight when `refresh`/`retryTranslations` supersedes it therefore
   *  cannot overwrite the fresher state — a late failure flipping a
   *  translated card back to the retry chip was the round-3 race. */
  const fetchTokens = new Map<string, number>();

  function nextFetchToken(version: string): number {
    const token = (fetchTokens.get(version) ?? 0) + 1;
    fetchTokens.set(version, token);
    return token;
  }

  function ownsFetchToken(version: string, token: number): boolean {
    return fetchTokens.get(version) === token;
  }

  /** Fetch ONE release's translation asset on demand (the section renders
   *  the English body until it lands). Idempotent per release: an entry
   *  in flight, ready or genuinely missing is left alone, so scroll
   *  ticks and re-renders cannot re-probe the mirror ladder — the one
   *  retry path is `retryTranslations` (the card's retry chip).
   *
   *  The Rust command answers payload → ready, null → missing (the
   *  release ships no asset) and REJECTS on transport/HTTP failure. The
   *  distinction matters: a rejection is never reported as "this release
   *  has no translation", it becomes a retryable error. A non-object
   *  payload (older shell, a proxy answering junk) reads as missing
   *  rather than crashing the pane. */
  async function ensureTranslations(version: string): Promise<void> {
    const current = translationStates.value[version];
    if (current && current.status !== "error") return;
    const token = nextFetchToken(version);
    setTranslationState(version, { status: "loading" });
    try {
      const payload = await invoke<ChangelogI18nPayload | null>(RPC.changelog_i18n, {
        tag: `v${version}`,
      });
      // A superseded attempt is dropped silently — never reported as the
      // release's current outcome.
      if (!ownsFetchToken(version, token)) return;
      const sections = payload?.sections;
      setTranslationState(
        version,
        sections && typeof sections === "object"
          ? { status: "ready", sections }
          : { status: "missing" },
      );
    } catch (e) {
      if (!ownsFetchToken(version, token)) return;
      // Tauri rejects commands with the raw Err string, not an Error.
      setTranslationState(version, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Forget one release's settled state and fetch it again — the retry
   *  chip on a failed card. */
  async function retryTranslations(version: string): Promise<void> {
    const next = { ...translationStates.value };
    delete next[version];
    translationStates.value = next;
    // Supersede an attempt still in flight for this version: its
    // completion must not land on the retry's fresh state.
    nextFetchToken(version);
    await ensureTranslations(version);
  }

  /** Fetch the FIRST batch (the section's refresh button). A concurrent
   *  call collapses into the in-flight one. */
  async function refresh() {
    if (loading.value) return;
    loading.value = true;
    error.value = null;
    epoch += 1;
    // A refresh re-streams the feed; let the visible rows re-fetch their
    // translation assets too (immutable per tag, but a failed fetch must
    // get a fresh attempt once the feed comes back). Bumping every known
    // token supersedes fetches still in flight: their completions belong
    // to the old list and must not land on the restarted one.
    translationStates.value = {};
    for (const version of fetchTokens.keys()) nextFetchToken(version);
    i18nEpoch.value += 1;
    try {
      const page = await invoke<ChangelogPage>(RPC.changelog_list, { page: 1 });
      releases.value = page.releases;
      hasMore.value = page.has_more;
      nextPage.value = page.next_page;
      loaded.value = true;
    } catch (e) {
      // Mirror probes fail offline / behind firewalls — Tauri rejects
      // commands with the raw Err string, not an Error instance.
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  /** Stream the next batch onto the list (the section's scroll sentinel).
   *  A failure keeps the fetched feed on screen — the error card rides
   *  above it, and `refresh` is the retry (a dead network must not
   *  re-probe the whole mirror ladder on every scroll tick). Already
   *  listed versions are dropped, so a release published between two
   *  loads cannot render twice, and a batch that lands after a refresh
   *  started is discarded with its stale cursor. */
  async function loadMore() {
    if (loading.value || loadingMore.value || error.value) return;
    if (!hasMore.value || !nextPage.value) return;
    loadingMore.value = true;
    const mine = epoch;
    try {
      const page = await invoke<ChangelogPage>(RPC.changelog_list, { page: nextPage.value });
      if (mine !== epoch) return;
      const seen = new Set(releases.value.map((r) => r.version));
      releases.value.push(...page.releases.filter((r) => !seen.has(r.version)));
      hasMore.value = page.has_more;
      nextPage.value = page.next_page;
    } catch (e) {
      if (mine !== epoch) return;
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loadingMore.value = false;
    }
  }

  /** Fetch once per session unless the last attempt failed — the section
   *  activators call this on every open, and a dead network must not
   *  re-probe the whole mirror ladder each time. */
  async function ensureLoaded() {
    if (loaded.value || loading.value || error.value) return;
    await refresh();
  }

  return {
    releases,
    loading,
    error,
    loaded,
    hasMore,
    nextPage,
    loadingMore,
    translationStates,
    i18nEpoch,
    refresh,
    loadMore,
    ensureLoaded,
    ensureTranslations,
    retryTranslations,
  };
});
