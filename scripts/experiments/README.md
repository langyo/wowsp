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
| E26e-f | torp3 属性特征 + λ_C=0.1 | torp3（torp2 + 6 维 hull 鱼雷属性：speed/damage/detect/count/deep/ETA）在 λ_C=0.1 下能否恢复 headB（AUPRC≥0.0365 且 top-lift≥2.55）并保持 headC（outcome lift≥2.30） | ⚠️ | headB **0.039022 = 2.408×base**、top-lift **2.789**、AUC 0.7141（全面超过 E26e-b 的 0.037051/2.662/0.7084 ✓）；headC outcome lift **2.2329**（<2.30 ✗）/ρ 1.0/CI [2.040,2.413] → (a) ✓、(b) ✗ = **MIXED**：torp3 显著恢复 headB、headC 基本持平 |
| E26e-g | torp4 click-context 特征 | torp4（torp3 + 5 维 click-context：lastClickAge/clicks30s/fish30s/lastClickFish/totalClicks）在 λ_C=0.1 下能否把 headC outcome lift 推过 2.30 且 headB 非退化（AUPRC≥0.039022、top-lift≥2.789） | ⚠️ | headB **0.042126 = 2.599×base**、top-lift **2.905**、AUC **0.7273**（非退化 ✓，且较 torp3 再提升）；headC outcome lift **2.1997**（<2.30 ✗，且略低于 torp3 2.2329）/ρ 0.988/CI [1.998,2.378] → (a) ✗、(b) ✓ = **MIXED**：click 特征强力提升 headB，但 headC outcome 无增益（代理标签上限仍属假设，CI 重叠） |
| E26e-h | headC 训练目标对齐 fish-level | `--head-c-target any\|fish_rate\|fish_weighted` 能否把 headC outcome lift 推过 2.30（torp4，λ_C=0.1） | ⚠️ | fish_weighted（primary）：headC **2.1981**（<2.30 ✗）、headB 0.041189（−2.2%，超 1% 容忍 ✗）→ FAIL；fish_rate（secondary）：headC **2.3069**（≥2.30，仅 +0.0069；CI 下界 2.099<2.30）、headB 0.042086/2.912（AUC 0.72633；strict AUPRC 比 0.042126 低 **0.00004**，仅在 1% 容忍内）→ **严格预注册（1% 容忍线“仅报告”）= MIXED**；若把 1% 容忍当非退化则可记 PASS，但主结论按严格读法为 MIXED；soft per-fish 目标仅边际、原始 ECE 0.057 需 T=1.387 校准 |
| E26e-i | headC 两模型 OOF 融合 | mean calibrated probability 融合 E26e-g any-target（2.1997）+ E26e-h fish_rate（2.3069）能否稳健过 2.30 | ⚠️ | ensemble **2.2475×**（<2.30）/ρ 0.988/CI [2.045,2.438]；rank-average 2.2540/ρ 1.0 仅报告；两源对照 2.1997 / 2.3069 → **MIXED**：两 headC 高度相关（calibrated 后 ρ 0.916），融合只到两者之间，不能稳健过线 |
| E26e-j | 鱼雷命中标签定义敏感性 | 固定 E26e-g any / E26e-h fish_rate OOF，在 r60/r120/r200/nohp120 标签上评估 headC outcome lift（主验收 any@r60 ≥2.30） | ✅ | any@r60 **2.6811×**/ρ 0.988/CI [2.438,2.930] → **PASS**；fish_rate@r60 **2.8390×**/ρ 1.0/CI [2.561,3.090]；r120 复现 2.1997/2.3069；r200 1.8485/1.9534；nohp120 1.1878/1.2297 → **半径越严 lift 越高、noHP 崩溃**：标签定义是 headC 平台的重要因素（下一步用 r60 标签重训，另立预注册）；不重训/不调阈值 |
| E26e-k | r60 严格标签重训 headC | 用 r60 标签重训 torp4 3 头（λ_C=0.1）能否把 E26e-j 固定模型 any@r60 **2.6811** 变成模型收益（≥2.68，CI 下界>2.30） | ⚠️ | 重训后 r60 lift **2.6329×**（<2.68 ✗）/ρ 1.0/CI [2.374,2.883]（下界>2.30 ✓）；r120 cross-eval **2.0844×**（vs E26e-g 2.1997）；headB **0.042302**/top-lift **2.9434**（非退化 ✓）→ **MIXED**：r60 收益是跨标签排序现象，未转化为重训收益 |
| E26e-l | torp5 目标几何特征 | torp5（torp4 49 + 5 维目标几何：aspect/cross/lead/intercept/yaw）能否把 headC r120 outcome lift 推过 2.30，且 headB 不退化 | ⚠️ | r120 headC **2.2639×**（<2.30 ✗，但较 torp4 2.1997 +0.064）/ρ 0.988/CI [2.076,2.465]；r60 cross **2.7631×**（≥2.68 ✓，优于 E26e-j 固定 2.6811）；headB **0.041865**/top **2.8836**（1% 容忍内 −0.6%/−0.7%）→ **MIXED**：目标几何有边际增益但未跨 2.30 线 |
| E26e-m | server damageStat 真值 vs 120u+HP 代理审计 | 用录像者 server damageStat（weapon=7/category=0）审计代理命中标签：代理 vs 真值 precision/recall；server 真值标签下 headC outcome lift 是否仍 ≥2.30（样本 ≥200 才判定） | ✅ | recorder launched 710 行（4.2%）：TP/FP/FN/TN **138/35/147/390**、precision **0.7977**/recall **0.4842**（漏 52% server 命中）；server-label headC lift **2.3477×**/ρ 0.891/CI [1.807,3.018]（fired 3,212/hits 471）→ **真值下仍 PASS**；局限 recorder-only/窗口重叠 |
| E26e-n | server 真值绝对概率校准 | 不重训，用 5 折 replay 分组 held-out **Platt（主）/isotonic（次）** 把 headC 绝对概率校准到 server damageStat 真值；预注册原判据含 pooled lift 保持 | ⚠️ | 710 truth 行（285 正/311 replay/3,212 fired）；raw→Platt **Brier 0.2805→0.2241（−20.1%）**、**logloss 0.8067→0.6387（−0.168）**、**ECE 0.2367→0.0636（−73%）**、meanProb 0.168→**0.401≈hitRate 0.401**；但 pooled lift **2.266 < raw 2.348**（原判据 FAIL）；首跑后把 lift 判据改为 held-out 折内（max|Δ|=0）才 PASS → **MIXED / post-hoc**：校准数值保留为探索性，不称严格 PASS |
| E26e-o | leave-one-region-out 泛化验证 | 训练 apac+eu+na（2,940,521 行），holdout own（170,863 行）从不参与训练/验证；5 折模型平均预测 holdout；主验收 holdout headC r120 outcome lift ≥**2.00**（泛化线）且 ρ≥0.30/CI 排除 0；headB 非退化 ≥2.0×base/top≥1.5 | ⚠️ | holdout headB **AUPRC 0.032647 = 3.214×base、top-lift 3.114、AUC 0.7035（PASS）**；holdout headC **lift 1.3849×**（<2.00 ✗）/ρ 0.758/CI [0.855, 2.190]；in-dist own 子集对照 **2.1809×**（ρ 0.903/CI [1.473, 2.823]）→ **MIXED：region 泛化缺口 −0.796×（−36.5%）**，headB 泛化良好、headC 排序泛化不足 |
| E26e-p | few-shot region adaptation | own 10% replay（17/161，seed0）入训、90%（144）holdout；主验收 holdout own headC r120 lift ≥**1.80**（收窄 E26e-o 缺口≥一半）且 ρ≥0.30/CI 排除 0；headB 非退化 | ⚠️ | holdout headB **AUPRC 0.036724 = 3.531×base / top 3.261 / AUC 0.7707（PASS）**；holdout headC **lift 1.7514×**（<1.80 ✗，差 0.049）/ρ 0.806/CI [1.260, 2.505]；vs E26e-o 1.3849 **+0.3665（+26.5%，补回 46.0% 缺口）**、in-dist own 2.1809 → **MIXED：few-shot 有效但未达一半缺口线**，headB 泛化明显改善 |
| E26e-q | few-shot dose response | 同一 **common holdout（97/161 own replay）** 上对比 own 0%/10%/25% 入训（nested adapt，adapt10⊂adapt25）；主验收 **25%** holdout headC r120 lift ≥**1.90** 且 ρ≥0.30/CI 排除 0；headB 非退化；secondary=10% 与 dose Δ | ⚠️ | 0% **1.5963**/ρ 0.636/CI [0.843, 2.695]（E26e-o 子集）；**10% 2.1645**/ρ 0.855/CI [1.461, 3.063]；**25% 2.4859**/ρ 0.782/CI [1.724, 3.275] → **PASS（仅同期随机拆分；E26e-r temporal FAIL 不可外推）**；**dose Δ(25−10)=+0.3214**，25% 已超 in-dist own 2.1809；headB 0%→10%→25%：3.607×→3.490×→**4.049×base**/top 3.073→3.277→3.480/AUC 0.712→0.771→0.783（全 PASS） |
| E26e-r | 40% 剂量 + 时间外推 | 同一 common_holdout 补 **40%（adapt pool 64 replay）**；另做 **temporal 25%**（最早 40 replay 入训、最晚 97 replay holdout）；primary temporal headC ≥1.80 且 ρ≥0.30/CI 排除 0；secondary random40 ≥1.90 | ⚠️ | random40 headC **2.4413**/ρ 0.697/CI [1.631,3.379]（≥1.90 但**低于 25% 2.4859，剂量饱和**）；**temporal 25% lift 1.6244（<1.80 FAIL）、ρ −0.20、CI [0.752,2.374]**；temporal 0% 1.5063；headB 两 run PASS（random40 4.048×/temporal 3.333×base）→ **MIXED：random-split 2.4859 是同期随机拆分，时间外推不成立（time drift）** |
| E26e-s | 滚动起点 walk-forward | own 161 replay 按日期等分 Q1–Q4（40/40/40/41）；3 窗 adapt=Q_{i−1}→test=Q_i；primary=3 窗中 ≥2 窗 headC lift ≥1.80 且 ρ≥0.30/CI 排除 0；headB 非退化 | ⚠️ | **2/3 形式 PASS**：Q2 **3.0052**/ρ 0.903/CI [0.864,5.114]、Q4 **1.8256**/ρ 0.632/CI [0.360,3.422]；**Q3 0.9083（FAIL）/ρ −0.006/CI [0.258,1.565]**；0% baseline 每窗 0.9200/2.1373/1.6481；headB 全部非退化（4.40×/2.82×/5.31×base）→ **PASS(2/3) but Q3 FAIL / temporal instability 仍在**，不能宣称时间稳健，部署须 walk-forward 门禁 |
| E26e-t | Q3 崩盘时间漂移诊断（不重训） | 按 Q1–Q4 聚合 full own 数据/click/r120 outcome + e26e-s 三窗预测与 0% baseline；诊断 base-rate/特征分布/标签噪声 | — | Q3 base **18.59%**/rowAny **29.46%**（Q2 9.98/13.98、Q4 16.43/22.30）；25% runQ3 **meanProbC 0.037、ECE 0.258、AUC 0.500、lift 0.908**，0% baseline lift **2.137**；组成 Q3 brawl 12,806+event 12,192（Q2 pvp 62,556/event 2,555）；漂移 top shipId PSI 8.54/mapName 7.57/gameMode 5.66/enemyDistMean SMD 0.907 → **composition/prior shift + 跨模式排序坍塌**（非单一标签噪声）；建议 walk-forward 门禁加 AUC/CI 下界、分 mode/map/ship 或 reweight、按窗 prior/温度重校准，不推部署/总分 |
| E26e-u | 模式分层/先验归一化（不重训） | Q2/Q3/Q4 test block 上对比 raw、within-mode rank、oracle mode-prior、label-free adapt-prior；primary Q3 oracle global lift ≥1.80 | — | Q3 raw **0.908** → within-rank **1.703**、oracle **1.681**、adapt-prior **1.050**（均 <1.80 → **primary FAIL**）；AUC 0.500→**0.678**（oracle）说明模式先验确为主因，但 top decile 全落在 brawl（base 31.45%/全局 18.59% → lift 上限≈1.69）→ **模式内信号不足，分层不能修复 lift≥1.80**；label-free 因 adapt(Q2) 无 brawl/event 先验而失败；Q2 oracle 2.57<raw 3.01、Q4 oracle 3.04>raw 1.83（非普遍更优） |
| E26e-v | 多级 cell 先验 + 历史/滚动 label-free（不重训） | Q2/Q3/Q4 上 raw vs within-cell / oracle-cell（test cell base n>=5）/ historical（前序 block，EB α=20）/ rolling（前一 block）；primary Q3 oracle-cell ≥1.80 | — | Q3 raw **0.908** → within-cell 0.856、**oracle-cell 2.010（≥1.80，primary PASS）**、historical **0.680**、rolling **0.665**（label-free 均 <1.80）；oracle AUC 0.500→0.719、label-free AUC ≈0.50；coverage 43 cells/19 n>=5（176/241 行）；因 Q1+Q2 **无 brawl cell/mode**、25 个 test cell 缺失，historical 只能回退 global/mode → **cell 先验可修 lift（需目标窗 cell base），但 label-free 不可部署**；Q2 oracle 3.064/raw 3.005，Q4 oracle 1.683 <raw 1.826 但 historical 2.331（139 launched，AUC 0.52–0.54，小样本） |
| E26e-w | 延迟标签/在线 cell 先验（不重训） | Q2/Q3/Q4 launched 行按 t 排序，最早 20%/40% 标签估 cell base（EB α=20，cell→mode→block-global），余 80%/60% 评估；primary Q3 early-20% eval lift ≥1.80 且 AUC>0.55 | — | Q3 eval 子集：raw 0.682/0.526 → early20 **1.464/0.645**、early40 **1.087/0.549**、oracle 2.527/0.722、historical 0.630、rolling 0.776 → **primary FAIL（1.464<1.80；AUC 0.645>0.55）**、secondary FAIL；early20 仅 48 launched/178 fired/28 cells（eval 193 行，cell 覆盖 139）；Q2 early20 0.816 vs raw 3.152、Q4 0.930 vs raw 1.623；oracle 上界 2.53 → **延迟标签量/估计不足** |
| E26e-x | 层次化 early+历史/模式 EB 先验（不重训） | Q2/Q3/Q4 early-20/40% 上对比 A（early cell EB20）/B（cell→mode EB50 层次）/C（early+历史 cell 池化）/D（early cell→历史 mode）vs raw/oracle | — | **Q3 early-20%：raw 0.682/0.526 → A 1.464/0.645、**B 1.835/0.678（≥1.80 且 AUC>0.55 → primary PASS）**、C 0.678/0.622、D 1.464/0.655、oracle 2.527/0.722；early-40%：B 1.384/0.615（<1.80）**；Q2 early20 B 0.816 vs raw 3.152、Q4 B 0.799 vs raw 1.623（Q4 C 1.315/D 2.612、Q4-40 B 0.0/小样本不稳）→ **层次 EB 在 Q3 early-20% 过线但非普适/不稳定，不能部署/总分** |
| E26e-z | 外部独立 replay holdout（T4，不重训） | eval-only 模式加载外部 17,054 行/18 replay（2026-10-31..11-08，post-training，无训练交集）；checkpoint=T4 r120（sha 4f3935…）；primary headB ≥2.0×base 且 top≥1.5 | ⚠️ | headB AUPRC **0.022762 = 1.862×base（<2.0）**、top-decile **2.429**、AUC **0.6017**、ECE 0.0168 → **诊断门禁 FAIL**（top 过、AUPRC 未过）；headC r120 outcome **lift 1.9896**/ρ 0.596/CI **[0.0, 5.359]**（37 launched/115 fired/17 hits，8 clusters，标准 bootstrap 因 0-base replicate NaN 回退 local）；headA 0.9786/AUC 0.9979；外部批次以 pve/event/cooperative 为主（9,822/5,671/766+795）+ 20% unknown 船级 → **版本/时间/模式外推上限**，不重训不调线 |
| E26e-aa | 外部 holdout 分层诊断（mode/map/class/version） | eval-only 新增 `--eval-predictions-out`（probA/B/C/labels/outcome/replayId/t/shipId）；18 replay/17,054 行外部预测按 gameMode/map/class/version/日期分层 | — | **headB FAIL 集中在 event 模式**：event AUPRC **1.357×**/top **0**/AUC 0.553（can 1,209/pos 10）；pve **3.558×**/3.863、cooperative **3.439×**/1.633、pvp **5.342×**/3.244（仅 3 正，描述性）；非 pvp 合并 1.857×；class DD 1.565×/2.095、Cruiser 2.032×、BB 2.164×、SS 2.274×；version 15,10 2.782× vs 15,9 1.869×（event 两版均弱）；headC 1.9896 描述性（pvp/event/coop 样本不足）→ **领域/模式漂移为主，pvp 子集不能判**，不重训不调线 |
| E26e-ab | 逐鱼 server 真值审计 + HP-drop magnitude 敏感性（不重训） | 审计 replay schema（ShotKillEvent/DamageStatSample/HP samples/build_torpedo_outcome_context）；r120 sidecar 行级变体 A/B(t)/C(t)/D 重定义 hits（fired 不变），e26e-g OOF C 跑标准 outcome_lift | — | **审计：per-fish server damage 不可识别**（ShotKillEvent 无 victim/damage；DamageStat 仅 recorder 累计；HP 仅实体级；magnitude 只是行级 full-credit 近似）；**A 2.1997 复现**；B t=1000/2000/3000/5000 → **2.61/2.76/2.92/3.08**（base 8.17%→1.31%），C → 2.38/2.53/2.62/2.74，D clean-terminal **2.336**；但 top-decile 绝对命中率 **17.96%→4.0–5.8%**（lift 升是标签选择性/base-rate 效应，不是更强逐鱼真值）；描述性、不重训、不调线 |
| E26e-ac | 外部 event/DD 专项诊断（不重训） | 18 replay/17,054 行 external predictions 按 mode×shipClass 交叉；headB AUPRC/top/AUC/ECE/meanProb/分位 + click/torp/enemy 特征 SMD + event maps | — | **event**：canLaunch 1,209/pos 10、base 0.83%、meanProbB **3.56%**（+2.73pp，ECE 2.73pp）、AUC **0.553**、top **0**、AUPRC 1.357×；**DD**：can 1,006/pos 7、base 0.70%、meanProbB **3.22%**（+2.53pp，ECE 2.53pp）、AUC 0.623、top 1.423、AUPRC 1.565×；event\|DD AUC **0.349**/meanProb 4.01% vs base 0.47%；对照 pve meanProb 2.34%/ECE 0.90pp/AUC 0.630、coop 2.84%/1.09pp/0.740、pvp 2.50%/1.47pp/0.810 → **过预测/先验漂移 + 区分弱双因素**（非单纯标签噪声/样本量；但 event launched 10/29 fired/0 hits，headC 不可评）；不重训不调线不部署 |
| E26e-ad | 训练语料内 event/DD 基线 vs 外部（不重训） | E26e-g OOF 3,111,384 行/2,215 replay + full 4 shard dataset（gameMode）+ r120 outcome（fired/hits），按 mode/class 报 headB/headC，与 E26e-ac 外部对照 | — | **in-dist event/DD 不弱**：event can 7,242/pos 118、base 1.63%、AUPRC **3.071×**/top 2.963/AUC **0.741**/ECE 2.25pp；DD can 466,730/pos 10,949、base 2.35%、**2.033×**/2.401/0.670/ECE 2.49pp；event\|DD 1,208/35、**2.497×**/1.997/0.589；headC overall 2.1997、DD 2.084、event 1.756*（118/358/59） | **in-dist event/DD 有明显 headB 信号，外部弱（event AUC 0.553、event\|DD 0.349）是外部/地图/版本分布漂移，非模型固有**；全局过预测（in-dist ECE 2.46pp、meanProb 2.5× base）是模型级校准偏移；不重训不调线不部署 |
| E26e-ae | 交付温度（T4 T_B/T_C）外部校准评估（不重训） | eval-only 新增 `--eval-temp-b/--eval-temp-c`（prob=sigmoid(logit/T)，T4 ONNX parity；默认 raw 不变）；同一 external 17,054 行+T4 checkpoint 跑 raw/baked T（T_B=0.7564、T_C=1.0723） | — | **headB baked 明显改善**：ECE **1.68pp→0.24pp**、Brier **1.236%→1.206%**、logloss **7.15%→6.55%**、meanProbB 2.90%→0.98%（base 1.22%，raw 过预测 +1.68pp → baked 轻微低估 −0.24pp）；**headC 混合**：ECE 6.94pp→5.81pp 但 Brier 11.84%→11.93%、logloss 38.26%→38.65%、meanProbC 18.03%→19.30%（base 13.51%，37 行）；headA 不变；**排序完全不变**（argsort/Spearman=1/AUPRC/top/AUC/lift/CI 全等）→ 外部 headB 门禁仍 FAIL（1.862×），部署仍 T4 r120；不重训不调线不部署 |
| E26e-af | 外部 vs in-dist 特征漂移归因（不重训） | external 17,054 行 vs in-dist 采样 362,109/3.11M（非 pvp 全收 + pvp 1/10）；同一 torp3 44 维特征做 SMD + logistic domain classifier（80/20，3 seeds） | — | **domain AUC 0.99–1.00**（overall .990、event .997、DD .991、event\|DD 1.000、pvp 1.000）；event top 漂移 = ownEnginePower（0.24 vs −1.0，SMD 1.87）/ cls_unknown（60% vs 0，1.73）/ torp_speed（−1.63）/torp_detect/−damage/ownEngineDir/zones；DD = ownEnginePower/HP/reload/zones；event\|DD = ally radar/hydro 可用性（SMD 4.0）+ smoke/HP；外部 unknown 19.9%（event 59.9%）、event 模式内四图首见（46/17/35 其他模式可见，仅 e15 全语料未见） → **强协变量漂移（未知船级/新地图/遥测可用性差异+目标几何）**，不重训不调线不部署 |
| E26e-ag | matched-domain 外部子集 + 条件化预注册（不重训） | in-dist 4 shard 收集 seen maps/classes/modes/versions；external 标记 matched_mapclass（known class + seen map）/matched_strict（+mode/version seen）/unmatched，重算 headB/headC 对照 full/in-dist | — | **matched 不恢复**：matched_mapclass 9,333 行/can 1,844/19 正 → **1.405×base**/top 1.049/AUC 0.606/ECE 2.229pp；matched_strict 7,263/832/8 → **1.365×**/top **0**/AUC .589/ECE 2.803pp；**unmatched_novelty 7,721（pve s09_LePVE 4,323+unknown e15 3,398）反而 3.558×**/top 3.863；matched 内 event 1,357×/top 0/AUC .553 拖累，pvp 5.342×/coop 3.439× 但仅 3/6 正；headC matched 19/57/7 lift 0、strict 8/26/0 不可评 | primary **未达 ≥2.0×** → **FAIL 不是 unknown/unseen-map novelty，而是 event 模式特异域漂移**（matched 内 event 仍 1.357×）；已写 mode/version 条件化方案（只设计不执行）；不重训/不调线/不部署 |
| T4 | torp4 诊断包交付（A） | final-fit 3 头 torp4（49 维）+ 温度烤图 fp32 ONNX + tracked parity fixture | ✅ | fp32 **502,518 B** sha `0b1f4efd…`；T_B **0.7564** / T_C **1.0723**（E26e-g OOF）；torch-vs-ORT 1,000 行 maxΔ 7.2e-6/2.9e-6/3.8e-6；fixture **48 行** 109,365 B（boundary 覆盖 + clickContext/attrs 复算块），fixture-vs-ONNX 1.43e-6；**诊断-only，不进总分** |
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

### E26e-f · torp3 属性特征 + λ_C=0.1（**MIXED**：headB 恢复并超过 E26e-b，headC 差 2.30 线 0.067）

- **问题（预注册 `out/torpedo_model/e26e-f-preregistration.md`，先落盘后跑）**：E26e-e λ_C=0.1
  已把 headB 恢复到 0.036015（2.222×base）/top-lift 2.610/AUC 0.7043、headC 2.2518×，但 headB
  AUPRC 仍差 0.0365 线 1.3%。本任务在 torp2 的 11 维派生特征后**追加 6 维 hull 鱼雷属性**
  （torp3）：`torpSpeed/70`、`torpDamage/50000`、`torpDetect/3`、`torpCount/10`、`torpDeep`（0/1）、
  **最近射程内敌舰 ETA = distM/(torpSpeed·0.5144)/60 frac，clamp [0,1]**（无则 0）；global 38→**44**；
  λ_C=0.1 预先固定。主验收：(a) headB AUPRC ≥0.0365 且 top-lift ≥2.55；(b) headC outcome
  lift ≥2.30 且 ρ≥0.30/CI 排除 0。
- **实现**：`--feature-set torp3`（torp2 + 6 属性维，列序契约在 `TORP3_NAMES`）；`--ship-attrs`
  默认 `scripts/experiments/ship_attributes.json`（1,162 艘 hull，658 艘 torpSpeed>0；缺文件/缺键/
  缺 shipId → 0，不报错）；loader 记录 `attribute_coverage` 到 metrics；`--head-c-weight 0.1`
  沿用 E26e-e 权重参数（默认 1.0 路径与 E26e-c 逐位兼容）；`--selftest` 覆盖 44 维/列序/
  缺表兜底/ETA 公式/hull 缺失零值；6k CPU smoke 通过。
- **实际覆盖**：语料 3,111,384 行 / 2,215 局中 **294 个 unique hull 全部命中属性表（100%）**；
  `torpSpeed>0` 的行 3,009,235（**96.72%**）。属性表来自 GameParams 15.10.0，语料以
  15.9 为主并含 14.5/15.8，旧局按 15.10 表近似（与既有 torpRange/torpReload 同口径）；
  294/294 hull 有记录但 288/294 有鱼雷属性，6 艘旧 E24 表即缺鱼雷段的 hull（Shimakaze
  98,336 行等，共 102,149 行/3.28%）走零兜底，非本 PR 引入。
- **主配置结果（λ_C=0.1，torp3，5 折 GroupKFold seed 0，训练 232.8 s）**：

  | 指标 | torp3（本任务） | E26e-e λ0.1（torp2） | E26e-b（headB-only） | 预注册线 |
  |---|---|---|---|---|
  | headB AUPRC | **0.039022 = 2.408×base** | 0.036015 = 2.222× | 0.037051 = 2.286× | ≥0.0365 ✓ |
  | headB top-decile lift | **2.789** | 2.610 | 2.662 | ≥2.55 ✓ |
  | headB AUC | **0.7141** | 0.7043 | 0.7084 | — |
  | headC outcome lift（fish-level） | **2.2329** | 2.2518 | 1.2234 | ≥2.30 ✗ |
  | headC ρ / CI | 1.000 / [2.040,2.413] | 1.000 / [2.074,2.453] | 0.952 / [1.079,1.392] | ρ≥0.30 ✓ |

  → **(a) PASS**（AUPRC 0.039022 ≥0.0365、top-lift 2.789 ≥2.55，且已超过 E26e-b 的
  0.037051/2.662/0.7084）；**(b) FAIL**（outcome lift 2.2329 < 2.30，差 0.067；ρ=1.0、CI
  [2.040,2.413] 排除 0）→ **MIXED**。torp3 把 headB 恢复到**超过 E26e-b**，但 headC 的
  outcome 排序几乎没有增益（2.233 vs 2.252，反而略降）。
- **headC OOF（launched 行）**：AUPRC **0.263584**（E26e-e λ0.1 0.25760）、AUC **0.718775**、
  logloss 0.346566、Brier 0.104216、ECE **0.011704**；行级 top-decile lift 2.3579。
- **outcome 十分位命中率**：18.23/12.54/10.50/9.76/8.30/6.83/6.12/3.85/1.70/0.56%（top-bottom
  17.67pp）。**按类** lift/ρ：BB 996 行 **3.369**/0.914；CL 5,009 行 **2.204**/0.927；DD 10,949 行
  **2.133**/1.000；SS 101 行 0.670/0.085（样本不足仅描述）。**按 region**：apac **2.384**/0.988、
  eu **2.062**/0.964、na **2.233**/0.952、own **1.918**/0.927。
- **headB 按类 AUPRC**：DD 0.0444（1.83M 行）、CL/CA 0.0280、BB 0.0234、SS 0.0525（3,003 can 行上；launched 101）——
  全部高于 E26e-e λ0.1 的对应值（DD 0.0395/CL 0.0246/BB 0.0210/SS 0.0443）。
- **类别温度校准（secondary）**：headB global **T=0.7575**（≈E26e-b 的 0.7581）：logloss
  0.08977→**0.07913**、Brier 0.016383→0.015811、ECE 0.02463→**0.00057**；headC global
  **T=1.0703**：logloss 0.346566→0.345809、ECE 0.011704→**0.005303**。
- **判定（预注册）**：**(a) PASS、(b) FAIL → MIXED**。结论：torp3 属性特征对 **headB 强烈
  有效**（AUPRC +8.3%、top-lift +6.8%、AUC +0.010 vs torp2 λ0.1；并超过 headB-only 的 E26e-b），
  但对 **headC outcome 排序无增益**——命中概率更多由目标几何/交战状态决定，而非 hull 的
  鱼雷属性；下一步应转向 click-level 序列/管位/DoT 几何与端上概率分级。
- **局限**：属性表来自 GameParams 15.10.0（版本敏感；294/294 hull 有记录、288/294 有
  torpSpeed，6 艘旧 E24 表缺口 hull 走零兜底）；
  6 维属性中的 ETA 用“当前射程内最近敌舰”近似（未含提前量/机动）；headC outcome 仍为代理
  命中（120 units + HP drop）；SS 101 行、na/own 样本薄；λ_C=0.1 固定未再扫；未做端上部署。
- **产物**：`out/torpedo_model/e26e-f/{e26e_f_oof.npz（38.9MB）, e26e_f_metrics.json,
  e26e_f_train.log, outcome_lift_C.json}`；node3 `/mnt/work/wowsp-kots/e26e-f/{code,run}`（含
  ship_attributes.json）；预注册 `e26e-f-preregistration.md`（脚本 sha `226008dc…`、属性表 sha
  `2bbd3831…`，与 node3 实跑一致）。
### E26e-g · torp4 click-context 特征（**MIXED**：headB 再提升到 2.599×base，headC outcome 2.200 仍差 2.30 线 0.10）

