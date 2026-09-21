/**
 * Minimal i18n layer for the installer shell. The wizard offers ten
 * self-named locales (简体中文 / 繁體中文 / English / Русский / 日本語 /
 * 한국어 / Français / Español / Deutsch / Português); every user-visible
 * string in App.tsx and the components resolves from `strings(locale)`
 * per render, so a locale switch re-renders everything live. zh-Hans is
 * the original copy (kept verbatim); the other nine are authored
 * translations. The AnnouncementCard (announcement.ts) carries its own
 * per-locale content and receives the wizard locale as a prop — its
 * variant list is out of this table's scope. The LogPane's structural
 * chrome (title / expand / collapse) lives in `logPane` and reaches the
 * component as props, and the composed log LINES (backend progress
 * verbs, file echoes, script starts) resolve from `install.progress`
 * against the picked locale too — unknown backend verbs still pass
 * through verbatim (the backend's flow labels are English).
 */

export const LOCALES = [
  "zh-Hans",
  "zh-Hant",
  "en",
  "ru",
  "ja",
  "ko",
  "fr",
  "es",
  "de",
  "pt",
] as const;
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
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
  pt: "Português",
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
 * ru* → ru, ja* → ja, ko* → ko, fr* → fr, es* → es, de* → de,
 * pt* → pt, everything else → en.
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
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("fr")) return "fr";
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("de")) return "de";
  if (lower.startsWith("pt")) return "pt";
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

const ja: InstallerStrings = {
  title: "WoWSP インストーラー",
  uninstallTitle: "WoWSP のアンインストール",
  languageLabel: "インストーラーの言語",
  steps: {
    mode: "インストール方式",
    license: "使用許諾契約",
    install: "インストール",
    done: "完了",
  },
  mode: {
    title: "WoWSP のインストール方式を選択",
    sub: "このコピーのインストール方法とデータの保存先を選択してください。2D / 3D モデルパックも一緒にインストールされます。",
    local: {
      title: "この PC にインストール",
      description:
        "スタートメニューのショートカットと自動更新付きの、標準的なシングルユーザーインストールです。",
      badge: "推奨",
    },
    usb: {
      title: "USB ドライブ（ネットカフェモード）",
      description:
        "リムーバブルドライブ上のポータブルコピー。レジストリ項目は作成せず、データはすべてドライブ内に保存されます。",
    },
  },
  target: {
    label: "インストール先",
    dialogTitle: "インストール先を選択",
    hintLocal:
      "データは %APPDATA% に書き込まれ、自動更新が利用できます。アンインストール情報もシステムに登録されます。",
    hintUsb:
      "リムーバブルドライブが検出されれば自動的に選択され、なければローカルパスに切り替わります。",
    hintUsbDetected: "リムーバブルドライブを検出しました。",
    warnUnwritable:
      "現在のディレクトリは書き込み不可のため、インストールできません。上の強調表示された候補から選んでください。",
    warnNoWritable:
      "書き込み可能な候補場所が見つかりません。アクセス権のあるディレクトリを手動で選択してください。",
    nestedNote:
      "ドライブのルートに直接インストールされないよう、フォルダーを一階層自動で追加しました。",
  },
  flavors: {
    full: "完全版 · 2D/3D モデルパック同梱",
    fullWebview2: "完全版 · 2D/3D モデルパックと WebView2 ランタイム同梱",
  },
  license: {
    title: "使用許諾契約",
    sub: "インストールの前に以下の契約書をお読みください。チェックを入れると、すべての内容に同意したものとみなされます。",
    agree: "上記のすべての契約を読み、同意しました",
    prevDoc: "前の契約書",
    nextDoc: "次の契約書",
    agreeInstall: (countdown) =>
      countdown > 0 ? `同意してインストール（${countdown} 秒）` : "同意してインストール",
  },
  install: {
    preparing: "インストールを準備しています…",
    startedLog: "インストール開始",
    fallback: "WoWSP をインストールしています。しばらくお待ちください…",
    progress: {
      stopApp: "実行中の WoWSP を停止しています",
      removedStale: (count) => `旧バージョンの残りファイルを ${count} 件削除しました`,
      verbs: {
        Extracting: "展開中",
        Reusing: "再利用中",
        Downloading: "ダウンロード中",
        Registering: "登録中",
        Writing: "書き込み中",
      },
      phases: {
        download: "リソースをダウンロードしています",
        extract: "ファイルを展開しています",
        register: "システム情報を登録しています",
        fallback: "インストールしています",
      },
      writing: (path) => `${path} を書き込み中`,
      reusing: (path) => `${path} を再利用`,
      runningScript: (name) => `スクリプト ${name} を実行中`,
    },
  },
  done: {
    failedTitle: "インストールに失敗しました",
    title: "✔ インストール完了",
    hintLocal:
      "WoWSP はシステムのアプリ一覧に登録されました。チェックしたショートカットは「インストール完了」をクリックしたときに作成されます。",
    hintUsb: "ポータブルコピーの準備ができました。データはすべてリムーバブルドライブ内に保存されます。",
    shortcutMenu: "スタートメニューのショートカットを作成",
    shortcutDesktop: "デスクトップのショートカットを作成",
    launchAfter: "インストール完了後、すぐに WoWSP を起動する",
    finish: "インストール完了",
    retry: "インストールを再試行",
    close: "閉じる",
  },
  nav: { next: "次へ", back: "戻る" },
  logPane: {
    title: "インストールログ",
    expand: "インストールログを展開",
    collapse: "インストールログを折りたたむ",
  },
  uninstall: {
    heading: "WoWSP をアンインストール",
    sub: "WoWSP と、それが登録したシステム項目を削除します。モデルリソースとユーザーデータは保持されます。",
    cancel: "キャンセル",
    repair: "インストールを修復",
    uninstall: "アンインストール",
    close: "閉じる",
    uninstalling: "アンインストールしています…",
    repairing: "修復しています…",
    doneUninstall: "アンインストールが完了しました",
    doneRepair: "修復が完了しました",
    failedUninstall: "アンインストールに失敗しました",
    failedRepair: "修復に失敗しました",
  },
  pathField: {
    browse: "参照…",
    diskChip: "ドライブ",
    chipLabel: "インストール先のドライブを選択",
    pickerTitle: "ドライブを選択",
    searchPlaceholder: "ドライブやボリューム ラベルを検索",
    emptyText: "一致するドライブがありません",
    kinds: {
      removable: "リムーバブルドライブ",
      fixed: "ローカルディスク",
      network: "ネットワークドライブ",
      cdrom: "光学ドライブ",
      ramdisk: "RAM ディスク",
      unknown: "不明なドライブ",
    },
  },
};

