/**
 * Standalone in-game plugin install prompt — the second-chance ask for
 * existing installs the onboarding wizard never covered (its plugin step
 * shipped after their first run, or their game path only appeared later).
 * Raised app-wide by AppShell's boot-time auto-ask (see the pluginPrompt
 * store) and re-raised on demand by the settings' closeBehavior section.
 *
 * The modal offers the same one-click install the idle guide's plugin
 * card uses (the shared ingamePlugin store), plus the 不再提示 checkbox.
 * The box starts at the marker's current state and a decline writes the
 * box back, so the re-opened window round-trips BOTH ways: checked keeps
 * the boot ask silent, unchecked re-arms it. No countdown here — the
 * deliberate-skip guard belongs to the wizard's offer, which sits in the
 * middle of a guided flow; this window only ever appears over the normal
 * UI.
 */
import { defineComponent, ref, watch } from "vue";
import { Plug } from "@lucide/vue";

import { HkCheckbox, HkModal, useToast } from "@celestia-island/hikari";

import { t } from "@/i18n";
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
          // Same contract as PluginStatusCard: the store returns either a
          // localized key or a raw message — t() passes the latter through.
          toast.error(t(done));
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

    return () => (
      <HkModal
        modelValue={prompt.visible}
        onUpdate:modelValue={(v: boolean) => (v ? prompt.open() : prompt.close())}
        title={t("replay.live.pluginPromptTitle")}
        width="30rem"
        footerActions={[
          {
            label: t("replay.live.pluginPromptLater"),
            variant: "secondary",
            onClick: skip,
          },
          {
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
              {t("replay.live.pluginPromptDesc")}
            </p>
          </div>
          <HkCheckbox
            modelValue={dontAsk.value}
            onUpdate:modelValue={(v: boolean) => (dontAsk.value = v)}
            label={t("replay.live.pluginPromptDontAsk")}
          />
        </div>
      </HkModal>
    );
  },
});
