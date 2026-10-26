# Mod Hub —— 插件管理设计

> **状态**：设计中（M10，1.0 之后的下一个里程碑）。
> 本文给出插件管理能力的差距分析、目标架构与落地拆解。

## 背景与目标

战舰世界的插件生态长期由整合包（Aslain、ModStation）主导。它们的共同问题：

- **整合包粒度太粗**：动辄数百个条目一次勾选，装完不知道自己装了什么；
- **版本更新即翻车**：游戏一升级，`res_mods/` 目录结构变化，插件需要手工搬运、逐个人工确认；
- **内容分发靠网盘**：皮肤、语音包这类"大头"内容散落在贴吧、网盘与 Discord，无哈希、无版本声明、无兼容性元数据。

WoWSP 已经踩进了这个领域——M6 的 Mod 安装器会往 `res_mods/` 写一个加载器文件来拉起悬浮面板。Mod Hub 的目标是把这件事做全：

1. **兼容 Aslain 的布局约定**：写入 `res_mods/<游戏版本>/`，与 Aslain/ModStation 共存不打架；
2. **以 GitHub Discussions 为发布与分发渠道**：作者发资源帖（模板化），索引器聚合为目录，官网与应用内共用；
3. **官方小补丁随安装器附带**：IME 输入修复、字体修正等第一类补丁由 WoWSP 直接托管分发；
4. **内容包是大头**：皮肤涂装与语音包的浏览、预览、批量安装是一等公民；
5. **版本更新自动迁移**：游戏升级后自动迁移可用插件、标记待确认项、支持一键回滚。

## 现状盘点（已具备）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 游戏安装检测 | `game_detect.rs` | 注册表 + Steam + Lesta + 360，得到 `<game_path>` |
| 游戏版本读取 | `game_detect.rs` | 从 `bin/<ver>/` 或 `version.xml` 得到当前版本号 |
| Mod 写入 | `mod_install.rs`（M6） | 向 `res_mods/<ver>/` 写入悬浮面板加载器 |
| 自动更新 | tauri-updater | WoWSP 自身的更新通道 |

## 差距分析（还缺什么）

| # | 缺口 | 影响 | 优先级 |
| --- | --- | --- | --- |
| G1 | **没有插件清单（manifest）格式** | 无法表达"这个包支持哪些游戏版本、包含哪些文件、装到哪"，一切自动化的前提 | P0 |
| G2 | **没有包来源协议** | 压缩包结构、Discussions 资源帖模板、附件与哈希的约定都未定义 | P0 |
| G3 | **安装器只管自家加载器** | 不支持通用插件包的解包、文件映射、冲突检测与还原点 | P0 |
| G4 | **无版本迁移与兼容性确认** | 游戏更新后插件目录漂移，用户手工收拾残局 | P1 |
| G5 | **无 Discussions 索引器** | 无法把资源帖聚合成可浏览的目录 | P1 |
| G6 | **无内容浏览器** | 皮肤/语音需要分类、预览（图/试听）、批量操作、断点续传 | P1 |
| G7 | **无 Aslain 迁移助手** | 存量用户从 Aslain 搬配置需要手工对照 | P2 |
| G8 | **无插件沙箱与权限模型** | 含脚本（PnFMods）的包需要明确的用户授权与来源校验 | P2 |

## 设计

### 1. 插件清单 manifest（`wowsp.mod.toml`）

每个插件包（zip 根目录或 Discussions 资源帖的首个代码块）携带一个 TOML 清单：

```toml
[mod]
id = "sea-haze-skins"            # 全局唯一 slug
name = "海雾涂装包"
version = "1.4.0"                # 包自身版本（semver）
category = "skins"               # aux | skins | voice | patches
license = "CC0-1.0"
authors = ["@someone"]

[compat]
game = ">=14.3 <14.6"            # 显式声明的游戏版本区间
# 或者：game = "*" + 人工确认标记，见“版本迁移”

[[files]]                        # 包内路径 → res_mods 相对路径
from = "gui/flash"
to = "gui/flash"
[[files]]
from = "content/gameplay/us/gun/main/textures"
to = "content/gameplay/us/gun/main/textures"

[hashes]                         # 关键文件 SHA-256（装后校验）
"content/.../camouflages.dds" = "…"

[preview]                        # 内容包专属：预览图/试听
images = ["preview/yamato.webp"]
audio = ["preview/sortie.ogg"]
```

