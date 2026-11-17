import { defineComponent, nextTick, onMounted, onUnmounted, ref, watch, type VNodeRef } from "vue";
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
 * release (newest first, streamed from `changelog_list` in visible
 * batches): a version chip with a 当前 badge on the running build, the
 * publish date, and the release body through ReleaseMarkdown. The first
 * batch is fetched by the section activators in SettingsBody
 * (`ensureLoaded`); this component only renders store state — its own
 * button is the explicit refresh, and a scroll sentinel at the list's
 * tail keeps older releases streaming in as the user scrolls.
 *
 * Release translations ride the per-release release-notes-i18n asset
 * (AGENTS.md §10). Each card fetches its asset only when it nears the
 * viewport (one shared IntersectionObserver also drives the tail
 * sentinel), and the English body stays rendered in EVERY fetch state:
 * "loading" adds the translating row above it, "error" the failed row
 * with a retry chip, while the fallback hint is reserved for a genuinely
 * asset-less release / locale the asset does not carry. A failed fetch
 * therefore never reads as "this release has no translation"; the feed's
 * per-release notes_i18n flag decides whether there is an asset to fetch
 * at all, so an asset-less release settles straight to the English body
 * plus the fallback hint, with no command call and no spinner.
 */
export default defineComponent({
  name: "ChangelogSection",
  setup() {
    const changelog = useChangelogStore();
    const lang = useLanguage();
    const version = ref("");
    const sentinel = ref<HTMLElement | null>(null);
    /** Release versions whose card is near the viewport (recorded by the
     *  shared observer below) — the translation prefetch only ever runs
     *  for these. Retained once added: a refresh must re-request the cards
     *  the user has already revealed. */
    const visibleVersions = ref<Set<string>>(new Set());
    /** The version standing for each observed card, and the element
     *  currently standing for each version (both sides of the same
     *  registration, so a re-set/unmounted ref can unobserve its
     *  predecessor). */
    const articleVersions = new Map<Element, string>();
    const articleEls = new Map<string, Element>();
    /** Stable per-version ref callbacks: an inline arrow would be a new
     *  function on every render, making Vue unset and re-set the ref —
     *  and churn the shared observer — on every state transition. */
    const articleRefs = new Map<string, VNodeRef>();
    let observer: IntersectionObserver | null = null;
    let sentinelEl: Element | null = null;

    /** The ONE viewport observer: a card entry publishes its version for
     *  the translation prefetch; any other intersecting entry is the tail
     *  sentinel and streams the next batch. Created lazily so both card
     *  refs (set during the initial patch) and the sentinel watcher can
     *  reach it. Intersection against the implicit root already accounts
     *  for the settings pane's own scroll clipping (root null works
     *  inside the modal). */
    function ensureObserver(): IntersectionObserver | null {
      if (observer) return observer;
      if (typeof IntersectionObserver === "undefined") return null;
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const translationVersion = articleVersions.get(entry.target);
            if (translationVersion) {
              markVisible(translationVersion);
              continue;
            }
            void streamMore();
          }
        },
        { rootMargin: "200px 0px" },
      );
      return observer;
    }

    /** Add a version to the near-viewport set (a fresh Set so the prefetch
     *  watcher re-runs; a repeated report for a known version is a no-op). */
    function markVisible(translationVersion: string): void {
      if (visibleVersions.value.has(translationVersion)) return;
      visibleVersions.value = new Set(visibleVersions.value).add(translationVersion);
    }

    function unobserveArticle(translationVersion: string): void {
      const el = articleEls.get(translationVersion);
      if (!el) return;
      articleEls.delete(translationVersion);
      articleVersions.delete(el);
      try {
        observer?.unobserve(el);
      } catch {
        // A stub observer may refuse unknown targets; the maps are truth.
      }
    }

    /** Register (or, on ref unset/unmount, drop) one release card with
     *  the viewport watcher. Without an IntersectionObserver (old webview
     *  / a test environment providing none) every card in the batch
     *  counts as visible and is fetched eagerly — the ungated behavior. */
    function observeArticle(el: Element | null, translationVersion: string): void {
      unobserveArticle(translationVersion);
      if (!el) return;
      const io = ensureObserver();
      if (!io) {
        markVisible(translationVersion);
        return;
      }
      articleEls.set(translationVersion, el);
      articleVersions.set(el, translationVersion);
      io.observe(el);
    }

    function articleRef(translationVersion: string): VNodeRef {
      let handler = articleRefs.get(translationVersion);
      if (!handler) {
        handler = (el) => observeArticle(el as Element | null, translationVersion);
        articleRefs.set(translationVersion, handler);
      }
      return handler;
    }

    /** Keep the shared observer on the tail sentinel while the stream is
     *  armed — unobserve, never disconnect, so the cards stay watched. */
    function syncSentinel(): void {
      const wanted = sentinel.value && changelog.hasMore ? sentinel.value : null;
      if (sentinelEl && sentinelEl !== wanted) {
        try {
          observer?.unobserve(sentinelEl);
        } catch {
          // ignore — the previous target may be detached already
        }
        sentinelEl = null;
      }
      if (!wanted || sentinelEl === wanted) return;
      const io = ensureObserver();
      if (!io) return;
      sentinelEl = wanted;
      io.observe(wanted);
    }

    /** Lazy translation-asset fetch (AGENTS.md §10): request the
     *  release-notes-i18n asset for the releases whose cards are near the
     *  viewport, and only for a non-English UI locale (English renders
     *  the body itself). ensureTranslations is idempotent per release, so
     *  scrolls, locale switches and refresh re-requests stay cheap. The
     *  list's per-release notes_i18n flag rides along: a release the feed
     *  reports without the asset settles "missing" in the store with no
     *  command call (and therefore no spinner row). The visible set (and
     *  each card's ref callback) is retained for the component's lifetime
     *  ON PURPOSE: a refresh re-streams the same feed and must re-request
     *  the cards the user has already revealed. Entries for versions the
     *  current feed no longer carries are filtered out below instead of
     *  being pruned from the set. Keeping this out of the render path
     *  avoids a fetch side effect during render. */
    watch(
      [
        () => [...visibleVersions.value].join(","),
        // The feed itself — versions AND their notes_i18n flags. A refresh
        // bumps i18nEpoch before the new list lands, so without this source
        // the flag would be read from the STALE previous feed for one round.
        () =>
          changelog.releases
            .map((release) => release.version + (release.notes_i18n ? "n" : "m"))
            .join(","),
        () => lang.uiLocale.value,
        () => changelog.i18nEpoch,
      ],
      () => {
        if (lang.uiLocale.value === "en-US") return;
        const notesByVersion = new Map(
          changelog.releases.map((release) => [release.version, release.notes_i18n]),
        );
        for (const releaseVersion of visibleVersions.value) {
          const hasNotes = notesByVersion.get(releaseVersion);
          if (hasNotes === undefined) continue;
          void changelog.ensureTranslations(releaseVersion, hasNotes);
        }
      },
      { immediate: true },
    );

    /** One load triggered by the sentinel; after it lands, re-check the
     *  sentinel once — IntersectionObserver only fires on intersection
     *  CHANGES, so a batch too short to push the tail out of view would
     *  otherwise stall the stream until the next scroll. */
    function streamMore(): Promise<void> {
      if (!changelog.hasMore || changelog.loadingMore || changelog.loading || changelog.error) {
        return Promise.resolve();
      }
      return changelog.loadMore().then(rescan);
    }

    async function rescan() {
      await nextTick();
      const el = sentinel.value;
      if (!el || !changelog.hasMore || changelog.error) return;
      if (el.getBoundingClientRect().top <= window.innerHeight) void streamMore();
    }

    // The sentinel streams the next batch when it nears the viewport. The
    // observer is created here rather than in onMounted (the former home)
    // so the card refs set during the same initial patch share it; both
    // watchers stay inert when the environment provides no observer — the
    // tests drive the store directly.
    watch([sentinel, () => changelog.hasMore], syncSentinel, { immediate: true });

    onMounted(async () => {
      // Running build, for the 当前 badge (browser dev keeps "" — no
      // badge; the version comparison simply never matches).
      try {
        version.value = await getVersion();
      } catch {
        // Browser dev mode — no Tauri runtime.
      }
    });

    onUnmounted(() => {
      observer?.disconnect();
      observer = null;
      sentinelEl = null;
      articleEls.clear();
      articleVersions.clear();
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
              // The i18n model (AGENTS.md §10): the release BODY is English and
              // the seven translations ride the release-notes-i18n-<tag>.json
              // asset, fetched lazily per visible release (Rust changelog_i18n).
              // The body never hides: the English original stays rendered below
              // every fetch status, and the fallback hint only claims the
              // translation is absent when the asset really is (missing) or
              // lacks the locale / carries the 🚧 placeholder — which is what
              // selectReleaseBody answers: undefined = not asked yet (no hint),
              // {} = no asset (hint), a map = hint when the locale is missing.
              // A release the list reports without an asset (notes_i18n) is
              // already settled "missing" by the store, so it renders the
              // English body + hint and never grows a fetch status row.
              const state = changelog.translationStates[release.version];
              const translations =
                state?.status === "ready"
                  ? state.sections
                  : state?.status === "missing"
                    ? {}
                    : undefined;
              const selected = selectReleaseBody(
                release.body,
                lang.uiLocale.value,
                translations,
              );
              // Loading / failed fetches are NOT absences: the status row
              // explains those, and the fallback hint must not pre-empt it.
              const showFallbackHint =
                state?.status !== "loading" &&
                state?.status !== "error" &&
                selected.fallback;
              return (
                <article
                  key={release.version}
                  ref={articleRef(release.version)}
                  class="changelog__release"
                >
                  <header class="changelog__release-head">
                    <span class="changelog__release-version">v{release.version}</span>
                    {release.version === version.value ? (
                      <span class="changelog__current">{t("settings.changelogCurrent")}</span>
                    ) : null}
                    <span class="changelog__release-date">
                      {formatDate(lang.uiLocale.value, release.published_at)}
                    </span>
                  </header>
                  {state?.status === "loading" ? (
                    <div class="changelog__i18n-status">
                      <HkSpinner size="sm" />
                      <span class="changelog__state-text">
                        {t("settings.changelogTranslating")}
                      </span>
                    </div>
                  ) : state?.status === "error" ? (
                    <div class="changelog__i18n-status">
                      <span class="changelog__state-text">
                        {t("settings.changelogTranslateFailed")}
                      </span>
                      <HkButton
                        size="sm"
                        onClick={() =>
                          void changelog.retryTranslations(release.version, release.notes_i18n)
                        }
                      >
                        {t("common.retry")}
                      </HkButton>
                    </div>
                  ) : null}
                  {showFallbackHint ? (
                    <p class="changelog__i18n-fallback">{t("settings.changelogI18nFallback")}</p>
                  ) : null}
                  {selected.source ? <ReleaseMarkdown source={selected.source} /> : null}
                </article>
              );
            })}
            {changelog.loadingMore ? (
              <div class="changelog__more">
                <HkSpinner size="sm" />
                <span class="changelog__state-text">{t("settings.changelogLoadingMore")}</span>
              </div>
            ) : null}
            {!changelog.hasMore && !changelog.error ? (
              <p class="changelog__end">{t("settings.changelogEnd")}</p>
            ) : null}
            {changelog.hasMore ? <div ref={sentinel} class="changelog__sentinel" /> : null}
          </div>
        )}
      </HkSettingsGroup>
      </>
    );
  },
});
