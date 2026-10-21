/**
 * Manual-locate picker state for the MAIN window: the cached-frame drag-box
 * picker renders as an in-app HkModal sub-window (same window context as
 * Settings) — there is no dedicated Tauri window (see
 * `ManualLocateOverlay`).
 *
 * The picker serves two openers: the settings calibration editor (the
 * "calibration" mode — `startCalibrationLocate` armed it; submits go to
 * `setCalibrationAnchor` against the target entry) and the battle-flow
 * manual locate (`startManualLocate`, after the backend's battle gates
 * pass). The layer closes itself on submit / cancel and on the backend's
 * `wowsp://manual-locate-close` force-close push. The state lives here
 * (not in the opener) so a mid-pick roster/battle update cannot unmount
 * the picker out from under the user.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

/** The calibration editor's target: which client install and battle-class
 *  entry a calibration-mode submit writes to (`setCalibrationAnchor`).
 *  `kind` is the install's client kind — forwarded so the backend can
 *  CREATE an entry that nothing measured yet (the pre-edit flow). */
export interface ManualLocateCalibration {
  clientKey: string;
  class: "pvp" | "pve";
  kind: string;
}

export const useManualLocateStore = defineStore("manualLocate", () => {
  const open = ref(false);
  /** Which opener the current pick serves — battle submits go to
   *  `setManualRosterRect`, calibration submits to `setCalibrationAnchor`.
   *  Battle stays the default so the battle flow needs no call changes. */
  const mode = ref<"battle" | "calibration">("battle");
  /** The calibration target; null outside calibration mode. */
  const calibration = ref<ManualLocateCalibration | null>(null);
  /** Monotonic counter bumped after every SUCCESSFUL calibration submit —
   *  the settings calibration section watches it to re-read the store list
   *  without polling (the picker layer and the section are otherwise
   *  decoupled; the section may not even be mounted, which is fine). */
  const calibrationVersion = ref(0);

  function openPicker(opts?: {
    mode?: "battle" | "calibration";
    calibration?: ManualLocateCalibration | null;
  }) {
    mode.value = opts?.mode ?? "battle";
    calibration.value =
      mode.value === "calibration" ? (opts?.calibration ?? null) : null;
    open.value = true;
  }

  function closePicker() {
    open.value = false;
  }

  /** Announce a successful calibration write (see `calibrationVersion`). */
  function noteCalibrationSaved() {
    calibrationVersion.value += 1;
  }

  return {
    open,
    mode,
    calibration,
    calibrationVersion,
    openPicker,
    closePicker,
    noteCalibrationSaved,
  };
});
