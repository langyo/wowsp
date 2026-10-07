# 游戏内战绩插件 —— 精确遥测设计

> **状态**：实验已收尾（2026-09-28），可进入实现。
> 覆盖层的伴生文档：显示层仍由透明窗口承担；本插件是游戏内的数据源，
> 让覆盖层的排序在任何环境（含独占全屏）下都精确。
>
> **更新（2026-10-01）**：新增第二种查看模式——游戏内展示。插件的 unbound 视图
> （安装到 `gui/unbound2/mods/WoWSPProbe.unbound`，游戏自动扫描并挂载的战斗视图目录）把战绩
> 直接绘制在游戏画面内，仅作用于新的 `table = "ingame"` 模式；本文其余部分描述
> 的"插件不渲染、透明窗口为唯一显示层"仍是覆盖模式（`"detect"`）的设计。桥接层
> （`commands/ingame_bridge.rs`）只在游戏内展示模式开启时应答 `request.json`，
> 两种显示不会同时出现。

## 背景与目标

现有实时战斗覆盖层靠截屏推断 TAB 队列表格的几何位置
（`overlay/capture.rs`、`overlay_detect.rs`），并以 30 ms 间隔轮询
`GetAsyncKeyState(VK_TAB)`。这套方案能用，但：

- 截屏是最脆弱的一层（DRM/捕获排斥、HDR、多 DPI、全屏差异）；
- 键态轮询无法区分"按住 Tab"与"聊天框里打 Tab"；
- 行序来自静态名单加击沉启发式推断。

一个跑在 Wargaming 官方 **Mods API**（PnFMods 通道，无注入、无内存
写入）上的游戏内 mod 可以从客户端内部观察战斗状态，经文件桥交给
WoWSP。该 mod **不渲染任何内容**——透明覆盖层仍是显示层——因此完全
不承担"游戏内渲染"方案按游戏版本维护 UI 的成本。

目标：把「mod 遥测 > 截屏推断 > 静态顺序」做成覆盖层数据的优先级
链，`overlay_config.toml` 的 roster 模式新增 `"plugin"` 值。

## 实验证明的事实

在 Steam 亚服 15.8.0（build 13187581）与 360 国服 15.8.1（build
13243917）上验证，各数局；探针产物见
`packages/ingame-plugin/src/Main.py`（对内恒报 `0.1.0`，迭代只走
git 历史）：

| 能力 | 机制 | 时延 / 备注 |
| --- | --- | --- |
| 双服加载 | `res_mods/<bin>/PnFModsLoader.py`（0 字节标记）+ `PnFMods/<Mod>/Main.py`，`API_VERSION = 'API_v1.0'` | 与 Aslain 共存 |
| 注入 API 模块 | `events, ui, utils, battle, callbacks, dataHub, constants` 为加载器注入的全局量；对它们 import 会失败（白名单），绝不能用 import 失败回退遮蔽 | builtins 同样白名单：无 `globals()`/`eval` |
| 名单与身份 | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm / isAlive | 记录是 `SafeClass`：下标可用、dict 协议不可用；加载早期容器短暂非 dict，需防御。记录自带的 `isAlive` 现为**权威**存活源——其翻转已按名字逐一与真实 Tab 截图的沉没行对表（2026-10-07 整局 journal） |
| 沉船归因 | 名单记录的 `isAlive` 翻转，1 s 轮询；avatar 实体遍历提供血量、仅作回退 | 记录逐名跟踪客户端表格（2026-10-07 整局 journal 验证）。锁存改由记录裁决：旧版「walk 单读即锁死」的单向锁存曾把玩家整局判死（观察到一例：本人在存活时被判沉没——该局 journal 已被环形缓冲覆盖，确切触发条件只能推断） |
| 实时血量与点亮 | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]`（`.value/.max/.isAlive`）、`entity[CC.relation]` | 敌方血量点亮前为 0/0——与游戏表格同等的战争迷雾；0→实值的跳变本身就是点亮事件 |
| TAB 屏状态 | SFM 事件 `input.tabModeIn` / `input.tabModeOut` | 按键后 ≤3 ms 触发；聊天打 Tab 不触发——直接消灭误报 |
| 名单变更 | `events.onPlayersListUpdated` | 一局触发 14 次 |
| 战斗生命周期 | `sfm.battleLoadingStarted`、`request.showBattle`、`onBattleStart`、`up.exitBattle`、`window.hide(Battle)` | 比 tempArenaInfo 文件出现/删除更细 |

**不可用**（也不需要）：avatar 实体上没有每玩家 score/XP 组件；
unbound 侧的 `$datahub.getCollection().getChildByPath('team.ally.sortedAlive')`
路径在 Python 侧没有对应（注入的 dataHub 没有 `getCollection`）。

**排序规则**（经所有者经验在 WG 系客户端确认；与集合名 `sortedAlive`
吻合）：TAB 表格保持初始顺序，仅把沉没玩家移入尾部的"沉船组"。因此：

```
覆盖层顺序 = tempArenaInfo 载具序（WoWSP 已解析）
             将 isAlive=false 的玩家按沉没顺序重排到末尾
