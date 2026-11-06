/**
 * ReportPlayerPicker — the AI report's perspective dropdown.
 *
 * The old roster was a two-team chip grid at the top of the report; the
 * report head now only shows the perspective being read, and the switch
 * lives behind this dropdown (both teams, coverage badge per row; hulls the
 * exporter could not score stay listed but disabled, never silently
 * dropped). The sheet is the report's own dark surface, so the menu is a
 * plain absolutely-positioned list styled by StaticReportPanel.scss rather
 * than a themed hikari popover — opening it never repaints the sheet in the
 * app's light scheme.
 *
 * The trigger is a real button (Enter/Space opens), the rows are
 * role="option" buttons (Tab reaches them, Enter selects), Escape and any
 * outside pointer dismiss the menu. While the long image is being captured
 * the menu is forced shut, so the exported frame only ever shows the
 * selected player — no stray dropdown in the share image.
 */
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type PropType,
} from "vue";
import { Check, ChevronDown, Minus, Percent } from "@lucide/vue";

import AppTag from "@/components/base/AppTag";
import { t } from "@/i18n";
import type { StaticCoverage, StaticReport, StaticRosterEntry } from "@/api";
import { coverageClass, pct } from "./reportFormat";
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
  },
  emits: {
    pick: (_entityId: number) => true,
  },
  setup(props, { emit }) {
    const rootRef = ref<HTMLElement | null>(null);
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
      if (event.key !== "ArrowDown" || open.value) return;
      event.preventDefault();
      open.value = true;
      void nextTick(() => menuRows()[0]?.focus());
    }

    function onDocumentPointerDown(event: PointerEvent) {
      if (!open.value) return;
      const root = rootRef.value;
      if (root && event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      open.value = false;
    }
    /** Escape closes the menu first; swallow it so the hosting HkModal does
     *  not also close the window on the same key press. */
    function onDocumentKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && open.value) {
        event.stopPropagation();
        closeMenu(true);
      }
    }

    onMounted(() => {
      document.addEventListener("pointerdown", onDocumentPointerDown, true);
      document.addEventListener("keydown", onDocumentKeydown, true);
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeydown, true);
    });

    // A capture must never freeze an open menu into the share image.
    watch(
      () => props.capturing,
      (capturing) => {
        if (capturing) open.value = false;
      },
    );

    return () => (
      <div class="srp-picker" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          class="srp-picker__trigger"
          aria-haspopup="listbox"
          aria-expanded={open.value}
          disabled={props.capturing}
          data-hint={t("replay.report.pickPlayer")}
          onClick={toggle}
          onKeydown={onTriggerKeydown}
        >
          <span
            class={
              "srp-picker__dot srp-picker__dot--" +
              (me.value?.teamId === 1 ? "enemy" : "ally")
            }
          />
          <span class="srp-picker__name">{displayName.value}</span>
          {props.capturing ? null : (
            <ChevronDown size={14} class="srp-picker__chevron" />
          )}
        </button>
        {open.value && !props.capturing ? (
          <div
            ref={menuRef}
            class="srp-picker__menu"
            role="listbox"
            aria-label={t("replay.report.pickPlayer")}
            onKeydown={onMenuKeydown}
          >
            {groups.value.map((group) => (
              <div
                key={group.key}
                class="srp-picker__group"
                role="group"
                aria-label={group.label}
              >
                <span class="srp-picker__group-label">{group.label}</span>
                {group.rows.map((row) => (
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
                    <span
                      class={
                        "srp-picker__row-dot srp-picker__row-dot--" +
                        (row.teamId === 1 ? "enemy" : "ally")
                      }
                    />
                    <span class="srp-picker__row-name">
                      {row.name ?? String(row.entityId)}
                    </span>
                    <CoverageTag coverage={row.coverage} />
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
});
