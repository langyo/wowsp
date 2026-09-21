/**
 * Minimal i18n layer for the installer shell. The wizard offers four
 * self-named locales (简体中文 / 繁體中文 / English / Русский); every
 * user-visible string in App.tsx and the components resolves from
 * `strings(locale)` per render, so a locale switch re-renders everything
 * live. zh-Hans is the original copy (kept verbatim); the other three are
 * authored translations. The AnnouncementCard (announcement.ts) carries
 * its own per-locale content and receives the wizard locale as a prop —
 * its variant list is out of this table's scope. The LogPane's structural
 * chrome (title / expand / collapse) lives in `logPane` and reaches the
 * component as props, and the composed log LINES (backend progress verbs,
 * file echoes, script starts) resolve from `install.progress` against the
 * picked locale too — unknown backend verbs still pass through verbatim
 * (the backend's flow labels are English).
 */

export const LOCALES = ["zh-Hans", "zh-Hant", "en", "ru"] as const;
export type InstallerLocale = (typeof LOCALES)[number];

/** Terminal fallback of the locale resolution chain (saved pref →
 *  system → this). */
export const DEFAULT_LOCALE: InstallerLocale = "zh-Hans";

/** Each locale, named in its own script — the picker's option labels. */
export const LOCALE_LABELS: Record<InstallerLocale, string> = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  en: "English",
  ru: "Русский",
};

/** HSelect options for the picker, in display order. */
export const LOCALE_OPTIONS: { value: InstallerLocale; label: string }[] =
  LOCALES.map((locale) => ({ value: locale, label: LOCALE_LABELS[locale] }));

