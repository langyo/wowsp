# 自建 WoWSP 服务端

> 本指南带你跑起自己的 WoWSP 服务端节点——完整的战斗推送网关、战绩
> 查询缓存，或两者兼有——再把桌面端和成员们的手机指向它。整套服务端
> 就是仓库里现成的 `packages/pairing-relay` 代码。线上契约见
> [cache-mesh.md](../designs/cache-mesh.md)（查询缓存、块、peers）与
> [gateway-push.md](../designs/gateway-push.md)（战斗推送）；本页只谈
> 部署与运维。

## 为什么要自建

- **私密**：成员的对局推送走你自己的服务端，不经过公共节点。
- **免验证码**：私有部署可以关闭 Turnstile，和/或改用一个简单的密码
  保护。
- **自主**：指向你拥有的任意域名（军团域名就很合适），对成员来说也是
  一个小福利。
- **提速**：你的节点缓存战绩查询，成员的 stats 请求先命中你的缓存
  （以及共享网格），而不必在国服晚高峰各自硬啃上游。

战队也好、个人也好，把一个节点跑起来、把域名填进应用的缓存服务器
列表，这就是网格设计的本意——节点越多，大家的查询越快。

## 节点可以是什么

| 能力 | 含义 | Cloudflare Worker | 原生服务端（VPS / 局域网 / Docker） | Vercel 边缘 |
| --- | --- | --- | --- | --- |
| `gateway` | `/gateway/*` 战斗推送 WebSocket | ✔ | ✔ | —（边缘函数无 WS） |
| `lookup` | `/api/lookup/*` 战绩缓存代理 | ✔ | ✔ | ✔ |
| `peers` | `/api/peers/*` 注册表（列表 + 自宣告） | ✔ | ✔ | ✔ |
| `blocks` | `/api/blocks/*` + `/ipfs/*` 内容存储 | ✔ | ✔ | ✔ |

- **Cloudflare Worker**——与官方节点相同的 wasm；桌面端内置向导即可
  部署（默认只开网关，网格可选）。最适合零维护的公共节点。
- **原生服务端**——一个自包含二进制（`relay-server`，axum + SQLite），
  跑在 VPS、局域网机器或 Docker 上；全部能力，无需 Cloudflare 账号。
  最适合完全掌控与局域网舰队。
- **Vercel 边缘**——`packages/relay-vercel` TypeScript 适配器，HTTP
  子集（无战斗推送）；在 Vercel 控制台即可部署，零 Rust 工具链。

每个部署的 `GET /api/health` 都会汇报自己的能力；客户端先探测再
使用，因此只跑网关的节点根本不会收到查询流量。

## 战绩查询缓存

过去每次战绩查询都由桌面端直连 WG/Lesta/vortex 上游，国服晚高峰的
vortex 传输能慢到 30 秒，整个体验跟着一起崩。

节点做的事就是把查询变成服务端缓存：一个玩家的 30 秒慢查询，变成
所有人的约 100 毫秒缓存命中——先命中你自己的节点，再惠及整个网格。
节点之间以内容寻址、逐块校验的方式共享缓存，社区节点可以直接应答
它自己从未拉取过的数据。

边界也要交代清楚：网格上只走公开游戏数据（与官方战绩站点匿名服务的
字节相同）。战斗推送帧和反馈从不进网格；节点不记查询日志、不存客户端
标识；http 或 IP 字面量节点也进不了公共列表——局域网舰队天然保持
私有（cache-mesh.md §8）。

## 路线一 —— Cloudflare Worker

### 前置条件

1. 一个 Cloudflare 账号（免费 Workers 套餐即可——免费档的 Durable
   Objects 使用 SQLite 存储，网关与网格的限流器正好用到它）。
2. 托管在该 Cloudflare 账号上的域名或子域名（部署时会自动为它绑定
   Workers Custom Domain）。
3. 运行桌面端的机器上有 Node.js（含 `npx`）与带
   `wasm32-unknown-unknown` 目标的 Rust 工具链——或者直接使用应用
   内置的向导，它会帮你逐项检测。

### 一键方式（桌面端）

