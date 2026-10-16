/**
 * One-time app migrations — the webui side of the hifumi scaffold. The
 * version gate and the ledger live in the Rust shell
 * (commands/app_migrations.rs); this module asks for the pending
 * DELEGATED actions, runs their WebView bodies (localStorage rewrites the
 * shell cannot reach) and reports each completion. Unknown ids are
 * skipped WITHOUT reporting, so the shell keeps retrying until a build
 * carrying their body ships.
 *
 * main.ts fires this before bootstrap() and awaits it in the mount gate
 * (first paint never flashes a pre-migration look); the tray and overlay
 * windows never import it. Any transport failure resolves to an empty run
 * — browser dev, or a shell hiccup — and the ledger keeps everything
 * pending for the next boot.
 */
import { api } from "@/api";
import { peekLastRunVersion } from "@/utils/lastRunVersion";

import { WEBUI_MIGRATION_ACTIONS } from "./definitions";

/** Runs every pending delegated migration body; returns the ids executed. */
export async function runStartupMigrations(): Promise<string[]> {
  try {
    const pending = await api.appMigrationsPending(peekLastRunVersion());
    const executed: string[] = [];
    for (const id of pending) {
      const action = WEBUI_MIGRATION_ACTIONS[id];
      if (!action) continue;
      action();
      await api.appMigrationCompleted(id);
      executed.push(id);
    }
    return executed;
  } catch {
    return [];
  }
}
