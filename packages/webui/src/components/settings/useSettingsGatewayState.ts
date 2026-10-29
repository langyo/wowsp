/** Gateway-section state for SettingsBody (the evolved pairing slot):
 *  the route-entry draft (official default / editable custom root), the
 *  mobile-service toggle driving gateway_publish_start/stop on the
 *  session-hub route, the publish status pill (wowsp://gateway-state via
 *  the store), and the self-host wizard's open flag. */
import { computed, onMounted, ref } from "vue";
import { useToast } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { GATEWAY_OFFICIAL_ROOT } from "@/api";
import { useGatewayStore } from "@/stores/gateway";
import { useShownPlayer } from "@/composables/useShownPlayer";
import { gatewayRoute } from "@/features/replay/gateway/gatewayBattle";

export function useSettingsGatewayState() {
  const gateway = useGatewayStore();
  const toast = useToast();
  const { shownPlayer } = useShownPlayer();

  onMounted(() => void gateway.loadConfig());

  /** The publish route — the session hub's resolved identity (falls back
   *  to the active account); null until one exists (§2: the caller — the
   *  webui — derives it). */
  const route = computed(() => {
    const p = shownPlayer.value;
    return p && p.accountId != null ? gatewayRoute(p.realm, p.accountId) : null;
  });

  // ── route entry ───────────────────────────────────────────────────────
  /** Whether the configured root is the official default (readonly
   *  display) — the custom branch carries the editable field. */
  const usingOfficial = computed(() => !gateway.isCustomRoot);
  /** The custom-root edit draft; seeded from the config once it lands. */
  const rootDraft = ref("");
  const rootBusy = ref(false);
  const rootError = ref<string | null>(null);
  const rootSavedTick = ref(0);

  /** React to config loads / external saves: keep the draft in step. */
  function syncDraft(): void {
    rootDraft.value = usingOfficial.value ? "" : gateway.config.root;
  }
  onMounted(syncDraft);

  /** Save the custom root (Rust normalizes; the echoed config re-seeds
   *  the draft). */
  async function saveCustomRoot(raw: string): Promise<void> {
    const root = raw.trim();
    if (!root || rootBusy.value) return;
    rootBusy.value = true;
    rootError.value = null;
    try {
      await gateway.saveConfig({ root });
      rootSavedTick.value += 1;
      syncDraft();
      toast.success(t("gateway.rootSaved"));
    } catch (e) {
      rootError.value = e instanceof Error ? e.message : String(e);
    } finally {
      rootBusy.value = false;
    }
  }

  /** Switch back to the official deployment's entry. */
  async function useOfficialRoot(): Promise<void> {
    if (rootBusy.value || usingOfficial.value) return;
    rootBusy.value = true;
    rootError.value = null;
    try {
      await gateway.saveConfig({ root: GATEWAY_OFFICIAL_ROOT });
      rootSavedTick.value += 1;
      syncDraft();
    } catch (e) {
      rootError.value = e instanceof Error ? e.message : String(e);
    } finally {
      rootBusy.value = false;
    }
  }

  // ── mobile-service toggle ─────────────────────────────────────────────
  const toggleBusy = ref(false);
  /** Enable → persist + publish on the session-hub route (a captcha-demand
   *  rejection is EXPECTED — the sidebar's GatewayCaptchaHint owns the
   *  challenge and the retry; everything else surfaces). Disable → stop. */
  async function setEnabled(on: boolean): Promise<void> {
    if (toggleBusy.value) return;
    toggleBusy.value = true;
    try {
      await gateway.saveConfig({ enabled: on });
      if (on) {
        if (!route.value) {
          toast.error(t("gateway.noAccount"));
          return;
        }
        try {
          await gateway.startPublish(route.value);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/captcha/.test(msg)) throw e;
          // The captcha phase + hint own this path (§5.2).
        }
      } else {
        await gateway.stopPublish();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (gateway.isCustomRoot) {
        toast.error(t("gateway.customNodeError", { detail: msg }));
      } else {
        toast.error(msg);
      }
    } finally {
      toggleBusy.value = false;
    }
  }

  // ── self-host wizard ──────────────────────────────────────────────────
  const wizardOpen = ref(false);

  return {
    gateway,
    route,
    shownPlayer,
    usingOfficial,
    rootDraft,
    rootBusy,
    rootError,
    rootSavedTick,
    saveCustomRoot,
    useOfficialRoot,
    toggleBusy,
    setEnabled,
    wizardOpen,
  };
}
