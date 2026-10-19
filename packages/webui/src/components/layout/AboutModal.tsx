import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { Check, Download, MessageCircle, RefreshCw } from "@lucide/vue";

import { HkButton, HkModal } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { SPECIAL_THANKS } from "@/data/attributions";
import { useUpdaterStore } from "@/stores/updater";
import { openExternal } from "@/utils/openExternal";
import AnnouncementContent from "./AnnouncementContent";
import "./AboutModal.scss";

/**
 * About modal: app name + version (dynamic via Tauri app API), tech stack,
 * links, license, and the QQ feedback group notice. Carries the mandatory
 * free & open-source notice as a permanent, always-visible card, shown in
 * the user's own language (no dismiss — the dismissable twin is the
 * onboarding wizard's welcome step; the usage-telemetry disclosure lives
 * in the settings' attributions section instead). Includes a "check for
 * updates" action when the updater is available.
 * Every link opens through the Rust backend so the system default browser
 * is used (the webview itself never navigates remotely). Link URLs live
 * only in the en-US locale (`about.links.*`) — they are language-invariant
 * values shared by every locale via the en-US fallback.
 * Two piggy easter eggs ride along: hovering the subtitle crossfades it
 * into its pig persona (and lights a skin-tone glow behind the logo),
 * clicking the logo pops a localized "hmph" bubble at a random nearby
 * spot and crossfades the description into a random localized "did you
 * know" trivia (click the trivia to get the plain description back).
 */

const TECH_LINKS = [
  { label: "Rust", link: "about.links.techRust" },
  { label: "Vue 3", link: "about.links.techVue3" },
  { label: "Tauri 2", link: "about.links.techTauri2" },
  { label: "Three.js", link: "about.links.techThreejs" },
  { label: "Pinia", link: "about.links.techPinia" },
  { label: "UnoCSS", link: "about.links.techUnocss" },
];

/** Piggy easter-egg message pools: the hums barked in the click bubble
 *  (about.hum1..5) and the cold-knowledge facts swapped in under the logo
 *  (about.trivia01..N). Enumerated message keys instead of JSON arrays so
 *  per-item key parity across all eight locales stays enforced by
 *  scripts/check_i18n.py and t() remains the only lookup path. */
const HUM_KEYS = [
  "about.hum1",
  "about.hum2",
  "about.hum3",
  "about.hum4",
  "about.hum5",
];
const TRIVIA_KEYS = [
  "about.trivia01",
  "about.trivia02",
  "about.trivia03",
  "about.trivia04",
  "about.trivia05",
  "about.trivia06",
  "about.trivia07",
  "about.trivia08",
  "about.trivia09",
  "about.trivia10",
  "about.trivia11",
  "about.trivia12",
  "about.trivia13",
  "about.trivia14",
  "about.trivia15",
  "about.trivia16",
  "about.trivia17",
  "about.trivia18",
  "about.trivia20",
  "about.trivia22",
  "about.trivia23",
  "about.trivia24",
  "about.trivia25",
  "about.trivia26",
  "about.trivia27",
  "about.trivia28",
  "about.trivia29",
  "about.trivia30",
  "about.trivia31",
  "about.trivia32",
  "about.trivia33",
  "about.trivia34",
  "about.trivia35",
  "about.trivia36",
  "about.trivia38",
  "about.trivia39",
  "about.trivia40",
  "about.trivia41",
  "about.trivia42",
  "about.trivia43",
  "about.trivia44",
  "about.trivia45",
  "about.trivia46",
  "about.trivia47",
  "about.trivia48",
];

/** The one trivia entry that name-drops a credited helper: @BestNaomi is
 *  rendered as an external link to his Bilibili space — the same URL the
 *  special-thanks card in Settings opens. The localized trivia43 text
 *  carries the literal token, so keep the two in sync. */
const TRIVIA_LINK_ENTRY = SPECIAL_THANKS.find((entry) => entry.id === "thanks-naomi");
const TRIVIA_LINK_TOKEN = TRIVIA_LINK_ENTRY ? `@${TRIVIA_LINK_ENTRY.name}` : "";
const TRIVIA_LINK_URL = TRIVIA_LINK_ENTRY
  ? `https://space.bilibili.com/${TRIVIA_LINK_ENTRY.uid}`
  : "";

/** Split a trivia line on the credited-helper token and turn the token
 *  into an external-link button. The click stops bubbling so it opens
 *  Bilibili instead of also restoring the plain description. */
