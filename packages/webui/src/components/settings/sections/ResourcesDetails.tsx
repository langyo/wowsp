/** The resources pane's details body: the registry walk's audit table,
 *  the per-cache controls, the AI runtime's technical facts and the
 *  destructive deletes.
 *
 *  ONE tree, TWO shells — the section renders this body inside a collapsed
 *  HkExpansionPanel on desktop and inside a docked HkModal sheet under the
 *  phone-layout breakpoint, so both surfaces show the same facts and can
 *  never drift apart. The body reads the shared SettingsBodyCtx directly
 *  (the same stores the family rows read), and every management verb
 *  re-walks the registry through the same runVerb contract as the rows, so
 *  the status card's footprint stays honest for verbs started here too.
 */
import { defineComponent, type PropType } from "vue";
import { HkButton, HkSettingsHint, HkTag } from "@celestia-island/hikari";

import { t } from "@/i18n";
import LoadingNote from "@/components/base/LoadingNote";
import { formatLocalStamp } from "@/utils/format";
import { isMobileApp } from "@/utils/platform";
import {
  auxDesc,
  auxTitle,
  formatBytes,
  formatResourceVersion,
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
  name: "SettingsResourcesDetails",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { updates, resources } = props.ctx;
    const cacheStore = updates.cacheStore;

    /** The pack's raw current/latest hash line — the same derivation the
     *  status card's chip tooltips. */
    const packHashHint = updates.packHashHint;

    /** Display name for one registry row — existing per-resource keys where
     *  the cards name them, inventory-only keys otherwise (caches reuse the
     *  aux-cache titles). */
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
      const aiKnown = caps.loaded;
      const invRows = updates.resourceRows.value;
      const modelsBytes = d?.present ? d.sizeBytes : 0;
      return (
        <>
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
                        void updates.runVerb(() => cacheStore.clearAuxCache(c.scope));
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
                            void updates.runVerb(() => cacheStore.clearRes());
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
                          onClick={() => void updates.runVerb(() => resources.clearDecisions())}
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
        </>
      );
    };
  },
});
