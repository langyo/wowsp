/**
 * The copy-share-shot action every water-table surface mounts in its card's
 * top-right corner (the IdentityHead badges row) — the stats-card
 * counterpart of the post-battle panel's toolbar shot button. Renders the
 * shot and copies the PNG to the clipboard (see useShareImage). The button
 * itself is hikari's HkButton (ghost xs — issue #1736 P2): the loading prop
 * supplies the built-in ring and forces disabled, so no spinner swap and
 * no bespoke pill face (the old .share-shot-btn sheet retired with the
 * migration).
 */
import { defineComponent } from "vue";
import { Camera } from "@lucide/vue";
import { HkButton } from "@celestia-island/hikari";

import { t } from "@/i18n";

export default defineComponent({
  name: "ShareShotButton",
  props: {
    busy: { type: Boolean, default: false },
  },
  emits: ["shot"],
  setup(props, { emit }) {
    return () => (
      <HkButton variant="ghost" size="xs" loading={props.busy} onClick={() => emit("shot")}>
        <Camera size={13} />
        {t("share.copyShot")}
      </HkButton>
    );
  },
});
