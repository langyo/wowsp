/** The plugin file-list window — a secondary HkModal (teleported to body,
 *  the share-wizard pattern): a narrow package list on the left, and the
 *  expected game paths as an HkTree on the right, rooted at
 *  `<bin version>/res_mods`. Installed units render the ledger record's
 *  written files instantly; everything else starts the read-only preview
 *  (download to temp + classify, res_mods untouched) the moment the window
 *  opens, with the progress riding the shared download bus. */
import { Download, FileText, Folder, Package } from "@lucide/vue";
import {
  HkButton,
  HkModal,
  HkScrollContainer,
  HkSpinner,
  HkTree,
  type TreeNode,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import { buildPathTree, splitGameRootFiles, type PathTreeNode } from "./fileTree";
import { pkgKb } from "./display";
import type { ResourcesCtx } from "./context";

/** Deep trees (voice packs run to thousands of .wem files) stay collapsed
 *  on open — expanding everything would mount the whole list at once. */
const AUTO_EXPAND_MAX = 200;

/** Decorate pure path nodes into HkTree nodes (the builder sorts folders
 *  ahead of files; icons carry the distinction visually). */
function toTreeNodes(nodes: PathTreeNode[]): TreeNode[] {
  return nodes.map((n) => ({
    id: n.path,
    label: n.name,
    icon: n.children?.length ? Folder : FileText,
    status: n.children?.length
      ? t("resources.fileTreeCount", { count: n.children.length })
      : undefined,
    children: n.children?.length ? toTreeNodes(n.children) : undefined,
  }));
}

/** Root label: the concrete bin version when known ("0.11.9/res_mods"),
 *  the localized stand-in word otherwise. */
function rootLabel(version: string): string {
  return t("resources.fileTreeRoot", {
    version: version || t("resources.fileTreeUnknownVersion"),
  });
}

function renderProgress(ctx: ResourcesCtx, id: string) {
  const p = ctx.progresses.value.get(id);
  const pct = p && p.total > 0 ? Math.min(100, (p.received / p.total) * 100) : 12;
  return (
    <div class="file-window__state">
      <p class="file-window__state-title">
        <HkSpinner size="xs" tone="current" /> {t("resources.fileListBuilding")}
      </p>
      <div class="file-window__progress">
        <div class="file-window__progress-bar" style={{ width: `${pct}%` }} />
      </div>
      {p && p.packages > 1 && (
        <p class="file-window__state-sub">
          {t("resources.fileListPkgOf", { package: p.package, packages: p.packages })}
        </p>
      )}
    </div>
  );
}

export function renderFileListWindow(ctx: ResourcesCtx) {
  const files = ctx.fileWindow;
  const target = files.target.value;
  if (!target) return null;
  const preview = files.preview.value;

  // Left list: the entry's preset-resolved packages, or the preview's
  // same-order rows once fetched (those carry the per-package file maps).
  const packages = preview?.packages ?? target.entry?.packages ?? [];
  // Right-side data: the ledger's MERGED written files when installed;
  // the preview's per-package maps (filtered by the left selection)
  // otherwise — the one source that knows which zip owns which path.
  const fromLedger = !!target.record;
  const selectedPkgs =
    fromLedger || !preview
      ? []
      : files.selectedPkg.value === "all"
        ? preview.packages
        : preview.packages.filter((p) => p.name === files.selectedPkg.value);
  const shownFiles = fromLedger ? target.record!.files : selectedPkgs.flatMap((p) => p.files);
  const warnings = selectedPkgs.flatMap((p) => p.warnings);
  const binVersion = fromLedger ? target.record!.binVersion : (preview?.binVersion ?? "");
  const { resMods, game } = splitGameRootFiles(shownFiles);

  const treeNodes: TreeNode[] = [
    {
      id: "res-mods-root",
      label: rootLabel(binVersion),
      icon: Folder,
      children: toTreeNodes(buildPathTree(resMods)),
    },
  ];
  if (game.length > 0) {
    treeNodes.push({
      id: "game-root",
      label: t("resources.fileTreeGameRoot"),
      icon: Folder,
      children: toTreeNodes(buildPathTree(game)),
    });
  }
  const expandAll = shownFiles.length <= AUTO_EXPAND_MAX;
  const totalKb = packages.reduce((acc, p) => acc + (p.size > 0 ? pkgKb(p.size) : 0), 0);

  return (
    <HkModal
      modelValue={true}
      onUpdate:modelValue={(v: boolean) => {
        if (!v) files.close();
      }}
      title={t("resources.fileListTitle", { name: target.title })}
      width="min(66rem, 92vw)"
    >
      <div class="file-window">
        {/* Both panes scroll through hikari's scroll containers (overlay
            thumbs; the native bars stay hidden). The left pane keeps the
            aside landmark the plain div replaced. */}
        <HkScrollContainer class="file-window__side" as="aside">
          <div class="file-window__side-inner">
          <div class="file-window__side-title">{t("resources.fileListPackages")}</div>
          {!fromLedger && preview && packages.length > 1 && (
            <button
              type="button"
              class={[
                "file-window__pkg",
                files.selectedPkg.value === "all" && "file-window__pkg--active",
              ]}
              onClick={() => (files.selectedPkg.value = "all")}
            >
              <Package size={14} />
              <span class="file-window__pkg-name">{t("resources.fileListAll")}</span>
            </button>
          )}
          {packages.map((p) => (
            <button
              type="button"
              key={p.name}
              class={[
                "file-window__pkg",
                !fromLedger && files.selectedPkg.value === p.name && "file-window__pkg--active",
              ]}
              disabled={fromLedger || !preview}
              onClick={() => (files.selectedPkg.value = p.name)}
              title={p.name}
            >
              <Package size={14} />
              <span class="file-window__pkg-name">{p.name}</span>
              {p.size > 0 && <span class="file-window__pkg-size">{pkgKb(p.size)} KB</span>}
            </button>
          ))}
          {packages.length === 0 && (
            <p class="file-window__side-empty">{t("resources.fileListNoPackages")}</p>
          )}
          {fromLedger && (target.entry?.packages.length ?? 0) > 1 && (
            <p class="file-window__side-note">{t("resources.fileListInstalledNote")}</p>
          )}
          </div>
        </HkScrollContainer>
        <HkScrollContainer class="file-window__main">
          <div class="file-window__main-inner">
          {files.error.value && (
            <div class="resources-banner resources-banner--error">{files.error.value}</div>
          )}
          {files.loading.value && target.entry ? (
            renderProgress(ctx, `preview:${target.entry.id}`)
          ) : fromLedger ? (
            treeNodes[0].children?.length ? (
              <HkTree nodes={treeNodes} size="sm" defaultExpandAll={expandAll} />
            ) : (
              <p class="file-window__state-sub">{t("resources.fileListEmpty")}</p>
            )
          ) : preview ? (
            treeNodes[0].children?.length ? (
              <HkTree nodes={treeNodes} size="sm" defaultExpandAll={expandAll} />
            ) : (
              <p class="file-window__state-sub">{t("resources.fileListEmpty")}</p>
            )
          ) : target.entry && ctx.gameRoot.value ? (
            <div class="file-window__state">
              <p class="file-window__state-title">{t("resources.fileListPreviewHint")}</p>
              <p class="file-window__state-sub">
                {t("resources.fileListPreviewSize", { kb: totalKb })}
              </p>
              <HkButton
                size="sm"
                variant="primary"
                loading={files.loading.value}
                onClick={() => void files.runPreview()}
              >
                <Download size={13} />
                {t("resources.fileListPreviewCta")}
              </HkButton>
            </div>
          ) : (
            <div class="file-window__state">
              <p class="file-window__state-sub">{t("resources.fileListNoEntry")}</p>
            </div>
          )}
          {warnings.length > 0 && (
            <ul class="file-window__warnings">
              {warnings.map((w, i) => (
                <li key={`${i}-${w}`}>{w}</li>
              ))}
            </ul>
          )}
          </div>
        </HkScrollContainer>
      </div>
    </HkModal>
  );
}
