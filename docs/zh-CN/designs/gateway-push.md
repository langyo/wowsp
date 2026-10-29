# 网关推送：按账户路由的实时对局（设计契约）

> 状态：草案（feat/mobile-gateway 这一波次的实现契约）。
> 范围：用可配置的**路由入口**（运行标准 pairing-relay wasm 的 Cloudflare
> Worker）取代桌面端配对码，加入按账户路由的对局**推送**、手机端的等待/
> 接收流程、按部署可选的 Turnstile/密码门禁，以及自建向导。
> 英文原文见 [gateway-push.md](../../en/designs/gateway-push.md)（如两者
> 有出入，以英文版为准）。

## 1. 目标

1. **桌面端不再需要配对码。** 桌面端改为配置一个路由入口——某个网关部署的
   基础 URL，默认为官方部署 `https://wowsp.langyo.xyz/gateway/`。
2. **对局自动推送。** 桌面端每检测到一场**新**对局（tempArenaInfo 送达，
   `arena_info::deliver_arena` 返回 `Battle`）就恰好推送一次，携带对局
   所在服、双方全部玩家名 + 船只、模式、地图与时间戳。
3. **同一账户接收。** 手机端在确认与桌面端**同一账户**（绑定/激活）后主动
   订阅，从服务端接收对局事件；对局进行中连接还能立即拿到当前对局快照。
4. **自建是一等公民。** 服务端源码就是仓库里的 `packages/pairing-relay`；
   设置里的向导可部署私有实例（目标域名、wrangler 登录、KV 桶、子域名），
   手机端可填自建域名。军团指挥官可以把自建作为成员福利下发。
5. **滥用防护。** 公共（官方）节点在推送服务启动前要求两端都通过
   Cloudflare Turnstile；私有节点可关闭 Turnstile 和/或设置密码（一分钟内
   5 次失败锁定来源 5 分钟）。

## 2. 频道身份

- 频道 id：**正在游玩的账户**的 `r:<realm>:<accountId>`（会话枢纽解析出的
  身份——名册里的本地玩家匹配到已绑定档案；无匹配时回退到当前激活账户）。
- 手机订阅**自己激活账户**的频道（realm + accountId 相等即"同一账户"确认）。
- id 是不透明 ASCII；Worker 只校验形状 `^r:[a-z]{2,5}:[0-9]+$`，不做任何
  额外解释。

## 3. HTTP + WebSocket 面（全部位于路由入口下）

路由入口是一个基础 URL，所有端点相对它解析——同一份 wasm 既服务官方节点
（`https://wowsp.langyo.xyz/gateway/`），也服务任何自建根路径
（`https://gateway.example.com/`——自建模板只绑定 `/gateway/*`，无需站点
资源）。

```
GET  {entry}/health        — 部署配置文档（无鉴权）
POST {entry}/session       — 凭据交换：Turnstile token 和/或密码
                             → { ticket }（一次性，≤120 秒 TTL）
WS   {entry}/pub?route=…&ticket=…   — 桌面端发布方（role=host）
WS   {entry}/sub?route=…&ticket=…   — 手机端订阅方（role=client）
```

### 3.1 `GET /health`

```json
{
  "gateway": "v1",
  "minClientVersion": "0.6.8",
  "auth": {
    "turnstile": { "required": true, "sitekey": "0x4AAA…" },
    "password":  { "required": false }
  },
  "notice": "可选的运营者公告"
}
```

- 官方部署 `turnstile.required` 为 true。未配置 `GATEWAY_TURNSTILE_SITEKEY`
  变量即视为关闭（自建默认）。`password.required` 反映 `GATEWAY_PASSWORD`
  密钥是否存在。
- 边缘缓存 60 秒（公开、无鉴权）。

### 3.2 `POST /session`

请求体：`{ "route": "r:asia:123456", "cf-turnstile-response": "…token…",
"password": "…" }`（未要求的凭据可省略）。

- 恰好校验健康文档要求的内容：Turnstile token 走
  `https://challenges.cloudflare.com/turnstile/v0/siteverify`（复用
  `relay-core::feedback::turnstile_verify_body`），密码与
  `GATEWAY_PASSWORD` 密钥做常数时间比较。
