import type { GameInstall, GameInstallKind } from "@/api";
import { t } from "@/i18n";

/** Map a client kind to its localized label (e.g. Steam / 官服 / Lesta / 国服). */
export function kindLabel(kind: GameInstallKind | null | undefined): string {
  if (!kind) return "";
  return t(`common.game.kind.${kind}`);
}

/** Short label for a client install: "Steam · ASIA" (kind only when the
 *  realm is unknown). Shared by the sidebar footer, the settings game-path
 *  table and the setup modal. */
export function installLabel(
  kind: GameInstallKind | null | undefined,
  realm?: string | null,
): string {
  const parts = [kindLabel(kind)];
  if (realm) parts.push(realm.toUpperCase());
  return parts.filter(Boolean).join(" · ");
}

/** Convenience overload for a GameInstall record. */
export function installLabelOf(i: GameInstall): string {
  return installLabel(i.kind, i.realm);
}
