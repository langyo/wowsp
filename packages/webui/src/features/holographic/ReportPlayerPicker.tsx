/**
 * ReportPlayerPicker — the AI report's perspective dropdown.
 *
 * The old roster was a two-team chip grid at the top of the report; the
 * report head now only shows the perspective being read, and the switch
 * lives behind this dropdown (both teams, coverage badge per row; hulls the
 * exporter could not score stay listed but disabled, never silently
 * dropped).
 *
 * The TRIGGER is the report's own identity head (emblem, [clan] nickname,
 * tier + ship) — content, not a generic form field. The PANEL is hikari's
 * standard dropdown surface (HkSelectPanel, the very surface HkSelect opens)
 * so the popout chrome, z-stacking, outside-click/Escape, the mobile bottom
 * sheet and the back gesture all come from the shared component; the rows
 * only supply their content. While the long image is being captured the
 * panel is forced shut, so the exported frame only ever shows the selected
 * player — no stray dropdown in the share image.
 *
 * Faces come from the host (reportSheet.ts): the trigger shows the player's
 * in-game emblem (the shared PlayerBadge), [clan] tag, nickname and tier +
 * ship name; rows lead with the SHIP (class glyph, tier numeral and ship
 * name in one fixed-width column) and carry the [clan] nickname after it,
 * then the coverage face and a check for the selected perspective. A row
 * whose hull no source can resolve keeps the ship column's width with a
 * neutral dash — never the old team-dot fallback (2026-11-07 user request).
 */
import { computed, defineComponent, nextTick, ref, watch, type PropType } from "vue";
import { HkSelectPanel } from "@celestia-island/hikari";
import { Check, ChevronDown, Minus, Percent } from "@lucide/vue";

import AppTag from "@/components/base/AppTag";
import BattleIcon from "@/components/base/BattleIcon";
import PlayerBadge from "@/components/base/PlayerBadge";
import { t } from "@/i18n";
import type { StaticCoverage, StaticReport, StaticRosterEntry } from "@/api";
import { tierRoman } from "@/features/replay/shipLiveStats";
import { coverageClass, pct } from "./reportFormat";
import type { ReportRosterInfo, ReportSheetIdentity } from "./reportSheet";
import "./StaticReportPanel.scss";

/** Coverage face: full / partial(percent) / no data — the same three-state
 *  badge the old chip grid carried. */
function CoverageTag(props: { coverage: StaticCoverage }) {
  const kind = coverageClass(props.coverage);
  const tone =
    kind === "full" ? "success" : kind === "partial" ? "warning" : "danger";
  return (
    <AppTag tone={tone} class="srp-picker__badge">
      {kind === "full" ? (
        <Check size={11} aria-hidden="true" />
      ) : kind === "partial" ? (
        <>
          <Percent size={10} aria-hidden="true" />
          <span>{pct(props.coverage.completeness)}</span>
        </>
      ) : (
        <Minus size={11} aria-hidden="true" />
      )}
    </AppTag>
  );
}

