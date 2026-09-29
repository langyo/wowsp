/** Supporters & credits, surfaced in the settings 支持与致谢 section in
 *  three groups: partner streamers first (cards with their live Bilibili
 *  avatars), upstream projects, and asset/resource partners last. Names,
 *  links and Bilibili UIDs are data; role/note wording lives in i18n
 *  (`about.attribution.*`). The seal fonts are declared as partners but
 *  only used as rendered bitmaps — the font files are NOT bundled.
 *
 *  正弦线 appears twice on purpose: once as the streamer he is (with the
 *  wallpaper note on his card), once under resources for the wallpaper
 *  art itself — the two rows carry different roles. */
export interface Attribution {
  id: string;
  name: string;
  url?: string;
  /** i18n key (`about.attribution.…`) describing what this partner provides. */
  roleKey: string;
  /** i18n key (`about.attribution.…`) for the usage/rights note. */
  noteKey?: string;
}

/** A partner streamer — rendered as a card: live Bilibili avatar (see
 *  commands/supporters.rs), name, role/note, click opens the space page. */
export interface StreamerSupporter {
  id: string;
  name: string;
  /** Bilibili user id — space page `space.bilibili.com/<uid>` and the
   *  avatar lookup key. */
  uid: number;
  roleKey: string;
  noteKey?: string;
}

/** The partner streamers, in display order. */
export const STREAMER_SUPPORTERS: StreamerSupporter[] = [
  {
    id: "streamer-sine",
    name: "正弦线",
    uid: 97738727,
    roleKey: "streamerRole",
    noteKey: "streamerSineNote",
  },
  {
    id: "streamer-cat",
    name: "猫叔不吃鱼",
    uid: 10604786,
    roleKey: "streamerRole",
  },
  {
    id: "streamer-naomi",
    name: "BestNaomi",
    uid: 77660417,
    roleKey: "streamerRole",
  },
];

/** Upstream projects the app builds on. */
export const UPSTREAM_ATTRIBUTIONS: Attribution[] = [
  {
    id: "aperadar",
    name: "海猴雷达 ApeRadar",
    url: "https://lxdev.org/aperadar/",
    roleKey: "aperadarRole",
  },
  {
    id: "wowsunpack",
    name: "wowsunpack",
    url: "https://github.com/landaire/wows-toolkit",
    roleKey: "wowsunpackRole",
  },
  {
    id: "wows-core",
    name: "wows-core",
    url: "https://github.com/landaire/wows-toolkit",
    roleKey: "wowscoreRole",
  },
  {
    id: "shittim-chest",
    name: "shittim-chest",
    url: "https://github.com/celestia-island/shittim-chest",
    roleKey: "shittimRole",
  },
  {
    id: "hikari",
    name: "Hikari",
    url: "https://github.com/celestia-island/hikari",
    roleKey: "hikariRole",
  },
  {
    id: "celestia-devtools",
    name: "Celestia Devtools",
    url: "https://github.com/celestia-island/celestia-devtools",
    roleKey: "devtoolsRole",
  },
];

/** Asset / resource partners — always the LAST group. */
export const RESOURCE_ATTRIBUTIONS: Attribution[] = [
  {
    id: "font-mao",
    name: "草檀斋毛泽东字体",
    roleKey: "fontMaoRole",
    noteKey: "bitmapNote",
  },
  {
    id: "font-luxun",
    name: "方正鲁迅行书",
    url: "https://www.foundertype.com",
    roleKey: "fontLuxunRole",
    noteKey: "bitmapNote",
  },
  {
    id: "wallpaper-sine",
    name: "正弦线",
    url: "https://space.bilibili.com/97738727",
    roleKey: "wallpaperRole",
    noteKey: "wallpaperNote",
  },
];

/** The About page's streamer cards, as one avatar-lookup request. */
export const STREAMER_UIDS: number[] = STREAMER_SUPPORTERS.map((s) => s.uid);
