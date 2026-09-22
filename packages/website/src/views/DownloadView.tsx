import { computed, defineComponent, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  HardDriveDownload, Usb, Download, ExternalLink, FileDown, Check, Zap,
} from "@lucide/vue";
import { LinkButton, Reveal } from "@/components/ui";
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
    // failure (fallback link to the Releases page).
    const release = ref<LatestRelease | null>(null);
    const phase = ref<"loading" | "ready" | "failed">("loading");
    onMounted(async () => {
      const hit = await fetchLatestRelease();
      if (hit) {
        release.value = hit.release;
        mirrorPrefix.value = hit.prefix;
        phase.value = "ready";
      } else {
        phase.value = "failed";
      }
    });

    function assetLabel(name: string): string {
      if (/\.msi$/.test(name)) return "MSI";
      return /webview2/.test(name) ? t("download.assetInstallerWv2") : t("download.assetInstaller");
    }

    const modes = [
      { icon: HardDriveDownload, key: "modeInstall" },
      { icon: Usb, key: "modeUsb" },
    ] as const;

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

        {/* ── modes ── */}
        <section class="download__modes container">
          <Reveal class="download__modes-head">
            <h2>{t("download.modesTitle")}</h2>
          </Reveal>
          <div class="download__grid">
            {modes.map((m, i) => {
              const Icon = m.icon;
              return (
                <Reveal delay={i * 90} key={m.key}>
                  <article class="mode-card glass-panel is-interactive">
                    <div class="mode-card__icon">
                      <Icon size={22} />
                    </div>
                    <h3>{t(`download.${m.key}Title`)}</h3>
                    <p>{t(`download.${m.key}Desc`)}</p>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </section>

        {/* ── assets ── */}
        <section class="download__assets container">
          <Reveal>
            <div class="download__assets-head">
              <h2>{t("download.assets")}</h2>
              {/* Hidden when the official route served the release info
               * (and on a failed fetch, when only the Releases-page link
               * remains): the note only ever names a mirror in use. */}
              {phase.value === "ready" && mirrorPrefix.value && (
                <span
                  class="accent-pill download__mirror"
                  title={mirrorPrefix.value}
                >
                  <Zap size={12} />
                  {t("download.mirrorNote", { host: mirrorHost.value })}
                </span>
              )}
            </div>
          </Reveal>
          <Reveal delay={80}>
            <ul class="download__list glass-panel">
              {phase.value === "ready" && release.value
                ? release.value.assets.map((a) => (
                  <li key={a.name}>
                    <a href={mirrorPrefix.value + a.url} target="_blank" rel="noopener">
                      <span class="download__file">
                        <FileDown size={14} />
                        {a.name}
                      </span>
                      <span class="download__label">
                        {assetLabel(a.name)}
                        {a.size ? ` · ${formatSize(a.size)}` : ""}
                      </span>
                    </a>
                  </li>
                ))
                : phase.value === "loading" ? (
                  <li class="download__placeholder">{t("download.loading")}</li>
                ) : (
                  <li>
                    <a href={RELEASES} target="_blank" rel="noopener">
                      <span class="download__file">
                        <FileDown size={14} />
                        GitHub Releases
                      </span>
                      <span class="download__label">{t("download.loadFailed")}</span>
                    </a>
                  </li>
                )}
            </ul>
          </Reveal>
          <p class="download__notes">{t("download.notes")}</p>
        </section>
      </div>
    );
  },
});
