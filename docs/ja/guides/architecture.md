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

## サーバーサイド

WoWSP はデスクトップアプリにとどまらない。`wowsp.langyo.xyz`（公式ノード）と任意のセルフホストノードが合わさって小さなサーバーサイドを構成し、3 つの形態はいずれも単一のポリシーコア（`packages/pairing-relay/crates/relay-core`）を共有する：

| 形態 | パッケージ | 機能 |
|---|---|---|
| Cloudflare Worker（公式 + ウィザードによるセルフホスト） | `crates/relay-worker`（Rust→wasm） | すべて |
| ネイティブバイナリ（VPS / LAN / Docker） | `crates/relay-server`（axum + SQLite） | すべて |
| Vercel エッジアダプター | `packages/relay-vercel`（TypeScript） | lookup + peers + blocks |

各ノードは 2 つの名前空間を公開する：

- **バトルプッシュ**（`/gateway/*`、WebSocket）— スマートフォンのライブ戦績チャネル。`designs/gateway-push.md` を参照。
- **キャッシュメッシュ**（`/api/lookup`、`/api/blocks`、`/api/peers`）— 公開戦績アップストリーム（vortex/WG/クラン、13 ホストの許可リスト）へのキャッシュプロキシに、コンテンツアドレス方式のブロックストア（CIDv1、`/ipfs/<cid>` ゲートウェイエイリアス付き）とブロードキャスト型 peer レジストリを加えたもので、あるプレイヤーの遅いコールドルックアップが全員のキャッシュヒットになる。`designs/cache-mesh.md` を参照（クライアント報告型結果のロードマップは `designs/cache-mesh-trust.md`）。

クライアント側では、すべての戦績リクエストがまず設定済みのキャッシュサーバー（設定 ▸ 接続 ▸ キャッシュサーバー — デフォルトは公式ノード + メッシュの peer リスト由来のコミュニティノード）を経由し、その後は従来どおりのプロキシ → 直接のチェーンへフォールバックする。ノードをセルフホストすることも正式にサポートされており、手順は `guides/self-host-gateway.md` にまとめられている。

## Provenance

The replay-parsing, game-detection, and `tempArenaInfo.json` polling principles
are adapted from [ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar). The
frontend shell, build infrastructure, and licensing model are adapted from
[shittim-chest](https://github.com/celestia-island/shittim-chest).
