import { computed, defineComponent, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  HardDriveDownload, Usb, Download, ExternalLink, FileDown, Check, Zap,
  ChevronRight, MessageCircle,
} from "@lucide/vue";
import { LinkButton, Reveal } from "@/components/ui";
import { siteBase } from "@/composables/siteBase";
import "./DownloadView.scss";

const GITHUB = "https://github.com/langyo/wowsp";
const RELEASES = `${GITHUB}/releases/latest`;
const API_LATEST = "https://api.github.com/repos/langyo/wowsp/releases/latest";
const API_LIST = "https://api.github.com/repos/langyo/wowsp/releases?per_page=10";

/* GitHub is commonly unreachable from mainland China. Every GitHub request
 * rotates through the official endpoint first, then these ghproxy-style
 * prefixes (the official URL appended verbatim) until one answers — the
 * same ladder the desktop app walks, see
 * packages/app/tauri/src/commands/github_mirror.rs. No configuration. */
const MIRROR_PREFIXES = [
  "https://ghp.ci/",
  "https://gh-proxy.com/",
  "https://ghfast.top/",
  "https://ghproxy.net/",
];

/* QQ notification group — the same group the desktop app's About panel and
 * the repo README point at. `qm.qq.com/q/<share-code>` is QQ's direct join
 * link: opening it hands off to QQ (or the web join page) with the group
 * already loaded, so nobody has to search a group number by hand. The
 * group's file list also carries every installer — the fallback when GitHub
 * is slow or unreachable — and release/fix news is announced there too. */
const QQ_GROUP = "612331811";
const QQ_JOIN = "https://qm.qq.com/q/ExDBBawuLC";

interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
}

interface LatestRelease {
  tag: string;
  assets: ReleaseAsset[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/* Installers only. The `releases/latest` endpoint is shared with the
 * res-latest / mod-hub rolling releases (model packs, mod zips): when one
 * of those was published more recently it takes over the endpoint, so the
 * tag is verified to be a versioned app tag (v…) and the list endpoint is
 * the fallback for finding the newest v-tagged release. */
function pickRelease(v: unknown): LatestRelease | null {
  if (!isRecord(v)) return null;
  const tag = str(v.tag_name);
  if (!tag || !/^v\d/.test(tag) || !Array.isArray(v.assets)) return null;
  const assets: ReleaseAsset[] = [];
  for (const raw of v.assets) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name);
    const url = str(raw.browser_download_url);
    if (!name || !url || !/\.(exe|msi)$/.test(name)) continue;
    assets.push({ name, size: typeof raw.size === "number" ? raw.size : 0, url });
  }
  return assets.length ? { tag, assets } : null;
}

async function ghJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? (res.json() as Promise<unknown>) : null;
  } catch {
    return null;
  }
}

/* Walks the official-first mirror ladder until an endpoint answers.
 * Returns the payload plus the prefix that served it ("" = official) —
 * that same prefix is then applied to the asset download links, so the
 * route proven working for the API carries the downloads too. */
async function ghJsonRotating(
  path: string,
): Promise<{ data: unknown; prefix: string } | null> {
  for (const prefix of ["", ...MIRROR_PREFIXES]) {
    const data = await ghJson(prefix + path);
    if (data !== null) return { data, prefix };
  }
  return null;
}

async function fetchLatestRelease(): Promise<{
  release: LatestRelease;
  prefix: string;
} | null> {
  // `releases/latest` first; the list endpoint is the fallback for the
  // rolling res-latest / mod-hub releases taking the endpoint over.
  for (const path of [API_LATEST, API_LIST]) {
    const hit = await ghJsonRotating(path);
    if (!hit) continue;
    const rows = Array.isArray(hit.data) ? hit.data : [hit.data];
    for (const row of rows) {
      const parsed = pickRelease(row);
      if (parsed) return { release: parsed, prefix: hit.prefix };
    }
  }
  return null;
}

