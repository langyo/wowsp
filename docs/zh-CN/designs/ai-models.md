# AI 模型分发：Hugging Face 渠道与多 provider 镜像（设计契约）

> 状态：草案（DRAFT）——`feat/ai-models` 这一波工作的实现契约。
> 范围：把内置的决策/评分模型（ONNX 权重、舰船属性路由表、逐地图地形通视栅格）
> 以及训练与部署脚本发布到一个公开的 Hugging Face 模型仓库；通过一条新的、
> 带签名的 `ai` 资源通道以逐文件下载的方式提供给客户端；并把目前只支持
> GitHub 的镜像梯子泛化成与 provider 无关的镜像上下文，供所有可下载资源共用。
>
> 不在范围内：已冻结的 App 更新通道、`res-latest` 资源包（仍留在 GitHub
> Releases）、训练管线本身，以及录像数据集的发布。

## 1. 问题与目标

内置决策模型（ONNX 开火/走位评分头、属性路由建议模型、可选的鱼雷模型、
属性路由表、逐地图地形通视栅格）目前**完全没有分发通道**。它们只存在于
`scripts/experiments/out/` 下、被 gitignore 的训练产物里；已安装的
`<cache>/decisions` 模型包是手工拷贝出来的目录，App 只能清点与清除。
没有发布脚本、没有 manifest、没有 digest、没有下载器、没有版本戳，也没有
覆盖率保证——如今 96 个已知地图 id 中只有 35 个带通视栅格，已装的两个模型
比当前 fp32 导出旧且体积约小一半，advice/torpedo 槽位干脆是空的。

与此同时，App 已经知道如何服务一个更完整的资源包：`res-latest` 资源包由
本仓库发布，对中国大陆网络通过 ghproxy 风格的镜像梯子加速，用官方 sha256
digest 校验，并原子化地安装。决策模型通道应当达到同样的工程标准，但不必
继承 1.3 GB 资源包的约束。

目标：

1. **一个公开、可复现的产物。** 每次模型发布都由仓库内脚本从指定的仓库
   commit 生成，并与训练/部署脚本一起发布到公开的 Hugging Face 模型仓库。
2. **模型更新独立于 App 发版——但受特征契约约束。** 只要输入/特征 schema
   与运行中的 featurizer 匹配，重训后的模型无需新的 App 构建就能到达已安装
   的客户端；schema 变更按定义就是一次 App 发版。
3. **执行前先校验完整性。** 模型文件会被 ONNX Runtime 解析并执行，因此该
   通道必须 fail-closed：签名 manifest 钉住每个文件的 sha256 与 Hugging Face
   commit，未签名或不匹配的载荷永不安装。
4. **中国大陆可达。** 在 `huggingface.co` 不可达的网络环境（维护者网络已
   实测）下运行时梯子必须可用，且不能把某一家第三方镜像写死。
5. **统一的镜像框架。** GitHub、Hugging Face 与（后续的）ModelScope 共用
   同一个 provider 感知的上下文——候选重写、探测、健康/粘性选择、可漂移
   检测的端点清单——而不是五份重复的 ghproxy 前缀列表。
6. **仓库中不含密钥。** Hugging Face 凭据只存在于环境变量或用户 token 库，
   绝不进入被跟踪的文件。

### 1.1 实测输入

| 产物 | 来源（开发检出） | 大小 |
| --- | --- | --- |
| 开火模型（fp32，v2 ablate NONE） | `scripts/experiments/out/fire_model/v2plain_std/fp32.onnx` | 2,592,543 B |
| 走位模型（fp32，17 类，ablate E11） | `scripts/experiments/out/move_model/node3/main/fp32.onnx` | 2,652,542 B |
| 建议开火模型（fp32，E24 属性路由） | `scripts/experiments/out/fire_model/e24_attrs/fp32.onnx` | 2,595,135 B |
| 鱼雷模型（fp32；int8 可选） | `scripts/experiments/out/torpedo_model/final/fp32.onnx` | 492,411 B（int8 136,214 B） |
| 舰船属性路由表 | `scripts/experiments/ship_attributes.json` | 261,507 B |
| 地形通视栅格 | `bake_terrain_los.py` 输出，每张地图一个 `terrain_los.npz` | 每个 5,986–221,638 B（已装 35 张） |

每个文件都远低于 10 MB 的更新体积预算。Hub 仍会通过 Xet/LFS 存储二进制块，
因此 `/resolve/` 返回的是签名 CDN 重定向而不是 200；下载器会跟随该重定向
（在最终主机上保持 Range/断点续传），不需要 Xet 客户端，而签名 manifest 与
逐文件 sha256 保证字节的权威性（见 4.2 与 7.8）。

## 2. 现状

