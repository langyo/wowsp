/** Supporters & credits, surfaced in the settings 支持与致谢 section:
 *  SPECIAL THANKS first (cards with the helpers' live Bilibili avatars —
 *  no identity labels beyond what each person actually contributed), the
 *  author's afdian SPONSOR card (see SponsorCard.tsx — not data-driven),
 *  upstream projects, and asset/resource partners last.
 *  Names, links and Bilibili UIDs are data; role/note wording lives in
 *  i18n (`about.attribution.*`). The seal fonts are declared as partners
 *  but only used as rendered bitmaps — the font files are NOT bundled.
 *
 *  正弦线 appears twice on purpose: once in special thanks as the wallpaper
 *  artist (with his live avatar), once under resources for the wallpaper
 *  art itself. */
export interface Attribution {
  id: string;
  name: string;
  url?: string;
  /** i18n key (`about.attribution.…`) describing what this partner provides. */
  roleKey: string;
  /** i18n key (`about.attribution.…`) for the usage/rights note. */
  noteKey?: string;
}

/** One specially-thanked helper — rendered as a card: live Bilibili
 *  avatar (see commands/supporters.rs), name, optional role/note, click
 *  opens the space page. The role is what the person CONTRIBUTED (e.g.
 *  wallpaper art), never an identity category. */
export interface SpecialThanksEntry {
  id: string;
  name: string;
  /** Bilibili user id — space page `space.bilibili.com/<uid>` and the
   *  avatar lookup key. */
  uid: number;
  /** i18n key of the contribution, omitted when the thanks needs no
   *  qualifier. */
  roleKey?: string;
  noteKey?: string;
}

/** Special thanks, in display order. */
export const SPECIAL_THANKS: SpecialThanksEntry[] = [
  {
    id: "thanks-sine",
    name: "正弦线",
    uid: 97738727,
    roleKey: "wallpaperRole",
  },
  {
    id: "thanks-cat",
    name: "猫叔UoCat",
    uid: 10604786,
  },
  {
    id: "thanks-naomi",
    name: "BestNaomi",
    uid: 77660417,
  },
  {
    id: "thanks-ape",
    name: "猪猪子zy",
    uid: 7120685,
    roleKey: "aperadarAuthorRole",
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

/** The special-thanks cards, as one avatar-lookup request. */
export const SPECIAL_THANKS_UIDS: number[] = SPECIAL_THANKS.map((s) => s.uid);
