# Decision-AI feasibility experiments

> 阶段 0 可行性实验（E1–E4）+ 阶段 1 特征管线首版（E5–E6）：为「内置预训练
> ONNX 决策模型（输入不完全博弈信息，输出行进 / 开火 / 武器选择建议）」验证
> 关键前提并搭建输入表示。本目录是实验工作区，产出数据文件不入库（见
> `.gitignore`）。实测样本：真实录像 `50_Gold_harbor`（15.8.0，12v12 随机战，
> 录制者 Lexington CV）与本地模型包缓存的同名地图 GLB。

| # | 实验 | 验证的问题 | 状态 | 结论 |
|---|------|-----------|------|------|
| E1 | ONNX 推理壳（`packages/app/tauri/src/commands/decision_ai.rs`） | `ort` 能否静态链接进 `wowsp_tauri`、加载 ONNX、经 Tauri IPC 跑通一次前向 | ✅ | 可行 |
| E2 | CruiseState `0x32` 解码 | replay 里的节速 / 舵角状态包能否解出逐船速度，补齐决策模型的动作标签 | ✅ | 可行（仅录制者本船） |
| E3 | 录像可见性探针（`replay_probe.rs`） | 未点亮敌舰在位置样本流中是否存在间隙（>4s），证实「客户端视角 = 天然不完全信息」假设 | ✅ | 证实 |
| E4 | 地形 LOS 栅格烘焙（`bake_terrain_los.py`） | 能否从已分发的地图 GLB 网格烘焙出高度 / 视线（LOS）栅格 | ✅ | 可行 |
| E5 | 场景单位标定（`decision_tick.rs`） | 世界单位与米的换算比能否用录像内证据钉死 | ✅ | 5.86 m/unit |
| E6 | 决策 tick 状态（`decision_tick.rs` + `terrain_los.rs`） | 能否产出「录制者视角不完全信息快照」作为模型输入表示，含地形遮挡标志 | ✅ | 可行 |
| E7 | 开火样本构造分析（`fire_dataset.rs`） | 开火决策的 (状态, 标签) 监督样本能否从录像构造、规模如何 | ✅ | 可行，需炮船录像 |
| E8 | 烟雾/消耗品/点亮事件协议逆向 | 三类语义事件能否从 EntityMethod/EntityProperty 流解出 | ✅ | 烟雾确证；消耗品/点亮排除 |
| E9 | 模型交付闭环原型（`train_fire_model.py`） | 样本导出→PyTorch 训练→ONNX→int8→Rust ort 实模型推理的全链路 | ✅ | 闭环（165µs/次） |
| E10 | def 机器生成完整 method 表 | 15.8.0 权威 def 能否精确复算 EntityMethod id 排序 | ✅ | 精确复算，100% 覆盖 |
| E11 | 点亮/消耗品/引擎事件重评估 | E10 定出 id 后，E8 排除的事件能否解出 | ✅ | 点亮/消耗品/引擎确证 |
| E12 | 批量摄取 + 多局训练 + 烟雾进 tick | G2/G3：规模化数据与训练管线 | ✅ | 全部打通 |
| E13 | 事后结果评估管线 + 版本切分压测 | #1418 归因能力落地：专家基线、模型 decile 的命中率/伤害曲线、--holdout-version 分布外测试 | ✅ | 见下 |
| E14 | 特征 v2（点亮/消耗品/引擎/烟雾/天气/配装） | 已解出但被丢弃的事件进特征后，模型是否更好；跨版本是否稳定 | ⚠️ | 同分布基本持平；**版本门控特征是 OOD 毒药**（消融后头 B 优于基线、头 A 仍略低） |
| E15 | 命中条件化标签（hit / soft） | 打空炮的时机不该被无差别模仿？ | ⚠️ | 无提升，plain 仍默认 |
| E16 | 走位数据集 + 走位模型（G6 第一步） | 「此时刻此情报下每艘船往哪走」的监督学习管线能否落地、模型能否击败惯性/多数类基线 | ✅ | 同分布击败全部基线；版本切分 top-1 输多数类、top-3 仍赢（见下） |
| E17 | 每船评分体系（G6 第二步） | 瞬时/整局评分（模型认同度+置信度）与实际战绩相关吗（预注册 ρ≥0.30） | ❌ | ρ=+0.011 失败；瓶颈是模型代际非构造；基建可用，UI 须诚实标注 |
| E18 | AI 调试工具 UI（G6 第三步） | 2D/3D 地图最优走向箭头 + 评分面板（滑动瞬时 + 置信度 + 诚实标注） | ✅ | 全链落地：`decision_debug_report` RPC + 双图层 + 评分侧栏 |

### E18 · AI 分析调试工具端上 UI（G6 第三步）✅

- **RPC `decision_debug_report(replay_path, time_sec, los_grid_dir?)`**：一次
  调用返回 全时间轴评分（E17 时间序列内嵌）+ 时刻 t 的每船走位建议（17 类
  分布、绝对方位还原、二选扇区）。走位建议**复用 E16 导出行**（≤t 最新行，
  陈旧度上限 8s）而非任意 t 重建特征——特征与训练行逐位一致，零
  train/inference 漂移（E14 教训的制度化）。模型阶梯 env → pack → 实验
  out/（宽度校验，v1 pack 火力模型被跳过可见）；单槽缓存：冷 1.8–2.7s、
  命中 3ms。
- **2D 图层**「AI 走位建议」：最优走向箭头（置信度渐变长度/颜色/线宽，
  阵营分色；no-move 画停驻标记；secondProb≥0.15 画次选浅箭头）；
  **3D**：船上方 12 世界单位悬浮箭头（池化 cylinder+cone，no-move 悬浮球，
  全息风格 depthWrite:false）。未点亮敌舰不画 3D、2D 画最后已知位。
- **评分侧栏**：每船整局模型认同度（0-100）+ fire/move 分量条 + **随播放
  滑动的瞬时分与置信度**（4s 网格二分查找、1s 量化重渲）；recorder 高亮、
  沉船半透明；顶部固定**诚实标注**（E17 结论进 UI）：「模型认同度 ≠
  战绩/水平」。
- 真实录像验证：t=300 十艘有建议/十六艘有评分，与 `compute_ship_scores`
  同模型下逐位一致；镜像 shipId 船无箭头无评分（E16 导出口径，UI 注明）。
- 门禁：Rust 1246 通过（+2 零回归）、webui build/typecheck/lint 0 警告、
  i18n 8 语言全对齐、vitest 2,088 测试（+7：色坡单调/阵营区分/次选方位/
  scoreSampleAt 边界）。


> 另有训练侧三主题网络调研（数据规模化获取 / 无环境评估协议 / 可导出 ONNX 的
> 实体编码结构），结论见文末「研究纪要」。

## 目标路线图（G1–G5）

