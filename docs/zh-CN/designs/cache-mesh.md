# WoWSP 缓存网格 —— 可自部署服务端、战绩查询缓存与节点同步

> 状态：契约文档（v1）。本文是 `packages/pairing-relay`（Cloudflare
> Worker）、原生 `relay-server` crate（VPS / 局域网）、
> `packages/relay-vercel` 边缘适配器以及桌面/手机客户端共同遵循的
> 路由、线上格式与策略的唯一权威来源。与 `gateway-push.md` 一样，
> 只维护 `en` 与 `zh-CN` 两份。

## 1. 动机

战斗推送网关（`/gateway/*`，见 `gateway-push.md`）已经验证了这套
模型：一份 Rust 策略核心（`relay-core`），多个传输层。现在有三个
问题推动它继续前进：

1. **部署自由。** 战队或个人应当能把 WoWSP 服务端跑在任何合适的
   地方——Cloudflare Workers（已有）、VPS 或局域网机器（原生二进制）、
   Vercel 类 serverless（HTTP 子集）——并且 WoWSP 客户端可以通过
   域名直接指向它。
2. **战绩查询在玩家所在的地方很慢。** 今天每次查询都由桌面端直连
   WG/Lesta/vortex/clans 上游（见 `commands/wg_realm.rs`）；国服
   晚高峰 vortex 传输能爬到 30 秒以上，整个生态都显得坏了。服务端
   缓存代理——官方节点、自部署节点、节点之间互相分享缓存内容——
   把一个玩家的 30 秒慢查询变成所有人的 100 毫秒缓存命中。
3. **任何单一节点都不该是单点故障。** 节点通过广播服务器列表互相
   发现（官方节点播种，任何节点都可订阅），并以内容寻址的方式交换
   缓存查询结果，于是社区节点可以服务它自己从未拉取过的数据。

## 2. 节点能力模型

每个 WoWSP 服务端部署的 `GET /api/health` 在原有 manifest 之上多出
`capabilities` 对象与 `node` 块。旧客户端忽略新键；新客户端先探测
再使用。

```json
{
  "ok": true,
  "provider": "wowsp-gateway",
  "name": "WoWSP Gateway",
  "version": "0.5.0",
  "notice": null,
  "capabilities": {
    "gateway": true,
    "lookup": true,
    "peers": true,
    "blocks": true
  },
  "node": {
    "id": "8f14e45fceea167a5a36dedd4bea2543",
    "role": "official",
    "sync": true,
    "peersUpstream": "https://wowsp.langyo.xyz"
  }
}
```

| 能力 | 含义 | Worker | 原生 | Vercel |
| --- | --- | --- | --- | --- |
| `gateway` | `/gateway/*` 战斗推送 WebSocket 命名空间 | ✔ | ✔ | —（边缘无 WS） |
| `lookup` | `/api/lookup/*` 战绩缓存代理 | ✔ | ✔ | ✔ |
| `peers` | `/api/peers/*` 注册表（列表 + 自宣告） | ✔ | ✔ | ✔ |
| `blocks` | `/api/blocks/*`（+`/ipfs/*` 别名）内容存储 | ✔ | ✔ | ✔（内存或 KV） |

- `node.id` —— 32 位小写十六进制，每个部署稳定不变（原生：随机生成
  持久化在数据目录；Worker：KV `node:id` 缓存）。不是机密；它让网格
  遥测能区分"节点重启"与"另一个节点"。
- `node.role` —— `official` | `community`（信息性）。
- `node.sync` —— 本节点在本地缓存未命中时是否向 peer 拉取块（§5.4）。
- `node.peersUpstream` —— 本节点从哪里订阅服务器列表（默认官方）；
  同样是给人看的信息。

整个 `capabilities` 对象缺失（旧部署或陌生 200）即"只有 gateway"——
查询客户端把该节点视为不可用于战绩，直接跳过。

## 3. 查询命名空间 —— `/api/lookup/*`

### 3.1 路由

```
GET|POST /api/lookup/fetch?url=<百分号编码的上游绝对 URL>
```

- 方法与上游一致。POST 原样转发请求体（≤ 8 KiB）。
- `url` 必须是 `https` 且主机必须在统计允许清单（§3.2）上；否则
  **403** `{"error":"forbidden_host"}`。
- 上游预算：总 15 秒、响应 8 MiB 上限。超限的体直接透传但不缓存。
- 上游失败返回 **502** `{"error":"upstream_failed"}` —— 客户端回退到
  自己的直连链。
