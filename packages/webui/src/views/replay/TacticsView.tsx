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

import { HkIconButton, HkPopover, HkTooltip, useToast } from "@celestia-island/hikari";
import { Check, FileArchive, FolderOpen, Map as MapIcon, Save, Users } from "@lucide/vue";

import { api } from "@/api";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { loadMapBounds, type MapBounds } from "@/features/holographic/modelLoader";
import { loadMapInsights, type MapInsightsDoc } from "@/features/holographic/insightsLoader";
import TacticalPlanStage from "@/features/holographic/tactical/PlanStage";
import {
  resolveHeatOverlay,
  type HeatLayerMode,
  type HeatOverlayData,
} from "@/features/holographic/tactical/heatLayer";
import MapSetupModal, { type MapSetupChoice } from "@/features/holographic/tactical/MapSetupModal";
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
    /** Case-tolerant bounds lookup (the minimaps.json keys use the bare
     *  space id; a `spaces/` prefix and case drift both resolve). */
    function boundsOf(spaceId: string): MapBounds | null {
      const all = allBounds.value;
      if (!all) return null;
      const key = spaceId.replace(/^spaces\//, "");
      return (
        all.get(key) ??
        all.get(key.toLowerCase()) ??
        [...all.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] ??
        null
      );
    }
    const bounds = computed<MapBounds | null>(() => boundsOf(selected.value));
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
     *  switch reloads the session; the choice lands right after). */
    let pendingMode: { mapId: string; choice: MapSetupChoice } | null = null;

    function onSetupConfirm(mapId: string, choice: MapSetupChoice): void {
      // The archive's save target is confirmed the moment a NEW map is
      // boarded (generated name pre-seeds the native dialog). Re-confirming
      // the SAME map keeps the existing identity — a tweak must not wipe
      // the display name or re-ask the path.
      if (mapId !== selected.value) void confirmProfilePath(mapId);
      if (mapId !== selected.value) {
        pendingMode = { mapId, choice };
        selected.value = mapId;
      } else {
        applyChoice(choice);
      }
    }
    watch(selected, (id) => {
      if (pendingMode && pendingMode.mapId === id) {
        const { choice } = pendingMode;
        pendingMode = null;
        applyChoice(choice);
      }
    });

    /** Apply the wizard's step-2 choice: a MEASURED layout lands its exact
     *  replay-learned points (radius included, letters by point index,
     *  ownership left neutral — the replay's team orientation vs the
     *  board's ally-south spawn is not inferable from the layout alone);
     *  a CUSTOM layout lands exactly what the second-level editor
     *  confirmed (hand-moved points, template starts, imported replays). */

    function applyChoice(choice: MapSetupChoice): void {
      if (choice.kind === "learned") {
        session.value = {
          ...session.value,
          modeId: null,
          // The applied layout's raw match-group — the key the heat overlay
          // resolves against the corpus doc (a preset has no such key).
          modeGroup: choice.layout.modeGroup ?? null,
          caps: choice.layout.caps.map((c) => ({
            letter: String.fromCharCode(65 + Math.max(0, Math.min(25, c.index))),
            at: { x: c.x, z: c.z },
            radius: c.radius ?? 115,
            team: null,
            ...(c.appearT != null && c.appearT > 0 ? { appearT: c.appearT } : {}),
          })),
        };
        persist();
        return;
      }
      session.value = {
        ...session.value,
        modeId: null,
        // A hand-authored layout carries no corpus mode key either.
        modeGroup: null,
        caps: choice.caps.map((c) => ({ ...c, at: { ...c.at } })),
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

    // ── Corpus heat overlay (the map-insights rail's spawn/track grids) ──
    // Pack-first with the bundled lite fallback — the same doc the setup
    // wizard's corpus rows read; until it resolves (or forever, on the lite
    // placeholder that carries no grids) the overlay simply stays empty.
    const mapInsights = ref<MapInsightsDoc | null>(null);
    onMounted(() => {
      void loadMapInsights()
        .then((doc) => {
          mapInsights.value = doc;
        })
        .catch(() => {
          // Unresolvable corpus — heat stays unavailable (null data).
        });
    });
    /** The current (map, mode)'s corpus heat grids; null without coverage
     *  (placeholder doc, unset/unknown mode) — the toolbar's button then
     *  renders disabled with the no-data hint. */
    const heatData = computed<HeatOverlayData | null>(() =>
      resolveHeatOverlay(
        mapInsights.value,
        selected.value,
        session.value.modeId,
        session.value.modeGroup,
      ),
    );

    function setHeat(mode: HeatLayerMode): void {
      session.value = { ...session.value, heat: mode };
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

    /** Rename popover state (the top-right tag's editor). */
    const renameOpen = ref(false);
    const renameText = ref("");
    const renameAnchor = ref<HTMLElement | null>(null);

    function setProfileName(name: string): void {
      session.value = { ...session.value, profileName: name.trim() };
      persist();
    }

    /** The formal archive name: the custom display name, else the generated
     *  file name's base (date-time + map + sequence), else the untitled
     *  placeholder. This is what the top-right tag shows. */
    const profileLabel = computed(() => {
      if (session.value.profileName) return session.value.profileName;
      const base = session.value.fileName?.replace(/\.wowsp-tactics$/i, "");
      if (base) return base;
      return t("tactics.profile.untitled");
    });

    /** Sequential archive file name: current date-time + the map's main
     *  display name + a per-(day, map) running number, so re-running the
     *  wizard for the same map on the same day never collides. */
    function newProfileFileName(mapId: string, mapLabel: string): string {
      const now = new Date();
      const pad = (n: number): string => String(n).padStart(2, "0");
      const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
      const safe = mapLabel.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || mapId;
      const key = `wowsp:tactics:profileseq:v1:${day}:${mapId}`;
      let seq = 1;
      try {
        seq = Number(window.localStorage.getItem(key) ?? "0") + 1;
        window.localStorage.setItem(key, String(seq));
      } catch {
        // storage unavailable — the dialog prefill is editable anyway
      }
      return `${day}_${time}_${safe}_${String(seq).padStart(2, "0")}`;
    }

    /** Confirm the archive's save target right after the map is chosen:
     *  one native save dialog pre-seeded with the generated name. A
     *  confirmed path becomes the profile's silent save target; cancelling
     *  keeps the dialog flow at save time. */
    async function confirmProfilePath(mapId: string): Promise<void> {
      const mapLabel = displayMapName(mapId, dataLanguage.value);
      const fileName = newProfileFileName(mapId, mapLabel);
      let path: string | null = null;
      try {
        path = await api.pickExportPath(`${fileName}.wowsp-tactics`, "WoWSP tactics profile", [
          "wowsp-tactics",
        ]);
      } catch {
        // non-Tauri host — no dialog; keep the name, save stays dialogless
      }
      session.value = { ...session.value, fileName, profilePath: path };
      persist();
    }

    async function saveProfile(): Promise<void> {
      try {
        // Flush the board's debounced save first, or the archive misses the
        // last ≤400 ms of edits (the slot duplicator's rule).
        stageRef.value?.flushDoc?.();
        const payload = buildProfilePayload(
          selected.value,
          displayMapName(selected.value, dataLanguage.value),
          session.value,
          { appVersion: appVersion.value, gameVersion: gameVersion.value },
        );
        // The generated file name seeds the archive's default name; a
        // confirmed save target writes straight there, silently.
        const meta = { ...payload.meta, fileName: session.value.fileName ?? undefined };
        const saved = await saveTacticsProfile(
          { ...payload, meta },
          session.value.profilePath ?? undefined,
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
        // caps, lineup, mirror and the profile name land with it — and the
        // opened file becomes the silent save target (path + file name).
        const restored = sessionFromProfileMeta(payload.meta);
        restored.profilePath = payload.path ?? null;
        restored.fileName =
          payload.path?.split(/[\\/]/).pop()?.replace(/\.wowsp-tactics$/i, "") ?? null;
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
                {session.value.modeId != null ? (
                  <span class="tac-topbar__map-mode">{t(`tactics.mode.${modeLabel.value}`)}</span>
                ) : null}
              </button>
            </HkTooltip>

            <HkTooltip text={t("tactics.lineup.title")} placement="bottom">
              <HkIconButton size={28} onClick={() => (lineupOpen.value = true)}>
                <Users size={14} />
              </HkIconButton>
            </HkTooltip>

            <span class="tac-topbar__spacer" />

            <span ref={renameAnchor} class="tac-topbar__profile-wrap">
              <HkTooltip text={t("tactics.profile.rename")} placement="bottom">
                <button
                  type="button"
                  class="tac-topbar__profile-tag"
                  onClick={() => {
                    renameText.value = session.value.profileName;
                    renameOpen.value = !renameOpen.value;
                  }}
                >
                  <FileArchive size={12} />
                  <span class="tac-topbar__profile-tag-name">{profileLabel.value}</span>
                  {session.value.profilePath ? (
                    <span class="tac-topbar__profile-tag-dot" title={session.value.profilePath} />
                  ) : null}
                </button>
              </HkTooltip>
              <HkPopover
                modelValue={renameOpen.value}
                onUpdate:modelValue={(v: boolean) => {
                  if (!v) renameOpen.value = false;
                }}
                anchorRef={renameAnchor.value}
                placement="bottom-end"
                closeOnBackdrop
                title={t("tactics.profile.rename")}
              >
                <div class="tac-topbar__rename">
                  <input
                    class="tac-topbar__rename-input"
                    value={renameText.value}
                    placeholder={session.value.fileName ?? t("tactics.profile.namePlaceholder")}
                    onInput={(e: Event) => {
                      renameText.value = (e.target as HTMLInputElement).value;
                    }}
                    onBlur={() => {
                      setProfileName(renameText.value);
                      renameOpen.value = false;
                    }}
                    onKeydown={(e: KeyboardEvent) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        setProfileName(renameText.value);
                        renameOpen.value = false;
                      } else if (e.key === "Escape") {
                        renameOpen.value = false;
                      }
                    }}
                  />
                  <HkIconButton
                    size={24}
                    variant="primary"
                    data-hint={t("tactics.lineup.apply")}
                    onClick={() => {
                      setProfileName(renameText.value);
                      renameOpen.value = false;
                    }}
                  >
                    <Check size={13} />
                  </HkIconButton>
                </div>
              </HkPopover>
            </span>
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
              // Teleport dock for the branch tree (PlanSlotsBar, tree
              // layout) — the tree is itself the hikari scroll container;
              // the aside keeps only the panel's box framing.
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
                  heat={heatData.value}
                  heatMode={session.value.heat}
                  onSetHeat={setHeat}
                slotsTeleport={wide.value ? "#tactics-branch-dock" : undefined}
                minimapTeleport={wide.value ? "#tactics-minimap-dock" : undefined}
                dockTeleport="#tactics-dock-row"
              />
            </section>
            {wide.value ? (
              <aside class="tac-workspace__side" id="tactics-minimap-dock" />
            ) : null}
          </main>

          {/* The board dock (toolbar + timeline) spans the WHOLE page
              width — the flanking panels frame the map only. */}
          <footer class="tac-dock-row" id="tactics-dock-row" />

          <MapSetupModal
            modelValue={setupOpen.value}
            onUpdate:modelValue={(v: boolean) => (setupOpen.value = v)}
            currentMapId={sel}
            currentModeId={session.value.modeId}
            spaceIds={[...ANALYSABLE_SPACE_IDS]}
            bucketsOf={bucketsOf}
            getBounds={(id) => boundsOf(id)}
            replaysDir={activePath.value ? replaysDir(activePath.value) : undefined}
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