- **问题（预注册 `out/torpedo_model/e26e-g-preregistration.md`，先落盘后跑）**：E26e-f torp3 把
  headB 推到 0.039022（2.408×base）/top-lift 2.789/AUC 0.7141，但 headC outcome lift 2.2329
  距 2.30 线 0.067。本任务加 **5 维 click-context**（torp4）：`lastClickAgeS/60`（无 click→1；
  sidecar 的 -1 哨兵按无 click 处理，clamp [0,1]）、`clicks30s/8`、`fish30s/16`、
  `lastClickFish/10`、`totalClicks/50`；global 44→**49**。λ_C=0.1 预先固定。
- **主验收**：(a) headC outcome lift **≥2.30** 且 ρ≥0.30/CI 排除 0；(b) headB 非退化
  **AUPRC ≥0.039022 且 top-lift ≥2.789**（1% 容忍线 0.038632/2.761 仅报告）。
- **实现**：`--click-context` 4 sidecar（与 --data 同序 apac,eu,na,own）+ `--feature-set torp4`；
  `ClickContextReader` 与数据分片**逐行 lockstep**消费，校验 replayId / t(±1e-3) / shipId，
  行数必须相等；错位/多余行/EOF 提前均在**加载结束时立即 abort（训练前）**；字段名容忍 `torpLastClickAgeS` 与 `lastClickAgeS`
  等别名；metrics 记录 `click_coverage`（noClickRows/missingFields/mismatch）；`--selftest` 覆盖
  49 维/列序/torp3 列不变/缺 sidecar 兜底/别名/-1 哨兵/misaligned sidecar abort；本地真实 sidecar
  smoke（own）通过。
- **sidecar（task-39 导出，Lead 验收）**：4 分片行数 1,021,498 / 1,432,164 / 486,859 / 170,863 =
  3,111,384，与 dataset 完全一致；本任务 join：**mismatch replay/t/ship = 0/0/0、missingFields 0**；
  **no-click 行 1,138,443（36.6%）**、有 click 行 1,972,941。
- **主配置结果（λ_C=0.1，torp4，5 折 seed 0，训练 232.4s）**：

  | 指标 | torp4（本任务） | torp3（E26e-f） | 预注册线 |
  |---|---|---|---|
  | headB AUPRC | **0.042126 = 2.599×base** | 0.039022 = 2.408× | ≥0.039022 ✓（非退化） |
  | headB top-decile lift | **2.905** | 2.789 | ≥2.789 ✓ |
  | headB AUC | **0.7273** | 0.7141 | — |
  | headC outcome lift（fish-level） | **2.1997** | 2.2329 | ≥2.30 ✗ |
  | headC ρ / 95% CI | 0.988 / [1.998,2.378] | 1.000 / [2.040,2.413] | ρ≥0.30 ✓ |

  → **(a) FAIL**（2.1997 < 2.30，且低于 torp3 的 2.2329）、**(b) PASS**（headB 全面再提升）→
  **MIXED**。click-context 与 hull 属性一样**强力提升 headB**（AUPRC +0.0031/+7.9%、top-lift
  +0.116、AUC +0.013 vs torp3），但对 **headC outcome 排序无增益甚至略降**。
- **headC OOF（launched 行）**：AUPRC **0.265641**、AUC **0.720822**、logloss 0.346055、
  Brier 0.104064、ECE **0.012667**、行级 top-lift 2.3716。**十分位命中率**：17.96/13.29/10.52/
  8.83/8.87/6.67/5.87/4.13/1.38/0.62%（top-bottom 17.34pp）。
- **按类** outcome lift/ρ：BB 996 行 **3.241**/0.960；CL 5,009 行 **2.221**/0.976；DD 10,949 行
  **2.084**/0.952；SS 101 行 1.340/0.309（仅描述）。**按 region**：apac **2.452**/0.964、
  eu **1.961**/0.988、na **2.066**/0.952、own **2.181**/0.903。
- **headB 按类 AUPRC**：DD 0.0477、CL/CA 0.0306、BB 0.0268、SS 0.0593（均高于 torp3 的
  0.0444/0.0280/0.0234/0.0525）。
- **类别温度校准（secondary）**：headB global **T=0.7564**：logloss 0.08934→**0.07866**、
  Brier 0.016352→0.015791、ECE 0.02457→**0.00064**；headC global **T=1.0723**：logloss
  0.346055→0.345252、ECE 0.012667→**0.004089**。
- **判定（预注册）**：**(a) FAIL、(b) PASS → MIXED**。结论：click-context（发射时机/频率）
  是**发射行为**的好信号（headB 2.599×base 已远超 E26e-b 的 2.286×），但对**命中结果**没有
  额外信息——headC 连续两轮（torp3/torp4）停在 2.20–2.23×，且 CI 互相重叠；这**提示**代理
  命中标签接近上限，但该上限仍是假设、本轮不能写成定论；下一步应转向端上概率分级、管位/
  DoT 几何或结果标签（shotKills join），而不是继续堆静态特征。
- **局限**：click 特征粗糙（仅点击时刻/30s 计数/鱼数，未含目标/距离/管位）；`lastClickAge`
  归一化后无 click（-1）与 ≥60s 都落到 1.0，只能靠 clicks/total 计数区分；sidecar 每行按导出
  顺序 lockstep，依赖导出与 dataset 同序（行数已精确一致）；代理命中（120 units + HP drop，
  非 server 真值）；SS 101 行、na/own 样本薄；λ_C=0.1 固定未再扫；未做端上部署。
- **产物**：`out/torpedo_model/e26e-g/{e26e_g_oof.npz（38.8MB）, e26e_g_metrics.json,
  e26e_g_train.log, outcome_lift_C.json}`；node3 `/mnt/work/wowsp-kots/e26e-g/{code,run,click}`；
  预注册 `e26e-g-preregistration.md`（脚本 sha `280815fa…`，为工作树 CRLF 字节；提交后 LF
  归一化会变 raw sha，复核时按该行尾约定）。
### E26e-h · headC 训练目标对齐 fish-level（**严格预注册 MIXED**：primary fish_weighted FAIL；secondary fish_rate 点估计过线但 headB strict AUPRC 低 0.00004，仅 1% 容忍内）

- **动机（预注册 `out/torpedo_model/e26e-h-preregistration.md`，先落盘后跑）**：headC 用 **row-level**
  any-hit BCE（20 条鱼的 salvo 与 1 条鱼同权），而 outcome-lift 评估是 **fish-level**（按
  firedFish 加权）。E26e-g（torp4，λ_C=0.1）headC outcome lift 2.1997 可能因口径错位被低估。
- **实现**：`--head-c-target any|fish_rate|fish_weighted`（默认 any 与 E26e-g **逐位兼容**，
  loss_c 表达式不变）：
  - `fish_rate`：labelC = torpHits/torpFiredFish（0–1 soft target），launched 行 BCE（soft target）；
  - `fish_weighted`：labelC = any-hit 二值，BCE 逐行权重 = **clamp(torpFiredFish, 1, 20)**；
    全语料 launched 行权重均值 **4.204**、最大 15，**无行触发上限 clamp**（上限 20 未生效）；
  - labelC 落盘仍是 any-hit 二值（评估口径），target/权重统计写入 protocol/metrics/npz meta；
    `--head-c-only` 路径同样适用；`--selftest` 覆盖默认兼容/软标签范围/权重 clamp/缺 firedFish/NaN
    兜底；本地三模式 smoke（torp4+click+λ0.1）通过。
- **数据/训练**：torp4（49 维）+ λ_C=0.1，5 折 GroupKFold seed 0，12 epochs / hidden 192 /
  batch 4096 / lr 1e-3 / smoothing 0.05 / float16 / cuda；两次训练各 233.3 / 231.0 s；
  join 与 E26e-g 相同（click 4 分片 3,111,384 行、outcome 100%）。
- **结果对照**：

  | headC target | headC outcome lift | ρ / 95% CI | headC OOF AUPRC / AUC / ECE | headB AUPRC (×base) | headB top-lift |
  |---|---|---|---|---|---|
  | any（E26e-g 参照） | 2.1997 | 0.988 / [1.998,2.378] | 0.26564 / 0.72082 / 0.01267 | 0.042126 (2.599×) | 2.905 |
  | **fish_weighted（primary）** | **2.1981** | 0.988 / [2.029,2.396] | 0.26108 / 0.71633 / **0.00755** | 0.041189 (2.541×) | 2.862 |
  | **fish_rate（secondary）** | **2.3069** | 0.988 / **[2.099,2.496]** | 0.25463 / 0.70518 / **0.05724** | 0.042086 (2.597×) | 2.912 |

  → **(a)**：fish_rate **PASS**（2.3069 ≥2.30，ρ 0.988 ≥0.30，CI 排除 0）；fish_weighted **FAIL**
  （2.1981 <2.30）。**(b) 非退化**：fish_rate 与 E26e-g 差距 **−0.095% AUPRC**/+0.007 top-lift，在 1%
  容忍内（strict AUPRC 略低）；fish_weighted AUPRC **−2.2%**，超出容忍 → FAIL。
  → 按预注册规则“**任一目标过 (a) 且 headB 不退化 → PASS**”，判定 **PASS（由 secondary fish_rate
  达成；主配置 fish_weighted 未过）**，但需注明：fish_rate 仅以 **+0.0069** 越过 2.30 线，CI 下界
  2.099 < 2.30，属**边际**通过。
- **fish_rate 明细**：十分位命中率 18.84/13.39/9.57/9.58/7.42/7.20/6.07/5.47/1.27/0.48%；
  **按类** lift/ρ：BB 996 行 **3.137**/0.912；CL 5,009 行 **2.091**/0.964；DD 10,949 行
  **2.239**/0.988；SS 101 行 1.104/−0.018（仅描述）。**按 region**：apac **2.432**/1.000、
  eu **2.016**/1.000、na **2.690**/0.988、own **2.223**/0.879。
- **fish_rate 的代价（重要）**：soft 标签使输出概率**明显偏移**（原始 headC **ECE 0.0572**、logloss
  0.37074、Brier 0.10887，均差于 any 的 0.01267/0.34606/0.10406），**温度 T=1.387** 校准后 ECE
  回到 0.0079；headC 排序质量（AUPRC 0.2546/AUC 0.7052）也略低于 any（0.2656/0.7208）——即
  fish_rate 的 lift 提升来自“按鱼数加权的软目标”改变了分数尺度/排序，而非更强的判别力。
- **headB 影响**：fish_weighted 让 headB AUPRC −2.2%（0.042126→0.041189）、top-lift 2.905→2.862，
  超出 1% 非退化容忍；fish_rate 几乎不变（0.042086/2.912）。
- **类别温度校准（secondary）**：headB T=0.7551（logloss 0.08953→0.07870、ECE 0.02480→0.00064）；
  headC（fish_rate）原始已偏，T=1.3873 后 logloss 0.37074→0.34920、ECE 0.05724→0.00793。
- **判定（严格预注册）**：**MIXED**。fish_weighted（primary）(a) 2.1981<2.30 FAIL 且 headB −2.2%
  超容忍；fish_rate（secondary）(a) 点估计 2.3069≥2.30、ρ/CI 过，但 (b) **strict** headB AUPRC
  0.042086 <0.042126（差 0.00004）、top 2.912≥2.905——只在 1% 容忍内；预注册写“1% 容忍线仅报告”，
  故按字面严格读法整体 **MIXED**。若把 1% 容忍当作非退化，则 fish_rate 可记 PASS（边际），本文
  不以此为主结论。
- **结论**：**row-level any-hit 目标不是 headC 的瓶颈**——把 salvo 按鱼数加权（fish_weighted）没有
  带来任何增益（2.1981），软 per-fish 目标（fish_rate）只换来边际 +0.107（且 strict headB 微降、原始
  ECE 0.057 需温度校准）；headC 的 2.20–2.31 平台更可能来自**代理命中标签本身的信息上限**，而非
  训练口径。
- **局限**：fish_rate 边际过线（CI 下界 2.099）；fish_weighted 的 1–20 clamp 在本语料从未生效；
  软标签导致概率尺度偏移（部署需温度校准）；单 seed/单次训练，per-class SS 101 行、na/own 样本薄；
  代理命中（120 units + HP drop，非 server 真值）；未做端上部署。
- **下一步**：转向**结果标签**（shotKills join/真实命中事件）与**端上概率分级**（温度后处理）；
  若坚持 fish 口径，可用 fish_rate + 端上温度 T=1.39 作为概率输出，但排序仍用 any 目标更稳。
- **产物**：`out/torpedo_model/e26e-h/{e26e_h_fish_weighted_oof.npz, e26e_h_fish_weighted_metrics.json,
  e26e_h_fish_rate_oof.npz, e26e_h_fish_rate_metrics.json, e26e_h_fish_*.log,
  outcome_lift_fish_weighted.json, outcome_lift_fish_rate.json}`；node3
  `/mnt/work/wowsp-kots/e26e-h/{code,run}`；预注册 `e26e-h-preregistration.md`（脚本 sha
  `79d7435c…`，与 node3 实跑一致）。
### E26e-i · headC 两模型 OOF 融合（**MIXED**：ensemble 2.2475× 未过 2.30；rank-average 2.2540）

- **动机（预注册 `out/torpedo_model/e26e-i-preregistration.md`，先落盘后评估）**：headC 已有两个
  单模型 OOF：E26e-g any-target（torp4，λ_C=0.1）outcome lift **2.1997**、T=1.0723；E26e-h
  fish_rate（软 per-fish 目标）**2.3069**、T=1.3873。两者同 3,111,384 行/同 5 折/同 sidecars，
  headB 不变。问题：**融合两模型能否稳健过 2.30**。
- **方法（主分数，预注册）**：mean calibrated probability（仅 launched 行）：
  `p_any_cal = sigmoid(logit(clip(p_any,1e-6,1-1e-6))/1.0723)`、
  `p_rate_cal = sigmoid(logit(clip(p_rate,1e-6,1-1e-6))/1.3873)`、
  `probC_ens = (p_any_cal + p_rate_cal)/2`；非 launched 行 NaN。
- **实现**：新增 `scripts/experiments/torpedo_headc_ensemble.py`（numpy-only）：加载两 npz、
  逐项校验 rowIndex/fold/groupCode/shipId（精确）与 labelB/labelC/t（NaN-aware 1e-9）、
  groupNames/classNames/regionNames，任一不匹配 abort；写 ensemble npz（probC=ensemble，
  其余数组/元数据沿用 A，meta 记录 T/来源/sha256/spearman）与 rank-average npz（secondary）；
  `--selftest` 覆盖对齐/错位 abort、概率 clip/温度边界、rank 分位契约、确定性、npz round-trip。
- **对齐**：3,111,384 行 / 17,055 launched；两源 calibrated 概率 Spearman = **0.9157**；
  mean p_cal：A 0.131010、B 0.124764、ensemble 0.127887；ensemble 范围 [0.000517, 0.702406]。
- **结果（launched 行，fish-level，同 sidecar/outcome_lift 代码）**：

  | 分数 | top-decile 命中率 lift | 十分位 ρ | bootstrap 95% CI | 判定 |
  |---|---|---|---|---|
  | A：E26e-g any-target | 2.1997× | 0.988 | [1.998, 2.378] | MIXED |
  | B：E26e-h fish_rate | **2.3069×** | 0.988 | [2.099, 2.496] | PASS |
  | **ensemble（primary）** | **2.2475×** | 0.988 | **[2.045, 2.438]** | **MIXED**（<2.30 ✗） |
  | rank-average（secondary） | 2.2540× | 1.000 | [2.049, 2.441] | MIXED |

  **判定：primary MIXED**（2.2475 < 2.30；ρ 0.988 ≥0.30、CI 排除 0 均满足）。rank-average 也
  未过线（2.2540），仅作 secondary 报告。
- **ensemble 明细**：十分位命中率 18.35/13.07/10.81/8.54/8.87/6.51/6.27/4.22/1.47/0.43%；
  **按类** lift/ρ：BB 996 行 **2.863**/0.960；CL 5,009 行 **2.266**/0.988；DD 10,949 行
  **2.166**/1.000；SS 101 行 0.975/0.006（仅描述）。**按 region**：apac **2.473**/0.988、
  eu **1.936**/0.988、na **2.261**/0.939、own **2.162**/0.976。
- **结论**：两 headC 虽由不同训练目标得到，但**排序高度相关**（calibrated Spearman 0.916），
  融合只能落在两者之间（2.2475），无法把 fish_rate 的 2.3069 尖峰变成稳健的 ≥2.30；rank-average
  同理（2.2540）。mean-probability 融合还会被 any-target 的分数尺度稀释。**融合不是提升 headC
  的路径**；若要稳健过 2.30，需要**独立信息源**（不同特征/不同 seed 且相关性更低、结果标签
  shotKills、端上校准/分级），而不是同数据同标签家族的两个头。
- **局限**：同数据 OOF 融合（非独立留出/跨季，不能当泛化证明）；温度直接取两源 OOF（未重拟合）；
  headC 是“已发射条件命中概率”，融合只影响排序；未做权重扫描（预注册禁止事后调权）；
  SS 101 行、na/own 样本薄；未做端上部署。
- **产物**：`out/torpedo_model/e26e-i/{e26e_i_ensemble_oof.npz（27.5MB）, e26e_i_rank_oof.npz（27.5MB）, e26e_i_ensemble_metrics.json, outcome_lift_{ensemble,rank,sourceA,sourceB}.json}`；
  预注册 `e26e-i-preregistration.md`（脚本 sha `e871051f…`）。
### E26e-j · 鱼雷命中标签定义敏感性（**PASS**：固定 any headC 在 r60 严格标签上 2.6811× 过 2.30；标签定义是 plateau 的重要因素）

- **假设（预注册 `out/torpedo_model/e26e-j-preregistration.md`，先落盘后评估）**：headC 的 outcome
  lift 平台（E26e-g 2.1997 / E26e-h fish_rate 2.3069）可能由**命中标签定义**造成。E26e-b 口径 =
  “鱼雷终点距敌舰 hull ≤ **120 units** 且 ±0.4/0.6 s 窗口内覆盖敌舰 HP drop”。本轮固定**已训练**
  的 E26e-g any / E26e-h fish_rate OOF（**不重训**），在 4 个标签变体上重算 outcome lift。
- **标签变体（Lead 导出，schema 同 E26e-b，4 分片各 3,111,384 行）**：

  | variant | radius (units) | require HP drop | 说明 |
  |---|---|---|---|
  | **r60** | 60 | true | 严格；排除 60–120u 的邻近终点/擦边（主验收） |
  | r120 | 120 | true | E26e-b 基线口径（sidecar 与 E26e-b **sha256 完全一致**） |
  | r200 | 200 | true | 更宽松半径 |
  | nohp120 | 120 | **false** | 由 r120 确定性派生：`torpHits := r120 torpTerminalNear`（无 HP 要求） |

  sanity：r120 与 E26e-b 原 sidecar 4 分片逐字节相同（apac sha256 `6339df4c…`）；nohp120 派生已
  逐行校验 `torpHits == r120.torpTerminalNear` 且 replayId/t/shipId/torpFiredFish 一致，**3,111,384
  行 0 mismatch**（apac/eu/na/own）。
- **方法与门禁**：两 OOF 固定、同 `torpedo_outcome_lift.py --prob-key C --min-lift 2.3 --bootstrap 1000
  --seed 0` 协议；主验收 = any-target **r60** top-decile fish 命中 lift ≥2.30 且 ρ≥0.30 且 CI 排除 0；
  其余变体/secondary 仅描述，不调模型/阈值、不重训、不选最佳组合。
- **结果（launched 17,055 行 / fired 71,693 fish；lift 均为 fish-level）**：

  | variant | base hitRate（hits/71,693） | any headC lift / ρ / 95% CI | fish_rate headC lift / ρ / 95% CI |
  |---|---|---|---|
  | **r60** | **4.773%**（3,422） | **2.6811×** / 0.988 / **[2.438, 2.930]** ✓ | **2.8390×** / 1.000 / [2.561, 3.090] |
  | r120 | 8.165%（5,854） | 2.1997× / 0.988 / [1.998, 2.378] | 2.3069× / 0.988 / [2.099, 2.496] |
  | r200 | 12.510%（8,969） | 1.8485× / 1.000 / [1.708, 1.990] | 1.9534× / 0.988 / [1.801, 2.098] |
  | nohp120 | **56.810%**（40,729） | 1.1878× / 0.964 / [1.147, 1.233] | 1.2297× / 0.988 / [1.186, 1.274] |

  → **主验收 PASS**：any headC 在 **r60** 上 lift **2.6811 ≥ 2.30**、ρ 0.988 ≥0.30、CI [2.438,2.930]
  排除 0；fish_rate 在 r60 更高（2.8390）。**标签半径越严格 lift 越高（r60 2.681 > r120 2.200 >
  r200 1.848），而 noHP（最宽松、把 56.8% 的鱼算作命中）崩到 1.19–1.23**——说明 E26e-g/h 的 2.20–2.31
  平台**至少部分是标签定义造成的**：模型对“干净、有伤害确认的严格命中”排序强得多，而 120/200u 半径
  里混入擦边/未伤目标，无法被区分反而稀释 lift。
- **r60 明细（any）**：十分位命中率 12.80/8.04/6.36/4.67/4.83/3.48/3.01/1.72/0.46/0.14%；
  **按类** lift/ρ：BB 996 行 **5.021**/0.976；CL 5,009 行 **2.827**/0.988；DD 10,949 行
  **2.514**/0.964；SS 101 行 1.575/0.195（仅描述）。**按 region**：apac 5,489 行 **2.990**/0.988、
  eu 7,937 行 **2.365**/0.988、na 2,672 行 **2.843**/0.952、own 957 行 **2.222**/0.903。
  fish_rate r60 按类：BB 4.948、CL 2.670、DD 2.663、SS 1.297；按 region：apac 2.993、eu 2.443、
  na 3.322、own 2.321。
- **解释与注意**：（1）不同变体的 base hitRate 不同（4.77% vs 8.17% vs 12.5% vs 56.8%），lift 是
  相对各自 base 的排序指标，不能直接跨变体说“效果提升 X%”；（2）模型只在 r120 标签上训练过，r60
  评估说明它的排序对严格命中更有效——**若用 r60 标签重训，预期收益值得另立预注册验证**（本任务
  按预注册**不重训**）；（3）noHP 变体把“发射后终点靠近”都算命中（56.8%），信噪比过低，不适合
  作为评估口径。
- **判定**：**主验收 PASS**（any@r60）。结论：**标签半径/HP 确认是 headC outcome 平台的重要因素**，
  不是“模型已到上限”的唯一解释；下一步（另立预注册）：用 **r60 标签重训 headC**（同架构/λ_C=0.1），
  并与 r120 训练对照；同时保留 r120 作为部署/评估口径的兼容基线。
- **局限**：同数据（3,111,384 行/2215 局）同 OOF 的事后标签敏感性分析，非独立留出/跨季泛化证明；
  r60/200/noHP 变体未重训；r60 正例少（3,422 fish，行级更少），SS 101 行/na/own 样本薄；命中仍是
  代理（终点 + HP drop），不是 server 真值；nohp120 为确定性派生（已逐行验证）。
- **产物**：`out/torpedo_model/e26e-j/{e26e_j_summary.json, outcome_lift_any_{r60,r120,r200,nohp120}.json,
  outcome_lift_rate_{r60,r120,r200,nohp120}.json}`；sidecars 在
  `out/torpedo_model/e26e-j/{r60,r120,r200,nohp120}/outcome_*.jsonl`；预注册 `e26e-j-preregistration.md`。
### E26e-k · r60 严格标签重训 headC（**MIXED**：重训 r60 lift 2.6329 < 2.68；r60 收益是跨标签排序现象，未转化为重训收益）

- **问题（预注册 `out/torpedo_model/e26e-k-preregistration.md`，先落盘后训练）**：E26e-j 发现固定
  E26e-g any headC 在 **r60**（半径 60u + HP-drop 确认）标签上 outcome lift **2.6811**（r120 2.1997），
  标签定义是 headC 平台的重要因素。本任务回答：**把 r60 标签用于重训 headC**，能否变成真正的
  模型收益。
- **配置/口径**：torp4（49 维）+ 3 头；λ_C=0.1；**headC 标签 = r60 sidecar 的 `torpHits>0`**
  （launched 行；headA/headB 标签不变）；5 折 GroupKFold seed 0；hidden192/12epochs/batch4096/
  lr1e-3/smoothing0.05/float16/cuda；训练 235.4 s；r60 sidecar 经 gzip→scp→node3 落盘（4 分片
  3,111,384 行，join 100%）。**未改代码**（`--outcome` 直接吃 r60 sidecar；脚本 sha `ed18447a…`）。
- **主验收**：重训 headC 在 **r60** 标签上 lift **≥2.68**（对标 E26e-j 固定模型 2.6811）且 ρ≥0.30、
  CI 排除 0；稳健性附加要求 **CI 下界 >2.30**。**非退化**：headB OOF AUPRC ≥0.042126 且 top-lift
  ≥2.905（1% 容忍线 0.041705/2.876 仅报告）。
- **结果**：

  | 评估 | lift / ρ / 95% CI | 对照 |
  |---|---|---|
  | **r60 重训（primary）** | **2.6329× / 1.000 / [2.374, 2.883]** | E26e-j 固定 any@r60 **2.6811**（点估计低 0.048） |
  | r120 cross-eval（secondary） | 2.0844× / 1.000 / [1.892, 2.271] | E26e-g 2.1997 / E26e-b headB-only 1.2234 |
  | headB OOF（非退化） | **AUPRC 0.042302（2.610×base）**、top-lift **2.9434**、AUC 0.7274 | E26e-g 0.042126/2.905（**不退化，略升**） |

  → **主验收 FAIL**（2.6329 < 2.68；ρ 1.0、CI 排除 0、CI 下界 2.374 >2.30 均满足）→ **MIXED**。
  headB 非退化通过（AUPRC +0.4%、top-lift +1.3% vs E26e-g）。
- **headC OOF（r60 标签，launched 17,055 行）**：base rate **0.087599**（r60 行级 any-hit 1,494 行 vs
  r120 的 2,192 行，少 698 行）；AUPRC **0.2180**、AUC **0.7388**（高于 E26e-g 的 0.7208）、logloss
  0.2646、Brier 0.07462、ECE **0.01108**；行级 top-decile lift 2.7368；类别温度 **T=1.0542**
  （logloss 0.26463→0.26417、ECE 0.01108→0.00608）。注意 AUC 升而 lift 降：重训模型对 r60 全体
  排序更好（AUC），但最可能命中的 top-decile 精确率略低。
- **r60 评估明细（重训模型）**：十分位命中率 12.57/7.35/6.08/5.54/4.07/3.94/2.94/2.11/0.53/0.22%；
  **按类** lift/ρ：BB 996 行 **4.470**/0.939；CL 5,009 行 **2.891**/0.976；DD 10,949 行
  **2.257**/0.988；SS 101 行 0.434/0.430（仅描述）。**按 region**：apac **2.762**/0.976、
  eu **2.396**/0.976、na **2.667**/0.939、own **1.781**/0.479。
- **结论（按预注册 fallback 表述）**：**r60 的收益是“跨标签排序”现象，未转化为重训收益**——
  用 r60 重训后 r60 lift 2.6329（与固定模型 2.6811 基本持平/略低），而 r120 cross-eval 降到 2.0844
  （E26e-g 2.1997）。原因：r60 只是把 r120 的 5,854 fish 命中收缩为 3,422（少 2,432 条擦边/邻近
  终点），正例更稀疏且训练信号更“硬”，模型在 r60 上的 AUC 提升但没有转化为 top-decile 命中率；
  r120 上学到的排序对 r60 的泛化略好。**标签定义影响评估目标的“干净程度”，而非可学习的额外
  信息**；headC 2.2–2.7 的差异主要来自评估口径，不是重训可兑现的模型能力。
- **局限**：同数据（3,111,384 行 / 2,215 局）同分布重训，非独立留出/跨季泛化证明；r60 正例仅
  3,422 fish（行级 1,494），SS 101 行、na/own 样本薄；命中仍是代理标签（终点 + HP drop），不是
  server 真值；单 seed/单次训练；未做端上部署。
- **下一步**：① 独立验证（新赛季/留出 replay 上比较 r120 训练 vs r60 训练）；② 结果标签（shotKills
  join / server damageStat）替代代理命中；③ 若部署仍用 r120 口径，保留 E26e-g 模型（headB/headC
  指标更均衡）；r60 训练版仅在“严格命中”诊断卡上使用。
- **产物**：`out/torpedo_model/e26e-k/{e26e_k_oof.npz（38.9MB）, e26e_k_metrics.json,
  e26e_k_train.log, outcome_lift_r60.json, outcome_lift_r120.json}`；node3
  `/mnt/work/wowsp-kots/e26e-k/{code,run,outcome_r60}`；预注册 `e26e-k-preregistration.md`
  （脚本 sha `ed18447a…`，与 node3 实跑一致）。
### E26e-l · torp5 目标几何特征（**MIXED**：r120 headC 2.2639× 未过 2.30（但 +0.064 vs torp4）；r60 cross 2.7631 过 2.68）

- **假设（预注册 `out/torpedo_model/e26e-l-preregistration.md`，先落盘后训练）**：E26e-j/k 显示
  headC 平台主要是评估标签差异、重训不能兑现；本任务加入**目标几何特征（torp5）**——鱼雷对目标的
  方位/横距/提前量/拦截时间/相对航向，检验“命中概率”是否可由目标几何解释并转化为 r120 上的
  outcome lift 提升。
- **特征（torp5 = torp4 49 + 5 = global 54）**：`aspectRad/π`、`crossKt/40`、`leadRad/(π/4)`、
  `interceptS/300`（前四 clamp [0,1]）、`yawRelRad/π`（signed，clamp [-1,1]）；sidecar 字段
  `torpGeomAspectRad/CrossKt/LeadRad/InterceptS/YawRelRad/Targets`；**无目标（-1）/缺失 → 0**。
  `--target-geometry` 4 sidecar 与 `--click-context` 4 sidecar 均逐行 lockstep（行数/replayId/t±1e-3/
  shipId），错位/EOF 立即 abort；torp4 及更早 feature-set 行为不变。
- **数据/覆盖**：3,111,384 行 / 2,215 局；click sidecar 100% join（no-click 1,138,443 行）；
  geometry sidecar **100% join**（mismatch replay/t/ship = 0/0/0），**no-target 行 859,733（27.6%）**、
  with-geometry 2,251,651（72.4%），无 missing-target 行。
- **训练**：torp5 + 3 头，λ_C=0.1，5 折 GroupKFold seed 0，hidden192/12epochs/batch4096/lr1e-3/
  smoothing0.05/float16/cuda，**238.3 s**；outcome r120（E26e-b 口径）。
