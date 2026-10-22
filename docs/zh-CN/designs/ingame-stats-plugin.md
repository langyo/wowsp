# 游戏内战绩插件 —— 精确遥测设计

> **状态**：实验已收尾（2026-09-28），可进入实现。
> 覆盖层的伴生文档：显示层仍由透明窗口承担；本插件是游戏内的数据源，
> 让覆盖层的存活/沉没状态在任何环境（含独占全屏）下都精确。TAB 行序在
> 探针能于引擎内读到游戏自身排序之前曾是按客户端校准的推断——现在能读到
> 了（见下文"终极方案"）；随后的"排序规则"仍是回退方案与国服的故事。
>
> **更新（2026-10-01）**：新增第二种查看模式——游戏内展示。插件的 unbound 视图
> （安装到 `gui/unbound2/mods/WoWSPProbe.unbound`，游戏自动扫描并挂载的战斗视图目录）把战绩
> 直接绘制在游戏画面内，仅作用于新的 `table = "ingame"` 模式；本文其余部分描述
> 的"插件不渲染、透明窗口为唯一显示层"仍是覆盖模式（`"detect"`）的设计。桥接层
> （`commands/ingame_bridge.rs`）只在游戏内展示模式开启时应答 `request.json`，
> 两种显示不会同时出现。

## 背景与目标

现有实时战斗覆盖层靠截屏推断 TAB 队列表格的几何位置
（`overlay/capture.rs`、`overlay_detect.rs`），并以 30 ms 间隔轮询
`GetAsyncKeyState(VK_TAB)`。这套方案能用，但：

- 截屏是最脆弱的一层（DRM/捕获排斥、HDR、多 DPI、全屏差异）；
- 键态轮询无法区分"按住 Tab"与"聊天框里打 Tab"；
- 行序来自静态名单加击沉启发式推断。

一个跑在 Wargaming 官方 **Mods API**（PnFMods 通道，无注入、无内存
写入）上的游戏内 mod 可以从客户端内部观察战斗状态，经文件桥交给
WoWSP。该 mod **不渲染任何内容**——透明覆盖层仍是显示层——因此完全
不承担"游戏内渲染"方案按游戏版本维护 UI 的成本。

目标：把「mod 遥测 > 截屏推断 > 静态顺序」做成覆盖层数据的优先级
链，`overlay_config.toml` 的 roster 模式新增 `"plugin"` 值。

## 实验证明的事实

在 Steam 亚服 15.8.0（build 13187581）与 360 国服 15.8.1（build
13243917）上验证，各数局；探针产物见
`packages/ingame-plugin/src/Main.py`（对内恒报 `0.1.0`，迭代只走
git 历史）：

