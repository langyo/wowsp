/** The Resources view's right-hand detail pane — plain render functions
 *  taking the view context (they render INSIDE ResourcesView's own tree,
 *  so the pane vnodes stay children of the view component). One function
 *  per selection mode; renderPane narrows the union and dispatches. */
import {
  AlertTriangle,
  Ban,
  CircleCheck,
  Ellipsis,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  ImageIcon,
  ListTree,
  MousePointerClick,
  Puzzle,
  Trash2,
  User,
} from "@lucide/vue";
import {
  HkButton,
  HkIconButton,
  HkImagePreview,
  HMenu,
  HkScrollContainer,
  HkSwitch,
  HkTabs,
} from "@celestia-island/hikari";

import type { CatalogEntry, InstalledMod, ForeignModUnit, ModInstallRecord, TextureAnalysis } from "@/api";
import ErrorCard from "@/components/base/ErrorCard";
import { KIND_META, catIcon, isCatalogCat } from "@/features/modhub/taxonomy";
import { listedEntries } from "@/features/modhub/catalogListed";
import AssetPreview from "@/features/modhub/AssetPreview";
import { openExternal } from "@/utils/openExternal";
import { mediaImageUrl } from "@/utils/media";
import { t } from "@/i18n";
import {
  bigOfKind,
  catalogKb,
  discussionUrl,
  installerLabel,
  kindLabel,
  localized,
  presetDesc,
  presetLabel,
  presetSwitched,
  tagLabel,
  texLabel,
} from "./display";
import { commonRootDir, splitGameRootFiles } from "./fileTree";
import type { ResourcesCtx } from "./context";
import type { TextureComponent } from "./types";

/** Compact breakdown of a texture-override tree — category / nation /
 *  species tags, the covered ship units, file-kind counts. Shared by the
 *  installed pane and the install plan card. */
function renderTexAnalysis(a: TextureAnalysis) {
  const tags = [
    ...a.categories.map((c) => ({
      key: `cat-${c}`,
      text: texLabel("cat", c),
      cls: "tex-tag--cat",
    })),
    ...a.nations.map((n) => ({ key: `nat-${n}`, text: texLabel("nation", n), cls: "" })),
    ...a.species.map((s) => ({ key: `spc-${s}`, text: texLabel("species", s), cls: "" })),
    ...a.spaceNames.slice(0, 2).map((s) => ({ key: `space-${s}`, text: s, cls: "" })),
  ];
  const shownShips = a.ships.slice(0, 4);
  const meta = [
    t(a.truncated ? "resources.tex.filesOver" : "resources.tex.files", {
      count: a.fileCount,
    }),
    ...a.fileKinds.slice(0, 4).map((k) => `${k.ext} ${k.count}`),
  ].join(" · ");
  return (
    <div class="tex-analysis">
      {tags.length > 0 && (
        <div class="tex-analysis__tags">
          {tags.map((tag) => (
            <span key={tag.key} class={["tex-tag", tag.cls]}>
              {tag.text}
            </span>
          ))}
        </div>
      )}
      {shownShips.length > 0 && (
        <div class="tex-analysis__ships" title={a.ships.join("\n")}>
          {shownShips.map((s) => (
            <span key={s} class="tex-ship">
              {s}
            </span>
          ))}
          {a.ships.length > shownShips.length && (
            <span class="tex-ship tex-ship--more">
              {t("resources.tex.moreShips", { count: a.ships.length - shownShips.length })}
            </span>
          )}
        </div>
      )}
      <div class="tex-analysis__meta">{meta}</div>
    </div>
  );
}

/** The detail head's ⋯ menu: open the unit's folder in the OS file
 *  manager, jump to the online thread, open the file-list window. Shared
 *  by the catalog and installed panes; a null action disables its item. */
