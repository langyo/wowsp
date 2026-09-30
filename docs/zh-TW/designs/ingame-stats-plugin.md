# 遊戲內戰績插件——精確遙測設計

> **狀態**：實驗已收尾（2026-09-28），可進入實作。
> 覆蓋層的伴生文件：顯示層仍由透明視窗承擔；本插件是遊戲內的
> 資料源，讓覆蓋層的排序在任何環境（含獨佔全螢幕）下都精確。

## 背景與目標

現有即時戰鬥覆蓋層靠螢幕擷取推斷 TAB 隊伍表格的幾何位置
（`overlay/capture.rs`、`overlay_detect.rs`），並以 30 ms 間隔輪詢
`GetAsyncKeyState(VK_TAB)`。這套方案可用，但：

- 螢幕擷取是最脆弱的一層（DRM／擷取排除、HDR、多 DPI、視窗化與
  全螢幕的種種差異）；
- 按鍵輪詢無法區分「按住 Tab」與「在戰鬥聊天中輸入 Tab」；
- 行序是由靜態名單加擊沉啟發式推斷出來的。

一個跑在 Wargaming 官方 **Mods API**（PnFMods 通道，無注入、無記憶體
寫入）上的遊戲內 mod 可以從用戶端內部觀察戰鬥狀態，經檔案橋接交給
WoWSP。該 mod **不渲染任何內容**——透明覆蓋層仍是顯示層——因此完全
不承擔曾讓早期「遊戲內渲染」構想夭折的逐遊戲版本 UI 維護成本。

目標：把「mod 遙測 > 螢幕擷取推斷 > 靜態順序」作為覆蓋層資料的優先
順序鏈，並在 `overlay_config.toml` 的 roster 模式中新增 `"plugin"` 值。

## 實驗證明的事實

已在 Steam 亞服 15.8.0（build 13187581）與 360 國服 15.8.1（build
13243917）上驗證，各數局；探針產物位於
`packages/ingame-plugin/src/Main.py`（自報版本恆為 `0.1.0`；
疊代只存在於 git 歷史）：

| 能力 | 機制 | 時延 / 備註 |
| --- | --- | --- |
| mod 載入（雙服） | `res_mods/<bin>/PnFModsLoader.py`（0 位元組標記）+ `PnFMods/<Mod>/Main.py`，`API_VERSION = 'API_v1.0'` | 與 Aslain 的 mod 共存 |
| 注入的 API 模組 | `events, ui, utils, battle, callbacks, dataHub, constants` 是載入器注入的全域變數；對它們 `import` 會失敗（白名單制），絕不可遮蔽它們 | builtins 同樣設有白名單：無 `globals()`/`eval` |
| 名單與身分 | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm | 記錄是 `SafeClass`：下標可用，dict 協定不可用；載入早期需防禦性疊代（容器短暫為非 dict） |
| 擊沉歸因 | `isAlive` 翻轉，以 1 s 間隔輪詢 | 與遊戲自身的 `typeDeath` 日誌行 1:1 對照驗證，≤1 s 滯後，橫跨 4 局 |
| 即時血量與點亮 | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]`（`.value/.max/.isAlive`）、`entity[CC.relation]` | 敵方血量在被點亮前恆為 0/0——與遊戲自身表格同等的戰爭迷霧；0→實值的跳變本身就是一次點亮事件 |
| TAB 畫面狀態 | SFM 事件 `input.tabModeIn` / `input.tabModeOut` | 按鍵後 ≤3 ms 觸發；在聊天中輸入 Tab **不**觸發——直接消滅這一整類誤報 |
| 名單變動 | `events.onPlayersListUpdated` | 一局內 14 次事件 |
| 戰鬥生命週期 | `sfm.battleLoadingStarted`、`request.showBattle`、`onBattleStart`、`up.exitBattle`、`window.hide(Battle)` | 比 tempArenaInfo 檔案的出現/移除更細粒度 |

**不可用**（也不需要）：avatar 實體上不存在每玩家的 score/XP 元件，
且 unbound 端的
`$datahub.getCollection().getChildByPath('team.ally.sortedAlive')` 路徑
在 Python 端沒有對應（注入的 dataHub 上沒有 `getCollection`）。

**排序規則**（經所有者經驗確認；與集合名 `sortedAlive` 吻合）：TAB
表格保持初始順序，僅把沉沒玩家移入尾端的「陣亡」分組。因此：

```
覆蓋層順序 = arena 載具序（tempArenaInfo —— 已解析）
                並將 isAlive=false 的玩家按沉沒順序重新附加到末尾
