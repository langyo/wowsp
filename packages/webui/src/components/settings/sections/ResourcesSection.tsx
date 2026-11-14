/** Resources settings section: the one place that lists every on-disk asset
 *  the app manages — game-client data (hot-updated ship data, the mod
 *  catalog and the auxiliary caches), the shared resource pack, and the AI
 *  runtime with the decision-model pack it runs.
 *
 *  Information hierarchy (reworked 2026-11-14). The pane used to be a
 *  maintainer's audit shelf: the six-column registry walk sat on top and
 *  eleven individually managed mini-cards with seventeen visible verbs sat
 *  below it, so a new player met a registry dump before learning whether
 *  anything needed doing. The pane now answers that question FIRST:
 *
 *    1. ONE status card — a tone rail + one sentence (ready / not checked
 *       yet / updates available / something missing), the on-disk footprint
 *       and the pane's only check verb.
 *    2. ONE family card — game data / resource pack / decision models /
 *       caches. Same-family items share one action (the visible verbs drop
 *       from seventeen to five), and every row names what the resource IS
 *       before showing its state.
 *    3. ONE details WINDOW — the registry walk's six columns, per-cache
 *       controls, the AI runtime's technical facts and the destructive
 *       deletes open as a child window stacked through the shared popup
 *       context (a centered frame on desktop, a docked sheet on phones)
 *       instead of competing with the player surface for space. Everything a
 *       maintainer needs stays one click away and nothing is lost.
 *
 *  Two derivations are deliberately conservative. The status card never
 *  dresses an unchecked set up as "ready" — "not checked yet" is its own
 *  state, because the sizes and stamps it summarizes arrive from five sources
 *  with five freshness rules. And the footprint sums the ONE registry walk,
 *  never the walk plus the aux-cache overview (both measure the same
 *  directories).
 *
 *  NO download progress renders here. Every resource pass is a context of the
 *  unified download context (stores/downloads) and renders on the shared
 *  top-right DownloadToast card, so a download looks the same wherever it was
 *  started and stays visible while this pane is closed. The cards below keep
 *  the management verbs (check / install / delete) and gate themselves on
 *  `downloads.busyFor(...)`.
 *
 *  The AI family row is also the portable-build explanation: the 便捷版
 *  compiles the `ai` feature out entirely, so inference/scoring surfaces are
 *  disabled with a pointer to the full installer instead of failing silently.
 */
import { computed, defineComponent, ref, type PropType } from "vue";
import {
  CheckCircle2,
  ChevronRight,
  Download,
  HardDrive,
  TriangleAlert,
} from "@lucide/vue";
import { HkButton, HkModal, HkSettingsGroup, HkTag } from "@celestia-island/hikari";

import { t } from "@/i18n";
import ErrorCard from "@/components/base/ErrorCard";
import LoadingNote from "@/components/base/LoadingNote";
import { formatLocalStamp } from "@/utils/format";
import { useDownloadsStore } from "@/stores/downloads";
import { SETTINGS_ANCHOR_BAKED_MODELS } from "@/stores/settingsUi";
import { formatBytes } from "@/components/settings/useSettingsUpdatesState";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import ResourcesDetails from "./ResourcesDetails";

/** The game-data family's registry members: the consumable kit, the
 *  two-realm ship-data bundle and the mod-hub index. Their sizes come from
 *  the walk — the family row shows ONE number for the set. */
const GAME_DATA_IDS = ["data-kit", "data-ship-gameparams", "mod-catalog"] as const;

type SummaryTone = "success" | "info" | "warning" | "neutral";

/** Tone → the icon chip the status card shows. */
const SUMMARY_ICONS: Record<SummaryTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  info: Download,
  warning: TriangleAlert,
  neutral: HardDrive,
};