要点：

- **`game` 区间是兼容性的唯一权威来源**。`*` 表示"未声明"，安装与迁移时一律标为"待确认"；
- `files` 的 `to` 永远相对 `res_mods/<游戏版本>/`——与 Aslain 写出的目录形态一致，因此双方安装的插件可以共存、互见（WoWSP 能识别并接管 Aslain 已装条目的搬迁）；
- 清单即真相：迁移、卸载、回滚都只依赖清单 + 安装记录，不需要包本身在场。

### 2. 三种安装来源

| 来源 | 形态 | 处理 |
| --- | --- | --- |
| **压缩包** | 拖入 `.zip/.7z`（含 `wowsp.mod.toml`） | 本地解包 → 校验清单 → 安装 |
| **GitHub Discussions 资源帖** | 模板化帖子（front-matter + 附件链接） | 索引器抓帖 → 生成索引 → 应用内一键安装 |
| **官方附带补丁** | 随 WoWSP 安装器内置（IME 修复、字体修正） | 离线可装，永远签名可信 |

Discussions 资源帖模板（节选）：

    ---
    wowsp-mod: sea-haze-skins
    version: 1.4.0
    game: ">=14.3 <14.6"
    category: skins
    author: Someone
    author_url: https://github.com/someone
    aliases: SMO_HazeSkins, SeaHazeSkinsPy
    license: CC0-1.0
    ---
    正文（Markdown，含预览图）……
    附件：sea-haze-skins-1.4.0.zip（SHA-256: …）

`aliases`（可选，逗号分隔）登记该条目在外部安装器名下的一切名字——
Aslain 整合包的清单行 ID 与落盘目录名。索引器将其采集进
`mod-index.json`，应用侧配对按精确身份处理：`TeamHP` 这类与展示名
（"Team HP by TTaro"）毫不相干的原始目录名，也能解析到正确条目。

`author`（可选）是插件作者的显示名，`author_url`（可选）是作者官方
页面。作者署名只活在这两行里——各语言的展示名一律不携带署名（是
"Team Panels"，不是 "Team Panels by AutoSpy"）：索引器把这对字段
复制进 `mod-index.json`，目录页将其渲染为作者标签，链接经核实后可
点击跳转。两行的数据源是 `scripts/mod_hub_authors.json` 登记表。

用 Discussions 而不是 Releases 的原因：评论区就是用户反馈与兼容性回报（"14.6 实测可用"会被索引器吸收为兼容性信号），Watch/通知即订阅，零后端成本。

#### 安装时方案（`wowsp:presets`）

内置多种预置配置（例如标记的配色、面板的位置）的插件，以命名「方案」声明它们，而不是拆成 `-v1`/`-v2` 条目——插件滚动更新，版本号不承载变体。线程携带一个隐藏标签块与带方案标注的下载行：

    <!--
    wowsp:presets
    sasagcy: Sasagcy 配色 | Sasagcy palette
    classic: 经典配色 | Classic palette
    wowsp:presets
    -->

    - [`smi-sasagcy.zip`](url) — 1 KB · SHA-256 `…` · preset `sasagcy`
    - [`smi-classic.zip`](url) — 1 KB · SHA-256 `…` · preset `classic`

规则：每方案一行标签 `id: <中文> | <英文>`（id 限 `[a-z0-9-]`，声明顺序即目录顺序）；方案下载行是普通下载行加尾部 `· preset `id``；全部下载行都带方案标注的线程，其顶层包列表回填为第一个（默认）方案，保证旧版本应用仍能安装合理内容。应用在详情面板渲染分段方案选择器，安装时下载所选方案的包；没有包的标签会被索引器丢弃。

#### 款式族折叠与 `supersedes`

同一 HUD 元素的历史"一式一条目"（六款侧边面板、三款迷你面板、五款红绿灯动向指示）在目录里读作重复行。两个索引构建器（`scripts/mod_hub_publish.py` 的 `build_index` 与 `scripts/mod_index.py` 的 `index_discussions`）在最新版本解析之后统一执行 `scripts/mod_hub_families.py` 的 `fold_families`：族内成员折叠成一个带方案的条目，Discussions 线程保持一式一线程不变，只有发布的 `mod-index.json` 合并。折叠条目额外携带：

