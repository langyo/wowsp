/** Network-section state for SettingsBody: the proxy/resource-CDN form and
 *  its save round-trip (mode switches apply immediately, URL rows commit via
 *  保存 / Enter). */
import { computed, onMounted, ref } from "vue";

import { api, type NetworkConfig } from "@/api";

export function useSettingsNetworkState() {
  // ── Network proxy (global for all outbound requests) ──────────────────
  // Mode changes apply immediately; the URL / resource CDN rows commit via
  // 保存 / Enter. `netLastSaved` mirrors what the backend holds so the save
  // button only lights up on a real change, and the saved URL stays visible
  // (greyed out) even while system/none mode is active.
  const netCfg = ref<NetworkConfig>({ mode: "system", proxy: null, resourceCdn: null });
  const netLastSaved = ref<NetworkConfig>({ mode: "system", proxy: null, resourceCdn: null });
  const netSavedFlash = ref(false);
  let netFlashTimer: number | undefined;

  const netDirty = computed(() => {
    const cur = netCfg.value;
    const last = netLastSaved.value;
    return (
      cur.mode !== last.mode ||
      (cur.proxy?.trim() || null) !== last.proxy ||
      (cur.resourceCdn?.trim() || null) !== last.resourceCdn
    );
  });

  onMounted(async () => {
    try {
      const cfg = await api.getNetworkConfig();
      netCfg.value = { ...cfg };
      netLastSaved.value = { ...cfg };
    } catch {
      // mock backend / older shell without the command — keep defaults
    }
  });

  async function selectNetMode(mode: NetworkConfig["mode"]) {
    if (netCfg.value.mode === mode) return;
    netCfg.value.mode = mode;
    await saveNet();
  }

  /** The canonical way users type a manual proxy: bare `host:port`.
   *  Prefix http:// so the shell's scheme validation accepts it instead
   *  of silently dropping the field (which would flip manual → system). */
  function normalizeProxyUrl(raw: string | null | undefined): string | null {
    const v = raw?.trim() ?? "";
    if (!v) return null;
    return v.includes("://") ? v : `http://${v}`;
  }

  async function saveNet() {
    // Re-fetch the CURRENT config so fields this section does not edit
    // (githubMirror — saved from the cache section — and future additions)
    // survive the round-trip instead of being reverted to mount-time
    // snapshots.
    let base: NetworkConfig;
    try {
      base = await api.getNetworkConfig();
    } catch {
      base = { ...netLastSaved.value };
    }
    const payload: NetworkConfig = {
      ...base,
      mode: netCfg.value.mode,
      proxy: normalizeProxyUrl(netCfg.value.proxy),
      resourceCdn: netCfg.value.resourceCdn?.trim() || null,
    };
    delete payload.effectiveProxy;
    try {
      // The shell sanitizes before persisting and returns what actually
      // landed — adopt THAT so the form never claims a proxy the HTTP
      // stack is not using (an invalid value would otherwise desync).
      // A backend without the response (mock / older shell) falls back
      // to the payload we sent.
      const saved = await api.setNetworkConfig(payload);
      const effective = saved ?? payload;
      netCfg.value = { ...effective };
      netLastSaved.value = { ...effective };
      netSavedFlash.value = true;
      window.clearTimeout(netFlashTimer);
      netFlashTimer = window.setTimeout(() => (netSavedFlash.value = false), 1600);
    } catch {
      // best-effort — the desktop shell persists it; mock has no backend
    }
  }

  return { netCfg, netDirty, netSavedFlash, selectNetMode, saveNet };
}