| 方面 | 现状 | 后果 |
| --- | --- | --- |
| 模型发布 | 无 | 模型只能靠手工拷贝到达用户 |
| 已装模型包 | `<LOCALAPPDATA>/WoWSP/decisions`，手工拷贝 | 陈旧/不完整；无版本戳；无法发现代次错误的模型 |
| 模型加载 | `decision_serve` 阶梯：env -> pack 槽位 -> 开发产物；`ship_attrs` 使用编译期 `include_str!` 表 | 属性表变更需要 App 发版；"pack 覆盖内置表"只是注释，尚未实现 |
| 资源包 | GitHub `res-latest` + delta 链 + relay 签名 digest | 成熟，保持不变 |
| 镜像梯子 | 只认 GitHub 主机、ghproxy 前缀拼接；副本散落在 Rust、Cargo metadata、Python、website、webui mock、relay CSP | 无法代理 `huggingface.co`；只对其中一份做了漂移测试 |
| 移动端 | ONNX Runtime 是默认 feature，Android/iOS 构建已包含 ONNX；decisions 包未打包 | 移动端同样能受益于该通道 |
| 注册表行 | `decisions-pack`，channel 为空，trigger 为 `manual` | 没有检查/下载按钮，也没有 freshness ledger 记录 |

因此这一波是**新建通道**，不是迁移。

## 3. 架构总览

三层，各司其职：

```text
  GitHub repo (source of truth)
      |  python scripts/publish_ai_models.py  (hash -> sign -> upload)
      v
  Hugging Face model repo  wowsp-d1  (generated release artifact + scripts snapshot)
      |  signed manifest.json + per-file resolve/<commit-sha>/<path>
      v
  client  commands/ai_pack.rs  --->  commands/mirror/ (MirrorContext)
      |      per-file download via download_hub        GitHub | Hugging Face | ModelScope
      v
  <cache>/decisions  (fire/move/advice/torpedo + attrs + <map>/terrain_los.npz)
```

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 下载源 | v1 只发 Hugging Face（加内置 `hf-mirror.com`）；GitHub Release 备用源与 ModelScope 是后续 provider | 只验证一条发布路径；镜像上下文让新增 provider 成本很低 |
| manifest 信任锚 | 使用现有已 pin 的 Ed25519 密钥自签名 manifest，并加 `seq` 单调计数 | Hugging Face 没有官方逐资源 digest；relay digest 通道会让每次模型发布多一步部署，却没有额外保障 |
| 传输粒度 | 每个产物一个文件，原子 staging 安装 | 所有文件 < 10 MB；可增量更新；下载枢纽本就支持分段进度、sha256、字节上下限、续传与取消 |
| 镜像选择 | provider 感知梯子 + 冷启动 hedge + 每轮粘性端点 + 健康冷却 | 部分用户所在网络无法访问官方主机；同时必须保留用户列表的确定性顺序 |
| 资源包 | 不变，仍只走 GitHub | 5.7k 文件、delta 链与 GitHub 资产 digest 仍是更合适的组合 |

## 4. Hugging Face 仓库

### 4.1 布局

```text
wowsp-d1/                          public model repository (owner/repo TBD, see 11)
  README.md                        model card: purpose, provenance, metrics, file table, licence
  LICENSE                          Synthetic Source License 1.0 (same as the app repo)
  manifest.json                    signed runtime manifest (section 5)
  NOTICE.md                        game-data provenance and redistribution note (section 4.5)
  onnx/fire_model.onnx
  onnx/move_model.onnx
  onnx/advice_fire_model.onnx
  onnx/torpedo_model.onnx
  onnx-int8/                       optional quantized variants, never installed by default
  attrs/ship_attributes.json
  los/<mapId>/terrain_los.npz
  training/                        generated snapshot: scripts/experiments training/deployment scripts
  SOURCE.json                      {"repo","commit","generatedAt","tool":"scripts/publish_ai_models.py"}
```

`manifest.json` 是 App 唯一视为"通道入口"的文件。各个文件本身也单独可下载，
供人和 model card 的文件表使用。

### 4.2 文件大小规则

每个仓库文件保持在 **10 MB 以下**，让更新保持小而增量。即使低于该阈值，
Hub 仍会通过 Xet/LFS 存储二进制块（纯 Git 提交二进制会被拒绝），因此
`/resolve/` 返回的是签名 CDN 重定向而不是 200；下载器会跟随该重定向，并在
最终主机上保持 Range/断点续传，全程不需要 Xet 客户端。通视栅格目前每张地图
一个文件（都远低于限制）；若未来某个包超过单文件限制，就把 LOS 拆成编号
bundle，每个仍低于该阈值。发布脚本会拒绝超过 10 MB 的暂存文件并打印其路径。

### 4.3 版本模型

