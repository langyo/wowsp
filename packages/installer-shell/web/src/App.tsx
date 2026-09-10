import { defineComponent, onMounted, ref } from "vue";
import { Box, CheckCircle2, FolderOpen, Monitor, Usb } from "lucide-vue-next";
import {
  HAlert,
  HButton,
  HCheckbox,
  HProgressBar,
  HSelectionGrid,
  HTimeline,
} from "@celestia-island/hikari";

import AppTitleBar from "./components/AppTitleBar";
import { invoke, listen, openDirectory } from "./tauri";
import licenseText from "../../../../LICENSE?raw";

/**
 * Installer shell UI — a step-driven delivery wizard rendered with hikari
 * components: a left step rail (mode → license → install → done), centered
 * panes, the bundled SySL 1.0 license agreement, and a desktop-shortcut
 * toggle. The license text is the repository's LICENSE document, inlined at
 * build time through Vite's ?raw import.
 */

type Mode = "local" | "usb" | "green";
type StepKey = "mode" | "license" | "install" | "done";

interface DirDefaults {
  dir: string;
  removable: boolean;
}

interface FlowEventPayload {
  phase?: string;
  step?: string;
  percent?: number | null;
  message?: string;
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

const STEPS: { key: StepKey; label: string }[] = [
  { key: "mode", label: "安装方式" },
  { key: "license", label: "用户协议" },
  { key: "install", label: "安装" },
  { key: "done", label: "完成" },
];

export default defineComponent({
  name: "InstallerApp",
  setup() {
    // `?step=` preview hook (static previews / dev); production passes no
    // query and starts at the mode pane.
    const initialStep = (new URLSearchParams(window.location.search).get(
      "step",
    ) ?? "") as StepKey;
    const step = ref<StepKey>(
      STEPS.some((s) => s.key === initialStep) ? initialStep : "mode",
    );
    const mode = ref<Mode>("local");
    const dir = ref("");
    const hint = ref("");
    const agreed = ref(false);
    const desktop = ref(true);
    const overall = ref<number | null>(null);
    const flowStep = ref("");
    const installFailed = ref(false);
    const failMessage = ref("");
    const note = ref<{ text: string; kind: "ok" | "err" } | null>(null);

    const running = ref(false);

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
      listen<FlowEventPayload>("install-progress", (event) => {
        if (event.step) flowStep.value = event.step;
        if (event.percent != null) overall.value = Math.round(event.percent);
        if (event.message) {
          installFailed.value = true;
          failMessage.value = event.message;
        }
      });
    });

    function go(next: StepKey) {
      step.value = next;
      if (next === "install") {
        running.value = true;
        installFailed.value = false;
        failMessage.value = "";
        overall.value = null;
        flowStep.value = "正在准备安装…";
      }
    }

    async function selectMode(id: string | number | boolean | undefined) {
      if (step.value !== "mode") return;
      mode.value = (id as Mode) ?? "local";
      await refreshDefaults().catch((err) => { hint.value = String(err); });
    }

    async function browse() {
      if (step.value !== "mode") return;
      const picked = await openDirectory("选择安装位置");
      if (picked) dir.value = picked;
    }

    async function start() {
      go("install");
      try {
        await invoke("start_install", {
          mode: mode.value,
          dir: dir.value.trim(),
          desktop: desktop.value,
        });
        overall.value = 100;
        step.value = "done";
      } catch (err) {
        installFailed.value = true;
        failMessage.value = String(err);
      } finally {
        running.value = false;
      }
    }

    function showNote(text: string, kind: "ok" | "err" = "ok") {
      note.value = { text, kind };
    }

    return () => {
      const timelineSteps = STEPS.map((s) => ({ key: s.key, label: s.label }));

      const pane =
        step.value === "mode" ? (
          <section class="wizard-pane">
            <h1>选择 WoWSP 的安装方式</h1>
            <p class="wizard-sub">选择此副本的安装方式及其数据存放位置；2D / 3D 模型资源包将一并安装。</p>

            <HSelectionGrid
              items={MODE_ITEMS}
              selectedId={mode.value}
              columns={3}
              onSelect={(item: { id?: string | number | boolean }) => {
                if (step.value !== "mode") return;
                mode.value = (item.id as Mode) ?? "local";
                void refreshDefaults().catch(() => {});
              }}
            />

            <section class="wizard-target">
              <label class="wizard-target__label" for="dir-input">安装位置</label>
              <div class="wizard-target__row">
                <div class="wizard-target__field">
                  <span class="wizard-target__field-icon" aria-hidden="true">
                    <FolderOpen size={18} />
                  </span>
                  <input
                    id="dir-input"
                    type="text"
                    spellcheck={false}
                    v-model={dir.value}
                    disabled={running.value}
                  />
                </div>
                <HButton variant="ghost" disabled={running.value} onClick={browse}>
                  浏览…
                </HButton>
              </div>
              <HCheckbox
                modelValue={desktop.value}
                label="同时创建桌面快捷方式"
                onUpdate:modelValue={(v: boolean) => (desktop.value = v)}
              />
              <p class="wizard-target__hint">{hint.value}</p>
            </section>
          </section>
        ) : step.value === "license" ? (
          <section class="wizard-pane">
            <h1>用户协议</h1>
            <p class="wizard-sub">安装前请阅读以下开源许可（Synthetic Source License 1.0）。</p>
            <div class="license-box">
              <pre>{licenseText}</pre>
            </div>
            <HCheckbox
              modelValue={agreed.value}
              label="我已阅读并同意本协议的全部条款"
              onUpdate:modelValue={(v: boolean) => (agreed.value = v)}
            />
          </section>
        ) : step.value === "install" ? (
          <section class="wizard-pane wizard-pane--center">
            {installFailed.value ? (
              <>
                <HAlert
                  variant="error"
                  title="安装失败"
                  message={failMessage.value}
                />
                <HButton variant="primary" onClick={() => go("license")}>
                  返回
                </HButton>
              </>
            ) : (
              <>
                <img src="/logo.webp" alt="" class="wizard-logo" />
                <p class="wizard-pane__title">WoWSP</p>
                <HProgressBar
                  status="loading"
                  size="md"
                  value={overall.value ?? undefined}
                  showLabel={overall.value != null}
                />
                <p class="wizard-step">{flowStep.value || "正在安装 WoWSP，这可能需要一点时间…"}</p>
              </>
            )}
          </section>
        ) : (
          <section class="wizard-pane wizard-pane--center wizard-done">
            <CheckCircle2
              size={56}
              color="rgb(var(--color-success))"
              stroke-width={1.5}
            />
            <p class="wizard-done__title">✔ 安装完成</p>
            <p class="wizard-done__path">{dir.value.trim()}</p>
            <p class="wizard-done__hint">
              {mode.value === "local"
                ? "WoWSP 已登记到系统「应用」列表，可从开始菜单启动。"
                : mode.value === "usb"
                  ? "便携副本已就绪：数据全部留在可移动磁盘内。"
                  : "便携副本已就绪，可从目标目录直接运行。"}
            </p>
          </section>
        );

      return (
        <>
          <AppTitleBar icon="/logo.webp" title="WoWSP 安装器" showMaximize={false} />
          <main class="installer">
            <div class="wizard-layout wizard-layout--left">
              <HTimeline
                steps={timelineSteps}
                currentKey={step.value}
                orientation="vertical"
              />
              <div class="wizard-layout__pane">{pane}</div>
            </div>

            {note.value && (
              <HAlert
                variant={note.value.kind === "err" ? "error" : "success"}
                message={note.value.text}
                banner
              />
            )}

            <footer class="installer__footer">
              <div>
                {running.value && flowStep.value && (
                  <span class="wizard-live">{flowStep.value}</span>
                )}
              </div>
              <div class="installer__nav">
                {running.value ? null : step.value === "mode" && (
                  <HButton variant="primary" size="lg" onClick={() => go("license")}>
                    下一步
                  </HButton>
                )}
                {step.value === "license" && (
                  <>
                    <HButton variant="ghost" onClick={() => go("mode")}>
                      上一步
                    </HButton>
                    <HButton
                      variant="primary"
                      size="lg"
                      disabled={!agreed.value}
                      onClick={start}
                    >
                      同意并安装
                    </HButton>
                  </>
                )}
              </div>
            </footer>
          </main>
        </>
      );
    };
  },
});