| Goal | 内容 | 完成标准 | 状态 |
|------|------|---------|------|
| G1 | 视野与状态特征完备 | tick 快照含：烟雾遮挡、消耗品状态、可见性事件、全船节速意图 | ✅ E8/E11/E12（节速意图仅录制者，全船为引擎输出档） |
| G2 | 数据规模化就绪 | 任意录像文件夹 → 一键聚合数据集（容错跳坏文件）+ 按局切分 | ✅ E12 |
| G3 | 训练工程化 | 多局训练 + 纪要 B 评估指标全实现（分层 κ / ECE / decile lift / GroupKFold） | ✅ E12 |
| G4 | 分发与端上集成 | `decisions` 模型包（含 LOS 栅格）+ 端上加载真模型 + 战术板建议层 | ✅ G4-a/G4-b（pack 管线 + `decision_fire_suggestions` + 2D 地图建议层） |
| G5 | 第一个可用开火决策模型 | 炮船录像 ≥ 数百局 → 弱监督预训练+本船微调 → 纪要 B 验收门槛 → 随包分发 | 🔬 第一版已训（162 局语料，含 outcome 评估与版本切分） |
| G6 | AI 分析调试工具（走位 + 评分） | 2D/3D 地图上「此刻、此情报下每艘船的最优走向」+ 每船整局评分与滑动瞬时评分（含置信度） | ✅ 三步齐（E16 走位模型击败基线 / E17 评分基建+预注册验证失败如实记录 / E18 端上 UI）；评分语义=模型认同度，待扩数据重训后复验 |

**已决策（2026-09-21，用户批准）**：两个陈旧 pin 已采纳为解码行为变更（`explosions` 128→131、`wardRemoved` 50→51，13/13 锚点与 def 精确一致）；G5 扩数据按「持续积累炮船录像 + `archive_replays.py` 定期归档」推进——**游戏客户端默认只保留当前版本最近 ~30 局**，未归档录像会被静默删除，归档目标 `%LOCALAPPDATA%/WoWSP/replay-archive/`（幂等，可重复跑）。重训节奏：语料每增长 ~50% 在 GPU 节点重训一次（环境已就绪）。

## 结论

### E1 · ONNX 推理运行时可静态编入桌面应用 ✅

- `ort =2.0.0-rc.13`（精确 pin：rc 线 API 不稳）默认 `download-binaries` 静态链接：
  测试 exe 的 PE 导入表**无 `onnxruntime.dll`**，核心运行时已编入，但 pyke 预编译件
  在 Windows 上始终链接 DirectML，exe 因而**静态导入 `DirectML.dll`**（尽管推理只用
  CPU）。DirectML 从 Win10 1903 才随系统提供，且 1903 自带版本缺 `DMLCreateDevice1`，
  所以完整版安装包在两个 installer payload 里都随附 `DirectML.dll`；便捷版则通过
  `--no-default-features --features portable` 完全剥离 `ai`，不链接 ORT/DirectML。
  预编译件来自 pyke CDN（构建期下载，~341 MB 解压后留在本地缓存
  `%LOCALAPPDATA%/ort.pyke.io`）。
- 369 字节 fixture（单 MatMul，`[1,8]→[1,8]`）经 `include_bytes!` 内嵌，
  `OnceLock<Mutex<Session>>` 惰性加载（ORT Session 非 `Sync`），两个 Tauri
  command（`decision_ai_status` / `decision_ai_suggest`）+ 4 个单测全过。
- 门禁全绿：fmt / clippy `-D warnings` / `cargo test -p wowsp_tauri` /
  `cargo check --workspace`。注意 ort rc.13 实际 MSRV 1.88（workspace 标 1.85，
  CI stable 工具链无影响）。

### E2 · CruiseState `0x32` = 录制者的输入流，布局已逆向 ✅

- 实测布局（31 包全部恰好 8 字节）：`[u32 LE 控制域][i32 LE 档位]`——
  **没有 entity id**，是录制者范围输入流（同 camera/weapon_locks 模式）。
  控制域 0 = 节速（实测 -1..4：后退/停车/¼..全速），1 = 舵角（-2..2，负=port）。
- 与位置差分强一致：全速档位窗口 97.5% 时间速度 ≥50% p95；停车档位窗口
  98.9% 时间速度 ≤25% p95。录制者本船实体经 avatar 的 0x2c linked 字段
  确定性求出，`cruiseSamples` 只挂该船。
- 含义：**动作标签（航速/舵角）只对录制者本船可得**——正好匹配决策模型的
  产品形态（给本船提建议）；非录制者的动作不可直接监督。
- 附带发现：场景单位 ≈ 6–9 m/unit（弹道比值/航母全速 ~2.9 units/s/地图边界
  三锚点交叉一致），绝对标定待办。未确证项（更深后退档、半/满舵精确对应、
  潜艇控制域、非航母船种）均以 `None` + 注释记录，不做猜测。

### E3 · 「间隙 = 未点亮」证实：训练数据天然是不完全信息 ✅

真实录像统计（`replay_visibility_probe` command，或
`WOWSP_TEST_REPLAY=<replay> cargo test -p wowsp_tauri replay_probe -- --ignored --nocapture`）：

| 分组 | 实体数 | 首样本时刻 | >4s 间隙 | 观测占比 |
|---|---|---|---|---|
| 我方（teamId 0） | 10 | 全部 t=0.0 | **全部 0 个** | 全部 1.000 |
| 敌方（teamId 1） | 9 | 76.6–159.4s | **全部有**（合计 12–701s） | 0.130–0.930 |
| 镜像船（shipId 撞车无法定队） | 5 | 按边分裂为两簇 | — | — |

- 三重证据证实假设：我方零间隙、敌方全部有间隙且开局 ≥76s 不可见、
  5 条无法定队船的可见性签名恰好按敌我分裂（潜在的反推阵营能力）。
  **训练管线不会泄漏隐藏敌舰真值**；可见性本身需从样本间隙隐式推断
  （无显式 spotted 事件）。
- 实体→team 映射可用但非完备：EntityCreate shipId→rooster relation，
  另用 BattleResults JSON 做镜像撞船交叉核验（同一 shipId 出现在多个
  teamId 时降级；roster 相对值与 teamId 绝对值两个命名空间的标定是待办）；
  两队同船时 shipId 撞车（本场 24 船中 2 个 shipId 撞车波及 5 实体）→
  如实输出 `teamId=null + shipIdAmbiguous=true`。entity 级玩家身份不在
  数据流中，确定性 join 是待补能力。

### E4 · LOS 栅格可从已分发地图 GLB 离线烘焙，无需游戏安装 ✅

- 关键事实：模型包的地图 GLB 不是渲染网格，而是 **terrain.bin 高程场的导出**
  （50_Gold_harbor：201×201 规则网格、间距 8.96m）——「缺 terrain.bin」这个
  预期误差源不存在。脚本纯 stdlib+numpy（零新依赖），GLB 解析复用
  `bake_model.py` 模式 + `np.frombuffer` 向量化。
- 实跑（res 256 / 64 观测点 / 眼高 20m）：陆地 6.56%、最大岛高 17.83m、
  观测点平均可见 67.3%（岛上高点 82.5% > 海面，方向正确）；与 minimap 美术图
  目视对照岛屿轮廓吻合（IoU≈0.76，残差来自美术图摆放启发式而非栅格坐标）。
