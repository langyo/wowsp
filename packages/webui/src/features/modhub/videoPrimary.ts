/**
 * Video-pack clip selection. A video pack shadows the client's login/opening
 * clip with one or two tiers — `gui/video/login/main.webm` (1080p) and
 * `main_low.webm` (720p), VP9+Vorbis at 25 fps. Rendering both as inline
 * players reads as a duplicate preview, so the detail pane shows exactly ONE
 * primary clip and lists the remaining tiers as text. The rule is pure (no
 * IPC, no Vue) so videoPrimary.test.ts can pin it:
 *
 *   1. the basename exactly `main.webm` (the full-quality main clip);
 *   2. otherwise the first basename WITHOUT `_low` (a full-quality tier
 *      under any other name);
 *   3. otherwise the first by name (a low-tier-only pack still previews).
 */

/** The shape the selection needs: a res_mods-relative path + byte size. */
export interface VideoClipLike {
  rel: string;
  size: number;
}

export interface PrimaryVideoSelection<T extends VideoClipLike> {
  /** The single clip to render, or null when the list is empty. */
  primary: T | null;
  /** The remaining tiers, in rule order, for compact text rows. */
  siblings: T[];
}

/** Final path segment, under either separator. */
export function videoBasename(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? "";
}

/** Selection rank: 0 = exact main.webm, 1 = a full-quality tier, 2 = low. */
export function videoTierRank(name: string): number {
  const lower = name.toLowerCase();
  if (lower === "main.webm") return 0;
  if (!lower.includes("_low")) return 1;
  return 2;
}

/**
 * Pick the ONE primary clip and order the siblings. Ranking is
 * case-insensitive (Windows filesystems are), and ties break by basename so
 * the result is deterministic across directory listings.
 */
export function pickPrimaryVideo<T extends VideoClipLike>(
  clips: readonly T[],
): PrimaryVideoSelection<T> {
  if (clips.length === 0) return { primary: null, siblings: [] };
  const sorted = [...clips].sort((a, b) => {
    const an = videoBasename(a.rel);
    const bn = videoBasename(b.rel);
    return (
      videoTierRank(an) - videoTierRank(bn) ||
      an.localeCompare(bn) ||
      a.rel.localeCompare(b.rel)
    );
  });
  return { primary: sorted[0], siblings: sorted.slice(1) };
}
