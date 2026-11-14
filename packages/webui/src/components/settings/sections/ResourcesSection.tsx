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
 *    3. ONE collapsed details panel — the registry walk's six columns,
 *       per-cache controls, the AI runtime's technical facts and the
 *       destructive deletes. Everything a maintainer needs stays one click
 *       away and nothing is lost; the panel body is always mounted, so the
 *       inventory markup (and its column contract) is unchanged.
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
import { CheckCircle2, Download, HardDrive, TriangleAlert } from "@lucide/vue";
import {
  HkButton,
  HkExpansionPanel,
  HkSettingsGroup,
  HkSettingsHint,
  HkTag,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import ErrorCard from "@/components/base/ErrorCard";
import LoadingNote from "@/components/base/LoadingNote";
import { formatLocalStamp } from "@/utils/format";
import { isMobileApp } from "@/utils/platform";
import { useDownloadsStore } from "@/stores/downloads";
import { SETTINGS_ANCHOR_BAKED_MODELS } from "@/stores/settingsUi";
import {
  auxDesc,
  auxTitle,
  formatBytes,
  formatResourceVersion,
  formatStamp,
  hash6,
} from "@/components/settings/useSettingsUpdatesState";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

/** The inventory's six aligned columns — the header labels and the per-cell
 *  class modifier share this table, so a column cannot drift from its own
 *  label. The order is also DOM order: the kind chip closes every row. */
const INV_COLUMNS = [
  ["name", "settings.resInvColName"],
  ["size", "settings.resInvColSize"],
  ["version", "settings.resInvColVersion"],
  ["installed", "settings.resInvColInstalled"],
  ["channel", "settings.resInvColChannel"],
  ["kind", "settings.resInvColType"],
] as const;

/** One inventory cell: the shared class + its column modifier. Rows render
 *  exactly one per INV_COLUMNS entry — all six always, an absent fact
 *  showing the N/A chip rather than nothing, because the subgrid's shared
 *  axes shift as soon as a row drops a cell. `na` marks those placeholder
 *  cells so the phone layout can drop them (a desktop-table affordance). */
const invCellClass = (col: string, na = false): string =>
  `settings-modal__res-inv-cell settings-modal__res-inv-cell--${col}${
    na ? " settings-modal__res-inv-cell--na" : ""
  }`;

/** The N/A placeholder for an absent fact: a deliberately quiet grey chip.
 *  The cell carries the localized reason on the data-hint channel. */
const naTag = () => (
  <HkTag size="sm" class="settings-modal__res-inv-tag-na">
    {t("settings.resInvNa")}
  </HkTag>
);

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

    /** Display name for one registry row — existing per-resource keys
     *  where the cards name them, inventory-only keys otherwise (caches
     *  reuse the aux-cache titles). */
    const rowName = (id: string): string => {
      switch (id) {
        case "res-pack": return t("settings.resPackName");
        case "data-kit": return t("settings.dataSourceShipData");
        case "data-ship-gameparams": return t("settings.dataSourceShipBundle");
        case "mod-catalog": return t("settings.dataSourceModCatalog");
        case "cache-image-cache":
        case "cache-gameparams":
        case "cache-encyclopedia":
        case "cache-community": return auxTitle(id.replace(/^cache-/, ""));
        case "decisions-pack": return t("settings.resRowDecisions");
        case "app-update": return t("settings.resRowAppUpdate");
        case "bundled-lesta": return t("settings.resRowBundledLesta");
        default: return id;
      }
    };
    /** Flat kind labels (locale JSONs are flat per namespace — no dotted
     *  keys) — inventory detail only. */
    const kindLabel = (kind: string): string => {
      const map: Record<string, string> = {
        update: t("settings.resKindUpdate"),
        pack: t("settings.resKindPack"),
        dataset: t("settings.resKindDataset"),
        index: t("settings.resKindIndex"),
        cache: t("settings.resKindCache"),
        bundled: t("settings.resKindBundled"),
      };
      return map[kind] ?? kind;
    };
    /** Flat channel labels (same contract as kindLabel): the registry
     *  stores the relay's protocol codes, the inventory shows what they
     *  mean — an unknown code falls back to itself. */
    const channelLabel = (channel: string): string => {
      const map: Record<string, string> = {
        app: t("settings.resChanApp"),
        res: t("settings.resChanRes"),
        data: t("settings.resChanData"),
        "mod-hub": t("settings.resChanModHub"),
        ai: t("settings.resChanAi"),
      };
      return map[channel] ?? channel;
    };

    /** The status card's readout. Priority: a pending app update gates the
     *  pack work → a missing pack (the biggest visible loss) → missing
     *  decision models → known updates → checked-and-clean → never checked
     *  (the honest resting state on a fresh install, see the header). */
    const summary = computed<{
      tone: SummaryTone;
      title: string;
      hint: string;
      action: "none" | "check" | "download";
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
          action: "check",
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

    /** The pack row's hover hint: the raw current/latest hashes the state
     *  chip abbreviates. The audit facts do not disappear with the row's
     *  compactness — they move onto the app's one tooltip channel. */
    const packHashHint = computed(() => {
      const st = cacheStore.status;
      const upd = cacheStore.update;
      const parts: string[] = [];
      if (st?.present) {
        parts.push(
          `${t("settings.resCurrent")}: ${
            st.legacyStamp ? t("settings.resLegacy") : hash6(st.treeSha256)
          }`,
        );
        if (st.version && !st.legacyStamp) parts.push(formatStamp(st.version));
      }
      if (upd) parts.push(`${t("settings.resLatest")}: ${hash6(upd.latestTreeSha256)}`);
      return parts.join(" · ");
    });

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

    /** Run one management verb, then re-walk the registry. The store verbs
     *  keep their own slices fresh, but the walk is what the status card's
     *  footprint and the rows' sizes come from — without this the card would
     *  keep advertising the bytes a delete just freed for the rest of the
     *  session. */
    async function runVerb(verb: () => Promise<unknown>) {
      await verb();
      await updates.loadResourceRows();
    }

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

    return () => {
      const st = cacheStore.status;
      const upd = cacheStore.update;
      const downloading = packBusy.value || (st?.downloading ?? false);
      const d = resources.decisions.value;
      const ai = resources.aiStatus.value;
      const aiCheck = resources.aiCheck.value;
      let aiEndpointHost = "";
      if (aiCheck?.endpoint) {
        try {
          aiEndpointHost = new URL(aiCheck.endpoint).host;
        } catch {
          aiEndpointHost = aiCheck.endpoint;
        }
      }
      const caps = resources.capabilities;
      // The capability probe is async; render "checking" instead of a
      // misleading "portable build" banner during the first frame.
      const aiKnown = caps.loaded;
      const invRows = updates.resourceRows.value;
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
                    onClick={() => void runVerb(() => cacheStore.download())}
                  >
                    {t("settings.cacheDownload")}
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
                    onClick={() => void runVerb(() => cacheStore.download())}
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
                    onClick={() => void runVerb(() => cacheStore.verifyIntegrity())}
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
                    onClick={() => void runVerb(() => cacheStore.download())}
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
                    onClick={() => void runVerb(() => resources.downloadAi())}
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
                      void runVerb(() => cacheStore.clearAllAuxCaches());
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

          {/* ── details: the maintainer's view, collapsed ──────────────── */}
          <HkExpansionPanel
            class="settings-modal__res-details"
            title={t("settings.resDetailsTitle")}
            subtitle={t("settings.resDetailsHint")}
          >
            <div class="settings-modal__res-subhead">{t("settings.resInvTitle")}</div>
            <HkSettingsHint>{t("settings.resInvHint")}</HkSettingsHint>
            {invRows ? (
              <ul class="settings-modal__res-inv">
                {/* Visual column labels — aria-hidden because the row text
                    itself reads in order (name first, kind last). */}
                <li class="settings-modal__res-inv-head" aria-hidden="true">
                  {INV_COLUMNS.map(([col, key]) => (
                    <span class={invCellClass(col)} key={col}>
                      {t(key)}
                    </span>
                  ))}
                </li>
                {invRows.map((row) => {
                  const version = row.present
                    ? row.version ?? (row.sha256 ? hash6(row.sha256) : null)
                    : null;
                  const versionLabel = formatResourceVersion(version);
                  /* Resolved once per row: the absent facts share one
                     localized "why" on their data-hint channel. */
                  const naHint = t("settings.resInvNaHint");
                  return (
                    <li
                      class="settings-modal__res-inv-row"
                      key={row.id}
                      data-hint={
                        row.checkedAt
                          ? t("settings.resInvChecked", { time: formatLocalStamp(row.checkedAt) })
                          : undefined
                      }
                    >
                      {/* All six cells always render — an absent fact shows
                          the N/A chip instead of a blank cell (the shared
                          subgrid columns would shift row by row as soon as
                          one dropped a cell). Tooltips carry the raw values
                          the chips abbreviate; N/A cells hint the localized
                          reason. */}
                      <span class={invCellClass("name")}>{rowName(row.id)}</span>
                      <span
                        class={invCellClass("size", row.present && row.sizeBytes <= 0)}
                        data-hint={row.present && row.sizeBytes <= 0 ? naHint : undefined}
                      >
                        {!row.present ? (
                          /* Nothing on disk is the row's headline fact: the
                             size column warns instead of showing 0 MB. */
                          <HkTag variant="warning" size="sm">
                            {t("settings.cacheStatusMissing")}
                          </HkTag>
                        ) : row.sizeBytes > 0 ? (
                          <HkTag size="sm">{formatBytes(row.sizeBytes)}</HkTag>
                        ) : (
                          naTag()
                        )}
                      </span>
                      <span
                        class={invCellClass("version", !versionLabel)}
                        data-hint={versionLabel ? row.version ?? row.sha256 ?? undefined : naHint}
                      >
                        {versionLabel ? (
                          /* The abbreviated / localized label still hints its
                             full source (raw version, else the whole sha256).
                             Mono is the VERBATIM-ID face only (semver / build
                             id / hash6): a localized timestamp must share the
                             updated column's normal face, or the two stamp
                             columns read as different kinds of value again. */
                          <HkTag
                            size="sm"
                            class={
                              versionLabel === version
                                ? "settings-modal__res-inv-tag-mono"
                                : undefined
                            }
                          >
                            {versionLabel}
                          </HkTag>
                        ) : (
                          naTag()
                        )}
                      </span>
                      <span
                        class={invCellClass("installed", !(row.present && row.installedAt))}
                        data-hint={row.present && row.installedAt ? row.installedAt : naHint}
                      >
                        {row.present && row.installedAt ? (
                          /* The column header already says "updated"; the chip
                             is only the stamp, the hint the raw UTC ISO. */
                          <HkTag size="sm">{formatLocalStamp(row.installedAt)}</HkTag>
                        ) : (
                          naTag()
                        )}
                      </span>
                      <span
                        class={invCellClass("channel", !row.channel)}
                        data-hint={row.channel ? row.channel : naHint}
                      >
                        {row.channel ? (
                          /* The registry code is the tooltip; the chip is
                             the localized meaning. */
                          <HkTag variant="primary" size="sm">{channelLabel(row.channel)}</HkTag>
                        ) : (
                          naTag()
                        )}
                      </span>
                      <span class={invCellClass("kind")}>
                        <HkTag variant="info" size="sm">{kindLabel(row.kind)}</HkTag>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <HkSettingsHint>
              {isMobileApp() ? t("settings.resPackMobileHint") : t("settings.resPackHint")}
            </HkSettingsHint>
            {packHashHint.value ? (
              /* The raw current/latest hashes stay VISIBLE in the audit view —
                 the row chip's tooltip alone would hide them from keyboards
                 and screen readers. */
              <span class="settings-modal__pack-meta">{packHashHint.value}</span>
            ) : null}

            {/* ── per-cache controls ─────────────────────────────────────── */}
            <div class="settings-modal__res-subhead">{t("settings.resDetailsCachesTitle")}</div>
            {cacheStore.auxCaches.map((c) => (
              <div class="settings-modal__pack" key={c.scope}>
                <div class="settings-modal__pack-info">
                  <span class="settings-modal__pack-name">{auxTitle(c.scope)}</span>
                  <span class="settings-modal__pack-desc">{auxDesc(c.scope)}</span>
                  <span class="settings-modal__pack-meta">{formatBytes(c.sizeBytes)}</span>
                </div>
                <div class="settings-modal__pack-actions">
                  {updates.auxArmed.value === c.scope ? (
                    <HkButton
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        updates.auxArmed.value = null;
                        void runVerb(() => cacheStore.clearAuxCache(c.scope));
                      }}
                    >
                      {t("settings.cacheDeleteConfirm")}
                    </HkButton>
                  ) : (
                    <HkButton
                      variant="secondary"
                      size="sm"
                      disabled={c.sizeBytes === 0}
                      onClick={() => (updates.auxArmed.value = c.scope)}
                    >
                      {t("settings.cacheAuxClear")}
                    </HkButton>
                  )}
                </div>
              </div>
            ))}

            {/* ── AI runtime's technical facts ─────────────────────────────
                Rendered for EVERY build: the portable build compiles the AI
                feature out, yet an orphaned pack left by a full install can
                still be inspected and deleted from here. */}
            {aiKnown ? (
              <>
                <div class="settings-modal__res-subhead">{t("settings.resDetailsEnvTitle")}</div>
                <div class="settings-modal__pack">
                  <div class="settings-modal__pack-info">
                    <span class="settings-modal__pack-name">
                      {t("settings.resourcesAiInference")}
                    </span>
                    <span class="settings-modal__pack-desc">
                      {caps.aiInference
                        ? t("settings.resourcesAiAvailable")
                        : t("settings.resourcesAiUnavailableHint")}
                    </span>
                    {caps.directmlRequired ? (
                      <span class="settings-modal__pack-desc">
                        {caps.directmlPresent
                          ? t("settings.resourcesDirectMLPresent", {
                              size:
                                caps.directmlBytes != null
                                  ? formatBytes(caps.directmlBytes)
                                  : "—",
                            })
                          : t("settings.resourcesDirectMLMissing")}
                      </span>
                    ) : null}
                    {!caps.aiInference ? (
                      <p class="settings-modal__packs-banner">
                        {t("settings.resourcesAiUnavailable")}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div class="settings-modal__pack">
                  <div class="settings-modal__pack-info">
                    <span class="settings-modal__pack-name">
                      {t("settings.resourcesDecisionsName")}
                    </span>
                    <span class="settings-modal__pack-desc">
                      {t("settings.resourcesDecisionsDesc")}
                    </span>
                    <span class="settings-modal__pack-meta">
                      {!resources.decisionsChecked.value ? (
                        <LoadingNote inline text={t("settings.resourcesAiChecking")} />
                      ) : ai?.installed ? (
                        t("settings.resourcesAiChannelVersion", {
                          version: ai.version ?? "—",
                          seq: ai.seq ?? 0,
                        })
                      ) : resources.decisionsError.value && d == null ? (
                        t("settings.resourcesDecisionsUnknown")
                      ) : d?.present ? (
                        t("settings.resourcesAiChannelUnmanaged", {
                          size: formatBytes(d.sizeBytes),
                        })
                      ) : (
                        t("settings.resourcesDecisionsAbsent")
                      )}
                    </span>
                    {aiCheck ? (
                      <span class="settings-modal__pack-desc">
                        {aiCheck.updateAvailable
                          ? t("settings.resourcesAiChannelUpdateAvailable", {
                              version: aiCheck.latestVersion,
                              seq: aiCheck.latestSeq,
                              size: formatBytes(aiCheck.totalBytes),
                            })
                          : t("settings.resourcesAiChannelUpToDate", {
                              version: aiCheck.latestVersion,
                            })}
                      </span>
                    ) : null}
                    {aiCheck ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesAiChannelEndpoint", {
                          endpoint: aiEndpointHost,
                          count: aiCheck.files.length,
                        })}
                      </span>
                    ) : null}
                    {aiCheck?.losMismatch || ai?.losSkipped ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesAiChannelLosMismatch")}
                      </span>
                    ) : null}
                    {resources.aiError.value ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesAiChannelFailed")}
                      </span>
                    ) : null}
                    {!caps.aiInference ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesDecisionsUnavailable")}
                      </span>
                    ) : resources.decisionsChecked.value &&
                      !resources.decisionsError.value &&
                      !resources.decisionsCleared.value &&
                      !d?.present ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesDecisionsDemoInUse")}
                      </span>
                    ) : null}
                    {d?.present && d.adviceModelPresent ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesDecisionsAdviceInstalled", {
                          size: formatBytes(d.adviceModelBytes),
                        })}
                      </span>
                    ) : null}
                    {/* Torpedo slots: the T4 three-head model is preferred,
                        the legacy two-head slot is the fallback for older
                        packs. The report side shows N/A without either, so the
                        card reports ONE installed model's size. */}
                    {d?.present && d.torpedo4ModelPresent ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesDecisionsTorpedo4Installed", {
                          size: formatBytes(d.torpedo4ModelBytes),
                        })}
                      </span>
                    ) : d?.present && d.torpedoModelPresent ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesDecisionsTorpedoInstalled", {
                          size: formatBytes(d.torpedoModelBytes),
                        })}
                      </span>
                    ) : null}
                    {d?.present ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesDecisionsLos", {
                          count: d.losMaps.length,
                          maps:
                            d.losMaps.length > 0
                              ? `${d.losMaps.slice(0, 4).join(", ")}${
                                  d.losMaps.length > 4 ? "…" : ""
                                }`
                              : t("settings.resourcesDecisionsLosNone"),
                        })}
                      </span>
                    ) : null}
                    {/* The restart note matters MOST right after a delete
                        (the cleared models stay loaded until the next boot),
                        so it rides modelPresent OR the cleared flag. */}
                    {d?.modelPresent || resources.decisionsCleared.value ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesDecisionsRestart")}
                      </span>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}

            {/* ── destructive verbs ──────────────────────────────────────── */}
            {st?.present || d?.present ? (
              <>
                <div class="settings-modal__res-subhead">{t("settings.resDangerTitle")}</div>
                <HkSettingsHint>{t("settings.resDangerHint")}</HkSettingsHint>
                {st?.present ? (
                  <div class="settings-modal__pack">
                    <div class="settings-modal__pack-info">
                      <span class="settings-modal__pack-name">{t("settings.resPackName")}</span>
                      <span class="settings-modal__pack-meta">{formatBytes(st.sizeBytes)}</span>
                      {st.bundled ? (
                        <span class="settings-modal__pack-desc">
                          {t("settings.resBundledClearNote")}
                        </span>
                      ) : null}
                    </div>
                    <div class="settings-modal__pack-actions">
                      {updates.clearArmed.value === "res" ? (
                        <HkButton
                          variant="danger"
                          size="sm"
                          disabled={cacheStore.integrityChecking}
                          onClick={() => {
                            updates.clearArmed.value = null;
                            void runVerb(() => cacheStore.clearRes());
                          }}
                        >
                          {t("settings.cacheDeleteConfirm")}
                        </HkButton>
                      ) : (
                        <HkButton
                          variant="secondary"
                          size="sm"
                          disabled={cacheStore.integrityChecking}
                          onClick={() => (updates.clearArmed.value = "res")}
                        >
                          {t("settings.resDeletePack", { size: formatBytes(st.sizeBytes) })}
                        </HkButton>
                      )}
                    </div>
                  </div>
                ) : null}
                {d?.present ? (
                  <div class="settings-modal__pack">
                    <div class="settings-modal__pack-info">
                      <span class="settings-modal__pack-name">
                        {t("settings.resourcesDecisionsName")}
                      </span>
                      <span class="settings-modal__pack-meta">
                        {formatBytes(d.sizeBytes)}
                      </span>
                      {/* Loaded models stay resident until the restart. */}
                      <span class="settings-modal__pack-desc">
                        {t("settings.resourcesDecisionsRestart")}
                      </span>
                    </div>
                    <div class="settings-modal__pack-actions">
                      {resources.decisionsArmed.value ? (
                        <HkButton
                          variant="danger"
                          size="sm"
                          loading={resources.decisionsClearing.value}
                          onClick={() => void runVerb(() => resources.clearDecisions())}
                        >
                          {t("settings.cacheDeleteConfirm")}
                        </HkButton>
                      ) : (
                        <HkButton
                          variant="secondary"
                          size="sm"
                          onClick={() => (resources.decisionsArmed.value = true)}
                        >
                          {t("settings.resDeleteModels", { size: formatBytes(modelsBytes) })}
                        </HkButton>
                      )}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </HkExpansionPanel>
        </>
      );
    };
  },
});
