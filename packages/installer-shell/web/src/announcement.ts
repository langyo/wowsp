/**
 * Content data for the mandatory "this software is free & open source"
 * notice, plus the locale-based variant picker, and the usage-telemetry
 * notice shown in the user's own language.
 *
 * The free-notice is ALWAYS shown in exactly three languages — Simplified
 * Chinese, English, and Russian — no matter which UI locale the user runs.
 * When the UI locale resolves to a fourth language (zh-TW / ja / ko / fr /
 * es) its variant is appended after the mandatory three; other zh / en /
 * ru tags collapse onto blocks already shown, so they add nothing.
 *
 * The telemetry notice is shown ONCE, in the language the system reports
 * (zh-Hant / zh / en), because unlike the anti-scam warning it is not a
 * fraud-prevention banner that must be legible to every buyer regardless
 * of locale — it is a disclosure aimed at this specific user. Canonical
 * long-form copy: docs/{lang}/license/usage-telemetry.md.
 *
 * This module is a mirrored copy: an identical module lives at
 * packages/webui/src/components/layout/announcementVariants.ts — keep the
 * copy texts in sync across both.
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

/** Short usage-telemetry disclosure, one per language id (en / zh-CN /
 *  zh-TW keyed; every other locale falls back to the en entry). The
 *  wording mirrors the short form of docs/{lang}/license/usage-telemetry.md. */
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
};

/** Pick the telemetry notice for a raw BCP-47 tag (navigator.language):
 *  Traditional Chinese locales read zh-TW, any other zh prefix reads
 *  zh-CN, everything else reads English. */
export function pickTelemetryNotice(tag: string): { label: string; text: string } {
  const lower = tag.toLowerCase();
  const traditional =
    lower.startsWith("zh") &&
    (["-tw", "-hk", "-mo"].some((sub) => lower.includes(sub)) || lower.includes("hant"));
  const key = traditional ? "zh-TW" : lower.startsWith("zh") ? "zh-CN" : "en";
  return TELEMETRY_NOTICES[key];
}

/**
 * Pick the variants to render for a raw BCP-47 tag (navigator.language):
 * the three mandatory blocks (zh-CN, en, ru) plus the tag's own variant
 * when it maps to a fourth language. zh tags with a tw / hk / mo region
 * or a Hant script subtag pick zh-TW; other zh tags collapse onto the
 * mandatory zh-CN block, and en / ru tags onto already-shown blocks —
 * none of them add a fourth. Unknown tags fall back to the mandatory
 * three only.
 */
export function pickAnnouncementVariants(tag: string): AnnouncementVariant[] {
  const picked: AnnouncementVariant[] = MANDATORY_IDS.map(
    (id) => ANNOUNCEMENT_VARIANTS[id],
  );
  const lower = tag.toLowerCase();
  let extraId = "";
  if (lower.startsWith("zh")) {
    const traditional =
      ["-tw", "-hk", "-mo"].some((sub) => lower.includes(sub)) ||
      lower.includes("hant");
    extraId = traditional ? "zh-TW" : "zh-CN";
  } else if (lower.startsWith("ja")) {
    extraId = "ja";
  } else if (lower.startsWith("ko")) {
    extraId = "ko";
  } else if (lower.startsWith("fr")) {
    extraId = "fr";
  } else if (lower.startsWith("es")) {
    extraId = "es";
  } else if (lower.startsWith("ru")) {
    extraId = "ru";
  }
  if (extraId && !picked.some((v) => v.id === extraId)) {
    picked.push(ANNOUNCEMENT_VARIANTS[extraId]);
  }
  return picked;
}
