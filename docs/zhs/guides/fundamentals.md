# 核心概念

> **读者**：希望从概念层面理解 WoWSP 设计的开发者。

## 一个二进制，两种模式

WoWSP 是一个 Tauri 桌面应用。同一个可执行文件既能跑独立复盘模式（打开录像、看全息地图），也能跑覆盖层模式（在运行的游戏上叠透明窗口）。前端通过路由选择模式：`/replay` 对 `/overlay`。

## 数据来源

| 来源 | 模式 | 提供给 WoWSP 的内容 |
|---|---|---|
| `.wowsreplay` 文件 | 复盘 | 对局描述（阵容、地图、对局类型）+ 数据包流（随时间的位置） |
| `tempArenaInfo.json` | 覆盖层 | 对局加载时的实时阵容 |
| `<game>/profile/clientrunner.log` | 两者 | 区服识别（`Selected realm:` 行） |
| Windows 注册表 + Steam manifest | 两者 | 游戏安装路径 |
| Wargaming 公开 / Vortex API | 两者（可选） | 单玩家战绩（胜率、军团等） |

## 模型转换

全息地图把地图几何和船体以 GLB 形式交给 three.js 渲染。游戏原生资产格式由 `scripts/model_convert/` 下的 Python 脚本转换：

- `convert_map.py` —— 地图空间数据 → GLB
- `convert_ship.py` —— 船体 → GLB

新增地图或船只是纯数据操作：把源资产放入 `scripts/mock/fixtures/`，跑 `just convert-model map`（或 `ship`），前端自动加载。无需改动 Rust 或 TS。

## 覆盖层交互模型

覆盖层仅在按住 `Tab` 时可见。每次按 Tab：

1. WoWSP 截取游戏窗口（Win32 `BitBlt`）。
2. 轻量检测器定位中央名单区域。
3. 把渲染好的阵容重新锚定到该区域上方。
4. 松开 Tab 时覆盖层再次隐藏。

这使得非 Tab 期间的 CPU 开销接近零，并且每次都重新锚定，分辨率/窗口尺寸变化永远不会让覆盖层错位。

## 出处

录像解析、游戏检测、`tempArenaInfo.json` 轮询原理借鉴自 ApeRadar。前端壳与构建设施借鉴自 shittim-chest。授权条款见 `LICENSE`（BSL-1.1 → SySL-1.0）。
