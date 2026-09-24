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
  HkAlert,
  HkButton,
  HkCheckbox,
  HkProgressBar,
  HkScrollContainer,
  HkSelect,
  HkSelectionGrid,
  HkTimeline,
} from "@celestia-island/hikari";

import AnnouncementCard from "./components/AnnouncementCard";
import AppTitleBar from "./components/AppTitleBar";
import PathField, { type DriveInfo } from "./components/PathField";
import LogPane, { type LogLine } from "./components/LogPane";
import {
  isInstallerLocale,
  LOCALE_OPTIONS,
  resolveSystemLocale,
  strings,
  type InstallerLocale,
} from "./i18n";
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

const MODE_ICONS = { local: Monitor, usb: Usb } as const;

// Quick-candidate row: label + glyph per candidate kind; drive candidates
// show the path itself (a row of drive roots reads better than a bare
// "磁盘"). The two product nouns are locale-independent.
const CANDIDATE_META: Record<string, { label: string; icon: typeof HardDrive }> = {
  appdata: { label: "AppData", icon: AppWindow },
  "program-files": { label: "Program Files", icon: HardDrive },
  drive: { label: "", icon: HardDrive },
};

// Step keys in rail order; the labels resolve from the string table per
// render so a locale switch relabels the timeline live.
const STEP_KEYS = ["mode", "license", "install", "done"] as const;