- User-Agent：应用自己在用的浏览器形态 UA（国服 WAF 拒绝非浏览器
  UA）—— 常量放在 `relay-core`，所有传输层一致。

### 3.2 主机允许清单（唯一来源：`relay-core::lookup`）

即 `res/config/upstream-endpoints.json` 的 stats 家族：

```
api.korabli.su            api.worldofwarships.eu    api.worldofwarships.com
api.worldofwarships.asia  vortex.korabli.su         vortex.worldofwarships.eu
vortex.worldofwarships.com vortex.worldofwarships.asia
vortex.wowsgame.cn        clans.wowsgame.cn
api.wows-numbers.com      v3-api.wows.shinoaki.com  api.wows.yuyuko.dev
```

重定向：跟随，但最终主机必须与原主机相同（原生传输层强制；Worker
的 fetch 实际只跟同主机重定向——记录在案的残余风险，允许清单上的
主机只会重定向到自己）。

### 3.3 缓存键、信封、TTL

缓存键是规范请求行的 CID（§4.1）。钉死的拼写如下——原始表述
`"<METHOD> <url>[<sha256(body)>]"` 中的方括号是**可选字段记号**，
绝不是字面字符；把方括号实现进去就是兼容性 bug：

- GET 行就是 `GET <url>`——两个字段，中间一个空格，url 之后
  再无内容；
- POST 行是 `POST <url> <sha256hex>`——转发体的 sha256 小写
  十六进制作为**第三个以空格分隔的裸十六进制字段**（64 字符，
  无前缀、无方括号）。

方法名转大写；url 逐字节保持客户端的原样拼写（同一上游 URL 的
两种拼写就是两条缓存）。该拼写由 Rust/TS 两侧共同钉死——
`relay-core` 的单元测试与跨实现 fixture
`packages/relay-vercel/test/policy.fixture.json` 携带相同的规范行
与 CID 向量（两侧各自独立钉住：`relay-core` 在自己的测试模块里，
TS 适配器在 fixture 里），偏离钉死拼写的哪一侧就会先挂 CI。

存储信封（JSON）：

```json
{
  "v": 1,
  "status": 200,
  "contentType": "application/json",
  "bodyB64": "…",
  "fetchedAt": 1732185600,
  "ttl": 120,
  "upstream": "vortex.wowsgame.cn",
  "line": "GET https://vortex.wowsgame.cn/api/accounts/503224851/"
}
```

可选成员 `line` 携带本块 CID 所对应的规范请求行——这是
§4.2/§8 网格校验锚点在实现中的真实形态。节点在自家铸造的每一行
上都写入它；**缺少该成员的 peer 来源行必须失败关闭**（没有可校验
CID 的对象），携带它的行通过在其上重算 CID 来验证。不含该成员的
外来/旧版行仍可解析——并且再序列化时保持缺失——旧行重发时字节
兼容。

按用途区分的 TTL（主机 + 路径前缀分类，`relay-core::lookup` 中的
纯函数，Vercel 适配器镜像，共享 fixture 测试钉死）：

| 上游 | 路径形态 | TTL |
| --- | --- | --- |
| vortex | `/api/accounts/<id>/ships/…`、`/api/accounts/<id>` | 120 秒 |
| vortex | 搜索 / 自动补全 | 600 秒 |
| clans.wowsgame.cn | 任意 | 600 秒 |
| WG/Lesta API | `/wows/account/*` | 120 秒 |
| WG/Lesta API | `/wows/clans/*`、赛季 | 600 秒 |
| WG/Lesta API | `/wows/encyclopedia/*` | 86400 秒 |
| api.wows-numbers.com | 期望值表 | 86400 秒 |
| yuyuko/shinoaki | 黑名单 | 86400 秒 |
| 清单上其余 | — | 300 秒 |

### 3.4 响应头

- 原始 `content-type`（默认 `application/json`）。
- `cache-control: public, max-age=<剩余 ttl>` —— 边缘缓存与浏览器
  也可以加入。
- `x-wowsp-cache: hit | miss | peer-hit` 与 `age: <秒>` —— 客户端在
  诊断里展示来源。
- `access-control-allow-origin: *`（stats 家族是公开数据）。
- Worker 传输层在 KV 之前再加边缘 Cache API（合成键
  `https://lookup.edge/<cid>`，`digests.rs` 的既有模式），热点流量
  不烧 KV 读。

