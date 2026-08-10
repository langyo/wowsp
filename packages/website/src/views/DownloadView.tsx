import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { HardDriveDownload, Usb, Zap, Download, ExternalLink } from "lucide-vue-next";
import { useScrollReveal } from "@/composables/useScrollReveal";
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

    const assets = [
      { file: "WoWSP-0.1.0-x64-setup.exe", label: t("download.install") },
      { file: "WoWSP-0.1.0-x64-portable.exe", label: t("download.portable") },
      { file: "WoWSP-0.1.0-x64.msi", label: "MSI" },
      { file: "latest.json", label: "Update manifest" },
    ];

    const m1 = useScrollReveal(0);
    const m2 = useScrollReveal(100);
    const m3 = useScrollReveal(200);
    const modeReveals = [m1, m2, m3];

    return () => (
      <div class="download">
        <section class="download__head section-bg scanline-overlay">
          <div class="download__head-inner">
            <span class="accent-pill">03 · {t("download.title")}</span>
            <h1 class="download__title">
              <span class="gradient-text">{t("download.title")}</span>
            </h1>
            <p class="download__lede">{t("download.lede")}</p>
            <a href={RELEASES} target="_blank" rel="noopener" class="download__cta">
              <Download size={16} />
              {t("download.assets")}
              <ExternalLink size={12} />
            </a>
          </div>
        </section>

        <section class="download__modes">
          <div class="download__modes-head reveal is-visible">
            <h2>{t("download.modesTitle")}</h2>
          </div>
          <div class="download__grid">
            {modes.map((m, i) => {
              const Icon = m.icon;
              const r = modeReveals[i];
              return (
                <article
                  class={["mode-card industrial-card", r.cls()].join(" ")}
                  ref={r.setEl}
                  style={r.style()}
                  key={m.key}
                >
                  <div class="mode-card__icon">
                    <Icon size={24} />
                  </div>
                  <h3>{t(`download.${m.key}Title`)}</h3>
                  <p>{t(`download.${m.key}Desc`)}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section class="download__assets">
          <h2>{t("download.assets")}</h2>
          <ul class="download__list industrial-card">
            {assets.map((a) => (
              <li key={a.file}>
                <a href={RELEASES} target="_blank" rel="noopener">
                  <span class="download__file">{a.file}</span>
                  <span class="download__label">{a.label}</span>
                </a>
              </li>
            ))}
          </ul>
          <p class="download__notes">{t("download.notes")}</p>
        </section>
      </div>
    );
  },
});
