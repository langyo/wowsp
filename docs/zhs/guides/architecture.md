# 架构

> **读者**：希望理解 WoWSP 内部实现的开发者。

## 两种工作模式

WoWSP 是一个 Tauri 2 桌面应用，配一个前端（Vue 3 + three.js），以两种模式运行，共享绝大部分 Rust 后端。

### 模式一 — 独立复盘

打开一个 `.wowsreplay`，在不启动游戏的情况下在全息 3D 地图上复盘整场对局。

```text
.wowsreplay 文件
  → Rust：解析 8 字节 magic + JSON 描述块（commands/replay.rs）
  → Rust：解码数据包流 → 各实体事件时间线（M3，TODO）
  → webui：three.js 全息地图按时间线播放（features/holographic）
```

地图与船体几何由 `scripts/model_convert/`（`convert_map.py`、`convert_ship.py`）转成的 GLB 提供。新增地图或船只只需把源资产放入 `scripts/mock/fixtures/` 并重新跑转换器，无需改动应用代码。

### 模式二 — 游戏内覆盖层

游戏 `res_mods/` 里的一个 mod 文件会在游戏启动时拉起 WoWSP。一个透明、置顶的窗口覆盖显示双方阵容，仅在按住 `Tab` 时可见。

```text
游戏启动
  → mod 启动器拉起 WoWSP 透明覆盖窗口
  → Rust：轮询 <game>/replays/tempArenaInfo.json 获取实时阵容（commands/arena_info.rs）
  → 用户按住 Tab
    → Rust：截取游戏窗口 + 检测中央名单区域（commands/overlay.rs）
    → webui：将渲染的阵容重新锚定到检测到的矩形（features/overlay）
  → 用户松开 Tab → 覆盖层隐藏
```

## 游戏安装检测

`commands/game_detect.rs` 扫描 Windows 卸载注册表中的 Wargaming / Lesta / 360 发行商项（仿照 ApeRadar 的 `ConfigWindow.AutoDetectGamePath`），再额外遍历 Steam 游戏库目录寻找 `appmanifest_552990.acf`（Steam appid 552990 = 战舰世界）——这正是 ApeRadar 未覆盖的情况。用户也可手动指定路径。

## 录像文件格式

```text
4 字节  magic       = {0x12, 0x32, 0x34, 0x11}
4 字节  json_len    = 小端 u32
N 字节  json_block  = 对局描述（阵容、地图、对局类型）
4 字节  meta_count  = u32，元数据块数量
...     metadata    = 额外元数据块
...     packets     = 加密/zlib 数据包流
```

`commands/replay.rs` 在第一阶段实现 magic 校验 + JSON 块抽取。数据包流解码在 M3 完成。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3（TSX）+ UnoCSS + 同目录 SCSS + Pinia + vue-i18n + three.js + echarts |
| 桌面壳 | Tauri 2（Rust） |
| 后端 IPC | `packages/app/tauri/src/commands/` 中的 `#[tauri::command]` 处理器 |
| Mock 后端 | FastAPI（`scripts/mock/`），供浏览器/e2e 开发 |
| 构建 | Cargo + pnpm workspace、`just` 任务、Python 工具 |
| 文档 | lagrange 多语言站点 |

## 出处

录像解析、游戏检测、`tempArenaInfo.json` 轮询原理借鉴自 [ApeRadar（海猴雷达）](https://github.com/zylalx1/ApeRadar)。前端壳、构建设施、授权模式借鉴自 [shittim-chest](https://github.com/celestia-island/shittim-chest)。