const ko: InstallerStrings = {
  title: "WoWSP 설치 관리자",
  uninstallTitle: "WoWSP 제거",
  languageLabel: "설치 관리자 언어",
  steps: {
    mode: "설치 방식",
    license: "사용권 계약",
    install: "설치",
    done: "완료",
  },
  mode: {
    title: "WoWSP 설치 방식 선택",
    sub: "이 복사본의 설치 방식과 데이터 저장 위치를 선택하세요. 2D / 3D 모델 팩도 함께 설치됩니다.",
    local: {
      title: "이 PC에 설치",
      description:
        "시작 메뉴 바로 가기와 자동 업데이트가 포함된 표준 단일 사용자 설치입니다.",
      badge: "권장",
    },
    usb: {
      title: "USB 드라이브 (PC방 모드)",
      description:
        "이동식 드라이브에 담는 휴대용 복사본입니다. 레지스트리 항목 없이 모든 데이터를 드라이브 안에 보관합니다.",
    },
  },
  target: {
    label: "설치 위치",
    dialogTitle: "설치 위치 선택",
    hintLocal:
      "데이터는 %APPDATA%에 기록되며 자동 업데이트를 사용할 수 있습니다. 제거 정보도 시스템에 등록됩니다.",
    hintUsb: "이동식 드라이브가 있으면 자동으로 지정되고, 없으면 로컬 경로로 대체됩니다.",
    hintUsbDetected: "이동식 드라이브가 감지되었습니다.",
    warnUnwritable:
      "현재 디렉터리는 쓸 수 없어 설치가 거부됩니다. 위에서 밝게 표시된 후보 위치를 선택하세요.",
    warnNoWritable:
      "쓸 수 있는 후보 위치를 찾지 못했습니다. 권한이 있는 디렉터리를 직접 선택하세요.",
    nestedNote:
      "드라이브 루트에 바로 설치되지 않도록 폴더를 한 단계 자동으로 추가했습니다.",
  },
  flavors: {
    full: "풀 버전 · 2D/3D 모델 팩 포함",
    fullWebview2: "풀 버전 · 2D/3D 모델 팩 및 WebView2 런타임 포함",
  },
  license: {
    title: "사용권 계약",
    sub: "설치하기 전에 아래의 계약 문서를 읽어 주세요. 확인란을 선택하면 모든 내용에 동의한 것으로 간주됩니다.",
    agree: "위의 모든 계약을 읽었으며 이에 동의합니다",
    prevDoc: "이전 문서",
    nextDoc: "다음 문서",
    agreeInstall: (countdown) =>
      countdown > 0 ? `동의 후 설치 (${countdown}초)` : "동의 후 설치",
  },
  install: {
    preparing: "설치를 준비하는 중…",
    startedLog: "설치 시작",
    fallback: "WoWSP를 설치하는 중입니다. 시간이 조금 걸릴 수 있습니다…",
    progress: {
      stopApp: "실행 중인 WoWSP를 중지하는 중",
      removedStale: (count) => `이전 설치의 잔여 파일 ${count}개를 제거했습니다`,
      verbs: {
        Extracting: "압축 풀기",
        Reusing: "재사용",
        Downloading: "다운로드",
        Registering: "등록",
        Writing: "쓰기",
      },
      phases: {
        download: "리소스를 다운로드하는 중",
        extract: "파일을 푸는 중",
        register: "시스템 정보를 등록하는 중",
        fallback: "설치하는 중",
      },
      writing: (path) => `${path} 쓰는 중`,
      reusing: (path) => `${path} 재사용`,
      runningScript: (name) => `스크립트 ${name} 실행 중`,
    },
  },
  done: {
    failedTitle: "설치 실패",
    title: "✔ 설치 완료",
    hintLocal:
      "WoWSP가 시스템의 앱 목록에 등록되었습니다. 선택한 바로 가기는 '설치 완료'를 클릭할 때 만들어집니다.",
    hintUsb: "휴대용 복사본이 준비되었습니다. 모든 데이터는 이동식 드라이브 안에 보관됩니다.",
    shortcutMenu: "시작 메뉴 바로 가기 만들기",
    shortcutDesktop: "바탕 화면 바로 가기 만들기",
    launchAfter: "설치가 끝나면 바로 WoWSP 실행",
    finish: "설치 완료",
    retry: "설치 다시 시도",
    close: "닫기",
  },
  nav: { next: "다음", back: "뒤로" },
  logPane: { title: "설치 로그", expand: "설치 로그 펼치기", collapse: "설치 로그 접기" },
  uninstall: {
    heading: "WoWSP 제거",
    sub: "WoWSP와 등록된 시스템 항목을 제거합니다. 모델 리소스와 사용자 데이터는 유지됩니다.",
    cancel: "취소",
    repair: "설치 복구",
    uninstall: "제거",
    close: "닫기",
    uninstalling: "제거하는 중…",
    repairing: "복구하는 중…",
    doneUninstall: "제거 완료",
    doneRepair: "복구 완료",
    failedUninstall: "제거 실패",
    failedRepair: "복구 실패",
  },
  pathField: {
    browse: "찾아보기…",
    diskChip: "디스크",
    chipLabel: "설치할 드라이브 선택",
    pickerTitle: "드라이브 선택",
    searchPlaceholder: "드라이브 또는 볼륨 레이블 검색",
    emptyText: "일치하는 드라이브 없음",
    kinds: {
      removable: "이동식 디스크",
      fixed: "로컬 디스크",
      network: "네트워크 드라이브",
      cdrom: "광학 드라이브",
      ramdisk: "RAM 디스크",
      unknown: "알 수 없는 드라이브",
    },
  },
};

