/** The layered resource-pack swimlane (美化定制分层) — Minecraft-style
 *  ordered stack, top = highest priority.
 *
 *  The component is presentation + drag only: every mutation rides props
 *  (onSelect / onReorder / onApply / onOpenReport / onRetry), so
 *  layerStackHelpers.test.ts can pin the badge/order rules without IPC.
 *  HkDraggableList owns the pointer model; legacy layers (managed=false)
 *  ride lockedKeys and stay pinned at the bottom.
 *
 *  Also exports the layer detail pane and the render-report modal — the
 *  two render functions ResourcesView's pane/modal slots mount inside its
 *  own tree (the DetailPane / SidebarRows pattern). */
import { computed, defineComponent, type PropType } from "vue";

import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Ban,
  Info,
  Trash2,
} from "@lucide/vue";
import {
  HkButton,
  HkDraggableList,
  HkModal,
  HkScrollContainer,
  type DragListItem,
} from "@celestia-island/hikari";

import type { LayerSlotConflict, ModKind, ModLayer } from "@/api";
import AppTag from "@/components/base/AppTag";
import LoadingNote from "@/components/base/LoadingNote";
import { KIND_META, KIND_ORDER, catIcon } from "@/features/modhub/taxonomy";
import { t } from "@/i18n";
import type { ResourcesCtx } from "./context";
import {
  conflictPaths,
  conflictsOfLayer,
  layerBadges,
  layerCategoryKey,
  type LayerBadge,
} from "./layerStackHelpers";

/** The primitive's row identity: the packId plus the layer itself, so the
 *  item slot reads the row without a second lookup. */
type LayerDragItem = DragListItem & { layer: ModLayer };

function categoryLabel(category: string): string {
  const key = layerCategoryKey(category);
  return key ? t(key) : category;
}

/** The row/pane glyph: on-disk kinds keep their KIND_META hue and icon,
 *  catalog categories use the curated glyph on the neutral tile. */
function glyphOf(category: string): {
  icon: (typeof KIND_META)[ModKind]["icon"];
  cls: string;
} {
  if ((KIND_ORDER as string[]).includes(category)) {
    const meta = KIND_META[category as ModKind];
    return { icon: meta.icon, cls: meta.class };
  }
  return { icon: catIcon(category), cls: "cat" };
}

function badgeTone(key: LayerBadge["key"]): "warning" | "danger" | "default" {
  if (key === "shadowed") return "warning";
  if (key === "slotConflict") return "danger";
  return "default";
}

function badgeText(badge: LayerBadge): string {
  if (badge.key === "shadowed") {
    return t("resources.layers.shadowed", { count: badge.count ?? 0 });
  }
  return t(`resources.layers.${badge.key}`);
}