### 3.5 滥用预算

`/api/lookup/*` 每 IP 限流：240 次/小时（Worker 上是
`LookupRate` SQLite Durable Object——**不是** KV 计数器，每请求一次
PUT 会烧穿免费 KV 写预算；原生用内存+SQLite，Vercel 用 Upstash）。
429 带 `retry-after`。运营者可用 `LOOKUP_RATE_PER_HOUR` 覆盖。

## 4. 内容寻址块 —— `/api/blocks/*`

### 4.1 CID 方案（与 IPFS 兼容的内容寻址）

```
cid = CIDv1(raw, sha2-256(multihash 0x12 0x20 || sha256(规范请求行)))
```

URL 中用 base58btc 拼写。这是 IPFS 对 raw 字节的标准 CID 布局：
wowsp 节点的块存储与 IPFS 节点对同样内容产生相同 CID，而
`/ipfs/<cid>`（§4.2）让每个 wowsp 服务端对它的块来说就是一个
字面意义上的 IPFS HTTP 网关。v1 不内嵌 kubo（Workers 上不可能）；
想要完整 IPFS 参与的 VPS 运营者可以自行 pin 块文件——磁盘布局
（`blocks/` 下每 CID 一文件、内容即信封 JSON）为此而文档化。

### 4.2 路由

```
GET /api/blocks/<cid>        → 信封 JSON（未知 404）
GET /api/blocks/<cid>/raw    → 解码后的体字节，带存储的 content-type
GET /ipfs/<cid>              → /raw 的别名（IPFS 网关路径约定）
```

按实际实现，校验是**基于请求行**的：CID 寻址的是规范请求行，因此
体的真实性由信封自己的 `line` 字段（§3.3）承载——在入口处，
peer 来源的行必须携带请求方算出的那条请求行，且在该行上重算 CID
必须复现所请求的 CID。缺少该字段的 peer 行失败关闭；内容不符过
不了哈希检查，直接丢弃、永不下发——恶意 peer 无法污染网格。

### 4.3 淘汰

块随 TTL 过期（+ 24 小时宽限给迟到的 peer 命中）；已落地的各端
均为惰性过期（原生：周期清扫任务；Worker：读取时检查——过期对象
即未命中，读取当时尽力删除，重填覆盖，刻意不设清扫 cron；Vercel：
Upstash TTL）。v1 不做配额记账——限流就是滥用闸门，存储量被 TTL
约束。

## 5. Peer 注册表与网格同步 —— `/api/peers/*`

### 5.1 列表

```json
GET /api/peers
{
  "v": 1,
  "generatedAt": 1732185600,
  "peers": [
    {
      "url": "https://wowsp.example.org",
      "capabilities": { "gateway": true, "lookup": true, "peers": true, "blocks": true },
      "role": "community",
      "nodeId": "8f14…",
      "addedAt": 1732185600,
      "lastSeenAt": 1732185700,
      "notice": "XX军团节点"
    }
  ]
}
```

- `cache-control: public, max-age=60`，`etag` 便于廉价再验证，
  CORS 开放。
- 任何节点都能提供列表。一个节点的视图 = 自己的注册表 ∪ 它的
  `peersUpstream` 的列表（默认官方；可配置），自己的行优先。这就是
  gossip：自部署节点**订阅**官方广播列表（也可以把 `peersUpstream`
  指向任何其他节点——包括另一个自部署节点）。

### 5.2 自宣告（握手）

```
POST /api/peers/announce   {"url": "https://wowsp.example.org", "contact": "可选"}
```

1. 形状闸：`https` URL、主机不是 IP 字面量（公共网格 = 只用名字；
   局域网/http 节点保持私有，§5.3）、≤ 253 字符。
2. 存活回调：注册表拉取 `GET {url}/api/health`（10 秒预算），记录
   答复的 `capabilities` + `node.id`。不可达或陌生 →
   `{"ok":true,"listed":false,"reason":…}`（200 —— 宣告尽力而为，
   永远不算调用方的错误）。
3. 行存活 48 小时；重新宣告刷新 `lastSeenAt`。注册表上限 128 个
   peer（按最旧 `lastSeenAt` 淘汰）。
4. 限流 10 次宣告/小时/IP。
5. **官方**注册表是所有人订阅的种子；社区注册表同样接受宣告
   （运营者可用 `PEERS_ACCEPT_ANNOUNCES=false` 关闭）。