const fr: InstallerStrings = {
  title: "Programme d'installation WoWSP",
  uninstallTitle: "Désinstaller WoWSP",
  languageLabel: "Langue de l'installateur",
  steps: { mode: "Mode", license: "Licence", install: "Installation", done: "Terminé" },
  mode: {
    title: "Choisissez comment installer WoWSP",
    sub: "Choisissez le mode d'installation de cette copie et l'emplacement de ses données ; les packs de modèles 2D / 3D sont installés en même temps.",
    local: {
      title: "Installer sur ce PC",
      description:
        "Installation mono-utilisateur standard avec un raccourci dans le menu Démarrer et des mises à jour automatiques.",
      badge: "Recommandé",
    },
    usb: {
      title: "Clé USB (cybercafé)",
      description:
        "Une copie portable sur un lecteur amovible — aucune entrée de registre, toutes les données restent sur le lecteur.",
    },
  },
  target: {
    label: "Emplacement d'installation",
    dialogTitle: "Choisir l'emplacement d'installation",
    hintLocal:
      "Les données sont écrites dans %APPDATA% avec mise à jour automatique ; l'entrée de désinstallation est enregistrée dans le système.",
    hintUsb:
      "Détecté automatiquement quand un lecteur amovible est présent ; sinon, repli sur un chemin local.",
    hintUsbDetected: "Lecteur amovible détecté.",
    warnUnwritable:
      "Le répertoire actuel n'est pas inscriptible et l'installation serait refusée — choisissez l'un des emplacements suggérés ci-dessus.",
    warnNoWritable:
      "Aucun emplacement inscriptible n'a été trouvé — choisissez un répertoire auquel vous avez accès.",
    nestedNote:
      "Un niveau de dossier a été ajouté automatiquement afin que l'installation n'atterrisse jamais à la racine du lecteur.",
  },
  flavors: {
    full: "Édition complète · inclut les packs de modèles 2D/3D",
    fullWebview2:
      "Édition complète · inclut les packs de modèles 2D/3D et le runtime WebView2",
  },
  license: {
    title: "Contrat de licence",
    sub: "Lisez les documents ci-dessous avant d'installer ; cocher la case vaut acceptation de l'ensemble de leur contenu.",
    agree: "J'ai lu et j'accepte l'intégralité des accords ci-dessus",
    prevDoc: "Document précédent",
    nextDoc: "Document suivant",
    agreeInstall: (countdown) =>
      countdown > 0 ? `Accepter et installer (${countdown} s)` : "Accepter et installer",
  },
  install: {
    preparing: "Préparation de l'installation…",
    startedLog: "Installation démarrée",
    fallback: "Installation de WoWSP — cela peut prendre un instant…",
    progress: {
      stopApp: "Arrêt de WoWSP en cours d'exécution",
      removedStale: (count) =>
        `${count} fichier(s) obsolète(s) de l'installation précédente supprimé(s)`,
      verbs: {
        Extracting: "Extraction",
        Reusing: "Réutilisation",
        Downloading: "Téléchargement",
        Registering: "Enregistrement",
        Writing: "Écriture",
      },
      phases: {
        download: "Téléchargement des ressources",
        extract: "Extraction des fichiers",
        register: "Enregistrement des entrées système",
        fallback: "Installation",
      },
      writing: (path) => `Écriture de ${path}`,
      reusing: (path) => `Réutilisation de ${path}`,
      runningScript: (name) => `Exécution de ${name}`,
    },
  },
  done: {
    failedTitle: "Échec de l'installation",
    title: "✔ Installation terminée",
    hintLocal:
      "WoWSP est enregistré dans la liste des applications du système ; les raccourcis cochés sont créés quand vous cliquez sur Terminer.",
    hintUsb: "La copie portable est prête : toutes les données restent sur le lecteur amovible.",
    shortcutMenu: "Créer un raccourci dans le menu Démarrer",
    shortcutDesktop: "Créer un raccourci sur le bureau",
    launchAfter: "Lancer WoWSP dès la fin de l'installation",
    finish: "Terminer",
    retry: "Réessayer l'installation",
    close: "Fermer",
  },
  nav: { next: "Suivant", back: "Retour" },
  logPane: {
    title: "Journal d'installation",
    expand: "Déployer le journal d'installation",
    collapse: "Replier le journal d'installation",
  },
  uninstall: {
    heading: "Désinstaller WoWSP",
    sub: "Cette opération supprime WoWSP et les entrées système qu'il a enregistrées. Les ressources de modèles et les données utilisateur sont conservées.",
    cancel: "Annuler",
    repair: "Réparer l'installation",
    uninstall: "Désinstaller",
    close: "Fermer",
    uninstalling: "Désinstallation…",
    repairing: "Réparation…",
    doneUninstall: "Désinstallation terminée",
    doneRepair: "Réparation terminée",
    failedUninstall: "Échec de la désinstallation",
    failedRepair: "Échec de la réparation",
  },
  pathField: {
    browse: "Parcourir…",
    diskChip: "Disque",
    chipLabel: "Choisir le disque d'installation",
    pickerTitle: "Choisir un disque",
    searchPlaceholder: "Rechercher des disques ou des noms de volume",
    emptyText: "Aucun disque correspondant",
    kinds: {
      removable: "Lecteur amovible",
      fixed: "Disque local",
      network: "Lecteur réseau",
      cdrom: "Lecteur optique",
      ramdisk: "Disque RAM",
      unknown: "Disque inconnu",
    },
  },
};