- 7 项 selftest（`--selftest`，CI 可跑）：栅格化往返、平地全可见、眼高单调性、
  山后阴影、200 点对 LOS 互换对称等全过；过程中修掉 DDA 角点死锁与观测者
  自格误遮挡两个真 bug。
- 成本：~33–46s/图（res 256），全量 ~50 图约 30–40 分钟单线程（res 128 仅
  5.7s/图）。误差整体偏保守（低估可见性）、量级 ~格元尺寸（5m@res256），
  与游戏地形遮挡判定同阶，对决策模型足够。

### E5 · 场景单位标定：`METERS_PER_UNIT = 5.86` ✅

- 主锚点：Lexington 满航速 33.5 kt（17.234 m/s，硬编码实验参考值）× 录像满档
  平台段速度 p90（2.941 units/s，80 个准稳态窗口；中位数 1.975 被 CV ~55s
  加速爬坡拖低，不能用）→ **5.86 m/unit**，把 E2 的 6–9 区间收紧。
- 交叉锚点：中队直线段速度按 paramsId 分组折算 44–321 kt，中段簇 118–180 kt
  罩住 Lexington 各机中队公开巡航 133–138 kt（支持 ~5.9）；炮弹炮口→瞄准点
  平均速度只给上界 14.76 m/unit（5.86 ≪ 上界，一致）。DTO 里线上 `speed (m/s)`
  字段与场景单位不同轴，后续注意。
- 系统误差：录制者的信号旗/改装是否改满速未知（±几个百分点）。

### E6 · 决策 tick 状态：模型输入表示首版 ✅

`decision_tick_state(replayPath, timeSec, losGridPath?)` Tauri command +
`build_tick_state` 纯函数（`decision_tick.rs`）：

- **录制者视角的不完全信息快照**：本船（位置/yaw/kt 速度/节速/舵角/HP），
  其他实体带 `observedNow`（最后样本 ≤4s，与 E3 间隙语义一致）与
  `lastObservedDelta`（陈旧情报年龄）；速度估计不跨 >4s 间隙差分；
  team 复用 E3 判定（撞车→null+ambiguous）；占点归属/进度；
  [t-30, t] 事件窗（炮弹/鱼雷/爆炸计数）。
- **LOS 接入零新依赖**：`terrain_los.rs` 用依赖树里已有的 `zip` crate 直读
  E4 的 `terrain_los.npz`（自写 ~60 行 npy 头解析），世界坐标 DDA 与 Python
  版语义对齐（端点格不测、300 对随机点交换对称）。真实数据 t=300：
  3 艘被点亮敌舰中 1 艘被地形遮挡（4361 m）——「地形视野影响」从 GLB 到
  特征标志的首条完整链路。
- 真实录像 t=300 实况：23 实体、敌舰被点亮 3 + 陈旧敌情 6、zones 40 条非空、
  30s 窗内 138 发炮弹。replay_probe.rs 提取 `resolve_team` 供复用（行为等价
  重构）。
- 门禁：**276 测试通过**（+15，零回归）、fmt/clippy/check 全绿。

### E7 · 开火决策监督样本：管线端到端跑通，需炮船录像 ✅

`fire_dataset.rs`（纯分析函数 + env 门控真实测试）在真实录像上的数字：

- **归属是显式字段**：`ShellLaunchEvent.ownerID` 100% join 到船实体（2411/2411），
  muzzle→owner 几何一致率 0.938；`shell_launches` 覆盖**双方所有被客户端看到的
  开火船**（18/24 艘），开火者开火时刻 97–100% 处于被观测状态。
- **装填可自恢复**：`salvoID` 是炮塔 pack 级而非点击级，按炮种（`gunBarrelID`
  主/副炮分组）+2s 聚合还原点击级 fire event；反推 18 艘炮船**主炮**装填
  6.9–30.5s（中位 ~16s）；**censoring（主炮口径）占存活时间 0.18–0.73、
  中位约 0.4**——负样本必须排除装填窗。副炮/高炮是 AI 自动开火，不进入
  资格/标签/censoring（交叉验证发现并修复的口径问题）。
- **样本规模**：2s 决策频率下每局 eligible 1330 点 / 开火 171 / 正类率
  0.129（无严重失衡）；实现上已修掉「装填完成瞬间的齐射会把前一决策点漏标进
  censoring 窗」的缺陷（改为装填将在标签窗口内完成即 eligible）。
- **负样本审计（20 窗）**：~60% 未开火原因可被现有特征表达（terrain-LOS 9、
  转炮偏角 2、陈旧情报 1），~40% 不可表达（瞄准解/提前量/换弹种/隐蔽博弈/
  故意 hold）——标签噪声地板，对应研究纪要的 confounder 结论与 two-head
  设计。
- **CV 局限（关键缺口）**：录制者是航母则对本船开火训练贡献为零（CV 火箭/
  炸弹不走 receiveArtilleryShots，全场 muzzle y≥15u 为 0）；其他炮船可做
  弱监督（缺 cruise 意图标签、敌方为不完全观测）。**需采集 BB/CA/CL/DD
  录制的录像。**
- **规模外推**：全船弱监督口径 1e6 样本 ≈ 752 局（Suphx 级 4M–15M 需
  3k–11k 局，可行）；录制者本船口径 1e6 ≈ 0.98 万局（差 1–2 个量级）。
  务实路径：**他人开火弱监督预训练 + 炮船录制者本船样本微调**。

### E8 · 烟雾几何确证；消耗品/显式点亮排除 ✅

- **烟雾：确证并实现**（`SmokeScreenEvent` DTO + `read_replay_smoke_screens`
  command）。entityType 4 = SmokeScreen（15.8.0 `entities.xml` 钉死，并纠正了
  旧注释「4=飞机中队」的错误）；创建态属性流布局
  `[u32 len][u8 n]{[u8 id][值]}`，id 2=radius、id 3=height。四重证据链：
  解出值域 {17, 17.5, 30}/{5, 10} 与 GameParams 全集一一对应；布烟者几何
  归属（创建点距识别船体 1–4 单位：Colonna 油烟 r=30、Veneto 排烟 r=17、
  敌 Yorktown 烟机 r=17.5/h=10）；**GameParams 距离单位 = 30 m**（雷达
  333.33→10km 等，非 5.86 场景轴）；寿命与 workTime+lifeTime 秒级对齐。
  真实录像 9 朵烟全解出（半径 510–900 m、舰布 h=5 / 空投 h=10 可区分）。
- **消耗品：排除（负结果）**。mid 27（5 字节位掩码脉冲）100% 与齐射对齐
  =逐炮塔开火标记；属性候选全部被 def 命名排除——但顺带钉死了
  `enginePower`/`engineDir`（**全船节速意图**，未来弱监督原料）、
  `selectedWeapon`、`burningFlags`、`hasAirTargetsInRange`。
- **显式点亮：排除（负结果）**。`visibilityFlags`(idx 35) 存在且活跃（953
  次变化、位 {1,2,6,8}）但位语义解不出（与位置流窗口一致性仅 60–68%，
  有反例）——**E3 的「样本间隙=未点亮」仍是唯一可靠可见性信号**。
