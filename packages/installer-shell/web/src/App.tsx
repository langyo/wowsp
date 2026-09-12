import { defineComponent, onMounted, ref } from "vue";
import { CheckCircle2, FolderTree, Monitor, Usb } from "lucide-vue-next";
import {
  HAlert,
  HButton,
  HCheckbox,
  HProgressBar,
  HScrollContainer,
  HSelectionGrid,
  HTimeline,
} from "@celestia-island/hikari";

import AppTitleBar from "./components/AppTitleBar";
import LogPane, { type LogLine } from "./components/LogPane";
import { invoke, listen, openDirectory, tauriWindow } from "./tauri";

/**
 * Installer shell UI — a step-driven delivery wizard rendered with hikari
 * components: a left step rail (mode → license → install → done), centered
 * panes, the bundled SySL 1.0 license agreement, and a desktop-shortcut
 * toggle. The license text is the repository's LICENSE document, inlined at
 * build time through Vite's ?raw import.
 */

type Mode = "local" | "usb";
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
  record?: {
    type: string;
    path?: string;
    line?: string;
    command?: string;
    code?: string;
    detail?: string;
  };
}

const MODE_ITEMS = [
  { id: "local", title: "安装到本机", description: "标准单用户安装，含开始菜单快捷方式与自动更新。", badge: "推荐", icon: Monitor },
  { id: "usb", title: "U 盘（网吧模式）", description: "便携副本放在可移动磁盘上，无注册表项，数据全部留在盘内。", icon: Usb },
];

const HINTS: Record<Mode, string> = {
  local: "数据写入 %APPDATA%，可自动更新；卸载信息会登记到系统。",
  usb: "检测到可移动磁盘时自动定位；否则回退到本机路径。",
};

