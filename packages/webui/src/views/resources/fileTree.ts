/** Pure path → tree helpers for the plugin file-list window. The window
 *  feeds ledger records (`record.files`) or on-demand previews
 *  (`PackageFilePreview.files`) in, and gets back nested nodes for hikari's
 *  HkTree — kept free of Vue imports so the shape is unit-testable. */

/** `@game/` prefix the install pipeline stamps on game-root (outside
 *  res_mods) files; see mod_catalog.rs's written-file collection. */
const GAME_ROOT_PREFIX = "@game/";

export interface PathTreeNode {
  /** Segment name (folder or file). */
  name: string;
  /** Full path from this tree's root (the prefix stripped for @game). */
  path: string;
  children?: PathTreeNode[];
}

/** Split a flat written-file list into the two roots the window renders:
 *  `res_mods`-relative paths and `@game/…` game-root drops. */
export function splitGameRootFiles(files: string[]): { resMods: string[]; game: string[] } {
  const resMods: string[] = [];
  const game: string[] = [];
  for (const f of files) {
    if (f.startsWith(GAME_ROOT_PREFIX)) game.push(f.slice(GAME_ROOT_PREFIX.length));
    else resMods.push(f);
  }
  return { resMods, game };
}

/** Which tree root(s) the window renders. Dual-root entries (files both
 *  inside res_mods and in the game root) switch through the scope toggle;
 *  single-root entries always render their one root, no toggle shown. */
export type TreeScope = "res_mods" | "game";

export function treeRootsFor(
  resMods: string[],
  game: string[],
  scope: TreeScope,
): { resMods: boolean; game: boolean } {
  if (resMods.length === 0) return { resMods: false, game: game.length > 0 };
  if (game.length === 0) return { resMods: true, game: false };
  return scope === "res_mods" ? { resMods: true, game: false } : { resMods: false, game: true };
}

/** Nest one flat list of forward-slash paths into sorted folder/file
 *  nodes (folders first, then files, both alphabetical). Duplicate and
 *  empty segments are ignored; a trailing slash marks a folder. */
export function buildPathTree(files: string[]): PathTreeNode[] {
  const root: PathTreeNode = { name: "", path: "", children: [] };
  for (const file of files) {
    const segs = file.split("/").filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    let node = root;
    segs.forEach((seg, i) => {
      const isLeaf = i === segs.length - 1 && !file.endsWith("/");
      node.children ??= [];
      let next = node.children.find((c) => c.name === seg);
      if (!next) {
        next = isLeaf
          ? { name: seg, path: segs.slice(0, i + 1).join("/") }
          : { name: seg, path: segs.slice(0, i + 1).join("/"), children: [] };
        node.children.push(next);
      } else if (isLeaf && next.children) {
        // A folder and a same-named file collide (never in real payloads);
        // keep the folder — the file's presence is implied by siblings.
      }
      node = next;
    });
  }
  const sortNodes = (nodes: PathTreeNode[]): PathTreeNode[] => {
    nodes.sort((a, b) => {
      const aDir = !!a.children?.length;
      const bDir = !!b.children?.length;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children) sortNodes(n.children);
    }
    return nodes;
  };
  return sortNodes(root.children ?? []);
}

/** Longest common leading DIRECTORY chain of a written-file list — the
 * unit's own folder inside res_mods ("PnFMods/ShotTimer" for a unit whose
 * every file starts there; "" when files sit at the root, e.g. the
 * PnFModsLoader.py marker). Drives "open plugin path" from a ledger
 * record. */
export function commonRootDir(files: string[]): string {
  if (files.length === 0) return "";
  let segs = files[0].replace(/\/+$/, "").split("/").slice(0, -1);
  for (const f of files.slice(1)) {
    const other = f.replace(/\/+$/, "").split("/").slice(0, -1);
    let i = 0;
    while (i < segs.length && i < other.length && segs[i] === other[i]) i++;
    segs = segs.slice(0, i);
    if (segs.length === 0) break;
  }
  return segs.join("/");
}
