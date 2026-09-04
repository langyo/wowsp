import { defineComponent, onMounted, ref } from "vue";
import { Box, Monitor, Usb } from "lucide-vue-next";
import {
  HButton,
  HProgressBar,
  HSelectionGrid,
  HTitleBar,
} from "@celestia-island/hikari";

import { invoke, listen, openDirectory } from "./tauri";

/**
 * Installer shell UI — three WoWSP install modes rendered with hikari
 * components (shared HTitleBar chrome, HSelectionGrid mode picker), driving
 * the silent NSIS engine on the Rust side.
 */

type Mode = "local" | "usb" | "green";

const MODE_ITEMS = [
  {
    id: "local",
    title: "安装到本机",
    description: "标准单用户安装，含开始菜单快捷方式与自动更新。",
    badge: "推荐",
    icon: Monitor,
  },
  {
    id: "usb",
    title: "U 盘（网吧模式）",
    description: "便携副本放在可移动磁盘上，无注册表项，数据全部留在盘内。",
    icon: Usb,
  },
  {
    id: "green",
    title: "绿色版直接运行",
    description: "解压到指定文件夹独立运行，与本机安装完全隔离。",
    icon: Box,
  },
];

const HINTS: Record<Mode, string> = {
  local: "数据写入 %APPDATA%，可自动更新；卸载信息会登记到系统。",
  usb: "检测到可移动磁盘时自动定位；否则回退到本机路径。",
  green: "默认解压到安装器旁边，可改为任意可写目录。",
};

interface DirDefaults {
  dir: string;
  removable: boolean;
}

export default defineComponent({
  name: "InstallerApp",
  setup() {
    const mode = ref<Mode>("local");
    const dir = ref("");
    const hint = ref("");
    const running = ref(false);
    const done = ref(false);
    const step = ref("");
    const note = ref("");
    const noteKind = ref<"" | "ok" | "err">("");

    async function refreshDefaults() {
      const defaults = await invoke<DirDefaults>("default_dir", {
        mode: mode.value,
      });
      dir.value = defaults.dir;
      hint.value =
        mode.value === "usb" && defaults.removable
          ? "已检测到可移动磁盘。"
          : mode.value === "usb"
            ? "未检测到可移动磁盘，暂时使用本机路径。"
            : HINTS[mode.value];
    }

    onMounted(() => {
      refreshDefaults().catch((err) => {
        hint.value = String(err);
      });
      listen<{ step: string }>("install-progress", (payload) => {
        step.value = payload.step;
      });
    });

    async function selectMode(id: string | number | boolean | undefined) {
      if (running.value || done.value) return;
      mode.value = (id as Mode) ?? "local";
      await refreshDefaults().catch((err) => {
        hint.value = String(err);
      });
    }

    async function browse() {
      if (running.value || done.value) return;
      const picked = await openDirectory("选择安装位置");
      if (picked) dir.value = picked;
    }

    async function start() {
      if (running.value || done.value) return;
      running.value = true;
      note.value = "";
      noteKind.value = "";
      step.value = "正在准备安装…";
      try {
        await invoke("start_install", {
          mode: mode.value,
          dir: dir.value.trim(),
        });
        done.value = true;
        note.value = `✔ 安装完成：${dir.value.trim()}`;
        noteKind.value = "ok";
      } catch (err) {
        running.value = false;
        step.value = "";
        note.value = String(err);
        noteKind.value = "err";
      }
    }

    return () => (
      <>
        <HTitleBar logoSrc="/logo.webp" appName="WoWSP 安装器" maximizable={false} />
        <main class="installer">
          <section class="installer__hero">
            <h1>选择 WoWSP 的安装方式</h1>
            <p>选择此副本的安装方式及其数据存放位置。</p>
          </section>

          <HSelectionGrid
            items={MODE_ITEMS}
            selectedId={mode.value}
            columns={3}
            onSelect={(item: { id?: string | number | boolean }) => selectMode(item.id)}
          />

          <section class="installer__target">
            <label class="installer__label" for="dir-input">
              安装位置
            </label>
            <div class="installer__row">
              <input
                id="dir-input"
                type="text"
                spellcheck={false}
                v-model={dir.value}
                disabled={running.value || done.value}
              />
              <HButton variant="ghost" disabled={running.value || done.value} onClick={browse}>
                浏览…
              </HButton>
            </div>
            <p class="installer__hint">{hint.value}</p>
          </section>

          {running.value && (
            <section class="installer__progress">
              <HProgressBar status="loading" size="md" />
              {step.value && <p class="installer__step">{step.value}</p>}
            </section>
          )}
          {done.value && (
            <section class="installer__progress">
              <HProgressBar status="done" size="md" />
            </section>
          )}

          <footer class="installer__footer">
            {note.value && (
              <p class={`installer__note installer__note--${noteKind.value || "muted"}`}>
                {note.value}
              </p>
            )}
            <HButton
              variant="primary"
              size="lg"
              disabled={running.value || done.value}
              onClick={start}
            >
              {done.value ? "已完成" : "开始安装"}
            </HButton>
          </footer>
        </main>
      </>
    );
  },
});