已成为契约的实现细节：peer 行的过期是**读取时惰性判定**——行自
`lastSeenAt` 起存活 48 小时，过期行只是不再出现在读取结果里，
下一次由宣告触发的重写会把它们从存储文档中彻底清掉。Worker 上
整个自有注册表是**一份 KV 文档**（键 `peers:own`，即整个行向量），
出于配额经济学——每次列表渲染一次读、每次接受宣告一次写——上游
订阅在 `peers:upstream` 下缓存一分钟，列表渲染本身再前置一层
60 秒边缘缓存。

### 5.3 私有 / 局域网节点

http 或 IP 字面量 URL 永远不进公共列表。原生节点把这类行保存在
自己的表里（标记 `"private": true`，从自己的 `/api/peers` 输出中
排除），于是局域网舰队仍能组网：该局域网的客户端直接把节点加为
缓存服务器；其它局域网节点把 `peersUpstream` 指向它。

### 5.4 拉取式同步（第一波的"P2P 数据同步"）

当查询在本地未命中且 `node.sync` 打开时：

1. 计算 CID，向列表中最多 `SYNC_PEERS_MAX`（默认 3）个 peer
   （先自己的表，再上游的）发起 `GET {peer}/api/blocks/<cid>`，
   每个 3 秒预算。
2. 校验 CID 与请求行，存入本地，以 `x-wowsp-cache: peer-hit` 服务。
3. 全部未命中 → 照常打真实上游。

同样已成为契约的两个实现细节：peer 交回的块其 TTL 会在本地
**重新分类**——服务的 `ttl` 取 `min(peer 声明, classify_ttl)`
（按 §3.3 表），peer 的声明只能缩短窗口、不能延长；同步候选的
选择**自有表优先**（自有注册表行按列表顺序），自有注册表为空时
退化为对合并列表的**确定性随机**排序——以 sha256(url, cid, 小时桶)
为键——使恶意的上游列表无法垄断前 `SYNC_PEERS_MAX` 个位置。

v1 的同步是惰性（按需拉取）且内容校验的——没有后台 gossip 任务、
没有推送、没有 want-list 协议。那些留作后续工作（在此记录，避免
路由名被重新发明）。

## 6. 客户端集成（桌面 + 手机）

### 6.1 配置（`network-config.toml`，`NetworkConfig`）

```toml
stats_cache_enabled = true
stats_cache_servers = ["https://wowsp.langyo.xyz"]   # 有序，用户管理
stats_peer_autodiscover = true
```

- 与镜像梯子一样净化（仅 https、容忍回环 http、修剪、去重、上限 8）。
- 默认条目即官方节点——与应用已钉住的
  `BUILTIN_WORKER_ROOT_URL` 常量（`packages/app/tauri/src/commands/gateway/urls.rs`）
  同源，全新安装无需输入任何内容即享受缓存服务。设置入口是
  **缓存服务器**面板（设置 id `cacheServers`，连接分组；§6.3）。
- `stats_peer_autodiscover`：打开时，客户端周期性订阅
  `GET {official}/api/peers`，按 `lookup` 能力过滤，探测头部条目，
  在用户自己的列表**之后**（永远不插前）使用最多 3 个已验证社区
  节点。设置页用平实的文字披露这一点；开关一键可关。

### 6.2 传输层钩子（`commands/upstream_health.rs`）

对允许清单上的 stats URL，在既有代理→直连链之前：

```
for server in [用户列表…] ++ [自动发现…]:
    GET {server}/api/lookup/fetch?url=<enc>     # 6 秒预算，完整读体
    2xx → 完成（当作上游应答来解析）
非 2xx/超时 → 下一个 → … → 既有链
```

- 钩子放在每个 stats 请求已经经过的唯一咽喉点
  （`recorded_get` / `get_with_fallback` / `send_with_fallback`）
  —— 不改任何调用点。
- 上游健康记账只记录直连路径的结果（缓存命中不得美化上游的健康
  行）。
- 会话/single-flight/磁盘缓存不动 —— 它们在该钩子之上，照常工作。

### 6.3 探测 + 设置界面

- 新命令 `stats_cache_probe`（对标 `github_mirror_probe`）：每服务器
  `{url, ok, latencyMs, capabilities, error}`。
- 新设置页 **缓存服务器**（连接分组）：官方节点固定在首位，用户行
  （增/删/拖动排序/探测徽标），全部测试，自动发现开关，以及链接
  运维指南的自部署提示卡。i18n 覆盖全部 8 种语言。