Hugging Face 的 revision 就是 commit；分支/tag 可以移动，commit SHA 不会。
因此发布使用两次 commit：

1. 上传产物文件（权重、属性表、LOS、脚本快照）-> commit `A`；
2. 上传 `manifest.json`、`README.md`、`LICENSE`、`NOTICE.md` 与
   `SOURCE.json`，manifest 中写 `"revision": "A"` -> commit `B`。

App 从分支头（`main`）拉取 `manifest.json`，验签后按
`/{repo}/resolve/{A}/{path}` 下载每个文件——这是不可变的 pin。缓存了旧
manifest 的客户端即使 `main` 前进也继续使用旧 commit。`models-<seq>` 之类的
标注只供人阅读。

### 4.4 发布流程与操作

`scripts/publish_ai_models.py`（仿照 `scripts/release_models.py`）：

1. 收集输入（权重、`ship_attributes.json`、烘焙好的 LOS 目录、指定 commit 的
   `git archive` 脚本快照）；
2. 逐文件哈希、构建签名 manifest（第 5 节）、计算 tree 哈希；
3. 上传产物（commit A），再上传 manifest 与文档（commit B，pin 到 A）；
4. 打印发布摘要（seq、manifest sha256、HF commit、文件表）。`--dry-run`
   执行所有本地步骤但不上传。

**账号、token 与仓库创建。** Hugging Face 没有匿名写路径：发布需要账号与
write token。token 在网页端创建（Settings -> Access Tokens，建议使用仅限该
仓库 write 权限的 fine-grained token），通过 `HF_TOKEN` 环境变量或标准用户
token 库（`~/.cache/huggingface/token`）提供。仓库本身可以由脚本通过
`huggingface_hub.create_repo`（REST `POST /api/repos/create`）、网页端或
可选的 `hf repo create` CLI 创建——三者等价，**CLI 不是前提条件**。发布脚本
使用 `huggingface_hub` Python API，官方 `huggingface/hub-sync` GitHub Action
也只是它的封装；后续可以让 CI 用仓库 secret 里的 `HF_TOKEN` 运行同一脚本
（token 绝不入库）。

**网络现实。** 只有 `huggingface.co` 接受写操作。中国大陆网络无法直连该主机
（实测：连接超时），因此本地发布需要维护者的 HTTP(S) 代理（`HTTPS_PROXY`），
或者在 CI 上发布。镜像是只读代理：运行时读取不需要代理，写入需要。上传后
可以通过镜像做校验（7.8）。

**版本。** `seq` 是严格递增的发布计数，存在 `manifest.json` 中（发布脚本
会在新值不大于当前已发布 manifest 时告警）。`version` 是 UTC 发布时间；
内容身份是 `treeSha256`（5.4 节）。

### 4.5 文档与来源

- `README.md` 是 model card：每个模型做什么、featurizer 契约、来自
  `scripts/experiments/README.md` 的评估数字（适用时含 auPRC/AUC/ECE/
  decile lift）、输入/输出张量形状、复现方法、指向确切 GitHub commit 的链接
  以及许可证。
- `SOURCE.json` 记录仓库、commit、生成时间与确切 tree 哈希，使发布产物可
  追溯到代码。
- `training/` 是 `scripts/experiments/` 的**生成快照**（脚本、构建辅助、
  研究日志）。model card 明确说明权威来源是记录 commit 处的 GitHub 仓库，
  并禁止在 Hugging Face 侧编辑该快照。
- 原始录像语料永不发布：那是用户贡献的对局数据。model card 仅以聚合方式描述
  语料形态与过滤/授权依据。
- `NOTICE.md` 记录：通视栅格由已发布的地图几何烘焙而来，属性表派生自游戏
  数据，并重申 Synthetic Source License 的披露要求。权重由录像派生特征训练
  而来。这与公开的 `res-latest` 通道已经在分发的数据类别相同；发布到第二个
  公开主机不改变许可证，但会改变可见度，因此显式说明（第 11 节决策 2）。

### 4.6 同步策略

GitHub 是唯一真源。Hugging Face 是生成的发布产物：不允许手工编辑、不允许
第二条开发分支、不允许反向同步。模型变更从本仓库开始（训练脚本 + 产物作为
发布脚本的输入），然后由维护者运行发布脚本。因此两个主机之间的差异由
commit 来源解释，而不是并行维护。

## 5. 签名 manifest

### 5.1 示例

