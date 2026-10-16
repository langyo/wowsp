/**
 * The copy-share-shot pill every water-table surface mounts in its card's
 * top-right corner (the IdentityHead badges row) — the stats-card
 * counterpart of the post-battle panel's toolbar shot button. Renders the
 * shot and copies the PNG to the clipboard (see useShareImage).
 */
import { defineComponent } from "vue";
import { Camera } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import "./ShareShotButton.scss";

export default defineComponent({
  name: "ShareShotButton",
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ["shot"],
  setup(props, { emit }) {
    return () => (
      <button
        class="share-shot-btn"
        type="button"
        disabled={props.busy}
        onClick={() => emit("shot")}
      >
        {props.busy ? <HkSpinner size="xs" tone="current" /> : <Camera size={13} />}
        {t("share.copyShot")}
      </button>
    );
  },
});
