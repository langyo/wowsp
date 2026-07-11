# 贡献指南

感谢你有兴趣为 WoWSP 贡献！

## 贡献政策

WoWSP 把正确性放在首位——一个坏的录像解析器或错位的覆盖层会直接影响玩家体验。开 PR 前请先阅读本节。

- **欢迎聚焦的改动**：bug 报告、聚焦的修复、范围清晰的检测/解析/渲染改进、新增地图或船只模型转换、文档。
- **架构级改动先讨论**（新模式、改动录像格式处理、改变覆盖层交互模型）。
- **接受贡献需签 CLA**。提交必须带 `Signed-off-by`（`git commit -s`）。

## 开发环境搭建

见 [构建指南](./building.md)。快速开始：

```bash
git clone https://github.com/celestia-island/wowsp.git
cd wowsp
cp .env.example .env
just init
just dev --mock      # 前端 + FastAPI mock，无需游戏
```

## 代码风格

```bash
just fmt     # Rust（cargo fmt + clippy）+ TS import 分组
just lint    # fmt-check + clippy + pnpm lint
just test    # cargo test --workspace
```

- Rust：函数 `snake_case`，类型 `CamelCase`，依赖用 `workspace = true`。
- TypeScript：Vue 3 TSX（`defineComponent`），严格模式，Pinia store。
- i18n：新增 UI 字符串需同时加到 `en` 和 `zhs`（`res/i18n/locales/`）。

## PR 流程

1. 从 `dev` 拉分支：`git checkout -b feat/my-feature dev`。
2. 原子化提交，遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat(replay): ...`、`fix(overlay): ...`、`docs: ...`。
3. 推送前跑 `just lint && just test`。
4. 向 `dev` 开 PR。

## 授权与 CLA

WoWSP 采用 **Business Source License 1.1（BUSL-1.1）**，**变更日期 2030-01-01**，届时自动转为 **Synthetic Source License（SySL-1.0）**。对所有内部、学术、政府、教育、非商业用途，今天起即等同于 SySL-1.0。详见 [`LICENSE`](../../../LICENSE)。
