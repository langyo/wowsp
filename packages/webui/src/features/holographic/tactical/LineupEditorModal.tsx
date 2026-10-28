/**
 * Fleet-lineup editor (the tactics page's 编辑阵容 button): the two teams a
 * plan is authored around, in one modal. Ships come from the SAME picker
 * the ship-comparison uses (ShipPickerModal — quick filters included), so
 * the two surfaces never drift apart.
 *
 * Every hull row is one uniform two-line card with a drag lane on the
 * left (hikari's HkDraggableList handle — reorder renumbers 01…12):
 *   line 1 — the game's own class icon, the Roman tier, the hull name,
 *             the auto number tag, and a kebab menu (edit loadout /
 *             equipment / flags / captain / skills, remove);
 *   line 2 — per-slot consumable pickers (icon button groups; a slot with
 *             alternatives offers them as siblings — radar vs spotter).
 * Hovering the whole card pops a structured summary (computed HP,
 * consumable selection, equipment/flag/captain status — the recommended
 * default loadout is stamped on every freshly added hull) toward the
 * modal's centre: right of our column, left of theirs.
 */
import { computed, defineComponent, ref, shallowRef, watch, type PropType } from "vue";
import {
  HkDraggableList,
  HkIconButton,
  HkIconButtonGroup,
  HkMenu,
  HkModal,
  HkPopupSelect,
  HkScrollContainer,
  HkTag,
  HkTooltip,
  useToast,
  type HkIconButtonGroupOption,
  type HkMenuItem,
} from "@celestia-island/hikari";
import {
  ArrowLeftRight,
  Flag,
  GraduationCap,
  MoreHorizontal,
  Ship,
  Trash2,
  UserRound,
  Wrench,
  X,
} from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useShipsUiStore } from "@/stores/shipsUi";
import { api } from "@/api";
import type { ShipInfo } from "@/api/client";
import { tierLabel } from "@/utils/shipCompare";
import { techTreeNode } from "@/utils/techTreeData";
import { useShipDetail } from "@/composables/useShipDetail";
import ShipPickerModal from "@/components/ships/ShipPickerModal";
import BuildPlanner from "@/components/ships/BuildPlanner";
import { defaultBuildFor, shipUpgradeSlots } from "@/components/ships/buildDefaults";
import { recomputeStats, type PlannerBuild } from "@/components/ships/modifierPipeline";
import {
  classSkills,
  skillClassFor,
  skillPointsSpent,
  SKILL_BUDGET,
} from "@/components/ships/skillTree";
import commandersData from "@/data/commanders.json";
import {
  shipConsumableLabel,
  shipLiveStats,
} from "@/features/replay/shipLiveStats";
import { shipIconUrl } from "../shipIcons";
import {
  cloneBuild,
  copySide,
  makeEntry,
  resolveUnit,
  torpedoOptionsOf,
  type Lineup,
  type LineupEntry,
  type TeamSide,
} from "./lineup";
import {
  bakedToggleOptions,
  gameparamsSlotGroups,
  selectFamily,
  type SlotGroup,
} from "./lineupSlots";
import "./LineupEditorModal.scss";

/** Commander catalog name → display person name (tooltip rows). */
const COMMANDER_PERSON = new Map(
  (commandersData as { name: string; person: string }[]).map((c) => [c.name, c.person]),
);

/** Nation codes with a bundled flag webp (publicDir art served at the
 * root path — keys-only glob, the files never enter Vite's module graph;
 * see utils/shipImages.ts). */
const NATION_STEMS = new Set(
  Object.keys(import.meta.glob("../../../res/images/nations/*.webp")).map(
    (path) => path.split("/").pop()!.replace(/\.webp$/i, ""),
  ),
);

function nationFlagUrl(nation: string): string | undefined {
  return NATION_STEMS.has(nation) ? `/images/nations/${nation}.webp` : undefined;
}

/** Loadout editor section the kebab menu can deep-link into. */
type LoadoutSection = "skills" | "captains" | "flags" | "upgrades";