- **方案级媒体**：每个方案可带 `preview`（该款式的截图）与 `desc_zh` / `desc_en`（该款式的注意事项——互斥警告、毁回放等）。详情面板的预览图与款式说明随分段按钮组的选择动态切换，无方案级媒体时回落到条目级。
- **`supersedes`（条目级）**：旧"一式一条目"id → 方案 id 的映射。台账配对把它当作"本条目以该方案安装"处理（已装记录、角灯、方案落位、漂移检测、卸载与深链全部沿用）；安装任一方案时安装器先回卷族内所有旧 id 的记录——款式族互斥，装新款即替换旧款。

折叠配置（族的成员、方案 id 与双语标签）维护在 `mod_hub_families.py` 的 `FAMILIES` 表；族简介与各款式描述复用 `scripts/mod_hub_desc_i18n.json`。`drop_missing_assets` 资产门同样清扫方案级包列表，发布自检（两个脚本的 `selftest`）覆盖折叠与门扫。

### 3. 安装器

写入路径严格遵循 Aslain 约定：

```
<game>/res_mods/<game_version>/<files.to…>
```

流程：`解包 → 清单校验 → 哈希校验 → 冲突检测（同路径已装条目）→ 生成还原点 → 原子写入 → 登记安装记录`。

- **还原点**：安装前把将被覆盖的路径快照到 `%AppData%/wowsp/mods/restore/<ts>-<名称>/`；快照是强制的——失败则中止安装，绝不覆盖一个无法还原的原件（嵌套快照目录会被创建；旧的尽力而为复制会静默跳过它们）；
- **原子写入与回滚**：每个文件经 `<目标>.wowsp-part` → 改名落盘，全部动作进 journal；任一步失败即整体回卷（还原快照、删除新文件、修剪空目录），半拷贝的模组树永远不会抵达游戏客户端；
- **安装记录**：`%AppData%/wowsp/mods/installed.json` 记录每个插件的清单、来源、安装时间、写入文件清单——卸载与迁移都靠它。本地文件夹安装同样入账（source `local`），卸载时可还原其覆盖的原件；重装同一插件（目录安装按 id、本地安装按计划名）先回卷旧记录——快照永远指向原版文件，新版本删掉的文件也不会残留；
- **游戏守卫**：所有变更命令（目录/本地安装、卸载、单元启停、overlay 桩）在游戏客户端进程存活期间一律拒绝执行，与 Aslain 安装器的告警同理——运行中写入会撕裂半加载的模组；
- **冲突策略**：同一路径后装覆盖前装，但在 UI 明确提示"将覆盖 X 插件的 N 个文件"。

#### 3.1 已安装插件的管理

已安装列表以 **Aslain 的 `bin/<build>/res_mods/installed_mods.xml`**（`<mod name version installer/>` 平铺行）为锚：文件系统分组（`banks/<bank>`、`PnFMods/<dir>`、`gui/unbound2/<mod>`、`gui/<child>`、顶层 `*.xml` 补丁、其余顶层目录）按"归一化名称相似度"（精确 > 包含 > 公共前缀）挂到清单行上，App 展示的是安装器真正装过的插件，而不是裸目录。找不到对应文件的清单行仍以"仅清单记录"形式列出；没有被任何清单行认领的分组保留启发式身份。

贴图覆盖类单元（`content/`、`particles/`、`spaces/` 等兜底分组，含被清单行认领后的合并单元）附带一份**结构化内容分析**（`textureAnalysis` 字段，有界遍历 ≤2 万文件）：按路径签名归类（`content/gameplay/<国家>/<舰种>/…` 舰船与部件贴图、`content/unlocks/…` 涂装图标、`spaces/<地图>/…` 场景、粒子/文本/系统资源），并从贴图文件名解析出覆盖的模型单元（`JSB039_Yamato_1945_Hull_a.dds` → `JSB039 Yamato 1945`；首位段为 2–6 个大写字母 + 2–4 位数字的单元码，可读名截到 Hull/Gun 等部件词为止）。国家/舰种/类别均为语言无关代码，由前端按 locale 本地化展示；本地文件夹安装的预检计划复用同一分析器，`particles`/`spaces` 等贴图根目录在包布局识别中同样被认作覆盖签名。

每个插件单元支持两种操作：