```

是**精確**複刻，而非近似。

## 沙盒約束（得來不易，寫進 mod 的風格守則）

- Python 是 **2.7**；語法保持保守（不用 f-string；現有探針刻意維持
  2/3 雙相容）。
- `open()` **沒有追加模式**（'a' 回傳 None 而非拋出例外）：以記憶體
  緩衝整檔重寫。
- 檔案缺失時引擎會先記一條錯誤日誌再拋出例外：每個被輪詢的信箱
  檔案都要在載入時播種一次（見 `manual_refresh.flag` 的播種）。
- 從回呼逃逸的例外會讓 mod 靜默死亡：全部包裹，重複錯誤先去重
  再記日誌。
- 注入模組的 `dir()` 回傳 `[]`（SafeClass 包裝）：API 面只有上文
  已驗證的名字清單。
- 載入器有兩條通道：我們使用的經典免簽 PnFMods 1.0 路徑，以及帶
  WG 簽章驗證的「ModsAPI 2.0」（ModStation 級簽章 mod）。免簽的
  社群 mod 共存無礙；第三方整合包的簽章失敗與我們無關。

## 架構

```
┌─ 遊戲用戶端（Mods API 沙盒，無網路）─────────────────────┐
│ PnFMods/WoWSPStats/Main.py                               │
│  · 名單輪詢（1 s，穩定確認）→ request.json               │
│  · 實體遍歷 → 遙測（hp/relation/alive）                  │
│  · SFM 事件 → tabMode 標記、生命週期標記                 │
│  · heartbeat.json（port/battle 相位，1–2 s）             │
└──────────────┬────────────────────────────────────────────┘
               │ mod 自身目錄下的平鋪 JSON 檔案
┌──────────────┴────────────────────────────────────────────┐
│ WoWSP 應用程式（Rust，沿用現有程序）                      │
│  · 橋接讀寫器（接替實驗探針的伴生角色；即第三方參考插件   │
│    確立的 request/response 協定）                         │
│  · 排序引擎：載具序 + 陣亡下沉                            │
│  · overlay_config 的 roster "plugin" 模式                 │
│  · 健康檢查：解析 profile/python.log 中 mod 的            │
│    載入/自檢行（api[load] dh=True …）                     │
└───────────────────────────────────────────────────────────┘
```

橋接檔案（協定 v1，全部位於 mod 目錄）：

```jsonc
// request.json —— 名單穩定後由 mod 寫出（手動刷新時重寫）。
// 伴生側回填戰績行。
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json —— 由 WoWSP 寫出；revision 須按工作階段單調遞增；
// 空檔案（無結尾換行）表示「處理中」。
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json —— 每 1–2 s 重寫一次；過期 = mod 已死或遊戲已關閉。
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3 }

