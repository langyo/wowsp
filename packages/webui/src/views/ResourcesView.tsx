import { computed, defineComponent, onMounted, ref, watch } from "vue";
import {
  AlertTriangle,
  AudioLines,
  FolderSearch,
  ImageIcon,
  PackageCheck,
  Palette,
  Puzzle,
  RefreshCw,
  ScrollText,
} from "lucide-vue-next";

import { api, type InstalledMod, type ModKind, type PackagePlan } from "@/api";
import { useConfigStore } from "@/stores/config";
import { t } from "@/i18n";
import "./ResourcesView.scss";

const KIND_ORDER: ModKind[] = ["voice", "skin", "gui", "patch", "textures"];

/** lucide glyph + accent hue per plugin category. */
const KIND_META: Record<ModKind, { icon: typeof Puzzle; class: string }> = {
  voice: { icon: AudioLines, class: "voice" },
  skin: { icon: Palette, class: "skin" },
  gui: { icon: ImageIcon, class: "gui" },
  patch: { icon: ScrollText, class: "patch" },
  textures: { icon: PackageCheck, class: "textures" },
};

/**
 * Mod Hub (Resources page) — milestone M10 groundwork.
 *
 * Left-to-right flow: scan what is already installed under the latest
 * `bin/<version>/res_mods/`, browse it by category, then install an unpacked
 * package folder through the Rust classifier (see commands/mod_hub.rs) which
 * returns a typed install plan for confirmation before anything is written.
 */