设置 ▸ 连接 ▸ 配对 ▸ **自建网关向导** 逐步完成：

1. **环境检测**——检查 `node`、`npx`、`rustc`、wasm32 目标与
   `worker-build`；缺失项会给出安装提示。
2. **登录 Wrangler**——运行 `npx wrangler login`（会打开浏览器；令牌
   只保存在 wrangler 自己的本地状态里，绝不进入 WoWSP）。
3. **目标域名**——网关要绑定的子域名，例如
   `wowsp.your-legion.example`。
4. **KV 桶**——创建/选择网关保存每个频道最近一场对局所用的
   `GATEWAY_KV` 命名空间。
5. **部署**——按仓库内模板生成填好的 wrangler 配置并执行
   `npx wrangler deploy`，输出逐行流式显示在向导里。
6. **验证**——请求 `https://<你的域名>/gateway/health`，成功后展示
   URL（附复制按钮），在每位成员手机的 设置 ▸ 连接 ▸ 路由入口 里填入。

向导部署的是战斗推送网关，缓存网格保持关闭（模板里
`LOOKUP_ENABLED = "0"`，这是刻意设计——一个不加闸的允许清单代理
不该悄悄跟着上线）。

### 手动方式（命令行）

```bash
git clone https://github.com/langyo/wowsp && cd wowsp/packages/pairing-relay
rustup target add wasm32-unknown-unknown
cargo install worker-build@0.8.7 --locked  # 0.9+ 需要 worker crate >= 0.9
npx wrangler login
npx wrangler kv namespace create GATEWAY_KV     # 记下打印的 id
cp wrangler.selfhost.toml.example wrangler.selfhost.local.toml
# 编辑 wrangler.selfhost.local.toml：填入域名与 KV id
npx wrangler deploy --config wrangler.selfhost.local.toml
curl https://<你的域名>/gateway/health
```

### 打开缓存网格（Worker 形态）

模板默认网格关闭；Worker 形态的网格节点必须先绑好网格的存储接缝。
在你的自建配置里补上：

1. `[[kv_namespaces]]` 绑定 `LOOKUP_KV`（任意命名空间——存放 peer
   注册表文档、`node:id` 与宣告计数器）。
2. `[[r2_buckets]]` 绑定 `LOOKUP_R2`，并一次性建桶：
   `npx wrangler r2 bucket create wowsp-lookup-blocks`（块信封）。
3. `[[durable_objects.bindings]]` `LOOKUP_RATE`（类 `LookupRate`），
   并在你的迁移链上（模板的下一个 tag）补迁移条目：
   ```toml
   [[migrations]]
   tag = "v2"
   new_sqlite_classes = ["LookupRate"]
   ```
4. 删掉 `LOOKUP_ENABLED = "0"`（缺省即开），可选设置
   `PEERS_UPSTREAM = "https://wowsp.langyo.xyz"`（订阅广播名单）与
   `NODE_ROLE = "community"`。

调优旋钮（vars）：`LOOKUP_SYNC = "0"`（关闭 peer 透传）、
`SYNC_PEERS_MAX`、`LOOKUP_RATE_PER_HOUR`、
`PEERS_ACCEPT_ANNOUNCES = "false"`（注册表变只读）。

存储为什么这样拆分（免费额度现实）：

- **块放 R2**——每次缓存填充都是一次写；免费 KV 命名空间每天只有
  1000 次写且与其他流量共享，而 R2 免费档每月允许 100 万次 A 类操作。
- **限流放 Durable Object**——KV 计数器每请求都要一次 PUT；`LookupRate`
  SQLite DO（每小时、每 IP 一个分片，自删除）不受这类共享配额约束。
- **KV 写保持在宣告量级**——整个自有 peer 注册表就是一份文档，只在
  接受宣告时重写（本就被限为每 IP 每小时 10 次）；热点查询路径前面有
  边缘缓存兜着，命中时完全不烧存储读。

三种形态里 Worker 的配额最紧张：打算长期认真跑的缓存节点请选下面
的原生服务端；Worker 留给战斗推送和试验。

## 路线二 —— 原生服务端（VPS / 局域网 / Docker）