const es: InstallerStrings = {
  title: "Instalador de WoWSP",
  uninstallTitle: "Desinstalar WoWSP",
  languageLabel: "Idioma del instalador",
  steps: { mode: "Modo", license: "Licencia", install: "Instalar", done: "Hecho" },
  mode: {
    title: "Elige cómo instalar WoWSP",
    sub: "Elige cómo se instala esta copia y dónde residen sus datos; los paquetes de modelos 2D / 3D se instalan junto con ella.",
    local: {
      title: "Instalar en este equipo",
      description:
        "Instalación estándar de un solo usuario, con acceso directo en el menú Inicio y actualizaciones automáticas.",
      badge: "Recomendado",
    },
    usb: {
      title: "Unidad USB (cibercafé)",
      description:
        "Una copia portátil en una unidad extraíble: sin entradas de registro, todos los datos permanecen en la unidad.",
    },
  },
  target: {
    label: "Ubicación de instalación",
    dialogTitle: "Elegir la ubicación de instalación",
    hintLocal:
      "Los datos se escriben en %APPDATA% con actualizaciones automáticas; la información de desinstalación se registra en el sistema.",
    hintUsb:
      "Se detecta automáticamente cuando hay una unidad extraíble; de lo contrario, se recurre a una ruta local.",
    hintUsbDetected: "Unidad extraíble detectada.",
    warnUnwritable:
      "El directorio actual no admite escritura y la instalación se rechazaría: elige una de las ubicaciones resaltadas arriba.",
    warnNoWritable:
      "No se encontró ninguna ubicación con permiso de escritura: elige un directorio al que tengas acceso.",
    nestedNote:
      "Se añadió automáticamente un nivel de carpeta para que la instalación nunca caiga en la raíz de la unidad.",
  },
  flavors: {
    full: "Edición completa · incluye los paquetes de modelos 2D/3D",
    fullWebview2:
      "Edición completa · incluye los paquetes de modelos 2D/3D y el runtime de WebView2",
  },
  license: {
    title: "Acuerdo de licencia",
    sub: "Lee los documentos del acuerdo antes de instalar; marcar la casilla implica aceptar todo su contenido.",
    agree: "He leído y acepto todos los acuerdos anteriores",
    prevDoc: "Documento anterior",
    nextDoc: "Documento siguiente",
    agreeInstall: (countdown) =>
      countdown > 0 ? `Aceptar e instalar (${countdown} s)` : "Aceptar e instalar",
  },
  install: {
    preparing: "Preparando la instalación…",
    startedLog: "Instalación iniciada",
    fallback: "Instalando WoWSP: esto puede tardar un momento…",
    progress: {
      stopApp: "Deteniendo el WoWSP en ejecución",
      removedStale: (count) =>
        `Se eliminaron ${count} archivo(s) obsoleto(s) de la instalación anterior`,
      verbs: {
        Extracting: "Extrayendo",
        Reusing: "Reutilizando",
        Downloading: "Descargando",
        Registering: "Registrando",
        Writing: "Escribiendo",
      },
      phases: {
        download: "Descargando recursos",
        extract: "Extrayendo archivos",
        register: "Registrando entradas del sistema",
        fallback: "Instalando",
      },
      writing: (path) => `Escribiendo ${path}`,
      reusing: (path) => `Reutilizando ${path}`,
      runningScript: (name) => `Ejecutando ${name}`,
    },
  },
  done: {
    failedTitle: "Error de instalación",
    title: "✔ Instalación completada",
    hintLocal:
      "WoWSP está registrado en la lista de aplicaciones del sistema; los accesos directos marcados se crean al pulsar «Finalizar».",
    hintUsb: "La copia portátil está lista: todos los datos permanecen en la unidad extraíble.",
    shortcutMenu: "Crear un acceso directo en el menú Inicio",
    shortcutDesktop: "Crear un acceso directo en el escritorio",
    launchAfter: "Iniciar WoWSP nada más terminar la instalación",
    finish: "Finalizar",
    retry: "Reintentar la instalación",
    close: "Cerrar",
  },
  nav: { next: "Siguiente", back: "Atrás" },
  logPane: {
    title: "Registro de instalación",
    expand: "Desplegar el registro de instalación",
    collapse: "Plegar el registro de instalación",
  },
  uninstall: {
    heading: "Desinstalar WoWSP",
    sub: "Esto eliminará WoWSP y las entradas del sistema que registró. Los recursos de modelos y los datos de usuario se conservan.",
    cancel: "Cancelar",
    repair: "Reparar instalación",
    uninstall: "Desinstalar",
    close: "Cerrar",
    uninstalling: "Desinstalando…",
    repairing: "Reparando…",
    doneUninstall: "Desinstalación completada",
    doneRepair: "Reparación completada",
    failedUninstall: "Error al desinstalar",
    failedRepair: "Error al reparar",
  },
  pathField: {
    browse: "Examinar…",
    diskChip: "Disco",
    chipLabel: "Elige el disco donde instalar",
    pickerTitle: "Elegir un disco",
    searchPlaceholder: "Buscar discos o etiquetas de volumen",
    emptyText: "Ningún disco coincidente",
    kinds: {
      removable: "Unidad extraíble",
      fixed: "Disco local",
      network: "Unidad de red",
      cdrom: "Unidad óptica",
      ramdisk: "Disco RAM",
      unknown: "Unidad desconocida",
    },
  },
};