| 能力 | 机制 | 时延 / 备注 |
| --- | --- | --- |
| 双服加载 | `res_mods/<bin>/PnFModsLoader.py`（0 字节标记）+ `PnFMods/<Mod>/Main.py`，`API_VERSION = 'API_v1.0'` | 与 Aslain 共存 |
| 注入 API 模块 | `events, ui, utils, battle, callbacks, dataHub, constants` 为加载器注入的全局量；对它们 import 会失败（白名单），绝不能用 import 失败回退遮蔽 | builtins 同样白名单：无 `globals()`/`eval` |
| 名单与身份 | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm / isAlive | 记录是 `SafeClass`：下标可用、dict 协议不可用；加载早期容器短暂非 dict，需防御。记录自带的 `isAlive` 现为**权威**存活源——其翻转已按名字逐一与真实 Tab 截图的沉没行对表（2026-10-07 整局 journal） |
| 沉船归因 | 名单记录的 `isAlive` 翻转，1 s 轮询；avatar 实体遍历提供血量、仅作回退 | 记录逐名跟踪客户端表格（2026-10-07 整局 journal 验证）。锁存改由记录裁决：旧版「walk 单读即锁死」的单向锁存曾把玩家整局判死（观察到一例：本人在存活时被判沉没——该局 journal 已被环形缓冲覆盖，确切触发条件只能推断） |
| 实时血量与点亮 | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]`（`.value/.max/.isAlive`）、`entity[CC.relation]` | 敌方血量点亮前为 0/0——与游戏表格同等的战争迷雾；0→实值的跳变本身就是点亮事件 |
| TAB 屏状态 | SFM 事件 `input.tabModeIn` / `input.tabModeOut` | 按键后 ≤3 ms 触发；聊天打 Tab 不触发——直接消灭误报 |
| 名单变更 | `events.onPlayersListUpdated` | 一局触发 14 次 |
| 战斗生命周期 | `sfm.battleLoadingStarted`、`request.showBattle`、`onBattleStart`、`up.exitBattle`、`window.hide(Battle)` | 比 tempArenaInfo 文件出现/删除更细 |

**不可用**（也不需要）：avatar 实体上没有每玩家 score/XP 组件；
unbound 侧的 `$datahub.getCollection().getChildByPath('team.ally.sortedAlive')`
路径在 Python 侧没有对应：注入的 `dataHub` 没有 `getCollection`，注入的
`battle` SafeClass 也不转发 battleGate 内部的同名助手（15.9.0 实测）。

**排序规则——不稳定、按客户端各自校准；真值必须来自游戏内。** TAB 表格的
行序由各家客户端的 HUD 自行渲染，厂商之间已经真实分叉（早期"竞技场载具序
+ 沉没者按沉没顺序追加到尾部"的模型只是 WG 系的近似——它解不开的同分并列
组正是 #604 点点芯片的由来）。必须按服对照真实 TAB 截图校准，预期它随任意
客户端更新变动；反编译脚本只能当旁证，永远不是证明。2026-10-09 矩阵（用
wowsdeob 反编译本机安装的 `ShipSystem.add` / `AvatarSystem.__sortKeyAlive`）：

- **WG 系**（eu/na/asia 共用同一构建）：存活位、舰种位（CV < BB < CA < DD
  < SS < 辅助）、等级降序、`NATION.SORT_ORDER` 位、本地化船名、
  `[TAG]昵称`——单一字符串拼接。线上 15.8.0 于 2026-09-27 实拍 6/6 验证，
  下一个构建（13357625，2026-10-06 预下载）反编译出**完全相同**的国别序优先
  公式——WG 没有跟进。
- **360 国服**：自家 Python（13243917 与当前 13357822）仍在计算 WG 的国别序
  键，但客户端**渲染**的是本地化船名序（2026-10-07 实拍 9/9 拼音）——分歧在
  HUD/视图层。因此脚本反编译永远定不了这个客户端的规则，只有渲染实拍作数。
- **Lesta**（ru）：渲染的是它**自己**的排序键序——已由 2026-10-10 实战对局
  定案（探针桥接出的键逐行复现了表格，6/6 盟友）。2026-10-09 的"船名序、
  同国服"读法是误读：Lesta 自家的国籍表把 russia 排**最前**，键的船名段是
  内部代码（"2970PRSC103"），博加特里排在两条圣路易斯之前是国籍排位、不是
  名字排序——打不开的 `.pyc` 容器也不再要紧（键本身就是顺序）。同键在该服
  保持名单自身顺序（不是 WG 反编译追加的"+ 名字"并列裁决）。

app 把这些编码为离线排序键上的按服门控（utils/realms 的
`realmUsesShipNameOrder`；utils/shipClass 承载排序键本身与 CN 静态布局），
并拒绝把推断当作游戏内真值：
排序键映射未覆盖时，即使插件已连接，/live 面板头部仍把行序标注为推断
（警告药丸 + tooltip，`features/replay/telemetryGrade.ts`）。

**终极方案当日落地（2026-10-09）**——走舰船组件而非排序集合：注入的
ModAPI dataHub 只对 `SYNCED` 白名单导出 `getSingleEntity` /
`getEntityCollections` 两个方法（反编译
`ModsShell/API_v_1_0/dataHub.py`——仅此两个导出），而 **`'ship'` 在白名单
里**。探针顺 avatar 的 `ship` 槽摸到每名玩家的 Ship 组件，其 `sortKey`
正是客户端自己的 TAB 排序键（`str(SORT_ORDER.index(subtype)) +
str(100 - level) + str(NATION.SORT_ORDER.index(nation)) + shortName`，
`ShipSystem.add`，build 13357625），随遥测带出（`sortKeys`，名字 → 键）。
/live 面板按客户端自己的比较排序——映射覆盖全员时药丸评级**精确**：WG 家族
用"键 + '[TAG]昵称'"（即 `__sortKeyAlive` 的拼接串），Lesta 只按键、同键保持
名单自身顺序（2026-10-10 实测：两条同键杜伦尼——一名人类和一个 ':bot:'
——按记录序渲染，而普通比较会把 ':' 排在字母前）。船名序客户端（国服）从不
渲染自家脚本算出的键序，因此该服接管让位、药丸不会评精确。该路径的离线
合规于 2026-10-10 落地（`scripts/check_ingame_plugin.py` 的舰船 pass）：植入
的舰船实体钉住了 WG 形态（遥测里的完整键表 + 面板折叠按键、稳定地排序存活
块——夹具的同键对保持遍历序）、Lesta 形态（UiComponents 抛异——该路径对
组件鸭子类型、无需常量）、部分覆盖（未配对的 avatar 使该侧保持遍历序——
游戏内真值行与遍历序行绝不交错——已覆盖侧仍排序）与编码器怪癖（键表能扛过
手写序列化器）。原遗留事项当日实战闭环：一场真实 Lesta 人机对局完整给出了
'ship' 集合（含 bot 共 11/11 键），上述模型就此定案——`realmUsesShipNameOrder`
现仅限国服（ru 的离线回退是 WG 家族键：舰种/等级正确、明知国籍段错在俄国
排位，桥接键才是游戏真值），部分覆盖的对局保持校准回退——游戏内真值行与
推断行绝不交错。

**排序原料桥（2026-10-12）**——终极方案落地后仍剩两处只能离线近似：Lesta
的同键并列裁决（"名单自身顺序"只有客户端知道，而 app 的 Lesta 名单合成曾按
(name, id) 排序，把这份顺序销毁了）与国服的船名段（离线 DB 的本地化名只是
近似：app 语言的漂移、DB 未收录的新船落到哨兵）。探针自此把两份原料随遥测
带出：`rosterOrder`（getPlayersInfo 记录映射自身的迭代序列——py2 字典序对
给定键集是确定的，且 2026-10-10 实拍已证明该服客户端同键按记录序渲染）与
`shipNames`（记录自带的 shipName 字段——客户端渲染的本地化船名原串；记录
不携带该字段的构建输出空表，消费端自动退回 DB 名，行为与从前一致）。
roster_raw.json 同帧携带 `order` 数组，Rust 合成（probe_roster）据此保序
输出 vehicles（字段缺失或未被点名者回退 (name, id)），并把 shipName 榨取
进每行的 ship_name。webui 两侧（/live 面板与覆盖层）把 rosterOrder 预排为
并列基序（缺名者稳定居后），CN 排列在整侧覆盖时以客户端船名替换 DB 名段
（两源混排会错序，故按整侧门控）。评级纪律：曾长期"国服不评精确"——彼时排序函数是我们
的拼音整理器、名段还是 DB 近似；2026-10-18 起放开（见下文再校准）：当
客户端真值船名覆盖整侧时，比较器的输入就是客户端渲染的原串，CN 排列
评为**精确**（名字段部分覆盖则保持推断档）。

**AI 判定桥（2026-10-22）**——准星卡的机器人过滤自此有游戏自带的权威信号：
遥测新增 `bots`（记录的 `isBot` 行 + 脚本名风格 ':'/'IDS_'/'#'，逐战斗缓存，
瞬时空 getPlayersInfo 不清空中名单；故障回退体不带该字段——缺字段意为"探针
版本早于本桥"，绝非"无机器人"）。活动 PvEvP（对面机器人与真人混编）里部分
机器人顶着**普通昵称**，名字风格规则永远抓不住它们，只有记录自带的 isBot
能判：准星卡的 aim 判决过 `aimDisplayName` 双层门（AI 名风格 + bots 名单），
命中即**整卡不渲染**——连裸名都不显示；混合对局窗口保持打开、只显示真人。
整局级的压制在 Rust 侧另立一帜（`arena_info::last_enemy_all_ai`）：敌方整侧
全 AI（合作、非对称填充、脚本行动波次、普通昵称机器人整侧的事件局——靠 WG
arena 文件机器人行负 id 的约定识别——以及故意摆人机的自定义房间；按名单
裁决而非 matchGroup 字符串）时准星卡窗口整局保持收起；该旗与
`LAST_BATTLE_PVE` 刻意分离——后者还键着锚点校准的战斗类，而非对称的 TAB
表是两队布局、锚点属于 PvP 档。

**编组桥 + 帧名册兜底（2026-10-22）**——记录失效构建类（getPlayersInfo
整场为空——2026-10-18/19 实测报告；2026-10-22 支持包里的 WGC 客户端同样
是 13357625 构建，四天的战斗遥测里只出现过战斗结束的清空帧）自 roster
宽限兜底起已跑 walk 源会话，但同伴侧仍然坐不下这场战斗：probe_arena 的
名册合成读的是 `roster_raw.json`，而该文件只有记录投影会写——这一构建类
整场它都是空的，于是"记录失效 + 不落 arena 文件"的客户端（该构建类同样
不写 `tempArenaInfo.json`，见 2026-10-20 报告）永远注册不了战斗，Tab
监视器的 `battle_known` 恒为假，遥测流再健康 overlay 也从不出现。遥测自
此桥出 walk 的编组成员（`sides`：条码条折叠所渲染的盟/敌名单，含机器人；
walk 收缩时为空列表；缺字段 = 探针版本早于本桥），probe_arena 的合成在
`roster_raw` 不可用时回退到帧内名单——行只靠名字键合（无账号 id、无船
id），relation 0 由帧的 `self.name` 圈定。同时 overlay 窗口的 realm 链
补上最后一环——绑定账号的 realm：walk 源身份为空、安装扫描又叫不出
realm（支持包里 realm=None 的 WGC 形态）时，链条原先死在 null，窗口
URL 里烤进空 realm，整场所有战绩查询都被禁用。

**精确顺序来源（2026-10-18 静态 + 回放探针）**——TAB 行序是客户端
`AvatarSystem` 自己渲染的序列。反编译 `mcb5884c1/m9be68bb6.pyc`
（`__createCollections`）可见它基于 avatar 集合构建 dh 的拆分/排序集合
`byTeams`、`byTeamsSortedAlive`（`sortedAlive`）、`sortedLeftTeam`、
`realPlayers`；unbound UI 通过这些路径读取：
`$datahub.getCollection(CC.avatar).getChildByPath('team.<side>.sortedAlive')`。
这个集合是游戏内唯一的精确顺序——任何排序键重建都无法还原国服 HUD 的
船名序或厂商各自的并列裁决。

当前 WG 构建的 Mods API 到不了它：反编译的
`ModsShell/API_v_1_0/battleGate` 里有一个内部 `getCollection(componentId)`
助手，能返回带 `getChildByPath` 的原始 dh 集合，但它只是模块级赋值，并非
导出 API——注入的 `battle` SafeClass 在 Steam 亚服 15.9.0（build 13357625，
回放探针）上把 `getCollection`/`getCollections`/`getAllPlayers` 都报为
missing，而 `getPlayersInfo`、`getPlayerInfo`、`getSelfPlayerInfo`、
`getAllShips` 可用。注入的 `dataHub` 只按 SYNCED 白名单提供实体列表
（`avatar`、`ship` 等）并把它拍平成 list，拆分树因此丢失。名单记录里的
`prebattleIndex` 不是行序：同一次回放里多数为 0、少数为 1–3（更像预战斗/
分队槽位，而非 HUD 顺序）。15.9 回放里 `children` 集合返回了 33 个实体，
但它们的 `Children.list` 值是 UI 数据树自己的实体 id（197xx），不是名单的
avatar id（798xxx）——这棵树不是队伍行序；`battleInfo`/`battleState` 采到
的字段为空。这些负结果都记在 `order_probe.json` 里。

剩余可行路径，按优先级：

1. **unbound 视图**——直接读上面的集合，按该顺序渲染面板行，或把顺序桥给
   伴生进程。unbound 运行时可派发外部动作（`bindcall externalCall
   'direct.action'` / `inputMapping.onAction`，现成 mod 已在用），但现成
   mod 都不写文件；外部动作能否到达 Python `events` 处理器，是下一步实验。
2. **Flash 桥**——`flashGate` 导出 `call`、
   `addExternalCallback`/`removeExternalCallback`，且注入沙盒里
   `flash.call` 可用。若战斗 HUD 通过 ActionScript 回调暴露渲染行表，
   Python 可直接查询；SWF ABC 面尚未检查。
3. **舰船排序键 + 名单序**（已桥接）——只有客户端规则与重建键一致时才精确；
   国服 HUD 与厂商特有的并列裁决不在其中。
4. **OCR/TAB 截图**——兜底，不是客户端真值。

探针在每次名单稳定后写一次 `order_probe.json`（名单再次稳定会重写）：
API 面、候选集合计数、名单的
`prebattleIndex` 值、被服务容器组件的有限采样（`children` 列表、
`battleInfo`/`battleState` 字段），以及该构建能给出的
`team.<side>.sortedAlive` 顺序。它纯属诊断，排序消费端不读它。

**游戏内面板精确行序（2026-10-18）**——unbound 面板直接读取
`$datahub.getCollection().getChildByPath('team.<side>.sortedAlive')`，
用每个条目的 avatar id 映射到面板行（行数据带 `avatar_id`，并同时下发
`allyById`/`enemyById` 映射）。所用 DSL 构造全部有两家客户端已装视图的
先例：无守卫的集合变量（battle_expert）、`items.length` +
`evAdded`/`evRemoved`、`items[$index].id`，以及数字 id 载荷字典下标
（`toString(id)` + `in` + 三元守卫——BuildViewer 的原样习语）。未配对
的条目渲染**空行位**——精确行各自守住自己的 TAB 行，绝不与回退块交错；
集合缺失则整侧回退 Python 行序。回放既不挂载 unbound 战斗视图也不接受
战斗输入（干净构建实测：常显面板 + 扫描码 Tab、前台已验证，零渲染、零
`tabMode` 事件），视觉验证需要一局真人局。

**CN 排列再校准（2026-10-18，回放自动化）**——多组独立实拍（回放
载入屏自带的队伍名单——载入屏在回放里**会**渲染，是真值面）与离线
`gameTabRowCompare(shipNameOrder)` 预测完全一致：一局**双侧 18/18**、
一局 12v12 全场 **24/24**，且五局志愿者**同队重复船**对局中 **5/5 组
重复对**（两条缅因、三条芒、两条沉舰者、两条基尔萨奇）客户端全部按
**玩家名拼音**裁决并列——与比较器的并列规则逐字一致（g<m、d<n、
l<s、q<s、b<y）。至今全部实拍零失配。据此所有者当日**放开 CN 精确
档**：药丸以**双侧**每行都带客户端真值本地化船名为门，覆盖层的昵称
列裁撤按侧门控——覆盖行全带真值名即评精确，校准排列的输入即渲染
原串。下文截屏侧信道保留为两
家族共用的客户端真值兜底通道。

**透明覆盖层昵称列（2026-10-18）**——当某一侧的行序被游戏确证时，
覆盖层去掉该侧额外的玩家昵称列：WG/Lesta 走排序键整侧覆盖，CN
（2026-10-18 放起）走客户端船名整侧覆盖；部分覆盖或过期流会恢复
昵称列。

**精确顺序路线矩阵（2026-10-18，WG + 国服静态/实测）**——多条路线已
关死，这里记录状态，避免重复走死路：

- **Python Mods API**——两家客户端都关死。反编译的国服
  `ModsShell/API_v_1_0` 与 WG 同构：`dataHub` 只导出
  `getEntityCollections`/`getSingleEntity`（SYNCED 组件列表、拍平——
  拆分树丢失）；`battleGate` 内部的 `getCollection(componentId)` 只是
  模块级助手，非导出 API（国服回放探针：`getCollection`/
  `getCollections`/`getAllPlayers` 两家都 missing）。
- **unbound → Python 反向桥**——两家实测都不通：自定义动作名的
  `bindcall externalCall 'inputMapping.onAction'`/`'direct.action'`、
  直呼回调名的 externalCall、`setUserPref` 载荷通道，都到不了 Python
  的 SFM 事件处理器或已注册的 `flash.addExternalCallback` 回调。Flash
  回调本身注册成功（两参形式），但 unbound 侧没有任何入口能唤起它。
- **unbound 集合读取**——可行（即上文游戏内面板的精确行序）。国服
  unbound 运行时确定支持：国服随包的 battle_expert 视图就在用
  `$datahub.getCollection(CC.xxx).getChildByPath(...)`。回放不挂载战斗
  视图，验证需要一局真人局。
- **名单记录旁侧字段**——`prebattleIndex` 是分队槽位（多数为 0、分队
  成员 1–3），不是行序；国服记录顶层无 `shipName`（嵌套 `shipInfo`
  还差一次下标访问探测）。负结果都记在 `order_probe.json`。
- **读客户端内存**——按红线排除（无注入/无内存读写；AGENTS.md §0）。
- **OCR 渲染出的 TAB 表**——已废弃的像素管线，不再回头。

**截屏侧信道 v1——编码端已落地（2026-10-18），解码端下一步。**
覆盖层本来就会截屏取表格外几何；unbound 视图现在按侧渲染一条小
条码带，各行跟随客户端自己的 sortedAlive 顺序（与面板同一 byId
配对），每行编码该玩家在遥测已发布的 rosterOrder 中的名次。固定
几何二值色块的解码无需 OCR，在所有客户端（含国服）上精确归位每一
行 TAB，且只用官方 API。冻结契约（两侧都按这些数字实现——改动即
双方协同升版）：

- 条码几何：色块 6×6 px、水平间距 2、垂直间距 3、背景衬 4 px、
  距屏边 24 px——盟友条锚左上、敌条锚右上（`left = stageW - 24 -
  70`）；条宽 70 px。背景 `0xFF101010`、1 位 `0xFFF2F2F2`、
  0 位 `0xFF303030`。
- 第 0 行为同步头 `1,0,1,0,1,0,1,1`（定位+定向）；数据行为
  `[1,0] 同步 + 5 位名次（MSB 在前）+ 偶校验位`（校验位：五位中
  1 的个数为偶时点亮）。比特由 Python 算好以布尔随面板载荷下发
  （`bits`），DSL 只渲染三元表达式。无名次的行（记录从未携带的
  名字）不渲染任何字——解码端绝不猜测。
- 模式门控：载荷的 `panel`/`barcode` 旗标来自探针 wowsp.toml 同名
  键；活动模式的消费者在启动时声明（游戏内桥接 → panel=1/
  barcode=0，覆盖层监视 → panel=0/barcode=1，每个游戏会话一次），
  探针每局战斗开始时重读该表——两种显示绝不共屏，overlay 模式下
  `--` 统计表保持熄灭。
- 行 id：byId 键为实体遍历锁存的 avatar 实体 id（粘性、含 bot）——
  与集合条目同一 id 空间；名单记录的 avatarId 字段是另一个 id，
  仅作回退。
- 解码端（Rust 侧，下一个 PR）：在左走廊（x 8..120、y 8..600、步长
  2）按 8 px 格距找盟友条同步头，在镜像的右走廊（x stageW-120..
  stageW-8）找敌条；每行采样 8 个色块中心、亮度阈值 140、
  校验同步位与奇偶；某侧条码带第 k 行 ↔ 该侧 TAB 列第 k 行；名次
  → 名字经遥测 rosterOrder。任一失败整侧丢弃（保持现有顺序推断）。
  合成证明（500 组随机排列 + 边界用例、随机偏移、噪声背景、0.4 px
  模糊）已按本契约完整往返。

**编码器加固（2026-10-09，WG 亚服 15.9.0 实测）**：客户端自带的
`utils.jsonEncode` 同样被证明随构建不稳——15.9 对 15.8 曾接受的普通字典
载荷直接抛异常，WG 亚服的 telemetry.json 冻结在退出清空态，而
heartbeat/request 一切正常（探针本身活着：按键事件、记录、日志全都在）。
现在所有桥接写入都经 `json_encode_safe`——先走客户端编码器，失败则退到
手写的 ASCII 安全序列化器（沙箱场景 `plain=reject`）——任何编码器怪癖都
再也压不住遥测。

**遥测兜底（2026-10-18）**：1 s 遥测写入器现在会标注失败阶段
（`telemetry failed@<stage>`），并统一经 `_bridge_write` 写 UTF-8 字节
（py2 文本模式会把 unicode 体按 ASCII 编码；二进制打开被拒时回退文本
模式）。若某个辅助阶段仍抛异常，写入器会写出实际收集到的内容——名单
循环完整时的存活表 + 客户端排序键——名单循环未完成时省略 `players`，
既不让旧文件冻结，也不会误报“全员存活”。

**国服分叉**（360 build 13243917，2026-10-07 实拍）：国服客户端的 TAB
表格**不重排**——沉没行留在开局原位、就地变暗（实测 5 名阵亡者的行与存活
行交错），且同（舰种, 等级）组内按**本地化船名**（拼音序）排列，而非反编译
出的国籍序（见 utils/shipClass）。**直播面**（透明覆盖层的映射与 /live
面板的预测顺序）对两者均以 `realm == "cn"` 门控（overlay/main.ts
的 cnLayout 静态布局 + 船名序）；录像回放视图与全息名单**有意**保留 WG 规则
（其场景没有 CN 实拍证据），插件自身的面板也仍用竞技场规则合并——仅为
观感差异。2026-10-12 起，探针记录
里的 shipName 原串（遥测 `shipNames`）在整侧覆盖时替换该排列的 DB 名段
（见上文"排序原料桥"）。

## 沙盒约束（来之不易，写进 mod 的风格守则）

- 运行时是 **Python 2.7**；语法保持保守（不用 f-string；现有探针刻意
  2/3 双兼容）。
- `open()` **没有追加模式**（'a' 返回 None 而非抛异常）：用内存缓冲
  整文件重写。
- 文件不存在时引擎会先记一条错误日志再抛异常：每个被轮询的邮箱文件
  都要在加载时播种一次（见 `manual_refresh.flag` 的播种）。
- 回调里逃逸的异常会静默杀死 mod：全部包裹，重复错误去重后再记日志。
- 注入模块的 `dir()` 返回 `[]`（SafeClass 包装）：API 面只有上文
  已验证名单。
- 加载器有两条通道：我们使用的经典免签名 PnFMods 1.0，以及带 WG
  签名校验的 "ModsAPI 2.0"（ModStation 级签名 mod）。免签名社区 mod
  共存无碍；第三方整合包的签名失败与本项目无关。

## 架构

```
┌─ 游戏客户端（Mods API 沙盒，无网络）─────────────────────┐
│ PnFMods/WoWSPStats/Main.py                               │
│  · 名单轮询（1 s，稳定确认）→ request.json               │
│  · 实体遍历 → 遥测（hp/relation/alive）                  │
│  · SFM 事件 → tabMode 标记、生命周期标记                  │
│  · heartbeat.json（port/battle 相位，1–2 s）             │
└──────────────┬────────────────────────────────────────────┘
               │ mod 自身目录下的平铺 JSON 文件
