/**
 * Dog-tag asset overlay.
 *
 * Player dog tags render from two repo-shipped artifacts: the part WebPs
 * under `src/res/dogtags/` and the `id → [index, species, colorHEX?]` map
 * in `src/data/dogtags_map.json`. Both are snapshots of the game client, so
 * medals Wargaming adds later are unknown until a new app build ships.
 *
 * The desktop shell bridges that gap: `ensure_res_pack()` serves the
 * content-addressed resource pack from the fixed `res-latest` release
 * (see `scripts/release_models.py`), whose `dogtags/` subtree carries a
 * refreshed map plus any new part images. initDogtagPack() wires that
 * pack in once at startup:
 *
 *   - dogtagAssetUrl() serves part images from the pack cache (via
 *     convertFileSrc), falling back to the bundled publicDir paths during
 *     development or before the download finishes;
 *   - dogtagEntry() looks ids up in the bundled map overlaid by the pack's
 *     map (pack wins per id). The lookup touches dogtagMapVersion, a ref, so
 *     computeds that call it re-run when the overlay lands.
 *
 * Mobile keeps initDogtagPack unwired while the APK bundle serves (the
 * bundled publicDir snapshot IS the pack there) and wires it only when a
 * downloaded update is in the app cache — same rule as initModelPack.
 */
import { ref } from "vue";
import mapRaw from "@/data/dogtags_map.json";
import { isNative } from "@/utils/platform";

export type DogtagMapEntry = [string, string] | [string, string, string];

/** 2- or 3-element tuple per id: JSON module types keep the arrays the
 *  bundled map literally holds (`string[]`), so the tuples are re-assembled
 *  here — a row of any other length is skipped rather than asserted into a
 *  shape the lookups would then index off the end of. The downloaded pack's
 *  JSON is merged into the same record by initDogtagPack. */
/** Accept a row only when it is the 2- or 3-element string tuple the lookups
 *  index into; anything else is skipped instead of asserted into a shape whose
 *  3rd slot the renderer reads. Shared by the bundled map and the downloaded
 *  pack (the untrusted one). */
function coerceRow(row: unknown): DogtagMapEntry | null {
  if (!Array.isArray(row)) return null;
  const cells: unknown[] = row;
  if (cells.length === 2 || cells.length === 3) {
    if (cells.every((cell) => typeof cell === "string")) {
      return cells.length === 2
        ? [cells[0] as string, cells[1] as string]
        : [cells[0] as string, cells[1] as string, cells[2] as string];
    }
  }
  return null;
}

const entries: Record<string, DogtagMapEntry> = {};
for (const [id, row] of Object.entries(mapRaw)) {
  const coerced = coerceRow(row);
  if (coerced) entries[id] = coerced;
}

/** Bumped when the pack's map is merged in; read by every lookup. */
export const dogtagMapVersion = ref(0);

const packRoot = ref<string | null>(null);
let convertFileSrc: ((path: string) => string) | null = null;
let initPromise: Promise<void> | null = null;

/** Wire up the downloaded dog-tag pack. Safe to call multiple times — only
 *  the first invocation fetches; every failure keeps the bundled snapshot. */
export function initDogtagPack(fetchPack: () => Promise<string>): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // convertFileSrc's module resolves in plain browsers too, but the call
    // itself needs the Tauri internals; outside the shell keep serving the
    // bundled snapshot (what `?mobileApp=1` browser emulation wants).
    try {
      const mod = await import("@tauri-apps/api/core");
      if (!isNative()) return;
      convertFileSrc = mod.convertFileSrc;
    } catch {
      return;
    }
    let root: string;
    try {
      root = await fetchPack();
    } catch {
      return;
    }
    packRoot.value = root;

    // Overlay the pack's map (pack wins per id) so unknown medals resolve.
    try {
      const res = await fetch(convertFileSrc(`${root}/dogtags/dogtags_map.json`));
      if (res.ok) {
        // The pack is the UNTRUSTED source: run its rows through the same
        // coercion instead of asserting the whole document into the tuple map.
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [id, row] of Object.entries(parsed)) {
            const coerced = coerceRow(row);
            if (coerced) entries[id] = coerced;
          }
          dogtagMapVersion.value++;
        }
      }
    } catch {
      // Images still overlay; the bundled map keeps covering lookups.
    }
  })();
  return initPromise;
}

/** Map entry for a Vortex dog_tag id (null when unknown to both snapshots). */
export function dogtagEntry(id: number | null | undefined): DogtagMapEntry | null {
  void dogtagMapVersion.value;
  if (id == null) return null;
  return entries[String(id)] ?? null;
}

/** URL for a dog-tag part image (`"PCNP053.webp"`, `"PCNA001/border.webp"`). */
export function dogtagAssetUrl(relPath: string): string {
  const root = packRoot.value;
  if (root == null || convertFileSrc == null) return "/dogtags/" + relPath;
  return convertFileSrc(`${root}/dogtags/${relPath}`);
}

/** Candidate URLs for one dog-tag part image, best-first: the wired pack's
 *  .webp, then the same path as .png (a legacy all-.png pack generation),
 *  then the bundled same-origin snapshot. Callers walk the chain on load
 *  errors, so one missing file degrades its own badge part instead of —
 *  like the old global WebP→PNG flip — flipping every badge's URLs onto an
 *  extension the pack doesn't carry. */
export function dogtagUrlChain(relPath: string): string[] {
  const urls: string[] = [];
  const root = packRoot.value;
  if (root != null && convertFileSrc != null) {
    const webp = convertFileSrc(`${root}/dogtags/${relPath}`);
    urls.push(webp, webp.replace(/\.webp$/, ".png"));
  }
  urls.push("/dogtags/" + relPath);
  return urls;
}