- 密码失败：任意 60 秒窗口内 5 次（按来源 IP 计）→ 该 IP 锁定 300 秒，
  返回 HTTP 429 + `retryAfter`。计数器放在鉴权 Durable Object 里（KV 的
  最终一致性不够）。
- 成功 → `{ "ticket": "<32 hex>", "route": "…", "ttl": 120 }`。ticket
  一次性，绑定（route, 凭据种类），在首次 WS 升级时消耗。

### 3.3 `WS /pub`（桌面端）与 `WS /sub`（手机端）

- 查询参数：`route`（校验过的频道 id）+ 来自 /session 的 `ticket`。每个
  频道一个发布者：携不同持久 hostId 的第二个 host 会顶替第一个（与中继
  目录的 one-code 规则同策）。
- 连接后服务端先发
  `{"type":"hello","gateway":"v1","role":"pub|sub"}`，随后（如有）当前频道
  状态 `{"type":"battle", …}`。
- 桌面端 → 服务端（文本帧）。对局体与应用的 `ArenaInfo` 头部 +
  `VehicleEntry` 字段一一对应（去掉 `raw`），手机端无需转换即可映射进
  名册仓库：
  `{"type":"battle","realm":"asia","route":"r:asia:123456",
     "self":{"name":"…","accountId":123},
     "battle":{"dateTime":"2026-10-29 22:00:00","matchGroup":"pvp",
     "mapName":"14_ATL_NavalBase","scenario":"","eventType":"",
     "botCount":0,"scriptedUnitCount":0,
     "vehicles":[{"id":123,"name":"…","relation":0,
                  "shipId":4189570000,"shipName":"Yamato"}]} }`
  （`relation` 0 = 本人、1 = 友方、2+ = 敌方——与本地 arena 名册一样据此
  分边。）对局结束时（游戏退出/名册清空）发 `{"type":"bye"}`。单个对局
  事件 ≤ 64 KiB；超限帧被拒（1009）。
- 服务端 → 手机端：同样的 `battle` 帧（实时扇出）+ 在线状态：
  `{"type":"host","online":true|false}`。频道 DO 在对局期间（+5 分钟）
  保留最后一份对局快照，手机端在对局中连接 `/sub` 即可立刻拿到。
- 保活：双向每 30 秒文本 ping（Cloudflare 约 100 秒掐断空闲代理连接），与
  现有中继套接字一致。
- 两个套接字都住在 Rust 命令里（webui 绝不直接拨网关 WebSocket——与今天
  的码中继同一规则）：
  - 桌面端：`gateway_publish_start` / `gateway_publish_stop` +
    `deliver_arena` 的 Battle 钩子；连接阶段以 `wowsp://gateway-state`
    事件供给手机图标 UI；
  - 手机端：`gateway_subscribe_start` / `gateway_subscribe_stop`；收到的
    帧以 `wowsp://gateway-battle` 事件重新发给 webui，由实时页面渲染。
  `GET /health` 同样经由 Rust 命令（`gateway_get_health`）获取——webui
  自身不做跨源请求。

## 4. 部署配置

官方部署（packages/pairing-relay 的 wrangler.toml）新增：

- 变量：`GATEWAY_TURNSTILE_SITEKEY`（空 ⇒ Turnstile 关闭）；网关并入
  `run_worker_first` 的 `/api*` 列表——网关位于 `/gateway/*`，资源层永远
  不会服务它，因此无需资源豁免。
- 密钥：`GATEWAY_TURNSTILE_SECRET`（siteverify）、`GATEWAY_PASSWORD`
  （可选；缺省 ⇒ 无密码）。

自建（模板 `wrangler.selfhost.toml`，由向导生成）：

- **同一份** wasm 构建（一个 worker 二进制；模板只是绑定更少）：
  routes = `{ pattern = "<子域名>", custom_domain = true }`；KV 命名空间
  `GATEWAY_KV`（最近对局快照镜像，TTL 1 小时）；DO 类走同一条迁移链
  （v1-v3 不变，**v4 新增 GatewayChannel + GatewayAuth**）。无 [assets]、
  无 R2、无 cron、无 feedback/erp/qqbot 变量——自建部署只在
  `/gateway/*` 上可达；未用到的处理器实际上不会被路由到（绑定缺失只在
  访问时才是问题，README 记录了受支持的面）。
