<h1 align="center">WoWSP</h1>

<p align="center"><strong>战舰世界战况分析仪表盘 — 录像复盘与游戏内覆盖层</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![GitHub](https://img.shields.io/badge/github-langyo%2Fwowsp-blue.svg)](https://github.com/langyo/wowsp)

</div>

<div align="center">

[English](../../en/guides/README-wowsp.md) ·
**简体中文** ·
[繁體中文](../../zh-TW/guides/README-wowsp.md) ·
[日本語](../../ja/guides/README-wowsp.md) ·
[한국어](../../ko/guides/README-wowsp.md) ·
[Français](../../fr/guides/README-wowsp.md) ·
[Español](../../es/guides/README-wowsp.md) ·
[Русский](../../ru/guides/README-wowsp.md) ·
[العربية](../../ar/guides/README-wowsp.md)

</div>

WoWSP 是面向《战舰世界》的新一代战况分析仪表盘。它有两种工作模式：

1. **独立复盘** —— 自动检测游戏安装、解析 `.wowsreplay` 文件，并在全息 3D 地图上渲染每艘船的轨迹。
2. **游戏内覆盖层** —— 一个透明覆盖窗口显示双方阵容，仅在按住 `Tab` 时可见，并在每次按下时通过截屏重新锚定位置。

## 文档

架构、设计与指南位于仓库根目录的 [`docs/`](../../)，由 [lagrange](https://github.com/celestia-island/lagrange) 构建。

源码：[wowsp](https://github.com/langyo/wowsp)。

## 许可证

WoWSP 主体代码采用 **合成源码许可证 1.0**（**SySL-1.0**，全文见 [LICENSE](https://github.com/langyo/wowsp/blob/master/LICENSE)）——一个为「源码主要由 AI 生成的软件」设计的自定义许可证。要点：版权与专利授权的范围与 Apache-2.0 相当，仅以目标码形式分发也不承担开源源码义务，且无论版权状态如何都作为有约束力的合同生效；作为对价，每一份副本与衍生作品都必须保留 AI 生成披露声明。应用工作区内的所有第一方 crate 均在自己的清单中固定 `license = "SySL-1.0"`（独立的 pairing-relay Worker 工作区则自行声明 `MIT`，见下文）。

仓树中采用 MIT 的角落恰好有两处。其一，[`packages/tools/wowsunpack-vendor/`](https://github.com/langyo/wowsp/tree/master/packages/tools/wowsunpack-vendor) 下的 vendored 工具链：它是 [landaire/wows-toolkit](https://github.com/landaire/wows-toolkit) 的 vendored 快照，保留上游的 **MIT** 许可（该目录内含上游 `LICENSE`，© Lander Brandt）。根 `Cargo.toml` 因此在 `[workspace.package]` 层声明 `license = "MIT"`，仅为让 vendored 的 `wowsunpack` / `wows-core` 成员在应用工作区内解析 `license.workspace = true`——本工作区的每个第一方成员都覆盖了该字段，没有任何代码意外继承 MIT。其二，[`packages/pairing-relay`](https://github.com/langyo/wowsp/tree/master/packages/pairing-relay)（配对中继的 Rust→wasm Cloudflare Worker）是独立于根工作区的 standalone Cargo workspace，其 `relay-core` / `relay-worker` crate 依自己的 `[workspace.package]` 声明采用 **MIT**。

vendor 同步策略：该目录是仓内的普通快照目录（非 submodule）；当 WoWSP 消费的 crate（`wowsunpack`、`wows-core`）需要上游修复或特性时，手动从上游刷新。快照之上的本地改动（例如 Lesta/Korabli 客户端适配）以普通提交的形式记录在本仓库历史中——`git log -- packages/tools/wowsunpack-vendor` 即权威记录，仓内不维护独立的补丁队列。
