# 构建与开发指南

> **读者**：搭建本地 WoWSP 开发环境的贡献者。

## 前置依赖

| 工具 | 最低版本 | 说明 |
| --- | --- | --- |
| Rust | 1.85+ | 需要 Edition 2024；通过 <https://rustup.rs> 安装 |
| Node.js | 22+ | 根目录 `package.json` 的 `engines` 要求；CI 使用 22 |
| pnpm | 11+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| just | 最新 | 命令运行器；`cargo install just` |
| Python | 3.11+ | 工具脚本 + mock 后端 + 模型转换 |
| Tauri CLI | 2+ | `cargo install tauri-cli`（`cargo tauri dev` 需要） |

## 克隆与引导

```bash
git clone https://github.com/langyo/wowsp.git
cd wowsp
cp .env.example .env
just init          # cargo fetch + pnpm install + 生成 shaders + 生成 icons + fetch-models
```

> `just init` 并不轻量：最后的 `just fetch-models` 步骤会拉取烘焙好的 GLB
> 模型包（约 1.3 GB，有缓存——本地树哈希与已发布的 `res-latest` release
> 一致时跳过下载）。

## 开发

```bash
just dev           # 原生：Vite + Tauri（完整桌面壳）
just dev webui     # 仅浏览器 Vite（无 Tauri 命令——调用会优雅失败）
just dev mock      # FastAPI mock 后端 + Vite（脱离游戏开发前端）
```

mock 后端（`scripts/mock/`）在 `/api` 下以 HTTP 提供与 Rust 侧相同的命令接口，因此桌面与浏览器的前端代码路径完全一致。

## 质量检查

```bash
just fmt           # 格式化 Rust + TS import 分组
just lint          # fmt-check + clippy + pnpm lint + i18n 一致性
just check         # cargo check --workspace
just test          # cargo test --workspace（或 `just test e2e` 跑 Playwright）
just i18n-check    # 校验各语言的 i18n key 一致性（链接 URL 仅 en-US 一份，全语言共享）
```

## 发布构建

```bash
just build            # 构建 webui（Vite）+ Rust 壳（cargo，默认 release）
just build package    # cargo tauri build——打包应用本体，不含安装器变体
just build installers # shun 三模式安装器（full 变体内置模型包，lite 按需下载）
```

前端产物输出到 `dist/webui/`，由 Tauri 通过 `tauri.conf.json` 的 `frontendDist` 消费。

## 常见问题

- **`icons/icon.ico` not found** —— 跑 `just gen icons`（从 `docs/logo.webp` 经 `cargo tauri icon` 重新生成）。
- **`frontendDist` 路径不存在** —— 先 `just build webui`，或开发时用 `just dev`。
- **找不到录像** —— 在 `.env` 里把 `WOWSP_GAME_PATH` 设为你的战舰世界安装路径，或显式传 `dir=`。