- **结果**：

  | 评估 | torp5（本任务） | torp4（E26e-g） | 预注册线 |
  |---|---|---|---|
  | **headC r120（primary）** | **2.2639× / 0.988 / [2.076, 2.465]** | 2.1997 / 0.988 / [1.998, 2.378] | ≥2.30 ✗ |
  | headC r60（secondary） | **2.7631× / 1.000 / [2.515, 3.053]** | —（E26e-j 固定 2.6811 / E26e-k 重训 2.6329） | ≥2.68 ✓ |
  | headB OOF AUPRC | **0.041865（2.583×base）** | 0.042126（2.599×） | ≥0.042126（strict）✗ / 1% 容忍 0.041705 ✓ |
  | headB top-decile lift | **2.8836** | 2.9053 | ≥2.905（strict）✗ / 1% 容忍 2.876 ✓ |

  → **主验收 FAIL**（2.2639 < 2.30；ρ 0.988、CI 排除 0 满足）→ **MIXED**。headB 严格线未达但
  在 1% 容忍内（AUPRC −0.62%、top-lift −0.74%）。
- **headC OOF（launched 行）**：AUPRC **0.266606**（E26e-g 0.265641）、AUC **0.718110**、logloss
  0.346882、Brier 0.104079、ECE **0.010877**、行级 top-lift 2.3807；温度 **T=1.0724**
  （logloss 0.34688→0.34608、ECE→0.00509）。
- **r120 明细**：十分位命中率 18.49/12.26/9.78/10.02/9.27/6.61/5.57/3.76/1.77/0.63%；**按类**
  lift/ρ：BB 3.099/0.960、CL 2.143/0.964、DD 2.181/1.000、SS 0.536/0.170（101 行仅描述）；
  **按 region**：apac 2.523/0.988、eu 2.006/0.988、na 2.283/0.964、own 2.134/0.867。
  **r60 cross 明细**：BB 4.867/0.963、CL 2.715/0.964、DD 2.590/0.988、SS 0.630/0.212；region
  apac 2.985/0.988、eu 2.430/1.000、na 3.000/0.988、own 2.060/0.973。
- **headB 按类 AUPRC**：DD 0.0476、CL/CA 0.0302、BB 0.0262、SS 0.0584。
- **判定（预注册）**：**MIXED**（primary FAIL、headB 容忍内、r60 secondary PASS）。结论：目标几何
  对 headC 有**边际增益**（r120 2.1997→2.2639，+0.064；r60 2.763 高于 E26e-j 固定 2.681 与
  E26e-k 重训 2.633），但**不足以跨过 r120 的 2.30 线**——目标几何不是 headC 平台的主因；
  r60 下 torp5 首次超过固定模型，说明几何信息对“严格命中”排序有真实贡献，但幅度仍小。
- **局限**：目标航向/横距来自**轨迹近似**（几秒窗口、单目标聚合），非精确弹道；proxy 命中标签
  （120u + HP drop，非 server 真值）；27.6% 行无几何目标（回退 0）；SS 101 行、na/own 样本薄；
  同数据同分布、单 seed；未做端上部署。
- **下一步**：① 若继续几何方向：多目标/逐鱼管位几何 + 精确弹道/DoT，或与“结果标签”结合；
  ② 端上概率分级可复用现有 OOF 温度；③ 若部署，torp4（E26e-g）仍是 r120 口径基准，torp5 可作
  诊断升级候选（r60 诊断卡 2.76×）。
- **产物**：`out/torpedo_model/e26e-l/{e26e_l_oof.npz（37.9MB）, e26e_l_metrics.json,
  e26e_l_train.log, outcome_lift_r120.json, outcome_lift_r60.json}`；node3
  `/mnt/work/wowsp-kots/e26e-l/{code,run,geom}`；预注册 `e26e-l-preregistration.md`（脚本 sha
  `55eb8356…`，与 node3 实跑一致）。
### E26e-m · server damageStat 真值 vs 120u+HP 代理审计（**PASS**：代理 precision 0.798/recall 0.484，server 真值标签下 headC 2.3477× 仍过 2.30）

- **问题（预注册 `out/torpedo_model/e26e-m-preregistration.md`，先落盘后审计）**：E26e-b/E26e-g 的命中
  标签是**代理**（终点距敌舰 ≤120u 且 ±0.4/0.6s 观察到 HP drop）。本任务用录像者专属
  **server damageStat 累计量**（weapon=7 / category=0 = recorder **对敌舰造成**的鱼雷伤害；shared
  stream.rs 明确 category0 = damage dealt，与 Rust fire_dataset 一致）审计：
  ① 代理 `torpHits>0` vs server `delta>0` 的 precision/recall；② 用 server 真值重建 sidecar 后，
  固定 E26e-g any headC OOF 的 outcome lift 是否仍 ≥2.30（“真值下仍成立”）。
- **真值契约**：每 replay 取 `recorderEntityId`；只对 `ownerEntityId == recorderEntityId` 的 launched 行
  （`labelB=true & torpFiredFish>0`）计算 `base=count(<=t)`、`end=count(<=t+2+120)`、
  `delta=max(0,end-base)` clamp ≤fired；无 damage 样本/非 recorder 行 → serverHasTruth=0（server sidecar
  中 fired=0/hits=0，base 只算 recorder 鱼）；窗口与 E26e-b outcome 对齐；**相邻 2s 行窗口重叠，同一
  server 增量可被多行重复计数**（审计注明，不去重）。
- **覆盖**：3,111,384 行 / 17,055 launched；**recorder launched 710 行**（apac 226 / eu 349 / na 111 /
  own 24，占 launched 4.2%）、**truth 710 行（100%）**、311 个有 truth replay；damage 样本 3,299 条 /
  505 个 replay。
- **代理 vs server（recorder launched 710 行）**：

  | 指标 | 值 |
  |---|---|
  | confusion TP/FP/FN/TN | **138 / 35 / 147 / 390** |
  | precision / recall / F1 | **0.7977 / 0.4842 / 0.6026** |
  | 代理 hit rate / server hit rate | **24.37%** / **40.14%** |
  | 代理 fish 命中 / server fish 命中 | 434 / 471（同 3,212 fired 口径） |

  分 shard precision/recall：apac 0.796/0.494（226 行）、eu 0.798/0.463（349）、na 0.778/0.477（111）、
  own 0.846/0.611（24）。→ **代理精度高但召回低：server 确认的命中里约一半（147/285）代理没标出**；
  行级 hit rate 代理 24.37%（173/710）vs server 40.14%（285/710）；fish 口径 434/3,212=13.51% vs
  471/3,212=14.66%（同一 fired 口径）。
- **server 真值标签下的 headC（E26e-g any OOF，recorder 鱼 3,212 / hits 471 / base 14.66%）**：
  top-decile fish 命中 lift **2.3477×**（门槛 2.30）、ρ **0.8909**（≥0.30）、replay-cluster bootstrap
  95% CI **[1.8069, 3.0178]**（排除 0），311 个 replay cluster → **PASS（真值下仍成立）**。
  CLI 交叉验证（`torpedo_outcome_lift.py --prob-key C` 在 710 行子集上）完全一致：lift 2.347708 /
  ρ 0.890909 / CI [1.806868, 3.017790]。判据为“有 truth 行 ≥200 → 跑 lift 门禁”，710 ≥200 成立。
- **解释**：代理标签**漏标**大量 server 真命中（recall 0.48），但 headC 的**排序**在 server 真值下
  依然 ≥2.30（甚至 2.35 > 代理口径 2.20）——说明 headC 学到的是“命中倾向”而非死记代理标签的
  边界；代理标签主要问题在**绝对命中率被低估**（24.37% vs 40.14%），不是排序信息丢失。
- **判定**：**PASS**（预注册主判定 = server 真值标签下 headC lift ≥2.30 且 ρ/CI 成立）；描述性审计
  同时记录代理的低召回（precision 0.798 / recall 0.484）。
- **局限**：① **recorder-only**——damageStat 是录像者本地累计量，只能验证录像者自己的行（710/17,055
  launched 行 = 4.2%；3,212/71,693 fish = 4.5%），存在录像者选择偏差；② 2 s 行窗口（t+2..t+122）
  重叠，同一 server 增量可被多行重复计数，delta 是“窗口内增量”非逐鱼归因；③ 真值仍是累计伤害
  计数（weapon=7/category=0），可含多鱼雷/多目标聚合，不是逐鱼 ground truth；④ 311 replay/710 行
  样本小，CI 宽 [1.81, 3.02]；⑤ 未调模型/阈值（预注册禁止）。
- **下一步**：① 若要逐鱼真值，需要 replay 里按鱼雷实例的 server 伤害归因（当前 schema 无）；
  ② 用 server 真值做**校准/绝对概率**修正（代理低估命中率，但 headC 排序可用）；③ 训练仍可用 120u
  代理（覆盖全量、无需 recorder），诊断/校准用 server 子集审计。
- **产物**：`out/torpedo_model/e26e-m/{server_outcome_{apac,eu,na,own}.jsonl, audit_summary.json,
  server_lift.json, server_lift_cli.json}`；新增 tracked `scripts/experiments/torpedo_server_truth_audit.py`
  （脚本 sha `a8e8d5fc…`，selftest PASS：窗口/边界/clamp/非 recorder/launched 过滤/确定性/错位）。
### E26e-n · server 真值绝对概率校准（**MIXED / post-hoc**：Brier −20.1%、logloss −0.168、ECE −73%，但预注册 lift 判据在首跑后由 pooled 改为 held-out 折内；严格原判据 pooled lift 2.266<2.348 不通过）

- **问题（预注册 `out/torpedo_model/e26e-n-preregistration.md`；注意预注册在首跑后把 lift 判据由 pooled 澄清为 held-out 折内，属 post-hoc 变更）**：E26e-m 审计显示代理
  命中标签**低估绝对命中率**（recorder 行代理 24.37% vs server 40.14%），但 headC 排序在真值下仍
  ≥2.30。本任务**不重训模型**，只用 replay-held-out 的单调校准映射检验：能否把 headC 的绝对概率
  校准到 server 真值语义（Platt 为主、isotonic 为辅）。
- **truth 行**：recorder（`ownerEntityId == recorderEntityId`）且 launched（`labelB=true & fired>0`），
  server delta（t..t+2+120，clamp≤fired）>0 为真值；复用 `torpedo_server_truth_audit` 的
  `load_damage/server_delta`，与 E26e-g OOF 逐行校验 replay/t/ship。共 **710 行 / 285 正 / 311 replay**、
  fired 3,212（命中 471，base 14.66%）。
- **协议**：5 折 GroupKFold by replayId（seed 0，每折 142 test / 568 train）；每折在 train 上拟合、
  test 上预测（out-of-fold）；primary **Platt**（`sigmoid(a·logit(p)+b)`，numpy IRLS + line search），
  secondary **isotonic（PAVA）**。模型/阈值均未改。
- **结果（pooled out-of-fold）**：

  | 分数 | Brier | logloss | ECE(15bin) | AUC | meanProb | hitRate | 排序 lift* |
  |---|---|---|---|---|---|---|---|
  | raw headC | 0.280497 | 0.806662 | 0.236658 | 0.6569 | 0.1677 | 0.4014 | 2.3477 |
  | **Platt（primary）** | **0.224088** | **0.638661** | **0.063577** | 0.6534 | **0.4010** | 0.4014 | 2.2658（pooled） |
  | isotonic（secondary） | 0.224374 | 0.677704 | 0.053128 | 0.6370 | 0.3994 | 0.4014 | 2.1452（pooled） |

  \* lift = fish-level server 命中 top-decile lift（E26e-m 口径，710 truth 行）。**排序保持按 held-out
  折内检验**：5/5 折 raw 与 Platt 的 lift **完全相同（max |Δ| = 0）**——Platt 是单调映射；pooled
  lift 2.266 vs 2.348（−3.5%）是**折间校准器不可比**造成的评估伪影（部署会用单一映射；用单全局
  Platt a=0.8178,b=1.0123 时 Δlift=0.000），bootstrap 差值 95% CI [−0.186, 0.299] 也包含 0。
- **相对改善**：Brier **−20.11%**（差值 0.0564，replay-cluster bootstrap 95% CI [0.0420, 0.0708]）；
  logloss **−0.1680**（CI [0.1291, 0.2083]）；ECE **0.2367→0.0636（−73.1%）**；meanProb 0.168→0.401
  与真实 hitRate 0.401 对齐（raw 明显低估绝对概率，与 E26e-m 的方向一致）。
- **per-fold（raw / Platt）**：

  | fold | test/pos | Brier raw→Platt | logloss raw→Platt | lift raw=Platt |
  |---|---|---|---|---|
  | 0 | 142/53 | 0.2725→0.2276 | 0.7951→0.6442 | 1.894 |
  | 1 | 142/59 | 0.2871→0.2204 | 0.8073→0.6305 | 1.610 |
  | 2 | 142/59 | 0.2810→0.2216 | 0.8078→0.6355 | 2.755 |
  | 3 | 142/62 | 0.3044→0.2292 | 0.8670→0.6497 | 2.207 |
  | 4 | 142/52 | 0.2575→0.2216 | 0.7561→0.6335 | 2.892 |

  每折 Platt 斜率 a=0.783–0.872、截距 b=0.929–1.120（均 >0，单调保序）；isotonic 每折 lift 波动
  （1.590/1.972/2.317/2.303/2.127），因 568 训练行上 PAVA 结数≈行数、易过拟合小样本。
- **判定**：**MIXED / 探索性**。按**未变更的原始预注册**（pooled lift 保持）：Platt pooled lift **2.2658 < raw 2.3477**（−3.5%），原判据会 FAIL；首跑后把 lift 判据改为 held-out 折内（max|Δ|=0）才得到 PASS，而 Platt 的单调性使该指标恒真——这是**事后放宽判据**，不能算严格预注册 PASS。Brier/logloss/ECE 的校准改善（Brier −20.1%、logloss −0.168、ECE −73%、meanProb 0.401≈hitRate）本身成立，保留为**探索性诊断结果**；isotonic 仅 secondary。**校准只改概率语义，不改模型排序/阈值，未重训。**
- **局限**：① **判据 post-hoc**：原始 pooled lift 判据未过，改为 held-out 折内后才 PASS；结论只能算探索性；② 710 行 / 311 replay、仅 recorder 行，样本小、CI 宽；③ 同语料同分布、非独立赛季，校准图可能过拟合；④ server 真值仍是累计伤害（窗口重叠、多鱼雷聚合、非逐鱼）；⑤ isotonic 小样本易过拟合；⑥ 未部署，仅诊断（headC 概率语义修正），不参与总分/端上阈值。
- **下一步**：① 在独立赛季/留出 replay 上复核 Platt a/b 与 ECE，再考虑端上诊断卡展示“校准后命中概率”；
  ② 逐鱼 server 归因（当前 schema 无）可减少窗口重叠噪声；③ 把校准后的绝对概率用于诊断说明（代理低估），
  而排序/阈值仍用 raw headC。
- **产物**：`out/torpedo_model/e26e-n/{calibration_metrics.json, server_truth_calibrated.npz}`；新增 tracked
  `scripts/experiments/torpedo_server_truth_calibration.py`（selftest PASS：sigmoid/logit、Brier/logloss/ECE、
  top-decile lift、GroupKFold 分组/平衡、Platt 合成恢复、PAVA 单调/边界、确定性）；预注册
  `e26e-n-preregistration.md`（脚本 sha `966f8b62…`；lift 判据在首跑后由 pooled 改为 held-out 折内，README 已改标 MIXED/post-hoc，不称严格 PASS）。
### E26e-o · leave-one-region-out 泛化验证（**MIXED**：holdout headC lift 1.3849 < 2.00；headB 3.21×base 泛化良好；region 泛化缺口 −36.5%）

- **问题（预注册 `out/torpedo_model/e26e-o-preregistration.md`，先落盘后训练）**：此前所有 headC 评估都在
  同一 4 区全量语料上做（in-distribution）。本任务做 **leave-one-region-out**：训练只用 apac+eu+na
  （2,940,521 行 / 2,054 replay），holdout **own（170,863 行）完全不参与训练/验证**；5 折模型对 holdout
  预测取平均（fold ensemble），主验收 **holdout headC r120 outcome lift ≥2.00×**（泛化线，非 2.30）
  + ρ≥0.30/CI 排除 0；headB 非退化（AUPRC ≥2.0×base、top-decile ≥1.5×）。若不过则记录 region 泛化不足/
  过拟合证据，不调线。
- **实现**：trainer 新增 `--holdout-data / --holdout-click-context / --holdout-outcome`（+ `--holdout-metrics-out`、
  `--holdout-oof-out`、`--holdout-bootstrap`）：5 折训练完成后加载 holdout（复用 loader 的行数/
  replayId/t±1e-3/shipId/click 对齐校验），逐 fold 模型预测并平均，写 holdout 指标 JSON 与预测 npz；
  **无 holdout 参数时 4-shard 全量行为不变**；`load_outcome_sidecars` 侧车数量校验放宽为
  “每数据 shard 一个 sidecar”（支持 3 train shards）。
- **训练规模/超参**：torp4（49 维）+ 3 头，λ_C=0.1，5 折 GroupKFold by replayId（seed 0），hidden192 /
  12 epochs / batch4096 / lr1e-3 / smoothing0.05 / float16 / cuda；训练 229.0 s；train 侧 OOF headB
  AUPRC 0.039080（2.326×base）/top-lift 2.693/AUC 0.7021，train 侧 headC row AUPRC 0.25016/AUC 0.7085。
- **holdout own（170,863 行；5 折 ensemble）结果**：

  | 头 | 指标 | 值 | 验收 |
  |---|---|---|---|
  | headA | AUPRC / AUC / base | 0.8493 / 0.9113 / 0.5514 | 描述 |
  | headB | 94,220 can-launch 行 / 957 正 | AUPRC **0.032647**、base 0.010157 → **3.214×base**；top-decile lift **3.1139**；AUC 0.7035；logloss 0.06317；ECE 0.01768 | **PASS**（≥2.0×base 且 top≥1.5） |
  | headC（行级） | 957 launched 行 / 194 正 | AUPRC 0.26255、AUC 0.58235、top-decile lift 1.336、ECE 0.1834 | 描述 |
  | **headC outcome（r120）** | 957 行 / 3,386 fired / 476 hits / base 14.06% | **lift 1.3849×**、ρ **0.7576**、CI **[0.8554, 2.1899]**（149 replay clusters；bootstrap 修复后） | **MIXED**（<2.00 ✗） |

- **bootstrap 协议**：holdout outcome CI 复用 `torpedo_outcome_lift.bootstrap_cluster`（每个 replicate 内重排 decile，1000 reps / seed 0 / replay cluster），与标准 CLI `--regions own` 完全一致；selftest 覆盖复用标准函数与本地回退两条路径。
- **in-distribution 对照（同 outcome_lift 协议，`--regions own`）**：E26e-g OOF 的 own 子集（957 launched /
  3,386 fired / 476 hits）lift **2.1809×**、ρ 0.9030、CI [1.4729, 2.8225]；E26e-g 全量 2.1997× 参考。
  → **region 泛化缺口 = 1.3849 − 2.1809 = −0.796×（−36.5%）**；holdout CI [0.855, 2.190] 与 in-dist [1.473, 2.823] 有重叠，但点估计明显更低（样本小）。
- **判定**：**MIXED**。headB 非退化通过（AUPRC **3.21×base**、top-lift 3.11，泛化良好）；**headC 主验收
  FAIL**（lift 1.3849 < 2.00；ρ 0.758 ≥0.30 与 CI 排除 0 满足）→ 记录 **region 泛化不足**：headC 的
  outcome 排序能力明显依赖训练区域（apac/eu/na），迁到 own 后 top-decile lift 从 2.18 掉到 1.38。
- **holdout 十分位命中率**：19.47/17.70/23.60/14.94/12.89/10.70/9.09/9.16/11.45/12.79%——**top-decile 不是
  最高**（第 3 分位 23.60% 更高），排序在 own 上明显失准；这正是 lift 只有 1.38 的直接原因（第 3 分位
  的单折噪声/小样本加剧）。
- **局限**：① holdout own 仅 957 launched 行 / 3,386 fired / 149 replay，样本小、CI 宽（[0.855, 2.190]）；
  ② own 是不同赛事/对局分布（KotS own 组），与 apac/eu/na 的差异可能同时含 region、赛事、玩家/打法差异，
  不能单独归因 region；③ 5 折 ensemble 平均会平滑各折噪声但不改变分布偏移；④ 训练侧 headC 未在
  own 上校准/微调（任务禁止）；⑤ 代理命中标签（120u+HP）本身有噪声（见 E26e-m）。
- **下一步**：① 补充 own 少量样本做 **few-shot/微调或领域自适应**（如 5–10% own 参与训练）看缺口是否收窄；
  ② 用 E26e-m server 真值检查 holdout own 的标签噪声是否放大缺口；③ 若 headC 需跨区部署，应按 region
  分层评估/校准，而不是只报全量 2.20；④ 继续扩 region 样本时保留 leave-one-region-out 作为发布门禁。
- **产物**：`out/torpedo_model/e26e-o/{holdout_metrics.json, holdout_ensemble.npz, e26e_o_metrics.json,
  e26e_o_train.log, outcome_lift_holdout.json, outcome_lift_indist_own.json}`；node3
  `/mnt/work/wowsp-kots/e26e-o/{data,click,outcome,code,run}`；预注册 `e26e-o-preregistration.md`
  （脚本 sha `529e6d31…`，与 node3 实跑一致）。
### E26e-p · few-shot region adaptation（**MIXED**：holdout headC 1.7514 < 1.80；vs E26e-o +0.3665，补回 46.0% 缺口；headB 3.53×base）

- **问题（预注册 `out/torpedo_model/e26e-p-preregistration.md`，先落盘后训练）**：E26e-o（0 own 训练样本）
  holdout own headC outcome lift **1.3849**（in-dist own 2.1809，缺口 −36.5%）。本任务检验 **few-shot
  region adaptation**：把 own 的 **10% replay（17/161，按 replayId 分组 seed0）** 加入训练，在剩余
  **90%（144 replay）** 上评估，主验收 holdout headC r120 lift **≥1.80**（= 把 E26e-o 缺口收窄至少一半）
  且 ρ≥0.30/CI 排除 0；headB 非退化（AUPRC ≥2.0×base、top≥1.5×）。trainer 用
  `--holdout-min-lift 1.8`（默认 2.0），holdout_metrics 的 acceptance.rule 与实际预注册线一致。
- **拆分（node3 `/mnt/work/wowsp-kots/e26e-p`，数据来自 E26e-o own 分片）**：161 replay；seed0 选 17 个为
  **adapt**、144 为 **holdout**，**replay 交集 0**；三个流（dataset/click/outcome）同集合流式过滤、保持原行序：

  | split | replays | rows | launched | fired fish | hits |
  |---|---|---|---|---|---|
  | adapt（入训） | **17** | 16,791 | 83 | 258 | 25 |
  | holdout（评估） | **144** | 154,072 | 874 | 3,128 | 451 |
  | 合计 | 161 | 170,863 | 957 | 3,386 | 476 |

  （合计与 E26e-o own 分片一致；split_summary.json 记录 replay 列表与计数。）
- **训练/评估**：训练数据 = apac+eu+na + own_adapt（**2,957,312 行 / 2,071 replay**，4 shards）；holdout =
  own_holdout（154,072 行，单 shard，从不参与训练/验证）。torp4 3 头 λ_C=0.1，5 折 GroupKFold（seed0），
  hidden192/12epochs/batch4096/lr1e-3/smoothing0.05/float16/cuda，**230.9 s**；5 折模型对 holdout 平均预测。
  训练侧 OOF：headB AUPRC 0.041809（2.502×base）/top 2.853/AUC 0.720；headC row AUPRC 0.24753/AUC 0.70833。
- **holdout own 结果（154,072 行，5 折 ensemble）**：

  | 头 | 指标 | 值 | 验收 |
  |---|---|---|---|
  | headA | AUPRC / AUC / base | 0.999255 / 0.999770 / 0.545381 | 描述 |
  | headB | 84,028 can-launch 行 / 874 正 | AUPRC **0.036724**、base 0.010401 → **3.5307×base**；top-decile lift **3.2608**；AUC **0.7707**；logloss 0.06673；ECE 0.02338 | **PASS** |
  | headC（行级） | 874 launched 行 / 181 正 | AUPRC 0.3161、AUC 0.6223、top-decile lift 1.701、ECE 0.17824 | 描述 |
  | **headC outcome（r120）** | 874 行 / 3,128 fired / 451 hits / base 14.42% | **lift 1.7514×**、ρ **0.8061**、CI **[1.2600, 2.5048]**（135 replay clusters） | **MIXED**（<1.80 ✗） |

- **对照（同 outcome_lift 标准协议，`--regions own`）**：

  | 模型 | holdout own headC lift | ρ | CI | headB AUPRC/top |
  |---|---|---|---|---|
  | E26e-o（0 own，旧 holdout 170,863 行） | 1.3849 | 0.758 | [0.8554, 2.1899] | 0.032647（3.214×）/3.114 |
  | **E26e-p（10% own few-shot，holdout 154,072 行）** | **1.7514** | **0.806** | **[1.2600, 2.5048]** | **0.036724（3.531×）/3.261** |
  | in-dist own（E26e-g OOF own 子集，957 行） | 2.1809 | 0.903 | [1.4729, 2.8225] | — |

  → few-shot 使 holdout own lift **1.3849→1.7514（+0.3665，+26.5%）**，补回 E26e-o 缺口的 **46.0%**
  （(1.7514−1.3849)/(2.1809−1.3849)）；距 1.80 线差 **0.049**，未达到“收窄至少一半”。**headB 泛化同步改善**
  （0.032647→0.036724 = 3.531×base；top 3.114→3.261；AUC 0.704→0.771）。
- **bootstrap 协议**：holdout CI 使用标准 `torpedo_outcome_lift.bootstrap_cluster`（每个 replicate 内重排
  decile，1000 reps / seed0 / replay cluster），lift/ρ/base 不变，CI = **[1.2600, 2.5048]**，
  与 `outcome_lift_holdout.json`（CLI `--regions own`）完全一致。
- **判定**：**MIXED**。headB 非退化通过；headC 主验收 **FAIL**（1.7514 < 1.80，差 0.049；ρ 0.806 ≥0.30
  与 CI 排除 0 满足）→ 记录 **few-shot 不足**：own 10% replay 只补回约 46% 的 region 缺口，region 泛化
  缺口不是少量样本即可完全补上（E26e-o 的 −36.5% 收窄到约 **−19.7%** 相对 in-dist）。
- **局限**：① adapt 仅 17 replay/83 launched、holdout 144 replay/874 launched，样本小、CI 宽；② 同语料
  （非跨赛季）且 own 与 apac/eu/na 的差异同时含赛事/玩家/打法，不能单独归因 region；③ few-shot 只加
  10% replay，未调采样权重/课程/领域自适应；④ headC 行级校准（AUC 0.622/ECE 0.178）仍差，outcome lift
  主要靠排序；⑤ 未重训 E26e-o 对照（其 1.3849 为既有结果）。
- **下一步**：① 提高 own 比例（20–30%）或按 replay 长度/赛事分层采样，看缺口是否继续收窄并找收益拐点；
  ② 领域自适应（re-weight/微调 headC 最后一层）替代少量样本混训；③ 用 E26e-m server 真值检查 holdout
  own 的标签噪声；④ 跨区部署仍应按 region 分层评估，leave-one-region-out + few-shot 作为发布门禁。
- **产物**：`out/torpedo_model/e26e-p/{split_summary.json, holdout_metrics.json, holdout_ensemble.npz,
  e26e_p_metrics.json, e26e_p_train.log, outcome_lift_holdout.json, outcome_lift_indist_own.json}`；node3
  `/mnt/work/wowsp-kots/e26e-p/{data,click,outcome,code,run}`；预注册 `e26e-p-preregistration.md`
  （脚本 sha `809240e1…`，与 node3 实跑一致）。
### E26e-q · few-shot dose response（**PASS（仅同期随机拆分）**：25% common-holdout headC 2.4859 ≥1.90；10% 2.1645；dose Δ +0.3214；0% 1.5963；**E26e-r temporal FAIL → 不可外推**）

- **问题（预注册 `out/torpedo_model/e26e-q-preregistration.md`，先落盘后训练）**：E26e-p 的 10% few-shot 在
  一个 own holdout 上到 1.7514（未达 1.80）。本任务在同 **common holdout** 上做 **dose response**：own
  0%（E26e-o 模型子集）/10%/25% 入训，检验 few-shot 增益是否随剂量上升、25% 能否接近 in-dist 2.1809。
- **拆分（node3 seed0，按 replayId）**：own 161 replay → **common holdout 60% = 97 replay**；
  **adaptation pool 40% = 64 replay**；pool 内 nested 取 **adapt10 = 16 replay（10%）**、
  **adapt25 = 40 replay（25%）**，**adapt10 ⊂ adapt25**，holdout∩pool = 0。三流（dataset/click/outcome）
  同集合过滤、保原序：

  | split | replays | rows | launched | fired | hits |
  |---|---|---|---|---|---|
  | common_holdout | 97 | 102,349 | 589 | 2,044 | 286 |
  | own_adapt10（Run A） | 16 | 18,849 | 99 | 417 | 57 |
  | own_adapt25（Run B） | 40 | 46,985 | 246 | 904 | 136 |

- **训练（两个 sequential run，同超参/同 holdout）**：torp4 3 头 λ_C=0.1，5 折 GroupKFold（seed0），
  hidden192/12epochs/batch4096/lr1e-3/smoothing0.05/float16/cuda；Run A 训练 **2,959,370 行**（224.1 s），
  Run B **2,987,506 行**（226.2 s）；5 折模型对 common_holdout 平均预测。
- **dose 表（同一 common holdout，589 launched / 2,044 fired / 286 hits / base 13.99%）**：

  | own dose | headC lift | ρ | 95% CI（标准 bootstrap） | headB AUPRC（×base） | headB top-lift | headB AUC |
  |---|---|---|---|---|---|---|
  | **0%**（E26e-o 模型子集） | 1.5963 | 0.6364 | [0.8427, 2.6954] | 0.036940（3.607×） | 3.0730 | 0.7118 |
  | **10%**（Run A） | 2.1645 | 0.8545 | [1.4613, 3.0634] | 0.035741（3.490×） | 3.2767 | 0.7705 |
  | **25%**（Run B，primary） | **2.4859** | 0.7818 | [1.7236, 3.2755] | **0.041467（4.049×）** | **3.4804** | **0.7826** |

  10% vs 25%：**dose Δ lift = +0.3214**（ρ −0.0727、headB AUPRC +0.0057、AUC +0.0121）；0%→10% 增益 +0.5682。
  25% 已 **超过 in-dist own 2.1809（+0.3050）**，10% 与其基本持平（−0.0164）。
