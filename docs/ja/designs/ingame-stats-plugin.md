# ゲーム内戦績プラグイン —— 高精度テレメトリ設計

> **ステータス**: 実験は終了（2026-09-28）。実装可能な状態。
> オーバーレイ設計の関連文書: 表示レイヤは引き続き透過ウィンドウが担い、
> 本プラグインはゲーム内のデータソースとして、排他的フルスクリーンを含む
> あらゆる環境でオーバーレイの生存/撃沈状態を正確に保つ。TAB の行順は、
> プローブがゲーム自身の順序をエンジン内で読み取れるようになるまで、
> クライアントごとに校正された推定のまま —— 下記の並び順の規則を参照。

## 背景と目標

現在のリアルタイム戦闘オーバーレイは、画面キャプチャによって TAB チーム表の
ジオメトリを推定し（`overlay/capture.rs`、`overlay_detect.rs`）、
`GetAsyncKeyState(VK_TAB)` を 30 ms 間隔でポーリングしている。これは動くが、
次の問題がある。

- 画面キャプチャは最も壊れやすいレイヤである（DRM/キャプチャ除外、HDR、
  マルチ DPI、ウィンドウとフルスクリーンの差異）。
- キー状態のポーリングでは「Tab を押し続けている」と「戦闘チャットに Tab を
  入力した」を区別できない。
- 行の順序は、静的な名簿と撃沈ヒューリスティクスから推定される。

Wargaming 公式の **Mods API**（PnFMods チャネル。インジェクションなし、
メモリ書き込みなし）上で動くゲーム内 mod は、クライアントの内側から戦闘状態を
観測し、ファイルブリッジ経由で WoWSP に渡せる。この mod は**何もレンダリング
しない** —— 表示は引き続き透過オーバーレイが担う —— ため、かつて
「ゲーム内レンダリング」案を潰した、ゲームバージョンごとの UI メンテナンスを
一切背負わない。

目標:「mod テレメトリ > 画面キャプチャ推定 > 静的順序」をオーバーレイデータの
優先順位チェーンとし、`overlay_config.toml` の roster モードに新しい
`"plugin"` 値を追加する。

## 実験で証明されたこと

Steam-ASIA 15.8.0（build 13187581）と 360-CN 15.8.1（build 13243917）で
検証（各レルム数戦）。プローブの成果物は
`packages/ingame-plugin/src/Main.py`（自身は永遠に `0.1.0` を名乗る。
反復は git 履歴にのみ存在）:

