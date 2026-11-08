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
| E19 | 语料扩容 ×13.6 + MoE 软路由重训 + E17 复验 | 海王赛公开录像入册（163→2217 局）后，软混合专家能否提升双模型；整局评分能否过预注册线 | ⚠️ | 双模型均升（fire AUPRC 0.32/move top-1 0.586，门控健康分化）；E17 复验**仍失败**（ρ=−0.059，wholeFire −0.30 反向）——评分聚合语义缺陷，非功效不足 |

| E20 | 评分聚合重构（机会捕获族） | (p, fired) 逐决策对 + 探索/确认分割下，任何模型聚合能否过 ρ≥0.30 | ❌ | 最优正信号是纯开火量 C7（确认集 ρ=+0.222）；模型聚合族全负或更弱——伤害信号经由交战体积流动，见下 |

| E21 | xD 整局评分（实现−期望） | 换建模目标后整局评分能否过 ρ≥0.30（探索/确认分割预注册） | ✅ | X3（开火窗口实现伤害）确认集 ρ=+0.477、同场内 +0.427 首次过线；X2 超期望转化率探索集 +0.34（非循环论证信号） |### E19 · 语料扩容 + MoE 软路由双模型重训（G5/G6）⚠️ 模型升、评分线仍不过

| E23 | 域外泛化验证（留出语料） | in-sample 验证的 ρ 有多少水分：own+apac 训练 → eu+na 打分 | ✅ | X2 域外 ρ=+0.383（in-sample +0.376，**零退化**）；fire 决策级 hp-lost ρ 0.915→0.830；走位 top-1 持平 |
| E24 | 武备属性前置路由（shipId→属性表） | 路由器读武备属性而非船名：分类/校准能否提升、代价是什么 | ⚠️ | 定版：AUPRC 0.3560 / ECE 0.0266 / headA 误报 40/2490 历代最好；hp-lost ρ 0.915→0.600 仍退化——**双模型分工定案**：评分用 E19、建议用 E24（int8 有 0.911 头 A 偏移，交付只走 fp32） |
| E26 | 鱼雷决策数据集 + 试点（P1） | 从 `TorpedoLaunch` 导出「能否发射 / 专家是否点击」监督，鱼雷点击决策是否可学（预注册 headB AUPRC≥2×base 且 top-decile lift≥1.5×） | ⚠️ | own 86k 行/161 局（canLaunch 55.5%、launched 0.98%）；**headA AUPRC 0.985 可学；headB 0.0109 = 1.12×base、top-lift 1.01× → 预注册 FAIL**（4 s 节奏协议 bug 已修复，E26b 探索性复跑见下） |
| E26c | 全量语料鱼雷 scale 测试（node3 GPU） | headB 弱是「数据少」还是「特征不行」：全量 2,215 局同协议复跑（scale-only，不改特征） | ⚠️ | 3,111,384 行/2,215 局（canLaunch 1,052,311、launched 17,055 = 1.62%）；**headA 0.998；headB AUPRC 1.91×base（差 2× 线 0.09）、top-decile lift 2.33×（过线）→ MIXED**；AUC 0.675 vs own-only 0.587——scale 显著有效但未完全过线，下一步转 E26d 特征/标签 |
| E26d | 鱼雷几何/类别特征迭代（torp2，node3 全量） | 从现有行派生 11 维几何+类别特征，能否把 headB 推过 2×base 且 top-decile lift≥1.5× | ✅ | 3,111,384 行/2,215 局，global 27→38；**headB AUPRC 0.03705 = 2.29×base、top-decile lift 2.66×、AUC 0.7084 → 预注册 PASS**；headA 0.99989；E26c core 复跑逐位一致（0.0309248/2.3307） |
| E26e-a | OOF 落盘 + 温度校准（鱼雷 headB） | OOF 概率经单温度缩放能否达到常数基线的 logloss/Brier 水平 | ✅ | 3,111,384 行 OOF（npz 27.2 MB）；T=0.7586；logloss 0.09004→0.07947（<0.08289）、Brier 0.01640→0.01583（<0.01594）、ECE 0.0246→0.00053，AUPRC/AUC 不变 → **PASS** |
| E26e-b | 鱼雷 outcome-lift 评估（OOF probB vs 实际命中） | 排序专家点击是否也排序实际命中：launched 行 top-decile hit-rate lift ≥1.25× 且十分位 ρ≥+0.30（CI 排除 0） | ⚠️ | 3,111,384 行 join 100%；17,055 launched / 71,693 fish / 5,854 hits（base 8.17%）；top-decile lift **1.223×**（差 0.03 未过）、十分位 ρ **0.952**（CI 0.672–0.976）、HP/fish top-bottom 5.6× → **MIXED**：排序强 outcome 信号但 top-decile 未过线 |
| E26e-c | outcome-aware 第三头（headC）+ 类别温度校准 | 直接监督 P(命中\|已发射) 能否把 launched 行 top-decile 命中率 lift 推过 1.35×（高于 E26e-b 1.223×）并 ρ≥+0.30 | ✅ | 3,111,384 行 + 4 sidecar join 100%；headC OOF（17,055 launched）：AUPRC 0.254/AUC 0.715；**outcome-lift top-decile 命中率 18.07% vs base 8.165% = 2.213×（CI 2.03–2.41）、十分位 ρ 0.988（CI 0.964–1.0）→ 预注册 PASS**；类别温度：headB global T 0.7581、logloss 0.09062→0.07998；headC T 1.0538、ECE 0.0084→0.0070 |
| E26e-d | 解耦 outcome headC + 联合排序 | 独立 headC（launched-only 训练）+ joint=probB*probC 能否 ≥2.2× 且 headB 不退化 | ⚠️ | headB（E26e-a 原模型，未重训）outcome lift **1.2234× 原样**、ρ 0.952；standaloneC **1.301×**/ρ 0.915；**joint 1.381×（<2.2 预注册线）**/ρ 0.952/CI 排除 0 → **MIXED：解耦无收益，共享 headC（2.213×）更优** |
| E26e-e | 多任务 headC 损失权重扫描 | λ_C ∈ {0.1,0.3,0.5} 能否同时恢复 headB（AUPRC≥0.0365 且 top-lift≥2.55）并保持 headC（outcome lift≥2.0、ρ≥0.30） | ⚠️ | λ=0.3（预注册主配置）：headB **0.034862 = 2.151×base**、top-lift **2.5195**、AUC 0.6963；headC outcome lift **2.1815**/ρ 0.988/CI [2.006,2.375] → (a) 未过、(b) 过 = **MIXED**；扫描显示 λ↓ 恢复 headB（λ0.1：**2.222×**/2.610/AUC 0.7043，headC **2.252**）→ 方向对但 0.3 不够；下一步 λ≈0.05–0.1 / frozen-trunk |
| E27 | 中队状态九流逆向（血量/逐机血量/伤害/油门/消耗品/坠机） | Avatar 的 squadron 状态方法群能否 def 推导 + 实证解码，喂给飞机跟随卡片（实时血量、加速、消耗品） | ✅ | 九流全解：见下 |

### E27 · 中队状态九流（血量 / 逐机油门 / 消耗品 / 坠机）✅

- **动机**：#1833 合入的飞机跟随卡片缺三样真数据——中队实时血量、引擎加速、消耗品状态（用户点名「飞行重整 / 拉烟」）；updateSquadron 只带位置/朝向/俯仰。
- **def 权威源**：reference checkout（≤15.7）+ 本地提取 defs159（15.9，CN360 build 13357822）与 defs1510（15.10，Steam build 13533378）经 `exposed_index.py` 复算 exposed id；锚点（updateSquadron/artillery/damageStat/chat）在 14.5 / 15.8 / 15.9 / 15.10 四个版本全部对上出货表 → 九方法 id 三版本钉死（15.8≡15.9：84/94/87/62/149/68/147/61/59；15.10 盾插位 +1：84/95/88/62/150/68/148/61/59）。Lesta 表留 None 待实证。
- **实证语料**：Steam 安装里的 14.5.0 翔鹤 CV 录像（`replays/14.5.0.0/20250708_192303_PJSA108-Shokaku_37_Ridge`，录制者=CV）——探针 `dump_squadron_state_methods`（corpus 门控）逐字节定布局：squadronHealth 的 float 是 **0..1 总血量分数**；changeThrottleMode 是 **0=巡航/1=加速** 二值（561 次真实调用，覆盖敌我双方中队）；squadronConsumableUsed 线上只有 **1 字节类型 id**（20/21/22，def 写 CONSUMABLE_USAGE_PARAMS 属 def/线分歧）配对 StopWorking=窗口关闭；planeDeath 的 ARRAY 前缀是 **u8 计数**（非 u16/u32）+ u8 理由 + i64 凶手。Avatar 实体门控必要：同数字 id 在车辆实体上承载完全不同的载荷（探针的 len-129/99 噪声）。
- **逐机油量位域破解**（`sq_planes_health.md`）：u64 = **每机 3 bit 的八进制位域**（1=HP>3/4、2=(1/4,3/4]、4=≤1/4；位数=在飞数，坠机=顶位截断，180/180；0x249 重复纹样=八进制全 1，误导了 nibble/BCD 假设）；伴随 float 分母=**addSquadron 第 18 字节的出击机数**（23/224 局从打空的机库部分出击）——两字节现入 SquadronCreate。815 个同步样本 0 违例，B12 边界被 0.755/0.746 对钉死。
- **落地**：九解码器 + `read_replay_squadron_states` IPC + 解包助手（`PlaneHealthBand` 族）+ 卡片三态（HP 条/加速徽标/消耗品 chips，`planeCardExtras` 10Hz 派生）。消耗品 id→名称映射待 GameParams 侧研究，chips 暂以「消耗品 N」诚实展示。
- **语料门控测试的已知边界**：vehicle-build 与 cruise-state 两个**预先存在**的 corpus 测试各自期望特定的参考录像（15.9 配装捕获 / 有持续停车窗口的盘），喂其它录像会各自失败——master 同样失败，非本支回归（CI 无 WOWSP_TEST_REPLAY 时全跳过）。

### E27b · 中队消耗品 id→名称钉死（20/21/22/42）✅

- **方法**：`dump_squadron_consumable_windows` corpus 探针（time-aware 联表：每次 Used 联到其前最近的 addSquadron paramsId——first-add 联表在 planeId 复用下会错位，曾产出伪矛盾）在**五盘 14.5 CV 录像**（翔鹤×4 + 约克城×1，Steam 安装）上配对每个 Used→StopWorking/Interrupted 窗口，与 GameParams（CN360 15.9 dump）里全部 10 个 squadron 组 PCY 的 `consumableType`/`workTime` 指纹比对。
- **结论**：20=healForsage 引擎加力（5.0s 窗 17/17，双方通用槽0）；21=planeTacticalFighters 战术战斗机（60.0s 全窗 + 召唤物被击落的 INTERRUPTED + 中队回收时的 NEVER CLOSED，通用槽1）；42=planeSmokeGenerator 拉烟（10.01s 精确命中 US_SCV 10.0s，仅约克城支援 DB 装备该槽，同中队另有 12.6s 变体窗）；22=5s 防御消耗品（翔鹤侧=PCY085 支援灭火 JAP_CV 5s 精确命中）。
- **证伪记录**：槽位+20 假设（id=slot+20）被约克城盘击毁——同一 slot2 在翔鹤战斗机（灭火）出 22、在约克城 DB（拉烟）出 42；全局枚举假设同样不成立（42 覆盖 10.0s 与 12.6s 两种窗长）。id 的本体论最终按「消耗品实体分组」落名，其中 42 与 22 的区分度由中队配置联表保证。
- **诚实边界**：约克城 TB（PAAB218）在 14.5 录像里 22 号窗同为 5.0s，但 15.9 GameParams 该槽已是 activeManeuvering(12s)——14.5 对局装配与现行 GameParams 的版本漂移，无法用本地数据裁决，故 22 的文案定为「灭火/防御类」而非断言具体实体。
- **落地**：`CONSUMABLE_LABEL`（planeFollow.ts）补 42 + 8 语言真名（引擎加力/战术战斗机/灭火/拉烟）；探针与配对测试随库保留。

