import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { TriangleAlert } from "@lucide/vue";

import ToastCardBase, { type ToastCardAction, type ToastCardBaseInstance } from "./ToastCardBase";
import { useUpdaterStore } from "@/stores/updater";
import { isMobileApp, isNative } from "@/utils/platform";
import { t } from "@/i18n";
import "./UpdateStrandedToast.scss";

/** How long the card lingers before folding away on its own — the
 *  recovery actions outlast the success card's 8 s: the wizard launch
 *  is a deliberate decision, not a glance. */
const AUTO_DISMISS_MS = 60000;

/**
 * UpdateStrandedToast — the stranded-update recovery card. When the
 * startup reconciliation finds the previous launch handed off to an
 * update that never landed (the one-shot `update-pending.json` marker
 * in the data dir), this warning card rises in the shared top-right
 * toast column with the two ways out: 干净重装 re-runs the installer the
 * stranded pass already downloaded — visibly, as a standalone wizard,
 * never silently — and 打开下载页 falls back to the website when the
 * cached installer is gone. The card folds on either action (the
 * wizard's own flow stops this app at its install step); the ordinary
 * update banner keeps offering the silent retry independently. The
 * assertive role and the body line under the headline are this card's
 * own grammar; the surface, the quiet × and both pills are the base's.
 * Renders nothing outside the desktop Tauri shell, like its sibling cards.
 */
export default defineComponent({
  name: "UpdateStrandedToast",
  setup() {
    const updater = useUpdaterStore();
    const card = ref<ToastCardBaseInstance | null>(null);
    let autoTimer: number | undefined;

    /** Stop the auto-dismiss, then fold the card out (the base's
     *  delayed unmount keeps it alive for the --leave transition). */
    function dismiss() {
      if (autoTimer !== undefined) {
        window.clearTimeout(autoTimer);
        autoTimer = undefined;
      }
      card.value?.dismiss();
    }

    onMounted(() => {
      if (!isNative() || isMobileApp()) return;
      // The store's init() reads the reconciliation verdict; the card
      // rises whenever a stranded handoff shows up (and again never —
      // the marker is one-shot).
      watch(
        () => updater.stranded,
        (stranded) => {
          if (stranded && !card.value?.shown) {
            card.value?.show();
            autoTimer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
          }
        },
        // flush:"post" — the verdict lands after mount, and the callback
        // must run after the template-ref job binds the base instance
        // (a pre-flush callback would see card.value null and the card
        // would never rise).
        { immediate: true, flush: "post" },
      );
    });

    onBeforeUnmount(() => {
      if (autoTimer !== undefined) window.clearTimeout(autoTimer);
    });

    return () => {
      if (!updater.stranded) return null;
      const stranded = updater.stranded;
      // The 干净重装 pill only while the cached installer is still
      // runnable, disabled for the span of a recovery pass; the
      // 打开下载页 fallback always.
      const actions: ToastCardAction[] = [];
      if (stranded.installer_ready) {
        actions.push({
          label: t("about.updateStrandedReinstall"),
          kind: "primary",
          class: "update-stranded__reinstall",
          disabled: updater.recovering,
          onClick: () => {
            void updater.reinstallFromCache();
            dismiss();
          },
        });
      }
      actions.push({
        label: t("about.updateStrandedDownload"),
        kind: "outline",
        class: "update-stranded__download",
        onClick: () => {
          void updater.openDownloadPage();
          dismiss();
        },
      });
      return (
        <ToastCardBase
          ref={card}
          tone="warning"
          rootClass="update-stranded"
          role="alert"
          message={t("about.updateStrandedTitle")}
          bold
          close
          onClose={dismiss}
          actions={actions}
        >
          {{
            icon: () => <TriangleAlert size={16} />,
            body: () => (
              <p class="update-stranded__body">
                {t("about.updateStrandedBody", { version: stranded.expected })}
              </p>
            ),
          }}
        </ToastCardBase>
      );
    };
  },
});
