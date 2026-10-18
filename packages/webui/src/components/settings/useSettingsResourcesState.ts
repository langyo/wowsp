/** Settings → Resources state: the installed `decisions` model-pack
 *  inventory and its two-step delete. The compile-time AI capability and the
 *  DirectML runtime probe live in the shared capabilities store; the pack
 *  commands themselves are filesystem-only and exist in every build, so an
 *  orphaned pack can still be inspected and cleared from the portable build.
 */
import { ref } from "vue";

import { api, type DecisionsPackStatus } from "@/api";
import { useCapabilitiesStore } from "@/stores/capabilities";

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
    } catch {
      decisionsError.value = true;
    } finally {
      decisionsBusy.value = false;
      decisionsChecked.value = true;
    }
  }

  async function clearDecisions(): Promise<void> {
    if (decisionsClearing.value) return;
    decisionsClearing.value = true;
    try {
      await api.clearDecisionsPack();
      decisionsCleared.value = true;
      decisionsError.value = false;
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
  };
}
