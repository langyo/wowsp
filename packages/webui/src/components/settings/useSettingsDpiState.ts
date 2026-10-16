/** DPI (interface scale) state for SettingsBody: the staged slider over
 *  theme/dpiPrefs with its apply/keep/auto actions and the escape hatches
 *  that fire when the control unmounts. */
import { computed, onBeforeUnmount, ref, watch } from "vue";

import type { ModalAction } from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { SettingsSection } from "@/stores/settingsUi";
import {
  keepDpiScale,
  loadDpiScale,
  previewDpiScale,
  resetDpiScale,
  revertPreviewDpiScale,
  useAppliedDpiScale,
  useDpiCountdown,
} from "@/theme/dpiPrefs";

export function useSettingsDpiState(
  isActive: () => boolean,
  section: () => SettingsSection,
) {
  // ── interface scale (DPI) — staged slider over theme/dpiPrefs ────────
  // Dragging only stages a notch; Apply previews it and starts the
  // app-level countdown in dpiPrefs — the confirm modal rendered as a
  // sibling HkModal by SettingsBody is a pure view of that store (Keep
  // persists, "Revert now" / expiry restores). Closing the hosting
  // surface or leaving the appearance section (both unmount this
  // control) discards a staged notch and reverts a live preview.
  const dpiScale = ref<number | null>(loadDpiScale());
  const pendingDpi = ref<number | null>(null);
  const dpiCountdown = useDpiCountdown();
  const dpiAuto = computed(() => pendingDpi.value == null && dpiScale.value == null);

  function onDpiScaleChange(value: number) {
    pendingDpi.value = value;
  }

  function onDpiApply() {
    const pct = pendingDpi.value;
    if (pct == null) return;
    pendingDpi.value = null;
    previewDpiScale(pct);
  }

  function onDpiKeep() {
    keepDpiScale();
    dpiScale.value = loadDpiScale();
  }

  function onDpiAuto() {
    pendingDpi.value = null;
    dpiScale.value = null;
    resetDpiScale();
  }

  function onDpiRevertNow() {
    revertPreviewDpiScale();
  }

  // The control exists only while a surface is showing the appearance
  // section; losing either is the explicit escape hatch (shittim's
  // window-close grammar, re-expressed over the settingsUi store).
  const dpiMounted = computed(() => isActive() && section() === "appearance");
  watch(dpiMounted, (mounted) => {
    if (mounted) return;
    pendingDpi.value = null;
    if (dpiCountdown.active) revertPreviewDpiScale();
    dpiScale.value = loadDpiScale();
  });
  // Ctrl/Cmd+Alt+0 can reset the scale from anywhere while this control is
  // on screen; the root-zoom ref (MutationObserver-fed) mirrors that into
  // the readout unless a staged notch or live preview owns the display.
  watch(useAppliedDpiScale(), () => {
    if (dpiCountdown.active || pendingDpi.value != null) return;
    dpiScale.value = loadDpiScale();
  });
  onBeforeUnmount(() => {
    if (dpiCountdown.active) revertPreviewDpiScale();
  });

  const dpiConfirmActions = computed<ModalAction[]>(() => [
    { label: t("settings.dpiKeep"), variant: "primary", onClick: onDpiKeep },
    { label: t("settings.dpiRevertNow"), variant: "secondary", onClick: onDpiRevertNow },
  ]);

  return {
    dpiScale,
    pendingDpi,
    dpiCountdown,
    dpiAuto,
    onDpiScaleChange,
    onDpiApply,
    onDpiKeep,
    onDpiAuto,
    onDpiRevertNow,
    dpiConfirmActions,
  };
}
