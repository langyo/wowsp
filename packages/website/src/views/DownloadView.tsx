import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import {
  HardDriveDownload, Usb, Zap, Download, ExternalLink, FileDown, Monitor, Apple, Terminal, Check, Clock3,
} from "@lucide/vue";
import { HTag } from "@celestia-island/hikari";
import { LinkButton, Reveal } from "@/components/ui";
import "./DownloadView.scss";

const GITHUB = "https://github.com/langyo/wowsp";
const RELEASES = `${GITHUB}/releases/latest`;

export default defineComponent({
  name: "DownloadView",
  setup() {
    const { t } = useI18n();

    const modes = [
      { icon: HardDriveDownload, key: "modeInstall" },
      { icon: Usb, key: "modeUsb" },
      { icon: Zap, key: "modeGreen" },
    ] as const;

    const platforms = [
      { icon: Monitor, key: "win", ready: true },
      { icon: Apple, key: "mac", ready: false },
      { icon: Terminal, key: "linux", ready: false },
    ] as const;

    const assets = [
      { file: "WoWSP-0.1.0-x64-setup.exe", label: t("download.install") },
      { file: "WoWSP-0.1.0-x64-portable.exe", label: t("download.portable") },
      { file: "WoWSP-0.1.0-x64.msi", label: "MSI" },
      { file: "latest.json", label: "Update manifest" },
    ];

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
          </div>
        </section>

        {/* ── platforms ── */}
        <section class="download__platforms container">
          <div class="download__grid">
            {platforms.map((p, i) => {
              const Icon = p.icon;
              return (
                <Reveal delay={i * 80} key={p.key}>
                  <article class={["platform-card glass-panel", !p.ready ? "is-soon" : ""].join(" ")}>
                    <div class="platform-card__icon">
                      <Icon size={22} />
                    </div>
                    <h3>{t(`download.platform.${p.key}.name`)}</h3>
                    <p>{t(`download.platform.${p.key}.desc`)}</p>
                    {p.ready ? (
                      <span class="platform-card__status">
                        <HTag variant="success">
                          <Check size={11} />
                          {t("download.platform.ready")}
                        </HTag>
                        <a href={RELEASES} target="_blank" rel="noopener" class="platform-card__link">
                          {t("download.platform.get")}
                          <ExternalLink size={12} />
                        </a>
                      </span>
                    ) : (
                      <span class="platform-card__status">
                        <HTag variant="warning">
                          <Clock3 size={11} />
                          {t("download.platform.soon")}
                        </HTag>
                      </span>
                    )}
                  </article>
                </Reveal>
              );
            })}
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
            <h2>{t("download.assets")}</h2>
          </Reveal>
          <Reveal delay={80}>
            <ul class="download__list glass-panel">
              {assets.map((a) => (
                <li key={a.file}>
                  <a href={RELEASES} target="_blank" rel="noopener">
                    <span class="download__file">
                      <FileDown size={14} />
                      {a.file}
                    </span>
                    <span class="download__label">{a.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </Reveal>
          <p class="download__notes">{t("download.notes")}</p>
        </section>
      </div>
    );
  },
});
