/**
 * Manual-locate picker layer state for the MAIN window: the cached-frame
 * drag-box picker renders as a full-cover sub-window of the app itself —
 * there is no dedicated Tauri window anymore (see `ManualLocateOverlay`).
 *
 * The live-battle panel's button opens the layer after the backend gates
 * pass (`startManualLocate`); the layer closes itself on submit / cancel
 * and on the backend's `wowsp://manual-locate-close` force-close push. The
 * state lives here (not in the panel) so a mid-pick roster/battle update
 * cannot unmount the picker out from under the user.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

export const useManualLocateStore = defineStore("manualLocate", () => {
  const open = ref(false);

  function openPicker() {
    open.value = true;
  }

  function closePicker() {
    open.value = false;
  }

  return { open, openPicker, closePicker };
});
