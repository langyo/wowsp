/** Purge-backup snapshots (备份快照): the surface for the
 *  `res_mods.wowsp-purge-<stamp>` trees the "purge and reinstall" reset
 *  leaves behind. A backup carrying the `wowsp-purge-state.json` marker
 *  is an INTERRUPTED purge — its row sorts first with the warning accent
 *  and offers RESUME (finish the remaining reinstalls through the
 *  verified path, spinner while running) plus "mark done" (drop only the
 *  marker). Completed backups offer restore-merge (fold the files back
 *  under keep-new) and delete (confirm dialog). One collapsed launcher
 *  row above the installed list opens the secondary window with every
 *  row — the pattern the crash pins established. */
import { ref, watch, type Ref } from "vue";

import {
  HkButton,
  HkConfirmDialog,
  HkModal,
  HkScrollContainer,
  useToast,
} from "@celestia-island/hikari";
import { ChevronRight, Play, RotateCcw, Trash2, TriangleAlert, Undo2 } from "@lucide/vue";

import { api } from "@/api";
import type { PurgeBackup } from "@/api/modules/modhub";
import { t } from "@/i18n";
import { formatLocalStamp } from "@/utils/format";
import "./PurgeBackups.scss";

/** The purge-backups state the resources view renders from: the list
 *  (refreshed on install switch and after every action), one busy row at
 *  a time, and the delete confirmation target. `onChanged` fires after a
 *  resume or restore-merge touched the live tree so the view can rescan. */
export function usePurgeBackups(gameRoot: Ref<string>, onChanged?: () => void) {
  const toast = useToast();
  const backups = ref<PurgeBackup[]>([]);
  const loading = ref(false);
  /** dirName of the row whose action is in flight (one at a time). */
  const busyDir = ref<string | null>(null);
  /** The completed backup awaiting its delete confirmation. */
  const deleteTarget = ref<PurgeBackup | null>(null);

  async function refresh() {
    const root = gameRoot.value;
    if (!root) {
      backups.value = [];
      return;
    }
    loading.value = true;
    try {
      backups.value = await api.modHubPurgeBackups(root);
    } catch {
      // No backups surface without the command (older backend) — the
      // launcher row simply stays hidden.
      backups.value = [];
    } finally {
      loading.value = false;
    }
  }

  watch(gameRoot, () => void refresh());
  void refresh();

  /** One action at a time; failures surface through the toast, and every
   *  completed action refreshes the list (resume/restore also rescan the
   *  installed rows through `onChanged`). */
  async function run(dirName: string, op: () => Promise<void>) {
    if (busyDir.value) return;
    busyDir.value = dirName;
    try {
      await op();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      busyDir.value = null;
    }
  }

  async function resume(backup: PurgeBackup) {
    await run(backup.dirName, async () => {
      try {
        const report = await api.modHubPurgeBackupResume(gameRoot.value, backup.dirName);
        toast.success(
          t("resources.purgeBackups.resumeDone", {
            count: report.reinstalled.length,
            adopted: report.adopted.length,
          }),
        );
        if (report.skipped.length > 0) {
          toast.warning(
            t("resources.purgeBackups.skipped", { count: report.skipped.length }),
          );
        }
      } finally {
        await refresh();
        onChanged?.();
      }
    });
  }

  async function dismiss(backup: PurgeBackup) {
    await run(backup.dirName, async () => {
      await api.modHubPurgeBackupDismiss(gameRoot.value, backup.dirName);
      toast.success(t("resources.purgeBackups.dismissDone"));
      await refresh();
    });
  }

  async function restore(backup: PurgeBackup) {
    await run(backup.dirName, async () => {
      const report = await api.modHubPurgeBackupRestore(gameRoot.value, backup.dirName);
      if (report.backupRemoved) {
        toast.success(
          t("resources.purgeBackups.restoreDone", {
            merged: report.mergedFiles,
            skipped: report.skippedFiles,
          }),
        );
      } else {
        toast.warning(
          t("resources.purgeBackups.restoreKept", { count: report.conflictFiles }),
        );
      }
      await refresh();
      onChanged?.();
    });
  }

  function askDelete(backup: PurgeBackup) {
    deleteTarget.value = backup;
  }

  async function doDelete() {
    const target = deleteTarget.value;
    deleteTarget.value = null;
    if (!target) return;
    await run(target.dirName, async () => {
      await api.modHubPurgeBackupDelete(gameRoot.value, target.dirName);
      toast.success(t("resources.purgeBackups.deleteDone"));
      await refresh();
    });
  }

  return {
    backups,
    loading,
    busyDir,
    deleteTarget,
    refresh,
    resume,
    dismiss,
    restore,
    askDelete,
    doDelete,
  };
}

