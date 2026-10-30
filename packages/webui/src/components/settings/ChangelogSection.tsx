import { defineComponent, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";

import { HkButton, HkSettingsGroup, HkSettingsHint, HkSpinner } from "@celestia-island/hikari";

import { t, type Locale } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { useChangelogStore } from "@/stores/changelog";
import ErrorCard from "@/components/base/ErrorCard";
import { selectReleaseBody } from "@/utils/releaseI18n";
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
      <HkSettingsGroup class={changelog.error && !changelog.releases.length ? "changelog__error-fill" : undefined}>
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
          /* Feed-fetch failure — the standard error card, FILL-seated: the
             group yields the rest of the pane to it and the card
             compresses its raw-details frame to fit (the 2026-10-30
             report: the un-filled card pushed the whole pane into a
             scroll). The stale-feed branch below stays in-flow — there is
             real content under the card there. */
          <ErrorCard
            fill
            error={changelog.error}
            description={t("settings.changelogFailed")}
            retry={() => void changelog.refresh()}
          />
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
                error card rides above it instead of blanking the pane;
                the header's refresh button is the retry. */}
            {changelog.error ? (
              <ErrorCard error={changelog.error} description={t("settings.changelogFailed")} />
            ) : null}
            {changelog.releases.map((release) => {
              // The i18n scaffold (AGENTS.md §10): render ONLY the running
              // locale's section, falling back to the en-US original with a
              // hint when the locale's section is missing or still the
              // pending placeholder. Legacy bodies render whole.
              const selected = selectReleaseBody(release.body, lang.uiLocale.value);
              return (
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
                  {selected.fallback ? (
                    <p class="changelog__i18n-fallback">{t("settings.changelogI18nFallback")}</p>
                  ) : null}
                  {selected.source ? <ReleaseMarkdown source={selected.source} /> : null}
                </article>
              );
            })}
          </div>
        )}
      </HkSettingsGroup>
      </>
    );
  },
});