export default defineComponent({
  name: "LayerStack",
  props: {
    layers: { type: Array as PropType<ModLayer[]>, required: true },
    rendered: { type: Boolean, default: true },
    slotConflicts: {
      type: Array as PropType<LayerSlotConflict[]>,
      default: () => [],
    },
    selectedPackId: { type: String, default: "" },
    busy: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    error: { type: String, default: "" },
    reportBusy: { type: Boolean, default: false },
    onSelect: {
      type: Function as PropType<(layer: ModLayer) => void>,
      required: true,
    },
    onReorder: {
      type: Function as PropType<(from: number, to: number) => void>,
      required: true,
    },
    onApply: { type: Function as PropType<() => void>, required: true },
    onOpenReport: { type: Function as PropType<() => void>, required: true },
    onRetry: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    const dragItems = computed<LayerDragItem[]>(() =>
      props.layers.map((layer) => ({
        key: layer.packId,
        locked: !layer.managed,
        layer,
      })),
    );
    const lockedKeys = computed(() =>
      props.layers.filter((layer) => !layer.managed).map((layer) => layer.packId),
    );

    function renderLane(layer: ModLayer) {
      const glyph = glyphOf(layer.category);
      const Icon = glyph.icon;
      const badges = layerBadges(layer, {
        rendered: props.rendered,
        conflicts: props.slotConflicts,
      });
      const conflictSlots = props.slotConflicts
        .filter((conflict) => conflict.packIds.includes(layer.packId))
        .map((conflict) => conflict.slot);
      const badgeHint = (badge: LayerBadge): string | undefined => {
        if (badge.key === "unmanaged") return t("resources.layers.unmanagedHint");
        if (badge.key === "slotConflict") {
          return t("resources.layers.slotConflictHint", {
            slots: conflictSlots.join(", "),
          });
        }
        if (badge.key === "shadowed") {
          return t("resources.layers.shadowedCount", {
            count: badge.count ?? 0,
          });
        }
        return undefined;
      };
      return (
        <button
          type="button"
          key={layer.packId}
          class={[
            "layer-lane",
            props.selectedPackId === layer.packId && "layer-lane--active",
            !layer.enabled && "layer-lane--off",
            !layer.managed && "layer-lane--legacy",
          ]}
          onClick={() => props.onSelect(layer)}
        >
          <span class={`layer-lane__tile layer-lane__tile--${glyph.cls}`}>
            <Icon size={18} />
          </span>
          <span class="layer-lane__body">
            <span class="layer-lane__name">
              {layer.name}
              {layer.version && (
                <AppTag class="layer-lane__ver" tone="default" mono>
                  {layer.version}
                </AppTag>
              )}
            </span>
            <span class="layer-lane__meta">
              {categoryLabel(layer.category)} ·{" "}
              {t("resources.layers.fileCount", { count: layer.fileCount })}
              {!layer.managed && ` · ${t("resources.layers.unmanagedHint")}`}
            </span>
          </span>
          <span class="layer-lane__tail">
            {badges.map((badge) =>
              badge.key === "pending" ? (
                <span
                  key={badge.key}
                  class="layer-lane__dot"
                  data-hint={t("resources.layers.pendingDot")}
                />
              ) : (
                <AppTag
                  key={badge.key}
                  tone={badgeTone(badge.key)}
                  data-hint={badgeHint(badge)}
                >
                  {badgeText(badge)}
                </AppTag>
              ),
            )}
          </span>
        </button>
      );
    }

    return () => (
      <div class="layer-stack">
        <div class="layer-stack__head">
          <span class="layer-stack__hint">
            <Info size={13} />
            {t("resources.layers.priorityHint")}
          </span>
          <span class="layer-stack__tools">
            <HkButton
              size="sm"
              variant="secondary"
              disabled={props.busy || props.reportBusy}
              loading={props.reportBusy}
              onClick={props.onOpenReport}
            >
              {t("resources.layers.renderReport")}
            </HkButton>
            {!props.rendered && (
              <HkButton
                size="sm"
                variant="primary"
                disabled={props.busy}
                loading={props.busy}
                onClick={props.onApply}
              >
                {t("resources.layers.apply")}
              </HkButton>
            )}
          </span>
        </div>

        {!props.rendered && (
          <div class="layer-stack__pending">
            <AlertTriangle size={14} />
            <span class="layer-stack__pending-text">
              {t("resources.layers.pending")}
            </span>
            <HkButton
              size="sm"
              variant="primary"
              disabled={props.busy}
              loading={props.busy}
              onClick={props.onApply}
            >
              {t("resources.layers.applyNow")}
            </HkButton>
          </div>
        )}

        {props.error && props.layers.length > 0 && (
          <div class="layer-stack__error">
            <AlertTriangle size={14} />
            <span class="layer-stack__error-text">
              {t("resources.layers.loadFailed", { reason: props.error })}
            </span>
            <HkButton size="sm" variant="secondary" onClick={props.onRetry}>
              {t("resources.layers.retry")}
            </HkButton>
          </div>
        )}

        {props.loading && props.layers.length === 0 ? (
          <div class="layer-stack__note">
            <LoadingNote text={t("resources.layers.loading")} />
          </div>
        ) : props.error && props.layers.length === 0 ? (
          <div class="layer-stack__empty">
            <p>{t("resources.layers.loadFailed", { reason: props.error })}</p>
            <HkButton size="sm" variant="secondary" onClick={props.onRetry}>
              {t("resources.layers.retry")}
            </HkButton>
          </div>
        ) : props.layers.length === 0 ? (
          <div class="layer-stack__empty">
            <p class="layer-stack__empty-title">{t("resources.layers.empty")}</p>
            <p>{t("resources.layers.emptyHint")}</p>
          </div>
        ) : (
          <HkDraggableList
            class="layer-stack__list"
            items={dragItems.value}
            lockedKeys={lockedKeys.value}
            label={t("resources.layers.title")}
            onReorder={(from: number, to: number) => props.onReorder(from, to)}
          >
            {{
              item: ({ item }: { item: LayerDragItem }) => renderLane(item.layer),
            }}
          </HkDraggableList>
        )}
      </div>
    );
  },
});

/** The layer detail pane: priority position, covering/shadowing state,
 *  slots and every layer action. Mounted by DetailPane for the "layer"
 *  selection mode. */