```json
{
  "format": 1,
  "seq": 7,
  "version": "2026-11-08T14:22:03Z",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "source": { "repo": "langyo/wowsp", "commit": "89abcdef0123456789abcdef0123456789abcdef" },
  "resTreeSha256": "3f2a...",
  "files": [
    { "path": "fire_model.onnx", "sha256": "8ba9...", "size": 2592543,
      "kind": "fire-two-head", "featureSet": "fire-v1", "quant": "fp32" },
    { "path": "move_model.onnx", "sha256": "bc91...", "size": 2652542,
      "kind": "move-sectors-17", "featureSet": "move-v1", "quant": "fp32" },
    { "path": "advice_fire_model.onnx", "sha256": "b98f...", "size": 2595135,
      "kind": "advice-fire-attrs", "featureSet": "advice-e24", "quant": "fp32" },
    { "path": "torpedo_model.onnx", "sha256": "a7e3...", "size": 492411,
      "kind": "torpedo-three-head", "featureSet": "torpedo-e26d", "quant": "fp32" },
    { "path": "ship_attributes.json", "sha256": "2bbd...", "size": 261507 },
    { "path": "50_Gold_harbor/terrain_los.npz", "sha256": "9c1d...", "size": 172432 }
  ],
  "treeSha256": "d41d...",
  "metrics": { "fire": { "auprc": 0.32, "auc": 0.72 } },
  "key_id": "main",
  "sig": "MEUCIQ..."
}
```

### 5.2 字段

| 字段 | 含义 |
| --- | --- |
| `format` | manifest schema 版本（1） |
| `seq` | 严格递增的发布计数；App 拒绝低于已安装值的 manifest |
| `version` | UTC 发布时间，仅用于展示 |
| `revision` | 恰好包含所列文件的 Hugging Face commit SHA |
| `source` | 本次发布生成自的 GitHub 仓库 + commit |
| `resTreeSha256` | 烘焙 LOS 栅格所对应的资源包 tree 哈希（可选；不发布 LOS 时省略） |
| `files[].path` | `<cache>/decisions` 内的目标路径；普通相对路径，逐段校验（`[A-Za-z0-9._-]`，无 `..`，段内无分隔符） |
| `files[].sha256` | 确切字节的小写 sha256 |
| `files[].size` | 字节大小，用作传输下限/上限 |
| `files[].kind`、`featureSet`、`quant` | 模型契约元数据；`.onnx` 条目必填，数据文件没有 |
| `treeSha256` | 内容身份：对排序后的 `path\0sha256\n` 行做 sha256（与资源包完全相同的公式，便于同一套工具为两者哈希） |
| `metrics` | 从训练报告复制的展示用元数据 |
| `key_id`、`sig` | Ed25519 签名层 |

### 5.3 签名与防回滚

签名覆盖 manifest **去除 `sig` 成员后**的规范 JSON——键排序、紧凑分隔符、
UTF-8——与 `scripts/catalog_signing.py` 已实现、且 App 端用编译期 pin 的
公钥（`packages/app/tauri/res/keys/*.pub`）验证的规范形式一致。签名复用现有
release-digest 密钥仪式，不引入新密钥对。

App 在解析字段前先验签，然后施加 `seq` 棘轮：已验签但 seq 低于本地已存储
值的 manifest 被拒绝（防重放/降级）。因此镜像最多只能重放旧签名 manifest，
永远无法伪造。manifest 获取失败或签名无效是本次检查的硬失败——该通道刻意
**没有**"接受未经验证的镜像 manifest"的回退，因为载荷是可执行的模型内容。

### 5.4 新鲜度与陈旧

`manifest.json` 从 Hugging Face 分支头拉取。镜像缓存可能短暂提供旧副本；
旧 manifest 仍是真实的，只是更旧，因此检查要么以旧 seq 报告"已是最新"，要么
等下一次检查。发布端的上传顺序（先产物、后 manifest）保证 manifest 绝不会
指向在其 pin revision 上尚不可解析的文件。缓存文件只有 sha256 与 manifest
匹配时才被接受。

## 6. 运行时通道（`ai`）

### 6.1 注册表与 RPC 面

| 项 | 变更 |
| --- | --- |
| `resources.rs` 注册表行 | `decisions-pack` 改为 channel `ai`、trigger `boot`（静默检查）+ 手动、progress kind `ai-models` |
| 状态 ledger | 把 `decisions-pack` 加入 `STAMPED_ROWS`，使 `<data>/resources/decisions-pack.json` 记录安装/检查时间 |
| 新命令 | `ai_pack_status`、`ai_pack_check`、`ai_pack_download`、`ai_pack_cancel`；清除复用 `clear_decisions_pack`（扩展为同时删除版本戳） |
| 进度 | `wowsp://download-progress`，kind `ai-models`，每轮一个 job，`detail` 内带逐文件分段 |
| webui | 设置 -> 资源卡片（6.8 节）、api 模块、`rpc.ts`、webMock、parity 测试 |

### 6.2 检查时序

1. 通过镜像上下文解析 manifest URL 并拉取 `manifest.json`（小文件；冷启动
   hedge，之后粘性端点）。
