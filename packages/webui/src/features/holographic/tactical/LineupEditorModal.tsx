/**
 * Fleet-lineup editor (the tactics page's 编辑阵容 button): the two teams a
 * plan is authored around, in one modal. Ships come from the SAME picker
 * the ship-comparison uses (ShipPickerModal — quick filters included), so
 * the two surfaces never drift apart. Per hull: a display label, the
 * torpedo variant (the baked asset carries the widest today), and the
 * consumable toggles that later light zones on the board. Quick copies
 * mirror one side onto the other for symmetric matchups; nothing stops an
 * asymmetric one.
 */
import { computed, defineComponent, ref, watch, type PropType } from "vue";
import {
  HkIconButton,
  HkIconButtonGroup,
  HkTooltip,
  HkModal,
  HkPopupSelect,
  HkTag,
  useToast,
  type HkIconButtonGroupOption,
} from "@celestia-island/hikari";
import { ArrowLeftRight, AudioLines, CloudFog, Radar, Ship, Trash2, X } from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import type { ShipInfo } from "@/api/client";
import ShipPickerModal from "@/components/ships/ShipPickerModal";
import {
  copySide,
  makeEntry,
  resolveUnit,
  torpedoOptionsOf,
  UTILITY_FAMILIES,
  zoneSourceOf,
  type Lineup,
  type TeamSide,
} from "./lineup";
import "./LineupEditorModal.scss";

/** Consumable family → i18n label key (the board's zone names). */
const FAMILY_LABEL: Record<(typeof UTILITY_FAMILIES)[number], string> = {
  rls: "tactics.zone.radar",
  sonar: "tactics.zone.hydro",
  smoke: "tactics.zone.smoke",
};

/** Consumable family → the icon its toggle carries in the group strip. */
const FAMILY_ICON: Record<(typeof UTILITY_FAMILIES)[number], typeof Ship> = {
  rls: Radar,
  sonar: AudioLines,
  smoke: CloudFog,
};

/** Can the hull mount the family at all (kit + baked slot families)? */
function familyAvailable(f: (typeof UTILITY_FAMILIES)[number], src: ReturnType<typeof zoneSourceOf>): boolean {
  if (f === "rls") return (src.radarRadius ?? 0) > 0;
  if (f === "sonar") return (src.hydroRadius ?? 0) > 0;
  return src.smoke;
}

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
    const toast = useToast();
    /** Working copy — edits land on the session only when confirmed. */
    const draft = ref<Lineup>({ ally: [], enemy: [] });
    /** Which side the picker adds to. */
    const pickerSide = ref<TeamSide | null>(null);

    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          draft.value = {
            ally: props.lineup.ally.map((e) => ({ ...e, consumables: [...e.consumables] })),
            enemy: props.lineup.enemy.map((e) => ({ ...e, consumables: [...e.consumables] })),
          };
        }
      },
    );

    const byId = computed(() => encyclopedia.byId);

    function addShips(list: ShipInfo[]): void {
      const side = pickerSide.value;
      if (!side) return;
      const seen = new Set(draft.value[side].map((e) => e.shipId));
      const add = list.filter((s) => !seen.has(s.shipId)).map((s) => makeEntry(s.shipId));
      if (add.length === 0) return;
      draft.value = { ...draft.value, [side]: [...draft.value[side], ...add] };
    }

    function removeAt(side: TeamSide, index: number): void {
      draft.value = {
        ...draft.value,
        [side]: draft.value[side].filter((_, i) => i !== index),
      };
    }

    function patchAt(side: TeamSide, index: number, patch: Partial<Lineup["ally"][number]>): void {
      draft.value = {
        ...draft.value,
        [side]: draft.value[side].map((e, i) => (i === index ? { ...e, ...patch } : e)),
      };
    }

    function apply(): void {
      emit("apply", draft.value);
      emit("update:modelValue", false);
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
          <div class="lineup__rows">
            {entries.map((entry, i) => {
              const unit = resolveUnit(entry, byId.value);
              const src = zoneSourceOf(unit);
              const torps = torpedoOptionsOf(unit);
              return (
                <div key={entry.id} class="lineup__row">
                  <div class="lineup__row-main">
                    <Ship size={13} class="lineup__row-ico" />
                    <input
                      class="lineup__label"
                      value={entry.label}
                      placeholder={unit.ship?.name ?? unit.name}
                      title={i18nT("tactics.lineup.rename")}
                      onInput={(e: Event) =>
                        patchAt(side, i, { label: (e.target as HTMLInputElement).value })
                      }
                    />
                    {unit.ship ? (
                      <HkTag size="sm">
                        {`T${unit.ship.tier} · ${i18nT(`ships.type.${unit.ship.type}`)}`}
                      </HkTag>
                    ) : null}
                    <HkTooltip text={i18nT("tactics.lineup.remove")}>
                      <HkIconButton
                        size={24}
                        variant="danger"
                        data-hint={i18nT("tactics.lineup.remove")}
                        onClick={() => removeAt(side, i)}
                      >
                        <Trash2 size={12} />
                      </HkIconButton>
                    </HkTooltip>
                  </div>
                  <div class="lineup__row-config">
                    {torps.length > 0 ? (
                      <HkPopupSelect
                        label={i18nT("tactics.lineup.torpedo")}
                        modelValue={String(Math.min(entry.torpedo, torps.length - 1))}
                        options={torps.map((tp, ti) => ({
                          value: String(ti),
                          label: i18nT("tactics.lineup.torpKm", { km: tp.label }),
                        }))}
                        onUpdate:modelValue={(v: string) => patchAt(side, i, { torpedo: Number(v) })}
                      />
                    ) : null}
                    {(() => {
                      // The mountable consumables as one multi-select icon
                      // group: engaged families tint, tooltips carry the
                      // localized names.
                      const opts: HkIconButtonGroupOption[] = UTILITY_FAMILIES.filter((f) =>
                        familyAvailable(f, src),
                      ).map((f) => {
                        const Icon = FAMILY_ICON[f];
                        return {
                          key: f,
                          label: i18nT(FAMILY_LABEL[f]),
                          icon: <Icon size={15} />,
                        };
                      });
                      return opts.length > 0 ? (
                        <HkIconButtonGroup
                          class="lineup__kit"
                          mode="multiple"
                          variant="track"
                          size="sm"
                          options={opts}
                          modelValue={entry.consumables}
                          onUpdate:modelValue={(v: string | string[]) => {
                            patchAt(side, i, {
                              consumables: Array.isArray(v) ? v : [],
                            });
                          }}
                        />
                      ) : null;
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
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
