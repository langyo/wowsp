/**
 * Voice-line scene titles — the primary label of every audio row in a
 * voice pack's preview. Raw .wem file names are opaque event hashes
 * (`1041302342.mp3.wem`); the pack's mod.xml (parsed Rust-side, attached
 * to each listed file) says which Wwise event a file answers to, and
 * THIS module turns the event into a localized scenario title from the
 * bundled res/voice-scenes.json registry — the same shape and locale
 * fallback chain as the mod-tags registry. Events the registry hasn't
 * caught up with fall back to a humanized event name; files the mod.xml
 * never mentions keep their file name as the only line.
 */
import scenesJson from "../../../../../res/voice-scenes.json";

interface RawScene {
  event: string;
  i18n: Record<string, string>;
}

let table: Map<string, Record<string, string>> | null = null;

function ensureTable(): Map<string, Record<string, string>> {
  if (!table) {
    table = new Map();
    for (const scene of (scenesJson as { scenes: RawScene[] }).scenes) {
      if (scene?.event && scene.i18n) table.set(scene.event, scene.i18n);
    }
  }
  return table;
}

/** Audio-row ordering: scene-mapped lines first, grouped by event and
 *  ordered by variation index; unmapped files trail by name (the `~`
 *  prefix sorts behind every event name). */
export function compareByScene(
  a: { rel: string; sceneEvent?: string; sceneIndex?: number },
  b: { rel: string; sceneEvent?: string; sceneIndex?: number },
): number {
  const ka = a.sceneEvent ?? `~${a.rel}`;
  const kb = b.sceneEvent ?? `~${b.rel}`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0);
}

/** A scene's localized label: exact locale, then the zh / en pair the
 *  registry guarantees, else null (caller humanizes the event name). */
export function sceneLabel(event: string, locale: string): string | null {
  const i18n = ensureTable().get(event);
  if (!i18n) return null;
  const zh = locale.toLowerCase().startsWith("zh");
  return (
    i18n[locale] ??
    (zh ? (i18n["zh-CN"] ?? i18n["en-US"]) : (i18n["en-US"] ?? i18n["zh-CN"])) ??
    null
  );
}

/** `Play_VO_Fire_Alarm` → "Fire Alarm" — the registry-lag fallback that
 *  still beats a hash file name. */
export function humanizeEvent(event: string): string {
  return event
    .replace(/^(Play_VO|Play_UI|Play)_/, "")
    .replace(/_/g, " ")
    .trim();
}

/** The state qualifier shown under the title when an event assigns
 * files per state — `VO_Autopilot_Checkpoint` (event
 * `Play_VO_Autopilot`) → "Checkpoint"; quick-chat states keep their
 * command words (`CMD_QUICK_NEED_SMOKE` → "Need Smoke"). */
export function humanizeState(event: string, state: string): string {
  const core = event.replace(/^(Play_VO|Play_UI|Play)_/, "");
  let rest = state.replace(/^VO_/, "");
  if (rest.toLowerCase().startsWith(core.toLowerCase() + "_")) {
    rest = rest.slice(core.length + 1);
  } else {
    rest = rest.replace(/^CMD_QUICK_/, "");
  }
  return rest.replace(/_/g, " ").trim() || state;
}