export default defineComponent({
  name: "InstallerApp",
  setup() {
    // `?step=` preview hook (static previews / dev); production passes no
    // query and starts at the mode pane.
    const initialStep = (new URLSearchParams(window.location.search).get(
      "step",
    ) ?? "") as StepKey;
    const step = ref<StepKey>(
      (STEP_KEYS as readonly string[]).includes(initialStep) ? initialStep : "mode",
    );
    const mode = ref<Mode>("local");
    // Wizard locale — resolved synchronously from the system so first paint
    // (and the ?step= previews) always has strings, then overridden by the
    // saved preference once the backend answers (saved > system). A failed
    // invoke (e.g. non-Tauri preview) keeps the system resolution.
    const locale = ref<InstallerLocale>(
      resolveSystemLocale(navigator.language),
    );
    const dir = ref("");
    // The hint under the path field: a semantic kind resolved to text at
    // render time (so a locale switch relabels it), or a raw backend error
    // message that passes through as-is.
    const hintKind = ref<Mode | "usb-detected" | "error">("local");
    const hintError = ref("");
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
    // default) with a per-run toggle. Line text resolves from the picked
    // wizard locale (`install.progress` in i18n.ts); unknown backend verbs
    // pass through verbatim (they are composed English).
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
    // ones we know in the wizard language and pass the rest through.
    const localizeStep = (step: string): string => {
      const progress = strings(locale.value).install.progress;
      // Installer-shell steps beyond the payload verbs (main.rs): the
      // pre-kill notice and the stale-file cleanup summary.
      if (step === "Stopping wowsp.exe") return progress.stopApp;
      const stale = /^Removed (\d+) stale file/.exec(step);
      if (stale) return progress.removedStale(Number(stale[1]));
      const m = /^(Extracting|Reusing|Downloading|Registering|Writing)\s+(.+)$/.exec(step);
      if (!m) return step;
      const verb = progress.verbs[m[1]];
      return verb ? `${verb} ${m[2]}` : step;
    };
    const phaseLabel = (phase: string | undefined): string => {
      const phases = strings(locale.value).install.progress.phases;
      switch (phase) {
        case "download": return phases.download;
        case "extract": return phases.extract;
        case "register": return phases.register;
        default: return phases.fallback;
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
      hintKind.value =
        mode.value === "usb" && defaults.removable ? "usb-detected" : mode.value;
      hintError.value = "";
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

    // The license documents are backend-resolved per wizard locale
    // (build-time artifacts; every offered locale has a dedicated set,
    // and anything else still lands the English fallback). A locale
    // switch re-fetches; a response from a superseded request is dropped
    // so a slow earlier locale can never win.
    function refreshLicenseDocs() {
      const requested = locale.value;
      invoke<LicenseDoc[]>("get_license_docs", { locale: requested })
        .then((docs) => {
          if (locale.value !== requested) return;
          licenseDocs.value = docs;
          licenseIndex.value = 0;
        })
        .catch(() => {});
    }
    watch(locale, refreshLicenseDocs);

    onMounted(() => {
      invoke<string | null>("get_saved_language")
        .then((saved) => {
          // Saved preference wins over the system resolution; anything the
          // wizard does not offer is ignored.
          if (isInstallerLocale(saved)) locale.value = saved;
        })
        .catch(() => {});
      invoke<boolean>("is_uninstall_mode")
        .then((flag) => {
          uninstallMode.value = flag;
        })
        .catch(() => {});
      refreshDefaults().catch((err) => { hintKind.value = "error"; hintError.value = String(err); });
      invoke<{ version: string; flavor: string }>("get_identity")
        .then((id) => { identity.value = id; })
        .catch(() => {});
      invoke<DriveInfo[]>("list_drives")
        .then((list) => { drives.value = list; })
        .catch(() => {});
      invoke<LicenseDoc[]>("get_license_docs", { locale: locale.value })
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
        // Structured log records compose into localized pane lines, keyed
        // to the picked wizard locale.
        if (event.record) {
          const r = event.record;
          const kind = r.log;
          const progress = strings(locale.value).install.progress;
          if (kind === "file-write" && r.path) {
            pushLog("echo", progress.writing(r.path));
          } else if (kind === "file-reuse" && r.path) {
            pushLog("echo", progress.reusing(r.path));
          } else if (kind === "warning") {
            const text = [r.code, r.detail].filter(Boolean).join(": ");
            if (text) pushLog("error", text);
          } else if (kind === "script-begin" && r.name) {
            pushLog("step", progress.runningScript(r.name));
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
        flowStep.value = strings(locale.value).install.preparing;
        logLines.value = [];
        pushLog("step", strings(locale.value).install.startedLog);
      }
    }

    async function selectMode(id: string | number | boolean | undefined) {
      if (step.value !== "mode") return;
      mode.value = (id as Mode) ?? "local";
      await refreshDefaults().catch((err) => { hintKind.value = "error"; hintError.value = String(err); });
    }

    // Picker change: remember the choice for the next run — portable (USB)
    // runs skip the write, so a removable copy scatters no state onto the
    // host. The ref itself drives every label on the next render.
    function changeLocale(value: string) {
      if (!isInstallerLocale(value)) return;
      locale.value = value;
      void invoke("save_language", {
        language: value,
        portable: mode.value === "usb",
      }).catch(() => {});
    }

    /** 裸盘符根目录（如选中的 D:\）不直接接收载荷：shun 0.3 的根盘
        保护会在其下自动垫一层文件夹（默认取产品名 WoWSP），并让路径
        框始终显示真实目标。 */
    async function applyNestRootDir(raw: string) {
      const nested = await invoke<string>("nest_root_dir", { dir: raw });
      if (nested !== raw.trim()) showNote(strings(locale.value).target.nestedNote);
      dir.value = nested;
    }

    async function browse() {
      if (step.value !== "mode") return;
      const picked = await openDirectory(strings(locale.value).target.dialogTitle);
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
          language: locale.value,
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
      const s = strings(locale.value);
      // Uninstall page: a standalone centered pane instead of the wizard
      // layout — no step rail, no install panes, no footer nav. While the
      // mode probe is still in flight, render nothing.
      if (uninstallMode.value === null) {
        return (
          <>
            <AppTitleBar
              icon="/logo.webp"
              title={s.title}
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
              <h1>{s.uninstall.heading}</h1>
              <p class="wizard-sub">{s.uninstall.sub}</p>
              <div class="wizard-uninstall__actions">
                <HkButton variant="ghost" onClick={closeWindow}>
                  {s.uninstall.cancel}
                </HkButton>
                <HkButton variant="ghost" onClick={runRepair}>
                  {s.uninstall.repair}
                </HkButton>
                <HkButton variant="danger" onClick={runUninstall}>
                  {s.uninstall.uninstall}
                </HkButton>
              </div>
            </section>
          ) : uninstallPhase.value === "running" || uninstallPhase.value === "repairing" ? (
            <section class="wizard-pane wizard-pane--center wizard-uninstall">
              <img src="/logo.webp" alt="" class="wizard-logo" />
              <HkProgressBar status="loading" size="md" />
              <p class="wizard-step">
                {uninstallPhase.value === "repairing" ? s.uninstall.repairing : s.uninstall.uninstalling}
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
                {uninstallPhase.value === "repaired" ? s.uninstall.doneRepair : s.uninstall.doneUninstall}
              </p>
              <div class="wizard-uninstall__actions">
                <HkButton variant="primary" onClick={closeWindow}>
                  {s.uninstall.close}
                </HkButton>
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
                {uninstallPhase.value === "repair_failed" ? s.uninstall.failedRepair : s.uninstall.failedUninstall}
              </p>
              <p class="wizard-uninstall__error">{uninstallError.value}</p>
              <div class="wizard-uninstall__actions">
                <HkButton variant="primary" onClick={closeWindow}>
                  {s.uninstall.close}
                </HkButton>
              </div>
            </section>
          );

        return (
          <>
            <AppTitleBar icon="/logo.webp" title={s.uninstallTitle} showMaximize={false} />
            <main class="installer">
              <div class="wizard-layout__pane">{uninstallPane}</div>
            </main>
          </>
        );
      }

      const timelineSteps = STEP_KEYS.map((key) => ({
        key,
        label: strings(locale.value).steps[key],
      }));

      const modeItems = [
        {
          id: "local",
          title: s.mode.local.title,
          description: s.mode.local.description,
          badge: s.mode.local.badge,
          icon: MODE_ICONS.local,
        },
        {
          id: "usb",
          title: s.mode.usb.title,
          description: s.mode.usb.description,
          icon: MODE_ICONS.usb,
        },
      ];

      const pane =
        step.value === "mode" ? (
          <section class="wizard-pane">
            <h1>{s.mode.title}</h1>
            <p class="wizard-sub">{s.mode.sub}</p>

            <div class="wizard-language">
              <span class="wizard-language__label" id="locale-label">{s.languageLabel}</span>
              <div class="wizard-language__select">
                <HkSelect
                  modelValue={locale.value}
                  options={LOCALE_OPTIONS}
                  onUpdate:modelValue={changeLocale}
                />
              </div>
            </div>

            <HkSelectionGrid
              items={modeItems}
              selectedId={mode.value}
              columns={modeItems.length as 2}
              onSelect={(item: { id?: string | number | boolean }) => {
                if (step.value !== "mode") return;
                mode.value = (item.id as Mode) ?? "local";
                void refreshDefaults().catch(() => {});
              }}
            />

            <section class="wizard-target">
              <label class="wizard-target__label" for="dir-input">{s.target.label}</label>
              <PathField
                modelValue={dir.value}
                disabled={running.value}
                drives={drives.value}
                labels={s.pathField}
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
                    <HkButton
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
                    </HkButton>
                  );
                })}
              </div>
              <p class="wizard-target__hint">
                {hintKind.value === "error"
                  ? hintError.value
                  : hintKind.value === "usb-detected"
                    ? s.target.hintUsbDetected
                    : hintKind.value === "usb"
                      ? s.target.hintUsb
                      : s.target.hintLocal}
              </p>
              {dirWritable.value === false && (
                <p class="wizard-target__warning">
                  {firstWritableCandidate.value
                    ? s.target.warnUnwritable
                    : s.target.warnNoWritable}
                </p>
              )}
              {identity.value && (
                <p class="wizard-identity">
                  {`WoWSP ${identity.value.version} · `}
                  {identity.value.flavor === "full-webview2"
                    ? s.flavors.fullWebview2
                    : identity.value.flavor === "full"
                      ? s.flavors.full
                      : identity.value.flavor}
                </p>
              )}
            </section>
          </section>
        ) : step.value === "license" ? (
          <section class="wizard-pane">
            <h1>{s.license.title}</h1>
            <p class="wizard-sub">{s.license.sub}</p>
            <AnnouncementCard locale={locale.value} />
            <HkScrollContainer class="license-box" axis="vertical">
              <pre>{licenseDocs.value[licenseIndex.value]?.body ?? ""}</pre>
            </HkScrollContainer>
            {licenseDocs.value.length > 1 && (
              <div class="license-pager">
                <HkButton
                  variant="ghost"
                  size="sm"
                  disabled={licenseIndex.value <= 0}
                  ariaLabel={s.license.prevDoc}
                  onClick={() => (licenseIndex.value -= 1)}
                >
                  <ChevronLeft size={15} />
                </HkButton>
                <span class="license-pager__label">
                  {licenseIndex.value + 1}/{licenseDocs.value.length}{" "}
                  {licenseDocs.value[licenseIndex.value]?.title ?? ""}
                </span>
                <HkButton
                  variant="ghost"
                  size="sm"
                  disabled={licenseIndex.value >= licenseDocs.value.length - 1}
                  ariaLabel={s.license.nextDoc}
                  onClick={() => (licenseIndex.value += 1)}
                >
                  <ChevronRight size={15} />
                </HkButton>
              </div>
            )}
            <HkCheckbox
              modelValue={agreed.value}
              label={s.license.agree}
              onUpdate:modelValue={(v: boolean) => (agreed.value = v)}
            />
          </section>
        ) : step.value === "install" ? (
          <section class="wizard-pane wizard-pane--install">
            <div class="wizard-install__main">
              <img src="/logo.webp" alt="" class="wizard-logo" />
              <p class="wizard-pane__title">WoWSP</p>
              <HkProgressBar
                status="loading"
                size="md"
                value={overall.value ?? undefined}
                showLabel={overall.value != null}
              />
              <p class="wizard-step">{flowStep.value || s.install.fallback}</p>
            </div>
            <div class="wizard-install__logs">
              <LogPane
                lines={logLines.value}
                labels={s.logPane}
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
            <p class="wizard-done__title wizard-done__title--fail">{s.done.failedTitle}</p>
            <p class="wizard-done__error">{failMessage.value}</p>
            <div class="wizard-install__logs">
              <LogPane
                lines={logLines.value}
                labels={s.logPane}
                order={logOrder.value}
                expanded={logExpanded.value}
                onToggleExpanded={() => {
                  logExpanded.value = !logExpanded.value;
                }}
              />
            </div>
            <div class="wizard-done__actions">
              <HkButton variant="primary" onClick={start}>
                {s.done.retry}
              </HkButton>
              <HkButton variant="ghost" onClick={() => tauriWindow()?.close()}>
                {s.done.close}
              </HkButton>
            </div>
          </section>
        ) : (
          <section class="wizard-pane wizard-pane--center wizard-done">
            <CheckCircle2
              size={56}
              color="rgb(var(--color-success))"
              stroke-width={1.5}
            />
            <p class="wizard-done__title">{s.done.title}</p>
            <p class="wizard-done__path">{dir.value.trim()}</p>
            <p class="wizard-done__hint">
            {mode.value === "local" ? s.done.hintLocal : s.done.hintUsb}
            </p>
            <div class="wizard-done__shortcuts">
              {mode.value === "local" && (
                <>
                  <HkCheckbox
                    modelValue={startMenuShortcut.value}
                    label={s.done.shortcutMenu}
                    onUpdate:modelValue={(v: boolean) => toggleMenu(v)}
                  />
                  <HkCheckbox
                    modelValue={desktopShortcut.value}
                    label={s.done.shortcutDesktop}
                    onUpdate:modelValue={(v: boolean) => toggleDesktop(v)}
                  />
                </>
              )}
              <HkCheckbox
                modelValue={launchAfterInstall.value}
                label={s.done.launchAfter}
                onUpdate:modelValue={(v: boolean) => (launchAfterInstall.value = v)}
              />
            </div>
          </section>
        );

      return (
        <>
          <AppTitleBar
            icon="/logo.webp"
            title={s.title}
            subtitle={identity.value ? `v${identity.value.version}` : ""}
            showMaximize={false}
          />
          <main class="installer">
            <div class="wizard-layout wizard-layout--left">
              <HkTimeline
                steps={timelineSteps}
                currentKey={step.value}
                orientation="vertical"
              />
              <div class="wizard-layout__pane">{pane}</div>
            </div>

            {note.value && (
              <HkAlert
                variant={note.value.kind === "err" ? "error" : "success"}
                message={note.value.text}
                banner
              />
            )}

            <footer class="installer__footer">
              <div class="installer__nav">
                {running.value ? null : step.value === "mode" && (
                  <HkButton
                    variant="primary"
                    size="lg"
                    disabled={dirWritable.value === false}
                    onClick={() => go("license")}
                  >
                    {s.nav.next}
                  </HkButton>
                )}
                {step.value === "license" && (
                  <>
                    <HkButton variant="ghost" onClick={() => go("mode")}>
                      {s.nav.back}
                    </HkButton>
                    <HkButton
                      variant="primary"
                      size="lg"
                      disabled={!agreed.value || noticeCountdown.value > 0}
                      onClick={start}
                    >
                      {s.license.agreeInstall(noticeCountdown.value)}
                    </HkButton>
                  </>
                )}
                {step.value === "done" && !installFailed.value && (
                  <HkButton
                    variant="primary"
                    size="lg"
                    disabled={finishing.value}
                    onClick={finish}
                  >
                    {s.done.finish}
                  </HkButton>
                )}
              </div>
            </footer>
          </main>
        </>
      );
    };
  },
});
