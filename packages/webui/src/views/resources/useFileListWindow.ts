/** The plugin file-list window's state machine: what the detail pane's ⋯
 *  menu pointed at, the read-only on-demand preview it may fetch, and the
 *  detail menu's own open/anchor pair. Takes the Mod Hub composable's
 *  return value as its input, mirroring useMigrateWizard. */
import { ref } from "vue";
import { useToast } from "@celestia-island/hikari";

import {
  api,
  type CatalogEntry,
  type CatalogFilePreview,
  type InstalledMod,
  type ModInstallRecord,
} from "@/api";
import { t } from "@/i18n";
import { localized } from "./display";
import type { ModHubCtx } from "./useModHub";

/** What the window is showing: a catalog entry (online pane, or an
 *  installed unit's paired entry) plus the ledger record when the
 *  install is WoWSP-managed — the record renders instantly, everything
 *  else comes from the on-demand preview. */
export interface FileListTarget {
  title: string;
  entry: CatalogEntry | null;
  record: ModInstallRecord | null;
  /** Preset resolving the entry's package list (what install would use). */
  preset?: string;
}

export function useFileListWindow(hub: ModHubCtx) {
  // The detail pane's ⋯ popup menu — one open/anchor pair shared by every
  // pane mode (only one pane renders at a time).
  const detailMenuOpen = ref(false);
  const detailMenuAnchor = ref<HTMLElement | null>(null);

  const target = ref<FileListTarget | null>(null);
  const preview = ref<CatalogFilePreview | null>(null);
  const loading = ref(false);
  const error = ref("");
  /** Selected left-list package ("all" = union; only meaningful when the
   *  per-package preview data exists). */
  const selectedPkg = ref("all");
  /** Which tree root the right pane shows: res_mods vs the game-root drops.
   * Only dual-root entries surface the toggle; the scope resets per open. */
  const treeScope = ref<"res_mods" | "game">("res_mods");
  const toast = useToast();

  function open(target_: FileListTarget) {
    target.value = target_;
    preview.value = null;
    error.value = "";
    loading.value = false;
    selectedPkg.value = "all";
    treeScope.value = "res_mods";
    // The window shows up first and fetches INSIDE: kick the preview off
    // immediately whenever this target needs one (installed units render
    // their ledger record instantly and never fetch).
    if (target_.entry && !target_.record && hub.gameRoot.value) {
      void runPreview();
    }
  }

  function close() {
    target.value = null;
    preview.value = null;
    error.value = "";
    loading.value = false;
    treeScope.value = "res_mods";
  }

  /** From the online pane: the entry drives the package list; a ledger
   *  record (when installed) renders the merged tree instantly. */
  function openForEntry(entry: CatalogEntry) {
    open({
      title: localized(entry).name || entry.title || entry.nameEn || entry.id,
      entry,
      record: hub.recordOf(entry.id) ?? null,
      preset: hub.activePreset(entry) || undefined,
    });
  }

  /** From the installed pane: paired entry when the unit has one, ledger
   *  record via the unit's identity. */
  function openForUnit(mod: InstalledMod) {
    const paired = hub.pairedEntryOf(mod);
    open({
      title: hub.unitDisplayName(mod),
      entry: paired ?? null,
      record: mod.identity ? (hub.recordOf(mod.identity) ?? null) : null,
      preset: paired ? hub.activePreset(paired) || undefined : undefined,
    });
  }

  /** Download + classify the packages (read-only). Progress rides the
   *  shared download bus under `preview:<id>` — hub.progresses carries it
   *  for the window's bar. A late answer only lands while the SAME target
   *  is still open (closing or switching the window abandons the pass —
   *  its download finishes server-side, the result is dropped). */
  async function runPreview() {
    const tgt = target.value;
    if (!tgt?.entry || !hub.gameRoot.value || loading.value) return;
    loading.value = true;
    error.value = "";
    try {
      const got = await api.modCatalogPreviewFiles(
        tgt.entry.id,
        hub.gameRoot.value,
        tgt.preset,
      );
      if (target.value !== tgt) return;
      preview.value = got;
      selectedPkg.value = "all";
    } catch (e) {
      if (target.value !== tgt) return;
      error.value = e instanceof Error ? e.message : String(e);
      toast.error(t("resources.fileListError"));
    } finally {
      if (target.value === tgt) loading.value = false;
    }
  }

  /** Open a unit folder in the OS file manager (toast carries backend
   *  errors — "path missing / uninstalled" is user-visible truth). */
  async function reveal(binVersion: string, relPath: string) {
    if (!hub.gameRoot.value) return;
    try {
      await api.modHubRevealPath(hub.gameRoot.value, binVersion, relPath);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    detailMenuOpen,
    detailMenuAnchor,
    target,
    preview,
    loading,
    error,
    selectedPkg,
    treeScope,
    openForEntry,
    openForUnit,
    close,
    runPreview,
    reveal,
  };
}

export type FileListWindowCtx = ReturnType<typeof useFileListWindow>;
