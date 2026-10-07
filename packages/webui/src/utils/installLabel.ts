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

/** Short SERVER tag for a replay or battle row: the realm uppercased
 *  ("ASIA" / "CN" / "RU"), else the client kind's label (Lesta / 国服 …),
 *  else "" — one tag vocabulary shared by the replay cards, the replay
 *  rail's count row and the playtime scope menu. The realm wins because it
 *  is the identity that decides WHICH SERVER recorded the file (two installs
 *  of the same kind on different realms are different servers); the kind is
 *  only a fallback for installs whose realm never resolved. */
export function serverTagOf(kind?: GameInstallKind | null, realm?: string | null): string {
  if (realm) return realm.toUpperCase();
  return kindLabel(kind);
}

/** The folder name off an install path — the last non-empty segment, both
 *  separator spellings handled (Windows paths reach the webui in either).
 *  Used to disambiguate same-labelled installs and to label a persisted
 *  client pick whose install has since disappeared. */
export function installFolderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Path segments, deepest last (empty ones dropped). */
function pathSegments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

/** The shortest tail of `path` (folder names, deepest last) that no path in
 *  `others` shares — how a same-labelled install gets a row a user can tell
 *  from its twin. One segment usually suffices (`E:\Games\World of Warships`
 *  vs `C:\SteamLibrary\steamapps\common\World of Warships`), and two
 *  installs whose LEAF folder is also identical (two Steam libraries, both
 *  `…\World of Warships`) grow one segment at a time until they differ.
 *  Falls back to the whole path when no tail can distinguish — reachable
 *  only for spelling variants that normalize apart. */
function shortestDistinguishingTail(path: string, others: readonly string[]): string {
  const mine = pathSegments(path);
  const theirs = others.map(pathSegments);
  for (let depth = 1; depth <= mine.length; depth += 1) {
    const tail = mine.slice(-depth).join("\\");
    const shared = theirs.some((segments) => segments.slice(-depth).join("\\") === tail);
    if (!shared) return tail;
  }
  return path;
}

/** Client-menu options for a detected install list: one row per install,
 *  labelled by [`installLabel`] and disambiguated with the shortest
 *  distinguishing path tail when two installs of the same kind+realm would
 *  otherwise read identically ("Steam · ASIA" twice — two Steam libraries).
 *  Rows a user cannot tell apart are unusable, and the path tail is the only
 *  thing that differs. The value is always the install's path: the identity
 *  the client filters and the battle scope compare against. */
export function clientMenuOptions(
  installs: readonly GameInstall[],
): { value: string; label: string }[] {
  const labels = installs.map((i) => installLabel(i.kind, i.realm));
  const collides = (idx: number): boolean =>
    labels.some((label, other) => other !== idx && label === labels[idx]);
  return installs.map((install, idx) => {
    const label = labels[idx] ?? install.path;
    if (!collides(idx)) return { value: install.path, label };
    const twins = installs.filter((_, other) => other !== idx && labels[other] === label);
    return {
      value: install.path,
      label: `${label} · ${shortestDistinguishingTail(
        install.path,
        twins.map((t) => t.path),
      )}`,
    };
  });
}
