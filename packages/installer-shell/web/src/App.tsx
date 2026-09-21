import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AppWindow,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  Monitor,
  TriangleAlert,
  Usb,
  XCircle,
} from "lucide-vue-next";
import {
  HAlert,
  HButton,
  HCheckbox,
  HProgressBar,
  HScrollContainer,
  HSelectionGrid,
  HTimeline,
} from "@celestia-island/hikari";

import AnnouncementCard from "./components/AnnouncementCard";
import AppTitleBar from "./components/AppTitleBar";
import PathField, { type DriveInfo } from "./components/PathField";
import LogPane, { type LogLine } from "./components/LogPane";
import { invoke, listen, openDirectory, tauriWindow } from "./tauri";

/**
 * Installer shell UI — a step-driven delivery wizard rendered with hikari
 * components: a left step rail (mode → license → install → done), centered
 * panes, the bundled SySL 1.0 license agreement, and done-page shortcut
 * toggles plus an optional immediate launch, all applied only when the
 * final confirmation runs (nothing is created during the install itself).
 * An install failure lands on the done step as a failure variant with
 * retry/close actions — nothing returns to earlier steps once the install
 * started. The license step pages through the localized documents the
 * backend resolves at build time (a copyright notice + the SySL
 * agreement); agreeing covers all of them.
 *
 * When the shell runs as the uninstaller (`/uninstall`, probed via
 * `is_uninstall_mode`), the wizard layout is replaced by a standalone
 * centered uninstall page: confirm (卸载, or 修复安装 which re-runs the
 * local delivery over the existing install dir) → indeterminate progress
 * → done/fail.
 */

type Mode = "local" | "usb";
type StepKey = "mode" | "license" | "install" | "done";

interface DirCandidate {
  kind: string;
  path: string;
  writable: boolean;
}

interface DirDefaults {
  dir: string;
  removable: boolean;
  candidates: DirCandidate[];
}

interface LicenseDoc {
  title: string;
  body: string;
}

