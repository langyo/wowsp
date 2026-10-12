/** Game-path settings section: install cards, the running-client fallback
 *  row and the add-path dialog (detection / native folder picker). */
import { defineComponent, type PropType } from "vue";
import { Check, FolderOpen, GripVertical, MonitorPlay, Plus, RefreshCw, Trash2 } from "@lucide/vue";
import {
  HkButton,
  HkModal,
  HkSettingsGroup,
  HkSettingsHint,
  HkTag,
  useToast,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { GameInstall } from "@/api";
import { useConfigStore } from "@/stores/config";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import PlatformIcon from "@/components/base/PlatformIcon";
import SortableList from "@/components/base/SortableList";
import { kindLabel } from "@/utils/installLabel";
import { sameGamePath } from "@/utils/gamePath";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";

export default defineComponent({
  name: "SettingsGamePathSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const configStore = useConfigStore();
    const pluginUpdates = usePluginUpdatesStore();
    const toast = useToast();
    const { gamePaths } = props.ctx;
    return () => (
          <>
          {/* game path — every known install (detected clients + manual pins)
              as a rich card mirroring the 账户 list: platform badge on the
              left, client + realm tag + path in the body; clicking a card
              activates it, which switches the app-wide client context
              (replay list, armor/ballistics loader, stats realm) and follows
              that realm's preferred account. Rows reorder by dragging each
              card's grip handle (the custom order survives rescans). Each
              card carries a two-step delete (arm → confirm, like the
              wallpaper strip) that removes the row and ignores it on future
              scans. A dashed add row at the end opens the dialog hosting
              detection and the native folder picker. Unreachable on the
              phone app build (the rail filters the section out). */}
          <HkSettingsGroup title={t("settings.gamePath")}>
            <HkSettingsHint>{t("common.gamePath.desc")}</HkSettingsHint>
            {gamePaths.installRows.value.length === 0 ? (
              <HkSettingsHint>{t("common.gamePath.noneFound")}</HkSettingsHint>
            ) : (
              // Rows reorder by dragging the card's grip handle; the custom
              // order is remembered by the config store (localStorage) and
              // re-applied on every scan.
              <SortableList
                class="settings-modal__installs"
                items={gamePaths.installRows.value}
                getKey={(i: GameInstall) => i.path}
                label={t("settings.gamePath")}
                onReorder={(from: number, to: number) => configStore.reorderInstalls(from, to)}
              >
                {(slot: { item: GameInstall }) => {
                  const i = slot.item;
                  const active = sameGamePath(i.path, gamePaths.activePath.value);
                  // The card is a button and buttons don't nest — the delete
                  // control lives on a positioned wrapper beside it (same
                  // structure as the wallpaper tiles).
                  return (
                    <div class="settings-modal__install">
                      <button
                        type="button"
                        class={["install-card", active ? "install-card--active" : ""]}
                        onClick={() => void gamePaths.activateInstall(i)}
                      >
                        <span
                          class="install-card__handle"
                          data-sortable-handle
                          aria-hidden="true"
                        >
                          <GripVertical size={14} />
                        </span>
                        <PlatformIcon kind={i.kind} size={38} />
                        <span class="install-card__body">
                          <span class="install-card__head">
                            <span class="install-card__name">{kindLabel(i.kind)}</span>
                            {i.realm ? (
                              <HkTag variant="default" size="sm">{i.realm.toUpperCase()}</HkTag>
                            ) : null}
                            {(pluginUpdates.infoFor(i.path)?.mods.length ?? 0) +
                              (pluginUpdates.infoFor(i.path)?.probeOutdated ? 1 : 0) > 0 ? (
                              <HkTag variant="warning" size="sm">
                                {t("resources.pluginUpdateBadge")}
                              </HkTag>
                            ) : null}
                            {active ? <Check size={12} class="install-card__check" /> : null}
                          </span>
                          <span class="install-card__path" title={i.path}>{i.path}</span>
                        </span>
                        {active ? (
                          <HkTag variant="success" size="sm">{t("common.gamePath.inUse")}</HkTag>
                        ) : null}
                      </button>
                      {sameGamePath(i.path, gamePaths.installArmed.value) ? (
                        <button
                          type="button"
                          autofocus
                          class="settings-modal__install-remove settings-modal__install-remove--confirm"
                          onClick={() => void gamePaths.removeInstall(i)}
                        >
                          {t("common.gamePath.removeConfirm")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          class="settings-modal__install-remove"
                          title={t("common.gamePath.removeAction")}
                          aria-label={t("common.gamePath.removeAction")}
                          onClick={() => (gamePaths.installArmed.value = i.path)}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  );
                }}
              </SortableList>
            )}
            {gamePaths.runningInstall.value ? (
              <div class="settings-modal__running">
                <MonitorPlay size={14} />
                <HkSettingsHint>
                  {t("common.gamePath.runningHint", { path: gamePaths.runningInstall.value.path })}
                </HkSettingsHint>
                <HkButton size="sm" variant="secondary" onClick={() => void gamePaths.useRunning()}>
                  {t("common.gamePath.useRunning")}
                </HkButton>
              </div>
            ) : null}
            {/* dashed add placeholder — the section's last row; opens the
                dialog with the detection / browse actions instead of an
                always-visible action row. */}
            <button type="button" class="settings-modal__install-add" onClick={() => gamePaths.openAddPath()}>
              <Plus size={14} /> {t("common.gamePath.addAction")}
            </button>
            {/* add-path dialog — re-detect installs or browse to a folder
                manually; closes as soon as detection finishes / a folder is
                actually applied (a cancelled picker or a failed scan keeps
                it open). */}
            <HkModal
              modelValue={gamePaths.addPathOpen.value}
              onUpdate:modelValue={(v: boolean) => (gamePaths.addPathOpen.value = v)}
              title={t("common.gamePath.addTitle")}
              width="26rem"
            >
              <HkSettingsHint>{t("common.gamePath.addDesc")}</HkSettingsHint>
              <div class="settings-modal__addpath-actions">
                <HkButton
                  variant="secondary"
                  loading={gamePaths.detecting.value}
                  onClick={async () => {
                    try {
                      await configStore.detect();
                      gamePaths.addPathOpen.value = false;
                    } catch (e) {
                      toast.error(`${(e as Error).message || e}`);
                    }
                  }}
                >
                  <RefreshCw size={14} /> {t("common.gamePath.redetect")}
                </HkButton>
                <HkButton
                  variant="secondary"
                  loading={gamePaths.pickingPath.value}
                  onClick={async () => {
                    const ok = await gamePaths.browseFolder();
                    if (ok) gamePaths.addPathOpen.value = false;
                  }}
                >
                  <FolderOpen size={14} /> {t("common.gamePath.browse")}
                </HkButton>
              </div>
            </HkModal>
          </HkSettingsGroup>

          </>
    );
  },
});
