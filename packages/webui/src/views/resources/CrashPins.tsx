/** Crash-suspect pinning for the mod hub list (崩溃嫌疑置顶). The crash
 *  watchdog analysis names top-level res_mods entries as suspects; this
 *  module pins them ABOVE the installed list while they matter: a
 *  suspect that matches a scanned unit wears the amber crash badge, one
 *  that matches nothing reads as an UNKNOWN mod on a yellow warning row
 *  (the product spec), and quarantined entries stay pinned with a
 *  restore action until the user brings them back. Everything rides the
 *  crash store; failures stay quiet (no watchdog backend, no pins). */
import { ref, watch, type Ref } from "vue";

import { HkButton, useToast } from "@celestia-island/hikari";
import { RotateCcw, ShieldAlert, TriangleAlert } from "@lucide/vue";

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

  return { crash, suspects, recordId, quarantine, restore };
}

/** The pinned block ABOVE the installed list. Renders nothing when the
 *  store carries no suspects and no quarantined entries. */
export function renderCrashPins(
  pins: ReturnType<typeof useCrashPins>,
  installedList: InstalledMod[],
) {
  const suspects = pins.suspects.value;
  const quarantined = pins.crash.quarantined;
  if (suspects.length === 0 && quarantined.length === 0) return null;
  return (
    <div class="crash-pins">
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
              <span class="crash-pins__name">
                {unit ? unit.name : s.name}
              </span>
              <span class="crash-pins__badges">
                <span class="crash-pins__badge">{t("crash.modlist.pinnedBadge")}</span>
                {!unit ? (
                  <span class="crash-pins__badge is-unknown">
                    {t("crash.suspects.unknownBadge")}
                  </span>
                ) : null}
                <span class="crash-pins__badge is-evidence">
                  {t("crash.suspects.evidence." + s.evidence)}
                </span>
                {isQuarantined ? (
                  <span class="crash-pins__badge is-quarantined">
                    {t("crash.modlist.quarantinedBadge")}
                  </span>
                ) : null}
              </span>
            </span>
            {isQuarantined ? (
              <HkButton
                size="xs"
                variant="secondary"
                disabled={busy}
                onClick={() => void pins.restore(s.name)}
              >
                <RotateCcw size={12} />
                {t("crash.suspects.restore")}
              </HkButton>
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
                <span class="crash-pins__name">{q.name}</span>
                <span class="crash-pins__badges">
                  <span class="crash-pins__badge is-quarantined">
                    {t("crash.modlist.quarantinedBadge")}
                  </span>
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
            </div>
          );
        })}
    </div>
  );
}