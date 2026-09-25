/**
 * Path identity for game installs. Detection feeds the same folder through
 * several pipelines (registry values keep the installer's casing and trailing
 * separator, Steam's vdf uses the library's), and the settings list keys rows
 * by path — so every "is this the same install?" comparison goes through
 * `sameGamePath` instead of `===`, mirroring the Rust-side dedupe key
 * (commands/game_detect.rs `install_path_key`).
 */

/** Normalized identity of an install path: backslash separators, no trailing
 *  separator, lowercased (Windows filesystems are case-insensitive). */
export function normalizeGamePath(path: string): string {
  let key = path.replaceAll("/", "\\").toLowerCase();
  while (key.endsWith("\\")) key = key.slice(0, -1);
  return key;
}

/** Whether two install-path spellings resolve to the same folder. */
export function sameGamePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeGamePath(a) === normalizeGamePath(b);
}
