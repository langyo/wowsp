/**
 * Tactics page (/tactics) — the plan board's full-bleed host.
 *
 * Layout: a top bar carrying the map/mode button (the two-step setup
 * wizard), the lineup editor button and the profile controls (name, save,
 * share), then the workspace — the branch tree on the LEFT (plan forks),
 * the square plan stage in the middle (the removed second map-list drawer
 * freed this whole column), and the overview minimap on the RIGHT (lifted
 * out of the stage's bottom-right corner; the two flanks collapse under a
 * narrow window and the widgets fall back to their in-stage spots).
 *
 * Per-map session state (mode, capture layout, lineup, mirror, profile
 * name) lives in localStorage (tactical/session.ts); plan documents and the
 * branch tree stay where they were (tactical/planSlots.ts). Mode buckets
 * from the replay history feed the wizard's categorised map list, exactly
 * as the old rail computed them.
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getVersion } from "@tauri-apps/api/app";

import { HkIconButton, HkTooltip, useToast } from "@celestia-island/hikari";
import { FolderOpen, Map as MapIcon, Save, Users } from "@lucide/vue";

import { api } from "@/api";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { loadMapBounds, type MapBounds } from "@/features/holographic/modelLoader";
import TacticalPlanStage from "@/features/holographic/tactical/PlanStage";
import MapSetupModal from "@/features/holographic/tactical/MapSetupModal";
import LineupEditorModal from "@/features/holographic/tactical/LineupEditorModal";
import {
  instantiateCaps,
  modePresetOf,
  MODE_PRESETS,
} from "@/features/holographic/tactical/modes";
import {
  resolveUnit,
  spawnPoses,
  type Lineup,
  type PlanUnit,
  type TeamSide,
} from "@/features/holographic/tactical/lineup";
import {
  emptySession,
  loadSession,
  saveSession,
  sessionFromProfileMeta,
  type TacticalSession,
} from "@/features/holographic/tactical/session";
import {
  applyProfilePayload,
  buildProfilePayload,
  openTacticsProfile,
  profileMetaOk,
  saveTacticsProfile,
} from "@/features/holographic/tactical/profile";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { displayMapName, replaysDir } from "@/utils/mapNames";
import { ANALYSABLE_SPACE_IDS, isAnalysableSpace } from "@/utils/tacticsMaps";
import { bucketOf, isPveSpace, type MapModeBucket } from "@/utils/mapModes";
import { modeKey } from "@/utils/modeColors";
import "./TacticsView.scss";

export default defineComponent({
  name: "TacticsView",
  setup() {
    const gd = useGameDetect();
    const encyclopedia = useEncyclopediaStore();
    const toast = useToast();
    const { dataLanguage } = useLanguage();
    const route = useRoute();
    const router = useRouter();

    const activePath = computed(() => gd.config.activeInstall?.path ?? "");

    // ── Selection + session ─────────────────────────────────────────────
    const selected = ref<string>(
      typeof route.query.map === "string" && isAnalysableSpace(route.query.map)
        ? route.query.map
        : (ANALYSABLE_SPACE_IDS[0] ?? ""),
    );
    const session = ref<TacticalSession>(emptySession());

    function loadFor(spaceId: string): void {
      session.value = loadSession(spaceId);
    }
    loadFor(selected.value);

    function persist(): void {
      saveSession(selected.value, session.value);
    }

    // ── World bounds (cap instantiation, spawn poses, mirroring) ────────
    const allBounds = ref<Map<string, MapBounds> | null>(null);
    const bounds = computed<MapBounds | null>(() => {
      const all = allBounds.value;
      if (!all) return null;
      const key = selected.value.replace(/^spaces\//, "");
      return (
        all.get(key) ??
        all.get(key.toLowerCase()) ??
        [...all.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] ??
        null
      );
    });
    onMounted(() => {
      void loadMapBounds().then((all) => {
        allBounds.value = all;
      });
    });
    // A wizard finished before the bounds JSON landed leaves a mode with an
    // empty cap set — complete the instantiation the moment bounds arrive
    // (only when nothing was ever placed: never clobber author-moved caps).
    watch(bounds, (b) => {
      if (!b || session.value.caps.length > 0 || session.value.modeId == null) return;
      const preset = modePresetOf(session.value.modeId);
      if (!preset) return;
      session.value = { ...session.value, caps: instantiateCaps(preset, b) };
      persist();
    });

    // ── Deep link (?map=) both ways ─────────────────────────────────────
    watch(
      () => route.query.map,
      (q) => {
        if (typeof q === "string" && isAnalysableSpace(q) && q !== selected.value) {
          selected.value = q;
        }
      },
    );
    watch(selected, (id) => {
      loadFor(id);
      if (route.query.map !== id) {
        void router.replace({ query: { ...route.query, map: id } });
      }
    });

    // ── Setup wizard (map + mode) ───────────────────────────────────────
    const setupOpen = ref(false);
    /** Wizard result waiting for its map to become the selection (a map
     *  switch reloads the session; the mode lands right after). */
    let pendingMode: { mapId: string; modeId: string } | null = null;

    function onSetupConfirm(mapId: string, modeId: string): void {
      if (mapId !== selected.value) {
        pendingMode = { mapId, modeId };
        selected.value = mapId;
      } else {
        applyMode(modeId);
      }
    }
    watch(selected, (id) => {
      if (pendingMode && pendingMode.mapId === id) {
        const { modeId } = pendingMode;
        pendingMode = null;
        applyMode(modeId);
      }
    });

    /** Switch the session's battle mode: re-instantiate the capture layout
     *  from the preset template over this map's playable rect. */
    function applyMode(modeId: string): void {
      const preset = modePresetOf(modeId);
      const b = bounds.value;
      if (!preset) return;
      session.value = {
        ...session.value,
        modeId,
        caps: b ? instantiateCaps(preset, b) : [],
      };
      persist();
    }

    const durationS = computed(
      () => modePresetOf(session.value.modeId)?.durationS ?? 20 * 60,
    );
    const modeLabel = computed(
      () =>
        (modePresetOf(session.value.modeId) ?? MODE_PRESETS.find((m) => m.id === "random-4"))!
          .labelKey,
    );

    // ── Lineup ──────────────────────────────────────────────────────────
    const lineupOpen = ref(false);

    function onLineupApply(lineup: Lineup): void {
      session.value = { ...session.value, lineup };
      persist();
    }

    /** Board units derived from the session's lineup: one per hull, keyed
     *  by its display name, spawned along its side's edge, mirror pairs by
     *  list index (lineup.ts). Keys are deduped ACROSS both sides — a
     *  mirrored matchup's twin hulls must never share a chain key — so the
     *  second side's duplicate carries a " 2" suffix (the team colours keep
     *  the board readable; the suffix is what keeps the plans apart). */
    const planUnits = computed<PlanUnit[]>(() => {
      const b = bounds.value;
      if (!b) return [];
      const byId = encyclopedia.byId;
      const seen = new Map<string, number>();
      const build = (side: TeamSide, entries: Lineup[TeamSide]): PlanUnit[] => {
        const spawns = spawnPoses(b, side, entries.length);
        return entries.map((entry, i) => {
          const unit = resolveUnit(entry, byId);
          const n = (seen.get(unit.name) ?? 0) + 1;
          seen.set(unit.name, n);
          return {
            key: n > 1 ? `${unit.name} ${n}` : unit.name,
            side,
            unit,
            spawn: spawns[i],
          };
        });
      };
      const ally = build("ally", session.value.lineup.ally);
      const enemy = build("enemy", session.value.lineup.enemy);
      for (let i = 0; i < ally.length; i++) {
        if (i < enemy.length) {
          ally[i].mateKey = enemy[i].key;
          enemy[i].mateKey = ally[i].key;
        }
      }
      return [...ally, ...enemy];
    });

    function toggleMirror(): void {
      session.value = { ...session.value, mirror: !session.value.mirror };
      persist();
    }

    // ── Profile (档案) ───────────────────────────────────────────────────
    const appVersion = ref("");
    /** The game build the plan targets (the WG encyclopedia's version —
     *  null without a network/app context; the archive records what it
     *  knows and never blocks the save on it). */
    const gameVersion = ref<string | null>(null);
    onMounted(() => {
      void getVersion()
        .then((v) => {
          appVersion.value = v;
        })
        .catch(() => {
          // browser dev host — the archive just records an empty version
        });
      void api
        .getGameVersion()
        .then((v) => {
          if (v?.gameVersion) gameVersion.value = v.gameVersion;
        })
        .catch(() => {
          // no WG context — the archive ships a null game version
        });
    });

    function setProfileName(name: string): void {
      session.value = { ...session.value, profileName: name };
      persist();
    }

    async function saveProfile(): Promise<void> {
      try {
        // Flush the board's debounced save first, or the archive misses the
        // last ≤400 ms of edits (the slot duplicator's rule).
        stageRef.value?.flushDoc?.();
        const saved = await saveTacticsProfile(
          buildProfilePayload(selected.value, displayMapName(selected.value, dataLanguage.value), session.value, {
            appVersion: appVersion.value,
            gameVersion: gameVersion.value,
          }),
        );
        if (saved) toast.info(t("tactics.profile.saved", { path: saved }));
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      }
    }

    async function openProfile(): Promise<void> {
      try {
        const payload = await openTacticsProfile();
        if (!payload || !profileMetaOk(payload.meta)) return;
        // Flush the CURRENT board before the import rewrites its keys — a
        // pending debounced save would otherwise land after the import and
        // overwrite the plan the profile just installed.
        stageRef.value?.flushDoc?.();
        const spaceId = applyProfilePayload(payload);
        if (!isAnalysableSpace(spaceId)) {
          toast.error(t("tactics.profile.unknownMap", { map: payload.meta.mapName || spaceId }));
          return;
        }
        // The archive carries the whole session, not just the plans: mode,
        // caps, lineup, mirror and the profile name land with it.
        const restored = sessionFromProfileMeta(payload.meta);
        saveSession(spaceId, restored);
        if (spaceId !== selected.value) {
          // Switch first; the selected watcher loads the freshly written
          // session and a fresh stage (key remount) reads the new slots.
          selected.value = spaceId;
        } else {
          // Same map: the stage did NOT remount — make it re-read the
          // freshly imported slots + document (flush already ran above).
          stageRef.value?.reloadSlots?.();
          session.value = restored;
        }
        toast.info(t("tactics.profile.opened", { n: payload.plans.length }));
      } catch (e) {
        toast.error(t("tactics.profile.openBad", { detail: String((e as Error)?.message ?? e) }));
      }
    }

    // ── Mode buckets from the replay history (the wizard's categories) ──
    const observed = ref<Map<string, Set<MapModeBucket>>>(new Map());
    let historySeq = 0;
    async function loadHistory(): Promise<void> {
      const seq = ++historySeq;
      const acc = new Map<string, Set<MapModeBucket>>();
      if (activePath.value) {
        try {
          const metas = await api.listReplaysMeta(replaysDir(activePath.value));
          for (const m of metas) {
            if (!m.mapName) continue;
            const b = bucketOf(
              modeKey(
                m.matchGroup,
                m.scenario,
                m.eventType,
                m.botCount ?? 0,
                m.scriptedUnitCount ?? 0,
              ),
            );
            let set = acc.get(m.mapName);
            if (!set) acc.set(m.mapName, (set = new Set()));
            set.add(b);
          }
        } catch {
          // history is enrichment only — empty buckets are fine
        }
      }
      if (seq !== historySeq) return;
      observed.value = acc;
    }
    onMounted(() => {
      void gd.detect().then(() => {
        if (activePath.value) void loadHistory();
      });
    });
    watch(activePath, (p, prev) => {
      if (p && p !== prev) void loadHistory();
    });

    /** Buckets a map counts as: observed history plus the static PVE
     *  fingerprint, defaulting to "random" so every map stays reachable. */
    function bucketsOf(spaceId: string): Set<MapModeBucket> {
      const set = new Set<MapModeBucket>();
      if (isPveSpace(spaceId)) set.add("pve");
      const obs = observed.value.get(spaceId);
      if (obs) for (const b of obs) set.add(b);
      if (set.size === 0) set.add("random");
      return set;
    }

    /** The plan stage's document handles (flush / reload) for the profile
     *  actions — same contract the slot bar's import already uses. */
    const stageRef = ref<{
      flushDoc: () => void;
      reloadDoc: () => void;
      reloadSlots: () => void;
    } | null>(null);

    // ── Flanking panels: only on wide windows. The stage's teleported
    //    widgets (branch tree / minimap) fall back to their in-stage spots
    //    when the docks are absent (Teleport disabled). ─────────────────
    const wide = ref(window.matchMedia("(min-width: 1180px)").matches);
    const mq = window.matchMedia("(min-width: 1180px)");
    const onMq = (): void => {
      wide.value = mq.matches;
    };
    onMounted(() => mq.addEventListener("change", onMq));
    onBeforeUnmount(() => mq.removeEventListener("change", onMq));

    return () => {
      const sel = selected.value;
      const mapLabel = displayMapName(sel, dataLanguage.value);
      return (
        <div class="tac-page">
          <header class="tac-topbar">
            <HkTooltip text={t("tactics.setup.title")} placement="bottom">
              <button
                type="button"
                class="tac-topbar__map"
                onClick={() => (setupOpen.value = true)}
              >
                <MapIcon size={14} />
                <span class="tac-topbar__map-name">{mapLabel || t("tactics.setup.title")}</span>
                <span class="tac-topbar__map-mode">{t(`tactics.mode.${modeLabel.value}`)}</span>
              </button>
            </HkTooltip>

            <HkTooltip text={t("tactics.lineup.title")} placement="bottom">
              <HkIconButton size={28} onClick={() => (lineupOpen.value = true)}>
                <Users size={14} />
              </HkIconButton>
            </HkTooltip>

            <span class="tac-topbar__spacer" />

            <input
              class="tac-topbar__profile-name"
              value={session.value.profileName}
              placeholder={t("tactics.profile.namePlaceholder")}
              title={t("tactics.profile.name")}
              onInput={(e: Event) => setProfileName((e.target as HTMLInputElement).value)}
            />
            <HkTooltip text={t("tactics.profile.save")} placement="bottom">
              <HkIconButton size={28} onClick={() => void saveProfile()}>
                <Save size={14} />
              </HkIconButton>
            </HkTooltip>
            <HkTooltip text={t("tactics.profile.open")} placement="bottom">
              <HkIconButton size={28} onClick={() => void openProfile()}>
                <FolderOpen size={14} />
              </HkIconButton>
            </HkTooltip>
          </header>

          <main class="tac-workspace">
            {wide.value ? (
              <aside class="tac-workspace__branch" id="tactics-branch-dock" />
            ) : null}
            <section class="tac-workspace__stage">
              <TacticalPlanStage
                ref={stageRef}
                key={sel}
                spaceId={sel}
                mapName={mapLabel}
                durationS={durationS.value}
                planUnits={planUnits.value}
                mirror={session.value.mirror}
                onToggleMirror={toggleMirror}
                onEditLineup={() => (lineupOpen.value = true)}
                caps={session.value.caps}
                slotsTeleport={wide.value ? "#tactics-branch-dock" : undefined}
                minimapTeleport={wide.value ? "#tactics-minimap-dock" : undefined}
              />
            </section>
            {wide.value ? (
              <aside class="tac-workspace__side" id="tactics-minimap-dock" />
            ) : null}
          </main>

          <MapSetupModal
            modelValue={setupOpen.value}
            onUpdate:modelValue={(v: boolean) => (setupOpen.value = v)}
            currentMapId={sel}
            currentModeId={session.value.modeId}
            spaceIds={[...ANALYSABLE_SPACE_IDS]}
            bucketsOf={bucketsOf}
            onConfirm={onSetupConfirm}
          />
          <LineupEditorModal
            modelValue={lineupOpen.value}
            onUpdate:modelValue={(v: boolean) => (lineupOpen.value = v)}
            lineup={session.value.lineup}
            mapName={mapLabel}
            onApply={onLineupApply}
          />
        </div>
      );
    };
  },
});
