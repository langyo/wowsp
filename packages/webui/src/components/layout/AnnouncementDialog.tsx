import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";

import { HButton, HModal } from "@celestia-island/hikari";

import { t } from "@/i18n";

import AnnouncementContent from "./AnnouncementContent";
import "./AnnouncementDialog.scss";

/**
 * Forced first-launch notice: the free & open-source warning, shown on
 * every startup until acknowledged. The only way out is the ack button —
 * HkModal is mounted with `closable={false}`, which (verified against the
 * hikari source) removes the X, makes Escape a no-op, ignores overlay
 * (backdrop) clicks, and disables the back-gesture guard. The ack button
 * stays disabled for a short countdown so the text cannot be skipped
 * blindly; acknowledging persists to localStorage forever.
 */
const ACK_STORAGE_KEY = "wowsp-oss-notice-acked";
const ACK_COUNTDOWN_SECONDS = 5;

export default defineComponent({
  name: "AnnouncementDialog",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    const countdown = ref(ACK_COUNTDOWN_SECONDS);
    let timer: number | undefined;

    onMounted(() => {
      timer = window.setInterval(() => {
        countdown.value -= 1;
        if (countdown.value <= 0) {
          window.clearInterval(timer);
          timer = undefined;
          countdown.value = 0;
        }
      }, 1000);
    });
    onBeforeUnmount(() => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    });

    function acknowledge() {
      localStorage.setItem(ACK_STORAGE_KEY, "1");
      emit("update:modelValue", false);
    }

    return () => (
      <HModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("announce.title")}
        width="32rem"
        closable={false}
      >
        <div class="announcement-dialog">
          {/* Scroll region of last resort: four language blocks can exceed
              short viewports; the ack button must stay visible below it. */}
          <div class="announcement-dialog__body">
            <AnnouncementContent />
          </div>
          <div class="announcement-dialog__actions">
            <HButton
              variant="primary"
              disabled={countdown.value > 0}
              onClick={acknowledge}
            >
              {countdown.value > 0
                ? t("announce.ackCountdown", { n: countdown.value })
                : t("announce.ack")}
            </HButton>
          </div>
        </div>
      </HModal>
    );
  },
});