> 本节内容整理自 crate 自己的 README
> （`packages/pairing-relay/crates/relay-server/README.md`）；
> 有出入时以 README 为准。

一个二进制，全部能力（`gateway` + `lookup` + `peers` +
`blocks`），状态放 SQLite——不需要 Cloudflare 账号，也不需要 wasm
工具链。

### 构建与运行

```bash
just build-server                       # 只做 release 构建
just run-server                         # 或直接运行
# 等价写法：
cd packages/pairing-relay && cargo run -p relay-server --release
```

服务端按设计只说 HTTP（TLS 终结是反向代理的事——Caddy/nginx/
Cloudflare）。冒烟检查：`curl http://127.0.0.1:8787/api/health`
应答 manifest 且全部能力为 true。

### 配置

优先级：`WOWSP_SERVER_*` 环境变量 > 工作目录下可选的
`wowsp-server.toml` > 默认值。机密一律走服务环境，不进任何被 git
跟踪的文件。

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `WOWSP_SERVER_BIND` | `127.0.0.1:8787` | 监听地址 |
| `WOWSP_SERVER_DATA_DIR` | `./wowsp-server-data` | SQLite 库 + 节点 id 文件 |
| `WOWSP_SERVER_PUBLIC_URL` | 未设 | 公开基础 URL；设置后（https、名字形态）节点会登记自己并定期重宣告；http/IP 字面量值作为私有行保留 |
| `WOWSP_SERVER_ROLE` | `community` | 信息性（`official`\|`community`） |
| `WOWSP_SERVER_NOTICE` | 未设 | 随健康文档下发的运营者公告 |
| `WOWSP_SERVER_GATEWAY_PASSWORD` | 未设 | 网关密码（缺省即关） |
| `WOWSP_SERVER_TURNSTILE_SITEKEY` / `_SECRET` | 未设 | `/gateway/session` 的 Turnstile 门禁 |
| `WOWSP_SERVER_PEERS_UPSTREAM` | `https://wowsp.langyo.xyz` | 订阅服务器列表的来源 |
| `WOWSP_SERVER_SYNC` | `true` | 本地未命中时向 peer 拉块 |
| `WOWSP_SERVER_SYNC_PEERS_MAX` | `3` | 每次未命中询问的 peer 数 |
| `WOWSP_SERVER_PEERS_ACCEPT_ANNOUNCES` | `true` | 接受宣告（关闭 → 403） |
| `WOWSP_SERVER_LOOKUP_RATE_PER_HOUR` | `240` | 每 IP 每小时查询预算 |

### 局域网与公网监听

`127.0.0.1` 默认值让服务端在宿主机之外不可见——个人缓存足够。要
服务局域网，绑 `0.0.0.0:8787`（或你的局域网地址）。要服务公网，
绑 `0.0.0.0` 并且前置一个终结 TLS、设置 `X-Forwarded-For` 的
反向代理——每 IP 预算以该头为键，缺了它所有客户端共用一个预算。
公共节点还应设置 `WOWSP_SERVER_PUBLIC_URL` 让节点登记自己。

### Docker

```bash
cd packages/pairing-relay/crates/relay-server
docker compose -f docker-compose.yml.example up -d --build
```

多阶段构建（`rust:1-bookworm` → `gcr.io/distroless/cc`），卷
`/data`，非 root 用户，端口 8787。开放端口前请先读 compose 文件里
的 `0.0.0.0` 警告。

### 数据目录布局

一份 `wowsp-server.db`（SQLite，WAL）加 `node-id.txt`（稳定节点 id，
只生成一次）：按 CID 键控的缓存信封（TTL + 24 小时宽限）、48 小时
宣告注册表（128 行上限）、战斗快照与按小时的限流窗口。后台任务每
10 分钟清扫过期行；SIGTERM 排空在途请求后退出。

### 加入网格

- **订阅**：默认的 `WOWSP_SERVER_PEERS_UPSTREAM` 订阅官方广播名单——
  你的节点服务自有注册表与官方列表的并集，本地未命中时向 peer 拉块。
