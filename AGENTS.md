# AGENTS.md — WoWSP Repository Rules for AI Agents

> 本文件改编自 Celestia 工作区规则（yuzu-linux-daemon 节点上的
> `/mnt/codespace/AGENTS.md`），只保留适用于本仓库（langyo/wowsp）的规则，
> 并记录了针对性调整（见 §10）。所有在本仓库工作的 AI agent / subagent
> **必须**遵守本文件。工作区级文件中的真实凭据与内网信息**永远不会**被
> 复制进本仓库（红线见 §7）。

---

## 1. Commit Message Format

```
<gitmoji> <Capitalized English summary ending with period.>
```

- 必须以一个 gitmoji 开头。白名单 = gitmoji.dev 完整规范集 + 组织增补
  （🔗 sync/copilot、🔄 sync/refresh、📜 license、🛡️ shield）。常用：
  ✨ 🐛 🔧 ♻️ 🔥 📝 🎨 ✅ 🚀 🌐 ⬆️ 🎉 📦。
  **权威实现是 `scripts/commit_msg_lint.py`**（CI 用它校验，本地可跑
  `just lint-msg`）；白名单以该脚本为准。
- 摘要为英文、首字母大写、以 `.` 结尾；**禁止 CJK 字符**。
- **禁止 Conventional Commits 前缀**（`feat:` / `fix:` 等）——emoji 本身就是类型标记。
- **禁止任何冒号前缀句式**（`Topic phrase: details`），即使是
  `🔧 Fix compliance: nonce handshake` 这种首字母大写形式也不行；正确写法是
  `🔧 Fix nonce handshake and embed path.`（CI linter 规则 7 会拒绝冒号前缀）。
  详细背景写进 commit BODY（空行 + bullet），绝不写进摘要行。
- 禁止以裸版本号或填充短语开头（`v1.2.3` / `Bump version` / `Update to`）。
- **禁止 merge commit subject**（`Merge branch ...` / `Merge pull request ...`）：
  本仓只使用 squash merge。
- 豁免：`Revert "..."`（git revert 产物）豁免 gitmoji 要求；
  dependabot 等机器人的 commit subject 豁免（按作者过滤，见 workflow）。
- **PR 标题遵循完全相同的规则**（squash 后它就是 commit subject）：
  `<gitmoji> <一句话英文描述.>`，无冒号前缀；机器人 PR（dependabot）豁免。

## 2. CHANGELOG Policy（2026-08-18 工作区指令沿用，强制）

- **任何情况下不在仓库里维护 CHANGELOG / 修订历史文件。** 合并的 PR 就是
  changelog：squash commit（gitmoji + 一句话摘要）+ PR 描述构成完整变更史，
  任意粒度用 `git log` 过滤即可。
- Release notes 写在 **git tag + GitHub Releases** 页面（按 release 撰写），
  绝不落在被跟踪的文件里。
- 仓库里已不存在 CHANGELOG 文件，不要新建；PR 模板 / workflow 里若再出现
  changelog 引用，随触及它的 PR 一并移除。

## 3. PR Workflow

每个阶段的工作必须遵循以下模式：

1. **从 master 切出 feature 分支**（`feat/<name>` / `fix/<name>`）。
   有并行任务时用独立 `git worktree`，避免多个 agent 同时改主 checkout。
2. **3 轮验证循环**：对每个变更——
   - 第 1 轮：分析 → 改进 → 验证（用 subagent 做验证）
   - 第 2 轮：再分析 → 改进 → 验证
   - 第 3 轮：最终分析 → 打磨 → 验证
   - **任何一轮失败，从零重新计数。**
3. 以 gitmoji 格式 **commit**。
4. **push** 分支。
5. 用 `gh pr create` **创建 PR**（标题遵循 §1）。
6. **squash merge**（满足 §5 门槛可自主合并）：subject 变为
   `<gitmoji> Summary. (#PRID)`。
7. 合并后**删除** feature 分支。

### Subagent 使用

- 所有非平凡任务**必须使用 subagent**（general / explore 类型），避免上下文污染。
- 给 subagent 的任务描述必须完整：精确文件路径、先看既有代码模式、验证标准、
  commit 消息格式。