```

是**精确**复刻，而非近似。

**国服分叉**（360 build 13243917，2026-10-07 实拍）：国服客户端的 TAB
表格**不重排**——沉没行留在开局原位、就地变暗（实测 5 名阵亡者的行与存活
行交错），且同（舰种, 等级）组内按**本地化船名**（拼音序）排列，而非反编译
出的国籍序（见 utils/shipClass）。**直播面**（透明覆盖层的映射与 /live
面板的预测顺序）对两者均以 `realm == "cn"` 门控（overlay/inferredOrder
的静态布局 + 船名序）；录像回放视图与全息名单**有意**保留 WG 规则
（其场景没有 CN 实拍证据），插件自身的面板也仍用竞技场规则合并——仅为
观感差异。

## 沙盒约束（来之不易，写进 mod 的风格守则）

- 运行时是 **Python 2.7**；语法保持保守（不用 f-string；现有探针刻意
  2/3 双兼容）。
- `open()` **没有追加模式**（'a' 返回 None 而非抛异常）：用内存缓冲
  整文件重写。
- 文件不存在时引擎会先记一条错误日志再抛异常：每个被轮询的邮箱文件
  都要在加载时播种一次（见 `manual_refresh.flag` 的播种）。
- 回调里逃逸的异常会静默杀死 mod：全部包裹，重复错误去重后再记日志。
- 注入模块的 `dir()` 返回 `[]`（SafeClass 包装）：API 面只有上文
  已验证名单。
- 加载器有两条通道：我们使用的经典免签名 PnFMods 1.0，以及带 WG
  签名校验的 "ModsAPI 2.0"（ModStation 级签名 mod）。免签名社区 mod
  共存无碍；第三方整合包的签名失败与本项目无关。

## 架构

```
┌─ 游戏客户端（Mods API 沙盒，无网络）─────────────────────┐
│ PnFMods/WoWSPStats/Main.py                               │
│  · 名单轮询（1 s，稳定确认）→ request.json               │
│  · 实体遍历 → 遥测（hp/relation/alive）                  │
│  · SFM 事件 → tabMode 标记、生命周期标记                  │
│  · heartbeat.json（port/battle 相位，1–2 s）             │
└──────────────┬────────────────────────────────────────────┘
               │ mod 自身目录下的平铺 JSON 文件
┌──────────────┴────────────────────────────────────────────┐
│ WoWSP 应用（Rust，沿用现有进程）                          │
│  · 桥读写器（接替实验探针的伴生角色；即第三方参考插件     │
│    确立的 request/response 协议）                        │
│  · 排序引擎：载具序 + 阵亡下沉                            │
│  · overlay_config 的 roster "plugin" 模式                │
│  · 健康检查：解析 profile/python.log 中 mod 的           │
│    加载/自检行（api[load] dh=True …）                    │
└───────────────────────────────────────────────────────────┘
```

桥文件（协议 v1，全部位于 mod 目录）：

```jsonc
// request.json —— 名单稳定后由 mod 写出（手动刷新时重写）。
// 伴生侧回填战绩行。
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json —— WoWSP 写出；revision 需按会话单调递增；
// 空文件（无结尾换行）表示"处理中"。
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json —— 每 1–2 s 重写；过期 = mod 死亡或游戏已关。
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3 }

