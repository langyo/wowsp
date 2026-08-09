export default {
  nav: {
    "language": "語言",
    features: "功能",
    download: "下載",
    docs: "文檔",
    github: "GitHub",
  },
  hero: {
    badge: "開源 · Windows x64",
    tagline: "戰艦世界的回放復盤與遊戲內懸浮面板",
    lede: "無需啟動遊戲，即可在 3D 全息地圖上復盤任意 .wowsreplay 回放；亦可作為 Mod 安裝，在按住 Tab 時懸浮顯示雙方陣容。",
    download: "下載 Windows 版",
    docs: "閱讀文檔",
    github: "GitHub 源碼",
    version: "首個正式版即將發佈",
    ships: "1200+ 艘艦船模型",
    maps: "3D 回放復盤",
    overlay: "對局內 Tab 懸浮",
  },
  features: {
    title: "兩種模式，一個面板",
    replay: {
      title: "獨立回放復盤",
      desc: "自動偵測遊戲安裝目錄，解析 .wowsreplay 檔案，在 3D 全息地圖上渲染每一艘艦船——無需啟動遊戲。",
    },
    overlay: {
      title: "遊戲內懸浮面板",
      desc: "以 Mod 方式隨遊戲啟動，透明懸浮窗顯示雙方陣容，僅在按住 Tab 時可見。",
    },
    stats: {
      title: "數據與洞察",
      desc: "透過 Wargaming 公開 API 提供艦船數據、排位賽季、玩家查詢與戰績趨勢。",
    },
    viewer: {
      title: "3D 艦船檢視器",
      desc: "以低多邊形全息模型瀏覽全部艦船——旋轉、縮放、檢視裝甲。",
    },
  },
  download: {
    title: "下載 WoWSP",
    lede: "Windows x64 · WebView2 執行階段將自動安裝。",
    install: "安裝程式（NSIS）",
    portable: "綠色版 / 免安裝",
    modesTitle: "三種執行方式",
    modeInstallTitle: "安裝到本機",
    modeInstallDesc: "標準單一使用者安裝，含開始功能表捷徑與自動更新。推薦。",
    modeUsbTitle: "USB 隨身碟（網咖模式）",
    modeUsbDesc: "可攜式副本放在 USB 上——無登錄檔項目，所有資料留在隨身碟內。適合共用電腦。",
    modeGreenTitle: "直接執行（綠色軟體）",
    modeGreenDesc: "解壓到任意位置直接執行，與本機安裝完全隔離。適合除錯或沙箱使用。",
    assets: "發佈資源",
    notes: "所有資源均發佈在 GitHub Releases。",
  },
  footer: {
    license: "以 SySL-1.0 授權發佈",
    made: "基於 Rust、Vue 3、Tauri 2 與 Three.js 構建",
  },
} as const;
