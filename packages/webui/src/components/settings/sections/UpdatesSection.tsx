/** Updates settings section: the app-binary card and the GitHub mirror
 *  source. The resource pack, baked decision pack and dynamic game-data
 *  caches moved to the dedicated Resources section so every on-disk asset
 *  is managed in one place. */
import { defineComponent, type PropType } from "vue";
import { HkButton, HkInput, HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { isMobileApp } from "@/utils/platform";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

export default defineComponent({
  name: "SettingsUpdatesSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const { updates } = props.ctx;
    const updater = updates.updater;
    return () => (
          <>
          {/* updates — the app-binary card and the GitHub mirror source for
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
          </>
    );
  },
});
