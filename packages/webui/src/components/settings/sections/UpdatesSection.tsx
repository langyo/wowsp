/** Updates settings section: the app-binary card and the GitHub mirror
 *  ladder. The resource pack, baked decision pack and dynamic game-data
 *  caches moved to the dedicated Resources section so every on-disk asset
 *  is managed in one place. */
import { defineComponent, type PropType } from "vue";
import {
  HkButton,
  HkCardList,
  HkIconButton,
  HkInput,
  HkListRow,
  HkSettingsGroup,
  HkSettingsHint,
  HkStatusPill,
  HkTag,
} from "@celestia-island/hikari";
import { X } from "@lucide/vue";

import { t } from "@/i18n";
import { isMobileApp } from "@/utils/platform";
import type { MirrorListRow } from "@/components/settings/useSettingsUpdatesState";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

export default defineComponent({
  name: "SettingsUpdatesSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { updates } = props.ctx;
    const updater = updates.updater;

    /** One row's per-prefix reachability pill: "testing" while the probe
     *  call is in flight, the backend's verdict afterwards, untested
     *  before the first probe. */
    const renderPill = (prefix: string) => {
      const probe = updates.probeState.value[prefix];
      if (probe === "testing") {
        return <HkStatusPill state="unknown" label={t("settings.mirrorTesting")} />;
      }
      if (probe) {
        return probe.ok ? (
          <HkStatusPill
            state="ok"
            label={t("settings.mirrorOk")}
            latencyMs={probe.elapsedMs}
          />
        ) : (
          <HkStatusPill state="error" label={t("settings.mirrorUnavailable")} />
        );
      }
      return <HkStatusPill state="unknown" label={t("settings.mirrorUntested")} />;
    };

    /** One ladder row: the direct endpoint first, then the built-in
     *  mirrors, then the user's custom prefixes — host as the title (the
     *  official row keeps its localized name), full prefix as the
     *  subtitle, built-in/custom chip + status pill + (user rows only)
     *  the remove control in the trailing slot. */
    const renderRow = (row: MirrorListRow) => {
      const title =
        row.kind === "official"
          ? t("settings.mirrorOfficialRow")
          : row.prefix.replace(/^https:\/\//, "");
      return (
        <HkListRow
          key={row.prefix}
          title={title}
          subtitle={row.prefix}
          v-slots={{
            trailing: () => (
              <>
                {row.kind !== "official" ? (
                  /* The direct route is no mirror — only the built-in and
                     custom rows carry a provenance chip. */
                  <HkTag size="sm" variant={row.kind === "user" ? "primary" : "default"}>
                    {row.kind === "user"
                      ? t("settings.mirrorCustomTag")
                      : t("settings.mirrorBuiltInTag")}
                  </HkTag>
                ) : null}
                {renderPill(row.prefix)}
                {row.kind === "user" ? (
                  /* data-hint is the app's only tooltip channel (see
                     composables/globalTooltip) — the icon-only button
                     names itself through aria-label. */
                  <span data-hint={t("settings.mirrorRemove")}>
                    <HkIconButton
                      size={24}
                      variant="ghost"
                      aria-label={t("settings.mirrorRemove")}
                      onClick={() => void updates.removeMirror(row.prefix)}
                    >
                      <X size={14} />
                    </HkIconButton>
                  </span>
                ) : null}
              </>
            ),
          }}
        />
      );
    };

    return () => (
          <>
          {/* updates — the app-binary card and the GitHub mirror ladder for
              mainland networks. APP UPDATES GO FIRST: while a newer build
              is pending the resource pack's buttons are disabled on the
              Resources section and its hint says so — the pack update
              follows after the restart. The phone app build ships through
              the store pipeline — its app-binary card is dropped entirely
              (checks are also silenced at the shell). */}
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
                  /* Check failure reads as a compact tag, not an inline
                     error block — the raw message rides the toast the
                     explicit check raises (the startup auto-check is quiet). */
                  <HkStatusPill state="error" label={t("settings.updatesCheckFailedTag")} />
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
              <h2 class="hk-settings-group-title">{t("settings.cacheMirrorTitle")}</h2>
              <HkButton
                size="sm"
                loading={updates.probing.value}
                onClick={() => void updates.probeMirrors()}
              >
                {t("settings.mirrorTestAll")}
              </HkButton>
            </div>
            <HkSettingsHint>{t("settings.cacheMirrorHint")}</HkSettingsHint>
            <HkCardList>{updates.mirrorRows.value.map(renderRow)}</HkCardList>
            <div class="settings-modal__netmanual">
              <div class="settings-modal__netinput">
                <HkInput
                  modelValue={updates.newMirrorDraft.value}
                  onUpdate:modelValue={(v: string) => (updates.newMirrorDraft.value = v)}
                  placeholder={t("settings.mirrorAddPlaceholder")}
                  size="sm"
                  spellcheck={false}
                  submitOnEnter={() => void updates.addMirror(updates.newMirrorDraft.value)}
                />
              </div>
              <HkButton
                size="sm"
                loading={updates.mirrorSaving.value}
                disabled={!updates.newMirrorDraft.value.startsWith("https://")}
                onClick={() => void updates.addMirror(updates.newMirrorDraft.value)}
              >
                {t("settings.mirrorAdd")}
              </HkButton>
            </div>
          </HkSettingsGroup>
          </>
    );
  },
});