export function isInstallerLocale(value: unknown): value is InstallerLocale {
  return (
    typeof value === "string" &&
    (LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Map a raw BCP-47 tag (navigator.language) onto a wizard locale:
 * zh-TW / zh-HK / zh-Hant* → zh-Hant, any other zh* → zh-Hans,
 * ru* → ru, everything else → en.
 */
export function resolveSystemLocale(tag: string): InstallerLocale {
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) {
    if (
      lower.startsWith("zh-tw") ||
      lower.startsWith("zh-hk") ||
      lower.startsWith("zh-hant")
    ) {
      return "zh-Hant";
    }
    return "zh-Hans";
  }
  if (lower.startsWith("ru")) return "ru";
  return "en";
}

/** The install-location editor's strings (PathField consumes them via a
 *  prop; the drive-kind labels moved here from the component). */
export interface PathFieldStrings {
  browse: string;
  /** Chip fallback when the value starts with no known mount. */
  diskChip: string;
  /** The picker chip's tooltip. */
  chipLabel: string;
  /** The popup's title. */
  pickerTitle: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Drive-kind → meta text, keyed by the backend's `kind` values. */
  kinds: Record<string, string>;
}

/** The LogPane's structural chrome (the composed per-line texts live in
 *  `install.progress`). */
export interface LogPaneStrings {
  /** Pane title shown in the collapsed bar. */
  title: string;
  /** Toggle tooltips. */
  expand: string;
  collapse: string;
}

/** Install-flow progress lines: the backend composes English labels, the
 *  known ones render localized, everything else passes through verbatim. */
export interface ProgressStrings {
  /** The shell's pre-kill notice before an overwrite install. */
  stopApp: string;
  removedStale(count: number): string;
  /** Backend flow verbs (Extracting / Reusing / …) → localized prefix. */
  verbs: Record<string, string>;
  /** Flow-phase fallbacks (shun's phase enum → a human line). */
  phases: { download: string; extract: string; register: string; fallback: string };
  /** Structured log-record lines. */
  writing(path: string): string;
  reusing(path: string): string;
  runningScript(name: string): string;
}

export interface InstallerStrings {
  /** Title-bar text for the installer window. */
  title: string;
  /** Title-bar text for the uninstall window. */
  uninstallTitle: string;
  /** The language picker's row label on the mode step. */
  languageLabel: string;
  steps: { mode: string; license: string; install: string; done: string };
  mode: {
    title: string;
    sub: string;
    local: { title: string; description: string; badge: string };
    usb: { title: string; description: string };
  };
  target: {
    label: string;
    /** Native directory-dialog title. */
    dialogTitle: string;
    hintLocal: string;
    hintUsb: string;
    hintUsbDetected: string;
    warnUnwritable: string;
    warnNoWritable: string;
    /** Note shown after the root-drive nesting pass rewrites the path. */
    nestedNote: string;
  };
  flavors: { full: string; fullWebview2: string };
  license: {
    title: string;
    sub: string;
    agree: string;
    prevDoc: string;
    nextDoc: string;
    /** The license step's primary button, with its notice countdown. */
    agreeInstall(countdown: number): string;
  };
  install: {
    preparing: string;
    startedLog: string;
    fallback: string;
    progress: ProgressStrings;
  };
  done: {
    failedTitle: string;
    title: string;
    hintLocal: string;
    hintUsb: string;
    shortcutMenu: string;
    shortcutDesktop: string;
    launchAfter: string;
    finish: string;
    retry: string;
    close: string;
  };
  nav: { next: string; back: string };
  logPane: LogPaneStrings;
  uninstall: {
    heading: string;
    sub: string;
    cancel: string;
    repair: string;
    uninstall: string;
    close: string;
    uninstalling: string;
    repairing: string;
    doneUninstall: string;
    doneRepair: string;
    failedUninstall: string;
    failedRepair: string;
  };
  pathField: PathFieldStrings;
}

const zhHans: InstallerStrings = {
  title: "WoWSP 安装器",
  uninstallTitle: "WoWSP 卸载",
  languageLabel: "安装向导语言",
  steps: { mode: "安装方式", license: "用户协议", install: "安装", done: "完成" },
  mode: {
    title: "选择 WoWSP 的安装方式",
    sub: "选择此副本的安装方式及其数据存放位置；2D / 3D 模型资源包将一并安装。",
    local: {
      title: "安装到本机",
      description: "标准单用户安装，含开始菜单快捷方式与自动更新。",
      badge: "推荐",
    },
    usb: {
      title: "U 盘（网吧模式）",
      description: "便携副本放在可移动磁盘上，无注册表项，数据全部留在盘内。",
    },
  },
  target: {
    label: "安装位置",
    dialogTitle: "选择安装位置",
    hintLocal: "数据写入 %APPDATA%，可自动更新；卸载信息会登记到系统。",
    hintUsb: "检测到可移动磁盘时自动定位；否则回退到本机路径。",
    hintUsbDetected: "已检测到可移动磁盘。",
    warnUnwritable: "当前目录不可写，安装会被拒绝——建议选择上方标亮的候选位置。",
    warnNoWritable: "未检测到可写的候选位置，请手动选择有权限的目录。",
    nestedNote: "已自动垫一层文件夹，避免直接安装到盘符根目录。",
  },
  flavors: {
    full: "完整版 · 含 2D/3D 模型资源包",
    fullWebview2: "完整版 · 含 2D/3D 模型资源包与 WebView2 运行时",
  },
  license: {
    title: "用户协议",
    sub: "安装前请阅读以下协议文档；勾选即代表同意全部内容。",
    agree: "我已阅读并同意上述全部协议",
    prevDoc: "上一篇协议文档",
    nextDoc: "下一篇协议文档",
    agreeInstall: (countdown) =>
      countdown > 0 ? `同意并安装（${countdown} 秒）` : "同意并安装",
  },
  install: {
    preparing: "正在准备安装…",
    startedLog: "开始安装",
    fallback: "正在安装 WoWSP，这可能需要一点时间…",
    progress: {
      stopApp: "正在停止运行中的 WoWSP",
      removedStale: (count) => `已移除 ${count} 个旧版残留文件`,
      verbs: {
        Extracting: "正在解压",
        Reusing: "正在复用",
        Downloading: "正在下载",
        Registering: "正在登记",
        Writing: "正在写入",
      },
      phases: {
        download: "正在下载资源",
        extract: "正在解压文件",
        register: "正在登记系统信息",
        fallback: "正在安装",
      },
      writing: (path) => `写入 ${path}`,
      reusing: (path) => `复用 ${path}`,
      runningScript: (name) => `运行脚本 ${name}`,
    },
  },
  done: {
    failedTitle: "安装失败",
    title: "✔ 安装完成",
    hintLocal:
      "WoWSP 已登记到系统「应用」列表；勾选的快捷方式会在点击「完成安装」时创建。",
    hintUsb: "便携副本已就绪：数据全部留在可移动磁盘内。",
    shortcutMenu: "创建开始菜单快捷方式",
    shortcutDesktop: "创建桌面快捷方式",
    launchAfter: "安装完成后立即启动 WoWSP",
    finish: "完成安装",
    retry: "重试安装",
    close: "关闭",
  },
  nav: { next: "下一步", back: "上一步" },
  logPane: { title: "安装日志", expand: "展开安装日志", collapse: "收起安装日志" },
  uninstall: {
    heading: "卸载 WoWSP",
    sub: "这将移除 WoWSP 及其注册的系统项。模型资源与用户数据将保留。",
    cancel: "取消",
    repair: "修复安装",
    uninstall: "卸载",
    close: "关闭",
    uninstalling: "正在卸载…",
    repairing: "正在修复…",
    doneUninstall: "已完成卸载",
    doneRepair: "已完成修复",
    failedUninstall: "卸载失败",
    failedRepair: "修复失败",
  },
  pathField: {
    browse: "浏览…",
    diskChip: "磁盘",
    chipLabel: "选择安装所在的磁盘",
    pickerTitle: "选择磁盘",
    searchPlaceholder: "搜索磁盘或卷标",
    emptyText: "未找到匹配的磁盘",
    kinds: {
      removable: "可移动磁盘",
      fixed: "本地磁盘",
      network: "网络磁盘",
      cdrom: "光盘",
      ramdisk: "RAM 盘",
      unknown: "未知磁盘",
    },
  },
};

const zhHant: InstallerStrings = {
  title: "WoWSP 安裝器",
  uninstallTitle: "WoWSP 解除安裝",
  languageLabel: "安裝精靈語言",
  steps: { mode: "安裝方式", license: "使用者協議", install: "安裝", done: "完成" },
  mode: {
    title: "選擇 WoWSP 的安裝方式",
    sub: "選擇此副本的安裝方式及其資料存放位置；2D / 3D 模型資源包將一併安裝。",
    local: {
      title: "安裝到本機",
      description: "標準單使用者安裝，含開始功能表捷徑與自動更新。",
      badge: "推薦",
    },
    usb: {
      title: "隨身碟（網咖模式）",
      description: "可攜副本放在可移動磁碟上，無登錄項目，資料全部留在碟內。",
    },
  },
  target: {
    label: "安裝位置",
    dialogTitle: "選擇安裝位置",
    hintLocal: "資料寫入 %APPDATA%，可自動更新；解除安裝資訊會登錄到系統。",
    hintUsb: "偵測到可移動磁碟時自動定位；否則回退到本機路徑。",
    hintUsbDetected: "已偵測到可移動磁碟。",
    warnUnwritable: "目前目錄不可寫，安裝會被拒絕——建議選擇上方標亮的候選位置。",
    warnNoWritable: "未偵測到可寫的候選位置，請手動選擇有權限的目錄。",
    nestedNote: "已自動墊一層資料夾，避免直接安裝到磁碟根目錄。",
  },
  flavors: {
    full: "完整版 · 含 2D/3D 模型資源包",
    fullWebview2: "完整版 · 含 2D/3D 模型資源包與 WebView2 執行階段",
  },
  license: {
    title: "使用者協議",
    sub: "安裝前請閱讀以下協議文件；勾選即代表同意全部內容。",
    agree: "我已閱讀並同意上述全部協議",
    prevDoc: "上一篇協議文件",
    nextDoc: "下一篇協議文件",
    agreeInstall: (countdown) =>
      countdown > 0 ? `同意並安裝（${countdown} 秒）` : "同意並安裝",
  },
  install: {
    preparing: "正在準備安裝…",
    startedLog: "開始安裝",
    fallback: "正在安裝 WoWSP，這可能需要一點時間…",
    progress: {
      stopApp: "正在停止執行中的 WoWSP",
      removedStale: (count) => `已移除 ${count} 個舊版殘留檔案`,
      verbs: {
        Extracting: "正在解壓",
        Reusing: "正在複用",
        Downloading: "正在下載",
        Registering: "正在登記",
        Writing: "正在寫入",
      },
      phases: {
        download: "正在下載資源",
        extract: "正在解壓檔案",
        register: "正在登錄系統資訊",
        fallback: "正在安裝",
      },
      writing: (path) => `寫入 ${path}`,
      reusing: (path) => `複用 ${path}`,
      runningScript: (name) => `執行腳本 ${name}`,
    },
  },
  done: {
    failedTitle: "安裝失敗",
    title: "✔ 安裝完成",
    hintLocal:
      "WoWSP 已登錄到系統「應用程式」清單；勾選的捷徑會在點擊「完成安裝」時建立。",
    hintUsb: "可攜副本已就緒：資料全部留在可移動磁碟內。",
    shortcutMenu: "建立開始功能表捷徑",
    shortcutDesktop: "建立桌面捷徑",
    launchAfter: "安裝完成後立即啟動 WoWSP",
    finish: "完成安裝",
    retry: "重試安裝",
    close: "關閉",
  },
  nav: { next: "下一步", back: "上一步" },
  logPane: { title: "安裝日誌", expand: "展開安裝日誌", collapse: "收起安裝日誌" },
  uninstall: {
    heading: "解除安裝 WoWSP",
    sub: "這將移除 WoWSP 及其登錄的系統項目。模型資源與使用者資料將保留。",
    cancel: "取消",
    repair: "修復安裝",
    uninstall: "解除安裝",
    close: "關閉",
    uninstalling: "正在解除安裝…",
    repairing: "正在修復…",
    doneUninstall: "已完成解除安裝",
    doneRepair: "已完成修復",
    failedUninstall: "解除安裝失敗",
    failedRepair: "修復失敗",
  },
  pathField: {
    browse: "瀏覽…",
    diskChip: "磁碟",
    chipLabel: "選擇安裝所在的磁碟",
    pickerTitle: "選擇磁碟",
    searchPlaceholder: "搜尋磁碟或卷標",
    emptyText: "未找到符合的磁碟",
    kinds: {
      removable: "可移動磁碟",
      fixed: "本機磁碟",
      network: "網路磁碟",
      cdrom: "光碟",
      ramdisk: "RAM 碟",
      unknown: "未知磁碟",
    },
  },
};

const en: InstallerStrings = {
  title: "WoWSP Installer",
  uninstallTitle: "Uninstall WoWSP",
  languageLabel: "Installer language",
  steps: { mode: "Mode", license: "License", install: "Install", done: "Done" },
  mode: {
    title: "Choose how to install WoWSP",
    sub: "Choose how this copy is installed and where its data lives; the 2D / 3D model packs are installed along with it.",
    local: {
      title: "Install on this PC",
      description: "Standard single-user install with a Start-menu shortcut and auto-updates.",
      badge: "Recommended",
    },
    usb: {
      title: "USB drive (internet café)",
      description: "A portable copy on a removable drive — no registry entries, all data stays on the drive.",
    },
  },
  target: {
    label: "Install location",
    dialogTitle: "Choose the install location",
    hintLocal: "Data is written to %APPDATA% with auto-updates; the uninstall entry is registered with the system.",
    hintUsb: "Located automatically when a removable drive is present; otherwise falls back to a local path.",
    hintUsbDetected: "Removable drive detected.",
    warnUnwritable: "The current directory is not writable and the install would be rejected — pick one of the highlighted candidates above.",
    warnNoWritable: "No writable candidate location was found — pick a directory you have access to.",
    nestedNote: "A folder layer was added automatically so the payload never lands on the drive root.",
  },
  flavors: {
    full: "Full edition · includes the 2D/3D model packs",
    fullWebview2: "Full edition · includes the 2D/3D model packs and the WebView2 runtime",
  },
  license: {
    title: "License agreement",
    sub: "Read the agreement documents below before installing; checking the box means you accept all of them.",
    agree: "I have read and accept all of the agreements above",
    prevDoc: "Previous document",
    nextDoc: "Next document",
    agreeInstall: (countdown) =>
      countdown > 0 ? `Agree & install (${countdown} s)` : "Agree & install",
  },
  install: {
    preparing: "Preparing the install…",
    startedLog: "Install started",
    fallback: "Installing WoWSP — this may take a moment…",
    progress: {
      stopApp: "Stopping the running WoWSP",
      removedStale: (count) => `Removed ${count} stale file(s) from the previous install`,
      // The backend's flow labels are already English — unknown or known
      // verbs alike pass through with the subject appended only when a
      // localized prefix exists.
      verbs: {
        Extracting: "Extracting",
        Reusing: "Reusing",
        Downloading: "Downloading",
        Registering: "Registering",
        Writing: "Writing",
      },
      phases: {
        download: "Downloading resources",
        extract: "Extracting files",
        register: "Registering system entries",
        fallback: "Installing",
      },
      writing: (path) => `Writing ${path}`,
      reusing: (path) => `Reusing ${path}`,
      runningScript: (name) => `Running ${name}`,
    },
  },
  done: {
    failedTitle: "Install failed",
    title: "✔ Install complete",
    hintLocal: "WoWSP is registered in the system's app list; the checked shortcuts are created when you click Finish.",
    hintUsb: "The portable copy is ready: all data stays on the removable drive.",
    shortcutMenu: "Create a Start-menu shortcut",
    shortcutDesktop: "Create a desktop shortcut",
    launchAfter: "Launch WoWSP right after the install finishes",
    finish: "Finish",
    retry: "Retry install",
    close: "Close",
  },
  nav: { next: "Next", back: "Back" },
  logPane: { title: "Install log", expand: "Expand install log", collapse: "Collapse install log" },
  uninstall: {
    heading: "Uninstall WoWSP",
    sub: "This removes WoWSP and the system entries it registered. Model resources and user data are kept.",
    cancel: "Cancel",
    repair: "Repair install",
    uninstall: "Uninstall",
    close: "Close",
    uninstalling: "Uninstalling…",
    repairing: "Repairing…",
    doneUninstall: "Uninstall complete",
    doneRepair: "Repair complete",
    failedUninstall: "Uninstall failed",
    failedRepair: "Repair failed",
  },
  pathField: {
    browse: "Browse…",
    diskChip: "Drive",
    chipLabel: "Pick the drive to install on",
    pickerTitle: "Choose a drive",
    searchPlaceholder: "Search drives or volume labels",
    emptyText: "No matching drive",
    kinds: {
      removable: "Removable drive",
      fixed: "Local disk",
      network: "Network drive",
      cdrom: "Optical drive",
      ramdisk: "RAM disk",
      unknown: "Unknown drive",
    },
  },
};

const ru: InstallerStrings = {
  title: "Установщик WoWSP",
  uninstallTitle: "Удаление WoWSP",
  languageLabel: "Язык установщика",
  steps: { mode: "Режим", license: "Лицензия", install: "Установка", done: "Готово" },
  mode: {
    title: "Выберите способ установки WoWSP",
    sub: "Выберите способ установки этой копии и место хранения её данных; пакеты 2D / 3D-моделей устанавливаются вместе с ней.",
    local: {
      title: "Установить на этот компьютер",
      description: "Обычная установка для одного пользователя: ярлык в меню «Пуск» и автообновление.",
      badge: "Рекомендуется",
    },
    usb: {
      title: "USB-накопитель (интернет-кафе)",
      description: "Портативная копия на съёмном диске: без записей в реестре, все данные остаются на диске.",
    },
  },
  target: {
    label: "Папка установки",
    dialogTitle: "Выберите папку установки",
    hintLocal: "Данные записываются в %APPDATA%, доступно автообновление; сведения об удалении регистрируются в системе.",
    hintUsb: "Определяется автоматически при наличии съёмного диска; иначе используется локальный путь.",
    hintUsbDetected: "Съёмный диск обнаружен.",
    warnUnwritable: "Текущий каталог недоступен для записи, установка будет отклонена — выберите один из подсвеченных вариантов выше.",
    warnNoWritable: "Доступных для записи вариантов не найдено — выберите папку, к которой у вас есть доступ.",
    nestedNote: "Автоматически добавлен уровень папки, чтобы установка не шла в корень диска.",
  },
  flavors: {
    full: "Полная версия · с наборами 2D/3D-моделей",
    fullWebview2: "Полная версия · с наборами 2D/3D-моделей и средой WebView2",
  },
  license: {
    title: "Лицензионное соглашение",
    sub: "Перед установкой прочитайте документы соглашения ниже; установка флажка означает согласие со всеми ними.",
    agree: "Я прочитал(а) и принимаю все указанные выше соглашения",
    prevDoc: "Предыдущий документ",
    nextDoc: "Следующий документ",
    agreeInstall: (countdown) =>
      countdown > 0 ? `Принять и установить (${countdown} с)` : "Принять и установить",
  },
  install: {
    preparing: "Подготовка к установке…",
    startedLog: "Установка начата",
    fallback: "Установка WoWSP — это может занять некоторое время…",
    progress: {
      stopApp: "Остановка запущенного WoWSP",
      removedStale: (count) => `Удалено файлов от предыдущей установки: ${count}`,
      verbs: {
        Extracting: "Распаковка",
        Reusing: "Пропуск (уже извлечено)",
        Downloading: "Загрузка",
        Registering: "Регистрация",
        Writing: "Запись",
      },
      phases: {
        download: "Загрузка ресурсов",
        extract: "Распаковка файлов",
        register: "Регистрация в системе",
        fallback: "Установка",
      },
      writing: (path) => `Запись ${path}`,
      reusing: (path) => `Пропуск (уже извлечено): ${path}`,
      runningScript: (name) => `Запуск скрипта ${name}`,
    },
  },
  done: {
    failedTitle: "Установка не удалась",
    title: "✔ Установка завершена",
    hintLocal: "WoWSP зарегистрирован в списке приложений системы; выбранные ярлыки будут созданы после нажатия «Готово».",
    hintUsb: "Портативная копия готова: все данные остаются на съёмном диске.",
    shortcutMenu: "Создать ярлык в меню «Пуск»",
    shortcutDesktop: "Создать ярлык на рабочем столе",
    launchAfter: "Запустить WoWSP сразу после установки",
    finish: "Готово",
    retry: "Повторить установку",
    close: "Закрыть",
  },
  nav: { next: "Далее", back: "Назад" },
  logPane: { title: "Журнал установки", expand: "Развернуть журнал установки", collapse: "Свернуть журнал установки" },
  uninstall: {
    heading: "Удалить WoWSP",
    sub: "Это удалит WoWSP и зарегистрированные им системные записи. Ресурсы моделей и пользовательские данные сохранятся.",
    cancel: "Отмена",
    repair: "Восстановить",
    uninstall: "Удалить",
    close: "Закрыть",
    uninstalling: "Удаление…",
    repairing: "Восстановление…",
    doneUninstall: "Удаление завершено",
    doneRepair: "Восстановление завершено",
    failedUninstall: "Не удалось удалить",
    failedRepair: "Не удалось восстановить",
  },
  pathField: {
    browse: "Обзор…",
    diskChip: "Диск",
    chipLabel: "Выберите диск для установки",
    pickerTitle: "Выбор диска",
    searchPlaceholder: "Поиск по дискам и меткам томов",
    emptyText: "Подходящих дисков не найдено",
    kinds: {
      removable: "Съёмный диск",
      fixed: "Локальный диск",
      network: "Сетевой диск",
      cdrom: "Оптический диск",
      ramdisk: "RAM-диск",
      unknown: "Неизвестный диск",
    },
  },
};

const TABLE: Record<InstallerLocale, InstallerStrings> = {
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  en,
  ru,
};

/** The full string table for one locale. Computed per render in App.tsx,
 *  so a locale switch re-renders everything live. */
export function strings(locale: InstallerLocale): InstallerStrings {
  return TABLE[locale] ?? zhHans;
}
