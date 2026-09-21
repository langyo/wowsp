/**
 * Content data for the mandatory "this software is free & open source"
 * notice, plus the locale-based variant picker, and the usage-telemetry
 * notice shown in the user's own language.
 *
 * The free-notice is ALWAYS shown in exactly three languages — Simplified
 * Chinese, English, and Russian — no matter which UI locale the user runs.
 * When the UI locale resolves to a fourth language (zh-TW / ja / ko / fr /
 * es) its variant is appended after the mandatory three; zh-SG deliberately
 * maps onto the zh-CN block (same script, same copy), so it adds nothing.
 *
 * The telemetry notice is shown ONCE, in the user's own language: every
 * UI locale resolves its own entry (zh locales split into Simplified /
 * Traditional, the other six offered UI locales map by code), and
 * anything unmapped reads English. Unlike the anti-scam warning it is
 * not a fraud-prevention banner that must be legible to every buyer
 * regardless of locale — it is a disclosure aimed at this specific user.
 * Canonical long-form copy: docs/{lang}/license/usage-telemetry.md (the
 * webui offers no de / pt UI locale, so those entries only surface in
 * the installer shell's mirror).
 *
 * This module is a mirrored copy: an identical module lives in
 * packages/installer-shell/web — keep the copy texts in sync across both.
 */

export interface AnnouncementVariant {
  /** Stable variant id (also the Vue key). */
  id: string;
  /** Display name of the language, written in its own script. */
  label: string;
  /** Bold headline. */
  title: string;
  /** Body paragraph. */
  body: string;
}

/** Every available variant, keyed by id. */
export const ANNOUNCEMENT_VARIANTS: Record<string, AnnouncementVariant> = {
  "zh-CN": {
    id: "zh-CN",
    label: "简体中文",
    title: "本软件完全免费，且开源发布",
    body: "WoWSP 完全免费、开源，仅通过官方 GitHub Releases（github.com/langyo/wowsp）分发。任何渠道收费出售均与作者无关——请勿付款；如已付费，请尽快申请退款并举报卖家。",
  },
  "zh-TW": {
    id: "zh-TW",
    label: "繁體中文",
    title: "本軟體完全免費，且以開放原始碼發布",
    body: "WoWSP 完全免費、開放原始碼，僅透過官方 GitHub Releases（github.com/langyo/wowsp）發布。任何收費販售皆與作者無關——請勿付款；如已付款，請儘速申請退款並檢舉賣家。",
  },
  en: {
    id: "en",
    label: "English",
    title: "This software is completely free and open source",
    body: "WoWSP is free, open-source software, distributed only via the official GitHub Releases (github.com/langyo/wowsp). Anyone charging for it is NOT the author — do not pay; if you already have, request a refund and report the seller as soon as possible.",
  },
  ja: {
    id: "ja",
    label: "日本語",
    title: "本ソフトウェアは完全に無料で、オープンソースとして公開されています",
    body: "WoWSP は無料のオープンソースソフトウェアであり、公式の GitHub Releases（github.com/langyo/wowsp）でのみ配布されています。これを販売する者は作者ではありません——支払わないでください。すでに支払った場合は、できるだけ早く返金を申請し、販売者を通報してください。",
  },
  ko: {
    id: "ko",
    label: "한국어",
    title: "이 소프트웨어는 완전히 무료이며 오픈 소스로 공개되어 있습니다",
    body: "WoWSP는 무료 오픈 소스 소프트웨어이며 공식 GitHub Releases(github.com/langyo/wowsp)에서만 배포됩니다. 이를 판매하는 자는 개발자가 아닙니다——결제하지 마세요. 이미 결제했다면 최대한 빨리 환불을 요청하고 판매자를 신고하세요.",
  },
  ru: {
    id: "ru",
    label: "Русский",
    title: "Это программное обеспечение полностью бесплатно и имеет открытый исходный код",
    body: "WoWSP — бесплатное ПО с открытым кодом, распространяется только через официальный GitHub Releases (github.com/langyo/wowsp). Тот, кто его продаёт, — не автор: не платите; если уже заплатили, как можно скорее требуйте возврат средств и пожалуйтесь на продавца.",
  },
  fr: {
    id: "fr",
    label: "Français",
    title: "Ce logiciel est entièrement gratuit et open source",
    body: "WoWSP est un logiciel gratuit et open source, distribué uniquement via la page officielle GitHub Releases (github.com/langyo/wowsp). Quiconque le vend n'est pas l'auteur — ne payez pas ; si vous avez déjà payé, demandez un remboursement et signalez le vendeur dès que possible.",
  },
  es: {
    id: "es",
    label: "Español",
    title: "Este software es completamente gratuito y de código abierto",
    body: "WoWSP es software gratuito y de código abierto, distribuido únicamente por la página oficial de GitHub Releases (github.com/langyo/wowsp). Quien lo venda no es el autor: no pague; si ya pagó, solicite un reembolso y denuncie al vendedor lo antes posible.",
  },
};

/** Mandatory blocks every surface shows, in display order. */
const MANDATORY_IDS = ["zh-CN", "en", "ru"] as const;