interface FlowEventPayload {
  phase?: string;
  step?: string;
  percent?: number | null;
  message?: string;
  record?: {
    // shun tags FlowLog records with a `log` discriminator (serde tag),
    // not `type` — kebab-case values: file-write / file-reuse / warning /
    // script-begin / script-line / command-done.
    log?: string;
    path?: string;
    name?: string;
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
  full: "完整版 · 含 2D/3D 模型资源包",
  "full-webview2": "完整版 · 含 2D/3D 模型资源包与 WebView2 运行时",
};

// Quick-candidate row: label + glyph per candidate kind; drive
// candidates show the path itself (a row of drive roots reads better
// than a bare "磁盘").
const CANDIDATE_META: Record<string, { label: string; icon: typeof HardDrive }> = {
  appdata: { label: "AppData", icon: AppWindow },
  "program-files": { label: "Program Files", icon: HardDrive },
  drive: { label: "", icon: HardDrive },
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
    const drives = ref<DriveInfo[]>([]);
    const candidates = ref<DirCandidate[]>([]);
    // Live writability of the shown path: null while the probe is in
    // flight or the box is empty, true/false once the backend answered.
    const dirWritable = ref<boolean | null>(null);
    const licenseDocs = ref<LicenseDoc[]>([]);
    const licenseIndex = ref(0);
    const agreed = ref(false);
    // License-step notice countdown: holds the agree button for five
    // seconds on EVERY license-step entry so the free & open-source
    // announcement card cannot be skipped unseen.
    const noticeCountdown = ref(5);
    const desktopShortcut = ref(true);
    const startMenuShortcut = ref(true);
    // Done-page option: start the installed app (portable copies launch
    // the portable copy) right when the confirmation closes the wizard.
    const launchAfterInstall = ref(true);
    const overall = ref<number | null>(null);
    const flowStep = ref("");
    const installFailed = ref(false);
    const failMessage = ref("");
    const note = ref<{ text: string; kind: "ok" | "err" } | null>(null);

    // Uninstall mode (`/uninstall` without --silent): replaces the whole
    // wizard layout with a standalone confirm → progress → done page.
    // Null while the probe is in flight — nothing renders until it lands,
    // so the uninstaller never flashes the wizard it will not run.
    const uninstallMode = ref<boolean | null>(null);
    // 卸载 drives running → done/failed; 修复安装 drives the parallel
    // repairing → repaired/repair_failed triple (same running view).
    const uninstallPhase = ref<
      "idle" | "running" | "done" | "failed" | "repairing" | "repaired" | "repair_failed"
    >("idle");
    const uninstallError = ref("");

    // Install log pane: structured events composed into localized lines
    // with HH:MM:SS stamps; ordering follows the manifest (newest-first
    // default) with a per-run toggle.
    const zh = navigator.language.toLowerCase().startsWith("zh");
    const logLines = ref<LogLine[]>([]);
    const logOrder = ref<"newest" | "oldest">("newest");
    // The log pane folds into a one-line drawer by default; error records
    // force it open so the cause is visible without a manual click.
    const logExpanded = ref(false);
    const stamp = () => new Date().toTimeString().slice(0, 8);
    const pushLog = (kind: LogLine["kind"], text: string) => {
      logLines.value.push({ time: stamp(), kind, text });
      if (logLines.value.length > 500) logLines.value.shift();
      if (kind === "error") logExpanded.value = true;
    };
    // The flow's progress labels are composed English verbs; render the
    // ones we know in the UI language and pass the rest through.
    const localizeStep = (step: string): string => {
      if (!zh) return step;
      // Installer-shell steps beyond the payload verbs (main.rs): the
      // pre-kill notice and the stale-file cleanup summary.
      if (step === "Stopping wowsp.exe") return "正在停止运行中的 WoWSP";
      const stale = /^Removed (\d+) stale file/.exec(step);
      if (stale) return `已移除 ${stale[1]} 个旧版残留文件`;
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
    // True while the done-page confirmation is applying the shortcut
    // choices — the finish button stays disabled for that window.
    const finishing = ref(false);

    async function refreshDefaults() {
      const defaults = await invoke<DirDefaults>("default_dir", { mode: mode.value });
      dir.value = defaults.dir;
      candidates.value = defaults.candidates;
      hint.value =
        mode.value === "usb" && defaults.removable
          ? "已检测到可移动磁盘。"
          : HINTS[mode.value];
    }

    const identity = ref<{ version: string; flavor: string } | null>(null);

    // The first candidate the install would actually accept — the row
    // highlights it while the current path fails the live probe.
    const firstWritableCandidate = computed(
      () => candidates.value.find((candidate) => candidate.writable) ?? null,
    );

    // Live writability probe, debounced so typing does not hammer the
    // backend (the probe creates + deletes a temp file per call). The
    // answer only lands while it is still about the current path.
    let writableTimer: ReturnType<typeof setTimeout> | null = null;
    watch(dir, (value) => {
      const target = value.trim();
      if (writableTimer !== null) clearTimeout(writableTimer);
      if (!target) {
        dirWritable.value = null;
        return;
      }
      dirWritable.value = null;
      writableTimer = setTimeout(() => {
        invoke<boolean>("check_dir_writable", { dir: target })
          .then((ok) => {
            if (dir.value.trim() === target) dirWritable.value = ok;
          })
          .catch(() => {
            if (dir.value.trim() === target) dirWritable.value = null;
          });
      }, 400);
    });

    onMounted(() => {
      invoke<boolean>("is_uninstall_mode")
        .then((flag) => {
          uninstallMode.value = flag;
        })
        .catch(() => {});
      refreshDefaults().catch((err) => { hint.value = String(err); });
      invoke<{ version: string; flavor: string }>("get_identity")
        .then((id) => { identity.value = id; })
        .catch(() => {});
      invoke<DriveInfo[]>("list_drives")
        .then((list) => { drives.value = list; })
        .catch(() => {});
      invoke<LicenseDoc[]>("get_license_docs", {
        locale: navigator.language,
      })
        .then((docs) => {
          licenseDocs.value = docs;
          licenseIndex.value = 0;
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
          const kind = r.log;
          if (kind === "file-write" && r.path) {
            pushLog("echo", zh ? `写入 ${r.path}` : `Writing ${r.path}`);
          } else if (kind === "file-reuse" && r.path) {
            pushLog("echo", zh ? `复用 ${r.path}` : `Reusing ${r.path}`);
          } else if (kind === "warning") {
            const text = [r.code, r.detail].filter(Boolean).join(": ");
            if (text) pushLog("error", text);
          } else if (kind === "script-begin" && r.name) {
            pushLog("step", zh ? `运行脚本 ${r.name}` : `Running ${r.name}`);
          } else if (kind === "script-line" && r.line) {
            pushLog("echo", r.line);
          } else if (kind === "command-done" && r.command) {
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
      // Preview hook landed directly on the license step: arm the notice
      // countdown here too, not only on the wizard's go("license").
      if (step.value === "license") {
        licenseIndex.value = 0;
        startNoticeCountdown();
      }
    });

    onBeforeUnmount(() => {
      if (noticeTimer !== null) clearInterval(noticeTimer);
    });

    let noticeTimer: ReturnType<typeof setInterval> | null = null;

    // (Re)arm the notice countdown: clears any pending interval, resets to
    // 5, ticks down once a second, and clears itself when it reaches 0.
    function startNoticeCountdown() {
      if (noticeTimer !== null) clearInterval(noticeTimer);
      noticeCountdown.value = 5;
      noticeTimer = setInterval(() => {
        noticeCountdown.value -= 1;
        if (noticeCountdown.value <= 0) {
          noticeCountdown.value = 0;
          if (noticeTimer !== null) clearInterval(noticeTimer);
          noticeTimer = null;
        }
      }, 1000);
    }

    function go(next: StepKey) {
      step.value = next;
      if (next === "license") {
        licenseIndex.value = 0;
        startNoticeCountdown();
      }
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

    /** 裸盘符根目录（如选中的 D:\）不直接接收载荷：shun 0.3 的根盘
        保护会在其下自动垫一层文件夹（默认取产品名 WoWSP），并让路径
        框始终显示真实目标。 */
    async function applyNestRootDir(raw: string) {
      const nested = await invoke<string>("nest_root_dir", { dir: raw });
      if (nested !== raw.trim()) showNote("已自动垫一层文件夹，避免直接安装到盘符根目录。");
      dir.value = nested;
    }

    async function browse() {
      if (step.value !== "mode") return;
      const picked = await openDirectory("选择安装位置");
      if (picked) await applyNestRootDir(picked);
    }

    async function start() {
      // 手动输入的裸盘根目录先垫好文件夹再开跑——完成页与后续的
      // 快捷方式 / 启动命令用的都是改写后的真实路径。
      await applyNestRootDir(dir.value).catch(() => {});
      go("install");
      try {
        await invoke("start_install", {
          mode: mode.value,
          dir: dir.value.trim(),
        });
        // No shortcut work here: the install creates none, and the done
        // pane's toggles take effect only on the final confirmation.
        overall.value = 100;
        step.value = "done";
      } catch (err) {
        installFailed.value = true;
        failMessage.value = String(err);
        // Failure lands on the done step too: the log lines stay (the
        // drawer auto-expanded on the error record) so the failure trail
        // remains readable next to the retry action. A retry resets them
        // in go("install").
        step.value = "done";
      } finally {
        running.value = false;
      }
    }

    // The done-page confirmation: applies the shortcut choices in one
    // shot for local installs (portable copies have none), optionally
    // starts the freshly installed app per the 立即启动 checkbox (for
    // portable it launches the portable copy), then closes the window.
    async function finish() {
      if (finishing.value) return;
      finishing.value = true;
      try {
        if (mode.value === "local") {
          await invoke("set_shortcuts", {
            desktop: desktopShortcut.value,
            menu: startMenuShortcut.value,
            dir: dir.value.trim(),
            mode: mode.value,
          });
        }
        if (launchAfterInstall.value) {
          await invoke("launch_app", { dir: dir.value.trim() });
        }
        tauriWindow()?.close();
      } catch (err) {
        showNote(String(err), "err");
      } finally {
        finishing.value = false;
      }
    }

    function toggleDesktop(v: boolean) {
      desktopShortcut.value = v;
    }

    function toggleMenu(v: boolean) {
      startMenuShortcut.value = v;
    }

    // The uninstall page's only action: run the shun uninstall (the
    // backend deletes the install dir this uninstaller sits in), then
    // flip to the done / failed view. shun emits no progress events, so
    // the running view is an indeterminate bar.
    async function runUninstall() {
      if (uninstallPhase.value !== "idle") return;
      uninstallPhase.value = "running";
      try {
        await invoke("perform_uninstall");
        uninstallPhase.value = "done";
      } catch (err) {
        uninstallError.value = String(err);
        uninstallPhase.value = "failed";
      }
    }

    // The uninstall page's repair action: re-runs the local delivery flow
    // over the install dir this uninstaller sits in (repairs damaged or
    // missing files; user data is preserved). The running view is the
    // same indeterminate bar as the uninstall itself — shun emits no
    // progress events the page surfaces here.
    async function runRepair() {
      if (uninstallPhase.value !== "idle") return;
      uninstallPhase.value = "repairing";
      try {
        const installDir = await invoke<string>("current_install_dir");
        await invoke("start_install", { mode: "local", dir: installDir });
        uninstallPhase.value = "repaired";
      } catch (err) {
        uninstallError.value = String(err);
        uninstallPhase.value = "repair_failed";
      }
    }

    function closeWindow() {
      tauriWindow()?.close();
    }

    function showNote(text: string, kind: "ok" | "err" = "ok") {
      note.value = { text, kind };
    }

    return () => {
      // Uninstall page: a standalone centered pane instead of the wizard
      // layout — no step rail, no install panes, no footer nav. While the
      // mode probe is still in flight, render nothing.
      if (uninstallMode.value === null) {
        return (
          <>
            <AppTitleBar
              icon="/logo.webp"
              title="WoWSP 安装器"
              subtitle={identity.value ? `v${identity.value.version}` : ""}
              showMaximize={false}
            />
            <main class="installer" />
          </>
        );
      }
      if (uninstallMode.value) {
        const uninstallPane =
          uninstallPhase.value === "idle" ? (
            <section class="wizard-pane wizard-pane--center wizard-uninstall">
              <h1>卸载 WoWSP</h1>
              <p class="wizard-sub">这将移除 WoWSP 及其注册的系统项。模型资源与用户数据将保留。</p>
              <div class="wizard-uninstall__actions">
                <HButton variant="ghost" onClick={closeWindow}>
                  取消
                </HButton>
                <HButton variant="ghost" onClick={runRepair}>
                  修复安装
                </HButton>
                <HButton variant="danger" onClick={runUninstall}>
                  卸载
                </HButton>
              </div>
            </section>
          ) : uninstallPhase.value === "running" || uninstallPhase.value === "repairing" ? (
            <section class="wizard-pane wizard-pane--center wizard-uninstall">
              <img src="/logo.webp" alt="" class="wizard-logo" />
              <HProgressBar status="loading" size="md" />
              <p class="wizard-step">
                {uninstallPhase.value === "repairing" ? "正在修复…" : "正在卸载…"}
              </p>
            </section>
          ) : uninstallPhase.value === "done" || uninstallPhase.value === "repaired" ? (
            <section class="wizard-pane wizard-pane--center wizard-uninstall">
              <CheckCircle2
                size={56}
                color="rgb(var(--color-success))"
                stroke-width={1.5}
              />
              <p class="wizard-done__title">
                {uninstallPhase.value === "repaired" ? "已完成修复" : "已完成卸载"}
              </p>
              <div class="wizard-uninstall__actions">
                <HButton variant="primary" onClick={closeWindow}>
                  关闭
                </HButton>
              </div>
            </section>
          ) : (
            <section class="wizard-pane wizard-pane--center wizard-uninstall">
              <XCircle
                size={56}
                color="rgb(var(--color-error))"
                stroke-width={1.5}
              />
              <p class="wizard-done__title wizard-done__title--fail">
                {uninstallPhase.value === "repair_failed" ? "修复失败" : "卸载失败"}
              </p>
              <p class="wizard-uninstall__error">{uninstallError.value}</p>
              <div class="wizard-uninstall__actions">
                <HButton variant="primary" onClick={closeWindow}>
                  关闭
                </HButton>
              </div>
            </section>
          );

        return (
          <>
            <AppTitleBar icon="/logo.webp" title="WoWSP 卸载" showMaximize={false} />
            <main class="installer">
              <div class="wizard-layout__pane">{uninstallPane}</div>
            </main>
          </>
        );
      }

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
              <PathField
                modelValue={dir.value}
                disabled={running.value}
                drives={drives.value}
                onUpdate:modelValue={(v: string) => (dir.value = v)}
                onBrowse={browse}
                onBlur={() => {
                  // 离开输入框即校平裸盘根目录，路径框保持真实目标。
                  if (step.value === "mode" && !running.value) {
                    void applyNestRootDir(dir.value).catch(() => {});
                  }
                }}
              />
              <div class="wizard-target__quick">
                {candidates.value.map((candidate) => {
                  const meta = CANDIDATE_META[candidate.kind] ?? CANDIDATE_META.drive;
                  const Icon = candidate.writable ? meta.icon : TriangleAlert;
                  // While the current path fails the probe, steer the
                  // user to the first location the install would accept.
                  const accent =
                    dirWritable.value === false &&
                    candidate.writable &&
                    candidate.path === firstWritableCandidate.value?.path;
                  return (
                    <HButton
                      key={candidate.path}
                      variant="ghost"
                      size="sm"
                      class={[
                        "wizard-target__quick-candidate",
                        candidate.writable ? "" : "wizard-target__quick-candidate--dim",
                        accent ? "wizard-target__quick-candidate--accent" : "",
                      ]}
                      onClick={() => void applyNestRootDir(candidate.path).catch(() => {})}
                    >
                      <Icon size={13} />
                      {candidate.kind === "drive" ? candidate.path : meta.label}
                    </HButton>
                  );
                })}
              </div>
              <p class="wizard-target__hint">{hint.value}</p>
              {dirWritable.value === false && (
                <p class="wizard-target__warning">
                  {firstWritableCandidate.value
                    ? "当前目录不可写，安装会被拒绝——建议选择上方标亮的候选位置。"
                    : "未检测到可写的候选位置，请手动选择有权限的目录。"}
                </p>
              )}
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
            <p class="wizard-sub">安装前请阅读以下协议文档；勾选即代表同意全部内容。</p>
            <AnnouncementCard />
            <HScrollContainer class="license-box" axis="vertical">
              <pre>{licenseDocs.value[licenseIndex.value]?.body ?? ""}</pre>
            </HScrollContainer>
            {licenseDocs.value.length > 1 && (
              <div class="license-pager">
                <HButton
                  variant="ghost"
                  size="sm"
                  disabled={licenseIndex.value <= 0}
                  ariaLabel="上一篇协议文档"
                  onClick={() => (licenseIndex.value -= 1)}
                >
                  <ChevronLeft size={15} />
                </HButton>
                <span class="license-pager__label">
                  {licenseIndex.value + 1}/{licenseDocs.value.length}{" "}
                  {licenseDocs.value[licenseIndex.value]?.title ?? ""}
                </span>
                <HButton
                  variant="ghost"
                  size="sm"
                  disabled={licenseIndex.value >= licenseDocs.value.length - 1}
                  ariaLabel="下一篇协议文档"
                  onClick={() => (licenseIndex.value += 1)}
                >
                  <ChevronRight size={15} />
                </HButton>
              </div>
            )}
            <HCheckbox
              modelValue={agreed.value}
              label="我已阅读并同意上述全部协议"
              onUpdate:modelValue={(v: boolean) => (agreed.value = v)}
            />
          </section>
        ) : step.value === "install" ? (
          <section class="wizard-pane wizard-pane--install">
            <div class="wizard-install__main">
              <img src="/logo.webp" alt="" class="wizard-logo" />
              <p class="wizard-pane__title">WoWSP</p>
              <HProgressBar
                status="loading"
                size="md"
                value={overall.value ?? undefined}
                showLabel={overall.value != null}
              />
              <p class="wizard-step">{flowStep.value || "正在安装 WoWSP，这可能需要一点时间…"}</p>
            </div>
            <div class="wizard-install__logs">
              <LogPane
                lines={logLines.value}
                order={logOrder.value}
                expanded={logExpanded.value}
                onToggleExpanded={() => {
                  logExpanded.value = !logExpanded.value;
                }}
              />
            </div>
          </section>
        ) : installFailed.value ? (
          <section class="wizard-pane wizard-pane--center wizard-done">
            <XCircle
              size={56}
              color="rgb(var(--color-error))"
              stroke-width={1.5}
            />
            <p class="wizard-done__title wizard-done__title--fail">安装失败</p>
            <p class="wizard-done__error">{failMessage.value}</p>
            <div class="wizard-install__logs">
              <LogPane
                lines={logLines.value}
                order={logOrder.value}
                expanded={logExpanded.value}
                onToggleExpanded={() => {
                  logExpanded.value = !logExpanded.value;
                }}
              />
            </div>
            <div class="wizard-done__actions">
              <HButton variant="primary" onClick={start}>
                重试安装
              </HButton>
              <HButton variant="ghost" onClick={() => tauriWindow()?.close()}>
                关闭
              </HButton>
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
              ? "WoWSP 已登记到系统「应用」列表；勾选的快捷方式会在点击「完成安装」时创建。"
              : "便携副本已就绪：数据全部留在可移动磁盘内。"}
            </p>
            <div class="wizard-done__shortcuts">
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
              <HCheckbox
                modelValue={launchAfterInstall.value}
                label="安装完成后立即启动 WoWSP"
                onUpdate:modelValue={(v: boolean) => (launchAfterInstall.value = v)}
              />
            </div>
          </section>
        );

      return (
        <>
          <AppTitleBar
            icon="/logo.webp"
            title="WoWSP 安装器"
            subtitle={identity.value ? `v${identity.value.version}` : ""}
            showMaximize={false}
          />
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
              <div class="installer__nav">
                {running.value ? null : step.value === "mode" && (
                  <HButton
                    variant="primary"
                    size="lg"
                    disabled={dirWritable.value === false}
                    onClick={() => go("license")}
                  >
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
                      disabled={!agreed.value || noticeCountdown.value > 0}
                      onClick={start}
                    >
                      {noticeCountdown.value > 0
                        ? `同意并安装（${noticeCountdown.value} 秒）`
                        : "同意并安装"}
                    </HButton>
                  </>
                )}
                {step.value === "done" && !installFailed.value && (
                  <HButton
                    variant="primary"
                    size="lg"
                    disabled={finishing.value}
                    onClick={finish}
                  >
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
