/** The Resources view's render-context type: everything the plain render
 *  functions (DetailPane / MigrateWizard / SidebarRows) receive. Type-only
 *  module — the composables know nothing about the render files, so the
 *  import graph stays one-directional. */
import type { PreviewPrefetchHandle } from "@/features/modhub/previewPrefetch";
import type { ModHubCtx } from "./useModHub";
import type { MigrateWizardCtx } from "./useMigrateWizard";
import type { ImportWizardCtx } from "./useImportWizard";
import type { FileListWindowCtx } from "./useFileListWindow";

export type ResourcesCtx = ModHubCtx & MigrateWizardCtx & ImportWizardCtx & {
  fileWindow: FileListWindowCtx;
  /** Catalog preview prefetcher (row visibility + selected entry media). */
  previewPrefetch: PreviewPrefetchHandle;
};
