import { defineComponent, onMounted, ref } from "vue";

import { t } from "@/i18n";
import { api } from "@/api";
import { SPECIAL_THANKS, SPECIAL_THANKS_UIDS, type SpecialThanksEntry } from "@/data/attributions";
import { mediaImageUrl } from "@/utils/media";
import { openExternal } from "@/utils/openExternal";
import "./SupporterCards.scss";

/**
 * The credits section's leading group (特别致谢): one card per specially
 * thanked helper with their LIVE Bilibili avatar (`commands/supporters.rs`
 * keeps a last-good cache; a total miss falls back to the initial-letter
 * disc), an optional contribution line (what they did, not who they are),
 * and the whole card opening their Bilibili space page in the external
 * browser. Avatars load through the `media://` proxy, so they are
 * disk-cached after the first view.
 */
export default defineComponent({
  name: "SupporterCards",
  setup() {
    /** uid → live/cached avatar URL; uids without an entry render the
     *  initial disc until the lookup lands (or forever, offline). */
    const faces = ref(new Map<number, string>());
    /** uids whose <img> failed to decode — back to the initial disc; a
     *  broken CDN link must not leave an empty circle. */
    const broken = ref(new Set<number>());

    onMounted(() => {
      api
        .getSupporterAvatars(SPECIAL_THANKS_UIDS)
        .then((list) => {
          const next = new Map<number, string>();
          for (const a of list) if (a.face) next.set(a.uid, a.face);
          faces.value = next;
        })
        .catch(() => {
          // offline / older shell — the initial discs serve
        });
    });

    return () => (
      <div class="supporter-cards">
        {SPECIAL_THANKS.map((s: SpecialThanksEntry) => {
          const face = faces.value.get(s.uid);
          const url = `https://space.bilibili.com/${s.uid}`;
          return (
            <button
              type="button"
              class="supporter-card"
              key={s.id}
              data-hint={url}
              onClick={() => void openExternal(url)}
            >
              {face && !broken.value.has(s.uid) ? (
                <img
                  class="supporter-card__avatar"
                  src={mediaImageUrl(face)}
                  alt={s.name}
                  loading="lazy"
                  onError={() => {
                    broken.value = new Set(broken.value).add(s.uid);
                  }}
                />
              ) : (
                <span class="supporter-card__avatar supporter-card__avatar--initial">
                  {s.name.slice(0, 1)}
                </span>
              )}
              <span class="supporter-card__body">
                <span class="supporter-card__name">{s.name}</span>
                {s.roleKey ? (
                  <span class="supporter-card__role">
                    {t(`about.attribution.${s.roleKey}`)}
                  </span>
                ) : null}
                {s.noteKey ? (
                  <span class="supporter-card__note">
                    {t(`about.attribution.${s.noteKey}`)}
                  </span>
                ) : null}
              </span>
              <span class="supporter-card__platform" aria-hidden="true">
                bilibili
              </span>
            </button>
          );
        })}
      </div>
    );
  },
});