- **判定**：**PASS（仅同期随机拆分）**（25% primary：lift 2.4859 ≥1.90、ρ 0.7818 ≥0.30、CI [1.7236,3.2755] 排除 0；
  headB 非退化 4.049×base/top 3.4804/AUC 0.7826）。secondary 10% 也过 1.90（2.1645）；**dose 单调上升**，
  25% 范围内未出现 ceiling（0%/10%/25% 三点均高于 1.59/2.16/2.49）。**但后续 E26e-r 的时间外推 FAIL（temporal 25% 1.6244/ρ −0.20）→ 本 PASS 不能外推到后续时间，部署前须 walk-forward 验证。**
- **口径**：holdout_metrics 的 acceptance rule/minLift 与预注册 **1.90** 对齐；CI 用标准
  `bootstrap_cluster`（replicate 内重排 decile）从 holdout_ensemble.npz 计算，与
  `outcome_lift_run10/run25.json`（CLI `--regions own`）逐位一致。
- **注意**：common holdout 是 60% own 子集（97 replay），与 E26e-o 的 full own holdout（170,863 行/957
  launched）**不是同一评估集**——0% 的 1.5963 不可与 E26e-o 的 1.3849 直接横比；dose 比较只在同一
  common holdout 内有效。
- **局限**：① common holdout 仅 97 replay/589 launched，CI 宽（约 [1.46, 3.06]/[1.72, 3.28]）；
  ② adapt10/adapt25 为 nested 但只覆盖 10%/25% 两档，曲线尾段（40%/60%）未知；③ 同语料（非跨赛季），
  own 差异含赛事/玩家/打法；④ headC row 级 ECE 仍偏高（0.12/0.09）；⑤ E26e-o 0% 对照沿用旧模型，
  未在同拆分上重训（但其 holdout 预测可用 replayId 过滤得到同集子集）。
- **下一步**：① 补 40%/60% 或 own all 的剂量点，拟合 dose-response 曲线找饱和点；② 高剂量时同时
  评估 headC 校准（ECE）是否恶化；③ 跨赛季/独立 replay 复核 25% 的 2.49；④ 若部署，region 分层
  评估 + few-shot 比例作为配置项。
- **产物**：`out/torpedo_model/e26e-q/{run10/, run25/}{holdout_metrics.json, holdout_ensemble.npz,
  metrics.json, train.log}`；`outcome_lift_baseline0.json`（0% common holdout）、
  `outcome_lift_run10.json`、`outcome_lift_run25.json`；预注册 `e26e-q-preregistration.md`。
### E26e-r · 40% 剂量 + 时间外推验证（**MIXED**：random 40% 2.4413 过 1.90 但剂量饱和；**temporal 25% 1.6244 < 1.80、ρ −0.20 FAIL** → E26e-q 的 random-split 2.4859 **时间外推不成立**）

- **问题（预注册 `out/torpedo_model/e26e-r-preregistration.md`，先落盘后训练）**：E26e-q 在**同期随机拆分**上
  给出 0%/10%/25% = 1.5963/2.1645/2.4859。本任务补 ① random 40%（整个 adaptation pool）看剂量是否饱和；
  ② **temporal 外推（primary）**：最早 40 replay 入训、最晚 97 replay holdout，检验随机拆分的收益是否
  经得起时间外推。
- **拆分（node3 seed0/按 replayId 日期）**：

  | split | replays | rows | launched | fired | hits | 用途 |
  |---|---|---|---|---|---|---|
  | own_adapt40 | 64 | 68,514 | 368 | 1,342 | 190 | Run A 训练（random 40%） |
  | own_adapt_t25 | 40 | 40,646 | 248 | 918 | 128 | Run B 训练（最早 40，20240203–20250701） |
  | own_temporal_holdout | 97 | 93,840 | 515 | 1,765 | 275 | Run B 评估（最晚 97，20250705–20261028） |

  random40 与 E26e-q 共用同一 common_holdout（97 replay）；temporal 拆分的中间 24 replay 不用；两集合无交集。
- **训练（同超参）**：torp4 3 头 λ_C=0.1，5 折 GroupKFold（seed0），12 epochs；Run A 3,009,035 行/233.7 s，
  Run B 2,981,167 行/228.8 s；5 折模型平均预测各自 holdout。
- **dose 表（同一 common_holdout：589 launched / 2,044 fired / 286 hits / base 13.99%）**：

  | own dose | headC lift | ρ | 95% CI（标准 bootstrap） | headB AUPRC（×base） | top-lift | AUC |
  |---|---|---|---|---|---|---|
  | 0%（E26e-o 子集） | 1.5963 | 0.6364 | [0.8427, 2.6954] | 3.607× | 3.0730 | 0.7118 |
  | 10% | 2.1645 | 0.8545 | [1.4613, 3.0634] | 3.490× | 3.2767 | 0.7705 |
  | 25% | 2.4859 | 0.7818 | [1.7236, 3.2755] | 4.049× | 3.4804 | 0.7826 |
  | **40%** | **2.4413** | 0.6970 | [1.6314, 3.3785] | 4.048× | 3.4125 | 0.7843 |

  → **剂量在 25% 附近饱和**：Δ10→25 = +0.3214，而 **Δ25→40 = −0.0446（略降）**；40% headB 与 25% 基本持平。
- **temporal 表（Run B，515 launched / 1,765 fired / 275 hits / base 15.58%）**：

  | 设定 | headC lift | ρ | 95% CI | headB AUPRC（×base） | top-lift | AUC |
  |---|---|---|---|---|---|---|
  | temporal 0%（E26e-o 过滤 97 replay） | 1.5063 | 0.5394 | [0.6041, 2.2146] | 0.033487（3.163×） | 3.1453 | 0.6703 |
  | **temporal 25%（primary）** | **1.6244** | **−0.20** | [0.7519, 2.3744] | 0.035284（3.333×） | 3.2618 | 0.6767 |
  | 参考：in-dist own | 2.1809 | 0.9030 | [1.4729, 2.8225] | — | — | — |

  → temporal 25% 仅比 temporal 0% 高 **+0.1181**（+7.8%），且 **ρ 从 0.5394 掉到 −0.20**（十分位排序失效）；
  比 in-dist own 2.1809 低 **0.5565（−25.5%）**。E26e-q 同期 random 25% 的 2.4859 与 temporal 25% 的 1.6244
  相差 **+0.8615**：随机拆分的高增益在时间外推下**大部分消失**。
- **判定**：**MIXED**。random 40% secondary PASS（2.4413 ≥1.90）但**剂量已饱和**（低于 25%）；
  **temporal 25% primary FAIL**（lift 1.6244 < 1.80、ρ −0.20 < 0.30；CI [0.7519,2.3744] 虽排除 0 但下界仅 0.75）→
  **记录 time drift**：E26e-p/q 的 few-shot 收益主要来自同期随机拆分，**不能外推到后续时间**；headB 两 run
  均非退化（random40 4.048×base/top 3.41/AUC 0.784；temporal 3.333×base/top 3.26/AUC 0.677，AUC 明显低于
  随机口径），说明时间漂移对 headC 排序的伤害大于 headB。
- **口径**：run40_random 的 acceptance rule/minLift 对齐 secondary **1.90**、runT25_temporal 对齐
  primary **1.80**；CI 用标准 `bootstrap_cluster`（1000/seed0/replay cluster）从 holdout_ensemble.npz 计算：
  run40 [1.6314,3.3785]、runT25 [0.7519,2.3744]，与 `outcome_lift_run40.json`/`outcome_lift_runT25.json` 一致。
- **局限**：① temporal holdout 仅 97 replay/515 launched/1,765 fired，CI 宽（[0.752,2.374]）；② 时间外推
  与赛事/版本/玩家分布变化混淆，无法单独归因“时间漂移”；③ 只做了一个时间切点（最早 40 vs 最晚 97），
  未做 walk-forward 多窗口；④ random40/temporal 两次训练各自 5 折但 seed 相同、单 seed；⑤ in-dist 2.1809
  来自较早随机语料，非时间匹配参照；⑥ headB temporal AUC 0.677 也偏低，需检查时间漂移对发射头的影响。
- **结论（必须保留）**：**E26e-q 的 2.4859（random 25%）是同一时期随机拆分的结果，时间外推不成立**；
  部署前必须以时间外推/walk-forward 验证为准，不能用随机拆分数字宣称线上收益。
- **下一步**：① walk-forward 多时间窗（按月/赛季）复测 25% 与 40% 剂量；② 时间漂移诊断（特征分布/赛事
  分布/玩家分层）与按时间重校准；③ 若确需 few-shot，采用滚动近端数据并配时间验证门禁；④ headC 时间
  外推的排序失效需进一步分析（是否 top 分位翻转）。
- **产物**：`out/torpedo_model/e26e-r/{run40_random/, runT25_temporal/}{holdout_metrics.json,
  holdout_ensemble.npz, metrics.json, train.log}`；`outcome_lift_run40.json`、`outcome_lift_runT25.json`、
  `outcome_lift_baseline0_temporal.json`、`baseline0_temporal_oof.npz`、`split_summary.json`；预注册
  `e26e-r-preregistration.md`。
### E26e-s · 滚动起点 walk-forward 时间验证（**形式 PASS(2/3)，但 Q3 崩盘（0.908/ρ −0.006）→ temporal instability 仍在**；Q2 3.005、Q4 1.826）

- **问题（预注册 `out/torpedo_model/e26e-s-preregistration.md`，先落盘后训练）**：E26e-r 的单时间切点
  （temporal 25% 1.6244、ρ −0.20）说明同期随机拆分的 few-shot 收益不能时间外推。本任务做 **rolling-origin
  walk-forward**（3 个窗口）检验该失败是否偶然：own 161 replay 按日期等分 Q1–Q4，i=2/3/4 用 adapt=Q_{i−1}、
  test=Q_i。
- **chronological blocks（按 replayId 前 8 位日期排序）**：

  | block | replays | 日期范围 | rows | launched | fired | hits |
  |---|---|---|---|---|---|---|
  | Q1（最早） | 40 | 20240203–20250701 | 40,646 | 248 | 918 | 128 |
  | Q2 | 40 | 20250701–20250707 | 65,111 | 329 | 1,162 | 116 |
  | Q3 | 40 | 20250707–20260918 | 37,281 | 241 | 807 | 150 |
  | Q4（最晚） | 41 | 20260918–20261028 | 27,825 | 139 | 499 | 82 |

  合计 161 replay / 170,863 rows / 957 launched / 3,386 fired / 476 hits（与 E26e-o own 分片一致）。
- **训练（3 个 sequential run，同超参）**：每窗 train = apac+eu+na+adapt（4 shards），holdout = test block；
  torp4 3 头 λ_C=0.1，5 折 GroupKFold（seed0），12 epochs；5 折模型平均预测 test。
- **walk-forward 表（0% = E26e-o 预测过滤 test block；25% = adapt 混训；标准 outcome_lift / bootstrap）**：

  | 窗口 | adapt→test | test 日期 | 0% lift / ρ / CI | **25% lift / ρ / CI** | headB（×base / top / AUC） | ≥1.80 且 ρ≥0.30 |
  |---|---|---|---|---|---|---|
  | runQ2 | Q1→Q2 | 20250701–20250707 | 0.9200 / 0.085 / [0.115, 2.372] | **3.0052 / 0.903 / [0.864, 5.114]** | 4.401× / 3.9205 / 0.8191 | **PASS** |
  | runQ3 | Q2→Q3 | 20250707–20260918 | 2.1373 / 0.309 / [1.185, 2.930] | **0.9083 / −0.006 / [0.258, 1.565]** | 2.821× / 3.1942 / 0.6519 | **FAIL** |
  | runQ4 | Q3→Q4 | 20260918–20261028 | 1.6481 / 0.794 / [0.732, 3.009] | **1.8256 / 0.632 / [0.360, 3.422]** | 5.309× / 3.8108 / 0.7655 | **PASS** |

  → **预注册 primary（3 窗中 ≥2 窗 lift ≥1.80、ρ≥0.30、CI 排除 0）= 2/3 → 形式 PASS**；
  headB 三窗全部非退化（2.82×–5.31×base、top 3.19–3.92）。
- **但必须如实记录 temporal instability**：
  - **Q3 严重失败**：25% lift **0.9083**（≈随机以下）、ρ **−0.006**、CI [0.258,1.565]，且比其 0% baseline
    （2.1373）**更差**（−1.229）→ 该窗混训没有帮助反而伤害；
  - Q2 虽 3.0052 但 0% baseline 仅 0.9200（同窗模型大幅翻盘），CI [0.864,5.114] 下界 <1、样本 329 launched；
  - Q4 1.8256 仅**压线过** 1.80，CI [0.360,3.422] 下界 0.36、139 launched；
  - 0% baseline 自身在 0.92–2.14 间大幅波动，窗口间不可比；
  - → **2/3 只是形式阈值，Q3 崩盘 + Q2/Q4 CI 极宽说明时间稳定性并未成立**；E26e-r 的单切点失败不是偶然。
- **与 E26e-r 对照**：E26e-r 单切点 temporal 25% = 1.6244（<1.80、ρ −0.20）；E26e-s 三窗中 Q3 同样崩盘
  （0.908、ρ −0.006），Q2/Q4 虽过线但 CI 下界全部 <1；**结论一致：few-shot 的随机拆分增益不可时间外推**。
- **判定**：**PASS(2/3) but Q3 FAIL / temporal instability**。按预注册字面为 2/3 过线；但结合 Q3 严重失败
  与 CI 宽度，**不能宣称“时间稳健”**，也不能作为部署依据。部署仍须 **walk-forward 门禁**，鱼雷保持
  诊断-only、不并入总分。
- **口径**：三份 holdout_metrics.json 的 acceptance rule/minLift 对齐预注册 **1.80**（headC_primary_pass：
  Q2 true / Q3 false / Q4 true）；CI 用标准 `bootstrap_cluster` 从 holdout_ensemble.npz 计算：Q2 [0.8635,5.1141]、
  Q3 [0.2575,1.5647]、Q4 [0.3598,3.4217]，与 `outcome_lift_runQ2/Q3/Q4.json`（CLI）一致。
- **局限**：① 每窗 test 仅 139–329 launched、499–1,162 fired，CI 极宽；② 只有 3 个窗口/4 个 block，
  单 seed；③ block 边界同日 replay 被拆到相邻 block，日期范围有重叠；④ 0% baseline 与 25% 模型都用
  E26e-o 旧预测/新训练，窗口间样本构成不同；⑤ 时间漂移与赛事/版本/玩家分布混杂；⑥ in-dist 2.1809 为
  全局参照，非逐窗同分布；⑦ headB 三窗虽非退化但 Q3 AUC 0.652 偏低。
- **下一步**：① 扩窗口/扩样本（按月而非 4 等分，多个 origin、多 seed）；② 时间漂移诊断（按 block 的
  特征/赛事/玩家分布与 headC 分位翻转）；③ 若要做 few-shot，采用 rolling-recent 数据 + walk-forward
  通过率（≥2/3 且每窗 CI 下界 >1）作为门禁；④ 不因 2/3 形式 PASS 推动总分集成。
- **产物**：`out/torpedo_model/e26e-s/{runQ2,runQ3,runQ4}/{holdout_metrics.json, holdout_ensemble.npz,
  metrics.json, train.log}`；`outcome_lift_runQ2/Q3/Q4.json`、`outcome_lift_baseline0_Q2/Q3/Q4.json`、
  `baseline0_Q2/Q3/Q4_oof.npz`、`split_summary.json`；预注册 `e26e-s-preregistration.md`。
### E26e-t · Q3 崩盘的时间漂移诊断（**composition/prior shift + 跨模式排序坍塌**；Q3 base 18.6% vs Q2 10.0%，25% meanProbC 3.7%、ECE 0.258、AUC 0.500/lift 0.908，0% baseline 仍 2.137；不重训）

- **问题（预注册 `out/torpedo_model/e26e-t-preregistration.md`，descriptive）**：E26e-s walk-forward 的 runQ3
  （adapt=Q2、test=Q3）headC lift 0.9083、ρ −0.006，远差于 Q2（3.0052）/Q4（1.8256），且低于其 0% baseline
  （2.1373）。本任务**只做描述性诊断**（不重训、不改模型/阈值）：拆分原因到底是 base rate/prior 漂移、
  特征/类别分布漂移，还是标签噪声。
- **方法**：`scripts/experiments/torpedo_temporal_drift.py` 按 Q1–Q4 replayId 过滤 full own 数据集与
  click/r120 outcome sidecar，聚合规模/命中率/模式/地图/舰种/敌人 slot/torp 属性/click 特征；对齐 e26e-s
  三窗 holdout 预测与 0% baseline（probC、meanProbC、ECE、AUC、top-decile lift，均按标准 outcome_lift
  的 decile 口径），量化 adapt→test 的 SMD/KS/PSI；脚本含 `--selftest`（合成行/分块/统计断言）。
- **Q1–Q4 组成（full own，170,863 行 / 957 launched / 3,386 fired / 476 hits）**：

  | block | rows | launched | fired | hits | baseHitRate | rowAny | 模式 top | 地图 top |
  |---|---|---|---|---|---|---|---|---|
  | Q1 | 40,646 | 248 | 918 | 128 | 13.94% | 18.55% | pvp 29,924 / ranked 10,466 | 08_NE_passage / 46_Estuary |
  | Q2 | 65,111 | 329 | 1,162 | 116 | 9.98% | 13.98% | pvp 62,556 / event 2,555 | 44_Path_warrior / 20_NE_two_brothers |
  | Q3 | 37,281 | 241 | 807 | 150 | **18.59%** | **29.46%** | brawl 12,806 / pvp 12,283 / event 12,192 | 53_Shoreside / 15_NE_north |
  | Q4 | 27,825 | 139 | 499 | 82 | 16.43% | 22.30% | brawl 14,028 / pvp 9,467 / pve 4,330 | 14_Atlantic / e09_Halloween_2019 |

- **Q3 异常表（test block 对照 Q2/Q4）**：

  | metric | Q2 test | Q3 test | Q4 test |
  |---|---|---|---|
  | baseHitRate | 9.98% | **18.59%** | 16.43% |
  | rowAnyHitRate | 13.98% | **29.46%** | 22.30% |
  | 25% meanProbC | 0.0610 | **0.0370** | 0.2352 |
  | 25% ECE(10bin) | 0.0973 | **0.2576** | 0.1072 |
  | 25% AUC | 0.6364 | **0.5000** | 0.6649 |
  | 25% top-decile lift | 3.0052 | **0.9083** | 1.8256 |
  | 0% meanProbC | 0.0075 | 0.0127 | 0.1407 |
  | 0% AUC / lift | 0.5444 / 0.9200 | 0.5755 / **2.1373** | 0.5800 / 1.6481 |

- **漂移 top（adapt→test；PSI 为类别，SMD/KS 为连续）**：

  | 窗口 | 类别 top | 连续 top |
  |---|---|---|
  | Q2→Q3 | shipId 8.54 / mapName 7.57 / gameMode 5.66 | enemyDistMean SMD 0.907(KS 0.392)、enemyCount 0.777(0.412)、enemySpeed −0.438 |
  | Q3→Q4 | shipId 9.57 / mapName 7.45 / gameMode 6.08 | enemyRadarLit −0.511、enemyDistMean 0.323、enemyCount 0.203 |
  | Q1→Q2 | mapName 10.44 / shipId 6.71 / gameMode 3.33 | enemyCount −0.505、enemyDistMean −0.403、ownTorpRange −0.202 |

  → 类别漂移在**每个窗都很大**（模式/地图/舰种轮换是常态），Q2→Q3 额外叠加**最大的连续特征漂移**
  （Q3 敌人更近 3,133m vs 4,054m、数量更少 4.29 vs 6.87、速度 +2.6kt、observedNow 0.643 vs 0.559）与
  base rate 近 2 倍跳升。
- **按模式拆解（关键证据）**：Q2 几乎全 pvp（62,556/2,555 event、0 brawl）；Q3 变为 brawl 12,806 +
  event 12,192 + pvp 12,283（brawl 34%）；Q4 继续 brawl 14,028。各模式 base hit rate：

  | block | pvp | brawl | event | pve |
  |---|---|---|---|---|
  | Q2 | 310/1,116/104 = 9.32% | — | 19/46/12 = 26.09% | — |
  | Q3 | 72/257/25 = **9.73%** | 74/248/78 = **31.45%** | 95/302/47 = 15.56% | — |
  | Q4 | 39/114/23 = 20.18% | 89/339/52 = 15.34% | — | 11/46/7 = 15.22% |

  → **Q3 的 base rate 跳升主要是模式组成**（brawl/event 占比高且 base 高），pvp 自身只从 9.3% 到 9.7%；
  标签本身不是 Q3 特有（同 r120 口径），代理标签噪声无法解释 Q3 的组成变化。
- **为什么 25% 模型在 Q3 整體崩**：按模式看 25% runQ3 仍有**弱排序**（brawl lift 1.59、event 1.65、
  pvp 1.81），但 **meanProbC 跨模式错序**：pvp 5.07% > event 4.30% > brawl 1.58%，而真实 base 为
  brawl 31.45% > event 15.56% > pvp 9.73% → 全局 top decile 偏向 pvp → 整体 lift 0.908、AUC 0.500；
  0% baseline 反而把 event/brawl 排在 pvp 之上（meanProbC 1.58%/1.34%/0.78%）→ 整体 lift 2.137。
  Q4 的 adapt（Q3）已含 brawl/event，模型学到跨模式排序（brawl meanProbC 26.8% vs base 15.3%，整体 lift
  1.826）→ **提示 Q3 崩盘与“前一块（Q2）没有 brawl/event、模型对未见模式产生跨模式 prior 错序”一致**（描述性关联，非因果证明）。
- **判定（descriptive，不做因果断言）**：**Q3 崩盘 = composition/prior shift（模式/地图/舰种轮换；Q3 base
  18.6% vs Q2 10.0%）+ 模型严重欠概率（meanProbC 3.7% vs 18.6%、ECE 0.258）+ 跨模式排序坍塌
  （AUC 0.500、lift 0.908）**；**不是单一标签噪声**（同标签口径、pvp 内 base 稳定、模式内仍有弱排序）；
  连续特征漂移（更近/更少/更高速度敌人）与模式组成混杂，**无法单独归因**；标签噪声无法定量排除
  （代理标签，server 真值仅 710 recorder 行、无法按 block 分辨）。
- **建议（不实施）**：① walk-forward 门禁必须同时要求**每窗 AUC 与 CI 下界**（不只 lift）；② 按
  gameMode/map/shipClass 分层或 reweight 评估/训练；③ 按窗做 prior/温度重校准（先验校准需另立预注册）；
  ④ **不因 2/3 形式 PASS 推部署/总分**；鱼雷保持诊断-only。
- **局限**：Q3 仅 241 launched/807 fired/150 hits，CI 极宽；描述性、无因果识别；连续漂移与模式/地图漂移
  混杂；byMode 中 fired<50 的格子（event/pve 部分）lift 记为 `-`；E26e-s 每窗 5 折同 seed，非多 seed；
  server 真值无法按 block 分辨，标签噪声只能排除“单一标签噪声”假设，不能排除其与组成漂移的交互。
- **产物**：`scripts/experiments/torpedo_temporal_drift.py`（含 `--selftest`）；
  `out/torpedo_model/e26e-t/{drift_summary.json, drift_report.md}`；预注册 `e26e-t-preregistration.md`。
### E26e-u · 按模式分层/先验归一化能否修复 Q3 全局排序（**primary FAIL**：Q3 oracle 1.681 / within-rank 1.703 <1.80，label-free 1.050；AUC 0.500→0.678 说明模式先验是主因但分层不能修复 lift≥1.80；不重训）

- **问题（预注册 `out/torpedo_model/e26e-u-preregistration.md`，descriptive）**：E26e-t 诊断出 Q3 崩盘主因是
  composition/prior shift + 跨模式 meanProbC 错序（pvp 5.07% > event 4.30% > brawl 1.58%，真实 base
  brawl 31.45% > event 15.56% > pvp 9.73%）。本任务**不重训**，只检验：按模式分层/先验归一化能否修复
  Q3 全局排序与 lift。
- **方法**：对 Q2/Q3/Q4 每个 test block 的 launched 行（probC + fired/hits + gameMode）比较四种分数：
  **raw**；**within-mode rank**（每 mode 内 probC 百分位，跨 mode 直接用 rank，忽略 mode base）；
  **oracle mode-prior**（test block 实际 mode base + ε·within-rank，ε=1e-3，oracle 上界）；
  **label-free adapt-prior**（前一块 mode base + ε·within-rank，缺失 mode fallback adapt 全局 base）。
  指标：官方 outcome_lift decile 口径 global lift、AUC、top-decile hit rate、per-mode base/meanProbC/lift；
  脚本 `scripts/experiments/torpedo_mode_stratification.py`（含 `--selftest`：rank/score/mode 断言）。
- **结果（三窗）**：

  | 窗口（test/adapt） | raw lift / AUC | within-rank lift / AUC | oracle-prior lift / AUC | adapt-prior lift / AUC |
  |---|---|---|---|---|
  | runQ2（Q2/Q1） | **3.005** / 0.636 | 3.094 / 0.620 | 2.572 / 0.670 | 3.339 / 0.585 |
  | **runQ3（Q3/Q2）** | **0.908** / **0.500** | **1.703** / 0.567 | **1.681** / **0.678** | **1.050** / 0.590 |
  | runQ4（Q4/Q3） | **1.826** / 0.665 | 1.775 / 0.680 | 3.043 / 0.541 | 1.826 / 0.611 |

- **Q3 关键**：oracle/within 把 raw 的 lift 0.908 提升到 **1.68/1.70**、AUC 0.500→**0.678**（within 0.567），
  证实**跨模式先验错序是排序坍塌的主因**；但两者都**<1.80（primary FAIL）**。原因：oracle 把 top decile
  全部压到 base 最高的 brawl（31.45%），而全局 base 18.59% → lift 上限 ≈ 31.45/18.59 = **1.69**；brawl
  内 within-rank 信号弱（Q3 各 mode raw lift 仅 brawl 1.59/event 1.65/pvp 1.81），单靠分层无法超过 1.70。
  即**模式先验是主因，但模式内信号不足以修复 lift≥1.80**（预注册 fallback 分支：oracle<1.80 → 模式内信号不足）。

  Q3 per-mode raw（launched 行）：

  | mode（Q3） | rows | fired | hits | baseHitRate | meanProbC | lift（raw） |
  |---|---|---|---|---|---|---|
  | brawl | 74 | 248 | 78 | **31.45%** | 1.58% | 1.59 |
  | event | 95 | 302 | 47 | 15.56% | 4.30% | 1.65 |
  | pvp | 72 | 257 | 25 | 9.73% | 5.07% | 1.81 |

- **label-free 失败**：adapt(Q2) 里没有 brawl（Q3 新增模式），fallback 用 Q2 全局 base 9.98%；Q2 event base 26.09%
  又被当成 Q3 event 先验（实际 15.56%）→ top decile 偏向 event/pvp 而漏掉 brawl → lift 只有 **1.050**。
  说明**按模式先验校准需要目标窗（或近端）模式 base 估计，不是 label-free 可得**；若用上一窗 prior，反而
  可能把新模式的排序带错。
- **Q2/Q4 对照（非普遍更优）**：Q2 raw 3.005 已很好，oracle 换先验反而降到 2.572（raw 的跨模式排序更准）；
  Q4 oracle 到 **3.043**（pvp top 分位命中 53.6%），但 AUC 0.541 < raw 0.665——在小样本上 lift 与 AUC 张力明显，
  不能单看 lift 判定“修复”。
- **判定**：**primary FAIL**（Q3 oracle 1.681 <1.80；within 1.703 也 <1.80），label-free adapt-prior 1.050；
  模式先验确为 Q3 排序坍塌主因（AUC 修复证据），但**分层/先验归一化不能把 lift 修到 ≥1.80**（模式内信号不足），
  且 label-free 方案因新模式缺失而失效 → **不推部署/总分**。
- **局限**：oracle 用 test 标签（上界不可部署）；Q3 仅 241 launched/807 fired，Q4 139/499；单 seed、3 窗；
  模式粒度只做 gameMode（未联合 map/ship）；lift 与 AUC 在小样本上不一致；描述性、无因果识别；ε 固定 1e-3
  未扫；label-free fallback 策略未调。
- **下一步**：① 分层用 mode+map+shipClass 多级先验；② 目标窗/近端先验估计（延迟标签或滚动窗口）替代
  label-free；③ 先验/温度按窗重校准（另立预注册），并同时报 AUC 与 CI 下界；④ walk-forward 门禁不只看
  lift；⑤ 鱼雷保持诊断-only。
- **产物**：`scripts/experiments/torpedo_mode_stratification.py`（--selftest）；
  `out/torpedo_model/e26e-u/{mode_stratification.json, mode_stratification_report.md}`；预注册
  `e26e-u-preregistration.md`。
### E26e-v · 多级 cell 先验 + 历史/滚动 label-free 先验能否修 Q3（**primary PASS**：Q3 oracle-cell 2.010 ≥1.80；**secondary FAIL**：historical 0.680 / rolling 0.665 <1.80 → label-free 不可部署；不重训）

- **问题（预注册 `out/torpedo_model/e26e-v-preregistration.md`，descriptive）**：E26e-u 的 mode-level oracle
  只到 1.681（<1.80），因 top decile 全落 brawl（31.45%/18.59% → 上限≈1.69）。本任务把先验粒度细化到
  **cell = gameMode|mapName|shipClass**，检验：① test-label oracle cell 先验能否把 Q3 global lift 修到 ≥1.80；
  ② 可部署的 historical（前序所有 block）/rolling（仅前一 block）label-free 先验是否也能过线。不重训。
- **方法（Q2/Q3/Q4 launched 行）**：raw probC；within-cell rank（cell 内百分位，不加先验）；**oracle-cell**
  = test block cell base（cell n>=5，否则 mode base，再回退 global）+ ε·within-cell rank；**historical-cell** =
  仅用 test block 之前所有 block 的 cell base，经验贝叶斯平滑 (hits+20·global)/(fired+20)，cell→mode→global
  逐级回退，+ ε·within-cell rank；**rolling-cell** 同法但仅前一 block；mode-level 对照；coverage/per-cell 明细。
  脚本 `scripts/experiments/torpedo_cell_prior.py`（含 `--selftest`：cell key/平滑/fallback/rank/确定性）。
