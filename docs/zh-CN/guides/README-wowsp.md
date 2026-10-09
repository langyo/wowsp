<h1 align="center">WoWSP</h1>

<p align="center"><strong>免费开源的《战舰世界》战况面板 —— 录像复盘、游戏内覆盖层、实时战斗情报与全面战绩，覆盖 Windows 与 Android。</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![Release](https://img.shields.io/github/v/release/langyo/wowsp)](https://github.com/langyo/wowsp/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/langyo/wowsp/total)](https://github.com/langyo/wowsp/releases)

</div>

<div align="center">

[English](../../en/guides/README-wowsp.md) ·
**简体中文** ·
[繁體中文](../../zh-TW/guides/README-wowsp.md) ·
[日本語](../../ja/guides/README-wowsp.md) ·
[한국어](../../ko/guides/README-wowsp.md) ·
[Français](../../fr/guides/README-wowsp.md) ·
[Español](../../es/guides/README-wowsp.md) ·
[Русский](../../ru/guides/README-wowsp.md) ·
[العربية](../../ar/guides/README-wowsp.md)

</div>

![WoWSP 主界面](../screenshots/dashboard.webp)

> [!IMPORTANT]
> **WoWSP 完全免费且开源，仅通过官方 [GitHub Releases](https://github.com/langyo/wowsp/releases) 分发。任何渠道收费出售均与作者无关——请勿付款；如已付费，请尽快申请退款并举报卖家。**

WoWSP 是 Windows 上的《战舰世界》桌面面板，并配有 Android 伴侣端。它会自动检测游戏安装（Wargaming 官方启动器 / Steam / Lesta / 360），全程陪伴你走完整个对局循环：赛后复盘录像、实时观战，以及对局中研判胜算。

## 功能一览

- **录像复盘** —— 打开任意 `.wowsreplay`，在全息 3D 地图上重演整场对局：每艘船的航迹、炮弹、鱼雷与飞机编队，射程圈、旋风天气与占领区域模拟。自由环绕、原录像机位与跟随舰船三种镜头；地图标签始终保持清晰可读；地图旁展示每位玩家的战斗结果（勋章、成就、伤害构成）。每个面板都能导出可遮蔽昵称的分享图，录像库可按模式、日期与归档状态筛选。
- **游戏内覆盖层** —— 战斗中按住 `Tab`，即可在游戏画面上叠看双方阵容与战绩；每次按键都会重新锚定位置。个人评分（PR）分档与胜率配色、印章、已沉没行着色、双方队伍汇总，以及按住 `Tab` 查看的消耗品情报。战绩既可渲染在检测到的表格上方的透明窗口中，也可通过自带的官方插件直接渲染进游戏内，行匹配针对各客户端（Wargaming、Lesta 与国服客户端）分别调校。
- **实时战斗监控** —— 从载入画面到结算画面，完整见证对局的展开：带个人评分分档与军团标签的完整阵容、按等级加权的队伍胜率、战斗卡片，以及实时个人战报——追踪你自己的伤害、成就与击杀归属。
- **战绩面板与游玩时长** —— 你自己的「水表」：个人评分、胜率与场均伤害卡片（支持日期范围筛选）、舰船分布图表（等级直方图、舰种与国家环形图）、排位赛季历史与多账号切换。专门的游玩时长视图可将你的录像文件变成战斗日历热力图，并可切换年份。
- **玩家与军团查询** —— 搜索任意玩家或军团（支持拼音），查看生涯卡片与军团成员名单并可生成分享图，跨服交叉比对军团战阵容。
- **舰船百科与配装规划器** —— 完整科技树，可在 Wargaming/Lesta 分支间切换；参数与装甲视图、每艘船的服务器趋势、舰船与飞机的 3D 模型展示台；配装规划器可将舰长技能、指挥官、信号旗与升级品折算为最终参数，并计算银币/经验开销。
- **模组中心** —— 精选的社区模组市集，覆盖功能、贴图与语音（舰船皮肤、可试听的 Wwise 语音包），提供安装预设、一键安全模式、冲突警告、过期模组迁移、贴图覆盖分析与批量更新。
- **战术板**（开发中）—— 基于内置对战地图目录的战术方案编辑器：20 分钟规划时钟、单位航迹、行动时间轴与可分享的方案集。
- **Android 伴侣端** —— 通过 Wi-Fi（自动发现）或经内置中继用六位配对码从任意位置与手机配对，直接从桌面端拉取录像，随时随地复盘。

在这套功能的底层，它始终保持原生应用的本色：镜像竞速自动更新（支持便携版安装）、托盘面板、新手引导向导、应用内公告与可导出日志的反馈表单；主题、壁纸、界面不透明度、字号与 DPI 调节；九种界面语言；可随时关闭的极少量匿名遥测；并自带 WebView2，缺失时优雅降级。

## 下载

Windows 10/11 —— 从 [GitHub Releases](https://github.com/langyo/wowsp/releases/latest) 下载最新的 `WoWSP_<version>_x64-installer-webview2.exe`（安装器自带 WebView2）；GitHub 访问缓慢时可改用官网的 [下载页](https://wowsp.langyo.xyz/download)（内置加速镜像）。Android 版需从源码构建，见[构建指南](building.md)。

所有界面、所有语言下的截图都在[官网画廊](https://wowsp.langyo.xyz/#gallery)。

## 文档

架构、设计与指南位于仓库的 [`docs/`](../../) 目录，共九种语言（英文与简体中文完整翻译），由 [lagrange](https://github.com/celestia-island/lagrange) 构建。WoWSP 会上报极少量的匿名使用遥测——具体收集（与绝不收集）什么见[遥测说明](../license/usage-telemetry.md)。

## 反馈与致谢

Bug 与测试反馈：QQ 群 **[1125770228](https://qm.qq.com/cgi-bin/qm/qr?k=b6kMIecv3d390ecZVWNQNWMFfLRVgcQ9&jump_from=webapi&authKey=NhNLVnIcIlmfnnDUCjpsra4C/zfciS1sYNjm5SV7x2RPhdP1CzOM91ObP9y9MMQV)**，或[官网](https://wowsp.langyo.xyz)的反馈表单。录像解析与游戏检测原理改编自 [ApeRadar（海猴雷达）](https://github.com/zylalx1/ApeRadar)；前端外壳与构建基建改编自 [shittim-chest](https://github.com/celestia-island/shittim-chest)。

## 许可证

WoWSP 采用 **Synthetic Source License 1.0**（合成源码许可证）（[全文](https://github.com/langyo/wowsp/blob/master/LICENSE)）—— 面向源码主要由 AI 生成的软件，授权范围与 Apache-2.0 相当，唯一额外义务是每份副本与衍生作品都必须保留 AI 生成披露声明。仓内 vendored 的 [wows-toolkit](https://github.com/langyo/wowsp/tree/master/packages/tools/wowsunpack-vendor) 快照保留其上游 **MIT** 许可证；仓库中其余一切——包括独立的 [pairing-relay](https://github.com/langyo/wowsp/tree/master/packages/pairing-relay) Worker——均采用 SySL-1.0。

## 支持作者

WoWSP 保持免费。如果它对你有所帮助、你愿意支持，作者的爱发电主页是 **[afdian.com/a/langyo](https://afdian.com/a/langyo)** —— **所有赞助将全部用于开发 WoWSP 的 AI 开销**（模型调用与代码生成工具）。

为了把权责说清楚：

- 赞助完全自愿、绝非必需——所有功能免费，软件本体绝不会内嵌需要赞助才能使用的功能。
- 赞助是自愿馈赠：不构成雇佣、委托或其他任何法律关系，也不附带对特定功能、交付时间或退款的任何诉求。
- 项目在上述许可证下对所有人保持开源——赞助者与未赞助者一视同仁。
- WoWSP 是独立的非官方项目，与 Wargaming、Lesta、360 没有直接关系。