- **最有价值的副产品**：从本机游戏安装（恰为 15.8.0 同 build）经 vendored
  game-assets VFS 取出权威 `Vehicle.def`/`Avatar.def`/`SmokeScreen.def`/
  `entities.xml`——后续可用它机器生成完整 method 表，消除经验偏移
  （当前 `EMPIRICAL_OVERRIDES` 的 14 个已钉 id 实测全部正确）。
- 门禁：285 测试通过（+4，零回归）。

**对视野特征的意义**：烟雾遮挡升级为定量几何（半径米数 + 高度档 + 硬起止），
tick 快照可算「敌舰已知位置是否在某活跃烟云内」；视野特征 = E3 间隙语义 +
烟雾几何 + 地形 LOS（E4/E6）的组合，边界已探明。

### E9 · 模型交付闭环：训练→导出→量化→端上推理全链路打通 ✅

> 目标是**管线验证而非模型质量**——训练数据只有一局录像，过拟合是预期且
> 被接受的；以下全部指标只证明机器运转正常。

- **样本导出**（`export_decision_dataset`，fire_dataset.rs）：真实录像
  **3584 行 / labelA(可打)=1330 / labelB(开火)=171 / 正类率 0.129**——与
  E7 参考数字逐位一致（测试内强制断言相等）。特征=固定槽位（敌 16+友 8+
  padding mask，观测优先距离排序）+ 全局特征（时间/本船状态/占点/事件窗），
  装填 censored 行也导出（头 A 需要负样本，头 B 在 Python 侧 mask）。
- **模型**（纪要 C 首选结构）：上下文化 DeepSets two-head，**316,802 参数**
  （0.32M，预算内），纯 MatMul/ReLU/masked-mean，无 attention/LayerNorm。
  BCE 两头分开 + 手工 label smoothing ε=0.05（`BCEWithLogitsLoss` 无此参数，
  是坑）；60 epoch CPU 48s，损失 1.135→0.513。
- **导出与量化**：静态 shape（batch=1）opset 17 导出，fp32 **1.27MB** →
  int8 动态量化 **330KB（3.8×）**。
- **三项一致性验证**（纪要 C 清单，全量 3584 行）：PyTorch↔ORT fp32
  max|Δp| = **2.7e-07**（门槛 1e-5，超一个量级余量）；int8 量化前后
  PR-AUPRC 0.5669→0.5670 / logloss 0.2762→0.2765（排序质量零损伤，概率
  平移 ≤7pp）；槽位 shuffle 置换不变 |Δlogit|<1e-6；全空 mask 无 NaN。
- **Rust ort 加载真实模型**（decision_ai.rs 的 `#[ignore]` 测试）：
  fp32/int8 均加载成功，**p50 延迟 165µs / 136µs**——比 1Hz 决策建议的
  预算低四个数量级。至此 E1 的推理壳吃上了 PyTorch 真实导出的模型。
- 依赖：训练侧 torch CPU 539MB + onnxruntime 46MB（实验性、未进
  requirements.txt）；**Rust 推理侧零新依赖**。
- 坑：onnxruntime 量化器在非 ASCII 路径（本仓库的 `源代码`）下写中间件
  会 FileNotFoundError——ASCII 临时目录量化再拷回；torch 2.14 导出需
  显式 `dynamo=False`。

### E10 · method 表从权威 def 精确复算，覆盖率 100% ✅

- **排序规则解出**（`exposed_index.py`，复刻 game-assets `rpc/entitydefs.rs`
  语义）：alias.xml 顺序解别名 → 按 Implements 声明序拼接（父接口一层在
  前）→ 同名保留首个 → 按参数 wire size 稳定排序（可变类型饱和 0xffff +
  VariableLengthHeaderSize），0 基索引即暴露 id。**54 个历史版本 × 12 个
  已钉方法 = 648/648 锚点精确复现**（离线对照本地参考 checkout）。
- **E8「+1→+4 漂移」之谜解开：不是规则错，是两个陈旧 pin**——
  explosions def=**131**（战斗效果簇 15.7→15.8 整体 +3，128 是未随迁旧值；
  本场录像 128–131 全静默故从未被证伪）；wardRemoved def=**51**（id 50
  实为 receive_removeSquadron——49/50 两 id 以 237 个 PLANE_ID 1:1 成对
  触发为铁证）。**两处 pin 按红线原样保留**（15.8.0 解码行逐字节不变），
  分歧以注释+测试固化，是否修 pin 属解码行为变更，留人工决策。
- **覆盖率**：15.8.0 完整表（Avatar 180 / Vehicle 84 方法）入 tests 模块
  （研究工件，不进解码路径）；真实录像实测 **Avatar 64/64 ids、Vehicle
  30/30 ids、77,364/77,364 次调用 100% 可解析**。
- **候选事件 id 全部定出（下迭代解析的钥匙）**：
  `updateMinimapVisionInfo`=155（本场 1,821 次调用！）、`clientInsideSmoke`=33、
  `ownSmokeCreated`=32、`vehicleLeaveSmoke`=10、`notifyAboutSmokePenalty`=11、
  `squadronConsumableUsed`=149、`receive_squadronVisibilityChanged`=79、
  Vehicle `onConsumableUsed`=72、`updateCoolDown`=167、`onChatMessage`=151 等。
  ——E8 排除掉的「消耗品/点亮」在拿到正确 id 后可以重新评估。
- 生成器可重现性：`gen_method_tables.py --defs` 离线校验模式（快照 diff
  硬失败、pin 分歧报 stderr）；重生成两次字节一致，15.8.0 行与全部历史行
  逐字节不变。290 测试通过（+5），fmt/clippy 绿。

### E11 · 点亮/消耗品/引擎事件确证（G1 核心）✅

- **`updateMinimapVisionInfo`=155 = 显式点亮事件流**（最高优先级候选拿下）：
  布局 `MINIMAPINFO×2`（每项 `[u8 n]{[u32 vehicleID][u32 packedData]}`）；
  **bit31=1（哨兵 0x80000000）= 未点亮标记**。与 E3 间隙语义的对齐率：
  **间隙起点 89/89、终点 89/89（双双 100%）**，其中 84/89 起点的最后一条
  恰为哨兵——E3 的「间隙=未点亮」从推断升级为直接验证，且从此有显式事件
  可用。packedData 低 31 位疑似位置量子（相关拟合 ~0.2 未解出编码，按红线
  保留原始值）。
- **`onConsumableUsed`=72 确证**（布局镜像上游 wows-toolkit 的 wows-replays
  UsageConverter）：104 次全 7 字节变体 1，跨 22 船双方阵营，ids
  {0,1,3,4,6,8,9,10,65}，时长 5–600s（id0=5s≈损管、id8=28s≈修理小组；
  id→名称映射留给 GameParams 侧）。