- **临时停用** —— 单元内每个文件改名为 `*.bak`；重新启用则去掉后缀。扫描器能识别 `.bak` 文件（`mod.xml.bak`、`Main.py.bak`、`x.xml.bak`），停用的单元仍然可见、可再启用。目录名永不改动——游戏不再加载这些文件，PnF 加载器也找不到可导入的 `Main.py`。停用一个共享兜底分组（整个 `content/`、散落 gui 文件）而该分组同时承载着台账在册、文件却分布在他处的模组时会被拒绝：PnF 载荷的贴图或 unbound 片段一旦消失就是加载期崩溃，切换会改指到那个模组自己的条目。
- **卸载** —— 删除整个单元（含 `.bak` 孪生），向上修剪清空的父目录（不超过 `res_mods`），并同步删除该单元在 `installed_mods.xml` 里的清单行（原子重写）。被单元**完整**覆盖的台账记录走完整卸载——还原快照并删除记录；同时拥有单元之外文件（共享该目录树的另一个模组）的记录则被裁剪：只移除其被覆盖的文件及对应快照，卸载一个插件绝不顺手卸掉邻居。台账卸载同样清理记录文件的 `.bak` 孪生，停用中的模组不会变成幽灵残留。

**安全模式**把当前整个 `res_mods` 以一次原子改名隔离（`res_mods` → `res_mods.wowsp-disabled`）——WG "安全模式"的支持套路：不删除任何文件让游戏绕过 res_mods 里的全部模组运行，是"到底是模组还是游戏本身"最快的二分法（个别文字模组会把 DLL 放在游戏根目录，那类文件不属于 res_mods、不受隔离影响）。一键即可完整还原到隔离前状态——包括游戏更新发生在安全模式期间、滞留在旧版本目录里的隔离树。安全模式期间所有变更命令（安装/卸载/启停/迁移/overlay）一律拒绝执行——写入会落进新建的 `res_mods` 并与隔离树漂移。

**单元警告**：扫描会标记两个已安装皮肤覆盖同一 `registerShipMod` 舰船 ID 的情况——只有一方能生效，两个单元都会在详情面板携带警告。

**台账对账**随已安装扫描运行：文件已全部不在盘上的记录（手工清理、bin 目录丢失——`.bak` 孪生与安全模式隔离树仍算存活）会被剔除，"已安装"角标保持真实。记录携带所属游戏安装（`gameRoot`），对账绝不波及其他安装的记录。不再被任何记录引用的快照目录在 24 小时宽限期后才会被垃圾回收，刚失败安装的快照得以留存待重试。

所有变更操作（目录安装/卸载、单元启停/卸载、overlay 桩的安装/卸载）经同一把异步闸串行化：并发的目录安装可以同时下载，但台账写入与文件改名不会交错。

#### 3.2 共享清单（`res_mods/wowsp.toml`）

在所管理的模组旁边，WoWSP 会维护 `bin/<version>/res_mods/wowsp.toml`
（schema 1）——它是应用侧账本（`%AppData%` 的 installed.json）的共享对半：工具插件从
中读取自己的配置，检视游戏目录的人也能看到 WoWSP 装了什么、用的哪个方案。每次安装、
卸载、单元启停都会重写该文件；`[tools.*]` 表归各工具所有，重写时原样保留（手改安全）。

    version = 1

    [managed."battle.marker.traffic-v4"]
    name = "Ship Movement Indicator"
    version = "15.7.0.10"
    category = "battle"          # 目录分类；本地安装为 "local"
    source = "mod-hub"           # mod-hub | local | bundled
    preset = "sasagcy"           # 安装所选方案（见 wowsp:presets）
    enabled = true               # 与 `.bak` 启停保持同步
    installed_at = "2026-10-05T00:00:00+00:00"

    [tools."battle.ingame.stats"]
    panel_fade_ticks = 3         # 工具自定义键——WoWSP 只补默认值，
    journal_limit = 300          # 已有键永不覆盖

契约：`version` 是 schema 闸门（读到更新版本的构建不会改写该文件）；无法解析的文件被
隔离为 `wowsp.toml.invalid` 并从零重建；清空的清单会自我删除。旧 bin 迁移从不搬运该
文件——其中幸存的内容（启停状态、工具配置）合并进当前 bin 的清单。首个消费方是内置
的游戏内战绩插件：从自己的 `[tools]` 表读取 `panel_fade_ticks` 与 `journal_limit`，
缺省回退为上述默认值。