const de: InstallerStrings = {
  title: "WoWSP-Installer",
  uninstallTitle: "WoWSP deinstallieren",
  languageLabel: "Installersprache",
  steps: { mode: "Modus", license: "Lizenz", install: "Installation", done: "Fertig" },
  mode: {
    title: "Wählen Sie, wie WoWSP installiert werden soll",
    sub: "Wählen Sie, wie diese Kopie installiert wird und wo ihre Daten liegen; die 2D-/3D-Modellpakete werden mitinstalliert.",
    local: {
      title: "Auf diesem PC installieren",
      description:
        "Standardinstallation für einen einzelnen Benutzer, mit Startmenü-Verknüpfung und automatischen Updates.",
      badge: "Empfohlen",
    },
    usb: {
      title: "USB-Laufwerk (Internetcafé)",
      description:
        "Eine portable Kopie auf einem Wechseldatenträger — keine Registry-Einträge, alle Daten bleiben auf dem Laufwerk.",
    },
  },
  target: {
    label: "Installationsort",
    dialogTitle: "Installationsort wählen",
    hintLocal:
      "Die Daten werden unter %APPDATA% abgelegt, mit automatischen Updates; der Deinstallationseintrag wird im System registriert.",
    hintUsb:
      "Wird automatisch gefunden, sobald ein Wechseldatenträger vorhanden ist; andernfalls wird auf einen lokalen Pfad ausgewichen.",
    hintUsbDetected: "Wechseldatenträger erkannt.",
    warnUnwritable:
      "Das aktuelle Verzeichnis ist nicht beschreibbar und die Installation würde abgelehnt — wählen Sie oben einen der hervorgehobenen Kandidaten.",
    warnNoWritable:
      "Kein beschreibbarer Kandidatenort gefunden — wählen Sie ein Verzeichnis, auf das Sie zugreifen dürfen.",
    nestedNote:
      "Automatisch wurde eine Ordnerebene eingefügt, damit nichts direkt im Wurzelverzeichnis des Laufwerks landet.",
  },
  flavors: {
    full: "Vollversion · inklusive der 2D-/3D-Modellpakete",
    fullWebview2: "Vollversion · inklusive der 2D-/3D-Modellpakete und der WebView2-Laufzeit",
  },
  license: {
    title: "Lizenzvereinbarung",
    sub: "Lesen Sie vor der Installation die folgenden Vereinbarungsdokumente; das Setzen des Häkchens bedeutet, dass Sie allen zustimmen.",
    agree: "Ich habe alle oben genannten Vereinbarungen gelesen und akzeptiere sie",
    prevDoc: "Vorheriges Dokument",
    nextDoc: "Nächstes Dokument",
    agreeInstall: (countdown) =>
      countdown > 0 ? `Zustimmen & installieren (${countdown} s)` : "Zustimmen & installieren",
  },
  install: {
    preparing: "Installation wird vorbereitet…",
    startedLog: "Installation gestartet",
    fallback: "WoWSP wird installiert — das kann einen Moment dauern…",
    progress: {
      stopApp: "Laufendes WoWSP wird beendet",
      removedStale: (count) =>
        `${count} veraltete(n) Datei(en) der vorherigen Installation entfernt`,
      verbs: {
        Extracting: "Entpacken",
        Reusing: "Wiederverwenden",
        Downloading: "Herunterladen",
        Registering: "Registrieren",
        Writing: "Schreiben",
      },
      phases: {
        download: "Ressourcen werden heruntergeladen",
        extract: "Dateien werden entpackt",
        register: "Systemeinträge werden registriert",
        fallback: "Installation läuft",
      },
      writing: (path) => `Schreibe ${path}`,
      reusing: (path) => `Wiederverwende ${path}`,
      runningScript: (name) => `Führe ${name} aus`,
    },
  },
  done: {
    failedTitle: "Installation fehlgeschlagen",
    title: "✔ Installation abgeschlossen",
    hintLocal:
      "WoWSP ist in der App-Liste des Systems registriert; die markierten Verknüpfungen werden beim Klick auf „Fertigstellen“ erstellt.",
    hintUsb: "Die portable Kopie ist bereit: Alle Daten bleiben auf dem Wechseldatenträger.",
    shortcutMenu: "Startmenü-Verknüpfung erstellen",
    shortcutDesktop: "Desktop-Verknüpfung erstellen",
    launchAfter: "WoWSP direkt nach Abschluss der Installation starten",
    finish: "Fertigstellen",
    retry: "Installation wiederholen",
    close: "Schließen",
  },
  nav: { next: "Weiter", back: "Zurück" },
  logPane: {
    title: "Installationsprotokoll",
    expand: "Installationsprotokoll ausklappen",
    collapse: "Installationsprotokoll einklappen",
  },
  uninstall: {
    heading: "WoWSP deinstallieren",
    sub: "Damit werden WoWSP und die registrierten Systemeinträge entfernt. Modellressourcen und Benutzerdaten bleiben erhalten.",
    cancel: "Abbrechen",
    repair: "Installation reparieren",
    uninstall: "Deinstallieren",
    close: "Schließen",
    uninstalling: "Deinstallation läuft…",
    repairing: "Reparatur läuft…",
    doneUninstall: "Deinstallation abgeschlossen",
    doneRepair: "Reparatur abgeschlossen",
    failedUninstall: "Deinstallation fehlgeschlagen",
    failedRepair: "Reparatur fehlgeschlagen",
  },
  pathField: {
    browse: "Durchsuchen…",
    diskChip: "Laufwerk",
    chipLabel: "Laufwerk für die Installation auswählen",
    pickerTitle: "Laufwerk wählen",
    searchPlaceholder: "Laufwerke oder Volumebezeichnungen suchen",
    emptyText: "Kein passendes Laufwerk",
    kinds: {
      removable: "Wechseldatenträger",
      fixed: "Lokaler Datenträger",
      network: "Netzwerklaufwerk",
      cdrom: "Optisches Laufwerk",
      ramdisk: "RAM-Laufwerk",
      unknown: "Unbekanntes Laufwerk",
    },
  },
};

