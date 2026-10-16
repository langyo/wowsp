/** Attributions settings section: supporters, sponsor, upstream projects
 *  and resource partners. */
import { defineComponent } from "vue";
import { HkSettingsGroup, HkSettingsHint } from "@celestia-island/hikari";

import { t } from "@/i18n";
import AuthorMark from "@/components/base/AuthorMark";
import SupporterCards from "@/components/settings/SupporterCards";
import SponsorCard from "@/components/settings/SponsorCard";
import {
  RESOURCE_ATTRIBUTIONS,
  UPSTREAM_ATTRIBUTIONS,
} from "@/data/attributions";

export default defineComponent({
  name: "SettingsAttributionsSection",
  setup() {
    return () => (
          <>
          {/* attributions — the categorized supporter page: SPECIAL
              THANKS first (cards with live Bilibili avatars, the whole
              card opens their space page), then the author's afdian
              SPONSOR card, then the upstream projects, and the asset /
              resource partners LAST. The same AuthorMark component
              annotates the desktop wallpaper. */}
          <HkSettingsGroup title={t("settings.supportersTitle")}>
            <HkSettingsHint>{t("settings.supportersHint")}</HkSettingsHint>
            <SupporterCards />
          </HkSettingsGroup>
          {/* sponsor — second group: one wide card opening the author's
              afdian page, carrying the per-locale sponsor disclaimers
              (what the funds buy, voluntary, no hiring relation, open
              source with no sponsor-gated features, no WG/Lesta/360
              affiliation). */}
          <HkSettingsGroup title={t("settings.sponsorTitle")}>
            <HkSettingsHint>{t("settings.sponsorHint")}</HkSettingsHint>
            <SponsorCard />
          </HkSettingsGroup>
          <HkSettingsGroup title={t("settings.upstreamTitle")}>
            <HkSettingsHint>{t("settings.upstreamHint")}</HkSettingsHint>
            <div class="settings-modal__attributions">
              {UPSTREAM_ATTRIBUTIONS.map((a) => (
                <div key={a.id} class="settings-modal__attribution">
                  <AuthorMark name={a.name} url={a.url} role={t(`about.attribution.${a.roleKey}`)} />
                  {a.noteKey ? <HkSettingsHint>{t(`about.attribution.${a.noteKey}`)}</HkSettingsHint> : null}
                </div>
              ))}
            </div>
          </HkSettingsGroup>
          <HkSettingsGroup title={t("settings.resourcesTitle")}>
            <HkSettingsHint>{t("settings.resourcesHint")}</HkSettingsHint>
            <div class="settings-modal__attributions">
              {RESOURCE_ATTRIBUTIONS.map((a) => (
                <div key={a.id} class="settings-modal__attribution">
                  <AuthorMark name={a.name} url={a.url} role={t(`about.attribution.${a.roleKey}`)} />
                  {a.noteKey ? <HkSettingsHint>{t(`about.attribution.${a.noteKey}`)}</HkSettingsHint> : null}
                </div>
              ))}
            </div>
          </HkSettingsGroup>
          </>
    );
  },
});
