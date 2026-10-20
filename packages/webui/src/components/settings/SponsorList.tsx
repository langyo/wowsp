import { defineComponent, onMounted, ref } from "vue";
import { HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { api, type SponsorEntry } from "@/api";
import { t } from "@/i18n";
import { mediaImageUrl } from "@/utils/media";
import { openExternal } from "@/utils/openExternal";
import "./SponsorList.scss";

/**
 * The credits section's bottom group: the afdian sponsor list. The rows
 * come from the pairing relay's /api/sponsors via `get_sponsor_list`
 * (live, else the AppData last-good cache, else nothing — see
 * commands/supporters.rs) ALREADY SORTED by the worker: current-month
 * paid, then all-time paid, then earliest first payment. This component
 * only renders them, as compact chips; a chip opens the sponsor's
 * public afdian profile in the external browser. The remark-carried
 * game ID stays DORMANT for now (the worker still parses and serves it,
 * but the chip-to-lookup jump is parked until the false positives from
 * free-text remarks are worth solving). Zero rows (relay cold, offline,
 * browser dev) hides the whole group.
 */
export default defineComponent({
  name: "SponsorList",
  setup() {
    const sponsors = ref<SponsorEntry[]>([]);
    /** userIds whose <img> failed to decode — back to the initial disc. */
    const broken = ref(new Set<string>());

    onMounted(() => {
      api
        .getSponsorList()
        .then((doc) => {
          sponsors.value = doc.sponsors;
        })
        .catch(() => {
          // offline / older shell / browser dev — the group hides
        });
    });

    return () => {
      if (sponsors.value.length === 0) return null;
      return (
        <HkSettingsGroup title={t("settings.sponsorListTitle")}>
          <HkSettingsHint>{t("settings.sponsorListHint")}</HkSettingsHint>
          <div class="sponsor-list">
            {sponsors.value.map((sponsor) => {
              const url = `https://afdian.com/u/${sponsor.userId}`;
              return (
                <button
                  type="button"
                  class={{
                    "sponsor-chip": true,
                    "sponsor-chip--active": sponsor.active,
                  }}
                  key={sponsor.userId}
                  data-hint={url}
                  onClick={() => void openExternal(url)}
                >
                  {sponsor.avatar && !broken.value.has(sponsor.userId) ? (
                    <img
                      class="sponsor-chip__avatar"
                      src={mediaImageUrl(sponsor.avatar)}
                      alt={sponsor.name}
                      loading="lazy"
                      onError={() => {
                        broken.value = new Set(broken.value).add(sponsor.userId);
                      }}
                    />
                  ) : (
                    <span class="sponsor-chip__avatar sponsor-chip__avatar--initial">
                      {sponsor.name.slice(0, 1)}
                    </span>
                  )}
                  <span class="sponsor-chip__name">{sponsor.name}</span>
                  {sponsor.active ? (
                    <span class="sponsor-chip__dot" aria-hidden={true} />
                  ) : null}
                </button>
              );
            })}
          </div>
        </HkSettingsGroup>
      );
    };
  },
});