- **宣告**：设置 `WOWSP_SERVER_PUBLIC_URL` 后，节点会登记自己并在
  每次清扫时向上游尽力重宣告。不设它就手动宣告——行存活 48 小时，
  每天两次 cron 即可保持在线：
  ```bash
  # cron：每 12 小时刷新一次宣告
  0 */12 * * * curl -fsS -X POST https://wowsp.langyo.xyz/api/peers/announce \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://wowsp.your-legion.example","contact":"XX军团节点"}'
  ```

## 路线三 —— Vercel 边缘

HTTP 子集（lookup + peers + blocks，无战斗推送），零 Rust 工具链：

1. Fork 本仓库（或推送一个包含 `packages/relay-vercel` 的分支）。
2. 在 Vercel：**Add New… → Project** 导入 fork，把 **Root Directory**
   设为 `packages/relay-vercel`（框架预设保持 **Other**）。
3. 创建 Upstash KV 数据库（Vercel 控制台 ▸ Storage ▸ Upstash KV，或
   <https://console.upstash.com>），把它的 REST 凭证填进项目环境变量
   `KV_REST_URL` / `KV_REST_TOKEN`。
4. 部署完成后，节点就在
   `https://<project>.vercel.app/api/health` 应答。

同时设置 `NODE_ID`（稳定的 32 位十六进制 id——不设的话每次冷启动
都像一个新节点），可选 `PEERS_UPSTREAM`、`NODE_ROLE`、`NOTICE`。
完整环境变量表见 `packages/relay-vercel/README.md`。

**内存模式注意**：没有 Upstash 环境变量时，适配器退化为内存
map——每个边缘 isolate 各自持有缓存，计数器随冷启动清零，peer 上限
也无法全局淘汰。`vercel dev` 与预览够用；正式部署请挂 Upstash KV
（免费档足够）。

## 让 WoWSP 指向你的节点

- **桌面端（战斗推送）**：设置 ▸ 连接 ▸ 配对 ▸ 路由入口——把官方的
  `https://wowsp.langyo.xyz/gateway/` 换成
  `https://<你的域名>/gateway/`，再打开"手机服务"开关。
- **桌面端（查询缓存）**：**缓存服务器**面板（设置 ▸ 连接，连接分组）。
  官方节点固定在首位；把你的域名加为第一条用户行，可拖动排序、逐条
  探测。用户自己的行永远优先于自动发现的社区节点。
- **手机端**：手机设置里的自定义网关根字段不变。手机不直接访问缓存
  服务器——桌面端的查询通过网格把两端都覆盖了。

### 网格信任模型（简版）

缓存服务器只是公开数据的信息源，仅此而已（cache-mesh.md §8）。块经
内容校验——说谎 peer 的行过不了 CID 哈希检查，直接丢弃；公共 peer
仅限 https 域名，宣告还要过存活回调；恶意节点最坏也只能给出过期或
错误的战绩数据，而客户端自己的健全性检查一直在盯防，信任级别与任何
上游相同。排序由用户管理，你自己的节点永远优先。战斗推送帧和反馈
从不进网格。

## 运维卫生

- **公告**：`GATEWAY_NOTICE` 变量（Worker）或 `WOWSP_SERVER_NOTICE`
  （原生）/ `NOTICE`（Vercel）随健康文档下发——告诉用户这个节点
  是谁在运营。
- **网关门禁**：Turnstile（Worker 上 `GATEWAY_TURNSTILE_SITEKEY` +
  `TURNSTILE_SECRET`；小部件的域名白名单必须包含 `tauri.localhost`、
  `asset.localhost` 与 `localhost`）和/或密码（`GATEWAY_PASSWORD`
  secret / `WOWSP_SERVER_GATEWAY_PASSWORD`）。一分钟内输错 5 次密码，
  来源 IP 就会被锁 5 分钟（HTTP 429 带 `retryAfter`）。两者都不设的
  话，任何知道频道 id 的人都能订阅——私有军团节点这样就够了。
- **限流**：`LOOKUP_RATE_PER_HOUR`（默认 240）限制查询代理的每 IP
  预算；宣告全平台限 10 次/小时/IP，注册表上限 128 行。额度紧张就
  调低查询预算；成员专用节点有余力可以调高。

两端连接失败都会以右上角 toast 提示。