function renderDetailMenu(
  ctx: ResourcesCtx,
  actions: { reveal: (() => void) | null; onlineUrl: string | null; files: (() => void) | null },
) {
  return (
    <span class="mod-detail__menu" ref={ctx.fileWindow.detailMenuAnchor}>
      <HkIconButton
        size={24}
        variant="ghost"
        data-hint={t("resources.detailMenu")}
        aria-label={t("resources.detailMenu")}
        onClick={() =>
          (ctx.fileWindow.detailMenuOpen.value = !ctx.fileWindow.detailMenuOpen.value)
        }
      >
        <Ellipsis size={15} />
      </HkIconButton>
      <HMenu
        variant="popup"
        title={t("resources.detailMenu")}
        open={ctx.fileWindow.detailMenuOpen.value}
        anchorRef={ctx.fileWindow.detailMenuAnchor.value}
        placement="bottom-end"
        items={[
          {
            key: "open-path",
            label: t("resources.actionOpenPath"),
            icon: FolderOpen,
            disabled: !actions.reveal,
          },
          {
            key: "online",
            label: t("resources.actionOnlinePage"),
            icon: ExternalLink,
            disabled: !actions.onlineUrl,
          },
          {
            key: "files",
            label: t("resources.actionFileList"),
            icon: ListTree,
            disabled: !actions.files,
          },
        ]}
        // HMenu emits the item key as the first argument (hikari: emit("select", item.key, item)).
        onSelect={(key: string | number) => {
          ctx.fileWindow.detailMenuOpen.value = false;
          if (key === "open-path") actions.reveal?.();
          else if (key === "online" && actions.onlineUrl) openExternal(actions.onlineUrl);
          else if (key === "files") actions.files?.();
        }}
        onUpdate:open={(v: boolean) => (ctx.fileWindow.detailMenuOpen.value = v)}
      />
    </span>
  );
}

/** Open the on-disk folder behind a detail pane: an explicit rel path
 *  (installed pane) or the ledger record's common root (catalog pane);
 *  an empty bin version lets the backend resolve the current one. */
function revealUnit(ctx: ResourcesCtx, record: ModInstallRecord | null, relPath: string) {
  void ctx.fileWindow.reveal(
    record?.binVersion ?? "",
    relPath ||
      (record ? commonRootDir(splitGameRootFiles(record.files).resMods) : ""),
  );
}

