/**
 * Title-bar "Saved" flash — the one-second confirmation chip beside the
 * window caption buttons (TitlebarSavedFlash renders it inside
 * AppTitleBar's `actions` slot). Settings in this app persist the moment
 * they change: switches and sliders write through on every touch, typed
 * rows commit via 保存 / Enter. The chip is the shared "the write landed"
 * cue — every settings persist path calls notifySettingsSaved() on
 * success, so no row needs its own saved feedback again.
 *
 * App-wide source of truth as a MODULE-level ref (not store-owned state,
 * statsPrefsState's pattern): theme/preference modules and Pinia stores
 * alike call the notifier without a store instance. Boot-time heal-writes
 * never route through it — only the user-action setters notify — so the
 * chip cannot fire before the UI exists.
 *
 * Re-entry restarts the dismiss clock instead of stacking: a slider
 * dragged through a dozen values keeps ONE chip alive until a second of
 * quiet passes — strobing per tick would be noise, not feedback.
 */
import { ref } from "vue";

/** One second, per the flash's product spec; the inline button-label
 *  flashes (netSavedFlash & co.) keep their own 1600ms rhythm. */
const FLASH_MS = 1000;

export const settingsSavedFlash = ref(false);

let flashTimer: number | undefined;

/** Flash the title-bar "Saved" chip — or restart its clock if one is
 *  already up (see the module doc: re-entry coalesces, never stacks). */
export function notifySettingsSaved(): void {
  settingsSavedFlash.value = true;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (settingsSavedFlash.value = false), FLASH_MS);
}