进程内该文件只有**一份读写上下文**：所有变更以 `ManifestOp` 经 mpsc 管道递给专职写
线程并等待回执，读取解析原子快照（tmp+rename）——多读一写，不存在可能漂移的平行副本。
三个节：

- `[managed.*]`——WoWSP 安装并拥有的单元（每次安装/卸载/启停/对账/迁移时重写）；
- `[tools.*]`——工具插件配置（归工具所有；WoWSP 只补缺失的默认值，永不覆盖已有键）；
- `[foreign.<installer>.<key>]`——**外来安装器**所装单元的识别：`aslain` 行来自整合包
  自己的 `installed_mods.xml` 台账，`modstation` 单元来自 WG 官方 ModStation 的
  `bin/<version>/mods/` 目录树（每次游戏更新被清空，因此靠重扫而非记忆）。每行携带尽力
  配对的 `identity`（名称对应的目录 id），各界面都可从这一份文件读取配对结论而非各自
  重新推导。已安装列表每次扫描都会刷新这些行。配对是分层的（名字精确 > 包含 > 字符
  二元组相似度，两侧都先剥掉停用词），因此整合包的驼峰命名也能对上目录的散文式命名。
  WoWSP 默认只描述外来单元，按用户明确操作才接手管理：外来单元面板提供禁用/卸载
  （Aslain 行走与本地单元相同的启停/卸载通道，并同步删除整合包清单行；ModStation
  目录树走专用的整目录卸载）；在配对的目录条目上重装即「注册」——切掉该条目的
  清单行、快照原文件，单元从此归 WoWSP 台账管理。

### 4. 版本迁移与兼容性确认

**已落地（检测 + 一键迁移）**：扫描会报告所有仍含文件的旧 `bin/<版本>/res_mods`（`mod_hub_stale_versions`），资源页顶部给出告警横幅；`mod_hub_migrate_stale_bin` 把滞留文件移入当前版本的 `res_mods`（同卷逐文件改名；冲突**保留新装**——当前树已有活动文件或禁用孪生时滞留副本即被丢弃，滞留孪生在其活动副本存在时同样丢弃，绝不覆盖任何现有文件；当前树缺少活动文件时禁用孪生随迁；滞留的 Aslain `installed_mods.xml` 随旧目录消亡、不移植幽灵清单行；迁移完清空旧目录，并把台账记录的 `bin_version` 重定向到当前版本；受 mod-hub 闸与游戏运行守卫保护）。

**规划中（按兼容性分级的迁移向导）**：游戏更新（检测到 `bin/` 出现新版本目录）后自动进入迁移向导：

1. **扫描**：读取旧版 `res_mods/<旧版本>/` 与安装记录；
2. **分级**：
   - 新版本的 `game` 区间命中 → **自动迁移**（复制到新版本目录）；
   - 区间未命中但有 Discussions 回报告知可用 → **标记"社区确认"**，一键采用；
   - 区间未命中且无信号 → **待确认**，用户逐项决定（尝试启用 / 暂时搁置 / 等待更新）；
   - 已知冲突（作者声明弃用、索引标记 broken）→ **建议移除**；
3. **回滚**：迁移产生新还原点，一键回到迁移前状态。

### 5. 内容浏览器（大头）

皮肤涂装与语音包占内容量的 90%+，因此浏览器为它们优化：

- **分类轴**：舰船 / 系列 / 角色 / 语种；皮肤有预览图轮播，语音包可试听；
- **批量操作**：多选安装、依赖自动补齐（语音包依赖的soundbanks 基础包自动带上）；
- **下载**：分块断点续传（语音包常见 100MB+），并发限速，装完自动校验；
- **CC0 优先**：索引只收录声明 CC0（或兼容自由许可）的资源，安装页显著标注许可。

### 6. Discussions 索引器

一个 GitHub Actions 定时工作流（也可手动触发）：

1. GraphQL 拉取带 `wowsp-mod` front-matter 的资源帖；
2. 解析 front-matter + 附件链接 + 评论区的版本回报信号；
3. 产出 `mod-index.json`（按分类聚合，含最新版本、哈希、兼容性信号），由 `scripts/mod_hub_sync.py` 发布为 `mod-hub` release 的同名资产；
4. 官网 `/mods` 目录页与应用内浏览器共用这份 JSON——**无自建后端**。

