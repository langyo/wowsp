/**
 * Standalone in-game plugin prompt — the second-chance ask for existing
 * installs the onboarding wizard never covered (its plugin step shipped
 * after their first run, or their game path only appeared later). Raised
 * app-wide by AppShell's boot-time auto-ask (see the pluginPrompt store)
 * and re-raised on demand by the settings' closeBehavior section. Two
 * shapes share the one window:
 *
 * - normal: the same one-click install the idle guide's plugin card uses
 *   (the shared ingamePlugin store), plus the dismissal checkbox. The box
 *   starts at the marker's current state and a decline writes the box
 *   back, so the re-opened window round-trips BOTH ways: checked keeps
 *   the boot ask silent, unchecked re-arms it. No countdown here — the
 *   deliberate-skip guard belongs to the wizard's offer, which sits in
 *   the middle of a guided flow; this window only ever appears over the
 *   normal UI.
 *
 * - safe mode: while the mod hub has quarantined res_mods, the probe
 *   reports the plugin as absent even though nothing is broken — the
 *   install offer would only hit the backend's guard refusal. The window
 *   becomes the recovery question instead: turn mods back on and repair
 *   the plugin in one click (the shared repairSafeMode flow). No
 *   dismissal checkbox here: this is a state-recovery question, not the
 *   install offer, so closing it must never silence the boot ask the way
 *   a deliberate install decline does. The variant re-renders from the
 *   live store — a repair that restored the mods but failed the install
 *   half falls back to the normal variant instead of closing.
 */
import { defineComponent, ref, watch } from "vue";
import { Plug } from "@lucide/vue";

import { HkCheckbox, HkModal, useToast } from "@celestia-island/hikari";

import { t, tError } from "@/i18n";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { usePluginPromptStore } from "@/stores/pluginPrompt";
import "./PluginInstallPromptModal.scss";

export default defineComponent({
  name: "PluginInstallPromptModal",
  setup() {
    const plugin = useIngamePluginStore();
    const prompt = usePluginPromptStore();
    const toast = useToast();

    const dontAsk = ref(false);
    const installing = ref(false);
    const repairing = ref(false);

    // The checkbox adopts the marker's current state on every open, so a
    // decline through the re-opened window reads as the user sees it.
    watch(
      () => prompt.visible,
      (v) => {
        if (v) dontAsk.value = prompt.dismissed;
      },
      { immediate: true },
    );

    async function install() {
      if (installing.value) return;
      installing.value = true;
      try {
        const done = await plugin.install();
        if (done) {
          // Key-or-raw contract (see tError): a backend guard refusal is
          // an English sentence and must surface verbatim, never via t().
          toast.error(tError(done));
          return;
        }
        toast.success(t("replay.live.idlePluginInstalled"));
        prompt.close();
      } finally {
        installing.value = false;
      }
    }

    function skip() {
      prompt.setDismissed(dontAsk.value);
      prompt.close();
    }

    /** Safe-mode recovery: one click restores res_mods and reinstalls the
     *  plugin. Awaiting the store's post-repair probe keeps the button's
     *  spinner honest and, on a partial failure, re-renders the window on
     *  whichever variant the refreshed state now calls for. */
    async function repair() {
      if (repairing.value) return;
      repairing.value = true;
      try {
        const done = await plugin.repairSafeMode();
        if (done) {
          // Key-or-raw contract (see tError): a key resolves to a
          // localized line, a raw backend sentence surfaces verbatim.
          toast.error(tError(done));
          return;
        }
        toast.success(t("replay.live.pluginSafeModeRepaired"));
        prompt.close();
      } finally {
        repairing.value = false;
      }
    }

    return () => {
      const safeMode = plugin.safeMode;
      return (
        <HkModal
          modelValue={prompt.visible}
          onUpdate:modelValue={(v: boolean) => (v ? prompt.open() : prompt.close())}
          title={t(
            safeMode
              ? "replay.live.pluginSafeModeTitle"
              : "replay.live.pluginPromptTitle",
          )}
          width="30rem"
          footerActions={[
            {
              label: t(
                safeMode
                  ? "replay.live.pluginSafeModeLater"
                  : "replay.live.pluginPromptLater",
              ),
              variant: "secondary",
              // Safe mode is a state-recovery question: closing it is not
              // an install decline, so the dismissal marker stays untouched.
              onClick: safeMode ? () => prompt.close() : skip,
            },
            safeMode
              ? {
                  label: t("replay.live.pluginSafeModeRepair"),
                  variant: "primary",
                  loading: repairing.value,
                  onClick: () => void repair(),
                }
              : {
                  label: t("replay.live.idlePluginInstall"),
                  variant: "primary",
                  loading: installing.value,
                  onClick: () => void install(),
                },
          ]}
        >
          <div class="plugin-install-prompt">
            <div class="plugin-install-prompt__lead">
              <span class="plugin-install-prompt__icon">
                <Plug size={16} />
              </span>
              <p class="plugin-install-prompt__desc">
                {t(
                  safeMode
                    ? "replay.live.pluginSafeModeDesc"
                    : "replay.live.pluginPromptDesc",
                )}
              </p>
            </div>
            {safeMode ? null : (
              <HkCheckbox
                modelValue={dontAsk.value}
                onUpdate:modelValue={(v: boolean) => (dontAsk.value = v)}
                label={t("replay.live.pluginPromptDontAsk")}
              />
            )}
          </div>
        </HkModal>
      );
    };
  },
});