/** Short usage-telemetry disclosure, one per language id (the languages
 *  the wizard offers, zh keyed as zh-CN / zh-TW; anything else falls back
 *  to the en entry). The wording mirrors the short form of
 *  docs/{lang}/license/usage-telemetry.md. */
export const TELEMETRY_NOTICES: Record<string, { label: string; text: string }> = {
  en: {
    label: "English",
    text: "WoWSP collects minimal usage telemetry (interface language, pages opened, country-level region) to guide development. No personal data, no replay or account data is ever collected.",
  },
  "zh-CN": {
    label: "简体中文",
    text: "WoWSP 会收集极少量使用量遥测（界面语言、打开的页面、国家级地区），仅用于指导开发；绝不收集任何个人数据、回放或账号数据。",
  },
  "zh-TW": {
    label: "繁體中文",
    text: "WoWSP 會收集極少量使用量遙測（介面語言、開啟的頁面、國家級地區），僅用於指導開發；絕不收集任何個人資料、回放或帳號資料。",
  },
  ja: {
    label: "日本語",
    text: "WoWSP は最小限の使用状況テレメトリー（インターフェースの言語、開いたページ、国レベルの地域）を収集し、開発の指針にのみ利用します。個人データ、リプレイデータ、アカウントデータは一切収集しません。",
  },
  ko: {
    label: "한국어",
    text: "WoWSP는 개발 방향을 잡기 위해 최소한의 사용량 원격 측정(인터페이스 언어, 열어본 페이지, 국가 수준 지역)만 수집합니다. 개인 데이터, 리플레이 또는 계정 데이터는 절대 수집하지 않습니다.",
  },
  ru: {
    label: "Русский",
    text: "WoWSP собирает минимальную телеметрию использования (язык интерфейса, открытые страницы, регион на уровне страны) — только для направления разработки. Персональные данные, данные реплеев и аккаунтов не собираются никогда.",
  },
  fr: {
    label: "Français",
    text: "WoWSP collecte un minimum de télémétrie d'utilisation (langue de l'interface, pages ouvertes, région au niveau du pays), uniquement pour guider le développement. Aucune donnée personnelle, aucune donnée de replay ni de compte n'est collectée.",
  },
  es: {
    label: "Español",
    text: "WoWSP recoge una telemetría de uso mínima (idioma de la interfaz, páginas abiertas, región a nivel de país) solo para orientar el desarrollo. Nunca se recogen datos personales ni datos de repeticiones o cuentas.",
  },
  de: {
    label: "Deutsch",
    text: "WoWSP erfasst minimale Nutzungstelemetrie (Oberflächensprache, geöffnete Seiten, Region auf Länderebene), ausschließlich zur Orientierung für die Entwicklung. Persönliche Daten sowie Replay- oder Kontodaten werden niemals erfasst.",
  },
  pt: {
    label: "Português",
    text: "O WoWSP recolhe telemetria de utilização mínima (idioma da interface, páginas abertas, região ao nível do país), apenas para orientar o desenvolvimento. Nunca são recolhidos dados pessoais nem dados de replays ou de contas.",
  },
};

/** UI locale → telemetry-notice key for the non-zh UI locales (exact
 *  codes — this picker keys off the app's canonical UI locale). Codes
 *  outside the set fall back to en. */
const UI_LOCALE_NOTICE: Record<string, string> = {
  "en-US": "en",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "ru-RU": "ru",
  "fr-FR": "fr",
  "es-ES": "es",
};

/** Pick the telemetry notice for a UI locale: Traditional Chinese locales
 *  read zh-TW, any other zh prefix reads zh-CN, the other offered UI
 *  locales map by code, everything else reads English. */
export function pickTelemetryNotice(uiLocale: string): { label: string; text: string } {
  const lower = uiLocale.toLowerCase();
  const traditional =
    lower.startsWith("zh") &&
    (["-tw", "-hk", "-mo"].some((sub) => lower.includes(sub)) || lower.includes("hant"));
  let key = "en";
  if (traditional) {
    key = "zh-TW";
  } else if (lower.startsWith("zh")) {
    key = "zh-CN";
  } else {
    key = UI_LOCALE_NOTICE[uiLocale] ?? "en";
  }
  return TELEMETRY_NOTICES[key];
}

/** UI locale → optional fourth variant id (missing entry = no fourth block). */
const LOCALE_VARIANT: Record<string, string> = {
  "zh-CN": "zh-CN",
  "zh-SG": "zh-CN",
  "zh-TW": "zh-TW",
  "en-US": "en",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "ru-RU": "ru",
  "fr-FR": "fr",
  "es-ES": "es",
};

/** Pick the variants to render for a UI locale: the three mandatory blocks
 *  (zh-CN, en, ru) plus the locale's own variant when it isn't one of them.
 *  Unknown locales fall back to the mandatory three only. */
export function pickAnnouncementVariants(uiLocale: string): AnnouncementVariant[] {
  const picked: AnnouncementVariant[] = MANDATORY_IDS.map(
    (id) => ANNOUNCEMENT_VARIANTS[id],
  );
  const extraId = LOCALE_VARIANT[uiLocale];
  if (extraId && !picked.some((v) => v.id === extraId)) {
    picked.push(ANNOUNCEMENT_VARIANTS[extraId]);
  }
  return picked;
}