function renderTriviaFact(text: string) {
  if (!TRIVIA_LINK_TOKEN || !TRIVIA_LINK_URL || !text.includes(TRIVIA_LINK_TOKEN)) {
    return text;
  }
  return text.split(TRIVIA_LINK_TOKEN).flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <button
            type="button"
            class="about-modal__trivia-link"
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              void openExternal(TRIVIA_LINK_URL);
            }}
          >
            {TRIVIA_LINK_TOKEN}
          </button>,
          part,
        ],
  );
}

/** One floating bubble around the logo — the point it grows from, in px
 *  offsets from the logo centre, and the hum message key it renders. */
interface PiggyBubble {
  id: number;
  humKey: string;
  x: number;
  y: number;
}

/** Pick a key at random, dodging `last` so consecutive clicks/pops never
 *  repeat (the pools are non-trivial, so the dodge always terminates). */
function randomKey(keys: string[], last: string): string {
  let key = keys[Math.floor(Math.random() * keys.length)];
  while (key === last) {
    key = keys[Math.floor(Math.random() * keys.length)];
  }
  return key;
}

/** The About body — logo, version + updater, tech tags, links, license
 *  footer, QQ line, then the mandatory free & open-source notice (the
 *  user's own language) as the last card. Rendered inside the AboutModal
 *  and inline in the settings modal's 关于 section. */