function renderCatalogDetail(ctx: ResourcesCtx, entry: CatalogEntry) {
  const text = localized(entry);
  // Folded style families pair through superseded legacy ids too.
  const record = ctx.recordOfEntry(entry);
  const foreignCopy = ctx.foreignCopyOf(entry);
  const upToDate = !!record && record.version === entry.version;
  const busyState = ctx.busy.value.get(entry.id);
  // The batch pass registers its items as "update" — same busy look.
  const busyInstall = busyState === "install" || busyState === "update";
  const busyUninstall = busyState === "uninstall";
  const progressEntry = ctx.progresses.value.get(entry.id);
  const url = discussionUrl(entry.discussion);
  const kb = catalogKb(entry);
  const CatIcon = catIcon(entry.category);
  // The scheme on the pane drives BOTH the preview image and the note
  // under the buttons — folded style families carry one screenshot and
  // their variant caveats per scheme, so flipping the button group
  // swaps them; plain entries and note-less schemes fall back to the
  // entry-level media.
  const activeScheme =
    (entry.presets ?? []).find((p) => p.id === ctx.activePreset(entry)) ??
    null;
  const schemeNote = activeScheme ? presetDesc(activeScheme) : "";
  const previewSrc = activeScheme?.preview ?? entry.preview;
  return (
    <div class="mod-detail">
      <div class="mod-detail__head">
        <span class="mod-row__tile mod-row__tile--cat mod-row__tile--lg">
          <CatIcon size={24} />
        </span>
        <div class="mod-detail__id">
          <div class="mod-detail__name">{text.name || entry.title || entry.nameEn}</div>
          <div class="mod-detail__en">{entry.nameEn}</div>
        </div>
        {renderDetailMenu(ctx, {
          // Open-path points at the ON-DISK folder of a WoWSP-managed
          // install — grayed out until the entry actually has one.
          reveal: record && ctx.gameRoot.value
            ? () => revealUnit(ctx, record, "")
            : null,
          onlineUrl: url || null,
          files: () => ctx.fileWindow.openForEntry(entry),
        })}
      </div>
      {/* Pane body scroller: hikari's scroll container owns the scrollbar
          (overlay track); the body scrolls inside its viewport. */}
      <HkScrollContainer class="mod-detail__scroll">
        <div class="mod-detail__inner">
        {foreignCopy && (
          <div class="mod-detail__foreign-copy">
            {t("resources.foreignCopy", {
              source: installerLabel(foreignCopy.installer),
            })}
          </div>
        )}
        <div class="mod-detail__badges">
          {isCatalogCat(entry.category) && (
            <span class="mod-detail__badge">{t(`resources.cat.${entry.category}`)}</span>
          )}
          {(entry.authors ?? []).map((a) =>
            a.url ? (
              <button
                key={a.name}
                class="mod-detail__tag mod-detail__tag--link"
                data-hint={t("resources.authorPage")}
                onClick={() => openExternal(a.url)}
              >
                <User size={12} />
                {a.name}
                <ExternalLink size={11} />
              </button>
            ) : (
              <span key={a.name} class="mod-detail__tag">
                <User size={12} />
                {a.name}
              </span>
            ),
          )}
          {record && !upToDate && (
            <span class="mod-detail__badge mod-detail__badge--warn">
              {t("resources.installedAt", { version: record.version })}
            </span>
          )}
          {upToDate && (
            <span class="mod-detail__badge mod-detail__badge--ok">
              {t("resources.installedBadge")}
            </span>
          )}
          {(entry.tags ?? []).map((id) => {
            const tag = ctx.tagTable.value.get(id);
            return (
              <span
                key={id}
                class={[
                  "mod-detail__tag",
                  tag?.kind === "ip" ? "mod-detail__tag--ip" : "",
                  id === "ai-generated" ? "mod-detail__tag--ai" : "",
                ]}
              >
                {tag ? tagLabel(tag) : id}
              </span>
            );
          })}
        </div>
        {entry.presets && entry.presets.length > 0 && (
          <div class="mod-detail__presets">
            <span class="mod-detail__presets-label">{t("resources.presetLabel")}</span>
            <HkTabs
              variant="segmented"
              block
              modelValue={ctx.activePreset(entry)}
              onUpdate:modelValue={(v: string) => (ctx.selectedPreset.value = v)}
              tabs={(entry.presets ?? []).map((p) => ({
                key: p.id,
                label: presetLabel(p),
              }))}
              renderPanels={false}
            />
            {/* The selected scheme's own caveats (mutual exclusions,
                replay breakage…) — the reason a style family folds into
                buttons instead of separate entries is exactly that each
                variant carries different warnings. */}
            {schemeNote && <p class="mod-detail__preset-note">{schemeNote}</p>}
          </div>
        )}
        {(text.desc || entry.description) && (
          <p class="mod-detail__desc">{text.desc || entry.description}</p>
        )}
        {/* Preview images route through the media proxy (proxy-aware
         *  client + mirror ladder + disk cache) — the raw GitHub URL is
         *  both outside the CSP's img-src and unreachable for many CN
         *  users when fetched by the webview directly. Keyed by the
         *  scheme so switching buttons remounts (not smears) the image. */}
        {previewSrc && (
          <HkImagePreview
            key={activeScheme?.id ?? "default"}
            src={mediaImageUrl(previewSrc)}
            alt={text.name || entry.title}
            objectFit="contain"
          />
        )}
        <div class="mod-detail__meta">
          <span>{t("resources.gameRange", { game: entry.game })}</span>
          {kb > 0 && (
            <span>{t("resources.pkgCount", { count: entry.packages.length, kb })}</span>
          )}
        </div>
        {/* The package-by-package file listing moved into the ⋯ menu's
            file-list window; the meta row above keeps the summary. */}
        </div>
      </HkScrollContainer>
      <div class="mod-detail__foot">
        {busyInstall && progressEntry && (
          <div class="mod-detail__progress">
            <div
              class="mod-detail__progress-bar"
              style={{
                width: `${Math.min(
                  100,
                  progressEntry.total > 0
                    ? (progressEntry.received / progressEntry.total) * 100
                    : 12,
                )}%`,
              }}
            />
          </div>
        )}
        <div class="mod-detail__foot-row">
          {url && (
            <button
              class="mod-detail__link"
              data-hint={t("resources.openDiscussion")}
              onClick={() => openExternal(url)}
            >
              <ExternalLink size={13} />
              {t("resources.discuss")}
            </button>
          )}
          <div class="mod-detail__actions">
            {record && (
              <button
                class="mod-detail__danger"
                disabled={!!busyState}
                onClick={() => (ctx.confirmTarget.value = entry)}
              >
                <Trash2 size={13} />
                {busyUninstall ? t("resources.uninstalling") : t("resources.uninstall")}
              </button>
            )}
            {/* The install action stays reachable even when the ledger
             * says "installed and current" — the backend rewinds the
             * same-id record and reinstalls over it, so this is also
             * the escape hatch for any residue that badges an entry
             * installed after its files are gone. */}
            {!entry.bundled && (
              <HkButton
                size="sm"
                variant="primary"
                class={
                  presetSwitched(entry, record, ctx.activePreset(entry))
                    ? "mod-detail__action-warn"
                    : undefined
                }
                disabled={!!busyState || !ctx.gameRoot.value}
                loading={busyInstall}
                onClick={() =>
                  ctx.installMod(
                    entry,
                    entry.presets?.length
                      ? ctx.selectedPreset.value || entry.presets[0].id
                      : undefined,
                  )
                }
              >
                {busyInstall
                  ? t("resources.installingMod")
                  : presetSwitched(entry, record, ctx.activePreset(entry))
                    ? t("resources.presetApplyReinstall")
                    : record
                    ? upToDate
                      ? t("resources.reinstallSame")
                      : t("resources.update")
                      : foreignCopy
                      ? t("resources.reinstall")
                      : t("resources.install")}
              </HkButton>
            )}
            {entry.bundled && (
              <span class="mod-detail__bundled">{t("resources.bundledWithApp")}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderInstalledDetail(ctx: ResourcesCtx, mod: InstalledMod) {
  const meta = KIND_META[mod.kind];
  const Icon = meta.icon;
  const state = ctx.unitBusy.value.get(mod.relPath);
  const paired = ctx.pairedEntryOf(mod);
  // A folded style family's ledger record may sit under a superseded
  // legacy id — pair through the entry, not the raw identity string.
  const record = paired
    ? (ctx.recordOfEntry(paired) ?? null)
    : mod.identity
      ? (ctx.recordOf(mod.identity) ?? null)
      : null;
  return (
    <div class="mod-detail">
      <div class="mod-detail__head">
        <span class={["mod-row__tile", `mod-row__tile--${meta.class}`, "mod-row__tile--lg"]}>
          <Icon size={24} />
        </span>
        <div class="mod-detail__id">
          <div class="mod-detail__name">
            {ctx.unitDisplayName(mod)}
            {mod.version && <span class="mod-row__ver">{mod.version}</span>}
          </div>
          <div class="mod-detail__en">{kindLabel(mod.kind)}</div>
        </div>
        {renderDetailMenu(ctx, {
          reveal: ctx.gameRoot.value
            ? () => revealUnit(ctx, record, mod.relPath)
            : null,
          onlineUrl: paired ? discussionUrl(paired.discussion) : null,
          files: paired || record ? () => ctx.fileWindow.openForUnit(mod) : null,
        })}
      </div>
      <HkScrollContainer class="mod-detail__scroll">
        <div class="mod-detail__inner">
        {(mod.disabled || ctx.isAslainUnit(mod)) && (
          <div class="mod-detail__badges">
            {mod.disabled && (
              <span class="mod-detail__badge mod-detail__badge--warn">
                {t("resources.disabled")}
              </span>
            )}
            {ctx.isAslainUnit(mod) && (
              <span class="mod-detail__badge">
                {t("resources.foreignSource.aslain")}
              </span>
            )}
          </div>
        )}
        {(() => {
          if (!paired) return null;
          return (
            <div class="mod-detail__paired">
              <div class="mod-detail__paired-head">
                <span>{t("resources.pairedHead")}</span>
                <button class="mod-detail__link" onClick={() => ctx.selectCatalog(paired)}>
                  {t("resources.pairedOpen")}
                </button>
              </div>
              <div class="mod-detail__paired-name">
                {localized(paired).name || paired.title || paired.nameEn}
                {ctx.unitDisplayName(mod) !== mod.name && (
                  <span class="mod-detail__paired-raw">{mod.name}</span>
                )}
              </div>
              <p class="mod-detail__paired-note">{ctx.pairedRelationOf(mod, paired)}</p>
            </div>
          );
        })()}
        {(mod.warnings ?? []).length > 0 && (
          <ul class="plan-card__warnings">
            {(mod.warnings ?? []).map((w, i) => (
              <li key={`${i}-${w}`}>
                <AlertTriangle size={12} /> {w}
              </li>
            ))}
          </ul>
        )}
        {mod.textureAnalysis && renderTexAnalysis(mod.textureAnalysis)}
        {/* The material section: one preview area per unit — texture
            thumbnails above, custom-model meshes (incl. the 3D stage)
            below, from a single asset listing. */}
        {bigOfKind(mod.kind) === "texture" && (
          <AssetPreview gameRoot={ctx.gameRoot.value} relPath={mod.relPath} mode="texture" />
        )}
        {mod.kind === "voice" && (
          <AssetPreview gameRoot={ctx.gameRoot.value} relPath={mod.relPath} mode="audio" />
        )}
        {mod.kind === "script" && (
          <AssetPreview
            gameRoot={ctx.gameRoot.value}
            relPath={mod.relPath}
            mode="model"
            silentEmpty
          />
        )}
        {mod.detail && <div class="mod-detail__desc">{mod.detail}</div>}
        {/* Unit root paths and full file listings live in the ⋯ menu's
            file-list window now; the hint stays because it explains why
            the enable switch below is missing. */}
        {mod.paths.length === 0 && <p class="mod-detail__hint">{t("resources.manifestOnly")}</p>}
        </div>
      </HkScrollContainer>
      <div class="mod-detail__foot">
        <div class="mod-detail__foot-row">
          {mod.paths.length > 0 ? (
            <HkSwitch
              size="sm"
              modelValue={!mod.disabled}
              disabled={!!state}
              onUpdate:modelValue={(v: boolean) => ctx.toggleUnit(mod, v)}
            >
              {mod.disabled ? t("resources.disabled") : t("resources.enabled")}
            </HkSwitch>
          ) : (
            <span class="mod-detail__hint">{t("resources.manifestOnlyShort")}</span>
          )}
          <div class="mod-detail__actions">
            <button
              class="mod-detail__danger"
              disabled={!!state}
              onClick={() => (ctx.unitTarget.value = mod)}
            >
              <Trash2 size={13} />
              {state === "uninstall" ? t("resources.uninstalling") : t("resources.uninstall")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function renderForeignDetail(ctx: ResourcesCtx, unit: ForeignModUnit) {
  const paired = unit.identity
    ? listedEntries(ctx.catalog.value).find((e) => e.id === unit.identity)
    : undefined;
  // Aslain rows are anchored in the installed list under their
  // manifest name — resolving that row hands this pane the same
  // toggle / uninstall the installed list has (the backend deletes
  // files AND cuts the manifest row). ModStation trees live outside
  // res_mods and uninstall through their own command.
  const aslainRow =
    unit.installer === "aslain"
      ? ctx.installed.value.find((m) => m.name === unit.name) ?? null
      : null;
  const aslainBusy = aslainRow ? ctx.unitBusy.value.get(ctx.unitKey(aslainRow)) : undefined;
  return (
    <div class="mod-detail">
      <div class="mod-detail__head">
        <span class="mod-row__tile mod-row__tile--cat mod-row__tile--lg">
          <Puzzle size={24} />
        </span>
        <div class="mod-detail__id">
          <div class="mod-detail__name">{unit.name}</div>
          <div class="mod-detail__en">{installerLabel(unit.installer)}</div>
        </div>
      </div>
      <HkScrollContainer class="mod-detail__scroll">
        <div class="mod-detail__inner">
        <div class="mod-detail__badges">
          <span class="mod-detail__badge">
            {t("resources.foreignBadge", { source: installerLabel(unit.installer) })}
          </span>
          {unit.version && <span class="mod-detail__badge">v{unit.version}</span>}
          {paired && (
            <span class="mod-detail__badge mod-detail__badge--ok">
              {t("resources.foreignPaired")}
            </span>
          )}
        </div>
        <p class="mod-detail__desc">
          {t("resources.foreignManaged", {
            name: unit.name,
            source: installerLabel(unit.installer),
          })}
        </p>
        {paired && (
          <p class="mod-detail__hint">
            {t("resources.foreignPairedHint", { name: localized(paired).name })}
          </p>
        )}
        </div>
      </HkScrollContainer>
      <div class="mod-detail__foot">
        <div class="mod-detail__foot-row">
          {aslainRow && aslainRow.paths.length > 0 ? (
            <HkSwitch
              size="sm"
              modelValue={!aslainRow.disabled}
              disabled={!!aslainBusy}
              onUpdate:modelValue={(v: boolean) => ctx.toggleUnit(aslainRow, v)}
            >
              {aslainRow.disabled ? t("resources.disabled") : t("resources.enabled")}
            </HkSwitch>
          ) : null}
          <div class="mod-detail__actions">
            {aslainRow ? (
              <button
                class="mod-detail__danger"
                disabled={!!aslainBusy}
                onClick={() => (ctx.unitTarget.value = aslainRow)}
              >
                <Trash2 size={13} />
                {aslainBusy === "uninstall"
                  ? t("resources.uninstalling")
                  : t("resources.uninstall")}
              </button>
            ) : (
              <button
                class="mod-detail__danger"
                onClick={() => (ctx.foreignTarget.value = unit)}
              >
                <Trash2 size={13} />
                {t("resources.uninstall")}
              </button>
            )}
            {paired && (
              <HkButton
                size="sm"
                variant="secondary"
                onClick={() => ctx.selectCatalog(paired)}
              >
                {t("resources.foreignOpenPaired")}
              </HkButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The material component pane: the covered part at the top, then one
 *  section per pack writing files there — registered pack name (from
 *  the wowsp.toml pairing) when known, the directory name otherwise —
 *  each with its texture previews and a jump to the catalog entry for
 *  replacing. */
function renderComponentDetail(ctx: ResourcesCtx, comp: TextureComponent) {
  return (
    <div class="mod-detail">
      <div class="mod-detail__head">
        <span class="mod-row__tile mod-row__tile--textures mod-row__tile--lg">
          <ImageIcon size={24} />
        </span>
        <div class="mod-detail__id">
          <div class="mod-detail__name">{comp.label}</div>
          <div class="mod-detail__en">
            {t("resources.componentSources", { count: comp.units.length })}
          </div>
        </div>
      </div>
      <HkScrollContainer class="mod-detail__scroll">
        <div class="mod-detail__inner">
        {comp.units.map((unit) => {
          const paired = ctx.pairedEntryOf(unit);
          return (
            <div class="mod-detail__component" key={unit.relPath}>
              <div class="mod-detail__component-head">
                <span class="mod-detail__component-name">
                  {paired
                    ? t("resources.componentFrom", {
                      name: localized(paired).name,
                    })
                    : unit.name}
                </span>
                {paired && (
                  <HkButton
                    size="sm"
                    variant="ghost"
                    onClick={() => ctx.selectCatalog(paired)}
                  >
                    {t("resources.componentReplace")}
                  </HkButton>
                )}
              </div>
              <AssetPreview
                gameRoot={ctx.gameRoot.value}
                relPath={unit.relPath}
                mode="image"
              />
            </div>
          );
        })}
        </div>
      </HkScrollContainer>
    </div>
  );
}

function renderLocalDetail(ctx: ResourcesCtx) {
  return (
    <div class="mod-detail">
      <div class="mod-detail__head">
        <span class="mod-row__tile mod-row__tile--lg">
          <FolderSearch size={24} />
        </span>
        <div class="mod-detail__id">
          <div class="mod-detail__name">{t("resources.installSection")}</div>
          <div class="mod-detail__en">{t("resources.installHint")}</div>
        </div>
      </div>
      <HkScrollContainer class="mod-detail__scroll">
        <div class="mod-detail__inner">
        <div class="resources-installrow">
          {/* Readonly display of the picker's choice (audit H-3): installs
              only accept paths a native folder dialog handed out, so there
              is no free-typed path anymore. */}
          <input
            type="text"
            value={ctx.sourcePath.value}
            readonly
            placeholder={t("resources.pathPlaceholder")}
            spellcheck={false}
          />
          <button
            disabled={ctx.analyzing.value || !ctx.gameRoot.value}
            onClick={ctx.pickAndAnalyze}
          >
            {ctx.analyzing.value ? t("resources.analyzing") : t("resources.pickFolder")}
          </button>
        </div>
        {ctx.planError.value && (
          <ErrorCard error={ctx.planError.value} />
        )}
        {ctx.report.value && (
          <div class="resources-banner resources-banner--ok">
            {t("resources.installedOk", {
              name: ctx.report.value.name,
              count: ctx.report.value.count,
              version: ctx.report.value.version,
            })}
            {ctx.report.value.mirrored.length > 0 && (
              <ul class="plan-card__warnings resources-report-mirrored">
                {ctx.report.value.mirrored.map((v) => (
                  <li key={v}>
                    <CircleCheck size={12} />{" "}
                    {t("resources.mirroredBins", { version: v })}
                  </li>
                ))}
              </ul>
            )}
            {ctx.report.value.warnings.length > 0 && (
              <ul class="plan-card__warnings resources-report-warnings">
                {ctx.report.value.warnings.map((w, i) => (
                  <li key={`${i}-${w}`}>
                    <AlertTriangle size={12} /> {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {ctx.plan.value && (
          <div class={`plan-card plan-card--${KIND_META[ctx.plan.value.kind].class}`}>
            <div class="plan-card__head">
              {(() => {
                const Icon = KIND_META[ctx.plan.value!.kind].icon;
                return <Icon size={18} />;
              })()}
              <strong>{ctx.plan.value.name}</strong>
              <span class="plan-card__badge">{kindLabel(ctx.plan.value.kind)}</span>
              {ctx.plan.value.detail && <span class="plan-card__detail">{ctx.plan.value.detail}</span>}
            </div>
            {ctx.plan.value.textureAnalysis && renderTexAnalysis(ctx.plan.value.textureAnalysis)}
            {ctx.plan.value.entries.length > 0 && (
              <table class="plan-card__files">
                <caption>{t("resources.planFiles")}</caption>
                <tbody>
                  {ctx.plan.value.entries.map((e) => (
                    <tr key={e.fromRel + e.toRel}>
                      <td>{e.fromRel === "." ? "." : `${e.fromRel}/`}</td>
                      <td>→</td>
                      <td>{e.toRel}/</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {ctx.plan.value.warnings.length > 0 && (
              <ul class="plan-card__warnings">
                {ctx.plan.value.warnings.map((w) => (
                  <li key={w}>
                    <AlertTriangle size={12} /> {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        </div>
      </HkScrollContainer>
      <div class="mod-detail__foot">
        <div class="mod-detail__foot-row">
          <div class="mod-detail__actions">
            <HkButton
              size="sm"
              variant="primary"
              disabled={!ctx.plan.value || ctx.installing.value || !ctx.gameRoot.value}
              loading={ctx.installing.value}
              onClick={ctx.confirmInstall}
            >
              {ctx.installing.value ? t("resources.installing") : t("resources.confirmInstall")}
            </HkButton>
          </div>
        </div>
      </div>
    </div>
  );
}

export function renderPane(ctx: ResourcesCtx) {
  // A deep link into a delisted mod explains itself BEFORE the empty
  // state — the entry is real, just not openable anymore.
  const gone = ctx.delistedHit.value;
  if (!ctx.selection.value && gone) {
    const text = localized(gone);
    return (
      <div class="mod-detail mod-detail--empty">
        <div class="mod-detail__placeholder">
          <Ban size={30} />
          <strong class="mod-detail__placeholder-title">
            {t("resources.delistedTitle")}
          </strong>
          <p>
            {t("resources.delistedHint", {
              name: text.name || gone.nameEn || gone.title,
            })}
          </p>
        </div>
      </div>
    );
  }
  const sel = ctx.selection.value;
  if (!sel) {
    return (
      <div class="mod-detail mod-detail--empty">
        <div class="mod-detail__placeholder">
          <MousePointerClick size={30} />
          <p>{t("resources.pickHint")}</p>
        </div>
      </div>
    );
  }
  switch (sel.mode) {
    case "catalog":
      return renderCatalogDetail(ctx, sel.entry);
    case "installed":
      return renderInstalledDetail(ctx, sel.mod);
    case "foreign":
      return renderForeignDetail(ctx, sel.unit);
    case "component":
      return renderComponentDetail(ctx, sel.comp);
    case "local":
      return renderLocalDetail(ctx);
  }
}
