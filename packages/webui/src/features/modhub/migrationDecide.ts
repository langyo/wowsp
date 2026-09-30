/**
 * Stale-bin migration wizard: decide-list selection state.
 *
 * Every decide-bucket file gets a three-way verdict — keep (migrate into
 * the current bin), ignore (leave it in the stale bin untouched), or
 * neither (delete). `keep` and `ignore` must stay disjoint, ignore wins:
 * ignoring a file pulls it out of `keep`, restoring it back. The master
 * checkbox and the kept-count pill only ever look at the still-pending
 * (non-ignored) files, so what the UI summarizes is exactly what execute
 * will receive. Pure and dependency-free so migrationDecide.test.ts can
 * pin the transitions.
 */
export interface DecideSelection {
  keep: Set<string>;
  ignore: Set<string>;
}

/** Decide paths still awaiting a verdict (not ignored). */
export function pendingOf(paths: readonly string[], ignore: ReadonlySet<string>): string[] {
  return paths.filter((p) => !ignore.has(p));
}

/** Tri-state of the master checkbox over the pending files: true when all
 *  pending are kept, false when none are, null (indeterminate) in between.
 *  Ignored files never count — they are no longer being decided. */
export function masterChecked(
  paths: readonly string[],
  keep: ReadonlySet<string>,
  ignore: ReadonlySet<string>,
): boolean | null {
  const pending = pendingOf(paths, ignore);
  if (pending.length === 0) return false;
  const kept = pending.filter((p) => keep.has(p)).length;
  if (kept === 0) return false;
  return kept === pending.length ? true : null;
}

/** Kept / pending pair for the count pill next to the master checkbox. */
export function keptPending(
  paths: readonly string[],
  keep: ReadonlySet<string>,
  ignore: ReadonlySet<string>,
): { kept: number; pending: number } {
  const pending = pendingOf(paths, ignore);
  return { kept: pending.filter((p) => keep.has(p)).length, pending: pending.length };
}

/** Keep (or unkeep) every pending file; ignored files are left alone —
 *  re-selecting the world must not silently un-ignore anything. */
export function selectAll(
  sel: DecideSelection,
  paths: readonly string[],
  keepAll: boolean,
): DecideSelection {
  const keep = new Set(sel.keep);
  for (const p of paths) {
    if (sel.ignore.has(p)) continue;
    if (keepAll) keep.add(p);
    else keep.delete(p);
  }
  return { keep, ignore: sel.ignore };
}

/** Mark one file "leave alone": out of `keep`, into `ignore`. */
export function ignoreFile(sel: DecideSelection, path: string): DecideSelection {
  const keep = new Set(sel.keep);
  const ignore = new Set(sel.ignore);
  keep.delete(path);
  ignore.add(path);
  return { keep, ignore };
}

/** Back to keep: the file returns to the default keep-all state. */
export function restoreFile(sel: DecideSelection, path: string): DecideSelection {
  const keep = new Set(sel.keep);
  const ignore = new Set(sel.ignore);
  ignore.delete(path);
  keep.add(path);
  return { keep, ignore };
}

/** Ignore every still-pending file in one click — the "don't make me
 *  decide" escape hatch that leaves the whole stale bin as it is. Pulled
 *  out of `keep` too: keep and ignore stay disjoint. */
export function ignoreAll(sel: DecideSelection, paths: readonly string[]): DecideSelection {
  const keep = new Set(sel.keep);
  const ignore = new Set(sel.ignore);
  for (const p of pendingOf(paths, sel.ignore)) {
    keep.delete(p);
    ignore.add(p);
  }
  return { keep, ignore };
}

/** Clear the ignored set entirely: every ignored file returns to kept. */
export function restoreAll(sel: DecideSelection): DecideSelection {
  const keep = new Set(sel.keep);
  for (const p of sel.ignore) keep.add(p);
  return { keep, ignore: new Set() };
}
