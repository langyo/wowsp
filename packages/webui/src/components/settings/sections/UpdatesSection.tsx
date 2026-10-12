/** Updates settings section: app-binary card, the resource-pack card, the
 *  GitHub mirror source and the clearable data sources / aux caches. */
import { defineComponent, type PropType } from "vue";
import { HkButton, HkInput, HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { formatEta, formatSpeed } from "@/utils/format";
import { isMobileApp } from "@/utils/platform";
import {
  auxDesc,
  auxTitle,
  formatBytes,
  formatStamp,
  hash6,
} from "@/components/settings/useSettingsUpdatesState";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

export default defineComponent({
  name: "SettingsUpdatesSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { updates } = props.ctx;
    const cacheStore = updates.cacheStore;
    const updater = updates.updater;
    return () => (
          <>
          {/* updates — the app-binary card and the single content-addressed
              resource-pack card (download / update / delete with live
              progress), the GitHub mirror source for mainland networks, and
              clearable auxiliary caches. APP UPDATES GO FIRST: while a
              newer build is pending the pack's buttons are disabled and the
              hint says so — the pack update follows after the restart.
              Pack versions are content tree hashes shown as their last 6
              hex chars; an outdated pack offers the retained chain patches
              (incremental) or falls back to the full archive. The phone app
              build ships through the store pipeline — its app-binary card
              is dropped entirely (checks are also silenced at the shell). */}
          {!isMobileApp() ? (
          <HkSettingsGroup>
            <div class="settings-modal__packs-head">
              <h2 class="hk-settings-group-title">{t("settings.updatesAppTitle")}</h2>
              <HkButton
                size="sm"
                loading={updater.checking}
                disabled={updater.portable}
                onClick={() => void updater.check()}
              >
                {t("settings.cacheCheckUpdates")}
              </HkButton>
            </div>
            <HkSettingsHint>{t("settings.updatesAppHint")}</HkSettingsHint>
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">{t("settings.updatesAppName")}</span>
                <span class="settings-modal__pack-desc">{t("settings.updatesAppDesc")}</span>
                <span class="settings-modal__pack-meta">
                  {t("settings.updatesCurrent")}: {updater.current || "—"}
                  {" · "}
                  {t("settings.updatesLatest")}
                  {": "}
                  {updater.available ? (updater.version ?? "—") : t("settings.updatesUpToDate")}
                </span>
                {updater.running ? (
                  <span class="settings-modal__pack-update">{updater.statusText}</span>
                ) : null}
                {updater.error ? (
                  <span class="settings-modal__pack-error">{updater.error}</span>
                ) : null}
              </div>
              <div class="settings-modal__pack-actions">
                {updater.portable ? (
                  <HkSettingsHint>{t("settings.updatesPortable")}</HkSettingsHint>
                ) : updater.available ? (
                  <HkButton
                    variant="primary"
                    size="sm"
                    disabled={updater.running}
                    onClick={() => void updater.downloadAndInstall()}
                  >
                    {t("settings.updatesAppNow")}
                  </HkButton>
                ) : null}
              </div>
            </div>
          </HkSettingsGroup>
          ) : null}
          <HkSettingsGroup>
            <div class="settings-modal__packs-head">
              <h2 class="hk-settings-group-title">{t("settings.resPackTitle")}</h2>
              <HkButton
                size="sm"
                loading={cacheStore.updatesLoading}
                onClick={() => void cacheStore.refreshUpdates()}
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
            {(() => {
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
              const deltaSteps = upd?.deltaSteps;
              return (
                <div class="settings-modal__pack">
                  <div class="settings-modal__pack-info">
                    <span class="settings-modal__pack-name">{t("settings.resPackName")}</span>
                    <span class="settings-modal__pack-desc">{t("settings.resPackDesc")}</span>
                    <span class="settings-modal__pack-meta">
                      {st?.bundled
                        ? // Phone build, bundle serving: identity comes from
                          // the APK manifest; there is no cache size to show.
                          t("settings.resBundledInUse")
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
                    {upd?.updateAvailable && !downloading ? (
                      <span class="settings-modal__pack-update">
                        {deltaSteps == null
                          ? t("settings.cacheUpdateAvailable")
                          : deltaSteps.length > 0
                            ? t("settings.resDeltaAvailable", { n: deltaSteps.length })
                            : t("settings.resFullDownload")}
                      </span>
                    ) : null}
                    {downloading ? (
                      <>
                        <div class="settings-modal__pack-progress">
                          <div
                            class="settings-modal__pack-progress-fill"
                            style={{ width: prog?.phase === "apply" ? "100%" : `${pct}%` }}
                          />
                        </div>
                        {/* Live readout under the track: bytes moved (over
                            the whole pass — cumulative across delta
                            segments), smoothed speed, ETA, and the segment
                            position. Never render text inside the 3px
                            __pack-progress track itself — its
                            overflow:hidden clips any content placed there.
                            Hidden entirely when nothing is known yet (the
                            full-install apply event carries all-zero
                            counters — the full-width bar says it all). */}
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
                      <span class="settings-modal__pack-error">
                        {t("settings.cacheDownloadFailed")}: {prog.error}
                      </span>
                    ) : null}
                    {st?.bundled && !downloading ? (
                      <span class="settings-modal__pack-desc">
                        {t("settings.resBundledClearNote")}
                      </span>
                    ) : null}
                  </div>
                  <div class="settings-modal__pack-actions">
                    {downloading ? (
                      <HkButton size="sm" onClick={() => void cacheStore.cancel()}>
                        {prog?.phase === "apply"
                          ? t("settings.cacheApplying")
                          : t("settings.cacheCancel")}
                      </HkButton>
                    ) : st?.present ? (
                      <>
                        <HkButton
                          variant="primary"
                          size="sm"
                          disabled={upd == null || !upd.updateAvailable || updates.appUpdatePending.value}
                          onClick={() => void cacheStore.download()}
                        >
                          {t("settings.cacheUpdate")}
                        </HkButton>
                        {updates.clearArmed.value === "res" ? (
                          <HkButton
                            variant="danger"
                            size="sm"
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
              );
            })()}
          </HkSettingsGroup>
          <HkSettingsGroup title={t("settings.cacheMirrorTitle")}>
            <HkSettingsHint>{t("settings.cacheMirrorHint")}</HkSettingsHint>
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HkInput
                  modelValue={updates.mirrorDraft.value}
                  onUpdate:modelValue={(v: string) => (updates.mirrorDraft.value = v)}
                  placeholder={t("settings.cacheMirrorPlaceholder")}
                  submitOnEnter={() => void updates.saveMirror()}
                />
              </div>
              <HkButton size="sm" disabled={!updates.mirrorDirty.value} onClick={() => void updates.saveMirror()}>
                {updates.mirrorSavedFlash.value
                  ? t("settings.networkSaved")
                  : t("settings.networkSave")}
              </HkButton>
            </div>
            <div class="settings-modal__mirror-presets">
              <button
                type="button"
                class="settings-modal__mirror-preset"
                onClick={() => (updates.mirrorDraft.value = "")}
              >
                {t("settings.cacheMirrorDirect")}
              </button>
              {updates.MIRROR_PRESETS.map((m) => (
                <button
                  type="button"
                  key={m}
                  class="settings-modal__mirror-preset"
                  onClick={() => (updates.mirrorDraft.value = m)}
                >
                  {m.replace("https://", "")}
                </button>
              ))}
            </div>
          </HkSettingsGroup>
          <HkSettingsGroup title={t("settings.dataSourcesTitle")}>
            <HkSettingsHint>{t("settings.dataSourcesHint")}</HkSettingsHint>
            <div class="settings-modal__pack">
              <div class="settings-modal__pack-info">
                <span class="settings-modal__pack-name">{t("settings.dataSourceShipData")}</span>
                <span class="settings-modal__pack-desc">{t("settings.dataSourceShipDataDesc")}</span>
                <span class="settings-modal__pack-meta">
                  {updates.dataPackVersion.value
                    ? `${t("settings.dataSourceVersion")}: ${updates.dataPackVersion.value.replace("T", " ").slice(0, 16)}`
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
                    ? `${t("settings.dataSourceModCatalogAt")}: ${updates.modCatalogStamp.value.replace("T", " ").slice(0, 16)}`
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

          </>
    );
  },
});
