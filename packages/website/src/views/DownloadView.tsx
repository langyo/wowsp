import { defineComponent } from "vue";
import { useI18n } from "vue-i18n";
import { HardDriveDownload, Usb, Zap, Download } from "lucide-vue-next";
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
      { file: "WoWSP-0.1.0-x64-setup.exe", label: "Installer (NSIS)" },
      { file: "WoWSP-0.1.0-x64-portable.exe", label: "Portable / green" },
      { file: "WoWSP-0.1.0-x64.msi", label: "MSI" },
      { file: "latest.json", label: "Update manifest" },
    ];

    return () => (
      <div class="download">
        <section class="download__head">
          <h1>{t("download.title")}</h1>
          <p>{t("download.lede")}</p>
          <a href={RELEASES} target="_blank" rel="noopener" class="download__cta">
            <Download size={18} />
            {t("download.assets")}
          </a>
        </section>

        <section class="download__modes">
          <h2>{t("download.modesTitle")}</h2>
          <div class="download__grid">
            {modes.map((m) => {
              const Icon = m.icon;
              return (
                <article class="mode-card" key={m.key}>
                  <div class="mode-card__icon">
                    <Icon size={26} />
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
          <ul class="download__list">
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