const pt: InstallerStrings = {
  title: "Instalador do WoWSP",
  uninstallTitle: "Desinstalar o WoWSP",
  languageLabel: "Idioma do instalador",
  steps: { mode: "Modo", license: "Licença", install: "Instalar", done: "Concluído" },
  mode: {
    title: "Escolha como instalar o WoWSP",
    sub: "Escolha como esta cópia é instalada e onde residem os seus dados; os pacotes de modelos 2D / 3D são instalados em conjunto.",
    local: {
      title: "Instalar neste PC",
      description:
        "Instalação mono-utilizador padrão, com atalho no menu Iniciar e atualizações automáticas.",
      badge: "Recomendado",
    },
    usb: {
      title: "Unidade USB (modo cibercafé)",
      description:
        "Uma cópia portátil numa unidade amovível — sem entradas no registo, todos os dados ficam na unidade.",
    },
  },
  target: {
    label: "Local de instalação",
    dialogTitle: "Escolher o local de instalação",
    hintLocal:
      "Os dados são escritos em %APPDATA%, com atualizações automáticas; a entrada de desinstalação é registada no sistema.",
    hintUsb:
      "Detetado automaticamente quando existe uma unidade amovível; caso contrário, recua para um caminho local.",
    hintUsbDetected: "Unidade amovível detetada.",
    warnUnwritable:
      "O diretório atual não permite escrita e a instalação seria recusada — escolha um dos locais sugeridos acima.",
    warnNoWritable:
      "Não foi encontrado nenhum local com permissão de escrita — escolha um diretório a que tenha acesso.",
    nestedNote:
      "Foi adicionado automaticamente um nível de pastas para que a instalação nunca caia na raiz da unidade.",
  },
  flavors: {
    full: "Edição completa · inclui os pacotes de modelos 2D/3D",
    fullWebview2:
      "Edição completa · inclui os pacotes de modelos 2D/3D e o runtime WebView2",
  },
  license: {
    title: "Acordo de licença",
    sub: "Leia os documentos do acordo antes de instalar; marcar a caixa significa que aceita todo o seu conteúdo.",
    agree: "Li e aceito todos os acordos acima",
    prevDoc: "Documento anterior",
    nextDoc: "Documento seguinte",
    agreeInstall: (countdown) =>
      countdown > 0 ? `Aceitar e instalar (${countdown} s)` : "Aceitar e instalar",
  },
  install: {
    preparing: "A preparar a instalação…",
    startedLog: "Instalação iniciada",
    fallback: "A instalar o WoWSP — isto pode demorar um momento…",
    progress: {
      stopApp: "A parar o WoWSP em execução",
      removedStale: (count) =>
        `Removido(s) ${count} ficheiro(s) desatualizado(s) da instalação anterior`,
      verbs: {
        Extracting: "A extrair",
        Reusing: "A reutilizar",
        Downloading: "A transferir",
        Registering: "A registar",
        Writing: "A escrever",
      },
      phases: {
        download: "A transferir recursos",
        extract: "A extrair ficheiros",
        register: "A registar entradas do sistema",
        fallback: "A instalar",
      },
      writing: (path) => `A escrever ${path}`,
      reusing: (path) => `A reutilizar ${path}`,
      runningScript: (name) => `A executar ${name}`,
    },
  },
  done: {
    failedTitle: "Falha na instalação",
    title: "✔ Instalação concluída",
    hintLocal:
      "O WoWSP está registado na lista de aplicações do sistema; os atalhos assinalados são criados quando clica em «Concluir».",
    hintUsb: "A cópia portátil está pronta: todos os dados ficam na unidade amovível.",
    shortcutMenu: "Criar atalho no menu Iniciar",
    shortcutDesktop: "Criar atalho no ambiente de trabalho",
    launchAfter: "Iniciar o WoWSP logo que a instalação termine",
    finish: "Concluir",
    retry: "Repetir a instalação",
    close: "Fechar",
  },
  nav: { next: "Seguinte", back: "Voltar" },
  logPane: {
    title: "Registo de instalação",
    expand: "Expandir o registo de instalação",
    collapse: "Recolher o registo de instalação",
  },
  uninstall: {
    heading: "Desinstalar o WoWSP",
    sub: "Isto remove o WoWSP e as entradas de sistema registadas por ele. Os recursos de modelos e os dados do utilizador são mantidos.",
    cancel: "Cancelar",
    repair: "Reparar instalação",
    uninstall: "Desinstalar",
    close: "Fechar",
    uninstalling: "A desinstalar…",
    repairing: "A reparar…",
    doneUninstall: "Desinstalação concluída",
    doneRepair: "Reparação concluída",
    failedUninstall: "Falha ao desinstalar",
    failedRepair: "Falha ao reparar",
  },
  pathField: {
    browse: "Procurar…",
    diskChip: "Disco",
    chipLabel: "Escolha o disco onde instalar",
    pickerTitle: "Escolher um disco",
    searchPlaceholder: "Procurar discos ou etiquetas de volume",
    emptyText: "Nenhum disco correspondente",
    kinds: {
      removable: "Unidade amovível",
      fixed: "Disco local",
      network: "Unidade de rede",
      cdrom: "Unidade ótica",
      ramdisk: "Disco RAM",
      unknown: "Disco desconhecido",
    },
  },
};

const TABLE: Record<InstallerLocale, InstallerStrings> = {
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  en,
  ru,
  ja,
  ko,
  fr,
  es,
  de,
  pt,
};

/** The full string table for one locale. Computed per render in App.tsx,
 *  so a locale switch re-renders everything live. */
export function strings(locale: InstallerLocale): InstallerStrings {
  return TABLE[locale] ?? zhHans;
}
