/**
 * Live self-stats panel (我的战绩) — the /live page's second body, mounted
 * while the title-bar's 全员/我的 switch reads "mine". The in-game results
 * screen's page 1 + page 3 fused into one live view: my running damage /
 * plane damage / hits / taken / frags (server-authoritative totals from the
 * recorder's damage stream), the damage-composition strip, the achievements
 * earned so far, and the per-ship damage ledger both ways — whom I hurt
 * (and sank) and who hurt me — rebuilt every few seconds off the game's
 * in-progress temp replay (see stores/liveSelf.ts +
 * features/replay/liveSelfStats.ts).
 *
 * The body itself is the shared SelfReportBody (the replay results modal's
 * "我的" view renders the exact same component); this host owns the head —
 * the LIVE/settled pills, the battle clock, the map tag and the share
 * actions: copy-shot (the watermarked PNG pipeline, rendered through the
 * shared selfReportView model so the copied image matches the panel) and
 * the ephemeral hide-nicknames toggle — masked nicks never reach the
 * copied image.
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties,
} from "vue";
import { Camera, Eye, EyeOff } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import type { ArenaInfo } from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { shareFooterStrings } from "@/features/share/shotKit";
import { useShareImage } from "@/features/share/useShareImage";
import { useLiveSelfStore } from "@/stores/liveSelf";
import { displayMapName } from "@/utils/mapNames";
import { modeColor, modeKey } from "@/utils/modeColors";
import { useNickMasking } from "./postBattleShare";
import { renderLiveSelfShot, type SelfShotModel } from "./liveSelfShot";
import { buildSelfShotModel, fmtClock } from "./selfReportView";
import type { SelfStatsModel } from "./liveSelfStats";
import { useBattleClock } from "./useBattleClock";
import MapNameTag from "./MapNameTag";
import SelfReportBody from "./SelfReportBody";
import { WaitingRadarArt } from "./liveGuideArt";
import "./LiveBattlePanel.scss";
import "./LiveSelfPanel.scss";

/** Localize a battle mode from its layered identity (matchGroup / scenario /
 *  battle script / roster bots) — the roster panel's helper, verbatim. */
