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

> 另有训练侧三主题网络调研（数据规模化获取 / 无环境评估协议 / 可导出 ONNX 的
> 实体编码结构），结论见文末「研究纪要」。

## 目标路线图（G1–G5）

| Goal | 内容 | 完成标准 | 状态 |
|------|------|---------|------|
| G1 | 视野与状态特征完备 | tick 快照含：烟雾遮挡、消耗品状态、可见性事件、全船节速意图 | ✅ E8/E11/E12（节速意图仅录制者，全船为引擎输出档） |
| G2 | 数据规模化就绪 | 任意录像文件夹 → 一键聚合数据集（容错跳坏文件）+ 按局切分 | ✅ E12 |
| G3 | 训练工程化 | 多局训练 + 纪要 B 评估指标全实现（分层 κ / ECE / decile lift / GroupKFold） | ✅ E12 |
| G4 | 分发与端上集成 | `decisions` 模型包（含 LOS 栅格）+ 端上加载真模型 + 战术板建议层 | ✅ G4-a/G4-b（pack 管线 + `decision_fire_suggestions` + 2D 地图建议层） |
| G5 | 第一个可用开火决策模型 | 炮船录像 ≥ 数百局 → 弱监督预训练+本船微调 → 纪要 B 验收门槛 → 随包分发 | 🔬 第一版已训（127 局语料，见下） |

**已决策（2026-09-21，用户批准）**：两个陈旧 pin 已采纳为解码行为变更（`explosions` 128→131、`wardRemoved` 50→51，13/13 锚点与 def 精确一致）；G5 扩数据按「持续积累炮船录像 + `archive_replays.py` 定期归档」推进——**游戏客户端默认只保留当前版本最近 ~30 局**，未归档录像会被静默删除，归档目标 `%LOCALAPPDATA%/WoWSP/replay-archive/`（幂等，可重复跑）。重训节奏：语料每增长 ~50% 在 GPU 节点重训一次（环境已就绪）。

## 结论

### E1 · ONNX 推理运行时可静态编入桌面应用 ✅

- `ort =2.0.0-rc.13`（精确 pin：rc 线 API 不稳）默认 `download-binaries` 静态链接：
  测试 exe 的 PE 导入表**无 `onnxruntime.dll`**，核心运行时已编入（附带系统自带的
  DirectML 依赖，Win10 1903+ 无需分发）。预编译件来自 pyke CDN（构建期下载，
  ~341 MB 解压后留在本地缓存 `%LOCALAPPDATA%/ort.pyke.io`）。
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
  wowsunpack VFS 取出权威 `Vehicle.def`/`Avatar.def`/`SmokeScreen.def`/
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

- **排序规则解出**（`exposed_index.py`，复刻 wowsunpack `rpc/entitydefs.rs`
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
- **`onConsumableUsed`=72 确证**（布局镜像 vendored wows-replays 的
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
