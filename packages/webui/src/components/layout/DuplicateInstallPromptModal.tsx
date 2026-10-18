/**
 * Duplicate-install ask: the boot-time window raised by the
 * duplicateInstall store when the backend finds a second WoWSP install
 * (the pre-0.6.26 silent-update bug's residue). The 不再提示 checkbox is
 * deliberately UNCHECKED on every open and only silences future launches
 * when it was ticked at close — closing without it keeps the check armed,
 * and the settings' installCleanup section re-enables either way. The
 * removal button runs the leftover's own uninstaller silently (the
 * backend waits and re-registers the running install) and the dialog
 * stays open on failure so the error toast is read in context.
 */
import { defineComponent, ref, watch } from "vue";
import { HkCheckbox, HkModal } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useDuplicateInstallStore } from "@/stores/duplicateInstall";

export default defineComponent({
  name: "DuplicateInstallPromptModal",
  setup() {
    const store = useDuplicateInstallStore();
    // Reset on every open: a leftover tick from an earlier ask must never
    // silently arm this close (the same discipline the close dialog's
    // remember checkbox follows).
    const neverAsk = ref(false);
    watch(
      () => store.showPrompt,
      (open) => {
        if (open) neverAsk.value = false;
      },
    );

    const close = () => store.closePrompt(neverAsk.value);
    const version = () =>
      store.info?.version ? t("settings.dupPromptVersion", { version: store.info.version }) : "";

    return () => (
      <HkModal
        modelValue={store.showPrompt}
        onUpdate:modelValue={(v: boolean) => {
          // Refuse mid-removal closes (ESC / backdrop): the uninstaller
          // is already running and its outcome decides what happens next.
          if (!v && store.showPrompt && !store.uninstalling) close();
        }}
        title={t("settings.dupPromptTitle")}
        width="28rem"
        footerActions={[
          {
            label: t("settings.dupPromptKeep"),
            variant: "secondary",
            disabled: store.uninstalling,
            onClick: close,
          },
          {
            label: t("settings.dupPromptUninstall"),
            variant: "danger",
            loading: store.uninstalling,
            disabled: !store.info?.hasUninstaller,
            onClick: () => void store.uninstall(),
          },
        ]}
      >
        {{
          default: () => (
            <div class="close-dialog__body">
              <p class="close-dialog__msg">
                {t("settings.dupPromptMsg", {
                  path: store.info?.path ?? "",
                  version: version(),
                })}
              </p>
              {store.info && !store.info.hasUninstaller ? (
                <p class="close-dialog__msg">{t("settings.dupNoUninstaller")}</p>
              ) : null}
              <HkCheckbox
                modelValue={neverAsk.value}
                onUpdate:modelValue={(v: boolean) => (neverAsk.value = v)}
                label={t("settings.dupPromptNever")}
              />
            </div>
          ),
        }}
      </HkModal>
    );
  },
});
