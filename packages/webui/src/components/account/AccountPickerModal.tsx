import { defineComponent, type PropType } from "vue";

import { HkModal } from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { AccountProfile } from "@/stores/account";
import AccountManagerContent from "./AccountManagerContent";

/**
 * Account picker modal — the window behind the sharing wizard's 署名账户
 * field: the SAME account cards as the manager (AccountManagerContent in
 * pick mode — no reorder handle, preferred star or remove), where a click
 * credits that account for shared replays instead of switching the app's
 * active one. The dashed add row still binds new players (without
 * switching); a fresh bind is picked immediately.
 */
export default defineComponent({
  name: "AccountPickerModal",
  props: {
    modelValue: { type: Boolean, default: false },
    /** The currently credited identity key (`realm:accountId`). */
    selectedKey: { type: String as PropType<string | null>, default: null },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    pick: (_a: AccountProfile) => true,
  },
  setup(props, { emit }) {
    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("sharing.wizard.identitySource")}
        width="34rem"
      >
        <AccountManagerContent
          pickMode
          selectedKey={props.selectedKey}
          onPick={(a: AccountProfile) => {
            emit("pick", a);
            emit("update:modelValue", false);
          }}
        />
      </HkModal>
    );
  },
});
