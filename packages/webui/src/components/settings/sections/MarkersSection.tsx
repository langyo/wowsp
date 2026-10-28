/** Player markers settings section (玩家标记): add/remove local colored
 *  markers (red = 消极作战, yellow = 疑似作弊, purple = 隐藏高手) and review
 *  the list. Strictly local data — no login, no sync, no upload. */
import { computed, defineComponent, ref } from "vue";
import type { PropType } from "vue";
import {
  HkButton,
  HkInput,
  HkScrollContainer,
  HkSettingsGroup,
  HkSettingsHint,
  HkTabs,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import { MARKER_COLORS, useMarkersStore } from "@/stores/markers";
import type { MarkerColor, MarkerEntry } from "@/api";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import "./MarkersSection.scss";

/** The color tabs, in the store's list order. */
const COLOR_TAB_LABEL_KEYS: Record<MarkerColor, string> = {
  red: "settings.markersColorRed",
  yellow: "settings.markersColorYellow",
  purple: "settings.markersColorPurple",
};

function colorLabel(color: MarkerColor): string {
  return t(COLOR_TAB_LABEL_KEYS[color]);
}

export default defineComponent({
  name: "SettingsMarkersSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup() {
    const store = useMarkersStore();
    void store.ensureLoaded();

    const nameInput = ref("");
    const noteInput = ref("");
    const color = ref<MarkerColor>("red");
    const adding = ref(false);

    function colorTabs() {
      return MARKER_COLORS.map((key) => ({ key, label: colorLabel(key) }));
    }

    async function addMarker(): Promise<void> {
      const nickname = nameInput.value.trim();
      if (!nickname || adding.value) return;
      adding.value = true;
      try {
        await store.add(nickname, color.value, noteInput.value.trim() || null);
        nameInput.value = "";
        noteInput.value = "";
      } finally {
        adding.value = false;
      }
    }

    const search = ref("");
    const filtered = computed<MarkerEntry[]>(() => {
      const entries = store.entries;
      const q = search.value.trim().toLowerCase();
      if (!q) return entries;
      return entries.filter(
        (entry) =>
          entry.nickname.toLowerCase().includes(q) ||
          (entry.note ?? "").toLowerCase().includes(q) ||
          String(entry.accountId ?? "").includes(q),
      );
    });
    const countText = computed(() =>
      t("settings.markersCount", { n: store.entries.length }),
    );

    return () => (
      <>
        <HkSettingsGroup title={t("settings.markersTitle")}>
          <HkSettingsHint>{t("settings.markersHint")}</HkSettingsHint>
          <div class="markers-section__add">
            <div class="markers-section__add-row">
              <div class="markers-section__add-input">
                <HkInput
                  modelValue={nameInput.value}
                  onUpdate:modelValue={(v: string) => (nameInput.value = v)}
                  placeholder={t("settings.markersNamePlaceholder")}
                  submitOnEnter={() => void addMarker()}
                />
              </div>
              <div class="markers-section__add-input">
                <HkInput
                  modelValue={noteInput.value}
                  onUpdate:modelValue={(v: string) => (noteInput.value = v)}
                  placeholder={t("settings.markersNotePlaceholder")}
                  submitOnEnter={() => void addMarker()}
                />
              </div>
              <HkButton size="sm" disabled={!nameInput.value.trim() || adding.value} onClick={() => void addMarker()}>
                {t("settings.markersAdd")}
              </HkButton>
            </div>
            <HkTabs
              block
              variant="segmented"
              modelValue={color.value}
              onUpdate:modelValue={(v: string) => (color.value = v as MarkerColor)}
              tabs={colorTabs()}
            />
          </div>
        </HkSettingsGroup>

        <HkSettingsGroup title={t("settings.markersListTitle")}>
          <div class="markers-section__row">
            <div class="markers-section__search">
              <HkInput
                modelValue={search.value}
                onUpdate:modelValue={(v: string) => (search.value = v)}
                placeholder={t("settings.markersSearchPlaceholder")}
              />
            </div>
            <span class="markers-section__muted">{countText.value}</span>
          </div>
          <HkScrollContainer class="markers-section__list">
            <div class="markers-section__list-inner">
              {filtered.value.length === 0 ? (
                <p class="markers-section__muted">{t("settings.markersEmpty")}</p>
              ) : (
                filtered.value.map((entry) => (
                  <div class="markers-section__entry" key={entry.nickname}>
                    <span
                      class={["markers-section__dot", `markers-section__dot--${entry.color}`]}
                      title={colorLabel(entry.color)}
                    />
                    <span class="markers-section__entry-name">{entry.nickname}</span>
                    {entry.note ? (
                      <span class="markers-section__entry-note">{entry.note}</span>
                    ) : null}
                    <span class="markers-section__entry-id">
                      {entry.accountId ?? ""}
                    </span>
                    <HkButton
                      size="sm"
                      onClick={() => {
                        void store.remove(entry.nickname);
                      }}
                    >
                      {t("settings.markersRemove")}
                    </HkButton>
                  </div>
                ))
              )}
            </div>
          </HkScrollContainer>
        </HkSettingsGroup>
      </>
    );
  },
});
