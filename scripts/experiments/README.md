# Decision-AI feasibility experiments

> 阶段 0 可行性实验：为「内置预训练 ONNX 决策模型（输入不完全博弈信息，输出
> 行进 / 开火 / 武器选择建议）」验证四个关键前提。本目录是实验工作区，
> 结论随实验完成回填到本文档；产出的数据文件一律不入库（见 `.gitignore`）。

| # | 实验 | 验证的问题 | 状态 |
|---|------|-----------|------|
| E1 | ONNX 推理壳（`packages/app/tauri/src/commands/decision_ai.rs`） | `ort` 能否静态链接进 `wowsp_tauri`、加载 ONNX、经 Tauri IPC 跑通一次前向 | 待做 |
| E2 | CruiseState `0x32` 解码 | replay 里的节速 / 舵角状态包能否解出逐船速度，补齐决策模型的动作标签 | 待做 |
| E3 | 录像可见性探针 | 未点亮敌舰在位置样本流中是否存在间隙（>4s），证实「客户端视角 = 天然不完全信息」假设 | 待做 |
| E4 | 地形 LOS 栅格烘焙（`bake_terrain_los.py`） | 能否从已分发的地图 GLB 网格烘焙出高度 / 视线（LOS）栅格，支撑地形与烟雾视野特征 | 待做 |

## 结论

（实验完成后回填）
