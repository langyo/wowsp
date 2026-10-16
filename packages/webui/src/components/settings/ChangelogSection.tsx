import { defineComponent, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";

import { HkButton, HkSettingsGroup, HkSettingsHint, HkSpinner } from "@celestia-island/hikari";

import { t, type Locale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { useChangelogStore } from "@/stores/changelog";
import ReleaseMarkdown from "./ReleaseMarkdown";
import "./ChangelogSection.scss";

/** One Intl formatter per visited locale (the list re-renders on locale
 *  switches; formatting dates is not the thing to redo per release). */
const dateFormatters = new Map<Locale, Intl.DateTimeFormat>();

function formatDate(locale: Locale, iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let fmt = dateFormatters.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
    dateFormatters.set(locale, fmt);
  }
  return fmt.format(date);
}

/**
 * ChangelogSection — the settings' 更新日志 pane. One article per GitHub
 * release (newest first, straight from `changelog_list`): a version chip
 * with a 当前 badge on the running build, the publish date, and the
 * release body through ReleaseMarkdown. The feed is fetched by the
 * section activators in SettingsBody (`ensureLoaded`); this component
 * only renders store state — its own button is the explicit refresh.
 */
export default defineComponent({
  name: "ChangelogSection",
  setup() {
    const changelog = useChangelogStore();
    const lang = useLanguage();
    const version = ref("");

    onMounted(async () => {
      // Running build, for the 当前 badge (browser dev keeps "" — no
      // badge; the version comparison simply never matches).
      try {
        version.value = await getVersion();
      } catch {
        // Browser dev mode — no Tauri runtime.
      }
    });

    return () => (
      <>
      <HkSettingsGroup>
        <div class="settings-modal__packs-head">
          <h2 class="hk-settings-group-title">{t("settings.changelog")}</h2>
          <HkButton
            size="sm"
            loading={changelog.loading}
            disabled={changelog.loading}
            onClick={() => void changelog.refresh()}
          >
            {t("settings.changelogRefresh")}
          </HkButton>
        </div>
        <HkSettingsHint>{t("settings.changelogHint")}</HkSettingsHint>
        {changelog.error && !changelog.releases.length ? (
          <div class="changelog__state">
            <p class="changelog__error">{t("settings.changelogFailed")}</p>
            <HkButton size="sm" onClick={() => void changelog.refresh()}>
              {t("common.retry")}
            </HkButton>
          </div>
        ) : changelog.loading && !changelog.releases.length ? (
          <div class="changelog__state">
            <HkSpinner size="sm" />
            <span class="changelog__state-text">{t("settings.changelogLoading")}</span>
          </div>
        ) : !changelog.releases.length ? (
          <p class="changelog__empty">{t("settings.changelogEmpty")}</p>
        ) : (
          <div class="changelog__list">
            {/* A failed refresh keeps the stale feed on screen — the
                error line rides above it instead of blanking the pane. */}
            {changelog.error ? (
              <p class="changelog__error">{t("settings.changelogFailed")}</p>
            ) : null}
            {changelog.releases.map((release) => (
              <article key={release.version} class="changelog__release">
                <header class="changelog__release-head">
                  <span class="changelog__release-version">v{release.version}</span>
                  {release.version === version.value ? (
                    <span class="changelog__current">{t("settings.changelogCurrent")}</span>
                  ) : null}
                  <span class="changelog__release-date">
                    {formatDate(lang.uiLocale.value, release.published_at)}
                  </span>
                </header>
                {release.body ? <ReleaseMarkdown source={release.body} /> : null}
              </article>
            ))}
          </div>
        )}
      </HkSettingsGroup>
      </>
    );
  },
});
