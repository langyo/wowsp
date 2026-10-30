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
import { HkButton, HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

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
  formatStamp,
  hash6,
} from "@/components/settings/useSettingsUpdatesState";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

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
      const caps = resources.capabilities;
      // The capability probe is async; render "checking" instead of a
      // misleading "portable build" banner during the first frame.
      const aiKnown = caps.loaded;
      const invRows = updates.resourceRows.value;
      return (
          <>
          {/* ── Resource inventory (the registry walk, read-only) ───────
              One line per runtime-managed resource: channel, kind, on-disk
              state. Management actions stay in the groups below. */}
          <HkSettingsGroup title={t("settings.resInvTitle")}>
            <HkSettingsHint>{t("settings.resInvHint")}</HkSettingsHint>
            {invRows ? (
              <ul class="settings-modal__res-inv">
                {invRows.map((row) => (
                  <li class="settings-modal__res-inv-row" key={row.id}>
                    <span class="settings-modal__res-inv-name">{rowName(row.id)}</span>
                    <span class="settings-modal__res-inv-meta">
                      {[
                        kindLabel(row.kind),
                        row.channel || "—",
                        row.sizeBytes > 0 ? formatBytes(row.sizeBytes) : null,
                        row.present
                          ? row.version ?? (row.sha256 ? hash6(row.sha256) : null)
                          : t("settings.cacheStatusMissing"),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
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
              <span class="settings-modal__pack-name">{t("settings.resPackTitle")}</span>
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
            {cacheStore.anyUpdateAvailable ? (
              <p class="settings-modal__packs-banner">{t("settings.cacheUpdateBanner")}</p>
            ) : null}
            {updates.appUpdatePending.value ? (
              <p class="settings-modal__packs-banner">{t("settings.resAfterApp")}</p>
            ) : null}
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

            {/* The decisions pack is installed out of band (no downloader);
                this row reports what is on disk and offers a clear. */}
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
                    ) : resources.decisionsError.value && d == null
                        ? t("settings.resourcesDecisionsUnknown")
                        : d?.present
                          ? `${formatBytes(d.sizeBytes)} · ${
                              d.modelPresent
                                ? t("settings.resourcesDecisionsModelInstalled", {
                                    size: formatBytes(d.modelBytes),
                                  })
                                : t("settings.resourcesDecisionsModelMissing")
                            }`
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
