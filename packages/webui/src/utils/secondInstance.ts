/**
 * Duplicate-launch (second-instance) flag, mirrored from the Rust shell's
 * single-instance guard (`packages/app/tauri/src/single_instance.rs`: a
 * named Windows kernel mutex decides which copy is the primary).
 *
 * When this copy is a duplicate, AppShell swaps the whole boot flow for a
 * non-closable "already running" notice and main.ts skips analytics. The
 * flag is settled inside main.ts's mount gate, so the dialog is present at
 * first paint — the real dashboard never flashes. Uses the same raw
 * `invoke` pattern AppShell's quit flow uses (no transport wrapper): the
 * duplicate-notice path must not depend on any store hydrating first.
 */
import { ref } from "vue";

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/utils/platform";

/** True when this process is a second copy (probed once, before mount). */
export const secondInstance = ref(false);

/**
 * Ask the shell whether this copy is a duplicate launch and settle the
 * flag. Never rejects: outside the Tauri shell (plain browser tab / mock
 * mode) there is no guard at all, and an IPC failure must not brick the
 * mount gate — both leave the flag at false.
 */
export async function probeSecondInstance(): Promise<void> {
  if (!isTauri()) return;
  secondInstance.value = await invoke<boolean>("is_second_instance").catch(
    () => false,
  );
}