const FLAVOR_LABELS: Record<string, string> = {
  lite: "精简版（不含模型资源包，可联网获取）",
  "lite-webview2": "精简版 · 含 WebView2 运行时（不含模型资源包）",
  full: "完整版 · 含 2D/3D 模型资源包",
  "full-webview2": "完整版 · 含 2D/3D 模型资源包与 WebView2 运行时",
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
    const licenseText = ref("");
    const agreed = ref(false);
    const desktopShortcut = ref(true);
    const startMenuShortcut = ref(true);
    const overall = ref<number | null>(null);
    const flowStep = ref("");
    const installFailed = ref(false);
    const failMessage = ref("");
    const note = ref<{ text: string; kind: "ok" | "err" } | null>(null);

    // Install log pane: structured events composed into localized lines
    // with HH:MM:SS stamps; ordering follows the manifest (newest-first
    // default) with a per-run toggle.
    const zh = navigator.language.toLowerCase().startsWith("zh");
    const logLines = ref<LogLine[]>([]);
    const logOrder = ref<"newest" | "oldest">("newest");
    const stamp = () => new Date().toTimeString().slice(0, 8);
    const pushLog = (kind: LogLine["kind"], text: string) => {
      logLines.value.push({ time: stamp(), kind, text });
      if (logLines.value.length > 500) logLines.value.shift();
    };
    // The flow's progress labels are composed English verbs; render the
    // ones we know in the UI language and pass the rest through.
    const localizeStep = (step: string): string => {
      if (!zh) return step;
      const m = /^(Extracting|Reusing|Downloading|Registering|Writing)\s+(.+)$/.exec(step);
      if (!m) return step;
      const verbs: Record<string, string> = {
        Extracting: "正在解压",
        Reusing: "正在复用",
        Downloading: "正在下载",
        Registering: "正在登记",
        Writing: "正在写入",
      };
      return `${verbs[m[1]] ?? m[1]} ${m[2]}`;
    };
    const phaseLabel = (phase: string | undefined): string => {
      if (!zh) return phase ?? "";
      switch (phase) {
        case "download": return "正在下载资源";
        case "extract": return "正在解压文件";
        case "register": return "正在登记系统信息";
        default: return "正在安装";
      }
    };


    const running = ref(false);

    async function refreshDefaults() {
      const defaults = await invoke<DirDefaults>("default_dir", { mode: mode.value });
      dir.value = defaults.dir;
      hint.value =
        mode.value === "usb" && defaults.removable
          ? "已检测到可移动磁盘。"
          : HINTS[mode.value];
    }

    const identity = ref<{ version: string; flavor: string } | null>(null);

    onMounted(() => {
      refreshDefaults().catch((err) => { hint.value = String(err); });
      invoke<{ version: string; flavor: string }>("get_identity")
        .then((id) => { identity.value = id; })
        .catch(() => {});
      invoke<string>("get_license", {
        locale: navigator.language,
      })
        .then((text) => {
          licenseText.value = text;
        })
        .catch(() => {});
      invoke<{ log_level: string; log_order: string }>("get_shell_prefs")
        .then((prefs) => {
          logOrder.value = prefs.log_order === "oldest" ? "oldest" : "newest";
        })
        .catch(() => {});
      listen<FlowEventPayload>("install-progress", (event) => {
        // Structured log records compose into localized pane lines.
        if (event.record) {
          const r = event.record;
          if (r.type === "file-write" && r.path) {
            pushLog("echo", zh ? `写入 ${r.path}` : `Writing ${r.path}`);
          } else if (r.type === "file-reuse" && r.path) {
            pushLog("echo", zh ? `复用 ${r.path}` : `Reusing ${r.path}`);
          } else if (r.type === "warning") {
            pushLog("error", r.detail ?? r.code ?? "");
          } else if (r.type === "script-line" && r.line) {
            pushLog("echo", r.line);
          } else if (r.type === "command-done" && r.command) {
            pushLog("ok", `✓ ${r.command}`);
          }
        }
        if (event.phase) flowStep.value = localizeStep(event.step ?? "") || phaseLabel(event.phase);
        if (event.percent != null) overall.value = Math.round(event.percent);
        if (event.message) {
          installFailed.value = true;
          failMessage.value = event.message;
          pushLog("error", event.message);
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
        flowStep.value = zh ? "正在准备安装…" : "Preparing the install…";
        logLines.value = [];
        pushLog("step", zh ? "开始安装" : "Install started");
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
        });
        // The install creates both shortcuts; the done pane's toggles then
        // apply the user's choices live (local mode only).
        await syncShortcuts();
        overall.value = 100;
        step.value = "done";
      } catch (err) {
        installFailed.value = true;
        failMessage.value = String(err);
        logLines.value = [];
      } finally {
        running.value = false;
      }
    }

    async function syncShortcuts() {
      if (mode.value !== "local") return;
      await invoke("set_shortcuts", {
        desktop: desktopShortcut.value,
        menu: startMenuShortcut.value,
        dir: dir.value.trim(),
        mode: mode.value,
      });
    }

    async function toggleDesktop(v: boolean) {
      desktopShortcut.value = v;
      try {
        await invoke("set_shortcuts", {
          desktop: v,
          menu: undefined,
          dir: dir.value.trim(),
          mode: mode.value,
        });
      } catch (err) {
        desktopShortcut.value = !v;
        showNote(String(err), "err");
      }
    }

    async function toggleMenu(v: boolean) {
      startMenuShortcut.value = v;
      try {
        await invoke("set_shortcuts", {
          desktop: undefined,
          menu: v,
          dir: dir.value.trim(),
          mode: mode.value,
        });
      } catch (err) {
        startMenuShortcut.value = !v;
        showNote(String(err), "err");
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
              columns={MODE_ITEMS.length as 2}
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
                    <FolderTree size={16} />
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
              <p class="wizard-target__hint">{hint.value}</p>
              {identity.value && (
                <p class="wizard-identity">
                  {`WoWSP ${identity.value.version} · `}
                  {FLAVOR_LABELS[identity.value.flavor] ?? identity.value.flavor}
                </p>
              )}
            </section>
          </section>
        ) : step.value === "license" ? (
          <section class="wizard-pane">
            <h1>用户协议</h1>
            <p class="wizard-sub">安装前请阅读以下开源许可（Synthetic Source License 1.0）。</p>
            <HScrollContainer class="license-box" axis="vertical">
              <pre>{licenseText.value}</pre>
            </HScrollContainer>
            <HCheckbox
              modelValue={agreed.value}
              label="我已阅读并同意本协议的全部条款"
              onUpdate:modelValue={(v: boolean) => (agreed.value = v)}
            />
          </section>
        ) : step.value === "install" ? (
          <section class="wizard-pane wizard-pane--install">
            <div class="wizard-install__main">
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
            </div>
            <div class="wizard-install__logs">
              <LogPane
                lines={logLines.value}
                order={logOrder.value}
                onToggleOrder={() => {
                  logOrder.value = logOrder.value === "newest" ? "oldest" : "newest";
                }}
              />
            </div>
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
                : "便携副本已就绪：数据全部留在可移动磁盘内。"}
            </p>
            {mode.value === "local" && (
              <>
                <HCheckbox
                  modelValue={startMenuShortcut.value}
                  label="创建开始菜单快捷方式"
                  onUpdate:modelValue={(v: boolean) => toggleMenu(v)}
                />
                <HCheckbox
                  modelValue={desktopShortcut.value}
                  label="创建桌面快捷方式"
                  onUpdate:modelValue={(v: boolean) => toggleDesktop(v)}
                />
              </>
            )}
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
                {step.value === "done" && (
                  <HButton variant="primary" size="lg" onClick={() => tauriWindow()?.close()}>
                    完成安装
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