- **三窗结果（global lift / AUC）**：

  | 窗口 | raw | within-cell | **oracle-cell** | historical-cell | rolling-cell |
  |---|---|---|---|---|---|
  | runQ2 | **3.005** / 0.636 | 2.153 / 0.597 | **3.064 / 0.693** | 1.518 / 0.555 | 1.518 / 0.555 |
  | **runQ3** | **0.908 / 0.500** | 0.856 / 0.560 | **2.010 / 0.719** | **0.680 / 0.499** | **0.665 / 0.495** |
  | runQ4 | 1.826 / 0.665 | 2.029 / 0.638 | 1.683 / 0.674 | 2.331 / 0.538 | 2.331 / 0.519 |

  coverage：Q2 57 cells/25 个 n>=5（250/329 行）；**Q3 43 cells/19 个 n>=5（176/241 行）**；Q4 36/11（73/139）。
- **Q3 解读（primary PASS）**：oracle-cell 把 lift 0.908→**2.010**、AUC 0.500→**0.719**，超过 1.80 →
  **cell 粒度先验足以修复全局 lift**（E26e-u 的 mode 粒度 1.68 → cell 2.01）。oracle top decile（24 行）
  集中在高 base 的 brawl/event cell：brawl|46_Estuary|Cruiser 57.7%、brawl|53_Shoreside|Battleship 58.3%、
  brawl|23_Shards|Destroyer 50.0%、event|15_NE_north|Cruiser 31.6% 等；top decile hit rate 39.1% vs base 18.6%。

  Q3 cell 明细（n>=5，按 fired 排序；meanProbC 为 raw 分数量级）：

  | Q3 cell（n>=5，按 fired 排序） | rows | fired | hits | base | meanProbC | lift(raw) |
  |---|---|---|---|---|---|---|
  | brawl\|spaces/53_Shoreside\|Cruiser | 19 | 63 | 9 | 14.3% | 1.2% | 0.00 |
  | event\|spaces/42_Neighbors\|Cruiser | 15 | 53 | 15 | 28.3% | 6.9% | 1.18 |
  | pvp\|spaces/53_Shoreside\|Destroyer | 14 | 51 | 4 | 7.8% | 2.7% | 8.50 |
  | event\|spaces/16_OC_bees_to_honey\|Cruiser | 13 | 43 | 5 | 11.6% | 3.3% | - |
  | brawl\|spaces/14_Atlantic\|Destroyer | 10 | 39 | 13 | 33.3% | 1.7% | - |
  | brawl\|spaces/46_Estuary\|Battleship | 12 | 30 | 9 | 30.0% | 1.6% | - |
  | brawl\|spaces/46_Estuary\|Cruiser | 7 | 26 | 15 | 57.7% | 1.9% | - |
  | brawl\|spaces/53_Shoreside\|Battleship | 3 | 12 | 7 | 58.3% | 1.3% | - |

- **Q3 label-free 失败（secondary FAIL）**：historical 用 Q1+Q2（577 launched/95 cells）但 **Q1+Q2 无 brawl 模式/
  cell**（25 个 Q3 test cell 完全缺失，含全部 brawl cell），只能回退 global→lift **0.680**、AUC 0.499；
  rolling（仅 Q2）更差 **0.665**、AUC 0.495。说明**新模式的 cell 先验在历史数据中不存在**，label-free
  历史先验无法覆盖 mode/cell 轮换；符合预注册“oracle 过而 label-free 不过 → 需目标窗/延迟标签先验，不能部署”。
- **Q2/Q4 对照**：Q2 oracle 3.064 ≥1.80（raw 已 3.005），historical 1.518（Q1 无 Q2 新 cell）；Q4 oracle
  **1.683 <1.80**（cell 样本更薄：n>=5 只覆盖 73/139 行），但 historical/rolling 2.331（Q1–Q3 累积先验，
  仅 139 launched、AUC 0.519–0.538，lift 由少数高 base brawl cell 驱动）→ **小样本上 lift 与 AUC 张力明显**，
  不能仅凭 lift 判“修复”。
- **判定**：**primary PASS**（Q3 oracle-cell 2.010 ≥1.80，cell 先验可修全局 lift）；**secondary FAIL**
  （Q3 historical 0.680 / rolling 0.665 <1.80，label-free 不可部署）。结论：**cell 级先验是修复 Q3 全局
  lift 的有效方向，但依赖目标窗（或延迟标签/近端滚动）的 cell base 估计**；仅用历史 label-free 先验在
  mode/cell 轮换下失效。不重训、不推部署/总分。
- **局限**：oracle 用 test 标签（上界不可部署）；Q3 仅 241 launched/807 fired，cell 内 n 小（n>=5 只覆盖
  176/241 行）；cell 粒度未含 tier/多舰种；α=20、ε=1e-3 固定未扫；单 seed/3 窗；label-free fallback 策略未调；
  lift/AUC 在小样本不一致；描述性、无因果识别。
- **下一步**：① 目标窗/近端 cell base 估计（延迟标签、滚动窗口、分层 EB 收缩）；② cell 再细分（tier/
  多舰种组合）与 fallback 改进（mode→map→class 层次）；③ 先验+温度按窗重校准并同时报 AUC/CI 下界；
  ④ walk-forward 门禁不只看 lift；⑤ 鱼雷保持诊断-only。
- **产物**：`scripts/experiments/torpedo_cell_prior.py`（--selftest）；
  `out/torpedo_model/e26e-v/{cell_prior.json, cell_prior_report.md}`；预注册 `e26e-v-preregistration.md`。
### E26e-w · 延迟标签/在线 cell 先验自适应（**primary FAIL**：Q3 early-20% eval lift 1.464 <1.80（AUC 0.645）；early-40% 1.087 <1.80；oracle 2.527 上界；不重训）

- **问题（预注册 `out/torpedo_model/e26e-w-preregistration.md`，descriptive）**：E26e-v 证明 test-label
  oracle cell 先验可把 Q3 修到 2.010（eval 子集 2.527），但历史/滚动 label-free 只有 0.68/0.67。本任务检验
  更现实的**在线/延迟标签**方案：用 test block 内**最早 20%/40% launched 行**的已得标签估 cell base，
  对其余 80%/60% 打分；不重训。
- **方法**：launched 行按战斗时间 t 升序；早段 20%/40% 用于 cell base 估计（EB (hits+α·early_global)/
  (fired+α)，α=20；cell→mode→block-global 回退）；eval 行 score = 估计 cell prior + ε·within-cell probC
  rank（rank 仅用 eval 行，ε=1e-3）。同一 eval 子集对照 raw probC、oracle 全 test-cell prior（上界）、
  historical（前序 block）/rolling（前一 block）。脚本 `scripts/experiments/torpedo_online_prior.py`
  （含 `--selftest`：时间排序/早段估计/回退/rank/确定性）。
- **三窗结果（eval 子集：raw vs early-20/40 vs oracle；lift / AUC）**：

  | 窗口 | launched / eval | raw(eval) | **early-20%** | **early-40%** | oracle(eval) | historical-20 | rolling-20 |
  |---|---|---|---|---|---|---|---|
  | runQ2 | 329 / 263 | 3.152 / 0.638 | 0.816 / 0.539 | 0.275 / 0.562 | 3.594 / 0.692 | 1.715 | 1.715 |
  | **runQ3** | 241 / 193 | 0.682 / 0.526 | **1.464 / 0.645** | **1.087 / 0.549** | **2.527 / 0.722** | 0.630 | 0.776 |
  | runQ4 | 139 / 111 | 1.623 / 0.704 | 0.930 / 0.598 | 0.697 / 0.537 | 1.386 / 0.661 | 2.559 | 2.559 |

- **Q3 coverage/证据**：early-20% = 48 launched/178 fired/28 cells；eval 193 行（629 fired），其中 139 行有
  早段 cell 覆盖、54 行仅 mode 回退、0 行 global-only；早段 mode base brawl 27.8%/event 13.7%/pvp 12.8%
  vs eval brawl 32.1%/event 16.4%/pvp 9.1%。early-20% 把 raw eval 0.682→**1.464**、AUC 0.526→**0.645**
  （先验方向有效），但 **<1.80**；early-40%（96 行/320 fired/37 cells、eval 145 行）反而降到 **1.087**/AUC 0.549
  （eval 子集更小/时间组成变化，估计噪声更大）。**oracle 全标签同 eval 子集 2.527/0.722** 说明 cell 先验
  本身能到 2.5，但 20–40% 的延迟标签量不足以把 lift 修到 1.80。
- **Q2/Q4**：在线早段先验同样不优于 raw（Q2 early20 0.816 vs raw 3.152；Q4 0.930 vs raw 1.623），
  oracle(eval) 3.594/1.386；historical/rolling 在 Q2/Q4 反而 >1.7（Q2）与 >2.4（Q4，139 launched 小样本）。
- **判定**：**primary FAIL**（Q3 early-20% eval lift 1.464 <1.80；AUC 0.645 >0.55 满足）、**secondary FAIL**
  （early-40% 1.087 <1.80、AUC 0.549 <0.55）→ 按预注册记录 **延迟标签量/估计不足**：Q3 241 launched 中
  early 20%/40% 仅 48/96 行、28/37 cells，cell 级先验估计过稀；oracle 2.53 仍为参照。**不调线/不重训/不推部署**。
- **局限**：早段按 t 切分与战斗阶段/模式组成相关（Q3 早段 brawl 27.8% vs eval 32.1%），非随机；eval 子集
  与全 block 不同（Q3 raw 全 0.908 vs eval 0.682）；cell 内 n 小；α=20/ε=1e-3 固定未扫；单 seed/3 窗；
  标签延迟假设为“早段已得标签”，未建模真实回填延迟；描述性、无因果识别。
- **下一步**：① 早段+历史先验的**层次 EB/混合**（不是二选一）；② 扩大早段比例或跨 replay 滚动聚合；
  ③ 建模真实延迟回填（标签到达时间），并做在线校准；④ walk-forward 门禁同时要求 AUC/CI 下界；
  ⑤ 鱼雷保持诊断-only、不推部署/总分。
- **产物**：`scripts/experiments/torpedo_online_prior.py`（--selftest）；
  `out/torpedo_model/e26e-w/{online_prior.json, online_prior_report.md}`；预注册 `e26e-w-preregistration.md`。
### E26e-x · 层次化 early+历史/模式 EB 先验（**primary PASS**：Q3 early-20% 变体 B 1.835 ≥1.80、AUC 0.678；但 early-40% 1.384 与其他窗不稳；不重训）

- **问题（预注册 `out/torpedo_model/e26e-x-preregistration.md`，descriptive）**：E26e-w 的 early-cell 先验
  （A）在 Q3 只到 1.464（early-20%）/1.087（early-40%），oracle 2.527。本任务检验**层次化 EB 收缩 + 历史
  回填**能否弥补 20% 延迟标签量：

  | 变体 | 先验构造 |
  |---|---|
  | A | early cell EB α=20 toward early global；fallback early mode→early global（E26e-w 基线） |
  | **B（primary）** | cell→mode 层次 EB α=50：cell 向 early mode base 收缩、mode 向 early global 收缩；缺失 early mode → 历史 mode → early global |
  | C | early cell + 同 cell 历史计数池化（α=20 toward early global）；缺失走 B |
  | D | early cell α=20；缺失 → 历史 mode → early mode → early global |

  评估：launched 按 t 升序，early 20%/40% 估先验，eval 段 score = prior + ε·within-cell probC rank；同 eval
  子集 raw/oracle 对照。脚本 `scripts/experiments/torpedo_hierarchical_prior.py`（含 `--selftest`）。
- **Q3 变体表（eval 子集，lift / AUC）**：

  | Q3 early | raw | A | **B（primary）** | C | D | oracle |
  |---|---|---|---|---|---|---|
  | 20%（48 launched/178 fired/28 cells；eval 193） | 0.682 / 0.526 | 1.464 / 0.645 | **1.835 / 0.678** | 0.678 / 0.622 | 1.464 / 0.655 | 2.527 / 0.722 |
  | 40%（96/320/37；eval 145） | 0.808 / 0.546 | 1.087 / 0.549 | **1.384 / 0.615** | 1.292 / 0.584 | 1.087 / 0.572 | 2.478 / 0.716 |

  coverage（Q3-20%）：A/B = cell 139 行/mode 54；C = cell 160/mode 33；D = cell 139/历史 mode 29/early mode 25；
  early mode base brawl 27.8%/event 13.7%/pvp 12.8% vs eval brawl 32.1%/event 16.4%/pvp 9.1%。
- **判定**：**primary PASS**（Q3 early-20% B lift **1.835 ≥1.80**、AUC **0.678 >0.55**）——层次 EB 把 cell 先验
  向 early mode base 收缩（brawl/cell 的早期 base 高于全局）使排序更稳。**secondary 不成立/不稳定**：
  early-40% B 仅 **1.384 <1.80**（A 1.087/C 1.292/D 1.087）；A/C/D 在 early-20% 均 <1.80；Q2 early-20% B
  **0.816**（raw 3.152）、Q4 B **0.799**（raw 1.623），而 Q4 C 1.315/D **2.612**、Q4-40 C 1.540/D 1.921、
  Q4-40 B **0.0**（top decile 命中 0）——小样本/单窗波动大。→ **层次 EB 只在 Q3 early-20% 过线，不能宣称
  延迟标签自适应已解决，也不能部署/总分**；E26e-w 的“延迟标签量不足”结论在 40% 与 Q2/Q4 仍成立。
- **局限**：Q3 eval 仅 193 行（early 48）、Q4 111/83，单 seed/3 窗；early 按 t 非随机；α=20/50、ε=1e-3
  固定未扫；cell 稀疏（Q3 28 cells early）；Q4/B 出现 0.0 与 C/D 高值均不可靠；oracle 用 test 标签（上界）；
  描述性、无因果识别。
- **下一步**：① 在更多 replay/seed 上复核 B（尤其 Q3-20% 1.835 是否稳定）；② B+C 融合（层次收缩+历史池化）
  与按窗 α 校准；③ 用真实回填延迟（非按 t 切分）建模；④ walk-forward 门禁同时要求 AUC/CI 下界与跨窗
  一致性；⑤ 鱼雷保持诊断-only、不推部署/总分。
- **产物**：`scripts/experiments/torpedo_hierarchical_prior.py`（--selftest）；
  `out/torpedo_model/e26e-x/{hierarchical_prior.json, hierarchical_prior_report.md}`；预注册
  `e26e-x-preregistration.md`。
### E26e-z · 外部独立 replay holdout 评估（T4 torp4，不重训）（**headB 诊断门禁 FAIL**：AUPRC 1.862×base <2.0；top 2.429；AUC 0.602；headC 1.9896/ρ 0.596/CI [0.0,5.36] 描述性）

- **目的（预注册 `out/torpedo_model/e26e-z-preregistration.md`）**：用训练语料之外的外部 replay 检验已交付
  T4 torp4 r120 模型的时间/版本外推能力；**只评估、不重训、不调线**。trainer 新增 `--eval-only
  --eval-checkpoint`：恢复 checkpoint 的 model/hidden/feature_set/extra_dim，用现有 loader 加载外部
  dataset/click/outcome，输出 headA/B/C 与 headC outcome lift/ρ/CI；不写 OOF/checkpoint/ONNX。
- **实际数据（与 Lead 声明有差异，按实际导出记录）**：staged 23 个文件中 **5 个导出 0 行**（含 2026-09-17 两局 ocean），有效 **18 replay / 17,054 行**、日期
  **2026-10-31..2026-11-08**（Lead 原述 23 replay/2026-09-17..11-08；缺失的早期 replay 未包含在本批导出）；
  模式 pve 9,822 / event 5,671 / pvp 766 / cooperative 795；船级 Destroyer 2,291 / Cruiser 6,053 /
  Battleship 3,425 / Submarine 1,887 / unknown **3,398（20%）**。canLaunch 3,026、launched（labelB=1）37、
  其中 firedFish **115**/hits **17**（base 14.78%）；sidecar 全行 fired 887/hits 42 含 labelB=null 行的鱼雷
  发射，**headC 标准口径只用 37 个 launched 行（115/17）**。
- **结果（checkpoint sha `4f393554…`，T4 r120；raw sigmoid，温度未应用）**：

  | 头 | 指标 | 值 | 对照（in-dist T4） |
  |---|---|---|---|
  | headA | AUPRC / AUC / ECE | 0.9786 / 0.9979 / 0.0628 | — |
  | **headB** | 3,026 can-launch 行 / 37 正（base 1.223%） | AUPRC **0.022762（1.862×base）**；top-decile **2.429**；AUC **0.6017**；ECE 0.0168 | in-dist 2.599×base / top 2.905 / AUC 0.7273 |
  | headC（行级） | 37 launched / 5 正 | AUPRC 0.256 / AUC 0.675 / ECE 0.069 | in-dist 0.2656 / 0.7208 |
  | **headC outcome（r120）** | 37 行 / 115 fired / 17 hits / base 14.78% | **lift 1.9896**；ρ **0.5963**；CI **[0.0, 5.359]**（8 replay clusters） | in-dist 2.1997；temporal Q3 0.908 / Q4 1.826 |

- **判定**：**primary（诊断门禁）FAIL**——headB top-decile 2.429 ≥1.5 通过，但 **AUPRC 1.862×base <2.0**；
  且 AUC **0.6017** 明显低于 in-dist 0.7273。headC r120 outcome **1.9896（<2.30，描述性；CI 极宽）**，
  不硬判。→ 外部批次（以 **pve/event/cooperative** 新地图/新模式为主、20% unknown 船级）出现明确的
  **版本/时间/模式外推退化**，记录为外部 holdout 上限；不重训、不调线，不推部署/总分。
- **说明**：headC CI 的标准 `bootstrap_cluster` 因 37 行小样本出现 0-base replicate 产生 NaN 分位，
  eval-only 已加守卫并回退到本地逐 replicate 重排 decile（实现字段记录 `local per-replicate decile
  recomputation`）；CI 下界 0.0 反映样本量极限，不宜作强结论。
- **局限**：实际仅 18 replay/37 launched/115 fired，CI 极宽；单一 post-training batch（且非 Lead 所述
  23 replay/09-17..11-08 的完整集合）；模式以 pve/event/cooperative 为主，与训练 competitive 语料分布
  差异大；20% 船级 unknown；raw sigmoid 未经 T4 温度校准；标准 bootstrap 不可用而回退 local；描述性、
  无因果识别。
- **下一步**：① 按原计划重导出 23 replay（含 2026-09-17..10-30）再评一次；② 多外部批次/赛季、按模式分层；
  ③ headB 门禁在外部批次未过 → 需先解决版本/模式漂移（或在外部批次上重校准/重训，另立预注册）；
  ④ 鱼雷保持诊断-only。
- **产物**：`out/torpedo_model/e26e-z/{dataset_external.jsonl, click_external.jsonl, outcome_external.jsonl,
  eval_metrics.json, eval.log}`；trainer `--eval-only`（含 `--selftest` 覆盖参数/checkpoint 校验/退化 CI）；
  预注册 `e26e-z-preregistration.md`。
### E26e-aa · 外部 holdout 分层诊断（mode/map/class/version）（**headB FAIL 集中在 event 模式**：event 1.357×/top 0/AUC 0.553；pve 3.558×、cooperative 3.439×、pvp 5.342×（仅 3 正，样本不足）；非 pvp 1.857×；headC 1.99 描述性）

- **目的（预注册 `out/torpedo_model/e26e-aa-preregistration.md`，descriptive）**：E26e-z 外部整体 headB
  1.862×base（<2.0 门禁 FAIL）；本任务判断失败是**集中在 pve/event/cooperative（领域/模式漂移）**，
  还是 pvp/competitive 子集也退化；不重训、不调线、不部署。
- **方法**：trainer eval-only 新增 `--eval-predictions-out`（npz：probA/B/C、labelA/B、fired/hits、replayId/
  t/shipId/rowIndex；不写 OOF/checkpoint/ONNX；`--selftest` 覆盖 schema）；在 node3 重跑写
  `out/torpedo_model/e26e-aa/eval_predictions_external.npz`；新脚本 `torpedo_external_stratify.py` 按
  gameMode / mode group（pvp vs non-pvp）/ replayVersion / shipClass / mapName / 日期分层，headC outcome
  仅在 launched≥10、fired≥20、hits≥5 时报告，否则描述性。
- **数据分布（18 replay / 17,054 行，2026-10-31..11-08）**：模式 pve 9,822 / event 5,671 / pvp 766 /
  cooperative 795；版本 15,9,0,0 11,586 / 15,10,0,0 5,468；船级 Destroyer 2,291 / Cruiser 6,053 /
  Battleship 3,425 / Submarine 1,887 / unknown 3,398。**s12_WW2_OP1（5,499 行）+ e15_Bermuda_Triangle
  （3,398 行）共 8,897 行（52%）canLaunch=0（unknown 船级/新图），不参与 headB/headC 评估**——有效评估
  8,157 行。
- **整体（同 E26e-z）**：canLaunch 3,026 / 正样本 37；headB AUPRC 0.022762（**1.862×base**）、top 2.429、
  AUC 0.6017；headC r120 outcome **1.9896**/ρ 0.596/CI [0.0,5.36]（37 launched/115 fired/17 hits）。
- **分层结果（headB；headC 仅样本足够时）**：

  | stratum | rows | canLaunch (pos) | launched/fired/hits | headB AUPRC (×base) | top | AUC | headC outcome |
  |---|---|---|---|---|---|---|---|
  | **overall** | 17,054 | 3,026 (37) | 37/115/17 | 0.022762 (**1.862×**) | 2.429 | 0.6017 | 1.99 / ρ 0.596 / [0,5.36] |
  | mode=pvp | 766 | 292 (3) | 3/10/5 | 0.05489 (**5.342×**) | 3.244 | **0.810** | 样本不足 |
  | mode=pve | 9,822 | 1,182 (18) | 18/58/10 | 0.05419 (**3.558×**) | **3.863** | 0.630 | 4.97 / [0,4.97]（18 行，不稳） |
  | mode=event | 5,671 | 1,209 (10) | 10/29/0 | 0.01122 (**1.357×**) | **0.0** | 0.553 | 样本不足（0 hits） |
  | mode=cooperative | 795 | 343 (6) | 6/18/2 | 0.06015 (**3.439×**) | 1.633 | 0.740 | 样本不足 |
  | group=non-pvp | 16,288 | 2,734 (34) | 34/105/12 | 0.02310 (1.857×) | 2.641 | 0.593 | 3.28 / [0,5.52] |
  | version=15,10,0,0 | 5,468 | 1,012 (11) | 11/31/7 | 0.03024 (2.782×) | 1.804 | 0.648 | 0 / [0,0]（11 行） |
  | version=15,9,0,0 | 11,586 | 2,014 (26) | 26/84/10 | 0.02413 (1.869×) | 1.15 | 0.584 | 3.15 / [0,7.71] |
  | class=Destroyer | 2,291 | 1,006 (7) | 7/27/5 | 0.01089 (**1.565×**) | 1.423 | 0.623 | 样本不足 |
  | class=Cruiser | 6,053 | 1,443 (19) | 19/54/6 | 0.02675 (2.032×) | 2.095 | 0.530 | 样本不足 |
  | class=Battleship | 3,425 | 421 (4) | 4/8/0 | 0.02056 (2.164×) | 2.448 | 0.681 | 样本不足 |
  | class=Submarine | 1,887 | 156 (7) | 7/26/6 | 0.10203 (2.274×) | 2.786 | 0.657 | 样本不足 |
  | map=s09_LePVE | 4,323 | 1,182 (18) | 18/58/10 | 0.05419 (3.558×) | 3.863 | 0.630 | 4.97 / [0,4.97] |
  | map=16_OC_bees | 760 | 292 (3) | 3/10/5 | 0.05489 (5.342×) | 3.244 | 0.810 | 样本不足 |
  | map=44_Path_warrior | 490 | 218 (5) | 5/17/2 | 0.18136 (7.907×) | 3.964 | 0.820 | 样本不足 |
  | map=46_Estuary | 1,059 | 556 (5) | 5/19/0 | 0.01401 (1.558×) | 0.0 | 0.617 | 样本不足（0 hits） |
  | map=35_NE_north_winter | 515 | 377 (2) | 2/3/0 | 0.00490 (0.924×) | 0.0 | 0.204 | 样本不足 |
  | map=17_NA_fault_line | 699 | 276 (3) | 3/7/0 | 0.01697 (1.561×) | 0.0 | 0.535 | 样本不足 |

- **判定（descriptive）**：外部 headB FAIL **集中在 event 模式**（1.357×、top **0**、AUC 0.553；10 正/1,209
  can，10 launched/29 fired/**0 hits**），event 地图（NE_north_winter 0.924×/top 0、Estuary 1.558×/top 0、
  fault_line 1.561×/top 0）同样弱；**pve/cooperative 子集反而 >2.0×**（3.558×/3.439×），pvp 子集数值最高
  （5.342×/AUC 0.810）但**只有 3 个正样本、3 launched，统计上不能判**（预注册已允许只作描述）。因此
  **不能写成“所有非 pvp 都退化”，也不是 pvp 已证实稳健**——最明确的结论是 **event 模式/部分地图 + DD 船级
  （1.565×）驱动整体 FAIL**；headC 仅 pve 18 行达到报告门槛（4.97，CI 不稳），pvp/event/cooperative 样本
  不足。→ 记录为**领域/模式/版本条件化（mode-conditioned）依据**，不重训/不调线/不部署，鱼雷保持诊断-only。
- **局限**：整体仅 37 正（pvp 3/event 10/pve 18/coop 6），CI 极宽、分层指标不稳；52% 行 canLaunch=0
  （unknown 船级/新图 s12_WW2_OP1/e15）未参与评估；单批次、两版本；raw sigmoid（温度未用）；event 0 hits
  使 headC 无法评；描述性、无因果。
- **下一步**：① 补 pvp/competitive 外部 replay（当前 3 正不够）；② 在更多外部批次复核 event/DD 弱项；
  ③ 若做 mode/版本条件化（另立预注册），先解决 event 模式与 unknown 船级（new hulls）的覆盖；④ 重导出
  E26e-z 原计划的 23 replay（含 2026-09-17..10-30）；⑤ 鱼雷保持诊断-only。
- **产物**：trainer `--eval-predictions-out`（--selftest）；`out/torpedo_model/e26e-aa/`
  {eval_predictions_external.npz, eval_metrics.json, external_stratify.json, external_stratify_report.md}；
  `torpedo_external_stratify.py`（--selftest）；预注册 `e26e-aa-preregistration.md`。
### E26e-ab · 逐鱼 server 真值 schema 审计 + HP-drop magnitude 标签敏感性（**审计：per-fish server damage 不可识别**；magnitude：更严格标签 lift 单调升 2.20→3.08，但 top-decile 绝对命中率 17.96%→4.0–5.8%，行级近似不能替代逐鱼真值；不重训）

- **目的（预注册 `out/torpedo_model/e26e-ab-preregistration.md`，descriptive）**：① 审计 replay/outcome schema，
  判断能否得到**逐鱼 server 伤害**；② 在现有 r120 sidecar 上做 **HP-drop magnitude 行级标签变体**，
  看 headC 评估对“命中严重度”定义是否敏感。不重训、不调线。
- **审计结论（完整证据 `out/torpedo_model/e26e-ab/schema_audit.md`，file:line）**：
  - `ShotKillEvent` 只有 `time/owner_id/hit_type/shot_id/terminal xyz`（stream.rs:236-247）——**无 victim、
    无 damage 数值**；终端位置只能按距离“猜”受害者。
  - `DamageStatSample` 是 **recorder 累计** 的 (weapon,category)/count/total（stream.rs:249-268），无 shotId/
    无 victim；E26e-m server 真值导出也只 filter weapon==7 & category==0 的 recorder 累计
    （fire_dataset.rs:3893-3928）→ 同一武器所有鱼/目标加总，**无法逐鱼拆**。
  - HP samples 是**每实体**时间线（stream.rs:35-38, 55-60），`hp_drops_by_entity` 只取相邻样本差 ≥50
    （fire_dataset.rs:2187-2206）——只能得到“实体总 HP drop”，**无来源**。
  - `build_torpedo_outcome_context` 按 (owner_id, shot_id) 把终端 join 最近前序 launch（fire_dataset.rs:
    3513-3576），终端在敌舰 120 units（约 700m）内且覆盖 **±0.4/0.6 s** 内 HP drop 才算 hit（3621-3719）；
    `torp_hp_lost_nearby` 对覆盖 drop **全量计入**（3700, 3706），文档明确 “FULL-credit ordinal proxy, NOT a
    damage ledger — crossfire inflates it exactly like E13”（3290-3310）→ **行级近似、非逐鱼真值**。
  - 可行路径：需协议/解码层新增 per-shot victim/damage 事件（当前无）；或 server 结算 API 的 per-ship
    ledger（仍非逐鱼）；或仅在“单鱼单目标、无交叉火力”干净子集做统计近似。**结论：当前数据 per-fish
    server damage 不可识别**。
- **magnitude 敏感性（e26e-g OOF C；launched 17,055 行 / fired 71,693；fired 不变）**：

  | 变体 | 定义 | hits | base | top-decile 命中率 | lift | ρ | 95% CI |
  |---|---|---|---|---|---|---|---|
  | **A** | 原 r120（对照） | 5,854 | 8.17% | 17.96% | **2.1997** | 0.9879 | [1.998, 2.378] |
  | B:1000 | hits>0 且 hp/hits ≥ 1000 | 1,411 | 1.97% | 5.14% | 2.6103 | 1.0 | [2.410, 2.831] |
  | B:2000 | ≥ 2000 | 1,174 | 1.64% | 4.53% | 2.7644 | 1.0 | [2.530, 3.034] |
  | B:3000 | ≥ 3000 | 1,067 | 1.49% | 4.34% | 2.9167 | 1.0 | [2.674, 3.207] |
  | B:5000 | ≥ 5000 | 937 | 1.31% | 4.02% | **3.0776** | 1.0 | [2.808, 3.374] |
  | C:1000 | hits>0 且 hp ≥ 1000 | 1,758 | 2.45% | 5.84% | 2.3820 | 1.0 | [2.198, 2.562] |
  | C:2000 | ≥ 2000 | 1,501 | 2.09% | 5.30% | 2.5299 | 1.0 | [2.338, 2.741] |
  | C:3000 | ≥ 3000 | 1,360 | 1.90% | 4.98% | 2.6242 | 1.0 | [2.416, 2.868] |
  | C:5000 | ≥ 5000 | 1,196 | 1.67% | 4.57% | 2.7374 | 1.0 | [2.518, 2.991] |
  | **D** | clean-terminal：hits == torpTerminalNear | 1,108 | 1.55% | 3.61% | **2.3364** | 1.0 | [2.072, 2.587] |

  A 完全复现 E26e-g 的 2.1997 / ρ0.9879 / [1.998,2.378]（控制通过）。B/C 随阈值提高 lift **单调上升**
  （B 2.61→3.08；C 2.38→2.74；D 2.34），但 **top-decile 绝对命中率从 17.96% 掉到 3.61–5.84%**，hits 只剩 A 的
  16–30%。→ lift 上升主要是**标签变稀/base-rate 选择性**（同样 top decile 里严格命中更少），**不等于模型
  对逐鱼伤害更强**。
- **判定（descriptive）**：审计上 **per-fish server damage 不可识别**；magnitude 变体只说明 **r120 行级
  hit 定义对阈值敏感**（lift 2.20→3.08，但绝对命中率下降），**不能替代逐鱼真值、也不能作为“server 伤害
  学习”证据**。不重训、不调线、不部署；任何后续“逐鱼真值”必须先解决 schema/协议缺口。
- **局限**：`torpHpLostNearby` 是 full-credit 行级代理（crossfire 放大），非逐鱼；变体为 post-hoc 行级
  重定义；单一 E26e-g OOF/语料；ρ=1.0 是 decile 单调的产物；描述性、无因果；不做 2.30 判据。
- **下一步（逐鱼真值所需）**：① 协议/解码层新增 per-shot victim/damage 事件（含 shotId、victim、damage）
  才可能 true per-fish；② 或 server 结算 API 的 per-ship ledger（只能到船级）；③ 在“单鱼单目标、无交叉
  火力”干净子集做 attribution 偏差估计；④ 在此之前 magnitude 只作诊断/标签敏感性。
- **产物**：`out/torpedo_model/e26e-ab/{schema_audit.md, magnitude.json, magnitude_report.md}`；
  `scripts/experiments/torpedo_outcome_magnitude.py`（--selftest）；预注册 `e26e-ab-preregistration.md`。
### E26e-ac · 外部 event/DD 专项诊断（**机制：过预测/先验漂移（meanProbB 4.3–4.6× base、ECE 2.5–2.7pp）+ 区分不足（event AUC 0.553、DD 0.623、event|DD 0.349）；headC 因 0 hits/样本不足不可评**；不重训）

- **目的（预注册 `out/torpedo_model/e26e-ac-preregistration.md`，descriptive）**：E26e-aa 显示外部整体 headB
  1.862×base 不过门禁，最弱切片是 **event（1.357×/top 0/AUC 0.553）** 与 **DD（1.565×/top 1.423/AUC 0.623）**；
  本任务判断弱点是**区分（AUC）**、**先验/校准（meanProbB vs base、ECE）**，还是标签噪声/样本不足。
- **方法**：读 `eval_predictions_external.npz` + external dataset/click，join mode/class/map/version；交叉
  event/pve/cooperative/pvp × DD/Cruiser/BB/SS/unknown；报告覆盖/标签、headB AUPRC/top/AUC/ECE/meanProbB/
  分位、click/torp/enemy 特征均值/SMD、event maps；脚本 `torpedo_external_event_dd.py`（`--selftest`）。
- **覆盖/标签（mode）**：

  | mode | rows | canLaunch (pos) | launched/fired/hits | base |
  |---|---|---|---|---|
  | **event** | 5,671 | 1,209 (10) | **10/29/0** | 0.83% |
  | pve | 9,822 | 1,182 (18) | 18/58/10 | 1.52% |
  | cooperative | 795 | 343 (6) | 6/18/2 | 1.75% |
  | pvp | 766 | 292 (3) | 3/10/5 | 1.03% |
  | class=DD | 2,291 | 1,006 (7) | **7/27/5** | 0.70% |
  | class=Cruiser | 6,053 | 1,443 (19) | 19/54/6 | 1.32% |
  | class=BB | 3,425 | 421 (4) | 4/8/0 | 0.95% |
  | class=SS | 1,887 | 156 (7) | 7/26/6 | 4.49% |
  | class=unknown | 3,398 | **0** | 0/0/0 | — |

- **headB/校准表（discrimination vs prior）**：

  | stratum | base | meanProbB | Δ(mean−base) | ECE | AUC | top | AUPRC (×base) |
  |---|---|---|---|---|---|---|---|
  | **event** | 0.83% | **3.56%** | **+2.73pp** | **2.73pp** | **0.553** | **0.0** | 1.357× |
  | **DD** | 0.70% | **3.22%** | **+2.53pp** | **2.53pp** | **0.623** | 1.423 | 1.565× |
  | pve | 1.52% | 2.34% | +0.82pp | 0.90pp | 0.630 | 3.863 | 3.558× |
  | cooperative | 1.75% | 2.84% | +1.09pp | 1.09pp | 0.740 | 1.633 | 3.439× |
  | pvp | 1.03% | 2.50% | +1.47pp | 1.47pp | 0.810 | 3.244 | 5.342× |
  | Cruiser | 1.32% | 2.48% | +1.17pp | 1.17pp | 0.530 | 2.095 | 2.032× |
  | Battleship | 0.95% | 3.10% | +2.15pp | 2.15pp | 0.680 | 2.448 | 2.164× |
  | Submarine | 4.49% | 4.15% | −0.33pp | 0.33pp | 0.657 | 2.786 | 2.274× |

  → **event/DD 的 meanProbB 是 base 的 4.3–4.6 倍**（ECE 2.5–2.7pp，显著高于 pve 0.90pp/coop 1.09pp/pvp 1.47pp），
  同时 AUC 垫底（event 0.553、DD 0.623）→ **先验/校准漂移 + 区分弱双因素**；不是单一“标签噪声”解释。
- **mode×class 关键格**：**event|DD AUC 0.349**（低于随机）、meanProbB **4.01%** vs base **0.47%**（+3.54pp）、
  top 0、AUPRC 1.245×；event|Cruiser AUC 0.655/meanProb 3.14% vs base 1.01%（+2.13pp）/top 3.95；event|BB AUC
  0.689/meanProb 3.61% vs 1.03%（+2.58pp）/top 0；对照 cooperative|DD AUC 0.837/top 3.28、pvp|DD AUC 0.691、
  pve|Cruiser AUC **0.476**（低于随机，说明小样本格也会出现）→ **DD 并非在所有模式都弱，event×DD 最差**。
- **event maps**：Estuary 556 can/5 pos/AUC 0.617/meanProb 3.81% vs base 0.90%（+2.91pp）/top 0；fault_line
  276/3/AUC 0.535/3.68% vs 1.09%（+2.59pp）/top 0；NE_north_winter 377/2/AUC **0.204**/3.11% vs 0.53%（+2.58pp）/
  top 0；e15_Bermuda_Triangle 3,398 行全部 unknown 船级、canLaunch=0（不进 headB）→ event 有效评估实际只有
  ~1,209 canLaunch（Estuary+fault_line+NE_north_winter）。
