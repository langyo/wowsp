# Architecture

> **Audience**: Developers who need to understand how WoWSP works internally.

## Two operating modes

WoWSP is a single Tauri 2 desktop app with one frontend (Vue 3 + three.js) that
runs in two modes, sharing most of the Rust backend.

### Mode 1 — Standalone review

Open a `.wowsreplay` and watch the whole match rendered on a holographic 3D map,
without launching the game.

```mermaid
flowchart TD
    A[".wowsreplay file"] --> B["Rust: parse 8-byte magic + JSON descriptor block (commands/replay/)"]
    B --> C["Rust: decode packet stream → per-entity event timeline (commands/packets/)"]
    C --> D["webui: three.js holographic map scrubs the timeline (features/holographic)"]
```

Map and ship geometry come from GLB produced by `scripts/model_convert/`
(`convert_map.py`, `convert_ship.py`), which pull the source assets straight
from the detected game install (`just convert-map --name ...` /
`just convert-ship --name ...`) — no app change needed for new maps or ships.

### Mode 2 — In-game overlay

WoWSP runs alongside the game: while the game runs and the in-game overlay
setting is on, a transparent always-on-top window overlays both teams'
rosters, visible only while `Tab` is held. The first-party probe mod installed
into `res_mods/` bridges live battle data to it (see
`designs/ingame-stats-plugin.md`).

```mermaid
flowchart TD
    A["game starts"] --> B["WoWSP creates the transparent overlay window while the game runs"]
    B --> C["Rust: poll &lt;game&gt;/replays/tempArenaInfo.json for live roster (commands/arena_info.rs)"]
    C --> D["user holds Tab"]
    D --> E["Rust: capture game window + detect team-list region (commands/overlay/)"]
    E --> F["webui: re-anchor rendered roster to detected rect (features/overlay)"]
    F --> G["user releases Tab → overlay hides"]
```

## Game-install detection

`commands/game_detect.rs` scans the Windows Uninstall registry for Wargaming /
Lesta / 360 publishers (mirroring ApeRadar's `ConfigWindow.AutoDetectGamePath`),
then additionally walks Steam library folders for `appmanifest_552990.acf`
(Steam appid 552990 = World of Warships) — the case ApeRadar misses — and
reads Lesta Game Center's own game index under `%ProgramData%\Lesta\GameCenter`
(preferences.xml `<working_dir>` entries + `apps\<game-id>\<hash>` path
files). The Lesta (Мир кораблей) client renamed its root stub to
`Korabli.exe`, so install-folder validation accepts either stub name and the
running-process watcher tracks `Korabli(.64).exe` as well. A manual path can
always be pinned.

## Replay file format

```text
4 bytes  magic       = {0x12, 0x32, 0x34, 0x11}
4 bytes  json_len    = little-endian u32
N bytes  json_block  = match descriptor (roster, map, match type)
4 bytes  meta_count  = u32, number of metadata blocks
...      metadata    = extra metadata blocks
...      packets     = encrypted/zlib packet stream
```

The Lesta (Мир кораблей) client renamed the container to `.korablireplay` and
switched to a different binary framing — those files are listed and imported
but header/packet parsing reports an explicit unsupported-format error until
the new layout is reverse-engineered. `tempArenaInfo.json`, the live-battle
arena descriptor, keeps its WG name and format.

`commands/replay/` implements the magic check + JSON block extraction; the
packet-stream decoder lives in `commands/packets/` (frames → payloads →
per-entity events, with per-version method tables) and feeds the event
timeline the holographic map scrubs.

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Vue 3 (TSX) + UnoCSS + co-located SCSS + Pinia + vue-i18n + three.js |
| Desktop shell | Tauri 2 (Rust) |
| Backend IPC | `#[tauri::command]` handlers in `packages/app/tauri/src/commands/` |
| Mock backend | FastAPI (`scripts/mock/`) for browser/e2e development |
| Build | Cargo + pnpm workspace, `just` recipes, Python tooling |
| Docs | lagrange multilingual site |

## 伺服器端

WoWSP 不只是桌面應用程式：`wowsp.langyo.xyz`（官方節點）加上任意自架節點，共同構成一個規模不大的伺服器端；三種形態共用同一份原則核心（`packages/pairing-relay/crates/relay-core`）：

| 形態 | 套件 | 能力 |
|---|---|---|
| Cloudflare Worker（官方 + 精靈自架） | `crates/relay-worker`（Rust→wasm） | 全部 |
| 原生二進位檔（VPS / 區域網路 / Docker） | `crates/relay-server`（axum + SQLite） | 全部 |
| Vercel 邊緣配接器 | `packages/relay-vercel`（TypeScript） | 查詢 + peers + 區塊 |

每個節點都會公開兩套命名空間：

- **戰鬥推送**（`/gateway/*`、WebSocket）— 手機的即時戰績通道；見 `designs/gateway-push.md`。
- **快取網格**（`/api/lookup`、`/api/blocks`、`/api/peers`）— 公開戰績上游（vortex/WG/軍團，13 主機白名單）的快取代理，加上內容定址的區塊儲存（CIDv1，附 `/ipfs/<cid>` 閘道別名）與廣播式 peer 登錄表，讓一位玩家的遲緩冷查詢變成所有人的快取命中。見 `designs/cache-mesh.md`（用戶端回報結果的路線圖見 `designs/cache-mesh-trust.md`）。

在用戶端，每個戰績請求都先走已設定的快取伺服器（設定 ▸ 連線 ▸ 快取伺服器 — 預設為官方節點，加上來自網格 peer 清單的社群節點），之後才回落到原有的代理 → 直連鏈。自架節點也是受支援、有文件可循的路徑：`guides/self-host-gateway.md`。

## Provenance

The replay-parsing, game-detection, and `tempArenaInfo.json` polling principles
are adapted from [ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar). The
frontend shell, build infrastructure, and licensing model are adapted from
[shittim-chest](https://github.com/celestia-island/shittim-chest).