export function renderLayerDetail(ctx: ResourcesCtx, packId: string) {
  const ls = ctx.layerStack;
  const layer = ls.layerById(packId);
  if (!layer) {
    return (
      <div class="mod-detail mod-detail--empty">
        <div class="mod-detail__placeholder">
          <Ban size={30} />
          <p>{t("resources.layers.empty")}</p>
        </div>
      </div>
    );
  }
  const list = ls.layers.value;
  const index = list.findIndex((entry) => entry.packId === packId);
  const priority = index >= 0 ? index + 1 : layer.priority + 1;
  const coveredBy = layer.coveredBy
    ? (list.find((entry) => entry.packId === layer.coveredBy) ?? null)
    : null;
  const conflicts = conflictsOfLayer(layer, ls.conflicts.value);
  const paired = ctx.pairedCatalogOfLayer(layer);
  const canUninstall = ctx.canUninstallLayer(layer);
  const busy = ls.busy.value;
  const glyph = glyphOf(layer.category);
  const Icon = glyph.icon;
  const canMove = layer.managed && !busy;
  const atTop = index <= 0;
  const lastManaged = list.filter((entry) => entry.managed).length - 1;
  const atBottom = index >= lastManaged;
  return (
    <div class="mod-detail layer-detail">
      <div class="mod-detail__head">
        <span class={`mod-row__tile mod-row__tile--${glyph.cls} mod-row__tile--lg`}>
          <Icon size={24} />
        </span>
        <div class="mod-detail__id">
          <div class="mod-detail__name">
            {layer.name}
            {layer.version && (
              <AppTag class="mod-row__ver" tone="default" mono>
                {layer.version}
              </AppTag>
            )}
          </div>
          <div class="mod-detail__en">{categoryLabel(layer.category)}</div>
        </div>
      </div>
      <HkScrollContainer class="mod-detail__scroll">
        <div class="mod-detail__inner">
          <div class="mod-detail__badges">
            <AppTag tone="primary">
              {t("resources.layers.layerN", { n: priority })}
            </AppTag>
            <AppTag tone={layer.managed ? "success" : "default"}>
              {layer.managed
                ? t("resources.layers.managed")
                : t("resources.layers.unmanaged")}
            </AppTag>
            {!layer.enabled && (
              <AppTag tone="warning">{t("resources.disabled")}</AppTag>
            )}
            {layer.layerClass === "override" && (
              <AppTag face="outline">
                {t("resources.layers.class.override")}
              </AppTag>
            )}
            {layer.layerClass === "additive" && (
              <AppTag face="outline">
                {t("resources.layers.class.additive")}
              </AppTag>
            )}
            {layer.layerClass === "registered" && (
              <AppTag face="outline">
                {t("resources.layers.class.registered")}
              </AppTag>
            )}
          </div>

          {!layer.managed && (
            <p class="mod-detail__hint">{t("resources.layers.unmanagedHint")}</p>
          )}
          {layer.coveredBy && (
            <p class="mod-detail__hint">
              {t("resources.layers.coveredBy", {
                name: coveredBy?.name ?? layer.coveredBy,
              })}
            </p>
          )}

          <div class="layer-detail__stats">
            <span>{t("resources.layers.winningCount", { count: layer.winningCount })}</span>
            <span>{t("resources.layers.shadowedCount", { count: layer.shadowedCount })}</span>
            <span>{t("resources.layers.fileCount", { count: layer.fileCount })}</span>
          </div>

          <div class="layer-detail__slot-block">
            <span class="layer-detail__label">{t("resources.layers.slotsLabel")}</span>
            {layer.slots.length > 0 ? (
              <div class="layer-detail__slots">
                {layer.slots.map((slot) => (
                  <AppTag key={slot} tone="default" mono>
                    {slot}
                  </AppTag>
                ))}
              </div>
            ) : (
              <span class="mod-detail__hint">{t("resources.layers.slotsEmpty")}</span>
            )}
          </div>

          {conflicts.length > 0 && (
            <div class="layer-detail__conflicts">
              <AlertTriangle size={14} />
              <span>
                {t("resources.layers.slotConflictHint", {
                  slots: conflicts.map((conflict) => conflict.slot).join(", "),
                })}
              </span>
            </div>
          )}
        </div>
      </HkScrollContainer>
      <div class="mod-detail__foot">
        <div class="mod-detail__foot-row">
          <div class="layer-detail__moves">
            <HkButton
              size="sm"
              variant="secondary"
              disabled={!canMove || atTop}
              onClick={() => void ls.move(layer, "top")}
            >
              <ArrowUpToLine size={13} />
              {t("resources.layers.moveTop")}
            </HkButton>
            <HkButton
              size="sm"
              variant="secondary"
              disabled={!canMove || atTop}
              onClick={() => void ls.move(layer, "up")}
            >
              <ArrowUp size={13} />
              {t("resources.layers.moveUp")}
            </HkButton>
            <HkButton
              size="sm"
              variant="secondary"
              disabled={!canMove || atBottom}
              onClick={() => void ls.move(layer, "down")}
            >
              <ArrowDown size={13} />
              {t("resources.layers.moveDown")}
            </HkButton>
            <HkButton
              size="sm"
              variant="secondary"
              disabled={!canMove || atBottom}
              onClick={() => void ls.move(layer, "bottom")}
            >
              <ArrowDownToLine size={13} />
              {t("resources.layers.moveBottom")}
            </HkButton>
          </div>
          <div class="mod-detail__actions">
            <HkButton
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void ls.setEnabled(layer, !layer.enabled)}
            >
              {layer.enabled
                ? t("resources.layers.disable")
                : t("resources.layers.enable")}
            </HkButton>
            {paired && (
              <HkButton
                size="sm"
                variant="primary"
                disabled={busy || !ctx.gameRoot.value}
                loading={ctx.busy.value.has(paired.id)}
                onClick={() => ctx.layerUpdate(layer)}
              >
                {t("resources.layers.update")}
              </HkButton>
            )}
            <button
              class="mod-detail__danger"
              disabled={busy || !canUninstall}
              data-hint={
                canUninstall ? undefined : t("resources.layers.uninstallUnpaired")
              }
              onClick={() => ctx.requestLayerUninstall(layer)}
            >
              <Trash2 size={13} />
              {t("resources.layers.uninstall")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The render report modal: one render pass's totals, warnings and the
 *  conflicting path list (winner / shadowed / foreign), capped at 200
 *  rows with the total still visible. */
export function renderLayerReport(ctx: ResourcesCtx) {
  const ls = ctx.layerStack;
  const report = ls.report.value;
  const { rows, total } = conflictPaths(ls.paths.value);
  const nameOf = (packId: string | null) =>
    packId
      ? (ls.layers.value.find((layer) => layer.packId === packId)?.name ?? packId)
      : "";
  const totals = report
    ? [
        { key: "written", value: report.written },
        { key: "removed", value: report.removed },
        { key: "unchanged", value: report.unchanged },
        { key: "blockedForeign", value: report.blockedForeign },
      ]
    : [];
  return (
    <HkModal
      modelValue={ls.reportOpen.value}
      onUpdate:modelValue={(open: boolean) => {
        if (!open) ls.closeReport();
      }}
      title={t("resources.layers.reportTitle")}
      width="42rem"
      footerActions={[
        {
          label: t("common.close"),
          variant: "secondary" as const,
          onClick: ls.closeReport,
        },
      ]}
    >
      <div class="layer-report">
        {report ? (
          <div class="layer-report__totals">
            {totals.map((item) => (
              <div class="layer-report__total" key={item.key}>
                <span class="layer-report__total-value">{item.value}</span>
                <span class="layer-report__total-label">
                  {t(`resources.layers.report.${item.key}`)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p class="layer-report__empty">{t("resources.layers.report.empty")}</p>
        )}

        {report && report.warnings.length > 0 && (
          <div class="layer-report__section">
            <h4 class="layer-report__title">
              {t("resources.layers.report.warnings")}
            </h4>
            <ul class="layer-report__warnings">
              {report.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>
                  <AlertTriangle size={12} /> {warning}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div class="layer-report__section">
          <h4 class="layer-report__title">
            {t("resources.layers.report.conflicts")}
          </h4>
          {rows.length === 0 ? (
            <p class="layer-report__empty">
              {t("resources.layers.report.noConflicts")}
            </p>
          ) : (
            <div class="layer-report__paths">
              {rows.map((row) => (
                <div class="layer-report__path" key={row.path}>
                  <code class="layer-report__path-name">{row.path}</code>
                  <span class="layer-report__path-meta">
                    {row.foreign && (
                      <AppTag tone="danger">
                        {t("resources.layers.report.foreign")}
                      </AppTag>
                    )}
                    {row.packId && (
                      <AppTag tone="primary">{nameOf(row.packId)}</AppTag>
                    )}
                    {row.shadowed.length > 0 && (
                      <AppTag tone="warning">
                        {t("resources.layers.shadowed", {
                          count: row.shadowed.length,
                        })}
                      </AppTag>
                    )}
                  </span>
                </div>
              ))}
              {total > rows.length && (
                <p class="layer-report__cap">
                  {t("resources.layers.report.capped", {
                    shown: rows.length,
                    total,
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </HkModal>
  );
}