- `GATEWAY_PASSWORD` 可选，`wrangler secret put` 配置；缺省 ⇒ 密码关闭。
- 官方部署的下一次 `wrangler deploy` 携带同一条 v4 迁移，`/gateway*`
  并入 `run_worker_first`（资源层不服务它；那里没有静态内容，也就无需
  按频道豁免）。

## 5. 桌面端流程（推送侧）

1. 设置 ▸ 手机服务：开关（持久化；默认关）+ 路由入口选择器（默认官方/
   自定义 URL，强制 https，回环地址允许用于开发——与中继客户端同一 URL
   策略）。
2. 服务开启期间：应用解析 `{entry}/health`。若要求 Turnstile，**左下角**
   tooltip（插件升级提示同款样式，锚在运行中游戏卡片旁，其旁加一枚手机
   图标）渲染挑战并**停留至通过**（标题提示用户至少点一次；通过铸出
   ticket 后才开始推送）。
3. `deliver_arena` == `Battle`（且手机服务开 + 会话 ticket 有效）时在
   pub 套接字上发布一帧；套接字以 30 秒保活维持整个对局，游戏退出时拆掉
   （`bye` + 关闭）。
4. 自定义节点失败同样以桌面端 toast 呈现（右上角，hikari useToast）。

## 6. 手机端流程（接收侧）

1. 手机 /live 自动进入**等待态**（账户徽章 + 路由入口 + "等待桌面端开启
   对局"）。
2. 开始连接：解析 `{entry}/health` → 若要求 Turnstile，**底部弹出**验证码
   窗口（hikari 手机 sheet 行为）；要求密码时出现密码输入 sheet。通过 =
   握手成功 → /session → /sub 套接字。
3. 收到的 `battle` 帧映射进现有 ArenaInfo 形状，经同一套实时组件渲染；
   `host.online` 切换等待页提示。**自定义**节点连接失败以右上角 toast
   提示。
4. 手机设置携带路由入口字段（默认官方；自建填自己的域名）。

## 7. 自建向导（桌面端设置）

各步（前进前均验证，输出流式进入向导）：

1. 环境探测：PATH 上的 node/npx（报告版本）；Rust 工具链 + wasm32 目标 +
   worker-build（缺失时经检测到的包管理器提供安装）。
2. Wrangler 鉴权：`npx wrangler whoami`；未登录则 `npx wrangler login`
   （浏览器流程）并等待。
3. 目标：子域名输入（须在该账号已有 zone 内）——向导经 `npx wrangler`
   列出 zone 并校验。
4. KV：创建/选择 `GATEWAY_KV` 命名空间。
5. 生成 `wrangler.selfhost.toml`（路由、KV id、DO 类），执行
   `npx wrangler deploy`；stdout/stderr 逐行作为进度事件流出。
6. 验证 `https://<域名>/gateway/health`；成功后展示要在手机上输入的 URL
   （二维码 + 复制）。

CF 令牌绝不进入仓库、日志或向导状态（使用 wrangler 自己的登录态；
AGENTS.md §7）。

## 8. Webui 集成点（已对照源码核实）

- **设置**：网关路由入口、手机服务开关与自建向导位于设置"连接"分组
  （account | network | pairing）。分区注册表（`stores/settingsUi.ts` 的
  SETTINGS_GROUPS + MOBILE_HIDDEN_SECTIONS）、`useSettingsBody.ts` 的
  SECTION_ICONS/标签，以及 `components/settings/sections/*` 槽位是确切的
  接线点。自建向导**仅桌面端**（MOBILE_HIDDEN_SECTIONS）；路由入口字段
  两端都显示。
- **Turnstile tooltip（桌面端）**：克隆 PluginUpdateHint 的锚定卡片模式
  （fixed、Teleport 到 body、位于侧栏底部游戏状态卡右侧——共用
  `statusCardEl` ref——z-tooltip 层、hikari 菜单行），但内容承载
  HkCaptchaWidget。手机服务开启且挑战未通过期间**钉住**（标题告诉用户
  通过一次），成功后解除。服务运行期间侧栏底部游戏状态卡旁加入手机图标
  （22px 槽位惯例）。
