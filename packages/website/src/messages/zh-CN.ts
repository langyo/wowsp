export default {
  nav: {
    features: "功能",
    download: "下载",
    docs: "文档",
    github: "GitHub",
  },
  hero: {
    tagline: "战舰世界的回放复盘与游戏内悬浮面板",
    lede: "无需启动游戏，即可在三维全息地图上复盘任意 .wowsreplay 回放；也可以作为 Mod 安装，在按住 Tab 时悬浮显示双方阵容。",
    download: "下载 Windows 版",
    docs: "阅读文档",
    github: "GitHub 源码",
    version: "首个正式版即将发布",
  },
  features: {
    title: "两种模式，一个面板",
    replay: {
      title: "独立回放复盘",
      desc: "自动检测游戏安装目录，解析 .wowsreplay 文件，在三维全息地图上渲染每一艘舰船——无需启动游戏。",
    },
    overlay: {
      title: "游戏内悬浮面板",
      desc: "以 Mod 方式随游戏启动，透明悬浮窗显示双方阵容，仅在按住 Tab 时可见。",
    },
    stats: {
      title: "数据与洞察",
      desc: "通过 Wargaming 公开 API 提供舰船数据、排位赛季、玩家查询与战绩趋势。",
    },
    viewer: {
      title: "三维舰船查看器",
      desc: "以低多边形全息模型浏览全部舰船——旋转、缩放、查看装甲。",
    },
  },
  download: {
    title: "下载 WoWSP",
    lede: "Windows x64 · WebView2 运行时将自动安装。",
    install: "安装程序（NSIS）",
    portable: "绿色版 / 免安装",
    modesTitle: "三种运行方式",
    modeInstallTitle: "安装到本机",
    modeInstallDesc: "标准单用户安装，含开始菜单快捷方式与自动更新。推荐。",
    modeUsbTitle: "U 盘（网吧模式）",
    modeUsbDesc: "便携副本放在 U 盘上——无注册表项，所有数据留在 U 盘内。适合共用电脑。",
    modeGreenTitle: "直接运行（绿色软件）",
    modeGreenDesc: "解压到任意位置直接运行，与本机安装完全隔离。适合调试或沙箱使用。",
    assets: "发布资源",
    notes: "所有资源均发布在 GitHub Releases。",
  },
  footer: {
    license: "以 SySL-1.0 许可发布",
    made: "基于 Rust、Vue 3、Tauri 2 与 Three.js 构建",
  },
} as const;