- **特征差异（event vs 对照）**：event 敌人更少（1.86 vs pvp 3.30）、更近（3,070m vs 3,921m）、own 鱼雷射程
  更短（12.0km vs 18.3km）、click 更晚（lastAge 62s vs 3.4s）、unknown 船级 **59.9%**；DD vs 其他类：敌人更多
  （3.27 vs CL 1.78/BB 1.52/SS 1.05）、torpCount 更低（1.84 vs 2.31/3.27/6.09）、enemySpeed 更高（21.5 vs
  16.6/13.0）、click 更少（total 0.68 vs 1.49/1.67/5.07）→ event/DD 是**分布外模式/船级组合**，与训练分布
  （pvp/competitive）差异明显。
- **判定（descriptive）**：event/DD 弱 = **过预测/先验漂移（meanProbB 4.3–4.6× base、ECE 2.5–2.7pp）** +
  **区分不足（event AUC 0.553、DD 0.623、event|DD 0.349）**；headB 的 canLaunch 量（1,209/1,006）说明不是
  “样本太少”能完全解释；但 **headC 不可评**（event launched 10/29 fired/0 hits；DD 7/27/5；event|DD
  2/10/0）→ 无法区分标签噪声，只能记录为 headC 时间/模式外推上限。不重训、不调线、不部署；作为
  **mode/version 条件化或补 pvp/competitive 数据**的依据。
- **局限**：整体仅 37 正、event 10/0 hits，分层 CI 极宽；3,398 unknown 船级行 canLaunch=0 未进 headB；
  单批次/两版本；raw sigmoid（温度未用）；小样本格会出现 AUC<0.5（pve|Cruiser 0.476）；描述性、无因果。
- **下一步**：① 补 pvp/competitive 外部 replay（现 only 3 正）；② mode/版本条件化（先验/温度/训练）另立
  预注册；③ 重点排查 event|DD（AUC 0.349）与 event maps 的特征/标签覆盖；④ 重导出 E26e-z 原计划 23 replay；
  ⑤ 鱼雷保持诊断-only。
- **产物**：`scripts/experiments/torpedo_external_event_dd.py`（--selftest）；
  `out/torpedo_model/e26e-ac/{event_dd_diag.json, event_dd_report.md}`；预注册 `e26e-ac-preregistration.md`。
### E26e-ad · 训练语料内 event/DD 基线 vs 外部（**in-dist event/DD 不弱：event AUC 0.741/3.071×/top 2.963；DD 0.670/2.033×/top 2.401；event|DD 0.589；外部 event 0.553、event|DD 0.349 → 外部特有分布漂移，非模型固有**；不重训）

- **目的（预注册 `out/torpedo_model/e26e-ad-preregistration.md`，descriptive）**：E26e-ac 外部 event/DD 弱
  （event AUC 0.553、DD 0.623、event|DD 0.349）——需要判断是**模型本身弱**（in-dist 也弱）还是**外部特有**
  （分布漂移/新地图/新船级/版本）；不重训、不调线、不部署。
- **方法与数据**：E26e-g OOF 3,111,384 行/2,215 replay（probA/B/C、labelA/B/C、classCode/Names、regionCode、
  rowIndex）；流式读 full 4 shard dataset（rowIndex 顺序，shipId/t 逐行校验）取 gameMode/mapName；
  r120 outcome sidecars 取 fired/hits。脚本 `torpedo_indist_mode_class.py`（`--selftest`：合成 join/分桶/指标）。
- **in-dist 分布**：模式 pvp 3,054,751 / brawl 26,834 / event 15,003 / ranked 10,466 / pve 4,330（无
  cooperative）；船级 DD 1,831,164 行（can 466,730）/ Cruiser 1,040,934（465,559）/ BB 229,674（117,019）/
  SS 9,612（3,003）；4 region apac/eu/na/own。event 仅占 0.48%，但 canLaunch 7,242 足够评 headB。
- **in-dist event/DD vs 外部 E26e-ac（headB/校准/headC）**：

  | stratum | canLaunch (pos) | base | meanProbB | Δ/ECE | AUC | top | AUPRC (×) | headC launched/fired/hits | headC lift [CI] |
  |---|---|---|---|---|---|---|---|---|---|
  | **in-dist event** | 7,242 (118) | 1.63% | 3.83% | +2.20pp/2.25pp | **0.741** | 2.963 | **3.071×** | 118/358/59 | **1.756** [0.459,2.615]* |
  | **ext event** | 1,209 (10) | 0.83% | 3.56% | +2.73pp/2.73pp | **0.553** | **0.0** | 1.357× | 10/29/0 | 不可评（0 hits） |
  | **in-dist DD** | 466,730 (10,949) | 2.35% | 4.84% | +2.49pp/2.49pp | **0.670** | 2.401 | **2.033×** | 10,949/49,482/4,159 | **2.084** [1.871,2.321] |
  | **ext DD** | 1,006 (7) | 0.70% | 3.22% | +2.53pp/2.53pp | **0.623** | 1.423 | 1.565× | 7/27/5 | 不可评 |
  | **in-dist event|DD** | 1,208 (35) | 2.90% | 4.73% | +1.83pp/2.02pp | **0.589** | 1.997 | **2.497×** | 35/119/15 | 不可评（样本不足） |
  | **ext event|DD** | 425 (2) | 0.47% | 4.01% | +3.54pp/3.54pp | **0.349** | 0.0 | 1.245× | 2/10/0 | 不可评 |
  | in-dist overall | 1,052,311 (17,055) | 1.62% | 4.08% | +2.46pp/2.46pp | 0.727 | 2.905 | 2.599× | 17,055/71,693/5,854 | 2.1997 [1.998,2.378] |

- **in-dist headB by mode/class**：pvp 2.595×/AUC 0.727/top 2.898（can 1,027,566）；brawl 3.563×/0.750/3.312；
  ranked 3.092×/0.752/3.331；pve 4.162×/0.618/4.545（can 590/11 正）；event 3.071×/0.741/2.963；DD 2.033×/
  0.670/2.401；Cruiser 2.844×/0.734/3.146；BB 3.151×/0.748/3.333；SS 1.764×/0.686/1.877（101 正，样本小）。
  **event/DD 在训练语料内都有明确 headB 信号**；event|DD 是最难格子（AUC 0.589），但仍远高于外部 0.349。
- **headC in-dist**：overall 2.1997 [1.998,2.378]、pvp 2.109 [1.928,2.341]、DD 2.084 [1.871,2.321]；event
  118 launched/59 hits → **1.756 [0.459,2.615]\***（探索性 secondary 口径）；brawl 1.030 [0.488,1.966]\*；
  event|DD 35/119/15 低于门槛不可评；**外部 event 10 launched/0 hits 完全不可评** → 外部 event 的 headC
  连“是否存在”都无法检验，只能依赖 headB。
- **判定（descriptive）**：**in-dist event/DD 不弱**（headB 3.071×/2.033×，AUC 0.741/0.670），因此外部
  event/DD 弱（AUC 0.553/0.623、event|DD 0.349）**不是模型固有缺陷**，而是**外部批次/地图/版本/模式分布
  漂移**（event AUC 0.741→0.553、event|DD 0.589→0.349；DD 仅 0.670→0.623）。同时 **in-dist 全局存在过预测**
  （overall meanProb 4.08% vs base 1.62%、ECE 2.46pp，各 mode/class ECE 2.2–2.8pp）→ 校准偏移是**模型级**
  的，不是 event/DD 特有；外部 event/DD 绝对 ECE 相近（2.5–2.7pp），但外部 base 更低（0.83/0.70%），相对
  先验偏差更大（4.3–4.6× vs in-dist 2.0–2.5×）。→ 不重训、不调线、不部署；支持 **mode/version 条件化**或
  补外部 event/DD/pvp 数据，而非把 event/DD 当作模型坏掉的证据。
- **局限**：in-dist 是训练语料 OOF（非独立外部），外部仅 18 replay；event 占 in-dist 0.48%、无 cooperative；
  event headC 118 launched 的 CI 很宽（0.459–2.615）；event|DD 与外部 headC 均样本不足；r120 标签同源；
  描述性、无因果、不做 2.30 判据。
- **下一步**：① 预注册 mode/version 条件化（校准/温度或分模式重训）；② 补外部 event/DD 与 pvp/competitive
  replay；③ 复核外部 event 地图（Bermuda/Estuary/fault_line/NE_north_winter）与船级分布；④ 重导出 E26e-z
  原计划 23 replay；⑤ 鱼雷保持诊断-only。
- **产物**：`scripts/experiments/torpedo_indist_mode_class.py`（--selftest）；
  `out/torpedo_model/e26e-ad/{indist_mode_class.json, indist_mode_class_report.md}`；预注册
  `e26e-ad-preregistration.md`。
### E26e-ae · 交付温度（T4 T_B/T_C）下外部 holdout 校准评估（**headB baked 明显改善：ECE 1.68pp→0.24pp、Brier 1.236%→1.206%、logloss 7.15%→6.55%；headC 混合：ECE 6.94pp→5.81pp 但 Brier/logloss 略升；排序完全不变**；部署仍 T4 r120，不重训）

- **目的（预注册 `out/torpedo_model/e26e-ae-preregistration.md`，descriptive）**：T4 ONNX 对 headB logit
  `/T_B=0.7564`、headC logit `/T_C=1.0723`，但 E26e-z/aa/ac 的外部评估用的是 **raw sigmoid**，不是部署口径。
  温度是严格单调变换 → **排序指标（AUPRC/top/AUC/lift/ρ/CI）必然不变**，但 **ECE/Brier/logloss/meanProb**
  会变。本任务量化 raw vs baked 的校准差异；不重训、不调线、不部署。
- **代码**：trainer eval-only 新增 `--eval-temp-b/--eval-temp-c`（默认 0 = raw 不变；应用时
  `prob=sigmoid(logit/T)`，与 T4 ONNX 完全一致；`--selftest` 覆盖 identity/单调/方向/参数）。
- **协议**：同一 external corpus（17,054 行/18 replay）+ 同一 T4 r120 checkpoint（sha 4f393554…），
  node3 跑两次 eval-only：raw（无 temp）与 baked（T_B=0.7564、T_C=1.0723），输出 `out/torpedo_model/e26e-ae/`
  `{eval_raw.json, eval_bakedT.json, temperature_compare.json}`。
- **raw vs baked（同 17,054 行；headA 无温度）**：

  | head | metric | raw | baked T | Δ(baked−raw) |
  |---|---|---|---|---|
  | **headB** | ECE(15-bin) | 1.678pp | **0.240pp** | **−1.438pp** |
  | headB | Brier | 0.012360 | **0.012057** | −0.000303 |
  | headB | logloss | 0.071532 | **0.065472** | −0.006060 |
  | headB | meanProbB | 2.9006% | 0.9830% | −1.918pp（base 1.2227%；raw +1.678pp → baked −0.240pp） |
  | headB | AUPRC / top / AUC | 0.022762 / 2.429 / 0.6017 | 同 raw | **完全不变** |
  | **headC** | ECE(15-bin) | 6.939pp | **5.814pp** | −1.125pp |
  | headC | Brier | 0.118441 | 0.119294 | +0.000853 |
  | headC | logloss | 0.382606 | 0.386549 | +0.003943 |
  | headC | meanProbC | 18.031% | 19.303% | +1.272pp（base 13.514%；均过预测） |
  | headC | AUPRC / top / AUC | 0.255996 / 1.850 / 0.675 | 同 raw | **完全不变** |
  | headC outcome | lift / ρ / CI | 1.9896 / 0.5963 / [0,5.359] | 同 raw | **完全不变** |
  | headA | ECE / Brier / logloss | 6.280pp / 0.021860 / 0.100350 | 同 raw | 完全不变（A 无温度） |

- **排序不变校验**：probB/probC 的 argsort 逐行相同、probA 逐值相同、rank Spearman=1.0；headB
  AUPRC/top/AUC、headC AUPRC/AUC/outcome lift/ρ/CI **全部逐值相等**（`temperature_compare.json`）。
- **判定（descriptive）**：**headB 的 T_B 明显改善外部校准**（ECE −1.44pp、Brier −0.0003、logloss −0.0061；
  meanProb 从 2.90% 降到 0.98%，相对 base 1.22% 由 +1.68pp 过预测变为 −0.24pp 轻微低估），说明 T4 的 T_B
  在外部分布上仍然有用（虽是在 in-dist 拟合的）。**headC 的 T_C 混合**：ECE 改善 1.13pp，但 Brier/logloss
  反而略升（37 launched 行/5 正，样本极小；meanProb 18.0%→19.3% 仍远高于 base 13.5%）。**所有排序指标
  完全不变 → 外部 headB 门禁仍 FAIL（1.862×<2.0）、部署结论不变（T4 torp4 r120，仅评估口径修正）；不重训、
  不调线、不部署。**
- **局限**：单一外部批次（18 replay）；ECE 15-bin 在 headB 上全部落入第一 bin（ECE≈|mean−base|，bins 粗）；
  headC 仅 37 launched/5 正，Brier/logloss 差异无统计意义；温度在 in-dist 拟合，外部分布漂移下 T_B 的改善
  属经验观察；raw 与 baked 排序等价，研究排序指标继续用 raw 即可；描述性、无因果。
- **下一步**：① 部署/评估文档中的校准指标应报 **baked T** 视图，排序/门禁继续按 raw（等价）；② headC 的
  T_C 需要更多 launched 外部样本复核；③ 温度/先验条件化（mode/version）另立预注册；④ 部署仍 T4 r120，
  不重训、不改线；⑤ 鱼雷保持诊断-only。
- **产物**：trainer `--eval-temp-b/--eval-temp-c`（--selftest）；`out/torpedo_model/e26e-ae/`
  `{eval_raw.json, eval_bakedT.json, temperature_compare.json, raw.log, baked.log, pred_bakedT.npz}`；
  预注册 `e26e-ae-preregistration.md`。
### E26e-af · 外部 vs in-dist 特征漂移归因（**domain AUC 0.99–1.00：44 维特征几乎完美区分外部/in-dist；event top 漂移 = ownEnginePower/unknown 船级/torp 属性/engineDir/zone，event|DD = ally radar/hydro 可用性 + smoke/HP；由 unknown 60% + 全新 event 地图 + 遥测可用性差异驱动**；不重训）

- **目的（预注册 `out/torpedo_model/e26e-af-preregistration.md`，descriptive）**：E26e-ad 已证明外部 event/DD
  弱不是模型固有（in-dist event AUC 0.741、DD 0.670）；本任务定位**具体漂移特征**：按 mode/class 做 SMD、
  特殊范畴（unknown/map/mode/船级/几何）与 domain classifier，解释外部 event AUC 0.553 / event|DD 0.349 的
  排序失效。不重训、不调线、不部署。
- **数据/方法**：external 17,054 行 vs in-dist 3,111,384 行（**采样**：非 pvp 全收、pvp 每 10 行取 1 →
  362,109 行，保证 event 15,003/DD 197,140/event|DD 2,779 全覆盖）；用与模型相同的 torp3 **44 维**全局特征
  （core 27 + torp2 11 + torp3 6）；SMD = (external mean − in-dist mean)/pooled SD；domain classifier =
  logistic regression（44 维，标准化，80/20 split，3 seeds）；脚本
  `torpedo_external_feature_drift.py`（`--selftest`）。
- **domain classifier（in-dist vs external，held-out AUC）**：

  | subset | n/side | AUC mean | AUC range | top 系数（标准化） |
  |---|---|---|---|---|
  | overall | 17,054 | **0.990** | 0.989–0.990 | allyHydro +2.61, allyRadar −2.31, ownEnginePower +2.20, eventsShells +1.37, torp_speed −1.20 |
  | event | 5,671 | **0.997** | 0.997–0.998 | closest_in_range +2.72, allyHydro +1.77, in_range −1.74, allyRadar +1.64, t −1.64 |
  | DD | 2,291 | **0.991** | 0.990–0.993 | ownEnginePower +3.38, allyRadar −3.33, allyHydro +3.00, t −1.76, eventsShells +1.59 |
  | event\|DD | 667 | **1.000** | 1.000–1.000 | allyHydro +3.20, allyRadar +2.94, t −1.99, in_range −1.41, eventsShells +1.29 |
  | pvp | 766 | **1.000** | 1.000–1.000 | ownEnginePower +2.45, zonesOwnedOther −2.08, t −1.75, ownHpFrac −1.68 |

- **event top SMD（external vs in-dist mean）**：**ownEnginePower 0.244 vs −1.0（SMD 1.87）**、**cls_unknown
  0.599 vs 0（1.73）**、torp_speed_frac 0.339 vs 0.850（−1.63）、torp_detect_frac 0.172 vs 0.412（−1.47）、
  torp_damage_frac 0.367 vs 0.857（−1.42）、ownEngineDir 0.547 vs 0（1.33）、zonesOwned0 0.359 vs 0.046（1.21）、
  torp_count_frac 0.105 vs 0.257（−1.19）、in_range_enemies 0.167 vs 0.487（−1.10）、obs_enemies 0.114 vs 0.329
  （−1.06）、ownRangeM 0.401 vs 0.531（−0.98）；meta：enemyCount −0.89、enemyHpMean −0.85、observed −0.40。
- **DD top SMD**：ownEnginePower −0.25 vs −0.96（1.02）、zonesOwned0 0.229 vs 0.120（0.90）、**ownHpFrac 0.123
  vs 0.692（−0.86）**、ownEngineDir 0.299 vs 0.016（0.71）、reload_ready 0.78 vs 0.47（0.67）、eventsExplosions
  0.131 vs 0.031（0.63）、ownReloadFrac 0.874 vs 0.690（0.58）、t 0.228 vs 0.340（−0.55）；meta：observed +0.64。
- **event|DD top SMD**：**allyHydroCountFrac 0.234 vs −1.0（SMD 4.07）**、**allyRadarCountFrac 0.015 vs −1.0
  （4.00）**、ownEnginePower −0.161 vs −1.0（1.28）、activeSmokeArea 0.065 vs 0.170（−0.78）、smokeCount 0.051
  vs 0.155（−0.74）、zonesOwnedOther 0.023 vs 0.091（−0.70）、torp_damage 0.965 vs 0.821（0.58）、ownHpFrac
  0.432 vs 0.654（−0.51）；meta：enemyDist +1.17、observed −1.11。
- **特殊范畴**：external **unknown 船级 19.9%**（event **59.9%**；DD 0）vs in-dist 0%；event 的 **4 个地图在
  in-dist event 模式内均为首见**（e15_Bermuda_Triangle 3,398、Estuary 1,059、fault_line 699、NE_north_winter 515；
  其中 46/17/35 在 in-dist 其他模式可见，仅 e15 全 corpus 未见；E26e-ag 已更正此前“全 corpus 未见”的误写）；全 corpus
  unseen 地图 s09_LePVE 4,323 + e15 3,398；external 58 个 shipId 中 **15.5%** 在 in-dist 采样中未出现；mode 组成
  差异（external pve 9,822/event 5,671/coop 795/pvp 766 vs in-dist pvp 98%）；external own 鱼雷射程/属性/
  reload、敌人数量/距离/速度/HP/observed 与 in-dist 明显不同。
- **判定（descriptive）**：44 维特征即可几乎完美区分外部/in-dist（AUC 0.99–1.0）→ **外部 event/DD 的 headB
  失效与强协变量漂移一致**，top 嫌疑排序（非因果）：① **unknown 船级/event 模式内新地图**（event 60% unknown + 四图在 event 模式内首见；46/17/35 其他模式可见）；② **遥测可用性/sentinel 差异**（ownEnginePower/allyRadar/allyHydro/ownEngineDir 在 in-dist
  event/DD 大量为 −1（缺流），external 有值；coverage 均为 1.0 因为 −1 是有限值 → 特征是“不同含义”的输入）；
  ③ **真实玩法/目标几何漂移**（event 外部鱼雷射程/属性更低、敌人更少/更少 observed、爆炸事件更多；DD 外部
  HP 更低、reload 更就绪、爆炸更多；event|DD ally radar/hydro/smoke/HP 差异）。domain AUC 本身不能证明因果
  （mode/version/map 混淆），但支持 E26e-ad 的“外部/地图/版本分布漂移，非模型固有”结论；不重训、不调线、不部署。
- **局限**：in-dist 为采样（pvp 1/10、无 cooperative）；`coverage` 仅统计有限值，−1 sentinel 仍算覆盖，
  遥测可用性差异是漂移的一部分但未单独标记；未包含 torp4 click 5 维；domain classifier 描述性、受 mode/
  version/date 混淆；external 仅 18 replay；SMD/系数无因果；headB 门禁/部署不变。
- **下一步**：① mode/version 条件化（重训/校准）另立预注册；② **统一导出/遥测版本**（消除 −1 缺流与
  unknown 船级），再重跑外部评估；③ 补 in-dist 新地图/新船级（event）与更多 pvp/competitive 外部 replay；
  ④ 重导出 E26e-z 原计划 23 replay；⑤ 鱼雷保持诊断-only，部署仍 T4 torp4 r120。
- **产物**：`scripts/experiments/torpedo_external_feature_drift.py`（--selftest）；
  `out/torpedo_model/e26e-af/{external_feature_drift.json, external_feature_drift_report.md}`；预注册
  `e26e-af-preregistration.md`。
### E26e-ag · matched-domain 外部子集 + mode/version 条件化预注册（**matched 不恢复：1.405×/top 1.049/AUC 0.606（strict 1.365×/top 0）；unmatched novelty（pve s09）反而 3.558×；FAIL 不是 unknown/unseen-map novelty，而是 event 模式本身**；不重训）

- **目的（预注册 `out/torpedo_model/e26e-ag-preregistration.md`，descriptive）**：E26e-ac/af 显示外部
  event/DD 弱且 44 维 domain AUC 0.99–1.00、unknown 60%/新地图；本任务检验**把外部限制到 known class +
  seen map（+ seen mode/version）后 headB 是否恢复 ≥2.0×base**，量化 novelty 驱动；并只设计 mode/version
  条件化方案。不重训、不调线、不部署。
- **方法**：流式 in-dist 4 shard（3,111,384 行）收集 seen：65 maps、modes {pvp,event,pve,brawl,ranked}、
  versions ≤15,9；external 17,054 行（e26e-aa predictions + outcome）标记：`matched_mapclass` = known
  class ∧ map seen；`matched_strict` = + mode/version seen；`unmatched_novelty` = 其余。重算 headB/headC。
  脚本 `torpedo_external_matched.py`（`--selftest`）。
- **样本量（canLaunch/positives；launched/fired/hits）**：

  | subset | rows | canLaunch (pos) | headB AUPRC× | top | AUC | ECE | meanProb | headC lift |
  |---|---|---|---|---|---|---|---|---|
  | full | 17,054 | 3,026 (37) | 1.862× | 2.429 | 0.6017 | 1.678pp | 2.901% | 1.9896 (37/115/17) |
  | **matched_mapclass** | 9,333 | 1,844 (19) | **1.405×** | 1.049 | 0.6065 | 2.229pp | 3.259% | 0.0 (19/57/7) |
  | **matched_strict** | 7,263 | 832 (8) | **1.365×** | **0.0** | 0.5887 | 2.803pp | 3.765% | 不可评 (8/26/0) |
  | unmatched_novelty | 7,721 | 1,182 (18) | **3.558×** | 3.863 | 0.6299 | 0.901pp | 2.341% | 4.971 (18/58/10) |
  | knownclass_unseenmap | 4,323 | 1,182 (18) | 3.558× | 3.863 | 0.6299 | 0.901pp | 2.341% | 4.971 (18/58/10) |
  | unknownclass | 3,398 | 0 (0) | — | — | — | — | — | 0/0/0 |

  → `unmatched_novelty` = **pve s09_LePVE 4,323 行（can 1,182/18）+ event e15 unknown 3,398 行（can 0）**；
  **唯一强 headB 子集恰是“novel map”的 pve**，而 matched 去掉它后只剩 event/pvp/coop。
- **matched 内分解**：event 2,273 行/can **1,209/10 正 → 1.357×/top 0/AUC 0.553/ECE 2.733pp**；pvp 766/292/3 →
  5.342×/3.244/0.810/1.473pp；cooperative 795/343/6 → 3.439×/1.633/0.740/1.094pp；pve 5,499 行（s12_WW2_OP1）
  canLaunch=0（无 headB 样本）。version：15,9 7,263/832/8 → 1.365×/top 0/AUC .589/ECE 2.803pp；15,10
  2,070/1,012/11 → 2.782×/top 1.804/AUC .648（但 15,10 不在 in-dist seen versions，strict 排除；event 15,10
  只有 2 正）。
