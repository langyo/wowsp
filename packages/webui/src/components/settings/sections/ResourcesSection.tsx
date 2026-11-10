/** Resources settings section: the one place that lists every on-disk
 *  asset the app manages — game-client data (hot-updated ship data, the mod
 *  catalog and the auxiliary caches), baked model resources (the shared
 *  resource pack plus the decisions model/LOS pack), and the AI runtime the
 *  full installer carries.
 *
 *  The AI group is also the portable-build explanation: the 便捷版 compiles
 *  the `ai` feature out entirely, so inference/scoring surfaces are disabled
 *  with a pointer to the full installer instead of failing silently. */
import { defineComponent, type PropType } from "vue";
import { HkButton, HkSettingsGroup, HkSettingsHint, HkTag } from "@celestia-island/hikari";

import { t } from "@/i18n";
import ErrorCard from "@/components/base/ErrorCard";
import LoadingNote from "@/components/base/LoadingNote";
import { formatEta, formatLocalStamp, formatSpeed } from "@/utils/format";
import { isMobileApp } from "@/utils/platform";
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

export default defineComponent({
  name: "SettingsResourcesSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { updates, resources } = props.ctx;
    const cacheStore = updates.cacheStore;
    /** Display name for one registry row — existing per-resource keys
     *  where the cards below already name them, inventory-only keys
     *  otherwise (caches reuse the aux-cache titles). */
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
     *  keys). */
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
    return () => {
      const st = cacheStore.status;
      const upd = cacheStore.update;
      const prog = cacheStore.progress;
      const downloading =
        (st?.downloading ?? false) ||
        (prog != null &&
          (prog.phase === "download" ||
            prog.phase === "apply" ||
            prog.phase === "queued"));
      const pct =
        prog && prog.phase === "download" && prog.total > 0
          ? Math.min(100, Math.round((prog.received / prog.total) * 100))
          : 0;
      const d = resources.decisions.value;
      const ai = resources.aiStatus.value;
      const aiCheck = resources.aiCheck.value;
      const aiProg = resources.aiProgress.value;
      const aiPct =
        aiProg && aiProg.phase === "download" && aiProg.total > 0
          ? Math.min(100, Math.round((aiProg.received / aiProg.total) * 100))
          : 0;
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
      return (
          <>
          {/* ── Resource inventory (the registry walk) ─────────────────
              One line per runtime-managed resource, one GRID COLUMN per
              fact (name | size | version | updated | channel | kind — the
              subgrid keeps every row on the same shared axes). Stamps are
              normalized so a timestamp-shaped version renders as the same
              local wall clock the installed column uses, while semver /
              build ids / hash6 stay verbatim. The channel column localizes
              the registry's relay codes, and a fact with no content reads
              as the grey N/A placeholder (its tooltip says why) instead of
              a blank cell. The kind chip is the one fact EVERY row
              carries, so it always closes the row in the far-right column.
              Management actions stay in the groups below; the refresh
              button re-checks the refreshable lanes (data pack + res
              manifest — never auto-downloads). */}
          <HkSettingsGroup title={t("settings.resInvTitle")}>
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
            <HkButton
              variant="secondary"
              size="sm"
              loading={updates.inventoryBusy.value}
              onClick={() => void updates.refreshInventoryRow()}
            >
              {t("settings.resInvRefresh")}
            </HkButton>
          </HkSettingsGroup>

          {/* ── Game-client data ─────────────────────────────────────────── */}
          <HkSettingsGroup title={t("settings.resourcesGameTitle")}>
            <HkSettingsHint>{t("settings.resourcesGameHint")}</HkSettingsHint>
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">{t("settings.dataSourceShipData")}</span>
                <span class="settings-modal__pack-desc">{t("settings.dataSourceShipDataDesc")}</span>
                <span class="settings-modal__pack-meta">
                  {updates.dataPackVersion.value
                    ? `${t("settings.dataSourceVersion")}: ${formatLocalStamp(updates.dataPackVersion.value)}`
                    : t("settings.dataSourceBundled")}
                </span>
              </div>
              <div class="settings-modal__pack-actions">
                <HkButton
                  variant="secondary"
                  size="sm"
                  loading={updates.dataPackBusy.value}
                  onClick={() => void updates.refreshDataPackRow(true)}
                >
                  {t("settings.dataSourceRefresh")}
                </HkButton>
              </div>
            </div>
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">{t("settings.dataSourceModCatalog")}</span>
                <span class="settings-modal__pack-desc">{t("settings.dataSourceModCatalogDesc")}</span>
                <span class="settings-modal__pack-meta">
                  {updates.modCatalogStamp.value
                    ? `${t("settings.dataSourceModCatalogAt")}: ${formatLocalStamp(updates.modCatalogStamp.value)}`
                    : t("settings.dataSourceModCatalogNone")}
                </span>
              </div>
              <div class="settings-modal__pack-actions">
                <HkButton
                  variant="secondary"
                  size="sm"
                  loading={updates.modCatalogBusy.value}
                  onClick={() => void updates.refreshModCatalogRow(true)}
                >
                  {t("settings.dataSourceRefresh")}
                </HkButton>
              </div>
            </div>
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
                        void cacheStore.clearAuxCache(c.scope);
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
          </HkSettingsGroup>

          {/* ── Baked model resources ─────────────────────────────────────
              data-settings-anchor: the pack-update toast's glide target
              (settingsUi.show("resources", SETTINGS_ANCHOR_BAKED_MODELS)
              slides the pane onto this card, where the live progress bar
              lives). */}
          <HkSettingsGroup
            title={t("settings.resourcesBakedTitle")}
            data-settings-anchor={SETTINGS_ANCHOR_BAKED_MODELS}
          >
            <HkSettingsHint>{t("settings.resourcesBakedHint")}</HkSettingsHint>
            <div class="settings-modal__packs-head">
              <span class="settings-modal__pack-name">
                {t("settings.resPackTitle")}
                {cacheStore.anyUpdateAvailable ? (
                  /* Update availability reads as a compact tag beside the
                     title, not an inline banner paragraph. */
                  <>
                    {" "}
                    <HkTag size="sm" variant="warning">
                      {t("settings.cacheUpdateAvailable")}
                    </HkTag>
                  </>
                ) : null}
              </span>
              <HkButton
                size="sm"
                loading={cacheStore.updatesLoading}
                onClick={() => void cacheStore.checkUpdates()}
              >
                {t("settings.cacheCheckUpdates")}
              </HkButton>
            </div>
            <HkSettingsHint>
              {isMobileApp() ? t("settings.resPackMobileHint") : t("settings.resPackHint")}
            </HkSettingsHint>
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">{t("settings.resPackName")}</span>
                <span class="settings-modal__pack-desc">{t("settings.resPackDesc")}</span>
                <span class="settings-modal__pack-meta">
                  {st?.bundled
                    ? t("settings.resBundledInUse")
                    : st?.present
                      ? formatBytes(st.sizeBytes)
                      : t("settings.cacheStatusMissing")}
                  {" · "}
                  {t("settings.resCurrent")}
                  {": "}
                  {st?.legacyStamp ? t("settings.resLegacy") : hash6(st?.treeSha256)}
                  {st?.version && !st.legacyStamp ? ` · ${formatStamp(st.version)}` : ""}
                  {" · "}
                  {t("settings.resLatest")}
                  {": "}
                  {hash6(upd?.latestTreeSha256)}
                </span>
                {downloading ? (
                  <>
                    <div class="settings-modal__pack-progress">
                      <div
                        class="settings-modal__pack-progress-fill"
                        style={{ width: prog?.phase === "apply" ? "100%" : `${pct}%` }}
                      />
                    </div>
                    {prog &&
                    (prog.phase === "download" || prog.phase === "apply") &&
                    (prog.received > 0 || prog.total > 0 || prog.segments > 1) ? (
                      <span class="settings-modal__pack-desc">
                        {[
                          prog.total > 0
                            ? `${formatBytes(prog.received)} / ${formatBytes(prog.total)}`
                            : formatBytes(prog.received),
                          (cacheStore.speedBps ?? 0) > 0
                            ? formatSpeed(cacheStore.speedBps)
                            : null,
                          prog.phase === "download" &&
                          prog.total > prog.received &&
                          (cacheStore.speedBps ?? 0) > 0
                            ? t("settings.resEta", {
                                time: formatEta(
                                  (prog.total - prog.received) / (cacheStore.speedBps ?? 1),
                                ),
                              })
                            : null,
                          prog.segments > 1
                            ? t("settings.resSegment", {
                                current: prog.segment,
                                total: prog.segments,
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    ) : null}
                  </>
                ) : null}
                {prog?.phase === "error" && prog.error ? (
                  /* Download failure — the localized sentence as the card's
                     description, the raw backend message structured below. */
                  <ErrorCard
                    error={prog.error}
                    description={t("settings.cacheDownloadFailed")}
                  />
                ) : null}
                {st?.bundled && !downloading ? (
                  <span class="settings-modal__pack-desc">
                    {t("settings.resBundledClearNote")}
                  </span>
                ) : null}
              </div>
              <div class="settings-modal__pack-actions">
                {downloading ? (
                  prog?.phase === "apply" ? (
                    // The swap-based apply runs to completion (no cancel):
                    // a busy ring on a disabled button says so.
                    <HkButton size="sm" loading>
                      {t("settings.cacheApplying")}
                    </HkButton>
                  ) : (
                    <HkButton size="sm" onClick={() => void cacheStore.cancel()}>
                      {t("settings.cacheCancel")}
                    </HkButton>
                  )
                ) : st?.present ? (
                  <>
                    {updates.appUpdatePending.value ? (
                      /* App updates go first: the reason rides the disabled
                         buttons as a tag — data-hint carries the full
                         sentence (data-hint is the app's only tooltip
                         channel), not a paragraph banner. */
                      <span data-hint={t("settings.resAfterApp")}>
                        <HkTag size="sm" variant="warning">
                          {t("settings.resAfterAppTag")}
                        </HkTag>
                      </span>
                    ) : null}
                    {upd != null && !upd.updateAvailable && !st.bundled && !st.legacyStamp ? (
                      // Already current: the update slot becomes the
                      // integrity check — re-hash the tree on demand and
                      // repair via an automatic re-download when it drifted
                      // (see the store's verifyIntegrity). Hidden when the
                      // APK bundle serves (mobile) or the cache predates
                      // the hash scheme (nothing to compare against).
                      <HkButton
                        variant="secondary"
                        size="sm"
                        loading={cacheStore.integrityChecking}
                        onClick={() => void cacheStore.verifyIntegrity()}
                      >
                        {t("settings.resCheckIntegrity")}
                      </HkButton>
                    ) : (
                      <HkButton
                        variant="primary"
                        size="sm"
                        disabled={upd == null || !upd.updateAvailable || updates.appUpdatePending.value}
                        onClick={() => void cacheStore.download()}
                      >
                        {t("settings.cacheUpdate")}
                      </HkButton>
                    )}
                    {updates.clearArmed.value === "res" ? (
                      <HkButton
                        variant="danger"
                        size="sm"
                        disabled={cacheStore.integrityChecking}
                        onClick={() => {
                          updates.clearArmed.value = null;
                          void cacheStore.clearRes();
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
                        {t("settings.cacheDelete")}
                      </HkButton>
                    )}
                  </>
                ) : (
                  <HkButton
                    variant="primary"
                    size="sm"
                    disabled={updates.appUpdatePending.value}
                    onClick={() => void cacheStore.download()}
                  >
                    {t("settings.cacheDownload")}
                  </HkButton>
                )}
              </div>
            </div>

            {/* The AI model pack is published on Hugging Face and installed
                through the signed ai channel (commands/ai_pack.rs): the card
                shows the local stamp/inventory, checks the authenticated
                manifest (once per day on mount; the button forces it) and
                runs the install pass behind the download-progress bus. */}
            {!aiKnown ? null : (
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
                      /* Inline checking value: the ring rides beside the copy
                         — a stacked block would break the pack row's line. */
                      <LoadingNote
                        inline
                        text={t("settings.resourcesAiChecking")}
                      />
                    ) : ai?.installed ? (
                      t("settings.resourcesAiChannelVersion", {
                        version: ai.version ?? "—",
                        seq: ai.seq ?? 0,
                      })
                    ) : resources.decisionsError.value && d == null
                        ? t("settings.resourcesDecisionsUnknown")
                        : d?.present
                          ? t("settings.resourcesAiChannelUnmanaged", {
                              size: formatBytes(d.sizeBytes),
                            })
                          : t("settings.resourcesDecisionsAbsent")}
                  </span>
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
                  {resources.aiDownloading.value ? (
                    <div
                      class="settings-modal__pack-progress"
                      role="progressbar"
                      aria-valuenow={aiPct}
                    >
                      <div
                        class="settings-modal__pack-progress-fill"
                        style={{ width: `${aiPct}%` }}
                      />
                    </div>
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
                  {d?.modelPresent || resources.decisionsCleared.value ? (
                    <span class="settings-modal__pack-desc">
                      {t("settings.resourcesDecisionsRestart")}
                    </span>
                  ) : null}
                </div>
                <div class="settings-modal__pack-actions">
                  {caps.aiInference ? (
                    <>
                      <HkButton
                        variant="secondary"
                        size="sm"
                        loading={resources.aiChecking.value}
                        disabled={resources.aiDownloading.value}
                        onClick={() => void resources.checkAiUpdate()}
                      >
                        {t("settings.resourcesAiChannelCheck")}
                      </HkButton>
                      {resources.aiDownloading.value ? (
                        <HkButton
                          variant="secondary"
                          size="sm"
                          loading={resources.aiCanceling.value}
                          onClick={() => void resources.cancelAi()}
                        >
                          {t("settings.resourcesAiChannelCancel")}
                        </HkButton>
                      ) : (
                        <HkButton
                          variant="primary"
                          size="sm"
                          disabled={!aiCheck?.updateAvailable}
                          onClick={() => void resources.downloadAi()}
                        >
                          {d?.present
                            ? t("settings.resourcesAiChannelUpdate")
                            : t("settings.resourcesAiChannelDownload")}
                        </HkButton>
                      )}
                    </>
                  ) : null}
                  {d?.present ? (
                    resources.decisionsArmed.value ? (
                      <HkButton
                        variant="danger"
                        size="sm"
                        loading={resources.decisionsClearing.value}
                        onClick={() => void resources.clearDecisions()}
                      >
                        {t("settings.cacheDeleteConfirm")}
                      </HkButton>
                    ) : (
                      <HkButton
                        variant="secondary"
                        size="sm"
                        onClick={() => (resources.decisionsArmed.value = true)}
                      >
                        {t("settings.cacheDelete")}
                      </HkButton>
                    )
                  ) : null}
                </div>
              </div>
            )}
          </HkSettingsGroup>

          {/* ── AI runtime ──────────────────────────────────────────────── */}
          <HkSettingsGroup title={t("settings.resourcesAiTitle")}>
            <HkSettingsHint>{t("settings.resourcesAiHint")}</HkSettingsHint>
            {!aiKnown ? (
              /* Mid-check hint: the shared ring-above-text placeholder —
                 the copy arrives WITHOUT its ellipsis. */
              <HkSettingsHint>
                <LoadingNote text={t("settings.resourcesAiChecking")} />
              </HkSettingsHint>
            ) : !caps.aiInference ? (
              <p class="settings-modal__packs-banner">
                {t("settings.resourcesAiUnavailable")}
              </p>
            ) : null}
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">
                  {t("settings.resourcesAiInference")}
                </span>
                <span class="settings-modal__pack-desc">
                  {!aiKnown ? (
                    <LoadingNote
                      inline
                      text={t("settings.resourcesAiChecking")}
                    />
                  ) : caps.aiInference
                      ? t("settings.resourcesAiAvailable")
                      : t("settings.resourcesAiUnavailableHint")}
                </span>
              </div>
            </div>
            {caps.directmlRequired ? (
              <div class="settings-modal__pack">
                <div class="settings-modal__pack-info">
                  <span class="settings-modal__pack-name">
                    {t("settings.resourcesDirectML")}
                  </span>
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
                </div>
              </div>
            ) : null}
          </HkSettingsGroup>
          </>
      );
    };
  },
});