2. 校验 Ed25519 签名与规范形式；解析；施加 seq 棘轮。
3. 与 `<cache>/.ai-version.json` 的 `seq` / `treeSha256` 比较（版本戳放在
   `decisions/` 旁边而非内部，保持 tree 哈希干净）。无差异 -> 报告当前状态。
4. 当 manifest 声明的模型无法被当前构建加载时（见 6.6），把该发布标记为不
   兼容，而不是下载它。

启动时的检查是静默的，带 TTL（24 小时），卡片上也随时可手动触发。检查永不
下载；下载始终是用户动作。

### 6.3 逐文件下载

所有文件都走 `download_hub::transfer`，`kind = "ai-models"`：

- 候选来自镜像上下文（Hugging Face provider，revision 取自 manifest 的 pin），
  永远不套用 GitHub 的 mirror 前缀；
- `expected_sha256` = manifest 哈希，`min_bytes = max_bytes = size`，
  `total_hint = size`，`resume = true` 并按文件使用 part 名；
- 单个文件失败只让该文件回退到下一个端点；本轮已校验的字节保留在 staging
  树中；
- 进度按整轮聚合字节（`base_received`/`base_total`）并附
  `detail: {file, index, files}`；取消遵循下载枢纽的标准作用域；
- 文件写入 `<cache>/.ai-staging/<path>`；在每个文件存在并校验通过之前，
  绝不触碰现役模型包。

### 6.4 安装前校验

交换前，在阻塞任务中：

1. 对 staging 文件重算 `treeSha256` 并与 manifest 比较（任何多余/缺失文件
   都会让本轮失败）；
2. 对每个 `.onnx` 文件，用现有 ONNX Runtime 封装加载并分类：kind、输入宽度
   与输出头必须与声明的 `kind`/`featureSet` 匹配（开火：24 x
   `ENTITY_DIM_V2` x `GLOBAL_DIM_V2`；走位：17 类；建议：属性路由头；
   鱼雷：`TORP_GLOBAL_DIM_V2` 全局块）；
3. 若必需模型校验失败则拒绝本轮；可选模型（advice、torpedo）仅在 manifest
   标记其为可选时才允许带警告丢弃。进程内已缓存的模型继续服务到重启。

这消除了当前手工模型包无法检测的"代次错误"故障模式，代价是交换前解析几 MB。

### 6.5 安装、版本戳与回滚

1. `decisions` -> `.decisions-backup`，staging -> `decisions`；
2. 写入 `<cache>/.ai-version.json`：`{schema, seq, version, revision,
   treeSha256, manifestSha256, keyId, installedAt}`；
3. 写入 freshness ledger 行；成功后删除备份；
4. 任一步失败（交换、版本戳、ledger）都恢复备份并让命令失败；取消的轮次
   不改动旧包。

因此校验失败、崩溃或用户取消始终回退到上一个可用包。卡片在 `decisions`
存在后提供"清除"；已加载的会话保留到重启（现有行为）。

### 6.6 特征契约

模型文件与镜像 Python 训练脚本的 Rust featurizer 耦合。manifest 的
`featureSet` 值就是契约：

| 模型 | kind | v1 特征集 | 必需 |
| --- | --- | --- | --- |
| fire_model.onnx | 开火双头（24 实体 deep sets） | `fire-v1` | 是 |
| move_model.onnx | 17 类走位扇区 | `move-v1` | 是 |
| advice_fire_model.onnx | 属性路由建议头 | `advice-e24` | 否 |
| torpedo_model.onnx | 三头鱼雷模型 | `torpedo-e26d` | 否 |

只有当每个必需模型的特征集都在 App 支持集合内、且每个可选模型的特征集要么
受支持要么缺席时，App 才接受该发布。featurizer 变更时，在同一 PR 中修改 Rust
featurizer 并提升特征集名称，从而过时的 App 永远不会把新权重喂给错误的张量。

### 6.7 LOS 栅格与资源包

LOS 栅格烘焙自资源包中的地图几何。当地图 GLB 变化（游戏版本升级）时，旧栅格
描述的是旧地形。manifest 的可选字段 `resTreeSha256` 记录烘焙栅格时对应的
资源包 tree；App 与已装资源包的版本戳比较，不匹配时安装模型但跳过 LOS 文件
（现有的逐地图查找本就容忍栅格缺失），并提示用户先更新资源包。发布端在资源包
发布之后再烘焙 LOS，并记录相同的 tree 哈希。

### 6.8 UI、i18n 与移动端

- 设置 -> 资源卡片新增：当前版本（发布时间与 tree 哈希后缀）、逐模型行（存在/
  大小/sha 前缀）、LOS 覆盖率（`x/已知地图数`）、总大小、检查/下载/取消
  按钮、重启提示，以及镜像梯子分组（7.6 节）。