export default defineComponent({
  name: "ResourcesView",
  setup() {
    const config = useConfigStore();

    const installed = ref<InstalledMod[]>([]);
    const scanning = ref(false);
    const filter = ref<"all" | ModKind>("all");

    const sourcePath = ref("");
    const analyzing = ref(false);
    const plan = ref<PackagePlan | null>(null);
    const planError = ref("");
    const installing = ref(false);
    const report = ref<{ name: string; count: number; version: string } | null>(null);

    const gameRoot = computed(() => config.activeInstall?.path ?? "");

    async function scan() {
      if (!gameRoot.value || scanning.value) return;
      scanning.value = true;
      try {
        installed.value = await api.modHubScanInstalled(gameRoot.value);
      } finally {
        scanning.value = false;
      }
    }

    async function analyze() {
      if (!sourcePath.value.trim() || analyzing.value) return;
      analyzing.value = true;
      plan.value = null;
      planError.value = "";
      report.value = null;
      try {
        plan.value = await api.modHubClassifyPath(sourcePath.value.trim());
      } catch (e) {
        planError.value = e instanceof Error ? e.message : String(e);
      } finally {
        analyzing.value = false;
      }
    }

    async function confirmInstall() {
      if (!plan.value || installing.value) return;
      installing.value = true;
      try {
        const r = await api.modHubInstall(sourcePath.value.trim(), gameRoot.value, plan.value);
        report.value = { name: r.name, count: r.wroteFiles, version: r.binVersion };
        plan.value = null;
        await scan();
      } catch (e) {
        planError.value = e instanceof Error ? e.message : String(e);
      } finally {
        installing.value = false;
      }
    }

    const byKind = computed(() => {
      const map = new Map<ModKind, number>();
      for (const m of installed.value) map.set(m.kind, (map.get(m.kind) ?? 0) + 1);
      return map;
    });

    const shown = computed(() =>
      filter.value === "all"
        ? installed.value
        : installed.value.filter((m) => m.kind === filter.value),
    );

    function kindLabel(kind: ModKind): string {
      return t(`resources.kind.${kind}`);
    }

    // The config store hydrates the active install asynchronously — rescan
    // once the game root shows up (the mount-time scan is a no-op before it).
    watch(gameRoot, (root) => {
      if (root && installed.value.length === 0) scan();
    });

    onMounted(scan);

    return () => (
      <div class="resources-view">
        <div class="resources-view__head">
          <h1 class="resources-view__title">{t("resources.title")}</h1>
          <button
            class="resources-view__rescan"
            disabled={!gameRoot.value || scanning.value}
            onClick={scan}
          >
            <RefreshCw size={14} class={scanning.value ? "spin" : undefined} />
            {scanning.value ? t("resources.scanning") : t("resources.scan")}
          </button>
        </div>
        <p class="resources-view__subtitle">{t("resources.subtitle")}</p>

        {!gameRoot.value && (
          <div class="resources-banner resources-banner--warn">
            <AlertTriangle size={16} />
            {t("resources.noGame")}
          </div>
        )}

        {/* ── Installed plugins, browsable by category ─────────────────── */}
        <section class="resources-section">
          <div class="resources-section__head">
            <Puzzle size={18} />
            <h2>{t("resources.installed")}</h2>
          </div>

          <div class="resources-chips">
            <button
              class={["chip", filter.value === "all" && "chip--on"]}
              onClick={() => (filter.value = "all")}
            >
              {t("resources.filterAll")} · {installed.value.length}
            </button>
            {KIND_ORDER.filter((k) => (byKind.value.get(k) ?? 0) > 0).map((k) => (
              <button
                key={k}
                class={["chip", filter.value === k && "chip--on"]}
                onClick={() => (filter.value = k)}
              >
                {kindLabel(k)} · {byKind.value.get(k)}
              </button>
            ))}
          </div>

          {shown.value.length === 0 ? (
            <div class="resources-section__placeholder">{t("resources.empty")}</div>
          ) : (
            <div class="mod-grid">
              {shown.value.map((m) => {
                const meta = KIND_META[m.kind];
                const Icon = meta.icon;
                return (
                  <div key={m.relPath + m.name} class={`mod-card mod-card--${meta.class}`}>
                    <Icon size={20} />
                    <div class="mod-card__body">
                      <div class="mod-card__name">{m.name}</div>
                      <div class="mod-card__kind">{kindLabel(m.kind)}</div>
                      {m.detail && <div class="mod-card__detail">{m.detail}</div>}
                      <div class="mod-card__path">{m.relPath}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Install from an unpacked folder via the classifier ───────── */}
        <section class="resources-section">
          <div class="resources-section__head">
            <FolderSearch size={18} />
            <h2>{t("resources.installSection")}</h2>
          </div>
          <p class="resources-section__desc">{t("resources.installHint")}</p>

          <div class="resources-installrow">
            <input
              type="text"
              v-model={sourcePath.value}
              placeholder={t("resources.pathPlaceholder")}
              spellcheck={false}
            />
            <button
              disabled={!sourcePath.value.trim() || analyzing.value || !gameRoot.value}
              onClick={analyze}
            >
              {analyzing.value ? t("resources.analyzing") : t("resources.browse")}
            </button>
          </div>

          {planError.value && (
            <div class="resources-banner resources-banner--error">{planError.value}</div>
          )}
          {report.value && (
            <div class="resources-banner resources-banner--ok">
              {t("resources.installedOk")
                .replace("{name}", report.value.name)
                .replace("{count}", String(report.value.count))
                .replace("{version}", report.value.version)}
            </div>
          )}

          {plan.value && (
            <div class={`plan-card plan-card--${KIND_META[plan.value.kind].class}`}>
              <div class="plan-card__head">
                {(() => {
                  const Icon = KIND_META[plan.value!.kind].icon;
                  return <Icon size={18} />;
                })()}
                <strong>{plan.value.name}</strong>
                <span class="plan-card__badge">{kindLabel(plan.value.kind)}</span>
                {plan.value.detail && (
                  <span class="plan-card__detail">{plan.value.detail}</span>
                )}
              </div>
              {plan.value.entries.length > 0 && (
                <table class="plan-card__files">
                  <caption>{t("resources.planFiles")}</caption>
                  <tbody>
                    {plan.value.entries.map((e) => (
                      <tr key={e.fromRel + e.toRel}>
                        <td>{e.fromRel === "." ? "." : `${e.fromRel}/`}</td>
                        <td>→</td>
                        <td>{e.toRel}/</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {plan.value.warnings.length > 0 && (
                <ul class="plan-card__warnings">
                  {plan.value.warnings.map((w) => (
                    <li key={w}>
                      <AlertTriangle size={12} /> {w}
                    </li>
                  ))}
                </ul>
              )}
              <button
                class="plan-card__go"
                disabled={installing.value}
                onClick={confirmInstall}
              >
                {installing.value ? t("resources.installing") : t("resources.confirmInstall")}
              </button>
            </div>
          )}
        </section>
      </div>
    );
  },
});
