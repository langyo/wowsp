/** 缓存服务器 settings section (docs/en/designs/cache-mesh.md §6.3):
 *  the master mesh toggle, the ordered server ladder (official node
 *  pinned and locked, user rows add / two-step-remove / drag-reorder /
 *  per-row probe pills), test-all, the autodiscover toggle + discover-now
 *  preview, and the self-deploy hint card. Same pane on desktop and
 *  phone — the phone's Rust commands run the same transport hook. */
import { defineComponent, type PropType } from "vue";
import {
  HkButton,
  HkCardList,
  HkDraggableList,
  HkIconButton,
  HkInput,
  HkListRow,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkStatusPill,
  HkSwitch,
  HkTag,
} from "@celestia-island/hikari";
import { Check, ExternalLink, Radar, X } from "@lucide/vue";

import { t } from "@/i18n";
import { openExternal } from "@/utils/openExternal";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import "./CacheServersSection.scss";

/** The ops guide the self-deploy card links (route exists today; the full
 *  guide content lands with the server waves). */
const SELFHOST_GUIDE_URL = "https://wowsp.langyo.xyz/guides/self-host-gateway";

export default defineComponent({
  name: "SettingsCacheServersSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const cs = props.ctx.cacheServers;

    /** One row's reachability pill: "testing" while the probe call is in
     *  flight, the backend's verdict afterwards (an alive gateway-only
     *  node reads as its own state — lookup is the capability that
     *  matters here), untested before the first probe. */
    const renderPill = (url: string) => {
      const probe = cs.probeState.value[url];
      if (probe === "testing") {
        return <HkStatusPill state="unknown" label={t("cacheServers.probeTesting")} />;
      }
      if (probe) {
        if (!probe.ok) {
          return <HkStatusPill state="error" label={t("cacheServers.probeUnavailable")} />;
        }
        if (probe.capabilities && !probe.capabilities.lookup) {
          return <HkStatusPill state="error" label={t("cacheServers.probeNoLookup")} />;
        }
        return (
          <HkStatusPill state="ok" label={t("cacheServers.probeOk")} latencyMs={probe.latencyMs} />
        );
      }
      return <HkStatusPill state="unknown" label={t("cacheServers.probeUntested")} />;
    };

    /** One ladder row (the official row keeps its localized name, user
     *  rows show the bare host) with provenance chip + probe pill + (user
     *  rows only) the two-step remove control. */
    const renderRow = (url: string, kind: "official" | "user") => {
      const host = url.replace(/^https?:\/\//, "");
      const armed = kind === "user" && cs.removeArmed.value === url;
      const removeLabel = armed
        ? t("cacheServers.removeConfirm")
        : t("cacheServers.remove");
      return (
        <HkListRow
          title={kind === "official" ? t("cacheServers.officialRow") : host}
          subtitle={url}
          v-slots={{
            trailing: () => (
              <>
                <HkTag size="sm" variant={kind === "user" ? "primary" : "default"}>
                  {kind === "user"
                    ? t("cacheServers.userTag")
                    : t("cacheServers.officialTag")}
                </HkTag>
                {renderPill(url)}
                {kind === "user" ? (
                  /* Two-step delete (arm → confirm, the GamePathSection
                   * convention); data-hint is the app's tooltip channel. */
                  <span data-hint={removeLabel}>
                    <HkIconButton
                      size={24}
                      variant="ghost"
                      aria-label={removeLabel}
                      onClick={() => {
                        if (armed) void cs.removeServer(url);
                        else cs.removeArmed.value = url;
                      }}
                    >
                      {armed ? <Check size={14} /> : <X size={14} />}
                    </HkIconButton>
                  </span>
                ) : null}
              </>
            ),
          }}
        />
      );
    };

    /** The discover-now result line: the verified count plus the roots
     *  themselves (a list-only preview — nothing was auto-added). */
    const discoveredLine = () => {
      const urls = cs.discoveredUrls.value;
      if (!urls) return null;
      if (urls.length === 0) return t("cacheServers.discoveredNone");
      return t("cacheServers.discoveredCount", { count: urls.length }) + " (" + urls.join(", ") + ")";
    };

    return () => (
      <HkSettingsGroup>
        <div class="settings-modal__packs-head">
          <h2 class="hk-settings-group-title">{t("cacheServers.title")}</h2>
          <HkButton
            size="sm"
            loading={cs.probing.value}
            disabled={!cs.enabled.value}
            onClick={() => void cs.testAll()}
          >
            {t("cacheServers.testAll")}
          </HkButton>
        </div>
        {/* master switch — stats lookups try the mesh before the direct
            chain (a miss falls through unchanged, §6.2) */}
        <div class="stats-prefs">
          <div class="stats-prefs__row">
            <span class="stats-prefs__row-text">
              <span class="stats-prefs__row-label">{t("cacheServers.enable")}</span>
            </span>
            <HkSwitch
              modelValue={cs.enabled.value}
              onUpdate:modelValue={(value: boolean) => void cs.setEnabled(value)}
            />
          </div>
        </div>
        <HkSettingsHint>{t("cacheServers.hint")}</HkSettingsHint>
        {/* the ladder — official node pinned first (locked, always
            probed), then the user's own rows in saved order */}
        <HkCardList>
          {cs.rows.value[0] ? renderRow(cs.rows.value[0].url, "official") : null}
          <HkDraggableList
            class="settings-modal__cache-servers"
            items={cs.userServers.value.map((url) => ({ url, key: url }))}
            label={t("cacheServers.listTitle")}
            onReorder={(from: number, to: number) => {
              // The draggable list's indexes sit inside the user-rows
              // block (the official row is pinned outside it).
              void cs.reorderUser(from, to);
            }}
          >
            {{
              item: ({ item }: { item: { url: string; key: string } }) =>
                renderRow(item.url, "user"),
            }}
          </HkDraggableList>
        </HkCardList>
        {/* add row — https-gated (loopback http tolerated, the LAN-node
            exception the shell's sanitize holds) */}
        <div class="settings-modal__netmanual">
          <div class="settings-modal__netinput">
            <HkInput
              modelValue={cs.newServerDraft.value}
              onUpdate:modelValue={(v: string) => (cs.newServerDraft.value = v)}
              placeholder={t("cacheServers.addPlaceholder")}
              size="sm"
              spellcheck={false}
              submitOnEnter={() => void cs.addServer(cs.newServerDraft.value)}
            />
          </div>
          <HkButton
            size="sm"
            loading={cs.saving.value}
            disabled={cs.newServerDraft.value.trim().length === 0}
            onClick={() => void cs.addServer(cs.newServerDraft.value)}
          >
            {t("cacheServers.addButton")}
          </HkButton>
        </div>

        {/* autodiscover (§6.1) — community nodes from the official
            broadcast list ride AFTER the user's own list; the toggle is
            one click off, the disclosure says what it does */}
        <HkSettingsSub title={t("cacheServers.autodiscoverTitle")}>
          <div class="stats-prefs">
            <div class="stats-prefs__row">
              <span class="stats-prefs__row-text">
                <span class="stats-prefs__row-label">
                  {t("cacheServers.autodiscover")}
                </span>
              </span>
              <HkSwitch
                modelValue={cs.autodiscover.value}
                onUpdate:modelValue={(value: boolean) => void cs.setAutodiscover(value)}
              />
            </div>
          </div>
          <HkSettingsHint>{t("cacheServers.autodiscoverHint")}</HkSettingsHint>
          <div class="settings-modal__cache-discover">
            <HkButton
              size="sm"
              loading={cs.discovering.value}
              disabled={!cs.enabled.value}
              onClick={() => void cs.discoverNow()}
            >
              <Radar size={14} />
              {t("cacheServers.discoverNow")}
            </HkButton>
            {cs.discoveredUrls.value ? (
              <HkSettingsHint>{discoveredLine()}</HkSettingsHint>
            ) : null}
          </div>
        </HkSettingsSub>

        {/* self-deploy hint card — 战队/个人自部署 + the ops guide; the
            deployment matrix's Docker (native) and Vercel (edge) paths */}
        <HkSettingsSub title={t("cacheServers.selfhostTitle")}>
          <HkSettingsHint>{t("cacheServers.selfhostBody")}</HkSettingsHint>
          <HkSettingsHint>{t("cacheServers.selfhostPlatforms")}</HkSettingsHint>
          <div>
            <HkButton size="sm" onClick={() => void openExternal(SELFHOST_GUIDE_URL)}>
              <ExternalLink size={14} />
              {t("cacheServers.selfhostLink")}
            </HkButton>
          </div>
        </HkSettingsSub>
      </HkSettingsGroup>
    );
  },
});