- i18n：现有 13 个 `settings.resourcesDecisions*` 键扩展出检查/下载/进度/
  版本/LOS 覆盖率等字符串，覆盖八个设置 locale（en-US、zh-CN、zh-TW、
  ja-JP、ko-KR、fr-FR、es-ES、ru-RU）；正确性由 `scripts/check_i18n.py`
  把关。
- 移动端使用同一通道（ONNX Runtime 已是默认 feature）。Slim APK 按需下载
  模型；把基线打进安装包/APK 是后续可选项（第 10 节 PR4）。
- 不启用 `ai` feature 的构建（portable 形态）不链接 ONNX Runtime：通道要么
  隐藏，要么显示为不可用，绝不下载无法加载的模型。

### 6.9 失败模式

| 失败 | 行为 |
| --- | --- |
| 无镜像可达 / manifest 4xx-5xx | 检查失败，现役模型包继续服务，原因记录并在卡片展示 |
| 签名无效 / seq 回退 | 硬失败；不安装，也不回退到未验证内容 |
| 文件 sha 不匹配 | 丢弃该候选；尝试下一个端点；全部失败则本轮失败 |
| 模型加载/kind/宽度不匹配 | 交换前拒绝本轮；恢复旧包 |
| LOS 对应到不同的资源包 tree | 安装模型、跳过 LOS 并给出说明性警告 |
| 磁盘满 / 取消 | staging 清理或保留以便续传；现役包不动 |
| App 升级、特征集提升 | 旧模型仍已安装，但新构建在安装到兼容发布前不会加载它们 |

## 7. 镜像上下文

### 7.1 当前的痛点

`github_mirror.rs` 只知道 `github.com`/`api.github.com`，用
`{prefix}/{完整 URL}` 重写。Hugging Face 镜像则是替换 endpoint 基址、保留
路径；ModelScope 又是另一种路径模板。内置列表重复出现在 App、`Cargo.toml`
的 shun metadata、`scripts/fetch_models.py`、website 下载页、webui mock 与
relay CSP 中，只有 Cargo 那份有漂移测试。六个消费者（`update`、
`model_pack`、`data_pack`、`mod_catalog`、`changelog`、`media`）
各走各的循环。

### 7.2 provider 模型

新模块 `packages/app/tauri/src/commands/mirror/`：

```rust
pub enum ProviderId { GitHub, HuggingFace, ModelScope }

pub enum Rewrite {
    UrlPrefix,                                  // GitHub: {prefix}/{official_url}
    Endpoint { template: &'static str },        // HF: {base}/{repo}/resolve/{rev}/{path}
                                                // MS: {base}/models/{repo}/resolve/{rev}/{path}
}

pub struct HfResource<'a> {
    pub repo: &'a str,      // "owner/name"
    pub revision: &'a str,  // pinned commit sha (validated as a plain segment)
    pub path: &'a str,      // repository-relative file path (validated segment by segment)
}

pub struct MirrorContext { /* config snapshot, provider ladders, health/last-good cache */ }

impl MirrorContext {
    pub fn candidates(&self, target: Target<'_>) -> Vec<Candidate>;
    pub fn probe(&self, provider: ProviderId) -> Vec<ProbeRow>;
    pub fn sticky(&self, provider: ProviderId) -> Option<Endpoint>;
}
```

下载枢纽仍接收 `Vec<String>` 源：provider 解析是 (config, target) 的纯函数。
digest/签名策略留在各通道内，保持"镜像 URL 只是传输、绝不是内容身份"的
不变式。

### 7.3 URL 矩阵

| Provider | 官方 | 镜像重写 | 探测 |
| --- | --- | --- | --- |
| GitHub | `https://github.com/langyo/wowsp/releases/download/<tag>/<asset>` | `{ghproxy-prefix}/{官方 URL}` | 仓库 `releases/latest` 页（现有） |
| Hugging Face | `https://huggingface.co/{repo}/resolve/{rev}/{path}` | `{endpoint}/{repo}/resolve/{rev}/{path}`（如 `https://hf-mirror.com/...`） | pin 一个小文件：`{endpoint}/{repo}/resolve/{rev}/manifest.json`，HEAD 或 `Range: bytes=0-1023`，接受 200/206 |
| ModelScope（后续） | `https://www.modelscope.cn/models/{repo}/resolve/{rev}/{path}` | endpoint 替换，同一模板 | HEAD `resolve/{rev}/manifest.json` |

Hugging Face API 端点（`/api/models/...`）永不进入下载路径；若探测需要元
数据，就使用 pin 文件，因为匿名 API 桶远小于 resolver 桶。

### 7.4 选择、健康与 hedge