### 7. 上游自动同步

Mod Hub 现有的 142 个工具类条目来自 Aslain's WoWs Modpack 的一次离线批量搬运
（`scripts/mod_hub_publish.py`，维护者手动按需执行）。上游从不静止：以
`ContentVersion`（如 `v.15.9.0 #05`）持续滚动更新，公开目录只保留当前版本（旧版本
Configuration 404）——搬运来的快照每次上游更新都会过时。上游 zip 文件名内嵌内容
md5 的前 8 位十六进制，等于自带内容指纹（204 个绝对 URL 的 `.7z` 条目例外，无指纹）。

`.github/workflows/mod-hub-sync.yml`（每 6 小时 `schedule` + `workflow_dispatch`
手动触发，`concurrency` 串行）调用 `scripts/mod_hub_sync.py`（流水线子命令
`detect` / `apply` / `index-only` 与离线 `selftest`；`render-summary` /
`upsert-issue` 负责把已保存的报告重新渲染/落帖）：

| 子命令 | 行为 |
| --- | --- |
| `detect` | 只读 diff 上游 + 报告 |
| `apply` | 真实同步；`--dry-run` / `--include-new` / `--no-gc` |
| `index-only` | 仅重建并重发 index |
| `selftest` | 离线自检 |

#### 无状态对账

不持久化任何上游快照。包改用内容寻址命名——`pkg-<md5 8>.zip` / `pkg7-<sha256 12>.zip`
（跨条目相同内容自动去重）——因此**已发布的 Discussion 帖正文本身就是同步状态**
（下载行里的资产名 + sha256）：每次运行拿上游 Configuration 与活帖做 diff，只处理
差量。首次迁移会把旧 `<slug>-partN.zip` 命名一次性全面翻新。

#### 版本语义

只有包内容真正变化的条目才升 `version`（webui 的 `pluginUpdates` store 以字符串相等
判断更新提示，内容未变绝不能升号）。游戏兼容区间（`game` front-matter）每次都刷新——
由上游 `root.xml` 的 `Cache.Version` 派生出形如 `>=15.9 <15.10` 的区间——不升
`version`，也就不触发全量更新提示。游戏小版本升级自动跟进（维护者已拍板），不做人工闸。

#### 两阶段下架

上游条目消失 / 被禁用 / 移出同步范围时：

1. **标记 stale**：帖子正文加入隐藏的 `wowsp:sync-stale` 注释块（`reason` / `since` /
   `content_version`）与可见的双语警示（"同步来源已关闭，待人工复核后下架"）；条目仍可安装；
2. **下架（人工）**：关闭该 Discussion 即彻底下架——爬虫据 `closed` 判定 delisted。
   24 小时宽限后，未被任何帖子引用的 release 资产被 GC（单次上限 150 个；引用集过小则
   跳过本次）。同步报告 issue 会列出全部待复核条目。

上游恢复后，下次同步自动摘除 stale 标记。

#### 新条目提案制

未登记 `SLUG_MAP` 的新 Aslain 条目绝不自动发布：只出现在报告的 `pending`
清单里。维护者补 `scripts/mod_hub_slugs.py`（可选补 `mod_hub_authors.json` /
`mod_hub_desc_i18n.json` / `mod_hub_families.py`）后，用 `workflow_dispatch`
（`mode=apply`，`include_new=true`）发布。

#### 信任链与 relay 加固

`mod-index.json` 仍是 `mod-hub` release 的资产。本设施同步启用 relay 的 mod-hub 签名
digest 通道：index 字节一有变化，工作流就用 `WOWSP_DIGEST_SIGNING_KEY` 签发
`packages/pairing-relay/digests/mod-hub/` 文档：

    scripts/publish_digests.py --channel mod-hub --tag mod-hub \
        --assets mod-index.json=<sha256> --latest --require-signed

同一 PR 在 `wrangler.toml` 补上 `!/api/digests/mod-hub` 两条 negation 与
`DIGEST_PUBLISHED_CHANNELS` 扩展。首份 digest 文档必须与 negation 同批部署——否则该
路径会落到 SPA 200 而不是 gated 404。PR 自动 squash merge 并触发 site 部署，随后验证
`https://wowsp.langyo.xyz/api/digests/mod-hub`。细节对齐 `release.yml` 的 app digest
job 模式。