/* Last rung of the ladder: a slimmed releases snapshot baked into the
 * site at deploy time (site.yml writes it via `gh api`). When GitHub
 * and every mirror are all unreachable — the norm on some mainland
 * networks, and what rate-limit exhaustion looks like too — the page
 * still shows a real version with real links, one deploy behind at
 * worst (version bumps touch packages/website, so every release wave
 * redeploys the site and refreshes the snapshot). */
async function fetchBakedRelease(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(`${siteBase}latest-release.json`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const rows = Array.isArray(data) ? data : [data];
    for (const row of rows) {
      const parsed = pickRelease(row);
      if (parsed) return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export default defineComponent({
  name: "DownloadView",
  setup() {
    const { t } = useI18n();

    // The mirror prefix that served the release info ("" = official).
    // Asset links ride the same route; the pill below the assets heading
    // names the mirror whenever one had to step in.
    const mirrorPrefix = ref("");
    const mirrorHost = computed(() => {
      try {
        return new URL(mirrorPrefix.value).host;
      } catch {
        return mirrorPrefix.value;
      }
    });

    // Latest release — fetched live so version numbers never go stale.
    // `phase` keeps the pending fetch (placeholder row) apart from a real
    // failure (every card falls back to the Releases page).
    const release = ref<LatestRelease | null>(null);
    const phase = ref<"loading" | "ready" | "failed">("loading");
    onMounted(async () => {
      const hit = await fetchLatestRelease();
      if (hit) {
        release.value = hit.release;
        mirrorPrefix.value = hit.prefix;
        phase.value = "ready";
        return;
      }
      // Live lookup failed everywhere: same-origin deploy-time snapshot
      // before giving up ("" prefix = links go straight to GitHub).
      const baked = await fetchBakedRelease();
      if (baked) {
        release.value = baked;
        phase.value = "ready";
      } else {
        phase.value = "failed";
      }
    });

    // The three published flavors, resolved against the latest release's
    // assets. The raw file names never reach the page: a card carries an
    // internationalized title + audience description, and its button
    // downloads the matching asset directly. The legacy bare-name alias
    // (the desktop updater's bridge) and every unrecognized asset stay
    // invisible — novices see exactly three choices. `label` is the
    // capitalized i18n key suffix (flavor<Label>Title / Desc).
    const FLAVORS = [
      { key: "online", label: "Online", icon: Zap },
      { key: "offline", label: "Offline", icon: HardDriveDownload },
      { key: "portable", label: "Portable", icon: Usb },
    ] as const;

    type FlavorKey = (typeof FLAVORS)[number]["key"];

    function flavorOf(name: string): FlavorKey | null {
      if (/x64-installer-lite\.exe$/.test(name)) return "online";
      if (/x64-installer-webview2\.exe$/.test(name)) return "offline";
      if (/x64-portable\.exe$/.test(name)) return "portable";
      return null;
    }

    // Always one card per flavor. A resolved asset rides the mirror that
    // served the release info; a missing asset (the latest release
    // predates the artifact) or a failed fetch falls back to the Releases
    // page — so every button stays clickable either way.
    const flavorCards = computed(() =>
      FLAVORS.map((flavor) => {
        const asset = release.value?.assets.find(
          (a) => flavorOf(a.name) === flavor.key,
        );
        return {
          key: flavor.key,
          label: flavor.label,
          icon: flavor.icon,
          href: asset ? mirrorPrefix.value + asset.url : RELEASES,
          size: asset?.size ?? 0,
        };
      }),
    );

    return () => (
      <div class="download">
        {/* ── head ── */}
        <section class="download__head">
          <div class="aurora" />
          <div class="container download__head-inner">
            <Reveal>
              <h1 class="download__title">{t("download.title")}</h1>
            </Reveal>
            <Reveal delay={100}>
              <p class="download__lede">{t("download.lede")}</p>
            </Reveal>
            <Reveal delay={200}>
              <LinkButton size="lg" href={RELEASES} external>
                <Download size={17} />
                {t("download.assets")}
                <ExternalLink size={13} />
              </LinkButton>
            </Reveal>
            {/* Below the CTA on purpose: arriving late, the badge only
             * grows the section's bottom edge — the button never moves. */}
            {release.value && (
              <Reveal delay={260}>
                <span class="accent-pill download__version">
                  <Check size={12} />
                  {t("download.latest")} · {release.value.tag}
                </span>
              </Reveal>
            )}
          </div>
        </section>

        {/* ── flavors ── */}
        <section class="download__assets container">
          <Reveal>
            <div class="download__assets-head">
              <h2>{t("download.flavorsTitle")}</h2>
              {/* Hidden when the official route served the release info,
               * or when the fetch failed (every button then targets the
               * Releases page): the note only ever names a mirror in use. */}
              {phase.value === "ready" && mirrorPrefix.value && (
                <span
                  class="accent-pill download__mirror"
                  title={mirrorPrefix.value}
                >
                  <Zap size={12} />
                  {t("download.mirrorNote", { host: mirrorHost.value })}
                </span>
              )}
              {/* A failed fetch never blocks the cards — every button
               * opens the Releases page instead — but say so up front. */}
              {phase.value === "failed" && (
                <span class="download__notice">{t("download.loadFailed")}</span>
              )}
            </div>
          </Reveal>
          <Reveal delay={80}>
            {phase.value === "loading" ? (
              <ul class="download__list glass-panel">
                <li class="download__placeholder">{t("download.loading")}</li>
              </ul>
            ) : (
              <div class="download__flavors">
                {flavorCards.value.map((card, i) => {
                  const Icon = card.icon;
                  return (
                    <Reveal delay={i * 90} key={card.key}>
                      <article
                        class={`flavor-card glass-panel${card.key === "online" ? " is-recommended" : ""}`}
                      >
                        {card.key === "online" && (
                          <span class="flavor-card__badge">
                            <Zap size={11} />
                            {t("download.flavorRecommendedBadge")}
                          </span>
                        )}
                        <div class="flavor-card__icon">
                          <Icon size={22} />
                        </div>
                        <h3>{t(`download.flavor${card.label}Title`)}</h3>
                        <p>{t(`download.flavor${card.label}Desc`)}</p>
                        {card.size ? (
                          <span class="flavor-card__meta">
                            ≈ {formatSize(card.size)}
                          </span>
                        ) : null}
                        <LinkButton href={card.href} external>
                          <FileDown size={15} />
                          {t("download.flavorDownload")}
                        </LinkButton>
                      </article>
                    </Reveal>
                  );
                })}
              </div>
            )}
          </Reveal>
          <p class="download__notes">{t("download.notes")}</p>
          {/* ── QQ notification group ─────────────────────────────
           * The community row under the installer cards. The whole row is
           * one anchor to QQ's direct join link, so a click anywhere joins
           * the group and there is no nested button for the keyboard to
           * tab into. Its file list mirrors every installer (the fallback
           * when GitHub is slow or unreachable); release news and fixes
           * are announced there too. */}
          <Reveal delay={140}>
            <a
              class="download__qq glass-panel"
              href={QQ_JOIN}
              target="_blank"
              rel="noopener"
            >
              <span class="download__qq-icon" aria-hidden="true">
                <MessageCircle size={20} />
              </span>
              <span class="download__qq-body">
                <span class="download__qq-title">
                  {t("download.qqTitle", { n: QQ_GROUP })}
                </span>
                <span class="download__qq-desc">{t("download.qqDesc")}</span>
              </span>
              <span class="download__qq-cta hk-btn hk-btn-primary hk-btn-md">
                {t("download.qqJoin")}
                <ChevronRight size={14} />
              </span>
            </a>
          </Reveal>
        </section>
      </div>
    );
  },
});
