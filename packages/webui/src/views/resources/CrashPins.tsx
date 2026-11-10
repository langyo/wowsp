/** Crash-suspect pinning for the mod hub list (崩溃嫌疑置顶). The crash
 *  watchdog analysis names top-level res_mods entries as suspects; this
 *  module surfaces them as ONE collapsed launcher row above the installed
 *  list (they used to pin as N rows and squeeze the normal entries out of
 *  the viewport) that opens a secondary window with the management
 *  surface: a suspect that matches a scanned unit wears the amber crash
 *  badge, one that matches nothing reads as an UNKNOWN mod on a yellow
 *  warning row (the product spec), and quarantined entries stay listed
 *  with RESTORE and permanent-DELETE actions until the user brings them
 *  back or drops them for good (the delete dialog confirms first; the
 *  backend resolves the active copy, its safe-mode twin and the
 *  quarantine copy in one pass). Everything rides the crash store;
 *  failures stay quiet (no watchdog backend, no pins). */
import { ref, watch, type Ref } from "vue";

import {
  HkButton,
  HkConfirmDialog,
  HkModal,
  HkScrollContainer,
  useToast,
} from "@celestia-island/hikari";

import AppTag from "@/components/base/AppTag";
import { ChevronRight, RotateCcw, ShieldAlert, Trash2, TriangleAlert } from "@lucide/vue";

import { useCrashStore } from "@/stores/crash";
import { t } from "@/i18n";
import { sameGamePath } from "@/utils/gamePath";
import type { InstalledMod, SuspectMod } from "@/api";
import "./CrashPins.scss";

/** The suspect matching core: a suspect names a top-level res_mods entry,
 *  so a unit matches when any of its roots IS that entry or sits under
 *  it (case-insensitive paths); the display name is the last resort. */
export function unitOfSuspect(
  installedList: InstalledMod[],
  suspect: string,
): InstalledMod | null {
  const s = suspect.toLowerCase();
  const byPath = installedList.find((m) =>
    m.paths.some((p) => {
      const lower = p.toLowerCase();
      return lower === s || lower.startsWith(s + "/");
    }),
  );
  if (byPath) return byPath;
  return installedList.find((m) => m.name.toLowerCase() === s) ?? null;
}

