import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type ReplayMeta } from "@/api";

/**
 * Holds the replay currently open for review (Mode 1). The holographic map
 * reads `current` to render the match; the replay list is populated lazily.
 */
export const useReplayStore = defineStore("replay", () => {
  const list = ref<string[]>([]);
  const current = ref<ReplayMeta | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refreshList(dir?: string) {
    list.value = await api.listReplays(dir);
  }

  async function open(path: string) {
    loading.value = true;
    error.value = null;
    try {
      current.value = await api.readReplayHeader(path);
    } catch (e) {
      error.value = (e as Error).message;
      current.value = null;
    } finally {
      loading.value = false;
    }
  }

  function clear() {
    current.value = null;
    error.value = null;
  }

  return { list, current, loading, error, refreshList, open, clear };
});