- 独立子任务并行发起；串行任务等待结果再继续。
- 每个 subagent 返回前必须验证自己的工作；重要工作由另一个 subagent 交叉验证。

### 验证门禁

提交前 `just lint`（或分目标 `just lint rust` / `just lint webui`）、
`cargo check` / `cargo test`、`pnpm build` 必须通过（按改动范围选择）。

## 4. Branch Naming & Git Push Rules

- `master` — 生产分支。**只接受 squash merge 的 PR**（2026-09-02 用户决策，
  见 §10），禁止直推；紧急修复走 `fix/<name>` 分支 + PR。
- `feat/<name>` — 新功能；`fix/<name>` — 缺陷修复；`chore/<name>` — 维护；
  `refactor/<name>` — 无行为变化的重构。
- `dev` — **已废弃，不要使用。**

### Git Push 硬规则

- **禁止裸 `git push --force`**（无显式人工授权）。无例外。
- feature 分支上 rebase/amend 恢复一律优先 `git push --force-with-lease`。
- `--force-with-lease` 被拒（远端跟踪 ref 过期）时**立即停止，绝不回退到
  `--force`**：先 fetch，用 `git log origin/<branch>..HEAD` 和
  `git log HEAD..origin/<branch>` 审查双方提交，确认无未知提交后再问用户。
- **master 上任何形式的 force push 绝对禁止**——master 只经 squash merge 前进。
- 拿不准时不要 force push：开新分支、重新提交、或问用户。
- 本条适用于所有 agent、subagent 和交互会话，无例外。

## 5. Merge & Release Rules

- **满足以下全部条件即可自主合并 PR**（无需逐 PR 人工确认）：
  1. **消息合规**：squash subject 为 `<gitmoji> <一句英文.>`，无冒号前缀；
     PR 标题同规则。
  2. **检查门槛**：必要检查通过后才可合并。**代码级失败**（编译 / 测试 /
     clippy / lint）必须修复，绝不带病合并；**环境性失败**（runner 配额、
     外部服务抖动等）在 PR 里记录并经本地验证（`cargo test` / `pnpm build` /
     lint）通过后可豁免。
  3. **PR 节约**：不要为每个琐碎变更单独开 PR 立即合并——PR 号是有限资源。
     一个 PR 应打包一批可合并的功能（一个连贯的功能/修复波次）；只有确实
     无可打包内容时（紧急 hotfix、孤立单条规则变更）才允许小 PR。
- **版本号随主 PR 走**：改版本就在功能/修复 PR 里一并 bump 五处
  （`Cargo.toml` workspace version、`packages/app/tauri/tauri.conf.json`、
  根 `package.json`、`packages/webui`、`packages/website`、`packages/holo`
  的 `version`），由 `scripts/check_versions.py` 在 CI 里强制一致；
  **不要**单独开纯 bump PR（除非用户明确要求）。
- **只在被要求或已批准的工作流步骤里创建 PR**；未经许可不得自发开 PR。

## 6. Build & Test

- Rust：`cargo build` / `cargo test` / `cargo fmt` / `cargo clippy`
  （仓库封装：`just check` / `just test unit` / `just lint rust`）。
- Web：`pnpm build` / `pnpm lint` / `pnpm -r typecheck`
  （仓库封装：`just lint webui`）。
- Rust 检查在 Windows 上跑（CI 的 rust job 也是 windows runner）：锁定的
  `windows-future 0.2.1` 在 Linux 上编不过（上游 bug，见 ci.yml 注释）；
  fmt/clippy 只针对 app crates（`wowsp_tauri` / `wowsp_tauri_shared`），
  vendored `wowsunpack` / `wows-core` 是依赖源，保持上游格式。
- **跨仓依赖**：一律用发布件 / vendored checkout，不用指向本机外部目录的
  path 依赖——hikari 通过 `packages/hikari-vendor`（见其 VENDOR.md）引入，
  malkuth 走 crates.io 发布版。

## 7. 敏感信息红线（强制，违反视为事故）

1. **禁止把任何真实密码 / 密钥 / token / 内网 IP 写进 git 树**（任何分支、
   任何文件，包括注释、示例、默认值、测试数据、README、docs）。
