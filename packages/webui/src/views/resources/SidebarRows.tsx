/** The Resources view's sidebar list rows — plain render functions taking
 *  the view context (they render INSIDE ResourcesView's own tree, so the
 *  row vnodes stay children of the view component). */
import { ImageIcon, Puzzle } from "@lucide/vue";

import type { CatalogEntry, InstalledMod, ForeignModUnit } from "@/api";
import { KIND_META, catIcon } from "@/features/modhub/taxonomy";
import { t } from "@/i18n";
import { kindLabel, localized } from "./display";
import type { ResourcesCtx } from "./context";
import type { TextureComponent } from "./types";

/** One online catalog row: corner light speaks the install state (yellow
 *  = update, green = current, blue = only a third-party copy), the tail
 *  badge mirrors it, and the busy spinner owns the tail while an install
 *  runs. */
export function renderCatalogRow(ctx: ResourcesCtx, entry: CatalogEntry, selKey: string) {
  const text = localized(entry);
  const record = ctx.recordOf(entry.id);
  const upToDate = !!record && record.version === entry.version;
  // Corner light — install state at a glance: yellow
  // while a newer catalog version exists, green once
  // current, blue when only a third-party copy (no
  // WoWSP ledger row) occupies the slot.
  const light: "green" | "yellow" | "blue" | null = record
    ? upToDate
      ? "green"
      : "yellow"
    : ctx.foreignCopyOf(entry)
      ? "blue"
      : null;
  const busyOp = ctx.busy.value.get(entry.id);
  const busyInstall = busyOp === "install" || busyOp === "update";
  const RowIcon = catIcon(entry.category);
  return (
    <button
      key={entry.id}
      class={["mod-row", selKey === entry.id && "mod-row--active"]}
      onClick={() => ctx.selectCatalog(entry)}
    >
      <span class="mod-row__tile mod-row__tile--cat">
        <RowIcon size={20} />
        {light && (
          <span class={["mod-row__dot", `mod-row__dot--${light}`]} />
        )}
      </span>
      <span class="mod-row__body">
        <span class="mod-row__name">
          {text.name || entry.title || entry.nameEn}
        </span>
        <span class="mod-row__sub">{text.desc || entry.nameEn}</span>
      </span>
      <span class="mod-row__tail">
        {busyInstall ? (
          <span class="mod-row__spinner" />
        ) : upToDate ? (
          <span class="mod-row__badge mod-row__badge--ok">
            {t("resources.installedBadge")}
          </span>
        ) : record ? (
          <span class="mod-row__badge mod-row__badge--up">
            {t("resources.update")}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** One material-component row (the texture category's grouped view). */
export function renderComponentRow(ctx: ResourcesCtx, comp: TextureComponent) {
  const active =
    ctx.selection.value?.mode === "component" &&
    ctx.selection.value.comp.key === comp.key;
  return (
    <button
      key={comp.key}
      class={["mod-row", active && "mod-row--active"]}
      onClick={() => ctx.selectComponent(comp)}
    >
      <span class="mod-row__tile mod-row__tile--textures">
        <ImageIcon size={20} />
      </span>
      <span class="mod-row__body">
        <span class="mod-row__name">{comp.label}</span>
        <span class="mod-row__sub">
          {t("resources.componentSources", {
            count: comp.units.length,
          })}
        </span>
      </span>
    </button>
  );
}

/** One installed-unit row. */
export function renderInstalledRow(ctx: ResourcesCtx, m: InstalledMod, selKey: string) {
  const meta = KIND_META[m.kind];
  const Icon = meta.icon;
  const state = ctx.unitBusy.value.get(m.relPath);
  // Corner light — every listed unit is installed.
  // A ledger row (WoWSP's own install) speaks first,
  // mirroring pairedRelationOf: yellow when it lags
  // the catalog, green when current. Only units the
  // ledger doesn't know fall to the Aslain verdict
  // (blue); everything else is plain-installed green.
  const paired = ctx.pairedEntryOf(m);
  const ledger = m.identity ? ctx.recordOf(m.identity) : null;
  const light: "blue" | "yellow" | "green" =
    paired && ledger
      ? ledger.version !== paired.version
        ? "yellow"
        : "green"
      : ctx.isAslainUnit(m)
        ? "blue"
        : "green";
  return (
    <button
      key={m.relPath}
      class={[
        "mod-row",
        m.disabled && "mod-row--disabled",
        selKey === m.relPath && "mod-row--active",
      ]}
      onClick={() => ctx.selectInstalled(m)}
    >
      <span class={["mod-row__tile", `mod-row__tile--${meta.class}`]}>
        <Icon size={20} />
        <span class={["mod-row__dot", `mod-row__dot--${light}`]} />
      </span>
      <span class="mod-row__body">
        <span class="mod-row__name">
          {ctx.unitDisplayName(m)}
          {m.version && <span class="mod-row__ver">{m.version}</span>}
        </span>
        <span class="mod-row__sub">
          {m.textureAnalysis?.ships?.length
            ? t("resources.texCover", {
              count: m.textureAnalysis.ships.length,
              ships: m.textureAnalysis.ships.slice(0, 2).join(" · "),
            })
            : ctx.unitDisplayName(m) !== m.name
              ? `${kindLabel(m.kind)} · ${m.name}`
              : `${kindLabel(m.kind)} · ${m.relPath}`}
        </span>
      </span>
      <span class="mod-row__tail">
        {state ? (
          <span class="mod-row__spinner" />
        ) : m.disabled ? (
          <span class="mod-row__badge mod-row__badge--off">
            {t("resources.disabled")}
          </span>
        ) : null}
        {ctx.isAslainUnit(m) && (
          <span class="mod-row__badge mod-row__badge--src">
            {t("resources.foreignSource.aslain")}
          </span>
        )}
      </span>
    </button>
  );
}

/** The ModStation strip below the installed list — those trees sit
 *  outside res_mods, so the scan never lists them with the rest. */
export function renderModstationStrip(ctx: ResourcesCtx) {
  if (ctx.source.value !== "installed" || ctx.modstationUnits.value.length === 0) {
    return null;
  }
  return (
    <div class="resources-view__foreign-strip">
      <span class="resources-view__foreign-strip-title">
        {t("resources.foreignSource.modstation")}
      </span>
      {ctx.modstationUnits.value.map((unit: ForeignModUnit) => (
        <button
          key={`${unit.installer}/${unit.key}`}
          class={[
            "mod-row",
            ctx.selection.value?.mode === "foreign" &&
              ctx.selection.value.unit.key === unit.key &&
              ctx.selection.value.unit.installer === unit.installer &&
              "mod-row--active",
          ]}
          onClick={() => ctx.selectForeign(unit)}
        >
          <span class="mod-row__tile mod-row__tile--cat">
            <Puzzle size={20} />
          </span>
          <span class="mod-row__body">
            <span class="mod-row__name">{unit.name}</span>
            <span class="mod-row__sub">
              {unit.identity
                ? t("resources.foreignPaired")
                : t("resources.foreignUnpaired")}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