- **`enginePower`(idx9)/`engineDir`(idx10) 确证，语义修正**：是**引擎当前
  输出档（0-10 十分位）与力方向符号**，不是节速意图——满功率窗口中位速度
  0.842×p95（n=699）vs 低功率窗口 0.000（n=226）；录制者 7/7 次减油门
  ~1s 内 engineDir 翻 −1（制动）。覆盖 23/24 船。**意图标签仍只有录制者
  可得（E2 CruiseState）**。
- **排除/半确证**：`receive_squadronVisibilityChanged` 布局解出（PLANE_ID+u16）
  但 u16 与中队在场/缺席无判别力，排除；`clientInsideSmoke`/`ownSmokeCreated`/
  `vehicleLeaveSmoke`/`notifyAboutSmokePenalty` def 签名明确但本场零调用，
  半确证待样本。
- 门禁：300 测试通过（+6，零回归）。新事件进 `DecodedReplay`（私有），
  `ReplayStream` 未动；`E11MethodIds` 版本门控仅 15.8.x（晋升进生成表留后续）。

### E12 · 批量摄取 + 多局训练 + 烟雾进 tick（G2/G3）✅

- **G2 批量摄取**（fire_dataset.rs）：`export_decision_dataset_dir` 文件夹
  →聚合数据集，坏/空/非 replay 文件记录原因跳过不中断；每行带 `replayId`
  （walker 统一盖章）；LOS 栅格按 `<los_dir>/<地图短名>/terrain_los.npz`
  逐局解析、缺图降级。真实录像验证：3 seen/1 exported/2 failed（容错生效），
  3584 行与 E9 逐位一致。
- **G3 训练工程化**（train_fire_model.py）：`--data` 多文件 + `--data-dir`
  递归；按 replayId 的确定性 GroupKFold + 留一局评估（单局回退随机切分并
  高声标注）；**纪要 B 指标全实现**：log loss/Brier/PR-AUPRC/ROC-AUC/
  ECE+reliability/分层 Cohen's κ（距离桶×observed 敌舰数，n<30 如实 None）/
  decile lift（Spearman ρ）/「物理不能打」子集假阳性计数。`--selftest`
  无 torch 可跑。真实运行：held-out 头 B AUPRC 0.319、decile ρ=0.673、
  cannot-fire FP 40/454（一局数据，管线证据）。顺带修了 E9 的一个潜伏
  bug（ORT prefix 长度数组错配）。
- **烟雾进 tick**（decision_tick.rs）：`DecisionTickSmokeState`（flatten
  扩展，零共享 crate 改动）——活跃烟 {radiusM(GP×30)、remainingS、漂移
  中心} + 实体级 `entities_inside_smoke` 并行数组（米制统一比较）。真实
  对照：9 朵烟与 E8 逐条一致；t=300 恰 1 朵活跃、t=600 有 4 朵重叠。

### G5 第一版 · 127 局语料 + GPU 训练（进行中）🔬

- **语料**（用户授权读取本机全部录像）：127 局 = 96 局 14.5.0 + 31 局 15.8.0，
  118 局炮船录制（66BB/24CA/22DD/6SS，Montana 47 局主力）+ 9 局航母，30 张
  地图全部烘焙 LOS 栅格。批量摄取 **126/126 零失败**（14.5 走旧 method 表正常
  解码）→ **307,123 行 / 142,720 can-fire / 17,714 fired / 正类率 0.124 /
  1,639 决策者**。
- **GPU 训练**（`--device cuda`，yuzu-linux-node3 RTX 5880 Ada 48GB，
  torch 2.5.1+cu121，SJTU 镜像安装）：60 epochs 480s；全量推理分块 16k 行
  （一次性推 307k 行要 ~9GB 中间激活，共享显卡上 OOM——已修）。5 折
  GroupKFold CV + 留最大局 held-out。
- **第一份真实评估**（held-out = 最大局，CV 5 折）：
  - 头 A（物理可打）：held-out **AUPRC 0.961** / AUC 0.949 / ECE 0.037；
    CV 均值 0.897——硬规则头泛化良好
  - 头 B（专家会打）：held-out **AUPRC 0.225**（基线 0.124，**1.8× 提升**）/
    AUC 0.624 / ECE 0.031；top decile 实际开火率 25%（**lift 2.1×**）；
    CV 均值 0.187±0.021；训练 0.436 vs held-out 0.225（过拟合间隙正常）
  - cannot-fire 假阳性 292/2490——头 A 是学出来的不是规则，纪要 B 的
    「零假阳性」门槛在 serve 侧要靠硬规则兜底
  - **定性**：真实但尚弱——信号显著高于随机（1.8×），距 Suphx 级
    （需 3k–11k 局）还有 1–2 个数量级数据缺口，符合 E7 预估
- **端上闭环**：语料训练的 fp32/int8 onnx 在 app 的 Rust ort 运行时加载
  推理（fp32 p50 130µs / int8 111µs）。GPU 节点工作流：xpipe 跳板链
  `ssh -J lab@<FRP>:60913 lab@3.node.linux.local`，数据集 gzip 884→127MB
  传输；镜像只有 SJTU 教育网快（aliyun/官方均慢）。
- 管线门槛校准：loss 降幅断言从单局时代的 2× 调到 0.85×（多局初始 loss
  更低，126 局实测 1.40×）。

### E13 · 事后结果评估管线 + 版本切分压测（纪要 B「最强离线证据」落地）✅

> #448 之后的 master 带来了伤害归因能力（#1418 claim-partition 模型、
> shotKills 逐发命中流、HP 流自动探测与锚定），研究纪要 B 一直 PENDING 的
> 「post-hoc outcome lift」从此可算：不再只问「模型是否同意专家」，而是问
> 「模型高置信开火时刻的事后命中/伤害是否真的更好」。

- **结果字段进数据集**（`fire_dataset.rs`）：每个决策行新增
  `(t + labelWindow, t + 45 s]` 窗口统计——`ownerShotsHit`（决策者
  shotKills 计数，任意武器）、`ownerShotsFired`（主炮 shell_launches 计数）、
  `enemyHpLostNearby`（其命中落点半径内敌方 HP 下降总额：#1418 partition
  简化版，**不均分**只记窗口总额，交叉火力会在各自行里全额重复计入——
  排序用代理而非伤害台账，取舍见代码注释）+ `gameMode`（头文件 matchGroup，
  ops/bot 模式可打标排除）。**单位警示**：webui 参考实现的「500 m」半径实为
  直接比较场景单位（≈2.9 km @5.86 m/unit），本移植原样保留该口径使 #1418
  校准量级可迁移。校准对照：真实录像上「任意近弹覆盖的敌方 HP 掉落 / 敌方
  总掉血」= **0.86x**（15.9 与 14.5 两局一致），与 #1418 dealt 台账 0.62x
  同量级（差额 = DoT 与无弹着伤害，两者都天然未覆盖；窗口总额口径因不均分
  略高于单人台账）。