2. 代码里需要密码时：用环境变量 / 不入库的配置文件，或占位符
   （`<your-password>` / `CHANGE_ME`）；示例 IP 一律用 RFC 5737 文档地址
   （192.0.2.x / 198.51.100.x / 203.0.113.x），示例值用明显假值
   （`test-password` / `sk-xxx`）。
3. 确有必要写真实凭据的极少数情况：**先问用户**，并评估仓库可见性
   （公共仓 ≠ 可写敏感值；历史泄漏不可撤销）。
4. **提交前自查**：涉及配置 / 部署 / install 脚本 / 示例数据的改动，grep 一遍
   `password|secret|token|api_key` 确认无真实值；内网 IP（192.168.x / 10.x）
   用文档地址替代。
5. 工作区本地文件（如 `/mnt/codespace/AGENTS.md`）里的真实凭据**只准留在
   本地**，禁止复制进任何仓库文件（包括本文件）。
6. 泄漏处置：立即删除 → 评估泄漏面（tag / 分支 / 下游引用）→ 报告用户，
   由用户决定是否历史重写（涉及 master force push 需显式授权）→
   **无论是否重写，凭据视为已公开，必须轮换**。

## 8. CI 使用策略

1. **不要过度依赖 CI 状态**：本地验证（`just lint` / `cargo test` /
   `pnpm build` 相关部分）+ commit/PR 标题 lint 通过即可合并；环境性失败
   记录到 PR 即可豁免（§5.2）。
2. **CI 是参考不是门禁**：合并前看一眼有没有**代码级失败**（编译 / 测试 /
   clippy）；有则修，全是环境性就直接合并。**不要长时间盯 CI**——排队或
   挂起超过 ~15 分钟按环境性处理。
3. **取消过时任务**：同 PR 反复 push 触发的旧 run 可取消
   （`gh run cancel <id>`）释放配额；各 workflow 已带
   `concurrency` + `cancel-in-progress` 自动去重（wowsp 是公共仓、托管
   runner，PR 每次 push 保留全量触发 + 并发去重的策略）。
4. CI 结构（`.github/workflows/`）：
   - `ci.yml` — web（ubuntu：typecheck / lint / website build / i18n /
     pnpm audit）、rust（windows：fmt / clippy / check / test）、deny
     （cargo-deny 原生二进制：advisories / licenses / sources）、versions
     （五处版本一致性）。
   - `commit-msg-lint.yml` — PR 标题 + PR 内全部 commit subject
     （用 `scripts/commit_msg_lint.py`，机器人作者豁免）。
   - `release.yml` / `site.yml` — tag 构建发布 / 站点部署。

## 9. 大文件下载纪律（通用化，强制）

> 源自工作区 2026-08-13 流量事故教训；wowsp 侧主要涉及
> `scripts/fetch_models.py`（模型下载）等大资源拉取。

1. **>5GB 的下载先向用户报量确认**，未确认不得启动。
2. 失败重试必须带总字节预算上限，**禁止无上限重试循环**。
3. 下载脚本优先支持断点续传 / 内容寻址缓存，避免重复全量拉取。

## 10. 与工作区 AGENTS.md 的差异记录

以下工作区规则**不适用**于本仓库，或经用户确认调整：

- 节点表 / NFS / worktree 软链 / malkuth 部署 / sing-box 代理等基础设施
  章节（§0.6 具体、§1、§8、§9）——wowsp 是本地 Windows 开发 + GitHub
  Actions 托管 CI，不依赖那套环境；仅 §9 保留了通用化的大文件纪律。
- **master 策略**：工作区规则为「squash-only」，wowsp 历史上是直推 + PR
  混合；2026-09-02 用户决策改为**严格 PR-only**（§4）。
- **CI 触发策略**：工作区因自托管 runner 容量限制只开
  `opened/reopened/ready_for_review` 触发；wowsp 为公共仓托管 runner，
  用户决策**保留 PR 全量触发 + concurrency 去重**（§8.3）。
- **自主合并**（§5）：2026-09-02 用户确认沿用工作区的自主合并门槛。
- easy-hydro 仓的 CJK 豁免不适用于本仓（wowsp 一律英文摘要）。
