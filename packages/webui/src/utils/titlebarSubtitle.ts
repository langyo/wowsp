/**
 * The main window's title-bar version subtitle. Debug builds append the
 * compile-time git identity stamp (`branch:hash7`, resolved by build.rs and
 * served through the `get_build_identity` command) so a running debug
 * binary says exactly which checkout it came from; release builds and
 * browser dev mode answer no stamp and render the bare `v<version>`.
 */
export function titlebarSubtitle(version: string, buildIdentity: string): string {
  const base = version ? `v${version}` : "";
  if (!buildIdentity) {
    return base;
  }
  return base ? `${base} ${buildIdentity}` : buildIdentity;
}