- **语料重摄取**：162 局（96×14.5 + 30×15.8 + 30×15.9 + 6 restored 旧版本
  + 万圣节/ops）→ **357,226 行 / 163,324 can-fire / 20,426 fired / 正类率
  0.125**；模式分布 pvp 251k / brawl 48k / ranked 21k / event 33.5k / pve
  3.2k（pve 局 0 can-fire 行——ops 打标排除确有必要）。**坑**：模型包 GLB
  已被 `optimize_glbs.py` 换成 meshopt 压缩格式，`bake_terrain_los.py` 的
  stdlib 解析器读不了——新增 `extract_glb_positions.mjs`（three 内嵌
  meshopt WASM 解码，验证与 GLTFLoader 逐坐标一致）+ `--positions` 输入，
  35 图全重烘焙（Gold harbor land 7.0% / 峰高 17.77 m，与 E4 的 6.56% /
  17.83 m 同源）。另发现 `terrain_los.rs` 真实栅格测试断言的是 #490 之前的
  旧 minimaps 边界（±600）——已按现 minimaps.json（±700）修正（该测试仅在
  栅格工件存在时激活，CI 因 out/ 不入库从未踩到）。
- **专家基线**（无模型，pvp 族 147,862 can-fire 行）：专家开火时刻 vs 持枪
  时刻——窗口命中率代理 **1.966 vs 1.710（+15%）**、窗口敌方 HP 损失均值
  **9,033 vs 4,970（1.82×）**。「好玩家在更优时机开火」在语料级成立。
  **限定**：两组都已在 can-fire 资格行内（censored 行映射 NaN 被排除，
  资格混杂已控制），但开火时刻机械上意味着正在交战——基线混有「时机质量」
  与「是否在交战」两个成分，故以 decile 曲线为主证据、该基线仅作方向参考。
  结果字段分布（同切片 can-fire 行）：窗口命中数中位 4 / p90 22，主炮弹数
  中位 3 / p90 10，`enemyHpLostNearby` 中位 306 / p75 6,732 / p90 16,334 /
  均值 5,453（51.5% 行 >0）；注意命中率代理 = 任意武器命中/主炮弹数，近战
  搏斗时 >1（次炮命中的口径噪声，README 口径即任务口径，Python 侧已注）。
- **模型 decile 三曲线**（`outcome_lift.py`，按头 B 概率十分位）：
  - 旧模型（127 局语料）在**从未见过的 15.9** 上：专家开火率 ρ **+0.985**、
    窗口命中率 ρ **+0.745**、HP 损失 ρ **+0.952**（top decile 1.60x 均值 /
    bottom 0.38x）。
  - 162 局新模型全语料（含训练局，参考曲线）：开火率 ρ **+1.000**（top
    decile 实际开火率 41.6% vs bottom 0.5%，77×）、HP 损失 ρ **+1.000**
    （1.91x vs 0.48x）、命中率 ρ +0.43。
  - 14.5-only 模型在 15.8 全量 36k 行上（纯分布外）：开火率 ρ +1.000、
    HP 损失 ρ **+0.988**、命中率 ρ +0.212。
  ——三条曲线里「开火率」与「HP 损失」在各模型/各版本切片上稳定单调：
  模型学到的确是「决策质量」而非「开火频率模仿」，且跨版本分布外成立，
  是对纪要 B「泛化担忧」的直接回应证据。产物：
  `out/fire_model/outcome_{expert_162,fresh_162,oldmodel_159,ho158model_158,
  ho159model_159}.json`。
- **版本切分压测**（`--holdout-version 15,8 --train-version 14,5`：训练只
  用 14.5 局、held-out 只用 15.8 局，其他版本行丢弃；CV 只在训练侧折——
  本轮 node3 仅 8 核，跑了 no-CV 版，CV 留待下轮）：

| 配置 | 训练 | held-out | 行数 | 头B AUPRC | 头B AUC | ECE | top-decile lift | outcome ρ（开火率/命中率/HP） |
|---|---|---|---|---|---|---|---|---|
| G5 旧模型（127 局） | 125 局混合 | 最大局（同分布） | — | 0.225 | 0.624 | 0.031 | 2.1× | —（当时 PENDING） |
| 162 局新摄取 | 160 局混合 | 最大局（同分布） | 6,289 | 0.219 | 0.645 | 0.029 | 2.48× | +0.98 / −0.92 / +0.59 |
| 版本切分 | 14.5×96 局 | **15.8×29 局** | 36,456 | **0.241** | 0.609 | 0.096 | 1.47× | **+1.00 / +0.21 / +0.99** |
| 版本切分 | 14.5×96 局 | **15.9×30 局** | 32,267 | 0.199 | 0.590 | 0.136 | 1.61× | +0.96 / +0.18 / +0.83 |

  结论：头 B 排序质量跨版本**保持**（AUPRC 0.20–0.24 vs 基线 0.125，~2×），
  但**概率校准随版本距离退化**（ECE 0.03 → 0.10 → 0.14，部署阈值前需
  recalibration——纪要 B 预判应验）；HP 损失 outcome 曲线在分布外仍强单调
  （15.8 上 ρ +0.99，top decile 1.39x vs bottom 0.40x）。命中率代理曲线最
  弱（ρ +0.2——任意武器命中/主炮弹数的口径噪声），HP 损失是最干净的结果
  信号。

### E14 · 特征 v2（事件/烟雾/天气/配装接入）⚠️ 部分有效，但踩中版本门控陷阱

> 把 E11 解出却一直被 `assemble` 丢弃的点亮/消耗品/引擎事件、E8 烟雾几何、
> 气旋时间线与盟友雷达/水听事实接进训练特征（schema 版本化：v1 行仍可读）。

- **schema**：实体槽 10 → **15** 维（+`spottedNow` 显式点亮、`insideSmoke`、
  `radarLit`、`isEnemy`、`enginePowerFrac`），全局 14 → **27** 维（消耗品活跃
  ×3、引擎 ×2、`e11EventsKnown`、烟雾 ×3、天气 ×2、盟友雷达/水听 ×2）；
  Rust 侧一次解码即带出四类事件（`decode_replay_stream_with_events`，零额外
  读盘）。
- **同分布**（留最大局 6,289 行，v1 对照取同 162 局语料的 `corpus162`）：
  头 A AUPRC **0.9874 → 0.9884（+0.10pt，基本持平）**——注意别拿 125 局旧
  模型的 0.9613 对比（跨语料不可比）；头 B 0.2192 → 0.2091（−1.0pt，同语料
  5 折 CV σ=0.0076，属小幅下降；v2 各 run 跳过了 CV，未做折间显著性）；
  ECE 0.0288 → 0.0203。
- **全语料 outcome lift**（147,862 can-fire，排除 event/pve）：v1 基线 HP
  ρ 1.0 / D1 1.907 / D10 0.483（3.95×）；v2-plain ρ 0.988 / 2.017 / 0.677
  （2.98×）——**同分布（含训练行）铺开反而略降**。
- **版本切分压测（14.5×96 局 → 15.8×29 局 36,456 行）暴露真问题**：
  v2-plain 头 A AUPRC **0.775**（v1 同切分 0.967）、cannot-fire 假阳性
  **13,111/22,286（58.8%）**、头 B AUC **0.518（随机）**、ECE 0.173。