┌──────────────┴────────────────────────────────────────────┐
│ WoWSP 应用（Rust，沿用现有进程）                          │
│  · 桥读写器（接替实验探针的伴生角色；即第三方参考插件     │
│    确立的 request/response 协议）                        │
│  · 排序引擎：载具序 + 阵亡下沉                            │
│  · overlay_config 的 roster "plugin" 模式                │
│  · 健康检查：解析 profile/python.log 中 mod 的           │
│    加载/自检行（api[load] dh=True …）                    │
└───────────────────────────────────────────────────────────┘
```

桥文件（协议 v1，全部位于 mod 目录）：

```jsonc
// request.json —— 名单稳定后由 mod 写出（手动刷新时重写）。
// 伴生侧回填战绩行。
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json —— WoWSP 写出；revision 需按会话单调递增；
// 空文件（无结尾换行）表示"处理中"。
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json —— 每 1–2 s 重写；过期 = mod 死亡或游戏已关。
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3, "rec": 18, "fb": "" | "records" | "walk" }

// `rec`（本拍 records 数）与 `fb`（会话的兜底来源）是 2026-10-18/19 现场
// 报告（Steam 13357625 + 国服 13357822）之后加入的名单降级诊断：这两个
// 构建上名单整场不稳定 —— battle.getPlayersInfo() 一直返回空或每拍变化
// —— 遥测会话门槛因此整场关闭，telemetry.json 只在战斗结束的清场写中
// 出现。探针现在在 5 拍战斗宽限后合成会话：优先用最后一次非空的
// records 尝试（fb: "records"，身份桥保留），否则用实体行走
// （fb: "walk"，仅名字/存活/阵营，身份桥为空、由伴生进程按自己的
// realm 路由兜底）。伴生进程每场将标记记录一次，作为“已降级但已桥接”
// 的证据行，区别于遥测彻底缺失的硬告警。

