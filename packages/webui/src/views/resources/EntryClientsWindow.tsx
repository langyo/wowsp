/** The entry-clients window — the merged install tag's click-through:
 *  EVERY configured client in one list, each with its basic info (kind ·
 *  realm, path, the mod tree's total disk usage) and THIS entry's install
 *  state. Answers "installed where?" without leaving the detail pane. */
import { computed, defineComponent, ref, watch, type PropType } from "vue";
import { HardDrive, FolderOpen } from "@lucide/vue";
import { HkModal, HkScrollContainer } from "@celestia-island/hikari";

import { useConfigStore } from "@/stores/config";
import {
  api,
  type ClientUsage,
  type GameInstall,
  type ModInstallRecord,
} from "@/api";
import { formatBytes } from "@/components/settings/useSettingsUpdatesState";
import { t } from "@/i18n";
import { localized } from "./display";
import type { ModHubCtx } from "./useModHub";

interface ClientRow {
  install: GameInstall;
  record: ModInstallRecord | undefined;
  usage: ClientUsage | null;
  usageFailed: boolean;
}

export const EntryClientsWindow = defineComponent({
  name: "EntryClientsWindow",
  props: {
    ctx: { type: Object as PropType<ModHubCtx>, required: true },
  },
  setup(props) {
    const config = useConfigStore();
    const usageByPath = ref<Record<string, ClientUsage>>({});
    const failedPaths = ref<Record<string, boolean>>({});
    let fetchEpoch = 0;

    const entry = computed(() => props.ctx.entryClientsWindow.value.entry);
    const open = computed(() => props.ctx.entryClientsWindow.value.open);

    const rows = computed<ClientRow[]>(() => {
      const e = entry.value;
      if (!e) return [];
      return config.installs.map((install) => ({
        install,
        record: props.ctx.recordOfEntryOn(e, install.path),
        usage: usageByPath.value[install.path] ?? null,
        usageFailed: failedPaths.value[install.path] === true,
      }));
    });

    watch(open, (now) => {
      if (!now) return;
      // Stat-only walks per client — parallel, one epoch guard so a quick
      // close/open cannot let a stale pass write over the fresh one.
      const mine = ++fetchEpoch;
      for (const install of config.installs) {
        api.modHubClientUsage(install.path).then(
          (usage) => {
            if (mine !== fetchEpoch) return;
            usageByPath.value = { ...usageByPath.value, [install.path]: usage };
          },
          () => {
            if (mine !== fetchEpoch) return;
            failedPaths.value = { ...failedPaths.value, [install.path]: true };
          },
        );
      }
    });

    return () => {
      const e = entry.value;
      if (!e) return null;
      return (
        <HkModal
          modelValue={open.value}
          onUpdate:modelValue={(v: boolean) => (v ? null : props.ctx.closeEntryClients())}
          title={t("resources.entryClients.title", {
            name: (e && (localized(e).name || e.nameEn)) || "",
          })}
          width="44rem"
        >
          <HkScrollContainer class="entry-clients__scroll">
            <div class="entry-clients">
              {rows.value.map((row) => (
                <div key={row.install.path} class="entry-clients__client">
                  <div class="entry-clients__head">
                    <span class="entry-clients__label">
                      {props.ctx.clientLabelOf(row.install)}
                    </span>
                    {row.record ? (
                      <span class="entry-clients__state entry-clients__state--ok">
                        {t("resources.installedBadge")} · {row.record.version}
                      </span>
                    ) : (
                      <span class="entry-clients__state">
                        {t("resources.entryClients.notInstalled")}
                      </span>
                    )}
                  </div>
                  <div class="entry-clients__meta">
                    <span class="entry-clients__meta-item">
                      <FolderOpen size={12} />
                      <span class="entry-clients__path">{row.install.path}</span>
                    </span>
                    <span class="entry-clients__meta-item">
                      <HardDrive size={12} />
                      {row.usage
                        ? t("resources.entryClients.usage", {
                            size: formatBytes(row.usage.totalBytes),
                            files: row.usage.files,
                          })
                        : row.usageFailed
                          ? t("resources.entryClients.usageFailed")
                          : "…"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </HkScrollContainer>
        </HkModal>
      );
    };
  },
});

/** ResourcesView mounts one window for the view's lifetime. */
export function renderEntryClientsWindow(ctx: ModHubCtx) {
  return <EntryClientsWindow ctx={ctx} />;
}