#### 安全闸

- 每个下载包做 zip magic / 解压 / repack 校验；
- 资产上传按 digest 幂等（相同 sha → 跳过）；
- index 资产存在性闸：缺失超过 25% 拒绝上传 index（delisted / stale 条目豁免）；
- 发布后回读校验已发布的 index；
- 失败时回滚到上一份 index，并开告警 issue；
- 讨论区批量更新限速 ≥1 秒/次。
- 共享运行时包（Aslain 的 `<Implicit>` 块——TTaroModUtils、ModForge 蓝图引擎）
  会并进每个 `RequiresAny` 依赖条目的包列表，安装即自包含；多个插件共享同一份，
  帖子里有说明（卸载某个插件后同类插件失效，重装任意一个即可恢复）。包级
  `Requires`/`RequiresAny` 是 Aslain 的条件变体选择器（按你勾选的其他插件
  安装对应分包）；WoWSP 与过去一样发布条目的全部分包，因此刻意不建模。
  `UnpackTo`/`Preserve` 同样无需建模：安装器已会把 zip 根目录的原生库
  （`gettext_x64r.dll` 这一类）作为 `@game/...` 落点搬进游戏根目录。

#### 按条目同步策略

`scripts/mod_hub_sync_policies.json` 把目录 slug 映射到每次同步都会遵守的
策略：`"auto"`（默认——完整同步）、`"manual"`（条目保持选中，但上游变更被
扣下不发布、仅在报告中列出，直到策略改回 auto）、`"skip"`（从目录移除；被
跳过条目的帖子永远不会被标记失效）。缺省即 auto——不改登记表就什么都不变。

#### 报告

每次运行产出 `sync-report.json`（随运行落盘）并渲染进步骤摘要与固定标题 issue
「[mod-hub-sync] Upstream sync report」（正文每次覆盖，内嵌隐藏 JSON 块，agent 与人
读同一份来源）。`apply` 失败时另开告警 issue。

#### 运行手册

- 手动触发：Actions 页 `workflow_dispatch`，或
  `gh workflow run mod-hub-sync.yml -f mode=apply`；
- 新条目策展：补 slug 登记表（见上），然后以 `include_new=true` 跑 apply；
- stale 复核：关闭 Discussion 即下架；上游恢复则下次同步自动摘除标记。

#### 合规姿态

维持"重托管 + 署名 + 来源链接 + 通知下架"的现状（`license: Unspecified (upstream)`）。
自动化不改变该姿态，但会放大规模；后续按作者 / 许可登记表逐条调整同步策略（登记表
本身设计为后续项）。

## 里程碑拆解（M10）

| 子项 | 内容 | 依赖 |
| --- | --- | --- |
| M10.1 清单与仓库约定 | manifest schema、包结构、Discussions 帖子模板、索引 JSON schema | — |
| M10.2 安装器 | 通用包解包/写入/冲突/还原点/安装记录 | M10.1 |
| M10.3 索引器 | Actions 工作流产出 `mod-index.json`，官网目录页 | M10.1 |
| M10.4 迁移引擎 | 版本漂移检测、分级迁移、回滚、兼容性确认 UI | M10.2 |
| M10.5 内容浏览器 | 分类浏览、预览试听、批量安装、断点续传 | M10.3 |
| M10.6 Aslain 迁移助手 | 识别 Aslain 已装条目并纳入安装记录——已通过分层配对 + 注册重装接管落地（安装时切掉整合包清单行） | M10.2 |

## 安全与合规

- 只索引声明自由许可（CC0 优先）的资源；版权内容（如官方联动语音）不收录；
- 所有包强制 SHA-256 校验；含可执行脚本（PnFMods）的包安装前需显式授权并在 UI 标红；
- 官方附带补丁（IME 修复等）随 WoWSP 安装器签名分发。

## 开放问题

- Lesta 服（俄服）客户端目录结构差异是否需要单独的布局适配；
- 语音包的 soundbanks 依赖是否建模为真正的依赖图（还是简单"同包装"约定）；
- 索引器对评论区"可用"信号的采信阈值（多少个独立回报算社区确认）。