- 候选顺序由各 provider 的策略决定：GitHub 保持现有的"用户端点 -> 官方路线
  -> 内置端点"顺序；Hugging Face 使用"用户端点 -> 内置端点 -> 官方路线"（中国
  大陆优先）。设置面板仍按官方、内置、用户行的形式展示（与现有 GitHub 梯子同形）。
- **冷启动**：对小文件请求做错峰 hedge（官方 + 内置），先拿到校验通过的响应
  者胜出，其余取消。这避免了当前"官方优先、等 8–15 秒再回退"的行为——对中国
  大陆用户来说这段等待每次都会付。
- **每轮/provider 粘性**：一旦某候选响应，本轮剩余文件（整轮所有文件）优先
  使用它；失败则从已提交偏移在梯子内故障转移（枢纽行为）。
- **健康缓存**：逐端点记录最近结果、延迟和短暂失败冷却，会话级，并持久化
  provider 的上次成功端点（appdata，不进用户配置）。用户主动探测会清除冷却。
- 大文件传输继续使用枢纽现有的 race/failover；上下文只负责给源排序。

### 7.5 配置与 IPC

`network-config.toml` 增加一个追加式、可选的字段（与其余字段一样 camelCase）：

```toml
githubMirrors = ["https://ghfast.top"]
huggingfaceMirrors = ["https://hf-mirror.com", "https://hf-mirror.example"]
```

- 仅 base endpoint（必须有 scheme、仅 https、无 query/fragment、去尾部斜杠、
  <= 8 项、去重）；官方路线是隐式的，永不存储。
- `githubMirrors` 语义不变；旧版单个 `githubMirror` 字符串仍折叠到其头部。
- 未来的 `providerMirrors` map 可以在不破坏旧拼写的前提下取代逐 provider
  字段。
- IPC：`mirror_ladder(provider)` 与 `mirror_probe(provider)` 返回带
  provider 标签的 DTO；旧的 GitHub 命名命令保留一个版本作为薄封装，使
  webui/api parity 测试平滑切换。
- webui 抽出逐 provider 的 `useMirrorLadder(provider)` hook 与共享的
  ladder/probe 组件；GitHub 组留在更新页，Hugging Face 组放在模型卡片旁。

### 7.6 端点清单与漂移检查

唯一被跟踪的真源：`res/config/mirror-endpoints.json`（provider -> 官方
endpoint + 内置 endpoint 列表 + 探测目标类型）。Rust 用 `include_str!`
嵌入；Python（`fetch_models.py`）、website 与 relay CSP 允许列表由新的
`scripts/check_mirror_endpoints.py` 消费或核对，接入 CI 与 `just lint`——
取代目前"只测试 Cargo shun metadata"的状态。`res/config/upstream-endpoints.json`
（传输健康目录）加入新主机，使代理/直连回退与 upstream-health 页面认识它们。

### 7.7 实测的中国大陆行为（2026-11-08，维护者网络）

| 目标 | 结果 |
| --- | --- |
| `https://huggingface.co/api/models/...` | 连接超时（直连不可用） |
| `https://hf-mirror.com/api/models/...` | 200，完整 Hub API JSON，含 commit sha |
| `hf-mirror.com/<repo>/resolve/main/<file>` | 307 -> `/api/resolve-cache/models/<repo>/<sha>/<file>` -> 200，`Accept-Ranges: bytes` |
| 固定 commit 的 resolve | 200 |
| 经镜像的 LFS/Xet 文件 | 302 -> 签名的 `cas-bridge.xethub.hf.co` URL -> 200/206（镜像本身不存 blob 字节） |
| `www.modelscope.cn/models/<repo>/resolve/master/<file>` | 200 JSON，独立的国内 CDN |

这就是为什么中国大陆用户的默认 Hugging Face 梯子是内置镜像优先、官方最后，
也是为什么运行时从不依赖 `huggingface.co` 可达。

### 7.8 镜像注意事项

- 第三方镜像是尽力而为的公共服务，没有正式 SLA 或条款（hf-mirror.com 是
  社区项目；ModelScope 的再分发条款与配额未核实）。它们只是传输层：每个字节
  都经签名/sha256 校验，端点可由用户配置。
- 大文件可能经签名跳转最终由 Hugging Face CDN 提供；通道固定 commit 并校验
  sha256，因此陈旧或错误的文件只会失败，绝不会被接受。
- 签名 CDN URL 会过期（约一小时）；下载器在 403/过期时重新解析，而不是缓存
  这些 URL。
- 客户端永不内嵌 token：只使用公开仓库。

## 8. 兼容性、安全与不变式

- **冻结的 App 更新通道不受影响**：`v*` 更新器、其 shun metadata 与 digest
  流程都不因这一波而修改。