// 遥测 journal —— 有界按局环形缓冲的整文件重写；
// 每个独立状态与事件标记在同一时间线上：
{ "t": 1690000000000, "players": { "<avatarId>": { /* 投影 */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag —— WoWSP 写入新鲜的时间戳触发重新查询；
// mod 在 10 s 窗口内消费。
```

## 准心瞄准浮窗

瞄准浮窗（2026-10-18）在准心正下方一段可配置的距离上悬浮显示被瞄准
玩家的基本战绩，与 Tab 表同属游戏内渲染，但**不随 Tab 显隐**——瞄准
和按 Tab 是两个时刻，unbound 根节点因此把它放在 Tab 可见块之外。

**检测契约（build 13357625 反编译实证）。** 客户端自己的世界船标就是
遍历探针所走的同一个 `CC.avatar` 集合
（`gui/unbound2/pc/battle/markers/base_marker.unbound`：avatar 的
renderer 即 `WorldShipMarker`），而每个 marker 上的锁定图标点亮条件是
`targetComponent.flags & LOCKABLE_WEAPONS`
（`markers/ship_marker.unbound` 的 GET_MARKER_ENTITY_COMPONENT
'target'；掩码冻结在 `shared/constants.unbound`，位集
{0,1,2,6,7,8,10,12,13} = `0x35C7`，基于 WEAPON_* 枚举）。因此"本机玩
家正在瞄准谁"由引擎计算、权威可读：target 组件携带任一锁定位的
avatar 实体。探针每 tick 在同一次实体遍历里读取（`aim_flags_of`）：
cc 路径 `entity[UiComponents.target].flags`，cc 属性被扣留时回退到
components 映射的鸭子类型探测（有 `.flags` 且无 `.reasons` —— CanHit
两者都有）。多目标同时锁定时（炮瞄 A、雷锁 B）主炮位（0-2 =
UNKNOWN/MAIN_AP/MAIN_HE）优先，否则取首个锁定命中。掩码常量即
Main.py 的 `AIM_LOCKABLE`/`AIM_MAIN_BITS`；改动即对客户端的规格升
级，与条码几何同规。

**判定出口。** 锁存进 telemetry（每战斗 tick 的
`aim: {name, flags}`，空名 = 无目标——回放/实机监听读这里）、
python.log（每次切换一行 `aim <name> flags=<n>`）与面板 payload
（下述 `aim` 块）。

**面板 payload（aim_block，全部呈现逻辑在 Python 侧）。**

```jsonc
{ "aim": { "on": true, "name": "Foe03", "ship": "岛风",
           "offset": 120,
           "vals": [ { "t": "52.5%", "c": 0xFFFFEE66, "label": "胜率" },
                     { "t": "1234",  "c": 0xFFFFEE66, "label": "PR" } ] } }
```

`offset` 为 wowsp.toml 的 `aim_offset`（准心在所有炮击视角下都位于舞
台中心，故以中心为锚下移）；`aim = 0` 隐藏浮窗；伴生侧**显式**回空列
表（用户删光卡片）同样隐藏，而从未下发过列的旧伴生保持仅名字/船名
的降级浮窗。

**列管线。** 列编辑与水表同一拖拽卡片编辑器
（`OverlayColumnsEditor`，游戏内设置区的第二个实例），以 stats prefs
的 `aimColumns` 持久化（上限 4，v1 仅 "global" scope——桥只做一次名单
查询；单船/船类 scope 需要 webui 的整船列表管线，明确不进本期）。
**主窗口**的 overlay 生命周期在桥启动与每次偏好变化时推送
（`set_ingame_bridge_aim([{scope, metric, label}])`，label 由 webui
预本地化），`response.json` 相应扩展：

```jsonc
"aimCols": [ { "scope": "global", "metric": "winrate", "label": "胜率" } ],
"rows": [ { ..., "aim": [ 52.3 ] } ]   // 与 aimCols 对齐；null = 无数据
```

伴生侧首次收到列之前 `aimCols` 整体缺省（对旧探针字节兼容）；显式空
列表仍会写出（即上述隐藏门）。

**回放注意。** 回放不挂载战斗 HUD 视图，浮窗本身无法在回放中目视验
证——但 Python 遍历照常运行（order-probe 同证据类），判定因此走
telemetry：回放播放是实时观察瞄准切换的受权途径（2026-10-18 矩阵：
Steam 客户端自带的 15.9.0 录像 + build 匹配的国服 360 志愿者录像）。

## Rust 集成点（精确到文件）

| 关注点 | 文件（无标注即现有） | 变更 |
| --- | --- | --- |
| 桥文件监听 | `commands/arena_info.rs` 的姊妹篇：新增 `commands/ingame_bridge.rs` | `notify` 监听 mod 目录；解析心跳/请求/journal；发出 `wowsp://ingame-*` Tauri 事件 |
| 排序引擎 | `packages/webui/src/features/replay/liveTabOrder.ts` + `packages/webui/src/overlay/inferredOrder.ts`，Lesta 阵容合成在 `commands/probe_roster.rs` | 桥事件驱动的"载具序 + 阵亡下沉"归约器；输出覆盖层渲染的最终行序 |
| 配置 schema | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster` 新增 `"plugin"`（优先级 `plugin > inferred > ocr > off`） |
| 覆盖层按键门控 | `overlay/placement.rs`（`tab_key_down`） | 桥存活时改用 `input.tabModeIn/Out` 标记驱动显示/隐藏，替代 `GetAsyncKeyState` 轮询 |
| 安装/卸载 | `commands/mod_install.rs` + `packages/ingame-plugin/`（新子包） | 模板指向子包 `Main.py`；快照 + 回滚；游戏关闭守卫；旧探针清理 |
| 健康检查 | `commands/ingame_bridge.rs` | 解析 `profile/python.log` 中的 `probe … loaded` / `api[load] dh=True` 自检行；供设置界面展示 |
| 战绩行 | 现有 `wg_api.rs` / `wg_api_cn.rs` | 不变——伴生侧用覆盖层现有的批量查询写 `response.json` |

## 产品整合

1. **开关即自动安装**：设置里启用游戏内排序源后，经现有
   `mod_install.rs` / `packages/ingame-plugin` 路径写入 mod
   （`PnFModsLoader.py` 标记仅在缺失时创建；只碰自有文件；快照 +
   回滚；游戏关闭守卫）。关闭即卸载。即所有者指定的"特殊"注册形态：
   插件永远不作为手动安装步骤出现。
2. **自家仓库 Discussions 注册**：在 `langyo/wowsp/discussions` 发布
   模板化资源帖，并在 `mod-index.json` 条目中引用（`category`、
   `discussion`、`versions[].game` 兼容性），让 Mod Hub 也能像对待
   其它 mod 一样列出/校验它——第一方出处，同一套目录机制
   （mod-hub.md 缺口 G8 的授权模型）。
3. **回退链**：遥测缺失/过期（心跳超时 N 秒、`api[load] dh=False`、
   游戏更新后 mod 失效）→ 静默回退到现有推断管线。覆盖层的可用性
   永不依赖 mod。

## 风险与维护

- **WG API 演进**是唯一耦合（无 unbound、无原版元素复制）。Mods API
  v1.0 面自 13.x 至 15.8 保持稳定；探针的自检行让失效显式可诊。
- **国服客户端**：已验证可用；360 客户端原生运行同一 Mods API 加载器
  （日志自会扫描 `PnFModsLoader.py`）。每个大版本留意国服反作弊政策。
- **性能**：1 s 轮询 `getPlayersInfo` + 实体遍历远在预算内（TeamHP 类
  mod 逐帧遍历）；绝不为这些数据使用 `callbacks.perTick`。
- **Journal 增长**：按局有界环形；如对战后分析有用可随回放归档。

## 测试计划

- **沙盒合规**：每次 `Main.py` 变更都对照约束清单校验（py2.7 语法、
  无被禁 builtins、无追加模式、回调全包裹）；2026-10-10 起另有四个舰船
  pass 以植入舰船实体驱动游戏真值排序键路径（WG 形态断言完整键表与面板折
  叠的稳定键排序、UiComponents 抛异的 Lesta 形态、未配对侧保持遍历序
  的部分覆盖形态、以及键表必须存活的 15.9 编码器怪癖）——它们回答不了的
  实弹对局问题（真实 Lesta 沙箱对 'ship' 集合到底给什么）已于当日
  2026-10-10 定案：完整键表，含 bot 共 11/11。另加 `python -m py_compile`。
- **仅港口冒烟测试**（不打战斗）：启动游戏、港口停 ~15 s、退出；断言
  `python.log` 出现 `injected names=[…]`、`api[load] dh=True` 与新鲜
  心跳。这套廉价协议是实验阶段的验收流程，保留为安装验收测试。
- **战斗夹具**：每服一局人机；断言 journal 含名单快照、≥1 次击沉驱动的
  `alive` 翻转、tabMode 标记，且 `python.log` 的 `typeDeath` 行与翻转
  1:1 对应。
- **回退演练**：停掉应用（无伴生）断言 mod 180 s 超时恢复且下一局照常
  请求；破坏 mod 目录断言覆盖层静默回退到推断。

## 交付计划

- **M1** —— 产品化：把探针的探测电池收进调试开关；冻结桥协议；Rust
  桥 + 排序引擎 + 接入覆盖层 store 的 `roster = "plugin"` 模式。
- **M2** —— 设置开关、自动安装/卸载、python.log 健康检查、过期回退
  逻辑。
- **M3** —— Discussions 注册、目录条目、更新通道（模板随应用发版走；
  mod 文件本身很少变动）。