export default defineComponent({
  name: "ReportPlayerPicker",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
    /** Capture mode: force-closed, trigger disabled (static frame only). */
    capturing: { type: Boolean, default: false },
    /** The selected player's identity faces (emblem, clan, ship) — the host
     *  resolves them; a null identity falls back to the bare nickname. */
    identity: {
      type: Object as PropType<ReportSheetIdentity | null>,
      default: null,
    },
    /** entityId → per-row identity faces (ship icon, clan, ship name). */
    roster: {
      type: Object as PropType<Map<number, ReportRosterInfo> | null>,
      default: null,
    },
  },
  emits: {
    pick: (_entityId: number) => true,
  },
  setup(props, { emit }) {
    const triggerRef = ref<HTMLButtonElement | null>(null);
    const menuRef = ref<HTMLElement | null>(null);
    const open = ref(false);
    const me = computed<StaticRosterEntry | undefined>(() =>
      props.report.roster.find((row) => row.entityId === props.report.entityId),
    );
    const groups = computed(() => [
      {
        key: "allies",
        label: t("replay.report.allies"),
        rows: props.report.roster.filter((row) => row.teamId === 0),
      },
      {
        key: "enemies",
        label: t("replay.report.enemies"),
        rows: props.report.roster.filter((row) => row.teamId === 1),
      },
    ]);
    const displayName = computed(() =>
      me.value ? (me.value.name ?? String(me.value.entityId)) : "—",
    );
    /** The trigger's identity faces: the host-resolved identity wins, the
     *  selected roster row is the fallback source of clan/ship. */
    const triggerClan = computed(() => {
      const row = me.value;
      return (
        props.identity?.clanTag ??
        (row ? (props.roster?.get(row.entityId)?.clanTag ?? null) : null)
      );
    });
    const triggerShip = computed(() => {
      const row = me.value;
      return (
        props.identity?.shipName ??
        (row ? (props.roster?.get(row.entityId)?.shipName ?? null) : null)
      );
    });
    const triggerTier = computed(() => {
      const row = me.value;
      return (
        props.identity?.tier ??
        (row ? (props.roster?.get(row.entityId)?.tier ?? null) : null)
      );
    });
    const triggerShipType = computed(() => {
      const row = me.value;
      return (
        props.identity?.shipType ??
        (row ? (props.roster?.get(row.entityId)?.shipType ?? null) : null)
      );
    });
    function rowInfo(row: StaticRosterEntry): ReportRosterInfo | null {
      return props.roster?.get(row.entityId) ?? null;
    }
    /** The row's identity line: the PLAYER nickname. `row.name` is the
     *  ship-name-preferred display name (the Rust resolver's choice — the
     *  trigger head reads it), so `playerName` comes first; a shell that
     *  predates the field falls back to the display name rather than
     *  dropping the row's only name. */
    function rosterName(row: StaticRosterEntry): string {
      return row.playerName ?? row.name ?? String(row.entityId);
    }

    /** Enabled rows of the opened menu — the roving-focus ring. */
    function menuRows(): HTMLButtonElement[] {
      const menu = menuRef.value;
      if (!menu) return [];
      return Array.from(
        menu.querySelectorAll<HTMLButtonElement>(".srp-picker__row:not(:disabled)"),
      );
    }
    /** Menu closed: the trigger is the only stable focus target, so focus
     *  returns there (keyboard users otherwise fell back to <body> and the
     *  modal's Tab trap could be escaped). */
    function closeMenu(refocus: boolean) {
      open.value = false;
      if (refocus) {
        void nextTick(() => triggerRef.value?.focus());
      }
    }
    function toggle() {
      if (props.capturing) return;
      if (open.value) {
        closeMenu(false);
      } else {
        open.value = true;
      }
    }
    function choose(row: StaticRosterEntry) {
      if (props.capturing || row.coverage.samples === 0) return;
      closeMenu(true);
      if (row.entityId !== props.report.entityId) emit("pick", row.entityId);
    }
    /** Arrow keys walk the enabled rows (the listbox pattern's roving
     *  focus); the trigger opens the menu and lands on the first row. */
    function onMenuKeydown(event: KeyboardEvent) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const rows = menuRows();
      if (rows.length === 0) return;
      const current = rows.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next =
        current === -1
          ? delta > 0
            ? 0
            : rows.length - 1
          : (current + delta + rows.length) % rows.length;
      rows[next].focus();
    }
    function onTriggerKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && open.value) {
        // The opened panel is the topmost layer: one Escape closes only it,
        // never the hosting HkModal (the panel forwards keys to its owner —
        // this is that owner's consume).
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (event.key !== "ArrowDown" || open.value) return;
      event.preventDefault();
      open.value = true;
      void nextTick(() => menuRows()[0]?.focus());
    }

    /** The hikari panel owns outside-click/Escape closing (it reports the
     *  close through update:open); a close that came from the panel still
     *  hands focus back to the trigger. */
    watch(open, (isOpen, wasOpen) => {
      if (wasOpen && !isOpen) void nextTick(() => triggerRef.value?.focus());
    });

    // A capture must never freeze an open menu into the share image.
    watch(
      () => props.capturing,
      (capturing) => {
        if (capturing) open.value = false;
      },
    );

    return () => (
      <div class="srp-picker">
        <button
          ref={triggerRef}
          type="button"
          class={[
            "srp-picker__trigger",
            props.capturing ? "srp-picker__trigger--static" : "",
          ]}
          aria-haspopup="listbox"
          aria-expanded={open.value}
          disabled={props.capturing}
          data-hint={t("replay.report.pickPlayer")}
          onClick={toggle}
          onKeydown={onTriggerKeydown}
        >
          <span class="srp-picker__avatar">
            {props.identity?.dogTag ? (
              <PlayerBadge dogTag={props.identity.dogTag} size={28} />
            ) : (
              // No emblem data yet (lookup pending / hidden / offline): a
              // team-tinted initial plate instead of PlayerBadge's empty
              // disc (2026-11-07 review: the plate read as an unfinished
              // download).
              <span
                class={
                  "srp-picker__avatar-initial srp-picker__avatar-initial--" +
                  (me.value?.teamId === 1 ? "enemy" : "ally")
                }
                aria-hidden="true"
              >
                {(displayName.value || "?").slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
          <span class="srp-picker__identity">
            <span class="srp-picker__name-line">
              {triggerClan.value ? (
                <span class="srp-picker__clan">[{triggerClan.value}]</span>
              ) : null}
              <span class="srp-picker__name">{displayName.value}</span>
            </span>
            {triggerShip.value ? (
              <span class="srp-picker__ship">
                {triggerShipType.value ? (
                  <BattleIcon
                    type={triggerShipType.value}
                    variant={me.value?.teamId === 1 ? "enemy" : "ally"}
                    size={13}
                  />
                ) : null}
                {tierRoman(triggerTier.value) ? (
                  <span class="srp-picker__tier">
                    {tierRoman(triggerTier.value)}
                  </span>
                ) : null}
                {triggerShip.value}
              </span>
            ) : null}
          </span>
          {props.capturing ? null : (
            <ChevronDown size={14} class="srp-picker__chevron" />
          )}
        </button>
        {/* Hikari's own dropdown surface (the one HkSelect opens): the panel
            chrome, scroll, z-stacking, outside-click/Escape and the mobile
            bottom sheet are the shared component's; this slot supplies the
            roster rows. */}
        <HkSelectPanel
          open={open.value && !props.capturing}
          onUpdate:open={(v: boolean) => {
            if (props.capturing) return;
            open.value = v;
          }}
          anchorRef={triggerRef.value ?? null}
          title={t("replay.report.pickPlayer")}
          placement="bottom-start"
          offset={4}
          maxHeight="min(60vh, 520px)"
          onKeydown={onMenuKeydown}
        >
          {{
            default: () => (
              <div
                ref={menuRef}
                class="srp-picker__menu"
                role="listbox"
                aria-label={t("replay.report.pickPlayer")}
              >
                {groups.value.map((group) => (
                  <div
                    key={group.key}
                    class="srp-picker__group"
                    role="group"
                    aria-label={group.label}
                  >
                    <span class="srp-picker__group-label">{group.label}</span>
                    {group.rows.map((row) => {
                      const face = rowInfo(row);
                      const tier = tierRoman(face?.tier);
                      return (
                        <button
                          key={row.entityId}
                          type="button"
                          role="option"
                          aria-selected={row.entityId === props.report.entityId}
                          disabled={row.coverage.samples === 0}
                          class={[
                            "srp-picker__row",
                            row.entityId === props.report.entityId
                              ? "srp-picker__row--selected"
                              : "",
                          ]}
                          data-hint={
                            row.coverage.samples === 0
                              ? t("replay.report.noData")
                              : t("replay.report.coverage") +
                                ": " +
                                pct(row.coverage.completeness) +
                                "%"
                          }
                          onClick={() => choose(row)}
                        >
                          {/* Far left: the SHIP column (船种 glyph / 船等级 /
                              船名), a fixed-width slot so both groups' rows
                              align and the identity column starts at one x.
                              A hull no source resolves keeps the slot and
                              shows a neutral dash — never the old team dot
                              (the group label already names the side;
                              2026-11-07 user request). */}
                          <span class="srp-picker__row-ship">
                            {face?.shipType ? (
                              <span class="srp-picker__row-icon">
                                <BattleIcon
                                  type={face.shipType}
                                  variant={row.teamId === 1 ? "enemy" : "ally"}
                                  size={18}
                                />
                              </span>
                            ) : (
                              <span
                                class="srp-picker__row-icon"
                                aria-hidden="true"
                              />
                            )}
                            {tier ? (
                              <span class="srp-picker__row-tier">{tier}</span>
                            ) : null}
                            <span class="srp-picker__row-shipname">
                              {face?.shipName ?? "—"}
                            </span>
                          </span>
                          <span class="srp-picker__row-id">
                            {face?.clanTag ? (
                              <span class="srp-picker__clan">
                                [{face.clanTag}]
                              </span>
                            ) : null}
                            <span class="srp-picker__row-name">
                              {rosterName(row)}
                            </span>
                          </span>
                          <CoverageTag coverage={row.coverage} />
                          {row.entityId === props.report.entityId ? (
                            <Check size={14} class="srp-picker__check" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ),
          }}
        </HkSelectPanel>
      </div>
    );
  },
});
