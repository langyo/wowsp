import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type ReplayMeta, type ReplayMetaLite } from "@/api";

/**
 * Holds the replay currently open for review (Mode 1). The holographic map
 * reads `current` to render the match; the replay list carries the parsed
 * descriptor metadata (date/mode/map/own ship) so the list view can render
 * info cards without opening each replay's packet stream.
 */
export const useReplayStore = defineStore("replay", () => {
  const list = ref<ReplayMetaLite[]>([]);
  const current = ref<ReplayMeta | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refreshList(dir?: string) {
    list.value = await api.listReplaysMeta(dir);
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