export const AboutContent = defineComponent({
  name: "AboutContent",
  setup() {
    const version = ref("0.1.0");
    const updater = useUpdaterStore();

    // --- piggy easter eggs ---
    /** True while the subtitle is hovered — flips the pig label and the
     *  logo's skin-tone glow (`.about-modal--piggy` in the SCSS). */
    const piggy = ref(false);
    /** Key of the trivia fact currently swapped in (null = plain
     *  description). Keys are stored, never translated text, so a locale
     *  switch re-translates the swapped-in fact on the next render. */
    const triviaKey = ref<string | null>(null);
    /** Bubbles currently alive around the logo; each expires itself via
     *  the 1.6s about-piggy-bubble animation, matching this timeout. */
    const bubbles = ref<PiggyBubble[]>([]);
    let bubbleSeq = 0;
    const bubbleTimers = new Set<number>();
    let lastHumKey = "";
    let lastTriviaKey = "";

    const popBubble = (): void => {
      const id = ++bubbleSeq;
      // Random spot around the logo — resample while the anchor would sit
      // inside the logo box, or high enough above it to clip against the
      // host's top edge (the modal body is overflow-y: auto).
      let x = 0;
      let y = 0;
      do {
        const angle = Math.random() * Math.PI * 2;
        const radius = 55 + Math.floor(Math.random() * 31);
        x = Math.round(Math.cos(angle) * radius);
        y = Math.round(Math.sin(angle) * radius);
      } while ((Math.abs(x) < 46 && Math.abs(y) < 46) || y < -40);
      const humKey = randomKey(HUM_KEYS, lastHumKey);
      lastHumKey = humKey;
      bubbles.value = [...bubbles.value, { id, humKey, x, y }];
      const timer = window.setTimeout(() => {
        bubbleTimers.delete(timer);
        bubbles.value = bubbles.value.filter((bubble) => bubble.id !== id);
      }, 1600);
      bubbleTimers.add(timer);
    };

    const swapTrivia = (): void => {
      triviaKey.value = randomKey(TRIVIA_KEYS, lastTriviaKey);
      lastTriviaKey = triviaKey.value;
    };

    const onLogoClick = (): void => {
      popBubble();
      swapTrivia();
    };

    onBeforeUnmount(() => {
      bubbleTimers.forEach((timer) => window.clearTimeout(timer));
      bubbleTimers.clear();
    });

    onMounted(async () => {
      // Dynamic version from the Tauri shell (falls back to package.json).
      try {
        version.value = await getVersion();
      } catch {
        // Browser dev mode — keep default "0.1.0".
      }
      // Portable installs can't self-update (NSIS-only) — probe once.
      void updater.init();
    });

    return () => (
      <div
        class={{
          "about-modal": true,
          "about-modal--piggy": piggy.value,
        }}
      >
          <button
            type="button"
            class="about-modal__logo"
            onClick={onLogoClick}
          >
            <img src="/logo.webp" alt="WoWSP" draggable={false} />
            {bubbles.value.map((bubble) => (
              <span
                key={bubble.id}
                class="about-modal__bubble"
                aria-hidden={true}
                style={{
                  left: `calc(50% + ${bubble.x}px)`,
                  top: `calc(50% + ${bubble.y}px)`,
                }}
              >
                {t(bubble.humKey)}
              </span>
            ))}
          </button>
          <h2 class="about-modal__name">WoWSP</h2>
          <p
            class="about-modal__subtitle"
            onMouseenter={() => {
              piggy.value = true;
            }}
            onMouseleave={() => {
              piggy.value = false;
            }}
          >
            <span class="about-modal__subtitle-face" aria-hidden={piggy.value}>
              {t("about.subtitle")}
            </span>
            <span
              class="about-modal__subtitle-face about-modal__subtitle-face--pig"
              aria-hidden={!piggy.value}
            >
              {t("about.subtitlePig")}
            </span>
          </p>
          <div class="about-modal__version">
            <span>v{version.value}</span>
            {updater.portable ? (
              <span class="about-modal__portable">{t("common.portableTag")}</span>
            ) : updater.running ? (
              <span class="about-modal__updating">{updater.statusText}</span>
            ) : updater.available ? (
              <HkButton variant="secondary" size="sm" onClick={() => void updater.downloadAndInstall()}>
                <Download size={12} /> {t("about.updateAvailable", { version: updater.version ?? "" })}
              </HkButton>
            ) : updater.checked ? (
              <span class="about-modal__up-to-date">
                <Check size={12} /> {t("about.upToDate")}
              </span>
            ) : (
              <HkButton variant="ghost" size="sm" onClick={() => void updater.check()}>
                <RefreshCw size={12} /> {t("about.checkUpdate")}
              </HkButton>
            )}
          </div>

          <div class="about-modal__desc-swap" aria-live="polite">
            <p
              class="about-modal__desc"
              style={{
                opacity: triviaKey.value ? 0 : 1,
                // The faded desc keeps painting (opacity < 1 forms a
                // stacking context) ABOVE the settled trivia, so it must
                // drop pointer events too or it swallows the restore click.
                pointerEvents: triviaKey.value ? "none" : "auto",
              }}
            >
              {t("about.description")}
            </p>
            <p
              class="about-modal__trivia"
              style={{
                opacity: triviaKey.value ? 1 : 0,
                pointerEvents: triviaKey.value ? "auto" : "none",
              }}
              onClick={() => {
                triviaKey.value = null;
              }}
            >
              {triviaKey.value
                ? renderTriviaFact(t("about.triviaLead", { fact: t(triviaKey.value) }))
                : ""}
            </p>
          </div>

          <div class="about-modal__tech">
            {TECH_LINKS.map((tech) => (
              <button
                key={tech.label}
                type="button"
                class="about-modal__tech-tag"
                data-hint={t(tech.link)}
                onClick={() => void openExternal(t(tech.link))}
              >
                {tech.label}
              </button>
            ))}
          </div>

          <div class="about-modal__links">
            <button
              type="button"
              class="about-modal__link"
              onClick={() => void openExternal(t("about.links.repo"))}
            >
              GitHub
            </button>
            <button
              type="button"
              class="about-modal__link"
              onClick={() => void openExternal(t("about.links.issues"))}
            >
              {t("about.issues")}
            </button>
          </div>

          <footer class="about-modal__footer">
            <button
              type="button"
              class="about-modal__license"
              data-hint="Synthetic Source License 1.0"
              onClick={() => void openExternal(t("about.links.license"))}
            >
              SySL-1.0 {t("about.license")}
            </button>
            <span>·</span>
            <button
              type="button"
              class="about-modal__license"
              onClick={() => void openExternal(t("about.links.author"))}
            >
              © langyo
            </button>
          </footer>

          <p class="about-modal__qq">
            <MessageCircle size={12} />
            <span>{t("about.qqGroupNotice")}</span>
            <button
              type="button"
              class="about-modal__qq-number"
              data-hint={t("about.qqGroupHint")}
              onClick={() => void openExternal(t("about.links.qqGroup"))}
            >
              {t("about.qqGroupNumber")}
            </button>
          </p>

          {/* Mandatory free & open-source notice: one block in the user's
              own language as the very last card — all info first, warning
              last, no inner scrollbar (the host scroller is the only one).
              The usage-telemetry disclosure lives in the settings'
              attributions section. */}
          <div class="about-modal__notice">
            <AnnouncementContent />
          </div>
        </div>
    );
  },
});

export default defineComponent({
  name: "AboutModal",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("about.title")}
        width="26rem"
      >
        <AboutContent />
      </HkModal>
    );
  },
});