- **验证码组件**：hikari HkCaptchaWidget（siteKey、attempt、onVerify）——
  只在健康文档到达后挂载（控制台 FeedbackApp 的异步 sitekey 守卫），每次
  交换失败后重置 `attempt` 让组件重铸 token。
- **手机实时页**：/live 不再是占位符；自动进入等待态（自动等待，查看无需
  手势），开始连接按钮驱动握手（验证码底部 sheet + 可选密码 sheet，均为
  hikari 手机 sheet 行为），`wowsp://gateway-battle` 事件以推送的
  ArenaInfo 形状负载经现有实时面板渲染。
- **Toast**：自定义节点连接失败经 hikari useToast()（右上角通道）呈现。
- **Turnstile 小部件主机名**：应用 webview 来源——`tauri.localhost`
  （Windows 桌面端）、`asset.localhost`（安卓）——必须在小部件域名白名单
  里。官方部署的小部件加上它们（维护者操作，见 README）；自建文档 + 向导
  第 5 步指示运营者把它们加进自己的小部件。localhost 本就允许
  `wrangler dev`。

## 9. Tauri IPC 面（已钉死——按此逐字实现）

命令（全部 `CommandResult`，anyhow 端到端；下列反引号内的稳定错误标记即
确切的拒绝字符串）：

```ts
gateway_get_config() -> { root: string, enabled: boolean }
   // root = 规范化后的路由入口；默认 "https://wowsp.langyo.xyz/gateway/"。
   // enabled = 手机服务。
gateway_set_config({ root?, enabled? }) -> GatewayClientConfig
   // root 按中继 URL 策略校验（强制 https，回环可用）。
gateway_get_health({ root }) -> GatewayHealthDoc
   // 错误：`gateway unreachable or health document invalid` |
   // `gateway speaks an unsupported gateway protocol` |
   // `gateway requires a newer app version`
gateway_open_session({ root, route, turnstileToken?, password? })
  -> { ticket: string, ttl: number }
   // 错误：`gateway captcha verification failed` |
   // `gateway password rejected` |
   // `gateway rate limited, retry after Ns`（N = 秒数）
gateway_publish_start({ route, turnstileToken?, password? }) -> void
   // 桌面端；route 由调用方（webui）从会话枢纽推导。
gateway_publish_stop() -> void
gateway_subscribe_start({ root, route, turnstileToken?, password? }) -> void
gateway_subscribe_stop() -> void
gateway_selfhost_probe() -> SelfhostEnv
   // { nodePath?, nodeVersion?, npxPath?, rustc?, wasmTarget?, workerBuild?,
   //   wranglerAuthed, account? }
gateway_selfhost_step({ step, ...args }) -> SelfhostStepResult
   // step = "wrangler-login" | "list-zones" | "kv-ensure" | "deploy" | "verify"
```

事件：

```ts
"wowsp://gateway-state"  { role: "pub"|"sub", route?,
                           phase: "resolving"|"captcha"|"connecting"|"online"|
                                   "error"|"stopped",
                           detail?: string }        // 桌面端 + 手机端
"wowsp://gateway-battle" GatewayBattleFrame        // 手机端（原样转发）
"wowsp://gateway-selfhost" { step, stream: "stdout"|"stderr"|"done",
                             line?, result? }      // 向导流式输出
```

TURNSTILE TOKEN 永远从 webui 进入（组件在那里渲染）；Rust 绝不渲染挑战，
只在 `/session` 交换 token，需要新 token 时重发 `captcha` 阶段（ticket
短命；TTL 内的新对局复用频道）。

## 10. 版本与兼容

- /health 中 `gateway: "v1"`；客户端拒绝 `> v1` 并沿用现有的
  unsupported-protocol 错误标记。`minClientVersion` 复用中继的版本门语义。
- 旧版基于码的中继（`/api/relay/*`）保持原样，手机的既有回放拉取向导在
  后续波次前不受影响。桌面端**不再显示**配对码；码分配路径本身保持可用，
  新网关铺开期间旧版手机仍可配对。