### E27c · 莱服九方法钉死 + 消耗品枚举分叉 + 多重巡航高度侦察 ✅

- **莱服九方法 id**：对本地 Korabli 安装（25.8 期 build 8871067）的 entity defs 跑 `exposed_index.py` —— 六个锚点（updateSquadron 144 / addSquadron 116 / artillery 124 / shotKills 126 / damageStat 166 / achievements 160）与已出货莱服表逐一吻合，故九个中队状态 id 为 def 权威：health=85 / planesHealth=95 / damage=87 / throttle=66 / consumableUsed=69 / stopWorking=71 / planeDeath=146 / notify=65 / deactivate=63。已钉入 `method_tables_lesta.rs`（replay-unvalidated：本地无 CV 的 .korablireplay，第一盘到手后跑 `dump_squadron_state_methods` 复核即可）。
- **消耗品枚举分叉（重要）**：莱服 `battle.xml` 独有 `CONSUMABLE_TYPES` 枚举（56 项，WG 客户端没有）——21=HEAL_FORSAGE、22=CALL_FIGHTERS、23=REGENERATE_HEALTH（飞行重整）、42=PLANE_SMOKE_GENERATOR、50=SHIELD（百慕大盾）、33=GO_DEEP、41=SUBMARINE_LOCATOR。其中 **42 与 WG 实证重合**（拉烟），但 20/21/22 与 WG 线上 id **错位**（WG 实证：20=加力 5s、21=战术战斗机 60s、22=灭火 5s）→ 两分支 id 空间已分叉；**莱服录像的消耗品 chips 必须查莱服表**，前端在拿到莱服 CV 录像验证 wire 字节用哪个空间前保持 WG 映射不动。
- **空投补给确认（官方口径）**：用户提供的官方信息确认 PCY084/085/086（tacticalBuffHealConsumableReload / tacticalFireExtinguishing / tacticalBuffHeal）是**直接空投给指定友舰的补给**（灭火/维修小组）——E27b 中「版本漂移」的措辞据此修正：约克城 TB 的 5s 窗就是空投灭火的作业时长，「灭火类」标签成立。
- **多重巡航高度侦察**：莱服 25.8 封测的「支援中队」（巡逻侦察机/烟雾布设机/截击机——战术模式召唤、不直接操控，[官方日志译文](https://ski.ink/blog/18-wow-carrier-support-25-8/)）在本地 Korabli defs 中**无高度机制脚手架**（Avatar.def/全 defs 无 altitude/flightLevel 关键词；25.8 期 build 早于该机制）。多重巡航高度（高空=防空免疫+无视野 / 低空=攻击姿态+可被攻击+视野+时限）尚在封闭测试、未进任何本地客户端。**监控计划**：与潜艇深度同构的假设（新 `SQUADRON_ALTITUDE_STATE` 枚举 + receive_* 方法或属性流；参照 DEPTH_STATE 的 -1/0/1/2/3 模式）——任一分支的公开/超测录像到手后：① 重新提取 defs 跑 def-diff 找新方法/属性；② `dump_squadron_state_methods` 探针换 id 扫描。基础设施已就绪。
- **语料**：King of the Sea XIX 全量公开录像爬取入册（用户授权；四赛区
  618 场 / 1047 局 / 2054 个 `.wowsreplay`，HEAD 实测 3.4GB、magic 全验，
  归档 `replay-archive/kots-xix/<region>/`）——语料 163 → **2217 局**；
  导出 fire 6,087,888 行 / move 2,828,778 行（release 测试可执行文件四分片
  真并行，绕开 cargo 构建锁串行化）。
- **MoE 软路由（用户设计）**：前置路由器读**现有输入契约**（global 特征块
  即武备属性代理——主炮射程/装填/消耗品/视野/烟雾/雷达水听 + 池化实体统计），
  门控 softmax 加权混合各专家的 head logits——混合定位舰（如赫尔）部分激活
  多个专家而非硬选一个；共享实体编码器 + 每专家独立交互层/头 +
  Switch 式负载均衡辅助损失（`--moe K`）。**输入/输出契约不变**，端上
  `ort` 前向与 ONNX/int8 链路零改动。武备射程/穿深/隐蔽逐项属性向量留待
  导出器 v3（E20+）。
- **结果（node3 / RTX 5880 Ada，LOO held-out）**：fire MoE（4 专家 645K 参数）
  headB **AUPRC 0.3155 / AUC 0.7195 / logloss 0.3311 / ECE 0.0374**，headA
  误报 69/2490（2.8%），门控 `[0.354, 0.092, 0.077, 0.478]` 无塌缩，int8
  AUPRC −0.4%；move MoE（661K 参数）**top-1 0.586 / top-3 0.763**，全面击败
  多数类（0.503）与速度门控惯性（0.467）。E13 outcome lift：决策级
  hp-lost decile ρ **+0.915**（最强离线证据）。
- **E17 预注册复验（如实报告）**：新模型对 2102 局 / 26,433 舰评分，
  join 83.9%（22,177 舰）——**wholeGame vs damage ρ = −0.059**（p≈2e-18，
  功效充足）；同场内排名合并 ρ=−0.197；驱动项 wholeFire vs damage
  **ρ≈−0.30**（各舰种一致反向）。结论：模型认同度均值聚合与实战伤害**反向**
  ——高伤害玩家出手更多、含模型低概率的激进炮，均值聚合把「敢打」算成减分；
  评分语义需按 E13 outcome-lift 语义重构（E20），而非继续堆语料。UI 诚实
  标注继续保留。
- **工程修复（随训练发现）**：两遍流式加载（dict 列表峰值 18GB 会压死
  node3，实测触发过一次 VM 重置）；ORT 校验限 5 万行前缀（原全量逐行=数小时）；
  走位扇区标签 22.5° 边界浮点容差（0.45° 噪声带内 ±1 扇区放行并计数，
  285 万行仅 1 例；真漂移仍硬失败）；`--test-threads 1` 与 `--exact` 过滤
  陷阱。产物：node3 `/mnt/work/wowsp-kots/e19/{fire_moe,move_moe}/`。


### E27d · 分支枚举归一化层（消耗品 wire 字节 → 语义词汇表）✅

- **动机**：E27c 证实 WG（`.wowsreplay`）与莱服（`.korablireplay`）的中队消耗品 wire 字节已经**分叉**（WG 实证 20=加力 / 21=战术战斗机 / 22=灭火 / 42=拉烟；莱服 battle.xml 枚举 21=HEAL_FORSAGE / 22=CALL_FIGHTERS / 23=REGENERATE_HEALTH / 42=PLANE_SMOKE_GENERATOR——仅 42 重合）。若让分支各自的裸 id 流到下游，前端每加一处消费点都要重写一遍分支判断；归一化必须在**解码边界**一次完成。
- **归一化层**（`tauri_shared::stream`）：语义枚举 `SquadronConsumableType`（HealForsage / PlaneTacticalFighters / FireExtinguishing / PlaneSmokeGenerator / RegenerateHealth / `Unknown(u8)`）+ 两张纯查表 `squadron_consumable_type_wg`（E27b 五盘 14.5 CV 录像 workTime 指纹）与 `squadron_consumable_type_lesta`（E27c 本地 Korabli battle.xml 权威、replay-unvalidated）。**莱服 22→PlaneTacticalFighters 为 PROVISIONAL**（莱服名为 CALL_FIGHTERS，按枚举名与槽位推定与 WG 21 同为槽 1 战术战斗机族，无录像证据，首盘莱服 CV 录像到手需复核）。`Unknown(u8)` 原样携带裸字节——永不丢信息，未来 id 以「诚实的未知」呈现而非猜测。
- **落地**：`SquadronConsumableEvent` 同时携带两份——`consumableType` 保持裸 wire 字节（前端兼容、无损），新增 `semantic`（serde camelCase，永远序列化；旧载荷反序列化回退 `Unknown(0)`）。`decode_squadron_consumable` 接分支旗标（`frames.rs` 从 `LayoutProfile::lesta` 穿入，与 wardType/ballistics 等既有版本门控解码参数同款）选表；分派逻辑本身不变。分支画像本就拥有 method-id 选表（`decode_replay` 按容器族选 WG/莱服 method 表）——本层是同一职责向**枚举语义**的延伸。
- **前端**：`replay.ts` 镜像联合类型（命名变体为字符串、未知为 `{ unknown: <raw> }`）；`planeFollow.ts` 的 `activeConsumablesAt` 直接返回语义类型数组（窗口仍按裸字节键控、按裸字节排序），`CONSUMABLE_LABEL` 改按语义键控；`HoloPlaneFollowCard` chips 按语义渲染，未知以 consOther + 裸 id 后缀（如「消耗品 57」）诚实展示。locale 键 `replay.planeCard.consForsage / consFighters / consExtinguisher / consSmoke / consRegen / consOther`。
- **测试**：两表逐 id 单测（含 Unknown 直通）；WG 侧 fixture 断言 semantic；**莱服表 fixture 用 WG 禁用字节证明分叉被抹平**——字节 23 莱服译 RegenerateHealth、WG 侧诚实地 `Unknown(23)`（解码级 + 走 walk 级穿 `profile.lesta` 双重覆盖）；`tauri_shared` 侧钉 IPC 形状（键集 + `{"unknown": 57}`）。
- **车辆消耗品流（E11）暂不迁移**：`onConsumableUsed`（`ConsumableUseEvent`）的 consumable_id 是 GameParams 消耗品枚举，id→名称本属 GameParams 联表侧，且尚未有莱服分叉证据——**保持裸字节**，待其前端上线时并入同一归一化层。
- **后续分叉在此汇合**：E27c 侦察的多重巡航高度（SQUADRON_ALTITUDE_STATE 类枚举）等未来分支差异，落点即此层——解码边界新增一对查表，下游继续单词汇表。

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
  同模型下时间轴一致（测试断言抽查前 3 船 + 船数/首样本 t，全程一致为
  运行观察值）；镜像 shipId 船无箭头无评分（E16 导出口径，UI 注明）。
- 交叉验证（E18 审查）：方位还原数学经逐步推导与船 glyph 交叉验证成立
  （两套 yaw 语义在端到端相消）；抓到并修复 top-2 提取在 argmax=0 时
  次选恒错的真 bug（会画错次选箭头），补 top=0 回归用例；ru-RU 拼写与
  粘滞缓存「需重启」语义补注。
- 门禁：Rust 1246 通过（+2 零回归）、webui build/typecheck/lint 0 警告、
  i18n 8 语言全对齐、vitest 2,088 测试（+7：色坡单调/阵营区分/次选方位/
  scoreSampleAt 边界）。


### E20 · 整局评分聚合重构（探索/确认分割预注册）❌ 体积是唯一稳健正信号

- **wire 扩展**：`ShipScoreSample` 新增 `fired`（当帧是否实际开火）与
  `fireProb`（头 B 原始概率）——`fire = fired ? p : 1−p` 不可逆折叠，E20 的
  机会捕获聚合需要 (p, fired) 对本身；webui TS 镜像同步（纯增量）。
- **预注册**（计算前落盘）：探索集 = apac+own，确认集 = eu+na；候选族
  C1 均值（E17 原聚合）/C2 中位/C3 上四分位均值/C4 recall@p≥0.5/
  C5 价值加权召回 Σp·fired/Σp/C6 每发价值/C7 开火率（体积对照）/
  C8 走位中位；选点规则=探索集最优正 ρ（语义序 C5>C4>C6…），确认集
  只跑一次，验收沿用 ρ≥0.30。
- **结果（E19 MoE 模型对 2217 局重评分，23k+ 已 join 舰）**：探索集
  （8,507 舰）C7 +0.19 唯一过 +0.15，C5 +0.11，C1 −0.27，C3 −0.29；
  **确认集 C7 ρ=+0.222（n=14,250），同场内合并 +0.205——未过 0.30 线，
  如实报告**。模型聚合族没有任何候选击败纯体积。
- **结论**：当前模型输出（对自舰窗口的火/走概率）里，伤害相关信号几乎
  全部经由交战体积（机会数 × 出手意愿）流动；决策质量的边际信号小于
  体积效应。要让「决策质量分」与战绩相关，需要换建模目标而非换聚合：
  下一迭代方向 = 结果条件化（E15 hit/soft 头多训一版）或直接窗口期望
  伤害头（score = 实现 − 期望，xG/xD 风格）。UI 诚实标注保留。

### E21 · xD 整局评分：结果接地的「实现 − 期望」（探索/确认分割预注册）✅ 首次过线

- **wire 扩展**：`ShipScoreSample` 新增 `hpLost`——该舰在
  `(t+2, t+45]s` 窗口内、以其弹着（shotKills ±0.4/0.6s 覆盖包络 ×
  500 单位归因半径）归因的敌方掉血（E13 语义从录像主推广到全部被
  评分舰；decision_score 镜像实现 + 归因单元测试）。这是「实现」侧
  的原始材料；「期望」侧用模型概率十分位校准曲线。
- **预注册**（计算前落盘）：分割与 E20 相同（探索 apac+own / 确认
  eu+na）；校准=探索集全部舰的开火窗口上 p 十分位 → 平均 hpLost
  （不足 20 样本的桶回退全局均值）；候选 X1 xD 和 / X2 超期望转化率
  （每发）/ X3 开火窗口实现伤害 / X4 实现÷期望 / C7、C5 对照；选点
  规则=探索集最优正 ρ（语义序 X1>X2>X4）；确认集只跑一次，验收
  ρ≥0.30。
- **校准曲线（探索集）**：p 十分位平均窗口伤害
  `[7591, 8267, 10208, 9921, 10147, 10097, 9940, 9863, 9049, 9049]`
  —— 低 p 窗口伤害略低但整体平坦（模型概率对伤害的分辨有限，
  伤害主要由「是否交战」而非「模型评分多高」决定——与 E20 结论
  一致）。
- **结果**：探索集（8,763 舰）X3 +0.436 > X4 +0.338 > X2 +0.341 >
  X1 +0.226 > C7 +0.209 > C5 −0.083；**确认集 X3 ρ=+0.477
  （n=14,716），同场内合并 +0.427——首次通过 ρ≥0.30 验收线**。
- **如实解读**：X3（开火窗口实现伤害）与最终伤害的相关部分是
  同源（窗口伤害本身构成总伤害的大头），循环论证成分需如实承认；
  非循环论证的「转化质量」信号是 X2（每发超出校准期望的伤害）。
- **X2 确认集复验（用户要求的后续，校准仍只用探索集）**：X2
  ρ=+0.376（n=11,928）、同场内 +0.363——**独立过线**；X4
  （实现÷期望）+0.375、X1 +0.248、C7 +0.241。转化质量与体积两个
  分量都与战绩正相关，X3 的主数值地位稳固。
- **端上接入（E22）**：`ShipScoreEntry` 新增 `contribution`（开火
  窗口归因伤害合计）与 `contributionShots`；评分侧栏双列——贡献
  （主数值，按贡献排序，悬浮显示每发均值）+ 认同度（0-100 与火/走
  分量条，独立维度），诚实标注改为「贡献=已验证的实际伤害归因；
  认同度≠战绩」。8 语言同步。

### E23 · 域外泛化验证：留出语料重训 + 打分（E21 的 in-sample 质疑回应）✅

- **协议（预注册）**：只用 own+apac 两分片训练新的 fire/move MoE（各 8 epoch，
  同 E19 超参），**eu+na 两分片全程未见于训练**；校准曲线仍取探索集
  （e21 apac+own，全语料模型概率）——eu/na 的打分概率完全来自留出模型。
- **结果（eu+na 共 1,371 局 / 14,716 舰）**：
  - **X2（超期望转化率，模型依赖分量）域外 ρ=+0.3827**，同场内 +0.3733
    （n=6,204）；对照 in-sample +0.3762——**零退化**，转化质量信号不是
    in-sample 假象。
  - X3 域外 +0.4774 与 in-sample 完全相同：X3 只由弹着归因与开火标记构
    成，两边都不含模型输出（模型无关量，不是泛化指标）。
  - fire 留出模型决策级 outcome lift：hp-lost 十分位 ρ +0.915 → **+0.830**
    （有效但略降）；headA 误报 78/2490（3.1%）。
  - move 留出模型 LOO top-1 **0.5869**，与全语料 0.586 持平——走位模型
    在未见语料上同样不塌。
  - 门控分布 `[0.28, 0.19, 0.11, 0.42]`（与全语料 `[0.35,0.09,0.08,0.48]`
    不同）——路由器随训练分布改变倾向，未见塌缩。
- **结论**：E21 的域外风险基本排除——模型依赖的评分分量跨语料稳定。
  剩余未验证项仍是 **MoE 属性路由假设**（需 v3 导出器携带武备属性向量）
  与**随机战分布**（现仅 163 局自有随机战，竞技语料占绝对多数）。

### E24 · 武备属性前置路由（shipId→属性表）⚠️ 分类升、排序塌 → 双模型分工定案

- **动机（用户设计）**：路由器不读船名、只读武备基本属性（主炮/鱼雷射程、
  雷达水听、隐蔽、烟隐）——混合定位舰按「它能做什么 + 它占了什么位」部分激
  活多个专家。实现上没有等 v3 导出器：**shipId→属性表**（`build_ship_attributes.py`
  从 gameparams 切片构建，表随库跟踪如 `ships_basics.json`）在训练侧展开为
  10 维路由输入（本船 6：隐蔽/烟隐/主炮射程/鱼雷射程/雷达/水听 + 编成 4：
  双方主炮射程与隐蔽均值），`--attr-table` 载入后门控输入 +10 维；**无表 =
  E19 输入契约原样**（不加 attrs 输入）。
- **属性表勘误**：初版表 `torpRange`/`visSmoke` 两列全零——鱼雷距离存在
  `__torpedoAmmo[*].maxDist` 且以 70/3 缩放单位记录（233.33 = 10.0km，全包
  交叉验证），烟隐真身是 `visibilityCoefGKInSmoke`；修正版 1162 船
  （鱼雷 672 / 烟隐 1035 / 雷达 97 / 水听 395 非零），雷达按消耗品名
  `rls|radar`（RLS=WG 内部对 surveillance radar 的俄文缩写）判定。与旧表逐列
  对拍：`mbRange`/`hasHydro` 零差异；`vis` 修正 10 个死值 + 3 个顶级船体
  隐蔽（取各船体配置最优）。
- **结果（全语料 6.09M 行，同 E19 超参 hidden 256 / 8 epoch / moe 4）**：
  - 训练损失 0.6416→**0.5440**（E19 同设置 0.5630）；
  - 门控份额 `[0.165, 0.268, 0.297, 0.271]`（E19 `[0.354, 0.092, 0.077, 0.478]`）
    ——属性路由下专家均衡分工，不再一专家独大；
  - headB **AUPRC 0.3451**（E19 0.3155，+9.4%）、AUC 0.7028、ECE 0.0324
    （E19 0.0374，校准更好）；headA 误报 68/2490；
  - 但 outcome lift hp-lost 十分位 ρ **+0.915 → +0.455**（大幅退化）。
- **定版重训（修正版属性表，全语料 6.09M 行，同超参）**——上面那组数字是在
  两张死列（`torpRange`/`visSmoke` 全零）上跑出的；换修正表后：
  - 损失 0.5898→**0.5511**（起点比 E19 低 ~0.13：门控开局即有真实信号）；
  - 门控份额 `[0.248, 0.082, 0.163, 0.507]`——不再是死表时的均匀分摊，
    回到有主导专家的分化格局；
  - headB **AUPRC 0.3560 / AUC 0.7151 / logloss 0.3215 / ECE 0.0266**
    （旧表 0.3451 / 0.7028 / 0.3248 / 0.0324；E19 0.3155 / — / — / 0.0374）
    ——分类与校准仍是历代最好；headA 误报降到 **40/2490**；
  - outcome lift hp-lost 十分位 ρ **+0.600**（旧表 +0.455，E19 +0.915）——
    修表把伤害排序拉回来一大截，但仍明显低于 E19。
- **结论：双模型分工定案（用户批准）**——武备属性让「该不该开火」的分类
  与校准更好、却破坏模型分数与「实现伤害」的排序对齐（评分需要后者）。
  **评分链用 E19**（伤害排序对齐优先，X2/X3 语义已验证），**建议链用 E24**
  （分类/校准优先）；两者输入契约只差一个 `attrs` 输入。建议链槽位已定版：
  决策包可选 `advice_fire_model.onnx`（env `WOWSP_DEBUG_ADVICE_FIRE_MODEL`
  覆盖 / dev 检出取 `out/fire_model/e24_attrs/fp32.onnx`），战术板建议命令
  优先走它、缺槽回退评分火模型；交付只走 fp32（int8 的 headA 偏移见下）。端上推理两侧已支持该分离：`DecisionModel`/`ScoreModel`
  自动识别带 `attrs` 输入的导出并拒绝契约错配（缺输入/多输入/宽度不符均
  硬报错），路由向量从内嵌属性表逐位复刻训练特征化
  （`ship_attrs.rs`，含闭式 ONNX fixture 测试）。
- **int8 警示**：本模型（645,964 参数）动态量化后 headA 概率最大偏移
  **0.911**、AUPRC-A 0.9959→0.9772（headB 侧仅 0.117 / 0.2245→0.2195）。
  「能否开火」的硬门一旦被量化打穿就是误报连片——**建议链交付只用 fp32**，
  int8 仅作体积兜底并需重新评估阈值。
- **loss 闸门勘误**：原 `losses[-1] < 0.85 * losses[0]` 是针对 E19 曲线标定的
  相对下降检查；属性路由起点低 0.13，健康运行（0.934×）会被误判失败，且
  失败发生在产物全部落盘之后。改为对比**基率 BCE 基线**（两头部各自预测多数
  类的损失之和，本次 1.07 → 0.5511 即 0.52×），再加一条单调下降检查。
- **工程教训**：首次 E24 全量训练在 ONNX 导出处崩溃——traced graph 未携带
  attrs 输入（1×298 vs 308×64），2 小时训练无落盘。修复：导出与全部 ORT
  校验调用统一携带 attrs 输入，且 `checkpoint.pt` **先于**导出落盘。

### E25 · 静态个人决策报告（任意视角 + 覆盖率声明）🔬 数据层

- **动机（用户需求）**：出一份可分享的长图，对某个人的若干次重大决策做拆分
  分析；软件内逐步查看或导出图片；可选任何人的视角——前提是该人完整参与
  对局，否则明确声明中间哪些时段「隐身解析不到」。
- **数据层（本 PR）**：`decision_static_report(replay, entity)` 复用
  debug 评分缓存（一次打分服务 3D 板与报告），产出：
  - **全 roster 覆盖率档案**：存活区间 × 采样缺口（>12s 判缺口；空序列
    = 被导出器剔除，完整度 0 显式可见），敌人只在被侦测窗口有数据；
  - **关键时刻提取**（≤8 个、45s 间隔）：权重分带——可验证伤害
    （fired+窗口掉血≥15k，≥2.0）> 概率分歧（错过 0.65+ 窗口 / 强行
    0.25− 开火，≥1.5）> 瞬时分极端（<1.25）——伤害时刻不会被低分窗口
    挤掉（首版正好犯这个错，17k 伤害输给 1.2 权重的弱窗口）；
  - 每时刻：局势快照（HP/航速/最近被观测敌舰距离方位在射程内外）、
    实际动作（开火与否/实际走向扇区）、模型判定（fireProb/建议走向
    重算/瞬时分/置信度）、结果（窗口归因伤害、20s 后自身 HP）。
- **实测（本地归档）**：Monarch 录制者（97 样本/完整度 0.95，7 发贡献
  炮 → 2 个 23.5k/27.6k 伤害时刻）；敌方 Shapt 视角（44 样本/完整度
  **0.43**、228s 隐身缺口，仍提取出 35.9k/37.5k 两个伤害时刻——伤害
  归因走录制者侧弹着流，与被观测者的开火窗口可交）。
- 纯函数（缺口/分类/挑选）带单测；真实录像 E2E env-gated
  （`WOWSP_STATIC_REPORT_REPLAY`，可选 `…_ENTITY` 换视角），JSON 落
  OS 临时目录。UI 长图渲染随后。

> 另有训练侧三主题网络调研（数据规模化获取 / 无环境评估协议 / 可导出 ONNX 的
> 实体编码结构），结论见文末「研究纪要」。

### E26 · 鱼雷决策数据集与试点（P1 Python 侧）⚠️ 头 A 可学；头 B 预注册 FAIL（4 s 节奏数据集）

- **动机**：鱼雷是 DD/CL/BB/SS 的主武器之一（CV 的空投鱼雷是当前唯一已建模的 CV
  攻击），`receiveTorpedoes`→`TorpedoLaunch` 早已解码，但此前没有任何「发不发
  鱼雷」的决策监督。E26 补上导出 + 可学性试点（Rust 导出 = task-7，Python 训练 =
  本脚本 `train_torpedo_model.py`）。
- **数据定义（`TorpedoDatasetRow`，`fire_dataset.rs` E26 段）**：`DecisionRowCore`
  v2（entity 15 / global 27）+ `labelACanLaunch` / `labelBLaunched` /
  `ownTorpReloadFrac` / `ownTorpRangeM`。一次玩家点击按 owner+≤2 s 聚合
  （`salvo_id` 是 pack 级不是点击级，一次点击会拆成 0.3–1.0 s 间隔的多个 salvo）；
  decider = 有鱼雷能力的 team-known 船（DD/CL/CA/BB/SS），**排除 CV**（空投
  owner=CV 但不是舰投决策）；labelA = 装填完成（GameParams `torpReload` 优先，
  否则 click 间隔 p10，clamp [10,300] s）且射程内（属性表 `torpRange`）有
  observed-now 敌舰；labelB = `(t, t+2 s]` 内有点击；core 的 `ownReloadFrac` /
  `ownRangeM` 在本族承载**鱼雷**装填/射程语义。
- **预注册（先落盘 `out/torpedo_model/e26-preregistration.md`，脚本 sha256 冻结）**：
  5 折 GroupKFold by replayId（<5 局如实降级）；hidden 192 / batch 4096 / 12 epochs /
  Adam 1e-3 / label smoothing 0.05 / seed 0 / CPU / max-rows 250k；
  **PRIMARY 验收线 = headB OOF AUPRC ≥ 2×base 且 top-decile launch-rate lift ≥ 1.5×**；
  DD/CL/BB/SS 分类别报告（n<30 或正例<10 只描述）；头部 A/B 基线 = 常数基率
  （no-skill）+「labelA 行全 1」规则；不达标**不调参重试**。
- **数据规模（own shard 全量，4 s 决策节奏，修复前导出）**：163 局 →
  163 exported / 0 failed → **85,681 行 / 161 局有行（2 局 0 行）/ 1,067 deciders**；
  canLaunch **47,511（55.5%）**；launched **465（can 行内 0.98%）**；`featureVersion`
  全 2、标签契约 0 违例；JSONL 0.32 GB。

  | 类别 | rows | canLaunch | launched | 正类率 | 头 A OOF AUPRC | 头 B OOF AUPRC |
  |---|---|---|---|---|---|---|
  | DD | 25,070 | 10,324 | 214 | 2.07% | 0.958 | 0.0186 |
  | CL/CA | 40,030 | 25,070 | 156 | 0.62% | 0.990 | 0.0098 |
  | BB | 15,761 | 10,572 | 47 | 0.44% | 0.994 | 0.00446 |
  | SS | 4,820 | 1,545 | 48 | 3.11% | 0.944 | 0.0293 |

- **结果（OOF pooled，4 s 数据集）**：头 A **AUPRC 0.9853 / AUC 0.9852 / ECE 0.0538**
  （base 0.5545）——「能不能发射」基本由装填+射程规则决定，管线/标签口径自洽；
  头 B **AUPRC 0.01094（=1.12× base 0.00979）/ AUC 0.5464 / logloss 0.0678
  （差于常数基线 0.0550）/ Brier 0.01033 / ECE 0.0250 / top-decile 实际发射率
  0.989%（lift 1.011×）**；每折 AUPRC 0.0107–0.0150、top-lift 1.129±0.219
  （fold 0–2 1.22–1.43，fold 3–4 0.82–0.94）。基线：no-skill AUPRC 0.00939 /
  logloss 0.0550；labelA 规则 AUPRC 同、logloss 15.96。
- **判定（预注册，如实）**：headB AUPRC 1.12× < 2×、top-lift 1.01× < 1.5× →
  **FAIL（两条都不过）**。这是 4 s 节奏数据集上的诚实 negative result，不隐藏、
  不调参重试。
- **数据协议 bug（E26 的 FAIL 不能当模型定论）**：本轮导出的决策节奏是 4 s
  （`MOVE_DECISION_INTERVAL_S`），而 labelB 窗口是 2 s——落在 `(t+2, t+4)` 的
  真实 launch 永远无法被标成正例、对应行还被标成 hold，约一半正例被吞、负例被
  污染。task-9 已把节奏改回 2 s（与 label 窗口对齐），E26b 用**同一脚本/超参**
  在同一批 replay 上探索性复跑；**E26b 不改变本节预注册验收结论，只给方向**。
- **局限**：own 单切片（含 Halloween/event 局，未按 gameMode 过滤）、CPU 试点、
  无 class one-hot/attrs、CV 空投只存在流里未建模（decider 侧排除）、SS 正例 48
  （描述性）、headB 仅 465 正例使 OOF 估计区间很宽、2 局 0 行。已知近似：
  多配置船取各鱼雷段 `shotDelay` 最小值、无属性表船用 10 km 兜底、多管按最后
  一次 click 计时、盲射不 censor——这些都会给 labelA/B 带噪声，E26b 同样适用。
- **产物**：`out/torpedo_model/{dataset_own.jsonl, dataset_own_2s.jsonl,
  pilot_own_metrics.json, pilot_own_2s_metrics.json, e26-preregistration.md}`；脚本
  `scripts/experiments/train_torpedo_model.py`
  （`--selftest` PASS 且不依赖 torch）；Rust 导出与测试见 task-7/task-9。
- 下一步（E26b 仍弱时）：更长/点击对齐的标签窗口、鱼雷几何与管位特征（发射管
  相对目标舷角、距离分桶、预估命中时间、DoT/进水）、KoTS 全量 + GPU、SS 专项头；
  共享 v2 特征下「点击时机」可能天然弱（与 E15「命中是随机结果」同型）。

### E26b · 探索性复跑（2 s 决策节奏，**不改变 E26 预注册结论**）⚠️ 方向改善但仍未过线

- **背景**：E26 的 4 s 决策网格与 2 s labelB 窗口错配——落在 `(t+2, t+4)` 的真实
  click 永远无法成为正例、对应行还被标成 hold（约一半正例被吞、负例被污染）。
  task-9 把决策节奏改回 2 s（与 window 对齐；单局 899→1794 rows、launched 5→8）。
  E26b 用**同一导出器（修后）/同一脚本/同一超参**在同一批 replay 上复跑，定位
  **exploratory**：不改变 E26 的预注册 FAIL 结论，也不以本次结果宣称 PASS。
- **数据规模（2 s）**：own 163 局 → 163 exported / 0 failed → **170,863 行 /
  161 局有行 / 1,067 deciders**（≈2× E26 的 85,681 行，符合 cadence 减半）；
  canLaunch **94,220（55.1%）**；launched **957（can 行内 1.02%）**；标签契约
  0 违例；JSONL 639 MB。版本：14.5 121,030 / 15.9 21,194 / 15.8 19,872 / 更老
  8,767；gameMode：pvp 114,230 / brawl 26,834 / event 15,003 / ranked 10,466 /
  pve 4,330（本切片未过滤）。

  | 类别 | rows | canLaunch | launched | 正类率 | 头 A AUPRC | 头 B AUPRC | 头 B/base |
  |---|---|---|---|---|---|---|---|
  | DD | 49,965 | 20,298 | 420 | 2.07% | 0.971 | 0.0225 | 1.09× |
  | CL/CA | 79,847 | 49,857 | 323 | 0.65% | 0.992 | 0.0090 | 1.39× |
  | BB | 31,439 | 21,062 | 113 | 0.54% | 0.996 | 0.0104 | 1.94× |
  | SS | 9,612 | 3,003 | 101 | 3.36% | 0.951 | 0.0385 | 1.14× |

- **结果（OOF pooled，2 s）**：头 A AUPRC **0.9889** / AUC 0.9889 / ECE 0.0441；
  头 B **AUPRC 0.01349（=1.33× base 0.01016；E26 4 s 为 1.12×）/ AUC 0.5873
  （4 s：0.5464）/ logloss 0.0687（仍差于常数基线 0.0567）/ ECE 0.0245 /
  top-decile launch-rate lift 1.484（4 s：1.011）**；每折 lift 1.18 / 1.71 / 1.82
  / 1.55 / 1.33（均值≈1.52、std≈0.24），每折 AUPRC 0.0131–0.0166。基线：
  no-skill AUPRC 0.00990 / logloss 0.0567；labelA 规则 AUPRC 同 / logloss 15.95。
- **判定（exploratory）**：两条预注册线仍不过（AUPRC 1.33× < 2×、top-lift 1.484
  < 1.5×）→ **FAIL（方向改善，但不足以宣称可学）**。与 4 s 相比 AUC +0.041、
  top-lift +0.47、AUPRC 倍数 +0.21——cadence bug 确实压低了信号，但剩余信号仍弱。
- **诚实解读**：① 头 A 0.989 很稳 → 「装填+射程」规则可学、导出/特征/切分无泄漏；
  ② 头 B AUC 0.587、top-lift 1.48 → 有**微弱**排序信号（高于随机），但 AUPRC 远
  低于预注册线、logloss 差于常数 → 共享 v2 特征对「点击时机」的可分性不足；
  ③ 957 正例的 fold 间 lift 波动 ±0.23，个别 fold 的 1.82 不能当稳定性证据。
- **下一步（不以调参过线为前提）**：更长/点击对齐的标签（click-level 事件建模，
  而不是仅窗口二分类）；鱼雷几何/管位特征（发射管相对目标舷角、距离分桶、预估
  命中时间、目标 DoT/进水、被侦测状态）；`pos_weight`/focal 只作为不平衡研究项；
  KoTS 全量（本切片未跑）+ GPU；SS 专项头（101 正例，仅描述）。
- **局限**：own 单切片（含 event/pve/brawl；pve 4,330 行无真实对抗标签）、CPU、
  无 class one-hot/attrs、CV 空投未建模、未跑 KoTS、161 局 5 折。

### E26c · 全量语料 scale 测试（node3 GPU，**exploratory scale-only**）⚠️ MIXED：排序显著变好，主验收差 0.09

- **问题**：E26/E26b 的 headB 弱是「数据少」还是「特征不行」？在 node3
  （yuzu-linux-node-3，RTX 5880 Ada，**与 llama-server 共享 GPU**——只用剩余显存、
  未 kill 任何进程）用**全量 2 s 语料**、**同一脚本/特征/标签/超参**复跑
  （scale-only：唯一变化是数据量与硬件）。预注册：
  `out/torpedo_model/e26c-scale-preregistration.md`（含 2 次冻结后 sha 修正的
  透明披露：CUDA 路径 label 保留 bug、--data 多路径 CLI；协议/验收线未改）。
- **数据（lead 导出 4/4，0 failed）**：own 170,863 + apac 1,021,498 +
  eu 1,432,164 + na 486,859 = **3,111,384 行 / 2,215 个有行 replay**
  （vs E26b own 170,863 行/161 局，约 18×）；canLaunch **1,052,311（33.8%）**、
  launched **17,055（can 行内 1.62%）**；labelB null 2,059,073；region 分布
  eu 46% / apac 33% / na 16% / own 5.5%。
- **加载/协议**：`--max-rows 0` 两遍式（pass-1 仅数行 11.6 s，pass-2 精确预分配；
  无 list/np.append），entity/mask **float16**、global float32（数组 2.79 GB），
  整库一次性上 GPU、host 副本随即释放；5 折 GroupKFold by replayId（2,215 局，
  fold 622k 行）；hidden 192 / batch 4096 / 12 epochs / Adam 1e-3 / smoothing 0.05 /
  seed 0；torch 2.5.1+cu121 / CUDA；**训练 236.9 s**（5 折各 46.5–49.1 s），
  未 OOM、未降级、llama 不受影响。
- **指标（pooled OOF，3.11M 行）**：headA **AUPRC 0.9983 / AUC 0.9993 /
  ECE 0.0369**（base 0.3382）；headB **AUPRC 0.030925（= 1.91× base 0.016207）/
  AUC 0.6752 / logloss 0.0909（仍差于常数基线 0.0829）/ Brier 0.01644
  （常数 0.01595）/ ECE 0.0245 / top-decile 实际发射率 3.78%（= 2.33× base）**；
  每折 lift 2.27–2.46（2.357±0.071）、AUPRC 0.0302–0.0327、AUC 0.677–0.684。
  基线：no-skill AUPRC 0.01684 / logloss 0.08289；labelA 规则 logloss 15.86。
- **判定（预注册）**：AUPRC 1.91× < 2×（**未过**）、top-decile lift 2.33× ≥ 1.5×
  （过）→ **MIXED**（只过一条：方向记录，不宣称可学；fold 间 std 仅 0.001，
  说明这是稳定差距而非噪声）。
- **与 E26/E26b 对比（同指标）**：headB AUPRC 倍数 **1.12× → 1.33× → 1.91×**；
  AUC **0.546 → 0.587 → 0.675**（+0.088 vs E26b）；top-lift **1.01× → 1.48× →
  2.33×**；ECE 稳定在 0.025；logloss 仍略差于常数（排序有用，但输出概率校准
  还不能直接当概率用）。**18× 数据带来明显但「刚好卡线」的排序提升**——结论：
  不是纯数据量问题，但 scale 显著有效；AUPRC 主验收线未过 → 瓶颈开始转向
  特征/标签（E26d）。
- **按类别**（headB AUPRC / 该类 base）：

  | 类别 | rows | canLaunch | launched | 正类率 | 头A AUPRC | 头B AUPRC | 头B/base |
  |---|---|---|---|---|---|---|---|
  | DD | 1,831,164 | 466,730 | 10,949 | 2.35% | 0.9971 | 0.0356 | 1.52× |
  | CL/CA | 1,040,934 | 465,559 | 5,009 | 1.08% | 0.9992 | 0.0236 | 2.20× |
  | BB | 229,674 | 117,019 | 996 | 0.85% | 0.9994 | 0.0195 | 2.29× |
  | SS | 9,612 | 3,003 | 101 | 3.36% | 0.9749 | 0.0469 | 1.39× |

  → 信号不均：BB/CL 已 >2×，**DD（1.52×）与 SS（1.39×）最低**；SS 行数仍只有
  9,612（own 切片），不足以单独下结论。
- **按区域**（headB AUPRC / base）：apac 1,021,498 行 **0.0333**（1.97×）；
  eu 1,432,164 **0.0305**（1.81×）；na 486,859 **0.0305**（1.86×）；
  own 170,863 **0.0258**（2.54×）→ 区域一致、无单区域塌陷；own 倍数最高但基数最小。
- **局限**：仍无类别 one-hot/attrs/鱼雷几何特征；labelB 是 2 s 窗口的 click
  二值化（非 click-level 序列）；全量语料含 event/pve 行未过滤；own 只占 5.5%，
  CV 空投未建模；GPU 与 llama 共享但仅用剩余显存；主验收 MIXED → 不宣称可学。
- **下一步 E26d（特征/标签，不再堆数据）**：鱼雷几何/管位（发射管相对目标舷角、
  距离分桶、预估命中时间、目标 DoT/进水、被侦测状态）、类别与武器 kind one-hot、
  click-level 序列标签/更长窗口；`pos_weight`/focal 作为不平衡研究项（不是
  「调参过线」）；可选 KoTS-only vs own-only 分训做域对照、SS 专项头。
- **产物**：本机 `out/torpedo_model/e26c_scale_metrics.json` + `e26c_scale.log`
  （node3 run/ 同源）；数据/脚本/结果留在 node3
  `/mnt/work/wowsp-kots/e26c/{data,code,run}`。

### E26d · 鱼雷几何/类别特征迭代（torp2，node3 全量）✅ PASS：headB 2.29×base、top-lift 2.66×（预注册主分析）

- **假设（预注册 `out/torpedo_model/e26d-preregistration.md`，先落盘后跑）**：在
  与 E26c **完全相同**的数据（3,111,384 行 / 2,215 局）、2 s 标签、5 折
  GroupKFold（seed 0）、超参与硬件下，把**由现有行派生**的 11 维 torp2 特征拼进
  global 块（27→38），使 headB pooled OOF 达到 E26/E26c 同一验收线：
  **AUPRC ≥ 2×base 且 top-decile lift ≥ 1.5×**。主分析 = torp2（无 reweight）；
  验收线未改、未调参、未根据结果改协议。预注册含 1 次冻结后 CUDA hotfix sha 的
  透明披露（`data["global"]` 被释放后取维度改为 `glob.shape[1]`；协议/超参/验收线未改）。
- **11 维 torp2 特征（全部由 row 现算，不重导出）**：①–⑤ 类别 one-hot
  DD / CL+CA / BB / SS / unknown；⑥ observed 敌舰数/12；⑦ 射程内 observed 敌舰数/8
  （`distM ≤ ownRangeM`）；⑧ 最近射程内敌舰距离占比 `1 − min(distM/ownRangeM)`；
  ⑨ 射程内 `|bearingRelRad| ≤ 45°` 比例；⑩ ≤20° 比例；⑪ 装填就绪二值
  （`ownReloadFrac ≥ 0.999`）。`--feature-set core`（默认）与 E26c 逐位一致。
- **数据/切分/算力**：同 E26c——own 170,863 + apac 1,021,498 + eu 1,432,164 +
  na 486,859 = 3,111,384 行/2,215 局；canLaunch 1,052,311（33.8%）、launched
  17,055（1.62%）；两遍式加载 + float16（数组 2.92 GB），整库上 GPU；node3
  RTX 5880 Ada（与 llama 共享、未 kill），torch 2.5.1+cu121；hidden 192 /
  batch 4096 / 12 epochs / lr 1e-3 / smoothing 0.05；**训练 236.0 s**，未 OOM。
- **主结果（pooled OOF）**：headB **AUPRC 0.037051（= 2.286× base 0.016207）/
  AUC 0.7084 / logloss 0.09004（仍略差于常数 0.08289）/ Brier 0.01640
  （常数 0.01594）/ ECE 0.0246 / top-decile 实际发射率 4.31%（= lift 2.662×）**；
  每折 AUPRC 0.0366–0.0385（0.03759±0.00062）、lift 2.556–2.770（2.698±0.075）、
  AUC 0.704–0.717。headA **AUPRC 0.99989 / AUC 0.99998 / ECE 0.0259 / logloss
  0.0291**（类别 one-hot 让"能否发射"的规则几乎完全确定）。基线：no-skill
  AUPRC 0.01684 / logloss 0.08289；labelA 规则 logloss 15.86。
- **判定**：AUPRC 2.29× ≥ 2× 且 top-decile lift 2.66× ≥ 1.5× → **PASS**（预注册
  两条都过；这是 E26 系列第一次过主验收线，且未调参过线）。
- **与 E26c（core）对比**：headB AUPRC 0.030925 → **0.037051**（1.91× → **2.29×**，
  +19.8%）；AUC 0.6752 → **0.7084**；top-lift 2.331 → **2.662**；headA
  0.99826 → **0.99989**。**core 复跑 sanity 与 E26c 逐位一致**（5 折 AUPRC
  0.0309608/0.0302013/0.0306312/0.0326273/0.0327289、总 AUPRC 0.03092482702170834、
  lift 2.330674724436389 完全相同）——证实 `--feature-set core` 与 E26c 兼容
  （float16 + GPU 下仍确定性一致），torp2 的全部差异来自新特征。
- **按类别（headB AUPRC / 该类 base；括号为 E26c core 值）**：

  | 类别 | rows | canLaunch | launched | 正类率 | headB AUPRC（core → torp2） | torp2/base |
  |---|---|---|---|---|---|---|
  | DD | 1,831,164 | 466,730 | 10,949 | 2.35% | 0.0356 → **0.04187** | 1.78× |
  | CL/CA | 1,040,934 | 465,559 | 5,009 | 1.08% | 0.02363 → **0.02618** | 2.43× |
  | BB | 229,674 | 117,019 | 996 | 0.85% | 0.01948 → **0.02236** | 2.63× |
  | SS | 9,612 | 3,003 | 101 | 3.36% | 0.04690 → **0.05067** | 1.51× |

- **按区域（headB AUPRC；括号为 core）**：apac 1,021,498 行 0.03330 → **0.03927**
  （2.32×）；eu 1,432,164 0.03050 → **0.03652**（2.16×）；na 486,859 0.03052 →
  **0.03685**（2.25×）；own 170,863 0.02578 → **0.03209**（3.16×）——四个区域全部
  提升，无单区域塌陷。
- **secondary ablation（未跑，如实记录）**：`--pos-weight` / `--focal-gamma` 两个
  开关已实现（只作用于 head B，默认关闭、与 E26c 逐位一致），但因时间与 lead 指示
  **本轮未运行**；主判定只用预注册的 torp2 无 reweight 结果。
- **局限/解读**：排序（AUPRC/AUC/top-lift）第一次过线，但 **logloss/Brier 仍略差于
  常数基线**——输出概率的校准还不能直接当概率用（只适合排序/分层）；SS 仅 9,612 行
  101 正例（结果描述性）；语料仍含 event/pve 未过滤；torp2 是粗粒度几何（槽位
  bearing/距离代理），不是 click-level 序列、无真实管位/DoT/命中概率；GPU 与 llama
  共享但仅用剩余显存。
- **下一步**：click-level 序列标签（发射事件建模，而非窗口二分类）；SS 专项
  （鱼雷管数/制导/深度）；命中结果标签（shotKills join）与 DoT/进水；概率校准
  （temperature/Platt 或 focal，目标 logloss < 常数基线）；KoTS-only vs own-only
  域对照；端上部署（ONNX 契约）留待特征定版后。
- **产物**：本机 `out/torpedo_model/{e26d_torp2_metrics.json, e26d_torp2.log,
  e26d_core_metrics.json, e26d_core.log, e26d-preregistration.md}`；node3
  `/mnt/work/wowsp-kots/e26d/{code,run}`（e26c 数据未动）。

#### 交付导出（T2 模型候选，node3）

- **最终模型训练口径（非 OOF）**：E26d torp2 特征（global 38）在**全部** 3,111,384 行 /
  2,215 局上做一次训练（无 CV；hidden 192 / batch 4096 / 12 epochs / lr 1e-3 /
  smoothing 0.05 / float16 输入 / cuda），loss 0.3406 → 0.2877，训练 57.2 s
  （含加载 300.4 s）；checkpoint 492,962 B（含 state_dict/hidden/feature_version/
  feature_set/feature_names/extra_dim）。**E26d 的 5 折 OOF（headB AUPRC 0.037051 =
  2.286×base、top-lift 2.662×、AUC 0.7084）仍是唯一诚实的泛化估计**；最终模型为
  全量重训，无 held-out，其 in-sample 参考只用于导出 sanity。
- **ONNX 契约（与 app 现有 Fire24 一致）**：opset 17、静态 batch 1、无 attrs；
  inputs = `entity` [1,24,15] fp32、`global_feat` [1,38] fp32、`mask` [1,24] fp32；
  outputs = `logitA` [1,1]、`logitB` [1,1]（onnx.checker 通过）。
  - fp32.onnx **492,411 B**，sha256 `a7e36f3844cd5b4ba8ffed108113a8d5301fabc9953b0cb0e998d07167ae8d9e`
  - int8.onnx（动态量化 QInt8）**136,214 B**，sha256 `61cfe2ea30858a12f44628cc0130d8508ccc4caf6c987ca5bd7a397010d0db75`
- **torch-vs-ORT fp32 一致性**：1,000 行 max|Δlogit| A **2.38e-6** / B **1.91e-6**
  （阈值 1e-4，assert 通过）；本机独立复核：ORT 输出与 parity_vectors 存储值完全一致，
  checkpoint 重建 logits 差 ≤ 9.5e-7。
- **int8 vs fp32（10 万行随机样本，in-sample 参考）**：headB AUPRC 0.034806 →
  **0.034577**、logloss 0.08333 → **0.08306**；headA AUPRC 0.999986 → **0.999985**、
  logloss 0.02726 → **0.02713**；max|Δp| A 0.342（个别行）、B 9.5e-3。→ 排序/校准
  基本无损（头 A 少数行概率偏移，仅排序使用无碍）。
- **产物**：`out/torpedo_model/final/{fp32.onnx, int8.onnx, checkpoint.pt, metrics.json}`；
  `parity_vectors.json`（200 行：entity/global/mask 平铺 + fp32/int8 logits +
  shipId/replayId/t/region/class/标签 + torp2 11 维），node3
  `/mnt/work/wowsp-kots/e26d/final` 同源，训练日志 `out/torpedo_model/e26d_final.log`。
- **性质**：这是研究训练产出的**交付候选**，不是最终 pack 发布——决策包清单/端上注册
  与 Rust/webui 集成由维护者构建；本轮未触碰 app Rust/webui，也未 commit。

### E26e-a · OOF 概率落盘 + 温度校准（**PASS**：headB logloss 0.07947 < 0.08289、Brier 0.01583 < 0.01594）

- **问题（预注册 `out/torpedo_model/e26e-a-preregistration.md`，先落盘后跑）**：E26d
  torp2 的排序过了验收线，但 **headB logloss 0.09004 / Brier 0.01640 仍差于常数基线
  （0.08289 / 0.01594）**——概率语义不可用。只做**后处理**：在 5 折 OOF 预测上拟合
  **单温度 T**（`p' = sigmoid(logit(p)/T)`，最小化 BCE，单调变换），验证能否用温度
  把概率拉到常数基线以下（校准只改概率，不改排序/不改 E26d 验收结论）。
- **OOF 落盘**：训练脚本新增 `--save-oof`，5 折路径把每行 OOF 预测与元数据写入
  npz（`probA/probB` float32、`labelA/labelB`、`fold`、`rowIndex`、`shipId`、`t`、
  class/region 的 int8 编码 + 名称表、replay 的 int32 编码 + 名称表、meta JSON）；
  **3,111,384 行 / 27,187,730 B**（压缩），全部行都被 5 折覆盖（scored 3,111,384）。
  不带 flag 时训练输出与 E26d **逐位一致**（仅 load_seconds 时间字段不同）。
- **复现**：本次 OOF 指标与 E26d 完全相同（headB AUPRC **0.03705068555520497**、
  AUC 0.7084036190742274、logloss 0.09004181589053842、top-decile lift 2.661953046068418、
  headA AUPRC 0.9998866615209074）——训练/切分确定性得到二次确认。
- **温度**：headB **T = 0.7586**（BCE 0.090042 → 0.079466）；headA 参考 **T = 0.4187**
  （BCE 0.029074 → 0.004078；headA 接近确定，锐化方向一致）。网格 log T∈[0.02,50]
  + 三分精化；温度单调，AUPRC/AUC 变化严格为 0。
- **headB before → after（canLaunch pooled OOF，1,052,311 行 / 17,055 正例）**：

  | 指标 | before | after | Δ |
  |---|---|---|---|
  | logloss | 0.090042 | **0.079466** | −0.010575 |
  | Brier | 0.016397 | **0.015826** | −0.000571 |
  | ECE(15 bin) | 0.024620 | **0.000531** | −0.024089 |
  | AUPRC | 0.037051 | 0.037051 | 0 |
  | ROC-AUC | 0.7084 | 0.7084 | 0 |

  常数基线：logloss 0.082886 / Brier 0.015945（p = 1.6207%）。
- **判定（预注册）**：logloss 0.079466 < 0.08289 且 Brier 0.015826 < 0.01594 →
  **PASS**（两条主验收都过；AUPRC/AUC 严格不变；ECE 下降 98%）。
- **按类别（headB，can 行；before → after）**：

  | 类别 | can 行 | launched | logloss | ECE | AUPRC |
  |---|---|---|---|---|---|
  | DD | 466,730 | 10,949 | 0.116819 → **0.108787** | 0.024411 → **0.004114** | 0.041874（不变） |
  | CL/CA | 465,559 | 5,009 | 0.070041 → **0.057585** | 0.024769 → **0.002142** | 0.026180（不变） |
  | BB | 117,019 | 996 | 0.061286 → **0.047875** | 0.024922 → **0.003366** | 0.022359（不变） |
  | SS | 3,003 | 101 | 0.149672 → **0.145736** | 0.022060 → **0.010187** | 0.050674（不变） |

  → 单 T 对四类都有改善，但 **SS 的 logloss 仍 0.146、DD 0.109**：类别间温度需求不同，
  下一个迭代是 per-class/per-region 温度或 isotonic（E26e-b）。
- **按区域（headB；logloss / ECE，before → after）**：apac 0.092323→**0.082359** /
  0.024030→**0.001203**；eu 0.092975→**0.082385** / 0.025053→**0.000642**；
  na 0.090884→**0.080222** / 0.024857→**0.000513**；own 0.066088→**0.053627** /
  0.024077→**0.002286**。四区一致改善、无区域塌陷。
- **headA 参考**：T=0.4187，logloss 0.029074 → **0.004076**，Brier 0.001779 →
  0.001013，ECE 0.025889 → **0.000328**（headA 近乎确定，仅作参考，不参与判定）。
- **局限**：单温度是**全局同分布**校准——只适用于 E26d 语料同分布行；跨版本/跨分布
  对抗分布未验证；SS（101 正例）与 DD 的残余 logloss 仍高，说明类别/区域异质；
  未改端上推理（温度后处理可在 Rust 侧 `sigmoid(logit/T)` 实现，但属后续交付任务）；
  未重新训练，未调 E26d 验收线。
- **产物**：本机 `out/torpedo_model/e26e/{e26e_oof.npz（27.2MB）, e26e_oof_metrics.json,
  calibration_metrics.json, e26e_train.log}`；node3 `/mnt/work/wowsp-kots/e26e/run`
  同源；预注册 `e26e-a-preregistration.md`（含一次 python3.11 f-string 兼容修正的
  sha 披露，协议未改）。

### E26e-b · 鱼雷 outcome-lift 评估（**MIXED**：十分位 ρ 0.952 强正，但 top-decile lift 1.223× 差 1.25× 线 0.027）

- **问题（预注册 `out/torpedo_model/e26e-b-preregistration.md`，先落盘后跑）**：E26d/E26e-a
  的 headB 只证明能**排序专家点击**（agreement：AUPRC 0.037051、AUC 0.7084、top-lift
  2.662）。本任务只做**评估**：在专家发射行（labelB=1）上，按 OOF probB 十分位看
  **实际鱼雷命中率**，验证“排序点击”是否也“排序结果”；outcome 不灌训练标签
  （E15 先例），不改 E26d 验收线。
- **数据/join**：E26e-a OOF（3,111,384 行 / 2,215 局）+ Rust compact sidecar 4 shard
  （apac,eu,na,own 顺序）；行数 1,021,498 / 1,432,164 / 486,859 / 170,863 =
  **3,111,384 完全一致**；逐行 replayId/t(±1e-3)/shipId 校验 → **join 100.000%**
  （mismatch 0/0/0、缺字段 0、未 join 0）。sidecar 字段：replayId/t/shipId/
  torpFiredFish/torpHits/torpHpLostNearby/torpTerminalNear（脚本兼容 snake/camel）。
- **outcome 口径（冻结）**：120 s 结果窗；鱼雷按 (owner, shotId) 最近前置 join 终点
  （飞行 ≤300 s）；命中 = 终点在任一敌舰 **≤120 units** 且覆盖敌方 HP drop
  （±0.4/0.6 s、≥50）；HP-loss 为 E13 full-credit **序数代理**（交叉火力高估，不当作伤害）。
- **质量**：launched 行 **17,055**；firedFish **71,693**（平均 4.2 雷/次）；hits **5,854**；
  base hitRate **8.165%**（行级 any-hit 12.85%；HP-loss 494/鱼）；**labelB=1 但 firedFish=0：0 行**
  （label 与 salvo 一致性完美）；terminalNear 正值行 10,196（max 15）。
- **P0 own（50 局，仅质量校准，不参与验收）**：54,389 行，join 100%，launched 334、
  fired 1,280、hits 152（hitRate 11.88%），top-decile lift 0.588、ρ −0.345——样本太小
  （每十分位 ~128 鱼）且方向不稳；如实记录，**不作为结论**。
- **全量主结果（pooled OOF，17,055 行 / 71,693 fish / 5,854 hits）**：

  | 指标 | 值 | 预注册线 | 判定 |
  |---|---|---|---|
  | top-decile fish 命中率 | 9.99%（base 8.165%） | lift ≥1.25× | **1.2234× ✗** |
  | 十分位 Spearman(meanP, hitRate) | **0.9515**（CI 0.672–0.976） | ≥+0.30 且 CI 排除 0 | **✓** |
  | top-bottom 命中率差 | 5.02 pp（9.99% vs 4.97%） | — | 描述 |
  | HP-loss/鱼 top vs bottom 十分位 | **1043 vs 187（5.6×）** | — | 描述（序数代理） |
  | 行级 ρ(probB, any-hit) | 0.110 | — | 描述 |
  | bootstrap 1000（replay cluster） | lift 95% CI [1.079, 1.392]；ρ CI 排除 0 | — | — |

  十分位命中率总体下行（10 档：9.99/9.32/9.37/8.70/8.45/9.21/7.65/6.81/5.76/4.97%，2→3、5→6 两处小回调），
  行级 any-hit 17.9%→6.8%，HP-loss/鱼 1043→187。**判定：MIXED**（join 过、ρ 与 CI 过、
  top-decile lift 1.2234 < 1.25，差 0.0266；不做任何事后放宽/调参）。
- **几何-only 对照（secondary，描述）**：terminalNear 仅“终点靠近敌舰”的几何命中代理
  基线 56.8%，top 十分位 59.6%（lift 1.049）——远弱于真实命中 lift 1.223；说明 headB
  排序的主要是“终点是否覆盖 HP drop（有效命中）”，而不只是“落点靠近船”。
- **agreement vs outcome（分开报告）**：probB vs labelB 的 AUPRC 0.037051 / AUC 0.7084 /
  logloss 0.09004（与 E26d 完全一致）——**排序专家点击 ≠ 结果更好**；本结果表明二者
  在本数据上方向一致（十分位总体下行、ρ 0.95），但 effect size 未到预注册 outcome 线。
- **按类别（launched 行；lift / ρ）**：DD 10,949 行 / 49,482 fish / 4,159 hits（base 8.41%，
  lift **1.186**，ρ 0.721）；CL/CA 5,009 / 18,391 / 1,367（7.43%，**1.426**，ρ 0.952）；
  BB 996 / 3,568 / 281（7.88%，**1.453**，ρ 0.006——行少、每档 ~356 鱼，ρ 不稳）；
  SS 101 / 252 / 47（18.65%，0.812，ρ 0.085，**样本不足仅描述**）。
- **按 region（lift / ρ）**：apac 5,489 行 / 23,257 fish / 1,915 hits（8.23%，**1.438**，ρ 0.939）；
  eu 7,937 / 33,853 / 2,637（7.79%，**1.228**，ρ 0.939）；na 2,672 / 11,197 / 826
  （7.38%，0.875，ρ 0.358）；own 957 / 3,386 / 476（14.06%，1.105，ρ 0.285）。
  → apac/eu 方向强，na/own 弱（样本与域差异）；四区均无系统性反向。
- **局限**：命中是**代理**（HP 采样稀疏会漏判、终点靠近误判、交叉火力高估伤害；
  server damageStat 仅录像者/15.8+，未逐条对齐）；120 units/300 s/120 s 为冻结近似；
  SS 仅 101 行、na/own 样本薄；outcome 只用于评估（不进训练标签）；top-decile 是单点
  估计，lift CI [1.08,1.39] 跨过 1.25（但点估计未过，按预注册不加解释性放宽）；
  2,217 seen → 2,215 有行局（2 个 own CO_ocean 录像 0 行，自然剔除）；14.5 录像无
  recorder damageStat 真值，命中代理只在 15.8+ 有部分交叉校准。
- **下一步**：E26e-c 方向——outcome-aware 特征/标签（命中结果/DoT/管位几何）与
  click-level 序列；把 HP-loss 序数信号作为 secondary target 研究；per-class lift 的
  样本补强（SS/BB）；若要做概率分级，配合 E26e-a 温度校准（概率已可校准，排序结论不变）。
- **产物**：`out/torpedo_model/e26e-b/{outcome_lift_metrics.json, p0_own_metrics.json,
  outcome_{apac,eu,na,own}.jsonl, export_*.log}`；脚本 `scripts/experiments/
  torpedo_outcome_lift.py`（numpy-only，含 --selftest）；预注册 `e26e-b-preregistration.md`
  （含 join 稳健性/terminalNear secondary 的运行前与运行后透明披露）。
### E26e-c · outcome-aware 第三头（headC）+ 类别温度校准（**PASS**：headC launched top-decile 命中率 lift 2.213×、ρ 0.988）

- **问题（预注册 `out/torpedo_model/e26e-c-preregistration.md`，先落盘后跑）**：E26e-b 结论
  MIXED——headB 排序专家点击很强（十分位 ρ 0.952）但 launched 行 top-decile 命中率 lift
  1.2234× 未过 1.25× 线。本任务给模型一个**直接 outcome 监督**的第三头
  **headC = P(torpHits>0 | launched)**（只在 labelB==1 行上用 BCE 训练），验证它能否把
  outcome 排序推过预注册的 **1.35×** 线；outcome **只进 headC**，不进 headB 标签/损失，
  不改 E26d/E26e-b 验收线。
- **实现（脚本内本地 ThreeHeadDeepSets，`train_fire_model.py` 未改）**：三头 DeepSets
  = E26 TwoHead 结构 + `head_c`；headA/B 损失不变，headC 只加在 launched 行；总损失
  = lossA + lossB + lossC（等权，先验登记）。`--outcome` 4 sidecar 逐行对齐（行数必须
  相等；replayId/t(±1e-3)/shipId 三重校验，mismatch 立即报告）；`--save-oof` 增
  `probC/labelC`。不带 flag 时训练路径与 E26e-a 逐位兼容。
- **数据/质量**：3,111,384 行 / 2,215 局；sidecar join **100.000%**（apac/eu/na/own
  1,021,498/1,432,164/486,859/170,863，mismatch 0、缺字段 0）；launched 17,055 行，
  **labelB=1 但 firedFish=0：0 行**；headC 正例（行级 any-hit）**2,192**（12.85%）；
  terminalNear 正值行 10,196。5 折 GroupKFold seed 0，hidden 192 / batch 4096 /
  12 epochs / lr 1e-3 / smoothing 0.05，node3 CUDA；训练 237.5 s（5 折 46.9–48.8 s）。
- **headC OOF（launched 行）**：AUPRC **0.253975** / AUC **0.715340** / logloss 0.347997 /
  Brier 0.104740 / ECE 0.008401（base 0.128525；5 折外 AUPRC 0.224–0.295、AUC 0.696–0.730）。
  headC 概率**本身已接近校准**（ECE 0.008 vs headB 0.025）。
- **outcome-lift（launched 行，fish-level，`--prob-key C`）**：

  | 指标 | 值 | 预注册线 | 判定 |
  |---|---|---|---|
  | top-decile fish 命中率 | **18.07%**（base 8.165%） = **2.213×** | ≥1.35× | **✓** |
  | 十分位 Spearman(meanP, hitRate) | **0.9879**（CI 0.964–1.0） | ≥+0.30 且 CI 排除 0 | **✓** |
  | bootstrap lift 95% CI | [2.030, 2.412] | — | — |
  | top-bottom 命中率差 | 17.56 pp（18.07% → 0.50%） | — | 描述 |
  | HP-loss/鱼 top vs bottom 十分位 | **1716 vs 10（166×）** | — | 描述（序数代理） |

  十分位命中率总体下行（3→4 档 10.08<10.26 一处小回调）：18.07/12.54/10.08/10.26/8.38/7.16/6.26/3.66/1.75/0.50%。
  **判定：PASS**（join 100% ✓、lift 2.213 ≥1.35 ✓、ρ 0.988 ≥0.30 ✓、CI [0.964,1.0] 排除 0 ✓）。
- **与 E26e-b headB 对照（同一 npz、同 sidecar、同评估代码）**：headB outcome lift
  **1.2311×**（ρ 0.952，仍 mixed，<1.25）；combined = `sqrt(probB*probC)` **1.9821×**
  （ρ 1.0，CI [1.804,2.151]，预注册 secondary，也过 1.35 线但**不参与判定**）。
  → outcome 监督直接优化结果排序，明显强于“排序专家点击”的 headB。
- **headB 影响（共享 trunk，如实记录）**：加入 headC 后 headB OOF AUPRC **0.032733**
  = **2.0197×base**、top-decile launch lift **2.349** → 仍过 E26d 验收线（PASS），但比
  E26e-b 的 headB（0.037051 = 2.286×base、top-lift 2.662、AUC 0.7084）略弱（AUC
  0.6828、logloss 0.09062）；headA OOF AUPRC 0.999934（较 E26e-b 0.999887 提升）。
- **按类 headC outcome lift / ρ（launched 行）**：DD 10,949 行 / 49,482 fish / 4,159 hits
  （base 8.41%，**2.180×**，ρ 0.988）；CL/CA 5,009 / 18,391 / 1,367（7.43%，**2.273×**，
  ρ 0.988）；BB 996 / 3,568 / 281（7.88%，**2.676×**，ρ 0.912）；SS 101 / 252 / 47
  （18.65%，1.100×，ρ 0.467，**样本不足仅描述**）。
- **按 region**：apac 5,489 / 23,257 / 1,915（8.23%，**2.271×**，ρ 0.988）；eu 7,937 /
  33,853 / 2,637（7.79%，**2.176×**，ρ 0.988）；na 2,672 / 11,197 / 826（7.38%，
  **2.036×**，ρ 0.964）；own 957 / 3,386 / 476（14.06%，**1.894×**，ρ 0.867）——四区一致强正。
- **类别温度校准（secondary，描述）**：
  - headB：global **T=0.7581**（≈E26e-a 的 0.7586，复现性一致），logloss 0.09062→**0.07998**、
    Brier 0.016456→**0.015845**、ECE 0.02493→**0.00037**；per-class T：BB 0.703 / CL 0.730 /
    DD 0.788 / SS 0.826，各类 logloss 均降（如 DD 0.11840→0.10926，SS 0.15171→0.14509）、
    ECE 降到 ~0.0002–0.0006。
  - headC：global **T=1.0538**，logloss 0.34800→**0.34756**、Brier 0.10474→0.10472、
    ECE 0.00840→**0.00697**；per-class T：DD 1.033 / CL 1.091 / BB 1.087 / SS 0.989，
    改善幅度小（headC 本身已校准），SS（101 行）仅描述。
  - 结论：类别温度对 headB 的系统性校准收益最大（ECE 降 98%）；headC 的收益小，说明
    outcome 监督的 head 同时学到了较准的概率。
- **局限**：命中仍是**代理**（ShotKillEvent 终点 + 120 units + HP drop 覆盖；HP 采样稀疏、
  交叉火力高估伤害、服务器 damageStat 仅录像者/15.8+ 未逐条对齐）；120 s/300 s/120 units
  为冻结近似；headC 与 headB 共享 trunk，headC 训练让 headB 排序略降（仍过线）；SS 仅
  101 行、na/own 样本薄；outcome 只用于 headC（不进 headB），未做端上部署/概率分级。
- **下一步（E26e-d）**：click-level 序列标签与真实管位/DoT/命中几何特征；outcome-weighted
  ranking / 双头联合排序（headC 排序 + headB 触发）；per-class headC 校准与端上温度后处理
  （T 可在 Rust 侧 sigmoid(logit/T) 实现，另立预注册）；更大 SS/BB 样本；命中结果标签
  （shotKills join）与 server damageStat 的小子集校准。
- **产物**：`out/torpedo_model/e26e-c/{e26e_c_oof.npz（38.7MB）, e26e_c_metrics.json,
  e26e_c_train.log, outcome_lift_B.json, outcome_lift_C.json, outcome_lift_combined.json}`；
  node3 `/mnt/work/wowsp-kots/e26e-c/{code,run,outcome}`；预注册
  `out/torpedo_model/e26e-c-preregistration.md`（含脚本 sha 冻结值）。
### E26e-d · 解耦 outcome headC + 联合排序（**MIXED**：joint lift 1.381× 远低于预注册 2.2×；解耦无收益）

- **问题（预注册 `out/torpedo_model/e26e-d-preregistration.md`，先落盘后跑）**：E26e-c
  的共享 trunk 让 headC 很强（outcome lift 2.213×）但把 headB 拖弱（2.020×base、
  top-lift 2.349，弱于 E26e-b 的 2.286×/2.662）。本任务把 outcome head **解耦**：
  standalone headC 只用自己的 trunk、只在 launched 行训练；**headA/B 保持 E26e-a 原模型
  不重训**。主验收：joint = `probB(E26e-a) × probC(standalone)` 在 launched 行
  top-decile fish 命中率 lift **≥2.2×**（不弱于 shared headC 2.213）且 ρ≥+0.30/CI 排除 0；
  同时 headB 保持原状（1.2234× / AUPRC 2.286×base / top-lift 2.662 不变）。
- **实现**：`--head-c-only` = 同形 DeepSets trunk（entity 24×15 / global 38 / mask 24）+ 单
  `head_c`，训练行 = `labelB==1 & torpFiredFish>=1`（17,055 行 / 2,192 正例），hidden 192 /
  12 epochs / batch 4096 / lr 1e-3 / smoothing 0.05 / float16 / cuda / 5 折 GroupKFold
  seed 0；OOF npz 只含 launched 行有效的 probC + 元数据。`--combine-oof` 把 E26e-a probB
  与本任务 probC 合并（校验 rowIndex/shipId/t/group 完全一致），不覆盖原 npz；
  `torpedo_outcome_lift.py` 新增 `--prob-key standaloneC|joint`（joint=probB*probC）。
  训练 3.9 s（5 折 2.7/0.3/0.3/0.3/0.3 s）+ 合并/评估秒级；`train_fire_model.py` 未改。
- **headB 不变性（解耦目标）**：E26e-a npz 原样评估 → outcome lift **1.2234×**、ρ 0.9515、
  CI [1.079,1.392]，与 E26e-b **完全一致**；headB 未重训 → 解耦**没有误伤**。
- **四种分数对照（launched 行，fish-level，同 sidecar/评估代码）**：

  | 分数 | top-decile 命中率 lift | 十分位 ρ | bootstrap lift 95% CI | 判定 |
  |---|---|---|---|---|
  | headB（E26e-a 原模型） | 1.2234× | 0.9515 | [1.079, 1.392] | MIXED |
  | shared headC（E26e-c） | **2.2126×** | **0.9879** | [2.030, 2.412] | PASS |
  | standaloneC（本任务） | 1.3011× | 0.9152 | [1.120, 1.466] | MIXED |
  | **joint（primary）** | **1.3813×** | 0.9515 | [1.215, 1.575] | **MIXED**（<2.2 ✗） |

  joint 十分位命中率 11.28/9.77/9.64/9.48/9.51/9.52/8.09/6.06/2.82/2.48%
  （top-bottom 8.80pp）；standaloneC 10.62/10.01/9.93/9.58/10.07/8.39/8.87/7.42/2.28/1.55%。
- **standaloneC OOF（launched 行）**：AUPRC **0.17393** / AUC **0.61851** / logloss 0.372610 /
  Brier 0.109728 / ECE 0.014955（base 0.128525；5 折 AUPRC 0.150–0.210、AUC 0.595–0.640）。
  与 shared headC（0.25398 / 0.71534 / 0.347997 / 0.104740 / 0.008401）相比**全部更弱**——
  只在 17k launched 行训练、且失去共享表示，是解耦代价。
- **joint 按类 lift / ρ**：BB 996 行 2.091/0.758；CL 5,009 行 1.775/0.952；DD 10,949 行
  1.444/0.515；SS 101 行 0.794/−0.115（样本不足仅描述）。**按 region**：apac 5,489 行
  1.507/0.915；eu 7,937 行 1.302/0.891；na 2,672 行 0.950/0.406；own 957 行 1.989/0.333。
  standaloneC 按类：BB 2.503、CL 1.464、DD 1.206、SS 0.715；按 region：own 2.067、apac
  1.423、eu 1.175、na 0.840。
- **standalone headC 类别温度校准（secondary）**：global T=**0.9551**，logloss 0.372610→
  **0.372191**、Brier 0.109728→0.109741（基本不变）、ECE 0.014955→**0.014398**；per-class
  T：BB 0.953 / CL 0.893 / DD 0.980 / SS 1.572（SS ECE 0.0967→0.0080，但 n=101 仅描述）。
- **判定（预注册）**：join 100% ✓、ρ 0.9515 ≥0.30 ✓、CI [0.721,0.988] 排除 0 ✓，但
  **joint lift 1.3813 < 2.2** ✗ → **MIXED**。**结论（按预注册 fallback 表述）**：
  **解耦无收益**——standalone headC 自身就弱（AUPRC 0.174 vs 0.254；outcome lift 1.30 vs
  2.21），joint 也只有 1.38；共享 trunk 的多任务表示对 headC 是必要的。解耦只是让
  headB 回到原模型（1.2234× 原样），但 headC 变弱，净收益为负。
- **局限**：launched-only 训练样本少（17,055 行 / 2,192 正例），standalone 易欠拟合/方差大
  （fold AUPRC 0.150–0.210 波动）；joint 用乘积融合，headB 概率尺度与 headC 不同；
  命中仍是代理（120 units + HP drop）；SS 101 行、na/own 样本薄；outcome 只用于 headC。
  **口径提示**：本任务 standalone headC 使用 label smoothing 0.05 的平滑 BCE，E26e-c 的
  共享 headC 用未平滑 BCE（两者超参按各自预注册），因此跨任务的 headC 概率/校准指标
  只作方向对照，不是严格同口径 A/B。
- **下一步（E26e-e）**：保留 E26e-c 共享 headC 作为主方案；研究**多任务权重/梯度
  平衡**（降低 headC 对 headB 的干扰，如 loss weighting / gradient surgery）；特征扩展
  （管位/DoT/click-level 序列）；端上概率分级（温度 T 后处理，另立预注册）。
- **产物**：`out/torpedo_model/e26e-d/{e26e_d_c_oof.npz（5.95MB）, e26e_d_combined_oof.npz
  （27.34MB）, e26e_d_c_metrics.json, e26e_d_train.log, outcome_lift_joint.json,
  outcome_lift_standaloneC.json, outcome_lift_B_e26ea.json, outcome_lift_sharedC_e26ec.json}`；
  node3 `/mnt/work/wowsp-kots/e26e-d/{code,run}`；预注册 `e26e-d-preregistration.md`（含脚本
  sha 冻结值）。
### E26e-e · 多任务 headC 损失权重扫描（**MIXED**：λ=0.3 未过 headB 恢复线；但扫描显示 λ↓ 可恢复 headB 且 headC 保持）

- **问题（预注册 `out/torpedo_model/e26e-e-preregistration.md`，先落盘后跑）**：E26e-c 的
  共享 trunk 三头（λ=1.0）把 headC 推到 outcome lift 2.213×，但 headB 被拖到
  **2.0197×base / top-lift 2.349 / AUC 0.6828**（E26e-b 为 2.286× / 2.662 / 0.7084）。
  本任务给总损失加权重 `wA·L_A + wB·L_B + wC·L_C`（wA=wB=1，主配置 **λ_C=0.3**），验证
  能否同时满足：(a) headB OOF **AUPRC≥0.0365（≈2.25×base）且 top-decile launch lift≥2.55**；
  (b) headC outcome lift **≥2.0×** 且 ρ≥+0.30 且 bootstrap 95% CI 排除 0。两条都过 PASS，
  一条 MIXED，都不过 FAIL；不做事后调线。
- **实现**：`--head-c-weight`/`--head-b-weight`（默认 1.0；默认路径走原 `loss_a+loss_b` /
  `+loss_c` 表达式 → 与 E26e-c **逐位兼容**）；headC 权重 0 可选（无 C 梯度对照）。
  `--selftest` 覆盖 default/自定义权重解析；6k CPU smoke λ=0.3 通过。协议/模型/loader/
  sidecar 路径不变；OOF 保存 probA/B/C。
- **运行**：node3 顺序跑 λ ∈ {0.1, 0.3, 0.5}（各 5 折 / 12 epochs / hidden 192 / batch
  4096 / lr 1e-3 / smoothing 0.05 / float16 / cuda；训练 ~240 s/次）；每个 OOF 用
  `torpedo_outcome_lift.py --prob-key C --min-lift 2.0` 评估 headC。
- **主配置 λ=0.3 结果**：headB **AUPRC 0.034862 = 2.151×base**、top-lift **2.5195**、
  AUC 0.6963、logloss 0.09073；headC **outcome lift 2.1815×**、ρ **0.9879**、bootstrap 95% CI
  **[2.006, 2.375]**（排除 0）。→ **(a) FAIL**（0.034862 < 0.0365、2.5195 < 2.55）、
  **(b) PASS** → **MIXED**（按预注册，主配置固定 λ=0.3，不从 sweep 反选）。
- **λ 扫描（secondary，不参与判定）**：

  | λ_C | headB AUPRC | ×base | top-lift | AUC | headC OOF AUPRC | headC outcome lift | ρ | 95% CI |
  |---|---|---|---|---|---|---|---|---|
  | 1.0（E26e-c 参照） | 0.032733 | 2.020 | 2.349 | 0.6828 | 0.25398 | 2.2126 | 0.988 | [2.030,2.412] |
  | 0.5 | 0.034455 | 2.126 | 2.456 | 0.6947 | 0.25530 | 2.2187 | 1.000 | [2.044,2.405] |
  | **0.3（主配置）** | 0.034862 | 2.151 | 2.519 | 0.6963 | 0.25404 | **2.1815** | 0.988 | [2.006,2.375] |
  | 0.1 | **0.036015** | **2.222** | **2.610** | **0.7043** | 0.25760 | **2.2518** | 1.000 | [2.074,2.453] |
  | —（headB-only 参照，E26e-b） | 0.037051 | 2.286 | 2.662 | 0.7084 | — | 1.2234 | 0.952 | [1.079,1.392] |

  → **趋势清晰**：λ_C 越低 headB 恢复越多（AUC 0.6828→0.7043、top-lift 2.349→2.610、
  AUPRC 2.020→2.222×），而 headC outcome lift 稳定在 **2.18–2.25×**（λ=0.1 甚至 2.252 >
  λ=1.0 的 2.213）——降权**几乎不损失 headC**，只是 λ=0.3 的降幅还不够。λ=0.1 是扫描中
  最佳权衡（headB top-lift 2.610 已过 2.55 线、headC 2.252 远超 2.0；AUPRC 0.036015 仍差
  0.0365 线 1.3%），但预注册主配置是 0.3 → 判定仍 **MIXED**，不事后改线/换配置。
- **λ=0.3 按类/region（headC）**：AUPRC DD 0.2715 / CL 0.2116 / BB 0.2547 / SS 0.2926
  （101 行仅描述）；outcome lift DD **2.176**/ρ 0.964、CL **2.106**/0.976、BB **2.869**/0.948、
  SS 1.300/0.297；region apac **2.262**/0.988、eu **2.049**/0.964、na **2.064**/0.976、
  own **1.854**/0.891。headB 按类 AUPRC：DD 0.0395 / CL 0.0246 / BB 0.0210 / SS 0.0443。
- **判定（预注册）**：**(a) FAIL、(b) PASS → MIXED**。结论：**降低 headC 权重方向正确**
  （λ↓ 单调恢复 headB，headC 基本不掉）；λ=0.3 不够——要恢复 headB 到 E26e-b 附近需
  λ≈0.05–0.1 或更精细的干扰控制（frozen-trunk / 梯度手术）。
- **局限**：λ 只扫 3 点（0.1/0.3/0.5，未扫更小）；headB 仍未完全回 E26e-b（λ0.1
  AUPRC 2.222× vs 2.286×）；per-fold headB AUPRC 全 sweep 0.032963–0.037623（λ0.3 为
  0.033914–0.037116）有波动；代理 outcome
  （120 units + HP drop，非 server 真值）；SS 101 行、na/own 样本薄；未冻结 trunk、未调
  per-head LR；未做端上部署。metrics JSON 里的 `acceptance` 仍是 E26d 的旧验收线
  （AUPRC≥2×base 且 top-lift≥1.5×），E26e-e 的判定以本预注册 (a)/(b) 为准。
- **下一步（E26e-f 候选）**：① λ_C≈0.05–0.1 复验（另立预注册，目标 AUPRC≥0.0365 且
  headC≥2.0）；② frozen-trunk headC：先按 E26e-b 训 headA/B 并冻结，再加 headC 短训；
  ③ 梯度手术/PCGrad；④ 特征扩展（管位/DoT/click-level 序列）；⑤ 端上概率分级（温度 T 后处理）。
- **产物**：`out/torpedo_model/e26e-e/{e26e_e_lambda{0.1,0.3,0.5}_oof.npz（各 ~38MB）,
  e26e_e_lambda{...}_metrics.json, e26e_e_lambda{...}.log, outcome_lift_lambda{...}_C.json}`；
  node3 `/mnt/work/wowsp-kots/e26e-e/{code,run}`；预注册 `e26e-e-preregistration.md`
  （脚本 sha `939f9b89…`，与 node3 实跑一致）。
## 目标路线图（G1–G5）

| Goal | 内容 | 完成标准 | 状态 |
|------|------|---------|------|
| G1 | 视野与状态特征完备 | tick 快照含：烟雾遮挡、消耗品状态、可见性事件、全船节速意图 | ✅ E8/E11/E12（节速意图仅录制者，全船为引擎输出档） |
| G2 | 数据规模化就绪 | 任意录像文件夹 → 一键聚合数据集（容错跳坏文件）+ 按局切分 | ✅ E12 |
| G3 | 训练工程化 | 多局训练 + 纪要 B 评估指标全实现（分层 κ / ECE / decile lift / GroupKFold） | ✅ E12 |
| G4 | 分发与端上集成 | `decisions` 模型包（含 LOS 栅格）+ 端上加载真模型 + 战术板建议层 | ✅ G4-a/G4-b（pack 管线 + `decision_fire_suggestions` + 2D 地图建议层） |
| G5 | 第一个可用开火决策模型 | 炮船录像 ≥ 数百局 → 弱监督预训练+本船微调 → 纪要 B 验收门槛 → 随包分发 | 🔬 第二版已训（E19：2217 局 MoE，AUPRC 0.32/AUC 0.72；分发待评分语义重构后一并定版） |
| G6 | AI 分析调试工具（走位 + 评分） | 2D/3D 地图上「此刻、此情报下每艘船的最优走向」+ 每船整局评分与滑动瞬时评分（含置信度） | ✅ 四步齐（E16/E18/E19 模型与 UI + E21 整局评分过线：X3 确认集 ρ=+0.477）；评分主数值=实际窗口贡献，认同度为独立维度 |

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
  stdlib 解析器读不了——新增 `extract_glb_positions.ts`（three 内嵌
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
