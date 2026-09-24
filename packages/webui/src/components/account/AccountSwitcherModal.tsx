import { defineComponent } from "vue";

import { HkModal } from "@celestia-island/hikari";

import { t } from "@/i18n";
import AccountManagerContent from "./AccountManagerContent";

/**
 * Account binder / switcher modal — a thin HkModal shell around the shared
 * AccountManagerContent body (search → bind, rich account cards). The
 * settings modal's 账户 section renders the content directly; this wrapper
 * stays for the dashboard's bind entry, closing + emitting `bound` after a
 * successful add/switch so the dashboard can refresh its stats.
 */
export default defineComponent({
  name: "AccountSwitcherModal",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    bound: () => true,
  },
  setup(props, { emit }) {
    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("account.switcherTitle")}
        width="34rem"
      >
        <AccountManagerContent
          onActive={() => {
            emit("bound");
            emit("update:modelValue", false);
          }}
        />
      </HkModal>
    );
  },
});
