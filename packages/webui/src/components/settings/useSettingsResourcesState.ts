/** Settings → Resources state: the installed `decisions` model-pack
 *  inventory, the AI model channel (Hugging Face signed manifest) check /
 *  download pass, and the two-step delete. The compile-time AI capability
 *  and the DirectML runtime probe live in the shared capabilities store;
 *  the pack inventory commands themselves are filesystem-only and exist in
 *  every build, so an orphaned pack can still be inspected and cleared from
 *  the portable build. The ai channel commands exist only in the ai build.
 */
import { getCurrentScope, onScopeDispose, ref } from "vue";

import {
  api,
  type AiPackCheck,
  type AiPackStatus,
  type DecisionsPackStatus,
  type DownloadProgress,
} from "@/api";

import { useCapabilitiesStore } from "@/stores/capabilities";

/** The explicit/boot check is rate-limited to one authenticated manifest
 *  fetch per day per installation; the card's button bypasses the TTL. */
const AI_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const AI_LAST_CHECK_KEY = "wowsp.aiPack.lastCheck";

function lastCheckAt(): number {
  try {
    const raw = window.localStorage.getItem(AI_LAST_CHECK_KEY);
    const parsed = raw == null ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function noteLastCheck(): void {
  try {
    window.localStorage.setItem(AI_LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // Private-mode storage failures only cost the TTL.
  }
}

export function useSettingsResourcesState() {
  const capabilities = useCapabilitiesStore();
  const decisions = ref<DecisionsPackStatus | null>(null);
  const decisionsBusy = ref(false);
  const decisionsClearing = ref(false);
  /** True once a status read (successful or not) has completed. */
  const decisionsChecked = ref(false);
  const decisionsError = ref(false);
  /** Two-step delete confirm for the decisions pack. */
  const decisionsArmed = ref(false);
  /** A pack model was cleared this session; it stays loaded until restart. */
  const decisionsCleared = ref(false);

  /** The ai channel's local install state (stamp + inventory). */
  const aiStatus = ref<AiPackStatus | null>(null);
  /** The last authenticated remote check (null until one succeeds). */
  const aiCheck = ref<AiPackCheck | null>(null);
  const aiChecking = ref(false);
  const aiDownloading = ref(false);
  const aiCanceling = ref(false);
  const aiError = ref(false);
  /** The running install pass's progress tick (kind "ai-models"). */
  const aiProgress = ref<DownloadProgress | null>(null);
  let detachProgress: (() => void) | null = null;

  function ensureProgressWired(): void {
    if (detachProgress) return;
    detachProgress =
      api.listenDownloadProgress?.((p: DownloadProgress) => {
        if (p.kind !== "ai-models") return;
        if (p.phase === "done" || p.phase === "error") {
          aiProgress.value = null;
          return;
        }
        aiProgress.value = p;
      }) ?? null;
  }

  // Detach the progress listener with the owning component scope; the
  // state hook is also constructed by tests outside a component scope, where
  // Vue has nothing to register against.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      detachProgress?.();
      detachProgress = null;
    });
  }

  /** Reload the pack inventory. A failed refresh keeps the last known
   *  status; only a first-ever failure renders the unknown state. */
  async function refreshDecisions(): Promise<void> {
    await capabilities.load();
    if (decisionsBusy.value) return;
    decisionsBusy.value = true;
    try {
      decisions.value = await api.decisionsPackStatus();
      decisionsError.value = false;
      if (decisions.value.modelPresent) decisionsCleared.value = false;
      if (capabilities.aiInference) {
        await refreshAiStatus();
        if (!aiChecking.value && Date.now() - lastCheckAt() > AI_CHECK_TTL_MS) {
          void checkAiUpdate();
        }
      }
    } catch {
      decisionsError.value = true;
    } finally {
      decisionsBusy.value = false;
      decisionsChecked.value = true;
    }
  }

  /** Read the ai channel's local state (no network). */
  async function refreshAiStatus(): Promise<void> {
    if (!capabilities.aiInference) return;
    try {
      aiStatus.value = await api.aiPackStatus();
      aiError.value = false;
    } catch {
      aiError.value = true;
    }
  }

  /** Fetch + authenticate the published manifest (no download). */
  async function checkAiUpdate(): Promise<void> {
    if (!capabilities.aiInference || aiChecking.value) return;
    aiChecking.value = true;
    aiError.value = false;
    try {
      aiCheck.value = await api.aiPackCheck();
      aiStatus.value = aiCheck.value.current;
      noteLastCheck();
    } catch {
      aiError.value = true;
      aiCheck.value = null;
    } finally {
      aiChecking.value = false;
    }
  }

  /** Download, verify and install the published pack. */
  async function downloadAi(): Promise<void> {
    if (!capabilities.aiInference || aiDownloading.value) return;
    aiDownloading.value = true;
    aiError.value = false;
    ensureProgressWired();
    try {
      await api.aiPackDownload();
      aiCheck.value = null;
      await refreshAiStatus();
      await checkAiUpdate();
    } catch {
      aiError.value = true;
    } finally {
      aiDownloading.value = false;
      aiProgress.value = null;
    }
  }

  async function cancelAi(): Promise<void> {
    if (!aiDownloading.value || aiCanceling.value) return;
    aiCanceling.value = true;
    try {
      await api.aiPackCancel();
    } catch {
      aiError.value = true;
    } finally {
      aiCanceling.value = false;
    }
  }

  async function clearDecisions(): Promise<void> {
    if (decisionsClearing.value) return;
    decisionsClearing.value = true;
    try {
      await api.clearDecisionsPack();
      decisionsCleared.value = true;
      decisionsError.value = false;
      aiCheck.value = null;
      await refreshAiStatus();
    } catch {
      decisionsError.value = true;
    }
    decisionsArmed.value = false;
    await refreshDecisions();
    decisionsClearing.value = false;
  }

  return {
    capabilities,
    decisions,
    decisionsBusy,
    decisionsClearing,
    decisionsChecked,
    decisionsError,
    decisionsArmed,
    decisionsCleared,
    refreshDecisions,
    clearDecisions,
    aiStatus,
    aiCheck,
    aiChecking,
    aiDownloading,
    aiCanceling,
    aiError,
    aiProgress,
    refreshAiStatus,
    checkAiUpdate,
    downloadAi,
    cancelAi,
  };
}