// 遥测 journal —— 有界按局环形缓冲的整文件重写；
// 每个独立状态与事件标记在同一时间线上：
{ "t": 1690000000000, "players": { "<avatarId>": { /* 投影 */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag —— WoWSP 写入新鲜的时间戳触发重新查询；
// mod 在 10 s 窗口内消费。
```

## Rust 集成点（精确到文件）

| 关注点 | 文件（无标注即现有） | 变更 |
| --- | --- | --- |
| 桥文件监听 | `commands/arena_info.rs` 的姊妹篇：新增 `commands/ingame_bridge.rs` | `notify` 监听 mod 目录；解析心跳/请求/journal；发出 `wowsp://ingame-*` Tauri 事件 |
| 排序引擎 | 新模块 `overlay/order_source.rs` | 桥事件驱动的"载具序 + 阵亡下沉"归约器；输出覆盖层渲染的最终行序 |
| 配置 schema | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster` 新增 `"plugin"`（优先级 `plugin > inferred > ocr > off`） |
| 覆盖层按键门控 | `overlay/placement.rs`（`tab_key_down`） | 桥存活时改用 `input.tabModeIn/Out` 标记驱动显示/隐藏，替代 `GetAsyncKeyState` 轮询 |
| 安装/卸载 | `commands/mod_install.rs` + `packages/ingame-plugin/`（新子包） | 模板指向子包 `Main.py`；快照 + 回滚；游戏关闭守卫；旧探针清理 |
| 健康检查 | `commands/ingame_bridge.rs` | 解析 `profile/python.log` 中的 `probe … loaded` / `api[load] dh=True` 自检行；供设置界面展示 |
| 战绩行 | 现有 `wg_api.rs` / `wg_api_cn.rs` | 不变——伴生侧用覆盖层现有的批量查询写 `response.json` |

## 产品整合

1. **开关即自动安装**：设置里启用游戏内排序源后，经现有
   `mod_install.rs` / `packages/ingame-plugin` 路径写入 mod
   （`PnFModsLoader.py` 标记仅在缺失时创建；只碰自有文件；快照 +
   回滚；游戏关闭守卫）。关闭即卸载。即所有者指定的"特殊"注册形态：
   插件永远不作为手动安装步骤出现。
2. **自家仓库 Discussions 注册**：在 `langyo/wowsp/discussions` 发布
   模板化资源帖，并在 `mod-index.json` 条目中引用（`category`、
   `discussion`、`versions[].game` 兼容性），让 Mod Hub 也能像对待
   其它 mod 一样列出/校验它——第一方出处，同一套目录机制
   （mod-hub.md 缺口 G8 的授权模型）。
3. **回退链**：遥测缺失/过期（心跳超时 N 秒、`api[load] dh=False`、
   游戏更新后 mod 失效）→ 静默回退到现有推断管线。覆盖层的可用性
   永不依赖 mod。

## 风险与维护

- **WG API 演进**是唯一耦合（无 unbound、无原版元素复制）。Mods API
  v1.0 面自 13.x 至 15.8 保持稳定；探针的自检行让失效显式可诊。
- **国服客户端**：已验证可用；360 客户端原生运行同一 Mods API 加载器
  （日志自会扫描 `PnFModsLoader.py`）。每个大版本留意国服反作弊政策。
- **性能**：1 s 轮询 `getPlayersInfo` + 实体遍历远在预算内（TeamHP 类
  mod 逐帧遍历）；绝不为这些数据使用 `callbacks.perTick`。
- **Journal 增长**：按局有界环形；如对战后分析有用可随回放归档。

## 测试计划

- **沙盒合规**：每次 `Main.py` 变更都对照约束清单校验（py2.7 语法、
  无被禁 builtins、无追加模式、回调全包裹）加 `python -m py_compile`。
- **仅港口冒烟测试**（不打战斗）：启动游戏、港口停 ~15 s、退出；断言
  `python.log` 出现 `injected names=[…]`、`api[load] dh=True` 与新鲜
  心跳。这套廉价协议是实验阶段的验收流程，保留为安装验收测试。
- **战斗夹具**：每服一局人机；断言 journal 含名单快照、≥1 次击沉驱动的
  `alive` 翻转、tabMode 标记，且 `python.log` 的 `typeDeath` 行与翻转
  1:1 对应。
- **回退演练**：停掉应用（无伴生）断言 mod 180 s 超时恢复且下一局照常
  请求；破坏 mod 目录断言覆盖层静默回退到推断。

## 交付计划

- **M1** —— 产品化：把探针的探测电池收进调试开关；冻结桥协议；Rust
  桥 + 排序引擎 + 接入覆盖层 store 的 `roster = "plugin"` 模式。
- **M2** —— 设置开关、自动安装/卸载、python.log 健康检查、过期回退
  逻辑。
- **M3** —— Discussions 注册、目录条目、更新通道（模板随应用发版走；
  mod 文件本身很少变动）。