| 能力 | 仕組み | レイテンシ / 備考 |
| --- | --- | --- |
| mod が両レルムでロードされる | `res_mods/<bin>/PnFModsLoader.py`（0 バイトマーカー）+ `PnFMods/<Mod>/Main.py`、`API_VERSION = 'API_v1.0'` | Aslain 製 mod と共存 |
| 注入される API モジュール | `events, ui, utils, battle, callbacks, dataHub, constants` はローダーが注入するグローバル。これらの `import` は失敗する（許可リスト方式）。決して同名で隠蔽しない | builtins も同じくホワイトリスト: `globals()`/`eval` は使えない |
| 名簿と識別情報 | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm | レコードは `SafeClass`: 添字アクセスは動くが dict プロトコルは動かない。ロード初期の反復は防御的に行う（コンテナが一時的に非 dict になる） |
| 撃沈判定 | `isAlive` の反転、1 秒間隔のポーリング | ゲーム自身の `typeDeath` ログ行と 1:1 で検証。遅延 ≤1 秒、4 戦で確認 |
| リアルタイム HP と発見 | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]`（`.value/.max/.isAlive`）、`entity[CC.relation]` | 敵の HP は発見されるまで 0/0 のまま —— ゲーム自身の表と同じ戦場の霧。0→実値への跳躍そのものが発見イベント |
| TAB 画面状態 | SFM イベント `input.tabModeIn` / `input.tabModeOut` | キー後 ≤3 ms で発火。チャット内 Tab では発火**しない** —— 誤検出という問題クラスを根絶する |
| 名簿の変動 | `events.onPlayersListUpdated` | 1 戦で 14 イベント |
| 戦闘ライフサイクル | `sfm.battleLoadingStarted`、`request.showBattle`、`onBattleStart`、`up.exitBattle`、`window.hide(Battle)` | tempArenaInfo ファイルの出現/削除より細かい粒度 |

**利用不可**（かつ不要）: プレイヤーごとの score/XP コンポーネントは avatar
エンティティに存在せず、unbound 側の
`$datahub.getCollection().getChildByPath('team.ally.sortedAlive')` パスには
Python 側の等価物がない（注入された dataHub に `getCollection` は存在しない）。

**並び順の規則 —— 不安定、クライアントごとの知識。真実はゲームの内側から
得なければならない。** TAB 表の行順は、各クライアントの HUD がレンダリング
したものそのままあり、ベンダー間で実際に分岐している（初期の「アリーナ車両順
＋撃沈者を末尾に再追加」というモデルは、あくまで WG 系の近似にすぎなかった
—— 解決できなかった同順位のグループこそ、#604 のドットチップが糊塗した
対象である）。レルムごとに実際の Tab キャプチャに対して校正し、クライアント
の更新次第で変わることを織り込んだ上で、スクリプトの逆コンパイルは裏付け
資料としてのみ扱うこと —— 証明としては決して扱わない。2026-10-09 の
マトリクス（このマシンのインストールから wowsdeob で逆コンパイルした
`ShipSystem.add` / `AvatarSystem.__sortKeyAlive`）:

- **WG 系**（eu/na/asia は同一ビルドを共有）: 生存フラグ、艦種ランク
  （CV < BB < CA < DD < SS < 補助）、ティア降順、`NATION.SORT_ORDER` ランク、
  ローカライズされた艦船短縮名、`[TAG]ニックネーム` —— 1 本の連結文字列。
  現行の 15.8.0 は 2026-09-27 の Tab キャプチャに対して 6/6 で検証済み。
  さらに次のビルド（13357625、2026-10-06 にダウンロード）も同じ
  「国別ランク優先」の式に逆コンパイルされた —— WG は動いていない。
- **360-CN**: 独自の Python（ビルド 13243917 と現行 13357822 の両方）は今も
  WG の国別ランクキーを計算しているのに、クライアントが**レンダリング**する
  のはローカライズ艦名順（2026-10-07 キャプチャ、9/9 pinyin）—— 分岐は
  HUD/ビュー層にある。ゆえにスクリプトの逆コンパイルではこのクライアントを
  決して確定できず、レンダリングされたキャプチャだけが根拠になる。
- **Lesta**（ru）: こちらもローカライズ艦名順をレンダリングする
  （2026-10-09 キャプチャ: Bogatyr が St. Louis の 2 行を `usa < russia` に
  反して先頭に置いた）; 現行ビルド（8867689）は逆コンパイラがまだ開けない
  変更済み `.pyc` コンテナを同梱している。

アプリはこれを、オフラインのソートキーに対するレルム別ゲートとして実装する
（utils/realms の `realmUsesShipNameOrder`; ソートキー本体と CN の静的
レイアウトは utils/shipClass が持つ）。そして推定をゲーム内の真実として
提示することを拒む: プラグインが接続済みでも、/live パネルのヘッダでは
「完全には動作していない」と評定され続ける（警告ピル + tooltip、
`features/replay/telemetryGrade.ts`）。テレメトリのペイロードは生存/撃沈
状態を運ぶが、行順は**運ばない**からだ。最終形は、プローブがゲーム自身の
順序をエンジン内で読み取ることだ —— TAB がレンダリングするコレクション
（`team.ally.sortedAlive`）が自然な情報源だが、注入された dataHub には
`getCollection` が存在しない。将来のペイロード契約
（`order: {ally: [...], enemy: [...]}`、ゲーム内の真値のみ）がピルを
「正確」へ戻す。それまでの間、推定は校正済みのフォールバックにすぎない。

## サンドボックスの制約（苦労して得た知見。mod のスタイルガイドに残すこと）

- Python は **2.7**。構文は保守的に保つ（f-string 不可。既存プローブは
  意図的に 2/3 互換にしてある）。
- `open()` に**追加モードはない**（'a' は例外を投げず None を返す）:
  ファイルはメモリ内バッファから丸ごと書き直す。
- 存在しないファイルは、例外が投げられる前にエンジン側へエラー行をログ
  する: ポーリング対象のメールボックスはすべて、ロード時に 1 回シードして
  おく（`manual_refresh.flag` のシード処理を参照）。
- コールバックから漏れた例外は mod を黙って殺す: すべてをラップし、
  繰り返すエラーは重複を除いてからログする。
- 注入モジュールに対する `dir()` は `[]` を返す（SafeClass ラッパ）:
  API の表面は上記の検証済み名前リストのみ。
- ローダーのチャネルは 2 つある: 本プロジェクトが使う古典的な非署名
  PnFMods 1.0 と、WG 署名検証付きの「ModsAPI 2.0」（ModStation クラスの
  署名 mod）。非署名のコミュニティ mod は問題なく共存する。サードパーティ
  パックの署名失敗は本プロジェクトの関知するところではない。

## アーキテクチャ

```
┌─ game client (Mods API sandbox, no network) ─────────────┐
│ PnFMods/WoWSPStats/Main.py                               │
│  · roster poll (1 s, stable-confirm) → request.json      │
│  · entity walk → telemetry (hp/relation/alive)           │
│  · SFM events → tabMode marks, lifecycle marks           │
│  · heartbeat.json (phase port/battle, 1–2 s)             │
└──────────────┬────────────────────────────────────────────┘
               │ flat JSON files in the mod's own directory
