# 自建 WoWSP 网关

> 本指南带领军团指挥官——或任何玩家——在自己的 Cloudflare 账号与域名上运行
> **私有** WoWSP 网关 Worker，并让桌面端与成员们的手机指向它。整套服务端就是
> 本仓库标准的 `packages/pairing-relay` wasm（协议详见
> [gateway-push.md](../designs/gateway-push.md)）。

## 为什么要自建

- **私密**：成员的对局推送走**你的** Worker，不经过公共节点。
- **免验证码**：私有部署可以关闭 Turnstile，改用一个简单的密码保护。
- **自主**：指向你拥有的任意域名（军团域名就很合适）——非常适合作为
  指挥官下放给军团成员的福利。

## 前置条件

1. 一个 Cloudflare 账号（免费 Workers 套餐即可——免费档的 Durable
   Objects 使用 SQLite 存储，网关正好用到它）。
2. 托管在该 Cloudflare 账号上的域名或子域名（部署时会自动为它绑定
   Workers Custom Domain）。
3. 运行桌面端的机器上有 Node.js（含 `npx`）与带
   `wasm32-unknown-unknown` 目标的 Rust 工具链——或者直接使用应用内置的
   向导，它会帮你逐项检测。

## 一键方式（桌面端）

设置 ▸ 连接 ▸ 配对 ▸ **自建网关向导** 逐步完成：

1. **环境检测**——检查 `node`、`npx`、`rustc`、wasm32 目标与
   `worker-build`；缺失项会给出安装提示。
2. **登录 Wrangler**——运行 `npx wrangler login`（会打开浏览器；令牌
   只保存在 wrangler 自己的本地状态里，绝不进入 WoWSP）。
3. **目标域名**——网关要绑定的子域名，例如 `wowsp.your-legion.example`。
4. **KV 桶**——创建/选择网关保存每个频道最近一场对局所用的
   `GATEWAY_KV` 命名空间。
5. **部署**——按仓库内模板生成填好的 wrangler 配置并执行
   `npx wrangler deploy`，输出逐行流式显示在向导里。
6. **验证**——请求 `https://<你的域名>/gateway/health`，成功后展示
   URL（附复制按钮），在每位成员手机的 设置 ▸ 连接 ▸ 路由入口 里填入。

## 手动方式（命令行）

```bash
git clone https://github.com/langyo/wowsp && cd wowsp/packages/pairing-relay
rustup target add wasm32-unknown-unknown
cargo install worker-build
npx wrangler login
npx wrangler kv namespace create GATEWAY_KV     # 记下打印的 id
cp wrangler.selfhost.toml.example wrangler.selfhost.local.toml
# 编辑 wrangler.selfhost.local.toml：填入域名与 KV id
npx wrangler deploy --config wrangler.selfhost.local.toml
curl https://<你的域名>/gateway/health
```

## 安全选项

| 选项 | 配置方式 | 默认 |
| --- | --- | --- |
| Turnstile 验证码 | `GATEWAY_TURNSTILE_SITEKEY` 变量 + `TURNSTILE_SECRET` 密钥 | 自建**关闭** |
| 密码 | `npx wrangler secret put GATEWAY_PASSWORD`（部署后的 Worker 密钥） | 关闭 |
| 都不启用 | — | 任何知道频道 id 的人都可以订阅 |

- 一分钟内输错 5 次密码，来源 IP 将被锁定 5 分钟（HTTP 429 带
  `retryAfter`）。
- 如果开启 Turnstile：为你的域名创建小部件（widget），并在其域名白名单里
  加入应用来源：`tauri.localhost`（Windows 桌面端）、`asset.localhost`
  （安卓端）与 `localhost`（开发）。小部件密钥通过
  `npx wrangler secret put TURNSTILE_SECRET` 配置。

## 让 WoWSP 指向你的网关

- **桌面端**：设置 ▸ 连接 ▸ 配对 ▸ 路由入口——把官方的
  `https://wowsp.langyo.xyz/gateway/` 换成
  `https://<你的域名>/gateway/`，再打开"手机服务"开关。
- **手机端**：手机设置里的同名字段；实时对局页随后等待推送到
  已登录账户的路由。

两端连接失败都会以右上角 toast 提示。
