import { defineComponent, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { api, type SponsorEntry } from "@/api";
import { t } from "@/i18n";
import { useAccountStore } from "@/stores/account";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { mediaImageUrl } from "@/utils/media";
import { openExternal } from "@/utils/openExternal";
import "./SponsorList.scss";

/**
 * The credits section's bottom group: the afdian sponsor list. The rows
 * come from the pairing relay's /api/sponsors via `get_sponsor_list`
 * (live, else the AppData last-good cache, else nothing — see
 * commands/supporters.rs) ALREADY SORTED by the worker: current-month
 * paid, then all-time paid, then earliest first payment. This component
 * only renders them, as compact chips.
 *
 * A chip whose sponsor left a recognizable GAME ID in an order remark
 * jumps to the lookup page for that player — the remark cannot carry a
 * realm, so the search seeds from the app's active realm (the picker on
 * the lookup page is one tap away if the guess is wrong). Every other
 * chip opens the sponsor's public afdian profile in the external
 * browser. Zero rows (relay cold, offline, browser dev) hides the whole
 * group.
 */
export default defineComponent({
  name: "SponsorList",
  setup() {
    const router = useRouter();
    const settings = useSettingsUiStore();
    const accounts = useAccountStore();

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

    const openSponsor = (sponsor: SponsorEntry): void => {
      const gameId = sponsor.gameId?.trim();
      if (gameId) {
        // The settings surface must not cover the route this lands on
        // (the desktop modal overlays the whole app window).
        settings.hide();
        void router.push({
          path: "/lookup",
          query: { name: gameId, realm: accounts.activeRealm },
        });
        return;
      }
      void openExternal(`https://afdian.com/u/${sponsor.userId}`);
    };

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
                  data-hint={sponsor.gameId ? t("settings.sponsorListLookupHint") : url}
                  onClick={() => openSponsor(sponsor)}
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
