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
  /** Per-release translation sections from the release-notes-i18n-<tag>.json
   *  asset, keyed by app version (the tag minus its "v"). Undefined until a
   *  fetch settles; an empty map means the asset was absent/unusable, so the
   *  English body renders with the fallback hint. */
  const translations = ref<Record<string, ReleaseTranslations>>({});
  const translationsRequested = new Set<string>();
  /** Bumped whenever `refresh` clears the translation cache so the
   *  section's watcher re-runs even when the version list is unchanged
   *  (a refresh that returns the same feed must still re-request the
   *  assets dropped above). */
  const i18nEpoch = ref(0);

  /** Fetch ONE release's translation asset on demand (the section renders
   *  the English body until it lands). The requested set collapses the
   *  render-driven calls; failures cache an empty map so a dead network
   *  cannot re-probe the mirror ladder on every render. */
  async function ensureTranslations(version: string): Promise<void> {
    if (translationsRequested.has(version)) return;
    translationsRequested.add(version);
    try {
      const payload = await invoke<ChangelogI18nPayload | null>(RPC.changelog_i18n, {
        tag: `v${version}`,
      });
      translations.value = { ...translations.value, [version]: payload?.sections ?? {} };
    } catch {
      translations.value = { ...translations.value, [version]: {} };
    }
  }

  /** Fetch the FIRST batch (the section's refresh button). A concurrent
   *  call collapses into the in-flight one. */
  async function refresh() {
    if (loading.value) return;
    loading.value = true;
    error.value = null;
    epoch += 1;
    // A refresh re-streams the feed; let the visible rows re-fetch their
    // translation assets too (immutable per tag, but a failed fetch cached
    // an empty map above and the user's retry deserves a fresh attempt).
    translationsRequested.clear();
    translations.value = {};
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
    translations,
    i18nEpoch,
    refresh,
    loadMore,
    ensureLoaded,
    ensureTranslations,
  };
});