- **资源包不变**：仍是 GitHub `res-latest` + delta + 签名 digest；镜像上下文
  只改变候选的生成方式（GitHub 的顺序与 URL 完全一致）。
- **旧客户端不受影响**：现有客户端没有 decisions 包下载器，因此新通道不产生
  兼容义务；资源包线格式也不重排。
- **配置兼容**：新的 TOML 字段可选，旧构建会忽略；降级时配置自愈写入会丢弃
  它们（已有文档记录），下次升级 App 会重新补上默认值。
- **安全不变式**：版本与 digest 只信官方；镜像只是传输层；一旦取得官方锚点
  即具有约束力；可执行载荷 fail-closed；仓库中无密钥；ONNX 文件在交换前做
  kind/宽度校验。
- **威胁模型**：对照 `docs/en/designs/threat-model.md`；新暴露面是模型通道
  （公开、传输中未加密的内容，由签名保护）与第三方镜像端点（只读传输）。

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 游戏派生数据（LOS/属性表）被公开再分发（许可） | 沿用现有公开资源包的先例；`NOTICE.md` 说明来源；见第 11 节决策 2 |
| 第三方镜像消失或作恶 | 签名 + sha256 校验；端点用户可配；官方路线仍是候选 |
| Hugging Face 限额/政策变化 | 每次安装 46–120 个请求，远低于匿名 resolver 预算；manifest 优先设计；重试遵守 `RateLimit`/`Retry-After` |
| Hugging Face 把小文件也切到 Xet | 下载器跟随重定向并支持 Range/续传；若真发生，先端到端验证再内置端点 |
| 特征漂移（权重 vs Rust featurizer） | 显式 `featureSet` 契约；App 侧校验；featurizer 变更提升特征集 |
| LOS/游戏版本不匹配 | `resTreeSha256` 比较；跳过 LOS 并提示 |
| 镜像 manifest 陈旧 | 内容有签名 + seq 棘轮；发布端上传顺序；下次检查重试 |
| 未签名/恶意 manifest | fail-closed；pin 的 Ed25519 公钥；无明文回退 |
| 发布时意外泄露 token | `HF_TOKEN` 只来自环境/CI secret；按仓库规则做 pre-commit grep |

## 10. 落地计划

每一步都是独立 worktree + PR，遵循仓库工作流；**设计文档以全部九种文档
locale 发布**（en、zh-CN、zh-TW、ja、ko、fr、es、ru、ar）。

1. **PR1——镜像上下文（行为不变）。** 抽出 `commands/mirror/`，GitHub
   provider 保持完全相同的语义，配置字段 + sanitize + IPC 封装，webui 通用
   hook，端点清单与漂移检查。门槛：现有 ladder/config/hub/upstream 测试全绿；
   无线上格式变化。
2. **PR2——Hugging Face provider + 发布脚本。** HF provider（重写/hedge/
   探测）、`scripts/publish_ai_models.py`、model-card 与许可证模板、
   `just publish-ai-models`。门槛：dry-run manifest 夹具、provider 单测、
   对私有测试仓库做一次发布演练。
3. **PR3——`ai` 通道。** `commands/ai_pack.rs`、注册表/ledger 行、安装期
   ONNX 校验、`ship_attrs` 的 pack 覆盖、设置卡片 + i18n + RPC/webMock
   parity，更新 `docs/{en,zh-CN}/designs/resources.md`（locale 文件存在处同步
   译文行）。门槛：端到端演练（镜像离线、坏 sha、坏 ONNX、取消、回滚）、完整
   lint/test 矩阵。
4. **PR4——可选。** ModelScope provider/发布、GitHub Release 备用源、安装包/
   APK 内嵌基线、逐地图懒加载 LOS。

## 11. 待定决策

1. **Hugging Face owner/repo 名称** —— 已定：`langyo/wowsp-d1`（公开）。
   账号与 write token 由维护者持有；发布脚本首次运行时创建仓库。
2. **游戏派生数据的再分发声明**：把 LOS 栅格与属性表连同权重一起按现有许可证
   + 来源说明发布（建议，与公开资源包一致），还是把它们排除在公开模型仓库之外、
   只通过 App 的 GitHub 资源包分发。
3. **训练脚本快照范围**：整个 `scripts/experiments/`（建议）还是精选子集；
   是否包含研究日志。
4. **更新策略**：启动静默检查（24 小时 TTL）+ 手动下载（建议），还是自动
   下载约 12 MB 的包；是否提供"自动更新模型"开关。
5. **第二 provider**：是否把 ModelScope 作为一等 provider（需要账号、key 与
   条款审查），以及/或者加一个 GitHub Release 备用源。
6. **可选产物**：是否发布 `onnx-int8/` 变体与 `checkpoint.pt`，还是只发权重
   （建议：int8 可选，checkpoint 不发布）。