function modeLabelOf(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
  scriptedUnitCount = 0,
): string {
  const key = modeKey(group, scenario, eventType, botCount, scriptedUnitCount);
  if (!key) return t("replay.mode._fallback");
  const i18nKey = "replay.mode." + key;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

export default defineComponent({
  name: "LiveSelfPanel",
  props: {
    arena: { type: Object as () => ArenaInfo | null, default: null },
    settling: { type: Boolean, default: false },
    ended: { type: Boolean, default: false },
    /** The just-finished battle's replay path (LiveView's settling signal):
     *  swapped in for the authoritative full parse. */
    settledReplay: { type: String, default: null },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();
    const live = useLiveSelfStore();
    const masking = useNickMasking();
    const root = ref<HTMLElement | null>(null);
    const { label: clockLabel } = useBattleClock(() => props.arena?.dateTime ?? null);

    // The store mirrors the arena (a fresh dateTime wipes the previous
    // battle's model) and parses the settled replay exactly once per battle.
    watch(
      () => props.arena,
      (a) => live.setArena(a),
      { immediate: true },
    );
    watch(
      () => props.settledReplay,
      (p) => {
        if (p) void live.settle(p);
      },
      { immediate: true },
    );
    onMounted(() => live.attach());
    onBeforeUnmount(() => live.detach());

    const model = computed<SelfStatsModel | null>(() => live.model);

    /** The battle-mode pill data (label + colors) for the share shot — the
     *  head's pill builds its own span, same vocabulary. */
    const shotMode = (): SelfShotModel["mode"] => {
      const arena = props.arena;
      if (!arena?.matchGroup) return null;
      const c = modeColor(
        arena.matchGroup,
        arena.scenario,
        arena.eventType,
        arena.botCount ?? 0,
        arena.scriptedUnitCount ?? 0,
      );
      return {
        label: modeLabelOf(
          arena.matchGroup,
          arena.scenario,
          arena.eventType,
          arena.botCount ?? 0,
          arena.scriptedUnitCount ?? 0,
        ),
        color: c.color,
        background: c.background,
      };
    };

    // ── share shot (the post-battle panels' copy pipeline, one shared
    //    model builder with the results modal's self view). */
    const shot = useShareImage(() =>
      renderLiveSelfShot(
        buildSelfShotModel(model.value, {
          title: t("replay.live.selfTitle"),
          mode: shotMode(),
          mapLabel: props.arena?.mapName
            ? displayMapName(props.arena.mapName, dataLanguage.value)
            : null,
          metaLine: model.value
            ? model.value.final
              ? t("replay.live.selfSettled")
              : t("replay.live.selfSyncAt", { time: fmtClock(model.value.battleTime) })
            : null,
          selfLine: model.value
            ? `${masking.maskOf(model.value.selfName ?? "")}${model.value.selfShipId != null ? " · " + (shipNameFromOfflineDb(model.value.selfShipId, dataLanguage.value) ?? "") : ""}`
            : "",
          lang: dataLanguage.value,
          maskOf: masking.maskOf,
          estimateNote: t("replay.live.selfEstimate"),
        }),
        {
          el: root.value,
          ...shareFooterStrings(),
        },
      ),
    );

    // Reactive like the roster panel's own pill: the panel can mount while
    // the game runs but tempArenaInfo.json has yet to appear — a setup-time
    // const would stay null (or stale after a second battle) forever.
    const modePill = computed(() => {
      const arena = props.arena;
      if (!arena?.matchGroup) return null;
      return (
        <span
          class="live-battle__pill"
          style={
            modeColor(
              arena.matchGroup,
              arena.scenario,
              arena.eventType,
              arena.botCount ?? 0,
              arena.scriptedUnitCount ?? 0,
            ) as CSSProperties
          }
        >
          {modeLabelOf(
            arena.matchGroup,
            arena.scenario,
            arena.eventType,
            arena.botCount ?? 0,
            arena.scriptedUnitCount ?? 0,
          )}
        </span>
      );
    });

    return () => {
      // No roster at all (game off / between battles): the same radar-scope
      // waiting state the roster panel shows.
      if (!props.arena || props.arena.vehicles.length === 0) {
        return (
          <div class="live-battle live-battle--empty">
            <WaitingRadarArt class="live-battle__empty-art" />
            <p class="live-battle__empty-title">{t("replay.live.waitingTitle")}</p>
            <p class="live-battle__empty-hint">{t("replay.live.selfWaitingHint")}</p>
          </div>
        );
      }

      const m = model.value;

      return (
        <div class="live-battle live-self" ref={root}>
          <div class="live-battle__head live-battle__head--status">
            <h1 class="live-battle__title">{t("replay.live.selfTitle")}</h1>
            {props.ended ? (
              <span class="live-battle__pill live-battle__pill--ended">
                {t("replay.live.ended")}
              </span>
            ) : props.settling ? (
              <span class="live-battle__pill live-battle__pill--settling">
                {t("replay.live.settling")}
              </span>
            ) : (
              <span class="live-battle__pill live-battle__pill--live">LIVE</span>
            )}
            {modePill.value}
            {!props.ended && clockLabel.value ? (
              <span class="live-battle__clock">{clockLabel.value}</span>
            ) : null}
            <MapNameTag
              class="live-battle__map"
              spaceId={props.arena.mapName}
              lang={dataLanguage.value}
            />
            {/* Snapshot sync state: the temp-replay decode's own clock —
                同步至 M:SS while live, the settled badge once final. */}
            {m ? (
              <span
                class={[
                  "live-battle__pill",
                  m.final ? "live-battle__pill--ended" : "live-self__sync",
                ]}
              >
                {m.final
                  ? t("replay.live.selfSettled")
                  : t("replay.live.selfSyncAt", { time: fmtClock(m.battleTime) })}
              </span>
            ) : (
              <span class="live-battle__pill live-self__sync">
                <HkSpinner size="xs" tone="current" />
                {t("replay.live.selfSyncing")}
              </span>
            )}
            <button
              class="live-battle__shot-btn"
              type="button"
              disabled={shot.busy.value || !m}
              onClick={() => void shot.copyShot()}
            >
              {shot.busy.value ? <HkSpinner size="xs" tone="current" /> : <Camera size={13} />}
              {t("share.copyShot")}
            </button>
            <button
              class={[
                "live-battle__mask-btn",
                { "live-battle__mask-btn--on": masking.hideAll.value },
              ]}
              type="button"
              onClick={() => masking.toggleAll()}
            >
              {masking.hideAll.value ? <Eye size={13} /> : <EyeOff size={13} />}
              {masking.hideAll.value
                ? t("replay.live.showNicks")
                : t("replay.live.hideNicks")}
            </button>
          </div>

          <div class="live-self__body">
            {!m ? (
              <div class="live-self__pending">
                <WaitingRadarArt class="live-self__pending-art" />
                <p class="live-self__pending-title">{t("replay.live.selfSyncing")}</p>
                <p class="live-self__pending-hint">{t("replay.live.selfSyncingHint")}</p>
                {live.error ? <p class="live-self__pending-err">{live.error}</p> : null}
              </div>
            ) : (
              <SelfReportBody model={m} maskOf={masking.maskOf} />
            )}
          </div>
        </div>
      );
    };
  },
});