- **根因（数据实证）**：两类事件解码门控**彼此错开**——E11（点亮/消耗品/
  引擎）只在精确 **15.8.x** 可用（14.5 行全哨兵：`e11EventsKnown=false`、
  消耗品/引擎 = −1），盟友配装（radar/hydro 持有者）只在 **15.9.x** 可解
  （15.8 行 `allyRadarCountFrac=-1` 100%）。用 14.5 训练 → 15.8 测试时，
  模型对从未学过的列突然收到真值 = 训练/推理特征分布错位。烟雾与天气特征
  **跨版本可用**（14.5 行同样有真值）。
- **消融验证**：`--ablate e11`（保留烟雾+天气）后 14.5→15.8 大幅恢复：
  头 A AUPRC 0.9533（**仍低于** v1 的 0.967）/ ECE 0.020 / 假阳性
  1,267/22,286（5.7%），头 B AUPRC **0.2527（优于 v1 的 0.241）** / AUC
  0.616 / ECE 0.093，HP ρ 0.952。
- **结论与规则**：(1) 跨版本训练默认**必须关闭版本门控特征组**（E11/配装），
  或按 `e11EventsKnown` 做行级屏蔽并只做同版本训练；(2) 烟雾+天气在 E11 关闭
  后未拖累跨版本表现（未能单独消融，故「安全增量」是方向性推断而非独立
  归因）；(3) 新版本上要先跑 `gen_method_tables.py --defs` /
  `gen_property_tables.py` 钉表，再启用这些特征。这条「版本门控特征 =
  分布外毒药」是本轮最重要的工程教训。

### E15 · 命中条件化标签（hit / soft）⚠️ 无提升，plain 仍是默认

> 假设：打空炮的时机不该与打中的时机被无差别模仿。做法：头 B 目标改为
> `labelBHit`（窗口内开火且 ≥1 确认命中）或 `labelBSoft`（0.3 + 0.7·命中）。

- 同分布头 B AUPRC：plain 0.2091 / hit **0.2032** / soft **0.1901**——
  两个变体都**不优于** plain。
- 全语料 outcome HP 铺开：plain 2.98× / hit 3.22× / soft **3.50×**
  （soft 在同分布略好，但版本切分上 soft ho158 头 B AUC 0.541 明显弱于
  plain+`ablate e11` 的 0.616）。
- **解读**：命中是**部分由随机性（散布、RNG 引燃）决定的结果**，把标签
  条件化在命中上会丢弃合法的压制射击/逼迫走位价值，且引入幸存者偏差；
  与纪要 B 的「不可观测混杂」结论一致。**默认保持 plain**；
  `--label hit/soft` 作为研究开关保留。

### E16 · 走位数据集 + 走位模型（G6 第一步）✅ 同分布击败基线，OOD top-1 未过

> 「这个时刻、这份情报下，每艘船往哪儿走是最优的」——开火决策（E7–E15）
> 的走位孪生。监督 = [t+4, t+16]（12 s）内的实际位移：16 个 22.5° 方位
> 扇区，**以本船当前朝向 yaw 为参考系的相对扇区**（WoWS 打舵语义是相对
> 艏向；serve 侧用 yaw 还原绝对方位）+ 1 类「无明显移动」（< 100 m；
> 100 m / 12 s ≈ 16.2 kt——低速直航船合法落此类，语料直方图 36.9%）。

- **导出**（`fire_dataset.rs` `export_move_dataset[_dir]`，与 fire 导出同
  v2 特征管线——重构出共享的 `DecisionRowCore`/`build_decision_row_core`，
  fire 行 JSON 逐键不变；`Deref` 兼容旧字段读取，decision_serve 未动）：
  决策点 = **每艘 team 已知的船**（航母/未开火船含入——走位对全员有意义，
  与 fire 的 has-fire-history 门 deliberately 不同），4 s 节奏，E7
  own-observable 门；标签窗口两端取「≤2 s 新鲜的尾随样本」，黑窗内无真值
  则整行 censored（绝不跨间隙插值）；死亡/流尾截断的窗口不出行。162 局
  语料 **0 失败 → 178,890 行 / 2,212 deciders（13.7/局——镜像 shipId 撞车
  使 roster 只解出 ~14/20 船，行数远低于 90 万预估）/ 14,962 censored
  （7.7%）**；movedDist p50 137 m / p90 210 m；**16 个方向扇区近乎均匀
  （3.4–5.6%/扇，sector 0 仅 3.8%）**——12 s 位移口径下「惯性」并不
  主导，压舱的是 no-move 类（36.9%）。
- **训练**（`train_move_model.py`，复用 train_fire_model 的 featurizer/
  切分/版本工具；DeepSets 同骨干 + 17 类 softmax 头 327,377 参数，CE +
  label smoothing 0.05，40 epochs 89.5 s@node3；默认排除 pve/event 局
  → 162,073 行 / 142 局）。对照基线全部同表报告：

  | 配置（held-out） | inertia top1/3 | speed-gated 惯性 | 多数类 | **模型 top1/3** | 模型 ECE | 方向行 top1 |
  |---|---|---|---|---|---|---|
  | 同分布·ablate e11（最大局 3,065 行） | 0.028/0.097 | 0.467/0.573 | 0.503/0.580 | **0.556 / 0.693** | 0.057 | **0.170**（基线 ≤0.057） |
  | 同分布·ablate none | 同上 | 同上 | 同上 | **0.556 / 0.700** | 0.054 | 0.169 |
  | 版本切分 14.5×112 局 → 15.8×30 局（20,440 行） | 0.033/0.100 | 0.383/0.454 | 0.387/0.483 | 0.372 / **0.508** | 0.119 | 0.083 |

- **结论**：(1) 同分布下模型击败全部基线（top1 +5.3 pt over 多数类，
  top3 +11 pt），且**方向行（真值≠no-move）top1 0.170 = 基线的 3 倍**、
  sector-16 recall 0.936——模型学到的不只是「多数类」，方向结构真有信号；
  (2) **版本切分上 top-1 输给多数类 1.6 pt**（top-3 仍 +2.4 pt）且 ECE
  0.12——OOD 上概率质量移出 no-move 类（预测熵 1.58 vs 同分布 1.38），
  与 E13「校准随版本距离退化」同型；扩数据/版本混合训练是 E17+ 的活；
  (3) v2 全量特征同分布中性（0.5563 vs 0.5560），与 E14 同分布结论一致；
  (4) **坑：17 类头的 int8 动态量化比 fire 二元头伤得多**（检查行 top1
  0.536→0.523，max|Δp| 至 0.19）——部署取 fp32（1.3 MB），量化另议。
- 产物：`out/move_model/dataset_corpus162.jsonl`（675 MB，162 局）、
  `out/move_model/node3/{main,ho158,plain_none}/{fp32.onnx,int8.onnx,
  metrics.json,sample_input.json}`；门禁 fmt/clippy/
  `cargo test -p wowsp_tauri` 1238 通过（基线 1234 + 4 个新测试，零回归）。
- 留 E17：走位 outcome 代理（位移落点 vs 掩体/占点/高 fireProb 区域）、
  serve 侧接线（decision_serve/decision_ai 后续波次）、`turnSign` 加分项。