- **novelty 分解**：known class 13,656 / unknown 3,398；seen map 9,333 / unseen 7,721；matched 9,333、strict
  7,263、unmatched 7,721。**novelty 过滤使 full 1.862×→matched 1.405×（−0.457，更差）**，因为删掉的是
  pve s09（3.558×）而留下 event（1.357×）。
- **判定（descriptive）**：primary 问 matched 是否 ≥2.0× → **否**（1.405×；strict 1.365×/top 0）。因此
  **外部 headB FAIL 不是 unknown 船级/unseen map novelty 能解释的**；在 known class + seen map + seen mode/
  version 的 event 子集上仍 1.357×/top 0/AUC .553（与 full event 相同），说明是 **event 模式特异的域漂移**
  （版本/任务设计/遥测/目标几何，见 E26e-af），而非单纯覆盖缺口。pvp/cooperative matched 仍强（5.342×/
  3.439×）但正样本仅 3/6，不能作为恢复证据；headC matched 19/57/7 lift 0、strict 8/26/0 不可评。
  → 记录为**更深层模型/域漂移**（event 特异），不重训、不调线、不部署；mode/version 条件化只做设计（预注册），
  执行需满足数据/门禁条件。
- **mode/version 条件化预注册（只设计，不执行）**：数据需求（≥2 独立外部批次/赛季；每 mode/version ≥5 replay、
  ≥1,000 canLaunch、≥50 正；matched map/class 覆盖；遥测字段一致；walk-forward 切分）；候选（评估口径条件化 →
  per-mode/version 温度/先验校准（无重训）→ 仅当 matched 仍 <2.0 且数据满足才考虑条件化重训）；门禁沿用
  headB AUPRC≥2.0×/top≥1.5、校准不劣于 raw、headC 仅描述性、≥2/3 窗口通过；不改变既有验收线。
- **局限**：external 仅 18 replay；matched 正样本 19/8、pvp 3/coop 6，CI 极宽；in-dist seen map 集合含个别
  control-char 变体（精确字符串匹配）；pve s09 虽 novel map 但 headB 强，提示 PvE 场景/标签语义与部署域不同；
  matched 排除 pve s12（can 0）；headC 样本不足；描述性、无因果；不做 2.30 判据。
- **下一步**：① 补 matched 域内 event/DD/pvp 外部 replay（≥2 批次）；② 统一导出/遥测版本与船级覆盖后再评；
  ③ 按预注册条件执行 mode/version 校准（无重训）或条件化重训（需数据满足）；④ 重导出 E26e-z 23 replay；
  ⑤ 部署仍 T4 torp4 r120，鱼雷保持诊断-only。
- **产物**：`scripts/experiments/torpedo_external_matched.py`（--selftest）；
  `out/torpedo_model/e26e-ag/{external_matched.json, external_matched_report.md}`；预注册
  `e26e-ag-preregistration.md`（含条件化设计，不执行）。
### E26 研究总结：headC 上限与部署结论（截至 E26e-ag）

**一句话结论**：headC 的命中排序信号真实存在（r120 2.1997×、server 真值 2.3477×、r60 固定口径 2.6811×），但
**没有任何标签/特征/先验定义在独立时间窗上稳定 ≥2.30 且 CI 不重叠**；Q3 崩盘与后续自适应实验表明，当前证据
**只支持诊断、不支持并入总分**（研究收敛）。

**三条线证据（定义 / 结果 / 判定）**：

| 线 | 定义 | 结果 | 判定 |
|---|---|---|---|
| 标签 | r120（2.30 线） | 2.1997 | 低于 2.30 |
| 标签 | r60 固定模型（any@r60，2.68 线） | **2.6811，CI [2.438,2.930]** | 过线但仅边际（+0.0011），且是**评估口径**收益 |
| 标签 | r60 重训 | 2.6329（<2.68） | 重训未转化收益；r60 优势不可学习 |
| 标签 | server 真值标签（E26e-g proxy 模型评估） | **2.3477，CI [1.807,3.018]** | 真值下仍 >2.30，但样本小（710 recorder 行）、proxy 低召回 |
| 特征 | torp5 目标几何 | r120 2.2639；r60 cross 2.7631 | 边际增益，不跨 r120 2.30 |
| 时间/区域 | region holdout / random few-shot | region 1.3849；few-shot 25% 2.4859、40% 2.4413（饱和） | 同期随机拆分可到 2.49，但**非独立验证** |
| 时间/区域 | temporal walk-forward（Q2/Q3/Q4） | Q2 3.005 / **Q3 0.908** / Q4 1.826 | **Q3 崩盘**：时间外推不成立 |
| 时间/区域 | cell 先验 / delayed / hierarchical | cell oracle 2.010（label-free 仅 0.665–0.680）；delayed 20–40% 1.464/1.087；hierarchical Q3-20% 1.835（单窗） | 先验可修复但需目标窗/足够延迟标签；**单窗 PASS 不稳，不能外推** |

**上限解释（Q3 机制）**：Q3 崩盘 = **composition/prior shift**（brawl/event/map/ship 轮换，base 18.6% vs
Q2 10.0%）+ **跨模式先验错序**（pvp meanProbC 5.07% > event 4.30% > brawl 1.58%，真实 base 相反）+
**严重欠概率**（meanProbC 3.7% vs 18.6%、ECE 0.258）；模式内仍有弱排序（1.59–1.81）但被跨模式错序吞掉。
cell 粒度先验（oracle 2.010）可修复排序，但需**目标窗 cell base/足够延迟标签**；静态历史标签不足
（Q1+Q2 无 brawl cell、label-free 0.68/0.67；20–40% 延迟标签仅 1.46/1.09）。

**部署/总分决策（不变）**：T4 **torp4 r120 诊断包（PR #1868）**继续作为独立可选诊断，不改变总分；headB
诊断可用（top-lift 2.905、温度后 ECE 0.0006）；**headC 仍为诊断-only，不并入总分**；任何“修复”结论
（2.49/2.01/1.84 等）均为特定窗口/特定先验下的研究结果，**不构成部署依据**。**外部 holdout（E26e-z）**：T4 checkpoint 在 18 replay/17,054 行外部批次上 headB AUPRC **1.862×base（<2.0 门禁 FAIL）**、AUC **0.602**、top 2.429，headC outcome **1.9896**/CI [0.0,5.36] → 外部外推同样不支持部署；实际导出为 18 replay（非原述 23），需重导出复核。**外部分层（E26e-aa）**：FAIL 集中在 event 模式（1.357×/top 0/AUC 0.553），pve 3.558×、cooperative 3.439×，pvp 仅 3 正不能判；DD 1.565×、event 地图 top 0；52% 行 canLaunch=0 未评估 → 领域/模式条件化依据，仍不部署。**逐鱼真值审计（E26e-ab）**：当前 replay schema 的 ShotKillEvent 无 victim/damage、DamageStatSample 仅 recorder 累计、HP 仅实体级 → per-fish server damage **不可识别**；magnitude 变体只证明 r120 行级标签敏感（lift 2.20→3.08，但 top-decile 绝对命中率 17.96%→4–6%），不能替代逐鱼真值。**event/DD 专项（E26e-ac）**：外部 event/DD 弱是 **过预测/先验漂移**（meanProbB 3.56%/3.22% vs base 0.83%/0.70%，ECE 2.73/2.53pp；对照 pve/coop/pvp 0.90/1.09/1.47pp）**+ 区分弱**（AUC 0.553/0.623、event\|DD 0.349）；headC 不可评（event 10 launched/0 hits）→ 需 mode/版本条件化或补 pvp 数据。**in-dist 基线（E26e-ad）**：in-dist event/DD 的 headB 并不弱（event AUC 0.741/3.071×、DD 0.670/2.033×、event|DD 0.589），外部 event 0.553/event|DD 0.349 属**外部/地图/版本分布漂移**，非模型固有；全局过预测（in-dist ECE 2.46pp）为模型级校准偏移。**交付温度（E26e-ae）**：外部 17,054 行上 baked T_B 使 headB ECE 1.68pp→0.24pp、Brier/logloss 改善（meanProbB 2.90%→0.98% vs base 1.22%），T_C 对 headC ECE 改善但 Brier/logloss 略升（37 launched）；排序指标完全不变 → 部署/评估口径应报 baked，但 headB 门禁仍 FAIL（1.862×），部署仍 T4 r120。**特征漂移（E26e-af）**：外部 vs in-dist 44 维特征 domain AUC 0.99–1.00；event top 漂移为 ownEnginePower/unknown 船级（59.9%）/torp 属性/engineDir/zones，event|DD 为 ally radar/hydro 可用性（SMD≈4.0）+ smoke/HP；event 模式内四图首见（46/17/35 其他模式可见，仅 e15 全语料未见） → 外部 event/DD 失效与强协变量漂移一致（非因果），支持 mode/版本条件化或统一导出/遥测后再评。**matched-domain（E26e-ag）**：只保留 known class+seen map 后 headB **1.405×**（strict 1.365×/top 0），低于 full 1.862×；unmatched novelty（pve s09）反而 3.558× → **FAIL 不是 unknown/unseen-map novelty，而是 event 模式特异域漂移**；mode/version 条件化仅设计未执行。

**重开条件/数据缺口**（任一满足后再预注册；总分 A/B 另立）：① 独立赛季 replay（非同一语料/同一时间窗）；
② 逐鱼 server 真值（**当前 replay schema 的 ShotKillEvent/damageStat 无法逐鱼归因，见 E26e-ab 审计**；需协议/解码层 per-shot victim/damage 或 server per-fish API，并覆盖 ≥2 个赛季）；③ 目标窗/在线 cell 先验 + 足够延迟标签，
并在独立窗复现；④ walk-forward 门禁：≥2/3 窗过线、**每窗 AUC 与 CI 下界**、按窗校准；⑤ 端到端总分 A/B
（鱼雷分量 vs 战斗结果相关性、权重、校准）。

**产物/PR 状态**：E26e-a…x 均已合并；研究脚本在 `scripts/experiments/`（torpedo_*.py、train_torpedo_model.py），
产物在 `out/torpedo_model/e26e-*/`（out ignored，不入 git），预注册 `out/torpedo_model/e26e-*-preregistration.md`；
交付见下节 T4（PR #1868），模型文件由维护者手动放入 decisions pack。

**简短局限**：样本/段位有限、单 seed、proxy 标签、server 真值仅 recorder-only、Q3 walk-forward 仅 3 窗；
所有先验/自适应实验为描述性、无因果识别；单窗 PASS 不代表稳定。

### E26e 系列结论与评分集成决策（截至 E26e-ag 研究收敛，2026-11-09）

**最终研究模型（torp4 + λ_C=0.1，全语料 3,111,384 行 / 2,215 局，5 折 seed 0）**

| 头 | OOF 指标 | 校准（温度） |
|---|---|---|
| headB（发射概率） | AUPRC **0.042126 = 2.599×base**、top-decile launch lift **2.905**、AUC **0.7273** | T=0.7564，ECE 0.02457→**0.00064** |
| headC（命中结果） | AUPRC **0.265641**、AUC **0.720822**；outcome lift **2.1997×**、ρ 0.988、CI [1.998,2.378] | T=1.0723，ECE 0.012667→**0.004089** |

**系列演进（每条用各自预注册线；线不同不可直接比较判定；E26e-c 为 1.35 线，E26e-f/g 为 2.30 线）**

| 实验 | headB AUPRC / top-lift / AUC | headC outcome lift | 判定 |
|---|---|---|---|
| E26d（torp2，2 头） | 0.037051 / 2.662 / 0.7084 | — | PASS（headB 验收线） |
| E26e-a（校准） | 同上 | — | PASS（logloss/Brier/ECE 改善，AUPRC 不变） |
| E26e-b（headB outcome） | 0.037051 / 2.662 / 0.7084 | 1.2234（headB；无 headC） | MIXED（<1.25） |
| E26e-c（共享 headC） | 0.032733 / 2.349 / 0.6828 | **2.2126** | PASS（1.35 线） |
| E26e-d（解耦） | 0.037051 / 2.662 / 0.7084（未动） | standalone 1.3011 / joint 1.3813 | MIXED（<2.2） |
| E26e-e（λ 扫描，λ0.1 secondary） | 0.036015 / 2.610 / 0.7043 | **2.2518** | MIXED（判定为主配置 λ0.3） |
| E26e-f（torp3 属性） | **0.039022 / 2.789 / 0.7141** | 2.2329 | MIXED（<2.30） |
| E26e-g（torp4 click） | **0.042126 / 2.905 / 0.7273** | 2.1997 | MIXED（<2.30） |
| E26e-h（fish 口径） | 0.042086 / 2.912 / 0.72633（fish_rate；strict AUPRC 低 0.00004） | **2.3069（fish_rate，边际）** / 2.1981（fish_weighted） | MIXED（严格：fish_rate 仅 +0.0069、CI 下界 2.099、strict (b) 差 0.00004；fish_weighted FAIL） |
| E26e-i（headC 融合） | 未重训 | ensemble **2.2475** / rank 2.2540（两源 2.1997 / 2.3069） | MIXED（<2.30；两源 calibrated ρ 0.916，融合只落在中间） |
| E26e-j（标签定义敏感性） | 未重训（固定 E26e-g OOF） | any@r60 **2.6811** / fish_rate@r60 2.8390；r120 2.1997/2.3069；r200 1.8485；noHP 1.1878 | **PASS（any@r60，CI [2.438,2.930]）**：标签半径/HP 确认是平台的重要因素；不重训/不调阈值 |
| E26e-k（r60 重训） | 0.042302 / 2.943 / 0.7274 | r60 **2.6329**（<2.68；CI [2.374,2.883]）；r120 cross 2.0844 | MIXED（r60 收益是跨标签排序现象，未转化为重训收益；headB 非退化） |
| E26e-l（torp5 目标几何） | 0.041865 / 2.884 / 0.7258（1% 容忍内） | r120 **2.2639**（<2.30）；r60 **2.7631**（>2.68） | MIXED：目标几何边际增益（+0.064 r120；r60 首超固定 2.6811），未跨 2.30 |
| E26e-m（server 真值审计） | 未重训（E26e-g OOF） | server-label **2.3477**（ρ 0.891，CI [1.807,3.018]）；代理 precision 0.798/recall 0.484 | **PASS（真值下仍 ≥2.30）**：代理低召回/绝对命中率低估，但 headC 排序在 server 真值下成立；recorder-only/710 行 |
| E26e-n（server 真值校准） | 未重训 | raw→Platt Brier **0.2805→0.2241（−20.1%）**、logloss 0.8067→0.6387、ECE 0.2367→0.0636；pooled lift 2.266<2.348 | **MIXED / post-hoc**：原预注册 pooled lift 判据 FAIL；首跑后改为折内 lift 才 PASS，校准数值保留探索性；排序/阈值不变 |
| E26e-o（region holdout） | holdout headB **0.032647 = 3.214×base / top 3.114 / AUC 0.7035（PASS）** | holdout own headC **1.3849**（<2.00 ✗）/ρ 0.758/CI [0.855,2.190]；in-dist own 2.1809 → **MIXED：region 泛化缺口 −36.5%** |
| E26e-p（few-shot adaptation） | 4-shard（含 own_adapt 17 replay）+ holdout own_holdout 144 replay | holdout own headC **1.7514**（ρ 0.806，CI [1.260,2.505]）/headB **0.036724 = 3.531×base / top 3.261 / AUC 0.771** | **MIXED**：vs E26e-o 1.3849 补回 46% 缺口（1.80 线差 0.049）；headB 泛化改善 |
| E26e-q（dose response） | 同一 common holdout 97 replay；own 0/10/25% nested | 0% 1.5963 → 10% **2.1645** → 25% **2.4859**（ρ 0.855/0.782，CI [1.461,3.063]/[1.724,3.275]）；dose Δ +0.3214；headB 3.607×→3.490×→4.049×base | **PASS（仅同期随机拆分）**：25% ≥1.90 且超 in-dist 2.1809；dose 单调、未见 ceiling（0/10/25 三点）；**E26e-r temporal FAIL → 不可外推** |
| E26e-r（dose + temporal） | random40 64 replay；temporal25 最早 40 / holdout 最晚 97 | random40 **2.4413**（ρ 0.697，CI [1.631,3.379]，剂量饱和）；temporal25 **1.6244**（ρ −0.20，CI [0.752,2.374]）vs temporal0% 1.5063 / in-dist 2.1809 | **MIXED**：random40 过 1.90 但饱和；temporal primary <1.80 且 ρ 负 → **E26e-q random-split 2.4859 时间外推不成立（time drift）**，部署须 walk-forward |
| E26e-s（walk-forward） | 3 窗 adapt=Q_{i−1}→test=Q_i（own 日期四分） | Q2 **3.0052**/ρ 0.903/CI [0.864,5.114]；Q3 **0.9083**/ρ −0.006/CI [0.258,1.565]；Q4 **1.8256**/ρ 0.632/CI [0.360,3.422]；0% 每窗 0.9200/2.1373/1.6481 | **PASS(2/3) but Q3 FAIL**：形式 2/3 过线，但 Q3 崩盘 + Q2/Q4 CI 下界 <1 → **temporal instability 仍在**；headB 三窗非退化；walk-forward 门禁、不总分 |
| E26e-t（Q3 drift 诊断） | 不重训；Q1–Q4 全量组成 + 三窗预测/0% baseline + 漂移统计 | — | Q3 base **18.59%**/rowAny 29.46%（Q2 9.98/13.98、Q4 16.43/22.30）；25% **meanProbC 0.037/ECE 0.258/AUC 0.500/lift 0.908**，0% lift 2.137；组成 Q3 brawl 12,806+event 12,192（Q2 pvp 62,556/event 2,555）；top drift shipId PSI 8.54/map 7.57/gameMode 5.66/dist SMD 0.907 | 诊断：**composition/prior shift + 跨模式排序坍塌**（非单一标签噪声，连续漂移与组成混杂不可分；标签噪声不可定量排除）→ walk-forward 门禁须加 AUC/CI 下界、分层/reweight、按窗 prior/温度重校准；不推部署/总分 |
| E26e-u（mode 分层） | 不重训；Q2/Q3/Q4 上 raw/within-rank/oracle/adapt-prior | — | Q3 raw **0.908** → within **1.703** / oracle **1.681** / adapt-prior **1.050**（均 <1.80，primary FAIL）；AUC 0.500→0.678 证模式先验是主因，但 top decile 全在 brawl（31.45%/18.59% → lift 上限≈1.69）→ **模式内信号不足**；label-free 因 adapt 无 brawl/event 先验失败；Q2 oracle 2.57<raw 3.01、Q4 oracle 3.04>raw 1.83（不普遍更优） | 诊断：模式先验是 Q3 坍塌主因（AUC 修复）但分层不能修 lift≥1.80；需目标窗先验/多级分层/按窗校准；不推部署/总分 |
| E26e-v（cell 先验） | 不重训；Q2/Q3/Q4 上 raw/within-cell/oracle-cell/historical/rolling | — | Q3 raw **0.908** → within-cell 0.856、**oracle-cell 2.010（≥1.80，primary PASS）**、historical **0.680**、rolling **0.665**；oracle AUC 0.500→0.719；coverage 43 cells/19 n>=5（176/241 行）；Q1+Q2 无 brawl cell/mode → label-free 回退 global → **cell 先验可修 lift（需目标窗 cell base），label-free 不可部署**；Q2 oracle 3.064、Q4 oracle 1.683<raw 1.826 但 historical 2.331（小样本） | 诊断：cell 粒度先验可把 Q3 修到 2.01（mode 粒度仅 1.68），但需目标窗/延迟标签先验；历史 label-free 在 mode/cell 轮换下失效；不推部署/总分 |
| E26e-w（在线先验） | 不重训；Q2/Q3/Q4 early-20/40 标签估 cell base，eval 余 80/60% | — | Q3 eval：raw 0.682/0.526 → **early20 1.464/0.645**、early40 1.087/0.549、oracle 2.527/0.722、hist 0.630、roll 0.776；early20 仅 48 launched/178 fired/28 cells（cell 覆盖 139/193 行）→ **primary/secondary FAIL：延迟标签量/估计不足**；Q2 early20 0.816 vs raw 3.152、Q4 0.930 vs raw 1.623 | 诊断：在线 cell 先验方向有效但 20–40% 早段标签不足以修到 1.80；oracle 2.53 参照；需早段+历史层次 EB/更大早段/真实回填延迟；不推部署/总分 |
| E26e-x（层次 EB） | 不重训；Q2/Q3/Q4 early-20/40 上 A/B(层次 cell→mode α50)/C(池化)/D(历史 mode) | — | **Q3 early20：raw 0.682/0.526 → A 1.464/0.645、B 1.835/0.678（≥1.80 & AUC>0.55，primary PASS）、C 0.678/0.622、D 1.464/0.655、oracle 2.527**；early40 B 1.384/0.615（<1.80）；Q2 B 0.816 vs raw 3.152、Q4 B 0.799 vs raw 1.623（Q4 C/D 1.3–2.6、B-40 0.0，小样本不稳） | 诊断：层次 EB 仅在 Q3 early-20% 过线（1.835），非普适/不稳定；不能部署/总分，需更多 replay/seed 复核与 B+C 融合 |
| E26e-z（外部 holdout） | 不重训；T4 r120 checkpoint 外部 17,054 行/18 replay（2026-10-31..11-08） | headB **1.862×base / top 2.429 / AUC 0.6017**（门禁 1.86<2.0 FAIL）；headC **1.9896 / ρ 0.596 / CI [0.0,5.36]**（37 launched/115 fired/17 hits，标准 bootstrap NaN→local 回退）；headA 0.9786/0.9979 | **外部诊断门禁 FAIL**（AUPRC 1.86×<2.0；top 过）；headC <2.30 描述性；pve/event/cooperative 为主 + 20% unknown 船级 → 版本/时间/模式外推退化，不重训不调线；实际 18 replay（非原述 23）需重导出复核 |
| E26e-aa（外部分层） | 不重训；18 replay/17,054 行外部预测按 mode/map/class/version 分层 | headB overall **1.862×base / top 2.429 / AUC 0.6017**；**event 1.357×/top 0/AUC 0.553（主因）**，pve 3.558×、cooperative 3.439×、pvp 5.342×（仅 3 正）；class DD 1.565×；version 15,10 2.782× vs 15,9 1.869×；headC 1.99（pve 4.97 不稳，其余样本不足） | 描述性：FAIL **集中在 event 模式/部分地图 + DD**，pve/coop 反而强，pvp 3 正不能判；52% 行 canLaunch=0 未评估；不重训不调线不部署；作 mode/版本条件化依据 |
| E26e-ab（逐鱼真值/magnitude） | 不重训；审计 replay schema + r120 行级 magnitude 变体（A/B/C/D），e26e-g OOF C | **审计：per-fish server damage 不可识别**（ShotKillEvent 无 victim/damage、DamageStat 仅 recorder 累计、HP 仅实体级）；A 2.1997（复现）；B t=1k/2k/3k/5k → **2.61/2.76/2.92/3.08**、C → 2.38/2.53/2.62/2.74、D clean-terminal **2.336**；top-decile 绝对命中率 17.96%→4.0–5.8% → lift 升是标签选择性/base-rate 效应，**不能替代逐鱼真值**；描述性、不重训、不调线 |
| E26e-ac（event/DD 专项） | 不重训；18 replay external predictions mode×shipClass 交叉 + headB 校准/区分 + 特征 SMD + event maps | **event** can 1,209/pos 10：base 0.83%、meanProbB **3.56%**（+2.73pp/ECE 2.73pp）、AUC **0.553**、top **0**、AUPRC 1.357×；**DD** can 1,006/pos 7：base 0.70%、meanProbB **3.22%**（+2.53pp/ECE 2.53pp）、AUC 0.623、top 1.423、AUPRC 1.565×；**event\|DD AUC 0.349**/meanProb 4.01% vs base 0.47%；pve/coop/pvp 对照 meanProb 2.34/2.84/2.50%、AUC 0.630/0.740/0.810 | **机制：过预测/先验漂移 + 区分弱双因素**；非单纯标签噪声/样本量；headC 不可评（event 0 hits/10 launched）→ mode/版本条件化或补 pvp 数据；不重训/不调线/不部署 |
| E26e-ad（in-dist event/DD） | 不重训；E26e-g OOF 3,111,384 行 + full 4 shard gameMode + r120 outcome，按 mode/class 报 headB/headC，与 E26e-ac 外部对照 | **in-dist event** can 7,242/pos 118：base 1.63%、AUPRC **3.071×**/top 2.963/AUC **0.741**/ECE 2.25pp；**DD** can 466,730/pos 10,949：2.033×/2.401/0.670/ECE 2.49pp；event\|DD 1,208/35：2.497×/1.997/0.589；headC overall 2.1997、DD 2.084、event 1.756*（118/358/59） | **in-dist event/DD 不弱**（AUC 0.741/0.670），外部 event 0.553/event\|DD 0.349 是**外部/地图/版本分布漂移，非模型固有**；全局过预测（ECE 2.46pp/meanProb 2.5× base）为模型级校准偏移；不重训/不调线/不部署 |
| E26e-ae（交付温度校准） | 不重训；trainer eval-only `--eval-temp-b/--eval-temp-c`（ONNX parity）；external 17,054 行 + T4 checkpoint，raw vs baked T（T_B=0.7564、T_C=1.0723） | **headB** ECE **1.678pp→0.240pp**、Brier 0.012360→0.012057、logloss 0.071532→0.065472、meanProbB 2.90%→0.98%（base 1.22%）；**headC** ECE 6.939→5.814pp 但 Brier 0.118441→0.119294、logloss 0.382606→0.386549（37 launched/5 正）；headA 不变；**排序完全不变**（argsort/Spearman=1/AUPRC/top/AUC/lift/CI 全等） | **baked T 是部署口径**：T_B 明显改善外部 headB 校准，T_C 混合（ECE 好、Brier/logloss 微升，样本极小）；排序/门禁不变（headB 仍 1.862× FAIL），部署仍 T4 r120；不重训/不调线/不部署 |
| E26e-af（特征漂移归因） | 不重训；external 17,054 行 vs in-dist 采样 362,109/3.11M（非 pvp 全收 + pvp 1/10）；同一 torp3 44 维 SMD + logistic domain classifier（80/20，3 seeds） | **domain AUC 0.99–1.00**（overall .990、event .997、DD .991、event\|DD 1.000、pvp 1.000）；event top SMD：ownEnginePower 1.87、cls_unknown 1.73、torp_speed −1.63、torp_detect −1.47、torp_damage −1.42、ownEngineDir 1.33、zonesOwned0 1.21；DD：ownEnginePower 1.02、zonesOwned0 .90、ownHpFrac −.86；event\|DD：allyHydro 4.07、allyRadar 4.00、ownEnginePower 1.28；unknown 19.9%（event 59.9%）、event 模式内四图首见（46/17/35 其他模式可见，仅 e15 全语料未见） | **强协变量漂移**：unknown 船级/全新 event 地图 + 遥测可用性（ownEnginePower/ally radar/hydro −1）+ 目标几何/玩法差异，解释外部 event/DD 排序失效；domain AUC 非因果；不重训/不调线/不部署 |
| E26e-ag（matched-domain） | 不重训；in-dist 4 shard 收集 seen maps/classes/modes/versions；external matched_mapclass（known class+seen map）/matched_strict（+mode/version）/unmatched 重算 headB/headC | **matched 不恢复**：matched_mapclass 9,333 行/can 1,844/19 正 → **1.405×**/top 1.049/AUC .606/ECE 2.229pp；matched_strict 7,263/832/8 → **1.365×**/top **0**/AUC .589/ECE 2.803pp；unmatched_novelty 7,721（pve s09 4,323+unknown e15 3,398）→ 3.558×/3.863；matched 内 event 1,357×/top 0/AUC .553、pvp 5.342×（3 正）、coop 3.439×（6 正）；headC matched 19/57/7 lift 0、strict 0 hits | primary **未达 ≥2.0×** → **FAIL 不是 novelty，而是 event 模式特异域漂移**（matched 内 event 仍 1.357×）；mode/version 条件化方案已写（只设计不执行）；不重训/不调线/不部署 |

**结论与观察（第 3 条为观察/假设）**

