export default {
  nav: {
    "language": "言語",
    features: "機能",
    download: "ダウンロード",
    docs: "ドキュメント",
    github: "GitHub",
  },
  hero: {
    badge: "オープンソース · Windows x64",
    tagline: "World of Warships のリプレイ解析とゲーム内オーバーレイ",
    lede: "ゲームを起動せずに、ホログラフィック 3D マップで任意の .wowsreplay を再生できます。Mod としてインストールすれば、Tab を押している間だけ両チームの名簿を表示するオーバーレイも利用可能です。",
    download: "Windows 版をダウンロード",
    docs: "ドキュメントを読む",
    github: "GitHub ソース",
    version: "初回正式版は近日公開",
    ships: "1200+ 隻の艦船モデル",
    maps: "3D リプレイ解析",
    overlay: "戦闘中の Tab オーバーレイ",
  },
  features: {
    title: "2つのモード、1つのパネル",
    replay: {
      title: "単独リプレイ解析",
      desc: "ゲームのインストール先を自動検出し、.wowsreplay を解析して全艦船をホログラフィック 3D マップに描画します。ゲームの起動は不要です。",
    },
    overlay: {
      title: "ゲーム内オーバーレイ",
      desc: "ゲームと同時に起動する Mod として動作。透明なオーバーレイが両チームを表示し、Tab を押している間だけ表示されます。",
    },
    stats: {
      title: "統計と分析",
      desc: "Wargaming 公開 API による艦艇別統計、ランクシーズン、プレイヤー検索、戦績トレンド。",
    },
    viewer: {
      title: "3D 艦船ビューア",
      desc: "全艦船をローポリのホログラフィックモデルで閲覧。回転・拡大縮小・装甲の確認が可能です。",
    },
  },
  download: {
    title: "WoWSP をダウンロード",
    lede: "Windows x64 · WebView2 ランタイムは自動的にインストールされます。",
    install: "インストーラー（NSIS）",
    portable: "ポータブル版 / グリーン版",
    modesTitle: "3つの実行方法",
    modeInstallTitle: "この PC にインストール",
    modeInstallDesc: "スタートメニューのショートカットと自動更新付きの標準的なユーザー単位のインストール。推奨。",
    modeUsbTitle: "USB ドライブ（ネットカフェモード）",
    modeUsbDesc: "USB メモリ上のポータブルコピー。レジストリエントリなし、すべてのデータはドライブ上に保持。共有 PC に最適。",
    modeGreenTitle: "直接実行（グリーンソフトウェア）",
    modeGreenDesc: "任意の場所に展開して単体で実行。本機のインストールから完全に分離。デバッグやサンドボックスに最適。",
    assets: "リリースアセット",
    notes: "すべてのアセットは GitHub Releases で公開されています。",
  },
  footer: {
    license: "SySL-1.0 ライセンス",
    made: "Rust、Vue 3、Tauri 2、Three.js で構築",
  },
} as const;