### E17 · 每船评分体系（G6 第二步）❌ 预注册线未过——阴性结果如实记录

- **实现**（`decision_score.rs` ~1,290 行 + `validate_scores.py`）：瞬时分 =
  模型对「实际动作」的概率（开火：p(fired)；走位：实际扇区 softmax 质量，
  proper scoring rule 逐点形式）；置信度独立输出；整局分 = 时间均值 +
  fire/move 分量；BattleResults join（镜像 shipId 撞车船排除，覆盖 89.0%，
  1,924 船）。双 ONNX fp32 加载（**move 模型按其训练配置做 e11 列置零**，
  列级测试钉死）；162 局全量跑通零失败，178,890 决策点与 E16 逐位一致。
- **验证（预注册：ρ≥0.30 有效 / 0.15–0.30 弱 / <0.15 失败）**：
  wholeGame vs damage **ρ=+0.011（n=1,924，失败）**；局内排名均值 ρ=−0.021
  （正局占比 50.7% = 抛硬币）。分量：wholeFire vs damage **−0.127（显著为
  负）**、wholeMove **+0.065（唯一稳定正信号，仍低于弱线）**；pvp 子集
  fire 分量更差（−0.206）；DD/BB 舰种最差（−0.27/−0.14）。
- **失败机理（数据实证）**：①开火分量饱和于「消极同意」——头 B 学的是
  12.5% 基率的保守分布，hold 几乎总被同意（wholeFire p50=0.83 无区分度），
  而残差方向继承「本语料实际开火率 vs 伤害 = −0.136」的负相关；②覆盖度
  本身 ρ(样本数, damage)=+0.308——携带的是生存/视野信号而非决策质量；
  ③E13 的 outcome 单调性在**逐决策窗口**层面（147k 行 decile），逐船全程
  平均把它稀释成噪声。
- **构造修正尝试（追加分析，未过）**：只对「实际开火的行」取模型背书
  （fired-only endorsement）ρ=−0.046（n=849），高频射手子集（nFe≥10）更差
  （−0.144）——**修构造救不回来，瓶颈是模型代际本身**（162 局 vs E7 预估
  的 3k–11k 局）。
- **结论与含义**：评分**基建可用**（DTO/双模型/时间序列/join），E18 UI 可以
  接；但「评分=决策质量」语义在当前模型代际**不成立**——UI 必须以「模型
  认同度 + 置信度」诚实标注，不宣称等于水平/战绩；待语料增长重训后按同一
  预注册协议复验。瞬时分的时序结构（开局均值高、全员奔点的 trivial
  agreement 佐证）也一并记录。
- 门禁：`cargo test -p wowsp_tauri` **1,244 通过**（+6 零回归）、clippy/fmt
  绿、validate_scores --selftest 过；本机 CPU 全语料评分 ~13 分钟。

## 对总体可行性的意义

阶段 0 四项前提全部成立：**推理运行时**（E1）与**地形视野特征**（E4）是纯
工程；**训练数据**天然满足不完全信息约束（E3），动作标签对录制者本船可得
（E2）。阶段 1 补上了**单位标定**（E5）、**模型输入表示**（E6）与**开火样本
管线**（E7）——从录像到 (状态, 标签) 的监督数据链路已在真实录像上端到端
打通，正类率 14% 无严重失衡。

下一步：采集炮船录像（E7 的硬缺口）→ 弱监督预训练 + 本船微调的第一个开火
决策模型（结构见研究纪要 C）→ `decisions` 模型包分发（复用 `model_pack.rs`，
随包发布 LOS 栅格）→ 战术板建议渲染。已知待补：entity→player 确定性 join、
把烟雾几何接进 tick 快照（E8 已解出、接线待做）、用 15.8.0 def 文件机器生成
完整 method 表、`enginePower`/`engineDir` 全船节速解码。

## 研究纪要（训练侧调研）

### A · 录像数据规模化获取

- replayswows.com 九年累计约 20 万局（URL ID 上界估计）；robots.txt 允许爬
  公开页、无站方 ToS/API——爬取属灰色地带（限内部训练、不公开再分发、入库
  即匿名化）；无公开 WoWS replay ML 数据集，学术爬取先例仅 Murnion 2018（WoT）。
- 版本碎片化：~4 周一版、replay 只能原版客户端回放，但**解析**侧
  replays_unpack 血统工具覆盖 0.8.0–15.4.0 且 CI 自动跟进——对特征提取阻碍小；
  同质性处理用「最近 3–4 版本训练 + 版本留出验证 / 版本 embedding」。
- 路线排序：10³ 局 = 用户授权上传 + 限速爬取；10⁴ 局 = 爬取 + WG Public API
  富集玩家水平（20 req/s）；10⁵ 局 = 只有产品内 opt-in 遥测可行。
- **产品化要点（合规最干净）**：客户端本地抽特征、只上传决策点特征而非原始
  replay（同时解决 GDPR 最小化/带宽/版本碎片），玩家 ID 哈希化、映射表不留存，
  每条样本带版本/舰种/分段标签。

### B · 无环境评估协议与标签噪声

- 「未开火的原因缺失」= causal imitation learning with unobserved confounders
  （Zhang & Bareinboim, NeurIPS 2020）：BC 在不可观测子集上不该被期待超越专家，
  评估按「可观测性」分层报告。E7 实测 ~40% 负样本不可归因，与之吻合。
- **two-head 结构（DeepHit 模板）**：头 A「物理上能否开火」（LOS/射程/装填
  硬规则弱标签）、头 B「可打时专家是否选择打」——噪声只进头 B。未开火帧按
  情境开火倾向降权（PU learning），label smoothing 轻 ε=0.05–0.1。
- **评估指标**：按玩家 GroupKFold；主指标 PR-AUPRC + log loss（正类 14% 无需
  激进手段）；ECE + recalibration 后再调部署阈值；分层 Cohen's κ（距离桶×
  舰种对×点亮状态）；**最强离线证据 = post-hoc decile lift**（模型概率分桶
  vs 事后 15–30s 命中率/伤害的单调性，体育分析 shot-decision 模型的成熟做法）；
  「物理不能打」子集假阳性必须为 0。

### C · 可导出 ONNX 的实体编码结构

- **首选：固定槽位 + padding mask 的上下文化 DeepSets**（per-entity 共享 MLP
  →全局特征 broadcast 拼接→窄交互层→二元头，<0.5M 参数，静态 shape 导出）。
  无 attention → ONNX 导出与 int8 动态量化整条风险链消失。
- attention/SDPA 的 dynamo 导出坑有明确 issue 证据（opset<24 不支持
  scaled_dot_product_attention、attention_mask 被忽略等）——只在首选欠拟合时
  才考虑自写显式 MatMul attention 的 2 层 Set Transformer（opset 17）。
- 导出验证清单：onnx.checker、随机 ≥1000 样本 PyTorch vs ort 一致性
  （max|Δp|<1e-5）、置换不变性（DeepSets）、量化前后 PR-AUPRC/ECE 变化
  <0.005、mask 全 -inf/空槽位 NaN 注入、P95 延迟 <5ms。