┌──────────────┴────────────────────────────────────────────┐
│ WoWSP app (Rust, existing processes)                      │
│  · bridge reader/writer (replaces the experiment probe's │
│    companion role; same request/response protocol the    │
│    third-party reference plugin established)             │
│  · ordering engine: arena order + dead-sinking           │
│  · roster mode "plugin" in overlay_config                │
│  · health check: parse profile/python.log for the mod's  │
│    load/self-check lines (api[load] dh=True …)           │
└───────────────────────────────────────────────────────────┘
```

ブリッジファイル（プロトコル v1。すべて mod ディレクトリ内）:

```jsonc
// request.json —— 名簿が安定した時点で mod が書き出す（手動リフレッシュ
// 時にも再書き込み）。コンパニオンが戦績行を応答する。
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json —— WoWSP が書き出す。revision はセッションごとに単調
// 増加でなければならない。空ファイル（末尾に改行なし）は「保留中」を意味する。
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json —— 1–2 秒ごとに書き直す。失効 = mod 死亡またはゲーム終了。
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3 }

// テレメトリ journal —— 戦闘ごとの有界リングをファイルごと書き直す。
// 個々の独立状態とイベントマークを 1 本のタイムラインに並べる:
{ "t": 1690000000000, "players": { "<avatarId>": { /* projection */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag —— WoWSP が新しいエポック ms タイムスタンプを
// 書き込んで再クエリをトリガーする。mod は 10 秒のウィンドウ内で消費する。
```

## プロダクト統合

1. **トグルで自動インストール**: 設定でゲーム内並び順ソースを有効にすると、
   既存の `mod_install.rs` / `mod_templates` の経路で mod を書き込む
   （`PnFModsLoader.py` マーカーは存在しないときのみ作成。自前のファイル
   のみ触る。スナップショット + ロールバック。ゲームクローズガード）。
   無効化するとアンインストールされる。これが所有者が指定した「特別な」
   登録動作であり、プラグインが手動インストール手順として姿を現すことは
   決してない。
2. **自リポジトリでの Discussions 登録**: `langyo/wowsp/discussions` に
   テンプレート化したリソーススレッドを公開し、`mod-index.json` エントリから
   参照する（`category`、`discussion`、`versions[].game` 互換性）。これにより
   Mod Hub も他の mod と同じようにリスト/検証できる —— ファーストパーティの
   出自、同一のカタログ機構（mod-hub.md のギャップ G8 の同意モデル）。
3. **フォールバックチェーン**: テレメトリが欠落/失効（ハートビートが N 秒
   超、`api[load] dh=False`、ゲーム更新で mod が壊れる）→ 現行の推定
   パイプラインへ黙ってフォールバックする。オーバーレイの機能が mod に
   依存することは決してない。

## リスクとメンテナンス

- **WG API の変化**が今や唯一の結合点（unbound なし、素の要素のコピーなし）。
  Mods API v1.0 の表面は 13.x→15.8 を通じて安定している。プローブの
  自己チェック行により、破損は派手に、かつ診断可能に現れる。
- **中国クライアント**: 動作検証済み。360 クライアントは同じ Mods API
  ローダーを動かす（ログはネイティブに `PnFModsLoader.py` を走査する）。
  メジャーバージョンごとに中国のアンチチート政策の変化に注視する。
- **パフォーマンス**: `getPlayersInfo` の 1 秒ポーリング + エンティティ
  走査は予算内に十分収まる（TeamHP 系 mod はフレームごとにエンティティを
  走査する）。この用途に `callbacks.perTick` を使わないこと。
- **ジャーナルの増大**: 戦闘ごとの有界リング。戦後分析に有用なら、リプレイと
  一緒にセグメントを同梱する。

## Rust 統合マップ（正確な接点）

| 関心事 | ファイル（注記なきものは既存） | 変更内容 |
| --- | --- | --- |
| ブリッジファイル監視 | `commands/arena_info.rs` の姉妹ファイル: 新規 `commands/ingame_bridge.rs` | mod ディレクトリを `notify` で監視。ハートビート/リクエスト/ジャーナルを解析。Tauri イベント `wowsp://ingame-*` を公開 |
| 並び順エンジン | 新規モジュール `overlay/order_source.rs` | ブリッジイベントが駆動する「アリーナ順 + 撃沈沈降」リデューサー。オーバーレイが描画する最終行順序を出力 |
| 設定スキーマ | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster` に `"plugin"` を追加（優先チェーン `plugin > inferred > ocr > off`） |
| オーバーレイのキーゲーティング | `overlay/placement.rs`（`tab_key_down`） | ブリッジが稼働しているときは、`GetAsyncKeyState` ポーリングの代わりに `input.tabModeIn/Out` マークで表示/非表示を駆動する |
| インストール / アンインストール | `commands/mod_install.rs` + `packages/ingame-plugin/`（新規サブパッケージ） | テンプレートをサブパッケージの `Main.py` にする。スナップショット + ロールバック。ゲームクローズガード。旧プローブのクリーンアップ |
| ヘルスチェック | `commands/ingame_bridge.rs` | `profile/python.log` を解析して mod の `probe … loaded` / `api[load] dh=True` 自己チェック行を探す。設定 UI 向けにステータスを公開 |
| 戦績行 | 既存の `wg_api.rs` / `wg_api_cn.rs` | 変更なし —— コンパニオンは、オーバーレイが現在使っているのと同じ一括照会から `response.json` を書き込む |

## テスト計画

- **サンドボックス適合**: 出荷する `Main.py` の変更はすべて、制約リスト
  （py2.7 としてパースできる、禁止 builtins なし、追加モードでの open なし、
  ガード済みコールバック）+ `python -m py_compile` で検証する。
- **ポートのみのスモークテスト**（戦闘なし）: ゲームを起動し、ポートに
  ~15 秒とどまって終了する。`python.log` に `injected names=[…]`、
  `api[load] dh=True`、新しいハートビートが出ることをアサートする。これは
  実験を正直に保った安価な検証手順であり、インストールの受け入れテストとして
  残す。
- **戦闘フィクスチャ**: 各レルムで Co-op を 1 戦。ジャーナルに名簿
  スナップショット、撃沈による `alive` 反転 ≥1 回、tabMode マークが含まれる
  こと、そして `python.log` の `typeDeath` 行が反転と 1:1 で対応することを
  アサートする。
- **フォールバックドリル**: アプリを停止する（コンパニオンなし）。mod の
  180 秒ビジータイムアウトが復旧し、次の戦闘でもリクエストを行うことを
  アサートする。mod ディレクトリを壊し、オーバーレイが黙って推定へ
  フォールバックすることをアサートする。

## 提供計画

- **M1** —— 製品化: プローブの探索バッテリーをデバッグフラグの下へ退避する。
  ブリッジプロトコルを凍結。Rust ブリッジ + 並び順エンジン + オーバーレイ
  ストアへ組み込む `roster = "plugin"` モード。
- **M2** —— 設定トグル、自動インストール/アンインストール、python.log
  ヘルスチェック、失効フォールバックロジック。
- **M3** —— Discussions 登録、カタログエントリ、更新チャネル（テンプレートの
  更新はアプリのリリースに乗る。mod ファイル自体が変わることはまれ）。