export default defineComponent({
  name: "SettingsResourcesSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { updates, resources } = props.ctx;
    const cacheStore = updates.cacheStore;
    // The unified download context: "is this pass running?" comes from the
    // ledger (one answer for every surface), and the progress itself renders
    // in the shared top-right card, never in this pane.
    const downloads = useDownloadsStore();
    const packBusy = computed(() => downloads.busyFor("res-pack"));

    /** The status card's readout. Priority: a pending app update gates the
     *  pack work → a missing pack (the biggest visible loss) → missing
     *  decision models → known updates → checked-and-clean → never checked
     *  (the honest resting state on a fresh install, see the header). */
    const summary = computed<{
      tone: SummaryTone;
      title: string;
      hint: string;
      action: "none" | "check" | "download" | "updateAll";
    }>(() => {
      const status = cacheStore.status;
      const rows = updates.resourceRows.value;
      if (rows == null && status == null) {
        return { tone: "neutral", title: t("settings.resStatusChecking"), hint: "", action: "none" };
      }
      const caps = resources.capabilities;
      // A boot-time pass flips `present` false while it streams the pack:
      // that is a pass in flight, not a missing pack, and it must not offer a
      // second download.
      const downloadingNow = packBusy.value || status?.downloading === true;
      const packMissing =
        status != null && !status.present && !status.bundled && !downloadingNow;
      const modelsMissing =
        caps.loaded &&
        caps.aiInference &&
        resources.decisionsChecked.value &&
        !resources.decisionsError.value &&
        resources.decisions.value?.present !== true;
      const anyUpdate =
        cacheStore.anyUpdateAvailable || resources.aiCheck.value?.updateAvailable === true;
      // The app-first gate is about the RESOURCE PACK. The decision-model
      // pack rides its own signed channel and is not held back by an app
      // update, so an AI-only update must not take this branch.
      if (updates.appUpdatePending.value && (cacheStore.anyUpdateAvailable || packMissing)) {
        return {
          tone: "warning",
          title: t("settings.resStatusAppFirst"),
          hint: t("settings.resAfterApp"),
          action: "none",
        };
      }
      if (packMissing) {
        return {
          tone: "warning",
          title: t("settings.resStatusMissingPack"),
          hint: t("settings.resStatusMissingPackHint"),
          action: "download",
        };
      }
      if (modelsMissing) {
        return {
          tone: "warning",
          title: t("settings.resStatusMissingModels"),
          hint: t("settings.resStatusMissingModelsHint"),
          action: "none",
        };
      }
      if (anyUpdate) {
        return {
          tone: "info",
          title: t("settings.resStatusUpdates"),
          hint: t("settings.resStatusUpdatesHint"),
          // Known updates grow the pane's ONE apply verb: one click queues
          // every pending pass instead of walking the rows one by one.
          action: "updateAll",
        };
      }
      // "Ready" is only claimed for a set that was actually checked: the walk
      // stamps `checkedAt` when the refresh entry touches a row, and the res
      // manifest's snapshot carries its own check time.
      // BOTH halves of the evidence are required: the walk's ledger stamp
      // (some row was actually re-checked) AND the res manifest snapshot. An
      // OR would let one stale half dress the whole set up as ready.
      const checked =
        updates.walkCheckedAt.value != null && cacheStore.updatesCheckedAt !== 0;
      if (!checked) {
        return {
          tone: "neutral",
          title: t("settings.resStatusUnchecked"),
          hint: t("settings.resStatusUncheckedHint"),
          action: "check",
        };
      }
      return { tone: "success", title: t("settings.resStatusReady"), hint: "", action: "check" };
    });

    /** The game-data family's freshest stamp: the ship datasets' publish
     *  stamp or the mod-hub index's fetch stamp, whichever is newer. Both are
     *  RFC3339, so the lexical compare is chronological. */
    const gameDataStamp = computed(() => {
      const pack = updates.dataPackVersion.value;
      const catalog = updates.modCatalogStamp.value;
      if (pack && catalog) return pack > catalog ? pack : catalog;
      return pack ?? catalog;
    });

    /** The status card's second line: the footprint the walk measured. */
    const summaryMeta = computed(() => {
      const rows = updates.resourceRows.value;
      const total = updates.walkTotalBytes.value;
      if (rows == null || total <= 0) return "";
      const checked = updates.walkCheckedAt.value;
      return checked
        ? t("settings.resStatusMeta", {
            size: formatBytes(total),
            time: formatLocalStamp(checked),
          })
        : t("settings.resStatusMetaNoTime", { size: formatBytes(total) });
    });

    /** The pack's raw hash line, shared with the details body — the hook
     *  owns the derivation so both shells read one answer. */
    const packHashHint = updates.packHashHint;

    /** The pack row's single state chip (one slot, exactly like the verb). */
    const packState = computed<{
      label: string | null;
      variant: "default" | "primary" | "success" | "warning";
    }>(() => {
      const st = cacheStore.status;
      if (packBusy.value || (st?.downloading ?? false)) {
        return { label: t("settings.cacheApplying"), variant: "primary" };
      }
      if (st?.bundled) return { label: t("settings.resBundledInUse"), variant: "default" };
      if (!st?.present) return { label: t("settings.cacheStatusMissing"), variant: "warning" };
      if (cacheStore.update?.updateAvailable) {
        return { label: t("settings.cacheUpdateAvailable"), variant: "warning" };
      }
      // No manifest snapshot (offline / first frame / failed fetch): claim
      // NOTHING. "Up to date" is only honest against a fetched manifest.
      if (cacheStore.update == null) return { label: null, variant: "default" };
      return { label: t("settings.resUpToDate"), variant: "success" };
    });

    /** True for the WHOLE check pass (the shared refresh entry plus the two
     *  client-side manifest snapshots the rows gate their verbs on) — the
     *  button spins until the last snapshot lands, not just the IPC. */
    const checkRunning = ref(false);

    async function runCheckAll() {
      if (checkRunning.value) return;
      checkRunning.value = true;
      try {
        // The shell's refresh entry (data lanes + both manifests)...
        await updates.checkAll();
        // ...then the res manifest through the user-facing verb: an explicit
        // check announces the update flavour (delta count / full download)
        // instead of silently flipping a chip.
        await cacheStore.checkUpdates();
        // The mod-hub index is ON DEMAND by design and is not part of the
        // shell's refresh plan, so an explicit check forces it here or the
        // lane would never refresh from this pane.
        await updates.refreshModCatalogRow(true);
        await resources.checkAiUpdate();
      } finally {
        checkRunning.value = false;
      }
    }

    /** True while ANY resource pass is running (either pack). The update-all
     *  button spins on this; the passes themselves render on the shared
     *  top-right card, each with its own cancel. */
    const anyPassBusy = computed(
      () => packBusy.value || resources.aiDownloading.value,
    );

    /** One click, every pending pass. Both halves route through the download
     *  hub's single FIFO (strict one-at-a-time; queue order is hub arrival,
     *  after each command's manifest resolve — not click order). The res-pack
     *  half re-checks the app-first gate here: the summary cannot reach this
     *  state while an app update gates the pack, but the guard keeps the
     *  verb honest if that races. */
    function runUpdateAll() {
      if (anyPassBusy.value) return;
      if (cacheStore.anyUpdateAvailable && !updates.appUpdatePending.value) {
        void updates.runVerb(() => cacheStore.download());
      }
      if (resources.aiCheck.value?.updateAvailable) {
        void updates.runVerb(() => resources.downloadAi());
      }
    }

    /** The details child window's open state. */
    const detailsOpen = ref(false);

    return () => {
      const st = cacheStore.status;
      const upd = cacheStore.update;
      const downloading = packBusy.value || (st?.downloading ?? false);
      const d = resources.decisions.value;
      const aiCheck = resources.aiCheck.value;
      const caps = resources.capabilities;
      // The capability probe is async; render "checking" instead of a
      // misleading "portable build" banner during the first frame.
      const aiKnown = caps.loaded;
      const sum = summary.value;
      const SummaryIcon = SUMMARY_ICONS[sum.tone];
      const modelsBytes = d?.present ? d.sizeBytes : 0;
      const auxBytes = cacheStore.auxCaches.reduce((n, c) => n + c.sizeBytes, 0);
      const gameDataBytes = updates.familyBytes(GAME_DATA_IDS);
      return (
        <>
          {/* ── status card: the pane's first answer ───────────────────────
              A tone rail + one sentence + the footprint + the only check
              verb. The card never claims "ready" for a set it has not
              checked, and a pending app update explains itself here rather
              than only on the disabled pack button. */}
          <HkSettingsGroup title={t("settings.resStatusTitle")}>
            <div class={`settings-modal__res-summary settings-modal__res-summary--${sum.tone}`}>
              <span class="settings-modal__res-summary-icon" aria-hidden="true">
                <SummaryIcon size={16} />
              </span>
              {/* role=status: a check that flips the verdict is announced to
                  assistive tech, not only repainted. */}
              <div class="settings-modal__res-summary-body" role="status">
                <span class="settings-modal__res-summary-title">{sum.title}</span>
                {summaryMeta.value ? (
                  <span class="settings-modal__res-summary-meta">{summaryMeta.value}</span>
                ) : null}
                {sum.hint ? (
                  <span class="settings-modal__res-summary-meta">{sum.hint}</span>
                ) : null}
              </div>
              <div class="settings-modal__pack-actions">
                {sum.action === "download" ? (
                  <HkButton
                    variant="primary"
                    size="sm"
                    disabled={updates.appUpdatePending.value}
                    onClick={() => void updates.runVerb(() => cacheStore.download())}
                  >
                    {t("settings.cacheDownload")}
                  </HkButton>
                ) : sum.action === "updateAll" ? (
                  <HkButton
                    variant="primary"
                    size="sm"
                    loading={anyPassBusy.value}
                    onClick={runUpdateAll}
                  >
                    {t("settings.resStatusUpdateAll")}
                  </HkButton>
                ) : sum.action === "check" ? (
                  <HkButton
                    variant={sum.tone === "success" ? "secondary" : "primary"}
                    size="sm"
                    loading={checkRunning.value}
                    onClick={() => void runCheckAll()}
                  >
                    {t("settings.cacheCheckUpdates")}
                  </HkButton>
                ) : null}
              </div>
            </div>
          </HkSettingsGroup>

          {/* ── the four family rows ───────────────────────────────────────
              One row per family, at most one verb each. Same-family items
              share the action, so the pane cannot ask a player to press
              "refresh" twice for the same lane or "clear" four times for the
              four caches. */}
          <HkSettingsGroup title={t("settings.resSpaceTitle")}>
            {/* game data — no per-row verb: these datasets are the boot-time
                lane the status card's check spans as a whole. */}
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">
                  {t("settings.resFamilyGameData")}
                </span>
                <span class="settings-modal__pack-desc">
                  {t("settings.resFamilyGameDataDesc")}
                </span>
                <span class="settings-modal__pack-meta">
                  {updates.resourceRows.value == null ? (
                    <LoadingNote inline text={t("settings.resourcesAiChecking")} />
                  ) : (
                    <>
                      {gameDataBytes > 0 ? (
                        <HkTag size="sm">{formatBytes(gameDataBytes)}</HkTag>
                      ) : null}
                      {gameDataStamp.value ? (
                        <span>
                          {t("settings.resFamilyGameDataVersion", {
                            time: formatLocalStamp(gameDataStamp.value),
                          })}
                        </span>
                      ) : gameDataBytes > 0 ? null : (
                        <span>{t("settings.dataSourceBundled")}</span>
                      )}
                    </>
                  )}
                </span>
              </div>
            </div>

            {/* resource pack — ONE verb that switches role with the state
                (download → integrity check → update). The data-settings-anchor
                stays on this row so the settings shell's glide still finds its
                target if an opener sets one again. */}
            <div
              class="settings-modal__pack"
              data-settings-anchor={SETTINGS_ANCHOR_BAKED_MODELS}
            >
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">{t("settings.resPackTitle")}</span>
                <span class="settings-modal__pack-desc">
                  {t("settings.resFamilyPackDesc")}
                </span>
                <span class="settings-modal__pack-meta">
                  {st == null ? (
                    <LoadingNote inline text={t("settings.resourcesAiChecking")} />
                  ) : (
                    <>
                      {st.present ? <HkTag size="sm">{formatBytes(st.sizeBytes)}</HkTag> : null}
                      {/* While a pass runs the button below already says
                          "applying" — the chip would repeat it. */}
                      {packState.value.label && !downloading ? (
                        <span data-hint={packHashHint.value || undefined}>
                          <HkTag size="sm" variant={packState.value.variant}>
                            {packState.value.label}
                          </HkTag>
                        </span>
                      ) : null}
                      {updates.appUpdatePending.value ? (
                        <span data-hint={t("settings.resAfterApp")}>
                          <HkTag size="sm" variant="warning">
                            {t("settings.resAfterAppTag")}
                          </HkTag>
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
                {downloads.errorFor("res-pack") ? (
                  /* A failed pass is a retry affordance, not progress: the
                     failure stays beside the button that retries it (the
                     running percent/speed lives on the shared toast card). */
                  <ErrorCard
                    error={downloads.errorFor("res-pack") ?? ""}
                    description={t("settings.cacheDownloadFailed")}
                  />
                ) : null}
              </div>
              <div class="settings-modal__pack-actions">
                {downloading ? (
                  /* The pass is running: the shared card owns the progress
                     AND the cancel verb, so this pane only says so. */
                  <HkButton size="sm" loading>
                    {t("settings.cacheApplying")}
                  </HkButton>
                ) : st == null ? null : !st.present && !st.bundled ? (
                  <HkButton
                    variant="primary"
                    size="sm"
                    disabled={updates.appUpdatePending.value}
                    onClick={() => void updates.runVerb(() => cacheStore.download())}
                  >
                    {t("settings.cacheDownload")}
                  </HkButton>
                ) : upd != null && !upd.updateAvailable && !st.bundled && !st.legacyStamp ? (
                  // Already current: the update slot becomes the integrity
                  // check — re-hash on demand and repair via an automatic
                  // re-download when it drifted. Hidden when the APK bundle
                  // serves (mobile) or the cache predates the hash scheme.
                  <HkButton
                    variant="secondary"
                    size="sm"
                    loading={cacheStore.integrityChecking}
                    onClick={() => void updates.runVerb(() => cacheStore.verifyIntegrity())}
                  >
                    {t("settings.resCheckIntegrity")}
                  </HkButton>
                ) : upd?.updateAvailable ? (
                  // Only a KNOWN update grows this button; a disabled "update"
                  // under a manifest we never fetched would be a dead control.
                  <HkButton
                    variant="primary"
                    size="sm"
                    disabled={updates.appUpdatePending.value}
                    onClick={() => void updates.runVerb(() => cacheStore.download())}
                  >
                    {t("settings.cacheUpdate")}
                  </HkButton>
                ) : null}
              </div>
            </div>

            {/* decision models — one slot too: check while the published
                manifest is unknown, apply when it reports an update. The
                runtime's technical facts live in the details panel. */}
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">
                  {t("settings.resFamilyModels")}
                </span>
                <span class="settings-modal__pack-desc">
                  {t("settings.resFamilyModelsDesc")}
                </span>
                <span class="settings-modal__pack-meta">
                  {!aiKnown ? (
                    <LoadingNote inline text={t("settings.resourcesAiChecking")} />
                  ) : !caps.aiInference ? (
                    <span>{t("settings.resourcesAiUnavailableHint")}</span>
                  ) : (
                    <>
                      {d?.present ? <HkTag size="sm">{formatBytes(modelsBytes)}</HkTag> : null}
                      {resources.aiChecking.value ? (
                        <LoadingNote inline text={t("settings.resourcesAiChecking")} />
                      ) : aiCheck?.updateAvailable ? (
                        <HkTag size="sm" variant="warning">
                          {t("settings.cacheUpdateAvailable")}
                        </HkTag>
                      ) : d?.present ? (
                        // Currency is only claimed against a fetched manifest.
                        aiCheck != null ? (
                          <HkTag size="sm" variant="success">
                            {t("settings.resUpToDate")}
                          </HkTag>
                        ) : null
                      ) : resources.decisionsChecked.value ? (
                        <HkTag size="sm">{t("settings.resStateNotInstalled")}</HkTag>
                      ) : null}
                    </>
                  )}
                </span>
              </div>
              <div class="settings-modal__pack-actions">
                {!aiKnown ? null : !caps.aiInference ? null : resources.aiDownloading.value ? (
                  <HkButton variant="secondary" size="sm" loading>
                    {t("settings.cacheApplying")}
                  </HkButton>
                ) : aiCheck?.updateAvailable ? (
                  <HkButton
                    variant="primary"
                    size="sm"
                    onClick={() => void updates.runVerb(() => resources.downloadAi())}
                  >
                    {d?.present
                      ? t("settings.resourcesAiChannelUpdate")
                      : t("settings.resourcesAiChannelDownload")}
                  </HkButton>
                ) : (
                  <HkButton
                    variant="secondary"
                    size="sm"
                    loading={resources.aiChecking.value}
                    onClick={() => void resources.checkAiUpdate()}
                  >
                    {t("settings.resourcesAiChannelCheck")}
                  </HkButton>
                )}
              </div>
            </div>

            {/* caches — the four clearable directories behind ONE cleanup
                verb (the per-scope controls stay in the details panel). */}
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">
                  {t("settings.resFamilyCaches")}
                </span>
                <span class="settings-modal__pack-desc">
                  {t("settings.resFamilyCachesDesc")}
                </span>
                <span class="settings-modal__pack-meta">
                  <HkTag size="sm">{formatBytes(auxBytes)}</HkTag>
                </span>
              </div>
              <div class="settings-modal__pack-actions">
                {updates.cleanArmed.value || cacheStore.auxClearing ? (
                  <HkButton
                    variant="danger"
                    size="sm"
                    loading={cacheStore.auxClearing}
                    disabled={cacheStore.auxClearing}
                    onClick={() => {
                      updates.cleanArmed.value = false;
                      void updates.runVerb(() => cacheStore.clearAllAuxCaches());
                    }}
                  >
                    {cacheStore.auxClearing
                      ? t("settings.resCleaning")
                      : t("settings.cacheDeleteConfirm")}
                  </HkButton>
                ) : (
                  <HkButton
                    variant="secondary"
                    size="sm"
                    disabled={auxBytes === 0}
                    onClick={() => (updates.cleanArmed.value = true)}
                  >
                    {t("settings.resCleanAll")}
                  </HkButton>
                )}
              </div>
            </div>
          </HkSettingsGroup>

          {/* ── details: the maintainer's view ─────────────────────────────
              A quiet entry row opens the audit body as a CHILD WINDOW stacked
              through the shared popup context — the same overlay stack the
              settings window itself lives on, so focus, ESC, the overlay and
              the phone back gesture all close it before the settings window
              reacts. Centered frame on desktop, docked sheet on phones; the
              pane itself never inlines the six-column table, and the
              destructive verbs stay behind this window. */}
          <button
            type="button"
            class="settings-modal__res-details-entry"
            aria-haspopup="dialog"
            aria-expanded={detailsOpen.value ? "true" : "false"}
            onClick={() => (detailsOpen.value = true)}
          >
            <span class="settings-modal__res-details-entry-text">
              <span class="settings-modal__res-details-entry-title">
                {t("settings.resDetailsTitle")}
              </span>
              <span class="settings-modal__res-details-entry-hint">
                {t("settings.resDetailsHint")}
              </span>
            </span>
            <span class="settings-modal__res-details-entry-chevron" aria-hidden="true">
              <ChevronRight size={16} />
            </span>
          </button>
          <HkModal
            modelValue={detailsOpen.value}
            onUpdate:modelValue={(v: boolean) => (detailsOpen.value = v)}
            title={t("settings.resDetailsTitle")}
            width="lg"
          >
            <ResourcesDetails ctx={props.ctx} />
          </HkModal>
        </>
      );
    };
  },
});