/** The pinned-state mirror the resources view renders from. */
export function useCrashPins(gameRoot: Ref<string | null>) {
  const crash = useCrashStore();
  const toast = useToast();
  const suspects = ref<SuspectMod[]>([]);
  /** The record the pins attribute quarantine actions to. */
  const recordId = ref<string | undefined>(undefined);
  /** The quarantined entry awaiting its permanent-delete confirmation. */
  const deleteTarget = ref<string | null>(null);

  /** The newest record of THIS install drives the pins. */
  async function refreshSuspects() {
    const root = gameRoot.value;
    if (!root) {
      suspects.value = [];
      return;
    }
    const record = crash.history.find(
      (r) => r.gameRoot && sameGamePath(r.gameRoot, root),
    );
    if (!record) {
      suspects.value = [];
      recordId.value = undefined;
      return;
    }
    recordId.value = record.id;
    try {
      const analysis = await crash.analyze(record.id);
      suspects.value = analysis.suspects;
    } catch {
      suspects.value = [];
    }
  }

  async function loadQuarantined() {
    const root = gameRoot.value;
    if (!root) return;
    try {
      await crash.loadQuarantined(root);
    } catch {
      // No watchdog backend or no manifest yet — nothing pinned.
    }
  }

  watch(gameRoot, () => {
    void refreshSuspects();
    void loadQuarantined();
  });
  watch(
    () => crash.history,
    () => void refreshSuspects(),
  );
  void refreshSuspects();
  void loadQuarantined();

  async function quarantine(name: string, crashId: string | undefined) {
    try {
      await crash.quarantine(name, crashId, gameRoot.value);
      toast.success(name + " — " + t("crash.modlist.quarantinedBadge"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function restore(name: string) {
    try {
      await crash.restore(name, gameRoot.value);
      toast.success(name + " — " + t("crash.suspects.restore"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  /** Arm the permanent-delete confirmation for one quarantined entry. */
  function askDelete(name: string) {
    deleteTarget.value = name;
  }

  /** Permanently delete one quarantined entry (the confirm dialog's
   *  action): the backend resolves every copy — the active res_mods tree,
   *  its safe-mode twin and the quarantine copy — and answers the updated
   *  manifest, which the store pins. The cached analysis still describes
   *  the pre-delete world, so it is dropped and re-derived too — without
   *  that, a deleted quarantined SUSPECT would stay listed as a plain
   *  suspect offering the quarantine action (the same refresh the crash
   *  section's refreshAll runs). Throws never: the toast is here. */
  async function deleteQuarantined(name: string) {
    try {
      await crash.deleteEntry(name, gameRoot.value);
      toast.success(name + " — " + t("crash.suspects.deleteDone"));
      // The delete already succeeded — a failed re-analysis must not turn
      // it into an error toast; the stale row clears on the next pass.
      if (recordId.value) {
        try {
          await crash.refreshAnalysis(recordId.value);
        } catch {
          // Best-effort: the entry is gone either way.
        }
      }
      await loadQuarantined();
      await refreshSuspects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    crash,
    suspects,
    recordId,
    deleteTarget,
    quarantine,
    restore,
    askDelete,
    deleteQuarantined,
  };
}

/** The collapsed launcher row ABOVE the installed list — one line, not N:
 *  the pinned rows used to squeeze the normal entries out of the sidebar
 *  viewport, so they moved into the secondary window this row opens
 *  (renderCrashPinsWindow). Renders nothing when the store carries no
 *  suspects and no quarantined entries. */
export function renderCrashPins(
  pins: ReturnType<typeof useCrashPins>,
  onOpen: () => void,
) {
  const suspects = pins.suspects.value;
  const quarantined = pins.crash.quarantined;
  if (suspects.length === 0 && quarantined.length === 0) return null;
  return (
    <div class="crash-pins">
      <div
        role="button"
        tabindex={0}
        class="crash-pins__row is-summary"
        data-hint={t("crash.modlist.manageHint")}
        onClick={onOpen}
        onKeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <span class="crash-pins__icon">
          <ShieldAlert size={14} />
        </span>
        <span class="crash-pins__body">
          <span class="crash-pins__name">{t("crash.modlist.title")}</span>
          <span class="crash-pins__badges">
            <AppTag tone="warning">
              {t("crash.modlist.pinnedBadge")} · {suspects.length}
            </AppTag>
            {quarantined.length > 0 ? (
              <AppTag tone="default">
                {t("crash.modlist.quarantinedBadge")} · {quarantined.length}
              </AppTag>
            ) : null}
          </span>
        </span>
        <ChevronRight size={14} class="crash-pins__chevron" />
      </div>
    </div>
  );
}

/** The secondary window the launcher row opens — the suspect rows and the
 *  quarantined-only rows with their quarantine / restore / delete actions,
 *  exactly the management surface the pinned block used to inline above
 *  the installed list, plus the permanent-delete confirmation dialog. */
export function renderCrashPinsWindow(
  pins: ReturnType<typeof useCrashPins>,
  installedList: InstalledMod[],
  open: boolean,
  onUpdateOpen: (open: boolean) => void,
) {
  return (
    <>
      <HkModal
        modelValue={open}
        onUpdate:modelValue={onUpdateOpen}
        title={t("crash.modlist.title")}
        width="40rem"
      >
        <HkScrollContainer class="crash-pins__scroll">
          <div class="crash-pins crash-pins--window">
            {renderCrashPinRows(pins, installedList)}
          </div>
        </HkScrollContainer>
      </HkModal>
      {/* Permanent delete is irreversible and reaches outside res_mods (the
          quarantine copy and the safe-mode twin) — always confirm first. */}
      <HkConfirmDialog
        open={pins.deleteTarget.value !== null}
        title={t("crash.suspects.confirmDeleteTitle")}
        message={t("crash.suspects.confirmDeleteMessage", {
          name: pins.deleteTarget.value ?? "",
        })}
        confirmLabel={t("crash.suspects.delete")}
        onConfirm={() => {
          const name = pins.deleteTarget.value;
          pins.deleteTarget.value = null;
          if (name) void pins.deleteQuarantined(name);
        }}
        onUpdate:open={(v: boolean) => {
          if (!v) pins.deleteTarget.value = null;
        }}
      />
    </>
  );
}

/** The management rows themselves — suspects first (a quarantined suspect
 *  rides its own row with restore + permanent-delete actions), then
 *  quarantined entries no suspect row already covers (the same pair). */
function renderCrashPinRows(
  pins: ReturnType<typeof useCrashPins>,
  installedList: InstalledMod[],
) {
  const suspects = pins.suspects.value;
  const quarantined = pins.crash.quarantined;
  return (
    <>
      {suspects.map((s) => {
        const unit = unitOfSuspect(installedList, s.name);
        const isQuarantined = quarantined.some(
          (q) => q.name.toLowerCase() === s.name.toLowerCase(),
        );
        const busy = pins.crash.quarantineBusy.has(s.name);
        return (
          <div
            key={s.name}
            class={{
              "crash-pins__row": true,
              "is-unknown": !unit,
            }}
          >
            <span class="crash-pins__icon">
              {unit ? <ShieldAlert size={14} /> : <TriangleAlert size={14} />}
            </span>
            <span class="crash-pins__body">
              <span class="crash-pins__name" data-hint-overflow={unit ? unit.name : s.name}>
                {unit ? unit.name : s.name}
              </span>
              <span class="crash-pins__badges">
                <AppTag tone="warning">{t("crash.modlist.pinnedBadge")}</AppTag>
                {!unit ? (
                  <AppTag tone="warning" face="solid">
                    {t("crash.suspects.unknownBadge")}
                  </AppTag>
                ) : null}
                <AppTag face="outline">
                  {t("crash.suspects.evidence." + s.evidence)}
                </AppTag>
                {isQuarantined ? (
                  <AppTag tone="default">
                    {t("crash.modlist.quarantinedBadge")}
                  </AppTag>
                ) : null}
              </span>
            </span>
            {isQuarantined ? (
              <>
                <HkButton
                  size="xs"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void pins.restore(s.name)}
                >
                  <RotateCcw size={12} />
                  {t("crash.suspects.restore")}
                </HkButton>
                <HkButton
                  size="xs"
                  variant="danger"
                  disabled={busy}
                  onClick={() => pins.askDelete(s.name)}
                >
                  <Trash2 size={12} />
                  {t("crash.suspects.delete")}
                </HkButton>
              </>
            ) : (
              <HkButton
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void pins.quarantine(s.name, pins.recordId.value)}
              >
                <ShieldAlert size={12} />
                {t("crash.suspects.quarantine")}
              </HkButton>
            )}
          </div>
        );
      })}
      {quarantined
        .filter((q) => !suspects.some((s) => s.name.toLowerCase() === q.name.toLowerCase()))
        .map((q) => {
          const busy = pins.crash.quarantineBusy.has(q.name);
          return (
            <div key={"q-" + q.name} class="crash-pins__row is-quarantined">
              <span class="crash-pins__icon">
                <RotateCcw size={14} />
              </span>
              <span class="crash-pins__body">
                <span class="crash-pins__name" data-hint-overflow={q.name}>{q.name}</span>
                <span class="crash-pins__badges">
                  <AppTag tone="default">
                    {t("crash.modlist.quarantinedBadge")}
                  </AppTag>
                </span>
              </span>
              <HkButton
                size="xs"
                variant="secondary"
                disabled={busy}
                onClick={() => void pins.restore(q.name)}
              >
                <RotateCcw size={12} />
                {t("crash.suspects.restore")}
              </HkButton>
              <HkButton
                size="xs"
                variant="danger"
                disabled={busy}
                onClick={() => pins.askDelete(q.name)}
              >
                <Trash2 size={12} />
                {t("crash.suspects.delete")}
              </HkButton>
            </div>
          );
        })}
    </>
  );
}