/** The collapsed launcher row ABOVE the installed list — rendered only
 *  when backups exist. Unfinished markers push the accent to warning so
 *  the recovery need is visible without opening the window. */
export function renderPurgeBackups(
  pins: ReturnType<typeof usePurgeBackups>,
  onOpen: () => void,
) {
  const list = pins.backups.value;
  if (list.length === 0) return null;
  const unfinished = list.filter((b) => b.hasMarker).length;
  return (
    <div class="purge-backups">
      <div
        role="button"
        tabindex={0}
        class={{ "purge-backups__row": true, "is-summary": true, "is-unfinished": unfinished > 0 }}
        data-hint={t("resources.purgeBackups.manageHint")}
        onClick={onOpen}
        onKeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <span class="purge-backups__icon">
          {unfinished > 0 ? <TriangleAlert size={14} /> : <Undo2 size={14} />}
        </span>
        <span class="purge-backups__body">
          <span class="purge-backups__name">{t("resources.purgeBackups.launcher")}</span>
          <span class="purge-backups__badges">
            <span class="purge-backups__badge">
              {t("resources.purgeBackups.count", { count: list.length })}
            </span>
            {unfinished > 0 ? (
              <span class="purge-backups__badge is-unfinished">
                {t("resources.purgeBackups.unfinishedBadge", { count: unfinished })}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronRight size={14} class="purge-backups__chevron" />
      </div>
    </div>
  );
}

/** The secondary window the launcher row opens: every backup as a row
 *  (dir name + stamp + counts + marker state) with its per-row actions,
 *  plus the delete confirmation dialog. Unfinished rows sort first with
 *  the warning accent and the primary resume action. */
export function renderPurgeBackupsWindow(
  pins: ReturnType<typeof usePurgeBackups>,
  open: boolean,
  onUpdateOpen: (open: boolean) => void,
) {
  return (
    <>
      <HkModal
        modelValue={open}
        onUpdate:modelValue={onUpdateOpen}
        title={t("resources.purgeBackups.title")}
        width="46rem"
      >
        <HkScrollContainer class="purge-backups__scroll">
          <div class="purge-backups purge-backups--window">{renderPurgeBackupRows(pins)}</div>
        </HkScrollContainer>
        {/* The localized half of the tolerant-resume refusal: the backend
            rejects an unresumable half-state with the same remedy, this
            line keeps it visible before the click. */}
        {pins.backups.value.some((b) => b.hasMarker) ? (
          <p class="purge-backups__footnote">
            {t("resources.purgeBackups.resumeBlocked")}
          </p>
        ) : null}
      </HkModal>
      <HkConfirmDialog
        open={!!pins.deleteTarget.value}
        title={t("resources.purgeBackups.delete")}
        message={t("resources.purgeBackups.confirmDelete", {
          name: pins.deleteTarget.value?.dirName ?? "",
          count: pins.deleteTarget.value?.fileCount ?? 0,
        })}
        confirmLabel={t("resources.purgeBackups.delete")}
        onConfirm={() => void pins.doDelete()}
        onUpdate:open={(v: boolean) => {
          if (!v) pins.deleteTarget.value = null;
        }}
      />
    </>
  );
}

function renderPurgeBackupRows(pins: ReturnType<typeof usePurgeBackups>) {
  const busyDir = pins.busyDir.value;
  // Unfinished first (stable — the backend order is newest-first), so the
  // rows that need a decision outrank the plain snapshots.
  const rows = [...pins.backups.value].sort(
    (a, b) => Number(b.hasMarker) - Number(a.hasMarker),
  );
  return rows.map((b) => {
    const busy = busyDir === b.dirName;
    const marker = b.hasMarker ? b.marker : null;
    const left = marker ? Math.max(marker.planned.length - marker.done.length, 0) : 0;
    const stampText = formatLocalStamp(new Date(b.stamp * 1000).toISOString());
    return (
      <div
        key={b.dirName}
        class={{ "purge-backups__row": true, "is-unfinished": b.hasMarker }}
      >
        <span class="purge-backups__icon">
          {b.hasMarker ? <TriangleAlert size={14} /> : <Undo2 size={14} />}
        </span>
        <span class="purge-backups__body">
          <span class="purge-backups__name" data-hint-overflow={b.dirName}>
            {b.dirName}
          </span>
          <span class="purge-backups__badges">
            <span class="purge-backups__badge">{stampText}</span>
            <span class="purge-backups__badge">
              {t("resources.purgeBackups.files", { count: b.fileCount })}
            </span>
            {b.hasMarker ? (
              marker ? (
                <>
                  <span class="purge-backups__badge is-unfinished">
                    {t("resources.purgeBackups.unfinished")}
                  </span>
                  <span class="purge-backups__badge is-evidence">
                    {t("resources.purgeBackups.progress", {
                      done: marker.done.length,
                      planned: marker.planned.length,
                    })}
                  </span>
                  <span class="purge-backups__badge is-evidence">
                    {marker.mode === "adopt-foreign"
                      ? t("resources.purgeBackups.modeAdopt")
                      : t("resources.purgeBackups.modeOurs")}
                  </span>
                </>
              ) : (
                // The marker file exists but does not parse: state unknown,
                // so scope/progress would be a guess — resume stays hidden
                // and dismiss is the only way out.
                <>
                  <span class="purge-backups__badge is-unfinished">
                    {t("resources.purgeBackups.unfinished")}
                  </span>
                  <span class="purge-backups__badge is-unfinished">
                    {t("resources.purgeBackups.markerUnreadable")}
                  </span>
                </>
              )
            ) : (
              <span class="purge-backups__badge is-quarantined">
                {t("resources.purgeBackups.completed")}
              </span>
            )}
          </span>
        </span>
        <span class="purge-backups__actions">
          {b.hasMarker ? (
            <>
              {marker ? (
                <HkButton
                  size="xs"
                  variant="primary"
                  loading={busy}
                  disabled={busy}
                  data-hint={t("resources.purgeBackups.resumeHint", { left })}
                  onClick={() => void pins.resume(b)}
                >
                  <Play size={12} />
                  {t("resources.purgeBackups.resume")}
                </HkButton>
              ) : null}
              <HkButton
                size="xs"
                variant="outline"
                disabled={busy}
                data-hint={t("resources.purgeBackups.dismissHint")}
                onClick={() => void pins.dismiss(b)}
              >
                {t("resources.purgeBackups.dismiss")}
              </HkButton>
            </>
          ) : (
            <>
              <HkButton
                size="xs"
                variant="secondary"
                disabled={busy}
                data-hint={t("resources.purgeBackups.restoreHint")}
                onClick={() => void pins.restore(b)}
              >
                <RotateCcw size={12} />
                {t("resources.purgeBackups.restore")}
              </HkButton>
              <HkButton
                size="xs"
                variant="outline"
                disabled={busy}
                data-hint={t("resources.purgeBackups.deleteHint")}
                onClick={() => pins.askDelete(b)}
              >
                <Trash2 size={12} />
                {t("resources.purgeBackups.delete")}
              </HkButton>
            </>
          )}
        </span>
      </div>
    );
  });
}
