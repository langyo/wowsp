import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import { RPC } from "@/rpc";

/** One GitHub release as served by the Rust `changelog_list` command
 *  (app tag minus the `v`, publish timestamp, markdown body — infra
 *  releases like res-latest/mod-hub are filtered out Rust-side). */
export interface ChangelogRelease {
  version: string;
  published_at: string;
  body: string;
}

/**
 * Changelog store, backed by the Rust `changelog_list` command: the
 * release list streams from GitHub's Releases API through the mirror
 * ladder (user mirror → official route → ghproxy prefixes — see
 * commands/changelog.rs). The repo deliberately keeps no changelog file,
 * so GitHub is the only source of release notes.
 *
 * Fetching is section-activated, not startup-automatic: SettingsBody's
 * activators call `ensureLoaded` when the 更新日志 section comes up, the
 * section's refresh button calls `refresh` directly. In browser-only dev
 * mode the command throws (no Tauri runtime); the failure lands in
 * `error` so the section renders its retry state.
 */
export const useChangelogStore = defineStore("changelog", () => {
  const releases = ref<ChangelogRelease[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loaded = ref(false);

  /** Fetch the release list (the section's refresh button). A concurrent
   *  call collapses into the in-flight one. */
  async function refresh() {
    if (loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      releases.value = await invoke<ChangelogRelease[]>(RPC.changelog_list);
      loaded.value = true;
    } catch (e) {
      // Mirror probes fail offline / behind firewalls — Tauri rejects
      // commands with the raw Err string, not an Error instance.
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  /** Fetch once per session unless the last attempt failed — the section
   *  activators call this on every open, and a dead network must not
   *  re-probe the whole mirror ladder each time. */
  async function ensureLoaded() {
    if (loaded.value || loading.value || error.value) return;
    await refresh();
  }

  return { releases, loading, error, loaded, refresh, ensureLoaded };
});
