/**
 * The confirmation gate every /erp mutation goes through (house rule:
 * nothing writes without an explicit HkConfirmDialog yes). One reactive
 * state + one dialog per surface; `confirm()` arms it, the bound
 * HkConfirmDialog drives it, and `onConfirm` runs the armed action with
 * the button's loading state until the promise settles.
 */

import { reactive } from "vue";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Defaults to the dialog's danger styling (drain/logout); pass false
   *  for ordinary saves. */
  danger?: boolean;
}

interface ConfirmState {
  open: boolean;
  loading: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  action: (() => Promise<void>) | null;
}

export function useConfirm() {
  const state = reactive<ConfirmState>({
    open: false,
    loading: false,
    title: "",
    message: "",
    confirmLabel: "确认",
    danger: true,
    action: null,
  });

  /** Arm the dialog. The action runs ONLY on the dialog's confirm. */
  function confirm(options: ConfirmOptions, action: () => Promise<void>): void {
    state.title = options.title;
    state.message = options.message;
    state.confirmLabel = options.confirmLabel ?? "确认";
    state.danger = options.danger ?? true;
    state.action = action;
    state.open = true;
  }

  async function onConfirm(): Promise<void> {
    const action = state.action;
    if (!action || state.loading) return;
    state.loading = true;
    try {
      await action();
      state.open = false;
    } finally {
      state.loading = false;
    }
  }

  function onCancel(): void {
    if (state.loading) return;
    state.open = false;
    state.action = null;
  }

  return { state, confirm, onConfirm, onCancel };
}
