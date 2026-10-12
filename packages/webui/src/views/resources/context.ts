/** The Resources view's render-context type: everything the plain render
 *  functions (DetailPane / MigrateWizard / SidebarRows) receive. Type-only
 *  module — the composables know nothing about the render files, so the
 *  import graph stays one-directional. */
import type { ModHubCtx } from "./useModHub";
import type { MigrateWizardCtx } from "./useMigrateWizard";

export type ResourcesCtx = ModHubCtx & MigrateWizardCtx;
