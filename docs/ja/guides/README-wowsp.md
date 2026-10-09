<h1 align="center">WoWSP</h1>

<p align="center"><strong>World of Warships 向けの無料オープンソース バトルパネル — リプレイレビュー、ゲーム内オーバーレイ、戦闘のリアルタイム情報、フル戦績。Windows と Android に対応。</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![Release](https://img.shields.io/github/v/release/langyo/wowsp)](https://github.com/langyo/wowsp/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/langyo/wowsp/total)](https://github.com/langyo/wowsp/releases)

</div>

<div align="center">

[English](../../en/guides/README-wowsp.md) ·
[简体中文](../../zh-CN/guides/README-wowsp.md) ·
[繁體中文](../../zh-TW/guides/README-wowsp.md) ·
**日本語** ·
[한국어](../../ko/guides/README-wowsp.md) ·
[Français](../../fr/guides/README-wowsp.md) ·
[Español](../../es/guides/README-wowsp.md) ·
[Русский](../../ru/guides/README-wowsp.md) ·
[العربية](../../ar/guides/README-wowsp.md)

</div>

![WoWSP ダッシュボード](../screenshots/dashboard.webp)

> [!IMPORTANT]
> **WoWSP は完全無料のオープンソースであり、公式の [GitHub Releases](https://github.com/langyo/wowsp/releases) のみで配布される。金銭を要求してくる者は作者ではない — 支払わないこと。すでに支払ってしまった場合は返金を要求し、販売者を通報すること。**

WoWSP は Windows 向けの **World of Warships** デスクトップパネルで、Android コンパニオンを備える。ゲームのインストール環境（Wargaming Game Center、Steam、Lesta、360 のいずれか）を自動検出し、試合後のレビューからリアルタイム観戦、プレイ中の戦況読みまで、一連の流れをまるごとフォローする。

## 主な機能

- **リプレイレビュー** — 任意の `.wowsreplay` を開けば、ホログラフィック 3D マップ上で試合を再視聴できる。全艦艇の航跡・砲弾・魚雷・航空機中隊に加え、射程リング、サイクロン天候、占領ゾーンのシミュレーションまで再現。自由オービット・元の録画視点・艦艇追従の 3 種類のカメラ、自ら可読性を保つマップラベル、そしてマップの傍らに表示されるプレイヤーごとの戦闘結果（リボン・実績・ダメージ内訳）。どのパネルからもニックネームをマスクできる共有スクリーンショットを書き出せ、ライブラリはモード・日付・アーカイブ状態で絞り込める。
- **ゲーム内オーバーレイ** — 戦闘中に `Tab` を押し続けると、両チームの編成と戦績が試合画面に重なって表示され、押すたびに再アンカーされる。個人レーティング（PR）のティアと勝率カラー、印章（スタンプ）、撃沈行の着色、チームサマリー、Tab 長押し中の消耗品情報を表示。戦績は、検出した対戦テーブル上の透明ウィンドウに描画するか、同梱のファーストパーティプラグインでゲーム内に直接描画するかを選べ、行マッチングはクライアントごと（Wargaming・Lesta・中国クライアント）に調整済み。
- **リアルタイム戦闘モニター** — ロード画面からリザルト画面まで、試合の展開をライブで追いかける。PR ティアとクランタグ付きの完全な編成一覧、ティア加重のチーム勝率、戦闘カード、さらに自分の与ダメージ・実績・撃破の帰属をリアルタイムで追う個人戦闘レポートを表示。
- **戦績ダッシュボードとプレイ時間** — あなただけの「ウォーターメーター」：個人レーティング（PR）・勝率・平均ダメージのカード（期間指定付き）、艦艇分布チャート（ティアのヒストグラム、艦種・国のドーナツグラフ）、ランクシーズン履歴、マルチアカウント切り替え。専用のプレイ時間ビューでは、リプレイファイルから戦闘カレンダーのヒートマップを作り、年も切り替えられる。
- **プレイヤー・クラン検索** — 任意のプレイヤーやクランを検索（ピンイン対応）し、経歴カードやクラン名簿を共有スクリーンショット付きで閲覧。サーバーをまたいでクラン戦（Clan Battles）の編成を突き合わせることもできる。
- **艦艇百科とビルドプランナー** — Wargaming/Lesta の分岐を切り替えられる完全な技術ツリー、諸元ビューと装甲ビュー、艦ごとのサーバー内トレンド、艦艇・航空機の 3D モデルステージ、そして艦長スキル・指揮官・シグナル・アップグレードを最終諸元に反映し、クレジット/XP のコスト計算まで行うビルドプランナー。
- **MOD ハブ** — 機能・テクスチャ・音声の各ジャンルのコミュニティ MOD（艦艇スキン、プレビュー付き Wwise 音声パック）を厳選して集めたマーケットプレイス。インストールプリセット、ワンクリックのセーフモード、競合警告、陳腐化 MOD の移行、テクスチャ上書きの分析、一括アップデートを備える。
- **戦術ボード** *(開発中)* — 同梱の戦闘マップカタログを土台にした戦術プランエディター：20 分のプランニングクロック、ユニットの軌跡、アクションタイムライン、共有可能なプランセット。
- **Android コンパニオン** — Wi-Fi 経由（自動検出）でスマートフォンをペアリングできるほか、内蔵リレーを介した 6 桁のペアリングコードなら場所を問わず接続可能。デスクトップからリプレイを直接取り込み、外出先でも視聴できる。

内部もネイティブアプリとしての作り込みを貫く：最速ミラーを選ぶ自動アップデート（ポータブルインストール対応）、トレイパネル、初回セットアップウィザード、アプリ内お知らせ、ログ書き出し付きフィードバックフォーム。テーマ、壁紙、UI 不透明度、フォントサイズ、DPI の調整。9 言語の UI。オフにできる最小限の匿名テレメトリ。そして、欠けていても適切にフォールバックする同梱 WebView2。

## ダウンロード

Windows 10/11 — [GitHub Releases](https://github.com/langyo/wowsp/releases/latest) から最新の `WoWSP_<version>_x64-installer-webview2.exe` を入手（WebView2 同梱）。GitHub が遅い地域では、ミラー対応の[ダウンロードページ](https://wowsp.langyo.xyz/download)を利用。Android 版はソースからビルドする — [ビルドガイド](building.md)を参照。

全ビュー・全 UI 言語のスクリーンショットは[ウェブサイトのギャラリー](https://wowsp.langyo.xyz/#gallery)で公開。

## ドキュメント

アーキテクチャ、設計メモ、各種ガイドは [`docs/`](../../) に 9 言語で格納されている（英語と简体中文が完全翻訳済み）。[lagrange](https://github.com/celestia-island/lagrange) で構築。WoWSP は最小限の匿名利用テレメトリを送信する — 収集内容（と収集しない内容）の詳細は[テレメトリに関するお知らせ](../license/usage-telemetry.md)を参照。

## フィードバックとクレジット

バグ報告とテストフィードバックは QQ グループ **[1125770228](https://qm.qq.com/cgi-bin/qm/qr?k=b6kMIecv3d390ecZVWNQNWMFfLRVgcQ9&jump_from=webapi&authKey=NhNLVnIcIlmfnnDUCjpsra4C/zfciS1sYNjm5SV7x2RPhdP1CzOM91ObP9y9MMQV)**、または[ウェブサイト](https://wowsp.langyo.xyz)のフィードバックフォームへ。リプレイ解析とゲーム検出の原理は [ApeRadar（海猴雷达）](https://github.com/zylalx1/ApeRadar) から、フロントエンドシェルとビルド基盤は [shittim-chest](https://github.com/celestia-island/shittim-chest) から改変のうえ採用している。

## ライセンス

WoWSP は **Synthetic Source License 1.0**（[全文](https://github.com/langyo/wowsp/blob/master/LICENSE)）の下で提供される — 実質的に AI 生成のコードベースに対して Apache-2.0 と同等の許諾を与えるライセンスであり、追加の義務はコピーおよび派生物すべてに AI 生成である旨の表示を維持することのみ。ベンダー取り込みした [wows-toolkit](https://github.com/langyo/wowsp/tree/master/packages/tools/wowsunpack-vendor) スナップショットは上流の **MIT** ライセンスを維持し、リポジトリ内のそれ以外の一切 — スタンドアロンの [pairing-relay](https://github.com/langyo/wowsp/tree/master/packages/pairing-relay) ワーカーを含む — は SySL-1.0 が適用される。

## 支援

WoWSP はこれからも無料であり続けます。価値を感じて支援したい場合は、作者の afdian ページ **[afdian.com/a/langyo](https://afdian.com/a/langyo)** へどうぞ。いただいた支援はすべて、WoWSP の開発にかかる AI コスト（モデル呼び出しとコード生成ツール）に全額使われます。

責任の範囲をはっきりさせておきます：

- 支援は完全に任意であり、必要条件ではありません——全機能が無料であり、支援しないと使えない機能が本体に組み込まれることは決してありません。
- 支援は自発的な贈与です：雇用・委託その他の法的関係は生じず、特定の機能・提供時期・返金に対する請求権も生じません。
- 本プロジェクトは上記ライセンスのもと、支援するしないにかかわらず誰に対してもオープンソースであり続けます。
- WoWSP は独立した非公式プロジェクトであり、Wargaming・Lesta・360 とは直接の関係がありません。
