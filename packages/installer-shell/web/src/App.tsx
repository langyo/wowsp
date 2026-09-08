import { defineComponent, onMounted, ref } from "vue";
import { Box, CheckCircle2, Monitor, Usb } from "lucide-vue-next";
import {
  HAlert,
  HButton,
  HCheckbox,
  HMarkdownRenderer,
  HProgressBar,
  HSelectionGrid,
  HTimeline,
} from "@celestia-island/hikari";

import AppTitleBar from "./components/AppTitleBar";
import { invoke, listen, openDirectory } from "./tauri";

type Mode = "local" | "usb" | "green";
type Phase = "configure" | "installing" | "done";

const MODE_ITEMS = [
  { id: "local", title: "安装到本机", description: "标准单用户安装，含开始菜单快捷方式与自动更新。", badge: "推荐", icon: Monitor },
  { id: "usb", title: "U 盘（网吧模式）", description: "便携副本放在可移动磁盘上，无注册表项，数据全部留在盘内。", icon: Usb },
  { id: "green", title: "绿色版直接运行", description: "解压到指定文件夹独立运行，与本机安装完全隔离。", icon: Box },
];

const HINTS: Record<Mode, string> = {
  local: "数据写入 %APPDATA%，可自动更新；卸载信息会登记到系统。",
  usb: "检测到可移动磁盘时自动定位；否则回退到本机路径。",
  green: "默认解压到安装器旁边，可改为任意可写目录。",
};

interface DirDefaults { dir: string; removable: boolean }

export default defineComponent({
  name: "InstallerApp",
  setup() {
    const phase = ref<Phase>("configure");
    const mode = ref<Mode>("local");
    const dir = ref("");
    const hint = ref("");
    const progressStep = ref("");
    const progressPercent = ref<number | null>(null);
    const note = ref<{ text: string; kind: "ok" | "err" } | null>(null);

    async function refreshDefaults() {
      const defaults = await invoke<DirDefaults>("default_dir", { mode: mode.value });
      dir.value = defaults.dir;
      hint.value =
        mode.value === "usb" && defaults.removable
          ? "已检测到可移动磁盘。"
          : HINTS[mode.value];
    }

    onMounted(() => {
      refreshDefaults().catch((err) => { hint.value = String(err); });
      listen<{ step?: string }>("install-progress", (p) => {
        if (p.step) progressStep.value = p.step;
      });
    });

    async function selectMode(id: string | number | boolean | undefined) {
      if (phase.value !== "configure") return;
      mode.value = (id as Mode) ?? "local";
      await refreshDefaults().catch((err) => { hint.value = String(err); });
    }

    async function browse() {
      if (phase.value !== "configure") return;
      const picked = await openDirectory("选择安装位置");
      if (picked) dir.value = picked;
    }

    async function start() {
      if (phase.value !== "configure") return;
      phase.value = "installing";
      progressStep.value = "正在安装 WoWSP，这可能需要一点时间…";
      try {
        await invoke("start_install", { mode: mode.value, dir: dir.value.trim() });
        phase.value = "done";
      } catch (err) {
        phase.value = "configure";
        showNote(String(err), "err");
      }
    }

    return () => {
      const timelineSteps = STEPS.map((s) => ({ key: s.key, label: s.label }));
      const modeItems = MODE_ITEMS.map((m) => ({ ...m }));
      const configuring = phase.value === "configure";
      const installing = phase.value === "installing";
      const finished = phase.value === "done";

      return (
        <>
          <AppTitleBar icon="/logo.webp" title="WoWSP 安装器" showMaximize={false} />
          <main class="installer">
            <HTimeline
              steps={timelineSteps}
              currentKey={phase.value}
              orientation="horizontal"
            />

            {configuring && (
              <div class="wizard-body">
                <HSelectionGrid
                  items={modeItems}
                  selectedId={mode.value}
                  columns={3}
                  onSelect={(item: { id?: string | number | boolean }) => selectMode(item.id)}
                />
                <section class="installer__target">
                  <label class="installer__label" for="dir-input">安装位置</label>
                  <div class="installer__row">
                    <input
                      id="dir-input"
                      type="text"
                      spellcheck={false}
                      v-model={dir.value}
                    />
                    <HButton variant="ghost" onClick={browse}>浏览…</HButton>
                  </div>
                  <p class="installer__hint">{hint.value}</p>
                </section>
              </div>
            )}

            {installing && (
              <div class="wizard-center">
                <HProgressBar status="loading" size="md" />
                <p class="installer__step">{progressStep.value}</p>
              </div>
            )}

            {finished && (
              <div class="wizard-center">
                <HProgressBar status="done" size="md" />
                <p class="wizard-done-title">安装完成</p>
                <p class="wizard-done-path">{dir.value.trim()}</p>
                <p class="installer__hint">
                  {mode.value === "local"
                    ? "已登记到系统「应用」列表，可从设置或下方按钮卸载。"
                    : "便携副本已就绪，可从目标目录直接运行。"}
                </p>
              </div>
            )}

            <footer class="installer__footer">
              <p class="installer__hint">
                {configuring ? HINTS[mode.value] : ""}
              </p>
              <div class="installer__nav">
                {configuring && (
                  <HButton variant="primary" size="lg" onClick={start}>
                    开始安装
                  </HButton>
                )}
                {installing && (
                  <HButton variant="primary" size="lg" disabled>
                    安装中…
                  </HButton>
                )}
                {finished && (
                  <HButton variant="primary" size="lg" onClick={() => currentWindow()?.close()}>
                    完成
                  </HButton>
                )}
              </div>
            </footer>
          </main>
        </>
      );
    };
  },
});
