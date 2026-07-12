import { onBeforeUnmount, ref } from "vue";

/**
 * Promise-based confirm dialog composable. Ported from shittim-chest.
 * Wire to a single <SConfirmDialog> in the view:
 *
 *   const confirm = useConfirm();
 *   // In template:
 *   <SConfirmDialog visible={confirm.visible.value} title={confirm.title.value}
 *     message={confirm.message.value}
 *     onConfirm={confirm.accept} onCancel={confirm.cancel} />
 *   // In logic:
 *   const ok = await confirm.confirm("Delete?", "Are you sure?");
 */
export function useConfirm() {
  const visible = ref(false);
  const title = ref("");
  const message = ref("");
  let resolvePromise: ((_value: boolean) => void) | null = null;

  onBeforeUnmount(() => {
    resolvePromise?.(false);
    resolvePromise = null;
    visible.value = false;
  });

  function confirm(titleText: string, messageText: string): Promise<boolean> {
    resolvePromise?.(false);
    title.value = titleText;
    message.value = messageText;
    visible.value = true;
    return new Promise((resolve) => {
      resolvePromise = resolve;
    });
  }

  function accept() {
    visible.value = false;
    resolvePromise?.(true);
    resolvePromise = null;
  }

  function cancel() {
    visible.value = false;
    resolvePromise?.(false);
    resolvePromise = null;
  }

  return { visible, title, message, confirm, accept, cancel };
}
