/**
 * Compile-time capability flags (AI inference + the Windows DirectML
 * runtime). Probed once per app lifetime from the Rust shell.
 *
 * Fail-closed: until the probe answers, `aiInference` stays false so a
 * portable build can never briefly enable the AI surfaces. Browser dev and
 * older shells have no command route — those fall back to the full-feature
 * defaults so the dev UI keeps its behaviour.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { api, type RuntimeCapabilities } from "@/api";
import { isNative } from "@/utils/platform";

export const useCapabilitiesStore = defineStore("capabilities", () => {
  const aiInference = ref(false);
  const portable = ref(false);
  const directmlRequired = ref(false);
  const directmlPresent = ref(false);
  const directmlBytes = ref<number | null>(null);
  const loaded = ref(false);
  let pending: Promise<void> | null = null;

  /** True only when the active binary can serve AI inference. */
  const aiAvailable = computed(() => aiInference.value);

  function apply(caps: RuntimeCapabilities): void {
    aiInference.value = caps.aiInference;
    portable.value = caps.portable;
    directmlRequired.value = caps.directmlRequired;
    directmlPresent.value = caps.directmlPresent;
    directmlBytes.value = caps.directmlBytes;
  }

  /** Idempotent startup probe; concurrent callers share one request. */
  async function load(): Promise<void> {
    if (loaded.value) return;
    if (!pending) {
      pending = api
        .getRuntimeCapabilities()
        .then(apply)
        .catch(() => {
          // Browser dev / mock backend: preserve the pre-split behaviour.
          // A REAL shell failure stays fail-closed — a portable binary must
          // never enable AI surfaces because the probe hiccuped.
          if (!isNative()) aiInference.value = true;
          portable.value = false;
          directmlRequired.value = false;
          directmlPresent.value = false;
          directmlBytes.value = null;
        })
        .finally(() => {
          loaded.value = true;
          pending = null;
        });
    }
    await pending;
  }

  return {
    aiInference,
    aiAvailable,
    portable,
    directmlRequired,
    directmlPresent,
    directmlBytes,
    loaded,
    load,
  };
});
