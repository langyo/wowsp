/**
 * The main window's title-bar version subtitle. Debug builds append the
 * compile-time git identity stamp (`branch:hash7`, resolved by build.rs and
 * served through the `get_build_identity` command) so a running debug
 * binary says exactly which checkout it came from; release builds and
 * browser dev mode answer no stamp and render the bare `v<version>`.
 * A portable build (the `is_portable` probe) appends the localized
 * portable tag after the version (`v0.6.1 便捷版`) before any stamp.
 */
export function titlebarSubtitle(
  version: string,
  buildIdentity: string,
  portableTag = "",
): string {
  const base = [version ? `v${version}` : "", portableTag]
    .filter(Boolean)
    .join(" ");
  if (!buildIdentity) {
    return base;
  }
  return base ? `${base} ${buildIdentity}` : buildIdentity;
}
