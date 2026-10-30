/**
 * Hikari-component chrome strings, registered into hikari's OWN i18n
 * context (the app-side mergeMessages seam — apps register their tables
 * here, and merged buckets survive hikari locale switches).
 *
 * Hikari ships per-locale component chrome, but the log window's newer
 * keys (`hikari::log.*`) are absent from every shipped bundle, so without
 * this table the crash-report log viewer renders English Pause / Copy /
 * Clear chrome inside a localized app. The app is the translator of last
 * resort: the table carries every UI locale, and syncHikariLocale both
 * registers the bucket and aligns hikari's active locale with the app's
 * (so any date formatting inside hikari follows the same choice).
 */
import { mergeMessages, setLocale as setHikariLocale } from "@celestia-island/hikari";

/** Canonical wowsp UI locale → hikari i18n dir — THE app-wide mapping
 *  (bootstrap's hikari locale sync consumes this same function). Hikari
 *  ships its component copy for zh-Hans/zh-Hant/en plus ja/ko/ru/fr/es;
 *  the remaining wowsp UI locales fall back to English. The whitelist
 *  matters: an unmapped primary must merge the English chrome table, not
 *  open a bucket no hikari activation will ever read. */
export function hikariLocaleOf(locale: string): string {
  const t = locale.toLowerCase();
  if (t.startsWith("zh")) {
    return /(^|[-_])(tw|hk|mo|hant)\b/.test(t) ? "zh-Hant" : "zh-Hans";
  }
  const primary = t.split(/[-_]/)[0];
  return ["ja", "ko", "ru", "fr", "es"].includes(primary ?? "") ? primary! : "en";
}

/** The log-window chrome per app UI locale. */
const LOG_CHROME: Record<string, Record<string, string>> = {
  "en-US": {
    "hikari::log.title": "Logs",
    "hikari::log.pause": "Pause",
    "hikari::log.resume": "Resume",
    "hikari::log.autoscroll": "Autoscroll",
    "hikari::log.copy": "Copy",
    "hikari::log.copied": "Copied",
    "hikari::log.clear": "Clear",
    "hikari::log.empty": "No log lines yet",
  },
  "zh-CN": {
    "hikari::log.title": "日志",
    "hikari::log.pause": "暂停",
    "hikari::log.resume": "继续",
    "hikari::log.autoscroll": "自动滚动",
    "hikari::log.copy": "复制",
    "hikari::log.copied": "已复制",
    "hikari::log.clear": "清空",
    "hikari::log.empty": "暂无日志行",
  },
  "zh-TW": {
    "hikari::log.title": "日誌",
    "hikari::log.pause": "暫停",
    "hikari::log.resume": "繼續",
    "hikari::log.autoscroll": "自動捲動",
    "hikari::log.copy": "複製",
    "hikari::log.copied": "已複製",
    "hikari::log.clear": "清空",
    "hikari::log.empty": "尚無日誌行",
  },
  "ja-JP": {
    "hikari::log.title": "ログ",
    "hikari::log.pause": "一時停止",
    "hikari::log.resume": "再開",
    "hikari::log.autoscroll": "自動スクロール",
    "hikari::log.copy": "コピー",
    "hikari::log.copied": "コピーしました",
    "hikari::log.clear": "クリア",
    "hikari::log.empty": "ログ行はまだありません",
  },
  "ko-KR": {
    "hikari::log.title": "로그",
    "hikari::log.pause": "일시정지",
    "hikari::log.resume": "재개",
    "hikari::log.autoscroll": "자동 스크롤",
    "hikari::log.copy": "복사",
    "hikari::log.copied": "복사됨",
    "hikari::log.clear": "지우기",
    "hikari::log.empty": "아직 로그 행이 없습니다",
  },
  "ru-RU": {
    "hikari::log.title": "Журналы",
    "hikari::log.pause": "Пауза",
    "hikari::log.resume": "Продолжить",
    "hikari::log.autoscroll": "Автопрокрутка",
    "hikari::log.copy": "Копировать",
    "hikari::log.copied": "Скопировано",
    "hikari::log.clear": "Очистить",
    "hikari::log.empty": "Строк журнала пока нет",
  },
  "fr-FR": {
    "hikari::log.title": "Journaux",
    "hikari::log.pause": "Pause",
    "hikari::log.resume": "Reprendre",
    "hikari::log.autoscroll": "Défilement auto",
    "hikari::log.copy": "Copier",
    "hikari::log.copied": "Copié",
    "hikari::log.clear": "Effacer",
    "hikari::log.empty": "Aucune ligne de journal pour l'instant",
  },
  "es-ES": {
    "hikari::log.title": "Registros",
    "hikari::log.pause": "Pausa",
    "hikari::log.resume": "Reanudar",
    "hikari::log.autoscroll": "Desplazamiento automático",
    "hikari::log.copy": "Copiar",
    "hikari::log.copied": "Copiado",
    "hikari::log.clear": "Borrar",
    "hikari::log.empty": "Aún no hay líneas de registro",
  },
};

/** Register this app's log-window chrome for the given UI locale and
 *  align hikari's active locale with it. Called from the webui's
 *  setLocale (initial application + every later switch); unknown locales
 *  fall back to the English table. */
export function syncHikariLocale(locale: string): void {
  const table = LOG_CHROME[locale] ?? LOG_CHROME["en-US"]!;
  const hikari = hikariLocaleOf(locale);
  mergeMessages(table, hikari);
  void setHikariLocale(hikari);
}