export default defineComponent({
  name: "TacticalLineupEditorModal",
  props: {
    modelValue: { type: Boolean, required: true },
    /** The session's current lineup (loaded per map). */
    lineup: { type: Object as PropType<Lineup>, required: true },
    mapName: { type: String, default: "" },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
    /** Apply the edited lineup (only on 完成). */
    apply: (_lineup: Lineup) => true,
  },
  setup(props, { emit }) {
    const encyclopedia = useEncyclopediaStore();
    const shipsUi = useShipsUiStore();
    const toast = useToast();
    const { dataLanguage } = useLanguage();
    const shipDetail = useShipDetail();
    /** Working copy — edits land on the session only when confirmed. */
    const draft = ref<Lineup>({ ally: [], enemy: [] });
    /** Which side the picker adds to. */
    const pickerSide = ref<TeamSide | null>(null);
    /** Open kebab menu (anchor = the pressed row's kebab button). */
    const menu = ref<{ side: TeamSide; id: string; el: HTMLElement } | null>(null);
    /** Open per-hull loadout editor (BuildPlanner modal), by entry id. */
    const loadout = ref<{ side: TeamSide; id: string; section: LoadoutSection } | null>(null);
    /** Authoritative per-slot consumable groups from GameParams slices
     *  (async, cached per shipId); the baked ship_live_stats `load` list
     *  covers first paint and stays as the permanent fallback. Only
     *  RESOLVED hulls are pinned — a failed fetch retries on the next
     *  open (or once an install root appears). */
    const gpSlots = shallowRef(new Map<number, SlotGroup[]>());
    const gpResolved = new Set<number>();

    // An install switch changes which GameParams the backend can read —
    // drop the old root's slot groups and re-resolve while open.
    watch(
      () => shipDetail.gameRoot.value,
      () => {
        gpResolved.clear();
        gpSlots.value = new Map();
        if (props.modelValue) loadGpSlots();
      },
    );

    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          const clone = (e: LineupEntry): LineupEntry => ({
            ...e,
            consumables: [...e.consumables],
            build: cloneBuild(e.build),
          });
          draft.value = {
            ally: props.lineup.ally.map(clone),
            enemy: props.lineup.enemy.map(clone),
          };
          loadGpSlots();
        } else {
          menu.value = null;
          loadout.value = null;
        }
      },
    );

    const byId = computed(() => encyclopedia.byId);

    /** Tech-tree index of a hull in the active realm's tree (feeds the
     *  default build's recommended skills + unique-mod gating). */
    function treeIndexOf(shipId: number): string | null {
      return techTreeNode(shipId, shipsUi.treeRealm)?.index ?? null;
    }

    /** The hull's effective build: its own, or the recommended default a
     *  legacy (pre-build) entry implicitly carries. */
    function entryBuild(entry: LineupEntry, ship: ShipInfo | null): PlannerBuild {
      return (
        entry.build ??
        defaultBuildFor(
          ship ?? { shipId: entry.shipId, type: "", nation: "", tier: 0 },
          ship ? treeIndexOf(ship.shipId) : null,
        )
      );
    }

    /** The hull's authoritative slot groups once its GameParams slice
     *  resolved; undefined → the baked family-toggle fallback. */
    function slotGroupsOf(entry: LineupEntry): SlotGroup[] | undefined {
      return gpSlots.value.get(entry.shipId);
    }

    /** Resolve the GameParams slot layout for every hull not yet resolved
     *  — the empty root lets the backend answer from its cache / bundled
     *  pack; failures keep the baked fallback and retry later. */
    function loadGpSlots(): void {
      const ids = new Set<number>();
      for (const e of [...draft.value.ally, ...draft.value.enemy]) ids.add(e.shipId);
      for (const id of ids) {
        if (gpResolved.has(id)) continue;
        api
          .getShipGameparams(id, shipDetail.gameRoot.value)
          .then((gp) => {
            const groups = gameparamsSlotGroups(gp, dataLanguage.value);
            gpResolved.add(id);
            if (groups.length > 0) {
              const next = new Map(gpSlots.value);
              next.set(id, groups);
              gpSlots.value = next;
            }
          })
          .catch(() => {
            // no slice for this hull (yet) — the baked slot list stays
          });
      }
    }

    function addShips(list: ShipInfo[]): void {
      const side = pickerSide.value;
      if (!side) return;
      const seen = new Set(draft.value[side].map((e) => e.shipId));
      const add = list
        .filter((s) => !seen.has(s.shipId))
        .map((s) => makeEntry(s.shipId, "", defaultBuildFor(s, treeIndexOf(s.shipId))));
      if (add.length === 0) return;
      draft.value = { ...draft.value, [side]: [...draft.value[side], ...add] };
      loadGpSlots();
    }

    function removeEntry(side: TeamSide, id: string): void {
      draft.value = {
        ...draft.value,
        [side]: draft.value[side].filter((e) => e.id !== id),
      };
    }

    function patchEntry(side: TeamSide, id: string, patch: Partial<LineupEntry>): void {
      draft.value = {
        ...draft.value,
        [side]: draft.value[side].map((e) => (e.id === id ? { ...e, ...patch } : e)),
      };
    }

    function reorder(side: TeamSide, from: number, to: number): void {
      const list = [...draft.value[side]];
      const [moved] = list.splice(from, 1);
      if (!moved) return;
      list.splice(to, 0, moved);
      draft.value = { ...draft.value, [side]: list };
    }

    function apply(): void {
      emit("apply", draft.value);
      emit("update:modelValue", false);
    }

    // ── Hover summary card (global delegated tooltip; JSON payload) ──────

    /** The hull's whole configuration as one hover card: computed HP,
     *  consumable selection, equipment/flag fill, captain + skill spend.
     *  Placement rides the ROW element (data-hint-pos): toward the modal's
     *  centre — right of ours, left of theirs. */
    function hintCardOf(entry: LineupEntry): Record<string, unknown> {
      const unit = resolveUnit(entry, byId.value);
      const ship = unit.ship;
      const build = entryBuild(entry, ship);
      const slotGroups = slotGroupsOf(entry);
      // Consumable readout, aligned with zoneSourceOf's semantics: an
      // EXPLICIT choice shows exactly what's mounted; an untouched hull
      // shows everything it COULD mount (the unrestricted planning view
      // the board's zone menu also takes), deduped for display.
      const families = [...new Set(
        entry.consumables.length
          ? entry.consumables
          : slotGroups
            ? slotGroups.flatMap((g) => g.options.map((o) => o.family))
            : bakedToggleOptions(entry.shipId).map((o) => o.family),
      )];
      const hp =
        recomputeStats(
          (ship?.defaultProfile ?? {}) as Parameters<typeof recomputeStats>[0],
          ship?.type ?? unit.shipType,
          ship?.tier ?? 0,
          build,
          build.healthPct ?? 1,
        ).modified.hp ?? shipLiveStats(entry.shipId)?.hp ?? null;
      const tree = classSkills(skillClassFor(ship?.type ?? unit.shipType));
      const points = skillPointsSpent(build.skills, tree);
      const captain =
        (build.commander ? COMMANDER_PERSON.get(build.commander) : undefined) ??
        i18nT("tactics.lineup.tipCaptainStd");
      return {
        title: unit.name,
        badge: ship ? tierLabel(ship.tier) : undefined,
        iconUrl: ship?.images?.contour || undefined,
        subtitle: ship
          ? `${i18nT(`ships.nation.${ship.nation}`)} · ${i18nT(`ships.type.${ship.type}`)}`
          : undefined,
        subtitleFlagUrl: ship ? nationFlagUrl(ship.nation) : undefined,
        rows: [
          {
            label: i18nT("tactics.lineup.tipHp"),
            value: hp != null ? Math.round(hp).toLocaleString("en-US") : "—",
          },
          {
            label: i18nT("tactics.lineup.tipConsumables"),
            value:
              families.map((f) => shipConsumableLabel(f)).join(" · ") ||
              i18nT("tactics.lineup.noSlots"),
          },
          {
            label: i18nT("tactics.lineup.tipUpgrades"),
            value: i18nT("tactics.lineup.tipSlots", {
              n: Object.keys(build.upgrades ?? {}).length,
              m: shipUpgradeSlots(ship?.tier ?? 0).length,
            }),
          },
          {
            label: i18nT("tactics.lineup.tipFlags"),
            value: i18nT("tactics.lineup.tipSignals", { n: (build.signals ?? []).length }),
          },
          {
            label: i18nT("tactics.lineup.tipCaptain"),
            value: `${captain} · ${i18nT("tactics.lineup.tipPts", {
              n: points,
              max: SKILL_BUDGET,
            })}`,
          },
        ],
        note: entry.build ? undefined : i18nT("tactics.lineup.tipDefault"),
      };
    }

    /** One side's column: hull rows + add/copy/clear actions. */
    const sideColumn = (side: TeamSide) => {
      const label = i18nT(side === "ally" ? "tactics.lineup.ally" : "tactics.lineup.enemy");
      const other: TeamSide = side === "ally" ? "enemy" : "ally";
      const entries = draft.value[side];
      return (
        <div class={`lineup__side lineup__side--${side}`}>
          <div class="lineup__side-head">
            <strong>{label}</strong>
            <span class="lineup__side-count">{entries.length}</span>
            <HkTooltip
              text={i18nT("tactics.lineup.copyTo", {
                side: i18nT(other === "ally" ? "tactics.lineup.ally" : "tactics.lineup.enemy"),
              })}
            >
              <HkIconButton
                size={24}
                data-hint={i18nT("tactics.lineup.copyTo", {
                  side: i18nT(other === "ally" ? "tactics.lineup.ally" : "tactics.lineup.enemy"),
                })}
                onClick={() => {
                  draft.value = copySide(draft.value, other, side);
                }}
              >
                <ArrowLeftRight size={12} style={{ transform: other === "ally" ? "scaleX(-1)" : undefined }} />
              </HkIconButton>
            </HkTooltip>
            <HkTooltip text={i18nT("tactics.lineup.clear")}>
              <HkIconButton
                size={24}
                data-hint={i18nT("tactics.lineup.clear")}
                disabled={entries.length === 0}
                onClick={() => {
                  draft.value = { ...draft.value, [side]: [] };
                }}
              >
                <X size={12} />
              </HkIconButton>
            </HkTooltip>
          </div>
          {/* Scroll region: hikari's HkScrollContainer owns the scrollbar
              (auto-hiding overlay track); the hull rows scroll inside its
              viewport, reordered through the drag lane each row carries. */}
          <HkScrollContainer class="lineup__rows">
            <HkDraggableList
              class="lineup__rows-inner"
              label={label}
              items={entries.map((e) => ({ ...e, key: e.id }))}
              onReorder={(from: number, to: number) => reorder(side, from, to)}
            >
              {{
                item: ({ item, index }: { item: LineupEntry & { key: string }; index: number }) => {
                  const entry = item;
                  const unit = resolveUnit(entry, byId.value);
                  const torps = torpedoOptionsOf(unit);
                  const groups = slotGroupsOf(entry);
                  const fallbackOptions = groups ? [] : bakedToggleOptions(entry.shipId);
                  const chosen = new Set(entry.consumables);
                  const typeIcon = shipIconUrl(
                    unit.ship?.type ?? unit.shipType,
                    side === "ally" ? "ally" : "enemy",
                  );
                  return (
                    <div
                      class="lineup__row"
                      data-hint-pos={side === "ally" ? "right" : "left"}
                      data-hint-card={JSON.stringify(hintCardOf(entry))}
                    >
                      <div class="lineup__row-main">
                        {typeIcon ? (
                          <img class="lineup__row-type" src={typeIcon} alt="" />
                        ) : (
                          <Ship size={13} class="lineup__row-type" />
                        )}
                        {unit.ship ? (
                          <span class="lineup__row-tier">{tierLabel(unit.ship.tier)}</span>
                        ) : null}
                        <span class="lineup__row-name">{unit.name}</span>
                        <HkTag size="sm" class="lineup__row-no">
                          {String(index + 1).padStart(2, "0")}
                        </HkTag>
                        <HkIconButton
                          size={24}
                          class="lineup__row-menu"
                          data-hint={i18nT("tactics.lineup.menu")}
                          onClick={(e: MouseEvent) => {
                            menu.value = {
                              side,
                              id: entry.id,
                              el: e.currentTarget as HTMLElement,
                            };
                          }}
                        >
                          <MoreHorizontal size={13} />
                        </HkIconButton>
                      </div>
                      <div class="lineup__row-config">
                        {groups
                          ? groups.map((g) => {
                              const opts: HkIconButtonGroupOption[] = g.options.map((o) => ({
                                key: o.family,
                                label: g.key ? `${g.key} · ${o.name}` : o.name,
                                icon: o.iconUrl ? (
                                  <img class="lineup__slot-ico" src={o.iconUrl} alt="" />
                                ) : undefined,
                              }));
                              const active =
                                g.options.find((o) => chosen.has(o.family))?.family ??
                                g.options[0]?.family ??
                                null;
                              return opts.length > 0 ? (
                                <HkIconButtonGroup
                                  class="lineup__slot"
                                  mode="single"
                                  variant="plain"
                                  size="sm"
                                  options={opts}
                                  modelValue={active}
                                  onUpdate:modelValue={(v: string | string[]) => {
                                    if (typeof v !== "string") return;
                                    patchEntry(side, entry.id, {
                                      consumables: selectFamily(
                                        groups,
                                        entry.consumables,
                                        g.slot,
                                        v,
                                      ),
                                    });
                                  }}
                                  tooltipDelay={350}
                                />
                              ) : null;
                            })
                          : fallbackOptions.length > 0
                            ? (() => {
                                // Baked fallback: a deduped family inventory
                                // without slot boundaries — the toggle strip
                                // (the pre-rework chips' semantics).
                                const opts: HkIconButtonGroupOption[] = fallbackOptions.map(
                                  (o) => ({
                                    key: o.family,
                                    label: o.name,
                                    icon: o.iconUrl ? (
                                      <img class="lineup__slot-ico" src={o.iconUrl} alt="" />
                                    ) : undefined,
                                  }),
                                );
                                return (
                                  <HkIconButtonGroup
                                    class="lineup__slot"
                                    mode="multiple"
                                    variant="plain"
                                    size="sm"
                                    options={opts}
                                    modelValue={entry.consumables}
                                    onUpdate:modelValue={(v: string | string[]) => {
                                      patchEntry(side, entry.id, {
                                        consumables: Array.isArray(v) ? v : [],
                                      });
                                    }}
                                    tooltipDelay={350}
                                  />
                                );
                              })()
                            : null}
                        {torps.length > 1 ? (
                          <HkPopupSelect
                            class="lineup__torp"
                            hideLabel
                            size="sm"
                            label={i18nT("tactics.lineup.torpedo")}
                            modelValue={String(Math.min(entry.torpedo, torps.length - 1))}
                            options={torps.map((tp, ti) => ({
                              value: String(ti),
                              label: i18nT("tactics.lineup.torpKm", { km: tp.label }),
                            }))}
                            onUpdate:modelValue={(v: string) =>
                              patchEntry(side, entry.id, { torpedo: Number(v) })
                            }
                          />
                        ) : null}
                        {!groups && fallbackOptions.length === 0 ? (
                          <span class="lineup__row-none">{i18nT("tactics.lineup.noSlots")}</span>
                        ) : null}
                      </div>
                    </div>
                  );
                },
              }}
            </HkDraggableList>
          </HkScrollContainer>
          <button
            type="button"
            class="lineup__add"
            onClick={() => {
              pickerSide.value = side;
            }}
          >
            + {i18nT("tactics.lineup.add")}
          </button>
        </div>
      );
    };

    /** Kebab items as a computed — a locale switch mid-session re-labels
     *  the menu with everything else. */
    const menuItems = computed<HkMenuItem[]>(() => [
      { key: "skills", label: i18nT("tactics.lineup.editSkills"), icon: GraduationCap },
      { key: "upgrades", label: i18nT("tactics.lineup.editUpgrades"), icon: Wrench },
      { key: "flags", label: i18nT("tactics.lineup.editFlags"), icon: Flag },
      { key: "captains", label: i18nT("tactics.lineup.editCaptain"), icon: UserRound },
      { key: "remove", label: i18nT("tactics.lineup.remove"), icon: Trash2, danger: true },
    ]);

    /** The hull the open loadout editor edits (null once removed). */
    const loadoutEntry = computed(() => {
      const l = loadout.value;
      if (!l) return null;
      return draft.value[l.side].find((e) => e.id === l.id) ?? null;
    });

    return () => (
      <>
        <HkModal
          modelValue={props.modelValue}
          onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
          title={i18nT("tactics.lineup.title")}
          width="min(60rem, 94vw)"
          footerActions={[
            {
              label: i18nT("tactics.setup.cancel"),
              variant: "secondary",
              onClick: () => emit("update:modelValue", false),
            },
            {
              label: i18nT("tactics.lineup.apply"),
              variant: "primary",
              onClick: apply,
            },
          ]}
        >
          <p class="lineup__hint">{i18nT("tactics.lineup.hint")}</p>
          <div class="lineup">
            {sideColumn("ally")}
            <div class="lineup__vs">
              <span>VS</span>
            </div>
            {sideColumn("enemy")}
          </div>
        </HkModal>

        {/* Row kebab menu — one instance anchored at the pressed row. */}
        <HkMenu
          open={menu.value != null}
          anchorRef={menu.value?.el ?? null}
          placement="bottom-end"
          items={menuItems.value}
          onUpdate:open={(v: boolean) => {
            if (!v) menu.value = null;
          }}
          onSelect={(key: string) => {
            const m = menu.value;
            menu.value = null;
            if (!m) return;
            if (key === "remove") {
              removeEntry(m.side, m.id);
              return;
            }
            loadout.value = { side: m.side, id: m.id, section: key as LoadoutSection };
          }}
        />

        {/* Per-hull loadout editor — the same BuildPlanner the ship
            detail modal hosts, deep-linked to the menu's section. Edits
            land on the working copy immediately; the modal only frames. */}
        <HkModal
          modelValue={loadout.value != null}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) loadout.value = null;
          }}
          title={i18nT("tactics.lineup.configTitle", {
            name: loadoutEntry.value
              ? resolveUnit(loadoutEntry.value, byId.value).name
              : "",
          })}
          width="min(78rem, 96vw)"
          footerActions={[
            {
              label: i18nT("tactics.lineup.apply"),
              variant: "primary",
              onClick: () => {
                loadout.value = null;
              },
            },
          ]}
        >
          {loadout.value && loadoutEntry.value
            ? (() => {
                const entry = loadoutEntry.value;
                const ship = byId.value.get(entry.shipId) ?? null;
                if (!ship) {
                  return <p class="lineup__hint">{i18nT("tactics.lineup.noShip")}</p>;
                }
                return (
                  <div class="lineup__loadout" key={entry.id}>
                    <BuildPlanner
                      ship={ship}
                      build={entryBuild(entry, ship)}
                      initialSection={loadout.value!.section}
                      gameRoot={shipDetail.gameRoot.value}
                      onUpdate:build={(b: PlannerBuild) => {
                        patchEntry(loadout.value!.side, entry.id, { build: b });
                      }}
                    />
                  </div>
                );
              })()
            : null}
        </HkModal>

        <ShipPickerModal
          modelValue={pickerSide.value != null}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) pickerSide.value = null;
          }}
          existingIds={
            new Set(
              pickerSide.value ? draft.value[pickerSide.value].map((e) => e.shipId) : [],
            )
          }
          onAdd={(list: ShipInfo[]) => {
            addShips(list);
            toast.info(i18nT("tactics.lineup.added", { n: list.length }));
          }}
        />
      </>
    );
  },
});
