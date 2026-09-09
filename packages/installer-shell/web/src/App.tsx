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

/**
 * Installer shell UI — an NSIS-style delivery wizard rendered entirely with
 * hikari components. Everything shown is generated from the shun
 * configuration declared in the shell crate's Cargo.toml
 * (`[package.metadata.shun]`) and served by the `get_config` command:
 * product identity, delivery modes, the license page (markdown through
 * HMarkdownRenderer), the timeline orientation (top rail or left rail),
 * theme mode, accent palette, and UI language (eight locales).
 */

type Mode = "local" | "usb" | "green";
type Phase = "configure" | "installing" | "done";

interface ProductIdentity {
  name: string;
  version: string;
  publisher?: string;
  logo?: string;
}

interface DirDefaults {
  dir: string;
  removable: boolean;
}

interface ShellView {
  product: ProductIdentity;
  modes: Mode[];
  timeline?: "top" | "left";
  theme?: { mode?: "system" | "light" | "dark"; accent?: [number, number, number] };
  language?: string;
  flash: boolean;
}

interface ProgressEvent {
  phase?: "download" | "extract" | "register";
  step?: string;
  percent?: number | null;
}

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

const STEPS: { key: Phase; label: string }[] = [
  { key: "configure", label: "配置" },
  { key: "installing", label: "安装" },
  { key: "done", label: "完成" },
];

export default defineComponent({
  name: "InstallerApp",
  setup() {
    const phase = ref<Phase>("configure");
    const mode = ref<Mode>("local");
    const dir = ref("");
    const hint = ref("");
    const progressStep = ref("");
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
        await invoke("start_install", {
          mode: mode.value,
          dir: dir.value.trim(),
        });
        phase.value = "done";
      } catch (err) {
        phase.value = "configure";
        showNote(String(err), "err");
      }
    }

    function showNote(text: string, kind: "ok" | "err" = "ok") {
      note.value = { text, kind };
    }

    return () => {
      const configuring = phase.value === "configure";
      const installing = phase.value === "installing";
      const finished = phase.value === "done";

      return (
        <>
          <AppTitleBar icon="/logo.webp" title="WoWSP 安装器" showMaximize={false} />
          <main class="installer">
            {configuring && (
              <>
                <section class="wizard-hero">
                  <h1>选择 WoWSP 的安装方式</h1>
                  <p class="wizard-sub">选择此副本的安装方式及其数据存放位置。</p>
                </section>

                <HSelectionGrid
                  items={MODE_ITEMS}
                  selectedId={mode.value}
                  columns={3}
                  onSelect={(item: { id?: string | number | boolean }) => {
                    if (phase.value !== "configure") return;
                    mode.value = (item.id as Mode) ?? "local";
                    void refreshDefaults().catch(() => {});
                  }}
                />

                <section class="wizard-target">
                  <label class="wizard-target__label" for="dir-input">安装位置</label>
                  <div class="wizard-target__row">
                    <input
                      id="dir-input"
                      type="text"
                      spellcheck={false}
                      v-model={dir.value}
                    />
                    <HButton variant="ghost" onClick={browse}>浏览…</HButton>
                  </div>
                  <p class="wizard-target__hint">{HINTS[mode.value]}</p>
                </section>
              </>
            )}

            {installing && (
              <section class="wizard-center">
                <img src="/logo.webp" alt="" class="wizard-logo" />
                <p class="wizard-product">WoWSP</p>
                <HProgressBar status="loading" size="md" />
                <p class="wizard-step">{progressStep.value}</p>
              </section>
            )}

            {finished && (
              <div class="wizard-center">
                <CheckCircle2
                  size={56}
                  color="rgb(var(--color-success))"
                  stroke-width={1.5}
                />
                <p class="wizard-done-title">安装完成</p>
                <p class="wizard-done-path">{dir.value.trim()}</p>
                {mode.value === "local" && (
                  <p class="wizard-done-hint">
                    WoWSP 已登记到系统「应用」列表，可从开始菜单启动。
                  </p>
                )}
                {mode.value === "green" && (
                  <p class="wizard-done-hint">
                    便携副本已就绪，可从目标目录直接运行。
                  </p>
                )}
              </div>
            )}

            <footer class="installer__footer">
              <p class={`installer__note ${note.value ? `installer__note--${note.value.kind}` : ""}`}>
                {configuring && HINTS[mode.value]}
                {installing && progressStep.value}
                {finished && `✔ 安装完成：${dir.value.trim()}`}
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

function currentWindow() {
  return (window as unknown as {
    __TAURI__?: { window?: { getCurrentWindow?: () => {
      minimize(): Promise<void>;
      close(): Promise<void>;
    } } };
  }).__TAURI__?.window?.getCurrentWindow?.() ?? null;
}