// 遙測 journal —— 對逐局有界的環形緩衝做整檔重寫；
// 每個獨立狀態加上事件標記共用同一條時間線：
{ "t": 1690000000000, "players": { "<avatarId>": { /* 投影 */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag —— WoWSP 寫入新的 epoch-seconds 時間戳以觸發重新
// 查詢；mod 在 10 s 時間窗內消費。
```

## 產品整合

1. **開關即自動安裝**：在設定中啟用遊戲內排序來源後，經由現有的
   `mod_install.rs` / `mod_templates` 路徑寫入 mod（`PnFModsLoader.py`
   標記僅在缺失時建立；只碰自有檔案；快照 + 回滾；遊戲關閉守衛）。
   停用即解除安裝。這就是所有者指定的「特殊」註冊行為：插件永遠
   不會以手動安裝步驟的形式出現。
2. **自家儲存庫 Discussions 註冊**：在 `langyo/wowsp/discussions`
   發布模板化的資源帖，並由 `mod-index.json` 條目引用（`category`、
   `discussion`、`versions[].game` 相容性），讓 Mod Hub 也能像對待
   其他 mod 一樣列出/驗證它——第一方出處、同一套目錄機制
   （mod-hub.md 缺口 G8 的同意模型）。
3. **回退鏈**：遙測缺失/過期（心跳超過 N 秒未更新、
   `api[load] dh=False`、遊戲更新導致 mod 失效）→ 靜默回退到現有
   的推斷管線。覆蓋層的運作永不依賴 mod。

## 風險與維護

- **WG API 漂移**如今是唯一的耦合（無 unbound、無原版元素複製）。
  Mods API v1.0 介面自 13.x 至 15.8 保持穩定；探針的自檢行讓失效
  顯著且易於診斷。
- **國服用戶端**：已驗證可用；360 用戶端執行同一套 Mods API 載入器
  （其日誌原生就會掃描 `PnFModsLoader.py`）。每個大版本都要留意
  國服反作弊政策的變化。
- **效能**：1 s 輪詢 `getPlayersInfo` + 實體遍歷遠在預算之內（TeamHP
  類的 mod 逐幀遍歷實體）；絕不為此使用 `callbacks.perTick`。
- **Journal 增長**：逐局有界環形；若對戰後分析有用，可將片段隨回放
  一併交付。

## Rust 整合點（精確到檔案）

| 關注點 | 檔案（無標註即為現有） | 變更 |
| --- | --- | --- |
| 橋接檔案監看器 | `commands/arena_info.rs` 的姊妹檔：新增 `commands/ingame_bridge.rs` | 以 `notify` 監看 mod 目錄；解析 heartbeat/request/journal；發出 Tauri 事件 `wowsp://ingame-*` |
| 排序引擎 | 新模組 `overlay/order_source.rs` | 由橋接事件餵入的「載具序 + 陣亡下沉」歸約器；輸出覆蓋層渲染的最終行序 |
| 設定 schema | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster` 新增 `"plugin"`（優先順序鏈 `plugin > inferred > ocr > off`） |
| 覆蓋層按鍵門控 | `overlay/placement.rs`（`tab_key_down`） | 橋接存活時，改由 `input.tabModeIn/Out` 標記驅動顯示/隱藏，取代 `GetAsyncKeyState` 輪詢 |
| 安裝/解除安裝 | `commands/mod_install.rs` + `packages/ingame-plugin/`（新子套件） | 模板改為該子套件的 `Main.py`；快照 + 回滾；遊戲關閉守衛；舊探針清理 |
| 健康檢查 | `commands/ingame_bridge.rs` | 解析 `profile/python.log` 中 mod 的 `probe … loaded` / `api[load] dh=True` 自檢行；向設定 UI 公開狀態 |
| 戰績行 | 現有 `wg_api.rs` / `wg_api_cn.rs` | 不變——伴生側以覆蓋層目前所用的同一套批次查詢寫出 `response.json` |

## 測試計畫

- **沙盒合規**：每次交付的 `Main.py` 變更都對照約束清單驗證（py2.7
  語法解析、無被禁的 builtins、無追加模式的 open、回呼皆有包裹），
  外加 `python -m py_compile`。
- **僅港口冒煙測試**（不打戰鬥）：啟動遊戲、在港口停留約 15 s、退出；
  斷言 `python.log` 出現 `injected names=[…]`、`api[load] dh=True`
  與新鮮的心跳。這套廉價協定讓實驗保持誠實——保留它作為安裝的
  驗收測試。
- **戰鬥夾具**：每個伺服器一場人機局；斷言 journal 含有名單快照、
  ≥1 次擊沉驅動的 `alive` 翻轉、tabMode 標記，且 `python.log` 中的
  `typeDeath` 行與翻轉 1:1 對應。
- **回退演練**：停掉應用程式（沒有伴生側），斷言 mod 的 180 s busy
  逾時會恢復且下一局照常發出請求；破壞 mod 目錄，斷言覆蓋層靜默
  回退到推斷。

## 交付計畫

- **M1** —— 產品化：把探針的整套探測測試剝離到除錯旗標之後；凍結
  橋接協定；Rust 橋接 + 排序引擎 + 接入覆蓋層 store 的
  `roster = "plugin"` 模式。
- **M2** —— 設定開關、自動安裝/解除安裝、python.log 健康檢查、
  過期回退邏輯。
- **M3** —— Discussions 註冊、目錄條目、更新通道（模板版本隨應用
  程式發佈；mod 檔案本身極少變動）。