## 7. 部署矩阵

| 平台 | 包 | 能力 | 存储 |
| --- | --- | --- | --- |
| Cloudflare Workers | `crates/relay-worker`（wasm） | 全部四项 | KV（单文档注册表 + 计数器缓存，边缘缓存前置）+ R2（块，桶 `wowsp-lookup-blocks`）+ `LookupRate` SQLite DO（限流）+ gateway DO |
| VPS / 局域网 / Docker | `crates/relay-server`（原生 axum） | 全部四项 | SQLite + 内存 |
| Vercel 边缘 | `packages/relay-vercel`（TS 适配器） | lookup + peers + blocks | Upstash KV REST（或每实例内存） |

Worker 启用配方——官方 `wrangler.toml` 绑定的变量/绑定，也是
自建节点打开网格要补的东西。`LOOKUP_ENABLED` **缺省即开**
（设 `"0"` 会把六条网格路由闸成 404，并把 `/api/health` 的
capabilities 降为 false）。绑定 `LOOKUP_KV`（注册表文档、
`node:id`、宣告计数器）、`LOOKUP_R2` 并一次性执行
`npx wrangler r2 bucket create wowsp-lookup-blocks`（块信封）、
以及 `LOOKUP_RATE` Durable Object 绑定与迁移 v6
（`new_sqlite_classes = ["LookupRate"]`——每 IP 小时预算）。
可选变量：`PEERS_UPSTREAM`（订阅广播名单；默认官方）、
`NODE_ROLE`、`PEERS_ACCEPT_ANNOUNCES`、`SYNC_PEERS_MAX`、
`LOOKUP_RATE_PER_HOUR`。`/ipfs/*` 另需在 `run_worker_first`
里与 `/api*` 并列加自己的条目——IPFS 网关路径约定刻意放在
`/api*` 之外。

- 原生服务端复用 `relay-core` 状态机（gateway auth/channel、lookup
  策略、peers 策略），DO/KV 接缝换成进程内实现：票据在内存（120 秒
  TTL）、频道是广播枢纽、快照镜像进 SQLite。
- 配置：`WOWSP_SERVER_*` 环境变量（绑定地址、数据目录、公开 URL、
  角色、公告、peers 上游、sync 开关、gateway 密码 / Turnstile）+
  可选 `wowsp-server.toml`。默认安全：`127.0.0.1:8787`、公共节点
  sync 开、接受宣告。
- Vercel 适配器只镜像允许清单/TTL/CID 策略（与 `relay-core` 共享
  的 fixture 测试钉死）—— 无 Rust 工具链也能部署：在包里
  `vercel deploy`。

## 8. 安全与滥用模型

- **SSRF**：查询代理只认允许清单（13 个主机）、仅 https、同主机
  重定向、8 MiB/15 秒上限。它永远不是开放代理。
- **网格投毒**：块按 CID 内容校验——说谎 peer 的行过不了哈希检查，
  直接丢弃，永不下发。
- **注册表投毒**：宣告需要存活的健康回调、仅 https 名字、48 小时
  TTL、128 peer 上限、10 次/小时/IP 限流；运营者可关闭自己的注册表。
- **隐私**：stats 家族是公开游戏数据（与官方站点匿名服务的字节
  相同）。节点只存缓存文档——网格中没有查询日志、没有客户端标识。
  战斗推送帧与反馈永远不进网格。
- **客户端信任**：缓存服务器是公开数据的信息源；恶意节点最坏只能
  给出过期/错误的**战绩数据**，而客户端自己的健全性检查（信封形状、
  状态闸）早已盯防——与任何上游同级的信任。用户管理的顺序意味着
  用户自己的节点永远优先。

## 9. 线上参考（速查表）

| 路由 | 方法 | 含义 |
| --- | --- | --- |
| `/api/health` | GET | manifest + `capabilities` + `node` |
| `/api/lookup/fetch?url=` | GET/POST | 战绩缓存代理（允许清单） |
| `/api/blocks/<cid>` | GET | 按 CID 取缓存信封 |
| `/api/blocks/<cid>/raw` | GET | 解码后的体字节 |
| `/ipfs/<cid>` | GET | `/raw` 的 IPFS 网关别名 |
| `/api/peers` | GET | 广播服务器列表 |
| `/api/peers/announce` | POST | 自宣告（存活校验） |
| `/gateway/*` | — | 不变（`gateway-push.md`） |
