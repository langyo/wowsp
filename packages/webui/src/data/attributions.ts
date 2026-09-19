/** Partner / asset attributions, surfaced in the settings 版权信息 section.
 *  Names and links are data; role/note wording lives in i18n
 *  (`about.attribution.*`). The seal fonts are declared as partners but only
 *  used as rendered bitmaps — the font files themselves are NOT bundled.
 *  Order: asset partners first, then upstream projects, with the
 *  celestia-island kin closest to home last. */
export interface Attribution {
  id: string;
  name: string;
  url?: string;
  /** i18n key (`about.attribution.…`) describing what this partner provides. */
  roleKey: string;
  /** i18n key (`about.attribution.…`) for the usage/rights note. */
  noteKey?: string;
}

export const ATTRIBUTIONS: Attribution[] = [
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
