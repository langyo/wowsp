/**
 * In-game overlay (Mode 2) user setting, persisted to AppData as
 * `overlay-config.json`. Enabled by default: while the game runs and a battle
 * is live, holding Tab (with the game focused) shows per-player WR / avg
 * damage over the team list.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import { api } from "@/api";

const OVERLAY_CONFIG_FILE = "overlay-config.json";
const DEFAULT_ENABLED = true;

export const useOverlayConfigStore = defineStore("overlayConfig", () => {
  const enabled = ref(DEFAULT_ENABLED);
  const loaded = ref(false);

  async function load() {
    if (loaded.value) return;
    loaded.value = true;
    try {
      const raw = await api.appdataRead(OVERLAY_CONFIG_FILE);
      if (raw) {
        const parsed = JSON.parse(raw) as { enabled?: boolean };
        enabled.value = parsed.enabled ?? DEFAULT_ENABLED;
      }
    } catch {
      // missing file / parse error — keep the default
    }
  }

  async function setEnabled(v: boolean) {
    enabled.value = v;
    try {
      await api.appdataWrite(OVERLAY_CONFIG_FILE, JSON.stringify({ enabled: v }));
    } catch {
      // best-effort persistence; the in-memory flag still applies
    }
  }

  return { enabled, loaded, load, setEnabled };
});