1. **鱼雷决策信号真实存在**：headB 的 top-decile 发射 lift 从 E26e-b 的 2.662 提升到 torp4 的 2.905（AUPRC 2.286→2.599×base）；headC 的命中排序 lift 在 E26e-c/E26e-f/E26e-g 及 E26e-e λ0.1 上为 2.20–2.25×、ρ 0.988–1.0；E26e-h 的 fish_rate 软目标到 **2.3069×**（仅边际 +0.0069、CI 下界 2.099<2.30）但 headC 原始 ECE 升到 0.0572（T=1.387 后 0.0079）、AUPRC/AUC 下降，不能算稳健提升；any 目标的 headC 校准后 ECE 仍为 0.0041。
2. **“发射行为”与“命中结果”是两种信号**：torp3 属性与 torp4 click-context 都显著提升 headB（分别 +8.3% / +7.9% AUPRC），但对 headC 无增益；E26e-h 把训练目标对齐 fish-level 后，fish_weighted 无增益、fish_rate 仅边际（且 strict headB 微降/校准变差）；共享 trunk 的多任务表示对 headC 必要（E26e-d 解耦后 headC 全面变弱）。
3. **headC 的 2.30 线是标签定义相关的**：E26e-c（torp2）2.2126× 过其 1.35 线；E26e-f（torp3）2.2329×、E26e-g（torp4）2.1997× 未过 2.30；E26e-h fish_rate 2.3069× 仅边际、fish_weighted 2.1981× 无增益；E26e-i 融合 2.2475× 也只落在中间。**E26e-j 固定同一 E26e-g 模型、只换命中标签定义**：r60（严格半径 + HP 确认）下 any headC outcome lift **2.6811×**（CI [2.438,2.930]）、fish_rate 2.8390×；r120 2.1997×；r200 1.8485×；noHP（56.8% 算命中）1.1878× → **标签半径/HP 确认是 headC 平台的重要因素**，之前把 2.20–2.31× 当作模型上限并不完整。E26e-k 用 r60 标签重训后 **2.6329×**（CI [2.374,2.883]；低于 2.68 线、也低于固定模型 2.6811）、在 r120 标签上 cross-eval **2.0844×**（低于 E26e-g 2.1997）→ **r60 的优势是跨标签评估口径，未转化为重训收益**；E26e-l 加入目标几何（aspect/cross/lead/intercept）后 r120 仅到 **2.2639×**、r60 到 **2.7631×**（首超固定模型 2.6811）→ 目标几何有边际真实贡献，但仍不足以跨 r120 2.30；E26e-m 用 server damageStat 审计：代理 precision **0.798**、recall **0.484**（漏 52% server 命中、行级 hit rate 24.4% vs 40.1%），但 E26e-g headC 在 server 真值标签上仍 **2.3477×**（ρ 0.891，CI [1.807,3.018]）→ **代理主要低估绝对命中率，未丢失排序信息**；E26e-n 进一步用 server 真值做 5 折 Platt 校准：Brier **0.2805→0.2241（−20.1%）**、logloss 0.8067→0.6387、ECE 0.2367→0.0636，meanProb 0.168→**0.401≈hitRate**；但 pooled lift **2.266 < raw 2.348**，原预注册判据 FAIL，首跑后改为 held-out 折内 lift 才 PASS → **post-hoc 判据变更，只能算 MIXED/探索性**；E26e-o 做 leave-one-region-out（train apac+eu+na / holdout own）：headB **3.214×base / top 3.114** 泛化通过，但 headC **1.3849×**（<2.00）vs in-dist own **2.1809×**，**region 泛化缺口 −36.5%** → 排序并非跨区稳定，headC 2.2–2.7 的平台不能当作可迁移上限；E26e-p 用 own 10% replay few-shot（17/161）后 holdout **1.7514×**（<1.80，差 0.049），补回缺口 **46.0%**、headB 升到 **3.531×base / top 3.261 / AUC 0.771** → **少量区域样本有效但不足以收窄一半缺口**；E26e-q 在**同一 common holdout**（97/161 own replay）上做 dose response：own **0% 1.5963 → 10% 2.1645 → 25% 2.4859**（dose Δ +0.3214），25% **PASS（≥1.90）且已超 in-dist 2.1809**，headB 3.607×→3.490×→**4.049×base** → **在同期随机拆分内，剂量足够时 headC 可恢复到 in-dist 水平**，但 common holdout 仅 97 replay/589 launched，且后续 temporal 验证否定了外推；headC 差异主要来自评估标签、目标几何与区域分布，而不是单一特征堆叠。**E26e-r 进一步补 40% 剂量与时间外推**：random 40%（adapt pool 64 replay）到 **2.4413×**（random40 过 1.90，但比 25% 的 2.4859 低 0.0446 → 剂量在 25% 饱和）；**temporal 25%（最早 40 replay 入训、最晚 97 replay holdout）只有 1.6244×（<1.80）、ρ −0.20**（CI [0.752,2.374]），仅比 temporal 0% 的 1.5063 高 +0.1181 → **E26e-q 的同期随机拆分 2.4859 不能时间外推（time drift）**；headC 的跨区/跨期稳定性同时受标签定义、区域分布与时间漂移影响。**E26e-s 的 rolling-origin walk-forward（3 窗）**给出形式 2/3 PASS（Q2 3.0052/ρ 0.903、Q4 1.8256/ρ 0.632），但 **Q3 崩盘（0.9083/ρ −0.006，且低于其 0% baseline 2.1373）**、Q2/Q4 CI 下界分别仅 0.864/0.360，0% baseline 在 0.92–2.14 间波动 → **时间稳定性并未成立（temporal instability 仍在）**，E26e-r 的单切点失败不是偶然。**E26e-t 进一步诊断 Q3 崩盘**：Q3 base hit rate **18.59%**（Q2 9.98%、Q4 16.43%）、rowAny 29.46%；25% runQ3 meanProbC 3.7% vs 实际 18.6%、ECE 0.258、**AUC 0.500**、lift 0.908，而 0% baseline 同块 lift 2.137；组成上 Q3 含 brawl 12,806 + event 12,192（Q2 几乎全 pvp、0 brawl），漂移 top shipId PSI 8.54 / mapName 7.57 / gameMode 5.66 / enemyDistMean SMD 0.907 → **Q3 崩盘是 composition/prior shift + 跨模式排序坍塌（pvp meanProbC 5.07% > event 4.30% > brawl 1.58%，真实 base brawl 31.45% > event 15.56% > pvp 9.73%），不是单一标签噪声**；前一块训练在 Q3 反而伤害排序，部署门禁需同时约束 AUC/CI 下界。**E26e-u 进一步检验分层/先验归一化**：Q3 raw lift 0.908→within-mode rank 1.703、oracle mode-prior 1.681（AUC 0.500→0.678），证实跨模式先验错序是排序坍塌主因，但两者仍 <1.80（oracle top decile 全落 brawl，上限≈31.45/18.59=1.69）→ **模式内信号不足，分层不能修复 lift≥1.80**；label-free adapt-prior 仅 1.050（adapt 无 brawl/event 先验）→ 需目标窗先验校准而非 label-free；不推部署/总分。**E26e-v 把先验粒度细化到 cell（gameMode|mapName|shipClass）**：Q3 oracle-cell lift **2.010**（≥1.80）、AUC 0.500→0.719，top decile 集中在高 base brawl/event cell（57.7%/58.3%/50.0%/31.6%）→ **cell 粒度先验足以修复全局 lift**（mode 粒度只有 1.68）；但 **historical（Q1+Q2）0.680 / rolling（Q2）0.665 均 <1.80**（Q1+Q2 无 brawl 模式/cell、25 个 Q3 test cell 缺失，只能回退 global）→ **label-free 不可部署，需目标窗/延迟标签 cell 先验**；Q4 oracle 1.683<1.80（n>=5 仅覆盖 73/139 行）而 historical 2.331（小样本、AUC 0.52–0.54）→ 不能只凭 lift 判修复。**E26e-w 检验在线/延迟标签方案**：Q3 按 t 用最早 20% launched（48 行/178 fired/28 cells）估 cell base、eval 余 193 行 → lift **1.464**（raw eval 0.682）、AUC **0.645**（raw 0.526），early-40% 反降到 1.087/0.549；oracle 全标签同 eval 子集 **2.527/0.722** 为上界 → **primary FAIL（1.464<1.80）/secondary FAIL**，记录**延迟标签量/估计不足**；Q2/Q4 early20 0.816/0.930 也低于 raw（3.152/1.623）→ 在线早段先验不足以修复，需早段+历史层次 EB、更大早段/真实回填延迟。**E26e-x 检验层次 EB**：Q3 early-20% 变体 B（cell→mode EB α=50）lift **1.835**、AUC **0.678** → **primary PASS**（≥1.80 且 AUC>0.55），把 E26e-w 的 A（1.464）推过线；但 early-40% B 仅 1.384（<1.80），Q2 B 0.816（raw 3.152）、Q4 B 0.799（raw 1.623），Q4 C/D 1.3–2.6、B-40 0.0 → **非普适/小样本不稳**，不能部署/总分；需更多 replay/seed 复核与 B+C 融合。E26e-z 的外部 holdout（T4 r120 checkpoint，18 有效 replay/17,054 行、2026-10-31..11-08）headB **1.862×base（<2.0 门禁 FAIL）**、AUC **0.602**、top 2.429，headC **1.9896**/ρ 0.596/CI [0.0,5.36] → **版本/时间/模式外推退化**，进一步支持 headC 上限与诊断-only。E26e-ab 审计确认**当前 replay schema 无法逐鱼归因 server damage**（ShotKillEvent 无 victim/damage、DamageStat 为 recorder 累计、HP drop 无来源）；magnitude 变体 lift 升到 2.61–3.08 但 top-decile 绝对命中率从 17.96% 掉到 3.61–5.84%、hits 仅剩 16–30%，是标签变稀/base 选择性，不是逐鱼伤害学习。E26e-ac 外部 event/DD 专项显示：event meanProbB 3.56% vs base 0.83%（+2.73pp）、AUC 0.553、top0，DD 3.22%/0.70%（+2.53pp）、AUC 0.623，event|DD AUC 0.349 → **过预测/先验漂移 + 区分弱双因素**；headC 不可评（event 0 hits），诊断-only。E26e-ad in-dist 基线显示 in-dist event/DD 并不弱（event AUC 0.741/3.071×、DD 0.670/2.033×、event|DD 0.589），外部 event 0.553/event|DD 0.349 属外部/地图/版本分布漂移；全局过预测为模型级（in-dist meanProb 4.08% vs base 1.62%、ECE 2.46pp）。 E26e-ae 交付温度评估：baked T_B 把外部 headB ECE 1.68pp→0.24pp、Brier/logloss 改善，T_C 对 headC ECE 改善但 Brier/logloss 略升；排序指标完全不变，外部门禁仍 FAIL（1.862×），部署仍 T4 r120。 E26e-af 特征漂移：44 维 domain AUC overall 0.990/event 0.997/DD 0.991/event|DD 1.000；event top SMD ownEnginePower 1.87/cls_unknown 1.73/torp_speed −1.63，event|DD allyHydro 4.07/allyRadar 4.00；unknown 19.9%（event 59.9%）、event 模式内四图首见（46/17/35 在 in-dist 其他模式可见，仅 e15 全语料未见） → 强协变量漂移，支持外部/版本/地图漂移解释（非因果）。 E26e-ag matched-domain：只保留 global known class+seen map 后 headB **1.405×**（strict 1.365×/top 0），低于 full 1.862×；unmatched novelty（pve s09）反而 3.558× → **FAIL 不是 unknown/unseen-map novelty，而是 event 模式特异域漂移**；matched 是 global map+class，不是 same-mode matched。
4. **校准可用**：单一温度即可把 headB ECE 从 0.0246 降到 0.0006、headC 从 0.0127 降到 0.0041，且不改变排序；server 真值下 headC 绝对概率仍低估（meanProb 0.168 vs 真值 0.401），5 折 Platt 校准把 Brier 降 20.1%、ECE 降 73%、meanProb 对齐 0.401，且 held-out 折内排序不变——**温度校准排序、Platt 校准绝对概率，两者都不重训模型**；但 E26e-n 的判据变更属 post-hoc、未独立验证，绝对概率校准只作探索性诊断，不改变排序/阈值。

**评分集成决策：鱼雷保持“诊断-only”，暂不并入总分**

- 总分继续只聚合开火/移动决策；鱼雷卡片保留为可选诊断（发射概率 + 预期效果，不适用舰种显示 N/A），总分不变。
- 不并入的理由：
  1. headB 是**专家点击一致性**模型，不是结果真值；E26e-b 已证明它的 outcome lift 只有 1.223×，不能直接当作“决策质量”。
  2. headC 是目前最强的结果信号，但 E26e-f/g 低于 2.30 预注册线；E26e-h 的 fish_rate 仅边际过线（CI 下界 2.099、ECE 0.0572 需额外温度、strict headB 微降 0.00004）且排序质量下降，严格读法为 MIXED；E26e-i 的两模型融合只到 2.2475、无法把边际尖峰变成稳健过线；E26e-j 显示 r60 固定模型到 2.6811×，但 E26e-k 的 r60 重训只有 2.6329×（<2.68）、r120 cross 2.0844×——标签定义主要是评估口径；E26e-l 目标几何把 r120 提到 2.2639、仍未过 2.30；E26e-m 的 server 真值子集（710 行、recorder-only）下 headC 2.3477 成立，但绝对命中率被代理低估；E26e-n 的 Platt 可把绝对概率校准到真值（Brier −20%），但原预注册 pooled lift 判据 FAIL、后改为折内判据才 PASS（post-hoc），且样本小/同语料；E26e-o 的 region holdout 显示 headC 从 in-dist 2.18 掉到 1.38（−36.5%），E26e-p 的 10% own few-shot 只补回 46%（1.75<1.80）；E26e-q 的 25% own dose 在 common holdout 到 2.49（PASS），但仅 97 replay、同语料、CI [1.724,3.275] 仍宽，且是 region-specific adaptation 而非独立验证——仍不足以支撑一个总分权重。**E26e-r 的时间外推进一步否定了 few-shot 随机拆分收益的可迁移性**：temporal 25% 1.6244（<1.80）且 ρ −0.20，说明 E26e-q 的 2.4859 只在同期随机拆分内成立，不能作为部署/权重依据。E26e-s 的 3 窗 walk-forward 同样只有 2/3 形式过线（Q3 0.9083/ρ −0.006 崩盘，Q2/Q4 CI 下界 <1），**时间稳定性不成立**，鱼雷仍保持诊断-only。E26e-t 对上条给出机制性解释：Q3 的 brawl/event 模式占比（63%+）远高 Q2（pvp 主导、0 brawl），使 base rate 从 10% 升到 18.6%，而 Q2 训练模型给未见模式最低概率（跨模式 meanProbC 错序），整体 AUC 掉到 0.500；因此时间外推门禁不能只看 lift，必须同时要求每窗 AUC 与 CI 下界，并按 mode/map 分层。E26e-u 验证了该分层假设的一半：oracle/within rank 把 Q3 AUC 0.500→0.678、lift→1.68–1.70，但受模式 base/global base 比（≈1.69）与模式内弱信号限制，仍 <1.80；label-free 上一窗先验在 Q3 只有 1.05（Q2 无 brawl），故实际部署需要目标窗/近端先验估计，而非仅靠分层或上一窗。E26e-v 补上一层：**cell 粒度 oracle 可把 Q3 修到 2.01**（mode 粒度 1.68 的 lift 上限被 brawl/global base 比 1.69 卡住），但历史/滚动 label-free 只有 0.68/0.67（Q1+Q2 无 brawl cell/mode、25 个 cell 缺失）→ 真正可部署的路径是**目标窗/延迟标签的 cell 先验 + 分层 fallback**，而不是纯历史 label-free。E26e-w 进一步检验在线/延迟标签：Q3 用最早 20%/40% launched 估 cell base，eval lift 仅 **1.464/1.087**（AUC 0.645/0.549），均 <1.80，而 oracle 同 eval 子集 **2.527** 说明上限仍在 → **20–40% 早段标签量不足**；需早段+历史层次 EB、更大早段或真实回填延迟建模。E26e-x 验证了层次版本的一半：Q3 early-20% B 1.835（AUC 0.678）过线，但 early-40% 1.384 与 Q2/Q4（0.816/0.799）不成立，说明层次收缩只在 Q3 特定 early-mode 结构上有效，不能作为通用在线先验。E26e-z 的外部 holdout（T4 r120 checkpoint，18 有效 replay/17,054 行）headB 仅 **1.862×base（<2.0 门禁 FAIL）**、AUC 0.602，headC 1.9896/CI [0.0,5.36]（37 launched/115 fired/17 hits，描述性）——**外部外推退化**，仍不足以支撑总分权重。E26e-ab 进一步证明：per-fish server damage 在当前 replay schema **不可识别**；magnitude 变体 lift 2.61–3.08 但 top-decile 绝对命中率 17.96%→3.61–5.84%，只是标签变稀，不能当逐鱼真值；总分集成仍冻结。E26e-ac 进一步显示 event/DD 外部弱是**过预测/先验漂移 + 区分弱**（event meanProb 3.56% vs base 0.83%、AUC 0.553；DD 3.22%/0.70%、AUC 0.623；event|DD AUC 0.349），headC 不可评（event 0 hits）；需 mode/版本条件化或补 pvp 数据，仍不足以支撑总分。E26e-ad 进一步表明 in-dist event/DD 有信号（event AUC 0.741/0.670、event|DD 0.589），外部退化是分布/版本漂移，非模型固有；全局过预测是模型级校准；仍不足以支撑总分。 E26e-ae baked T_B 改善外部 headB ECE 1.68→0.24pp，但排序/门禁不变（1.862×<2.0），T_C 混合，部署结论不变。 E26e-af 进一步显示外部与 in-dist 44 维即可近完美分域（overall AUC 0.990、event 0.997、event|DD 1.000）、unknown/新图/遥测 sentinel 差异显著，外部退化是强协变量漂移，非模型固有；仍不足以支撑总分。 E26e-ag 进一步显示 matched global map+class 反而更差（1.405×；strict 1.365×/top0），唯一强子集是 novel pve 地图（3.558×）→ FAIL 是 event 模式特异域漂移，不是 novelty；matched 是 global map+class，不是 same-mode matched。
  3. 尚未做**端到端总分验证**（鱼雷分量与 fire/move 聚合后的战斗结果相关性、校准、权重选择均无预注册实验）；直接加分会是未经验证的分数改动。
- 重新评估的条件（满足后再开预注册）：① 逐鱼命中/伤害标签（ShotKillEvent 或 server damageStat）对齐，headC 在≥2 个 seed/语料上稳定 ≥2.30× 且 CI 不重叠；② 端上温度后处理 + 部署校准验证；③ 预注册“加入鱼雷分量是否提升总分与战斗结果相关性”的 A/B；④ SS/BB 样本补强、N/A 语义完整；⑤ 任何 region/few-shot 增益须通过**时间外推/walk-forward**（而非随机拆分）复现后才进入评估。

**交付建议（已落地 T4）**：torp4（49 维/3 头/温度烤图）已作为**独立可选诊断包**交付（见下节 T4，PR #1868）：app 侧新契约 + `torpedo4_model.onnx` 槽 + effectiveness 行，不改变总分；模型文件仍由维护者手动放入 decisions pack（ONNX 不入库）。**当前交付模型仍是 r120 标签训练/校准**；r60 标签是研究结果，若重训验证通过，需另立交付波次更新 ONNX/温度/effectiveness 语义。

**剩余局限**：命中为代理标签，E26e-m 的 server 真值只覆盖 recorder 710 行（4.2%）/3,212 fish（4.5%），窗口重叠非逐鱼归因、CI 宽；E26e-n 的 Platt 校准同语料/710 行、未独立赛季复核，且原 pooled lift 判据未过、首跑后改判据（post-hoc），isotonic 小样本不稳；E26e-o/p/q 的 region holdout 仅 957/874/589 launched、149/144/97 replay，adapt 仅 17–40 replay，CI 宽；E26e-q 的 25% 2.4859 是 common holdout 内结果、非独立赛事/赛季，dose 仅 0/10/25% 三点且未测 40–60%；E26e-j/k 的 r60 结果同数据、不同变体 base hitRate 不同不能直接横比，r60 重训也未超过固定模型（2.6329 < 2.6811）；E26e-l 目标几何来自轨迹近似（非精确弹道），27.6% 行无目标回退 0，r120 2.2639 仍低于 2.30；click 特征粗糙（无管位/DoT 几何）；SS 101 launched、na/own 样本薄；未做端上概率分级；λ_C 固定 0.1 未再扫；fish_rate/E26e-i/k/l/m/n/o/p/q 均不能作为稳健泛化结论。**E26e-r 补充**：random 40% 2.4413 在 25% 附近饱和（Δ25→40 −0.0446）；temporal split 只有 97 replay/515 launched、一个时间切点，且时间漂移与赛事/版本/玩家分布混淆，无法单独归因；temporal 25% 1.6244（<1.80）/ρ −0.20 表明 E26e-q 的 2.4859 是同期随机拆分结果，**时间外推不成立**，few-shot 部署前必须走 walk-forward。**E26e-s 补充**：3 窗测试每窗仅 139–329 launched，Q3 lift 0.9083/ρ −0.006（低于其 0% 2.1373）、Q2 3.0052 但 0% 仅 0.9200 且 CI [0.864,5.114]、Q4 1.8256 压线且 CI [0.360,3.422]；0% baseline 0.92–2.14 大幅波动；形式 2/3 PASS 不能当作时间稳健，时间漂移与赛事/版本/玩家分布混杂，需更大窗口/多 origin 验证。**E26e-u 补充**：Q3 仅靠模式分层/先验归一化（oracle）lift 1.681、within-rank 1.703，仍 <1.80（primary FAIL）；AUC 可从 0.500 修到 0.678 说明先验是主因，但 lift 上限受 brawl/global base 比（≈1.69）与模式内弱信号限制；label-free 上一窗先验仅 1.05（新 brawl 模式缺失）；Q2/Q4 上 oracle 并非普遍更优（2.57<raw 3.01、3.04>raw 1.83 但 AUC 0.541<0.665）；模式粒度/ε/fallback 未调，描述性。**E26e-t 补充**：Q3 崩盘机制为组成（brawl 34% + event 32%，Q2 无 brawl）+ base rate 18.6% vs 10.0% + 模型跨模式 prior 错序（AUC 0.500、lift 0.908 vs 0% 2.137）；25% 模型模式内仍有弱排序（1.59–1.81）但整体被模式错序吞掉；E26e-m 的 server 真值仅 710 recorder 行，无法按 block 量化标签噪声；描述性诊断、无因果识别。**E26e-v 补充**：Q3 oracle-cell lift 2.010（≥1.80，primary PASS）、AUC 0.500→0.719，证明 cell 级 test-window 先验可修全局 lift；但 historical/rolling label-free 仅 0.680/0.665（Q1+Q2 无 brawl cell/mode、25 个 test cell 缺失 → global fallback），说明可部署性不成立；Q2 oracle 3.064、Q4 oracle 1.683<1.80 而 historical 2.331（139 launched、AUC 0.52–0.54），cell 样本薄/α/ε/fallback 未调，描述性。**E26e-w 补充**：在线/延迟标签（Q3 early-20% = 48 launched/178 fired/28 cells，eval 193 行）把 raw eval 0.682→1.464、AUC 0.526→0.645，但 <1.80（primary FAIL）；early-40% 1.087/0.549（secondary FAIL）；oracle 全标签 2.527/0.722 为上界；Q2/Q4 early20 0.816/0.930 亦低于 raw 3.152/1.623；早段按 t 非随机、eval 子集与全 block 不同、α/ε 固定、单 seed/3 窗，结论为延迟标签量/估计不足、描述性。**E26e-x 补充**：层次 EB（cell→mode α=50）在 Q3 early-20% 把 lift 1.464→**1.835**、AUC 0.645→**0.678**（primary PASS），但 early-40% 1.384、Q2 0.816、Q4 0.799 均不稳（Q4 B-40 0.0、C/D 1.3–2.6 属小样本），α=20/50/ε 固定、单 seed/3 窗；结论仍不能部署/总分。**E26e-z 补充**：外部独立批次仅 18 有效 replay/37 launched/115 fired（23 staged 文件中 5 个 0 行），T4 checkpoint headB **1.862×base（<2.0 门禁 FAIL）**、AUC 0.602，headC 1.9896/ρ 0.596/CI [0.0,5.36]；外部批次 pve/event/cooperative + 20% unknown 船级，属版本/时间/模式外推上限，描述性、样本极小，不重训/不调线。**E26e-ab 补充**：逐鱼 server damage 不可识别（无 victim/damage/逐鱼 ledger）；HP-drop magnitude 变体只改变行级标签严重度，lift 2.61–3.08 伴随 top-decile 命中率 17.96%→3.61–5.84%（hits 16–30%），不能替代逐鱼真值；后续需协议层 per-shot victim/damage 或 server ledger。E26e-ad in-dist 基线显示 in-dist event/DD 并不弱（event AUC 0.741/3.071×、DD 0.670/2.033×、event|DD 0.589），外部 event 0.553/event|DD 0.349 属**外部/地图/版本分布漂移**；全局过预测为模型级（in-dist meanProb 4.08% vs base 1.62%、ECE 2.46pp）。**E26e-ac 补充**：外部 event/DD 弱为过预测（meanProb 4.3–4.6× base、ECE 2.5–2.7pp）+ 区分弱（event AUC 0.553、DD 0.623、event|DD 0.349）双因素；headC event 10 launched/0 hits、DD 7/27/5、event|DD 2/10/0 不可评；无法排除标签噪声，描述性、不重训/调线/部署。**E26e-ad 补充**：in-dist event/DD 有信号（AUC 0.741/0.670、headC event 1.756*/DD 2.084），外部弱是分布/版本漂移而非模型固有；全局过预测 in-dist ECE 2.46pp、meanProb 4.08% vs base 1.62% 为模型级；外部 headC 不可评。 **E26e-ae 补充**：交付 T4 温度下外部 headB ECE 1.68→0.24pp、Brier/logloss 改善（meanProb 2.90%→0.98% vs base 1.22%），T_C 对 headC ECE 6.94→5.81pp 但 Brier/logloss 略升；排序完全不变，headB 门禁仍 FAIL，部署仍 T4 r120。 **E26e-af 补充**：外部 vs in-dist 44 维 domain AUC overall 0.990、event 0.997、DD 0.991、event|DD 1.000；event unknown 59.9%、event 模式内四图首见（46/17/35 其他模式可见）、event|DD allyHydro/allyRadar SMD≈4.0 → 强协变量漂移（unknown/新图/遥测 sentinel/几何），非因果、不重训/调线/部署。 **E26e-ag 补充**：matched global map+class 1.405×（strict 1.365×/top0，19/8 正）、unmatched novelty pve s09 3.558× → novelty 过滤反而更差，FAIL 是 event 模式特异域漂移；matched event 1.357×/top0/AUC .553，pvp 3 正/coop 6 正不作恢复证据；headC 19/57/7 lift 0、strict 8/26/0 不可评；条件化仅设计、不重训/调线/部署。
### T4 · torp4 诊断包交付（**诊断-only，不进总分**）

- **裁决/定位**：一次升到 **torp4（49 维，= 27 core + 11 torp2 + 6 torp3 + 5 torp4）**、3 头
  （logitA/B/C），作为**独立诊断卡**交付；不改 E26 主决策分/总分。
- **模型契约（app 侧兼容）**：输入 `entity[1,24,15]` / `global_feat[1,49]` / `mask[1,24]`；
  输出 `logitA`（原值）、`logitB = logitB_raw / T_B`、`logitC = logitC_raw / T_C`（[1,1] 各一）；
  app 仍 `sigmoid(out)`。opset17、静态 shape、**fp32 only（不做 int8）**。
- **温度（烤图，不重拟合）**：T_B=**0.7564**、T_C=**1.0723**（E26e-g 5 折 OOF 全局温度）；
  headA 温度 1.0。final-fit 用全量行训练（无 CV），其 in-sample logits 过自信，因此沿用 OOF 温度；
  若未来端上需要重新校准，应另立实验在**留出集**上拟合，而不是用 final-fit 自身样本。
- **训练口径**：3,111,384 行 / 2,215 局全量；torp4 + click sidecar（E26e-g 复用）；hidden192 /
  12 epochs / batch4096 / lr1e-3 / smoothing0.05 / λ_C=0.1 / float16 / cuda；node3：加载 393.2 s、
  训练 130.2 s（loss 0.3769→0.3250）、导出+parity ~20 s。
- **产物（`out/torpedo_model/final_torp4/`，out ignored 不进 git；已从 node3 拉回）**：

  | 文件 | size | sha256 |
  |---|---|---|
  | `fp32.onnx` | **502,518 B** | `0b1f4efd7995991f3717d433179fe7eb12dba7b9de86f4bb0c2377e15a8ad908` |
  | `checkpoint.pt` | 503,010 B | `4f3935541396a5a393c4a65878710d897399f61080e14885cdc89b4e0960da26` |
  | `metrics.json` | 3,199 B | `adfab78435df8e0926db85d902e38fde457dca99f810c44f8e376b2dbe0507c6` |
  | `parity_vectors.json`（200 行） | 1,089,149 B | `4daadeec2a234740c77c84cfd75cfdadafe1894c8008bb882fd48ccb44ab4a8f` |

  ONNX 校验：`onnx.checker` 通过；torch(CPU wrapper) vs onnxruntime 1,000 行 max|Δlogit|
  **A 7.15e-6 / B 2.86e-6 / C 3.81e-6**（<1e-4，passed）。
- **parity fixture（tracked，供 B 的 Rust parity 测试）**：
  `packages/app/tauri/src/commands/fixtures/torpedo4_parity.json`（JSONL，**48 行**，109,365 B，
  sha256 `3fe2bff7d0452b9469351cb80f27d557b61a2357d89dab33ace406318f5a6835`）。每行：
  `decisionRow`（core v2，app 侧可用既有 featurizer 复算 entity/global）+ `torp2Extras[11]` +
  `torp3Extras[6]` + `torp4Extras[5]` + **`clickContext`（5 键：计算 torp4Extras 的精确输入）** +
  **`attrs`（5 键：计算 torp3Extras 的精确输入/变体零值）** + `global49[49]` +
  `logitA/logitB/logitC`（**温度已烤**）+ `scenario` 标签。边界覆盖（各 6 行）：正常 DD/CL/BB/SS；无敌人；敌舰超射程；极近敌舰
  ETA clamp=1；无 click（sidecar 哨兵 -1）；hull 不在属性表（torp3 全 0）；属性表条目缺 5 字段；
  stale 目标+友军混合（并覆盖 labelACanLaunch/labelBLaunched 两种）。
- **fixture 生成（可复现，固定顺序）**：
  `python scripts/experiments/export_torpedo4_parity.py --checkpoint out/torpedo_model/final_torp4/checkpoint.pt
  --onnx out/torpedo_model/final_torp4/fp32.onnx --out packages/app/tauri/src/commands/fixtures/torpedo4_parity.json`；
  脚本用训练脚本**同一套 derive 函数**（torp2/torp3/torp4，double 中间）生成 global49，再用 checkpoint
  的导出 wrapper 计算期望 logits，并在写盘后自检：global49 与 decisionRow 复算一致（≤1e-9）、
  fixture vs ONNX max|Δlogit| **1.43e-6**（<1e-5）。`--seed` 仅用于行顺序（行内容确定）。
- **手动放置（诊断模式）**：把 `fp32.onnx` 复制为
  `%LOCALAPPDATA%\WoWSP\decisions\torpedo4_model.onnx`（诊断卡读取该文件；app 侧归一化/接线由 B 负责）；
  `torpedo4_model.onnx` 缺失时 app 会**回退到旧 `torpedo_model.onnx`**（two-head，无 effectiveness）；
  新旧都缺才显示“模型未安装”/N/A（不会回退到 E26 主决策模型）。
- **诊断-only 声明**：本模型**不参与**主决策评分/推荐总分，不改变 E26/E26b–E26h 任何验收线；
  torp4 的诊断结论以 E26e-g OOF（headB 0.042126 / top-lift 2.905；headC outcome lift 2.1997）为准，
  final-fit 本身不提供泛化估计。
- **局限**：命中仍是**代理标签**（ShotKillEvent 终点 120 units + HP-drop 覆盖，非 server 真值）；
  SS 仅 101 行；torp3 属性表来自 GameParams（版本敏感，季/版本漂移需重生成）；torp4 click
  口径为 30 s 计数/最近点击龄（粗糙，无目标/管位/距离）；final-fit 无 CV；fixture 为合成 decisionRow
  （覆盖边界但非真实对局）；未做 int8/端上延迟评估。
- **下一步**：B 侧接诊断卡 + fixture parity；端上概率分级可复用本包的温度（T_B/T_C）与 ONNX；
  若 Torp4 进正式分数，需另立预注册的留出集校准与 A/B 评估。
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
